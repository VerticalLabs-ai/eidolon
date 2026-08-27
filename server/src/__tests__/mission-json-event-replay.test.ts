import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql, eq } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

/** Start a run through the service and return its id + snapshot. */
async function startRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  key: string,
  text = 'Do work',
) {
  // Use deep_work mode. Deep Work now transitions draft→planning (5
  // initial events). These replay tests need a quiet non-queued run with
  // a known initial event count; revert the planning transition to
  // preserve the original 4-event draft semantics.
  const service = new MissionStartService(db);
  const result = await service.start({
    companyId,
    projectId,
    idempotencyKey: key,
    body: { projectThreadId: threadId, mode: 'deep_work', request: { text } },
    actorType: 'user',
    actorId: 'dev-user-000',
  });
  await db.drizzle.execute(sql`
    DELETE FROM "run_events" WHERE "run_id" = ${result.run.id} AND "sequence" = 5
  `);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "status" = 'draft', "state_version" = 1,
      "last_event_sequence" = 4, "updated_at" = ${new Date()}
    WHERE "id" = ${result.run.id}
  `);
  return {
    ...result,
    run: { ...result.run, status: 'draft', stateVersion: 1, lastEventSequence: 4 },
  };
}

/**
 * Append `count` synthetic journal events to a run, simulating what a later
 * feature's command transaction would do. Locks the run row, computes
 * sequence = last_event_sequence + 1..+count, inserts the events, and
 * advances the run's last_event_sequence in one transaction.
 */
async function appendEvents(
  db: AnyDb,
  companyId: string,
  projectId: string,
  runId: string,
  count: number,
): Promise<void> {
  const schema = db.schema;
  await db.drizzle.transaction(async (tx) => {
    const [run] = await tx
      .select({ lastEventSequence: schema.missionRuns.lastEventSequence })
      .from(schema.missionRuns)
      .where(sql`"id" = ${runId} AND "company_id" = ${companyId} AND "project_id" = ${projectId}`)
      .limit(1);
    if (!run) {
      throw new Error('appendEvents: run not found');
    }
    let seq = Number(run.lastEventSequence);
    const now = new Date();
    for (let i = 0; i < count; i++) {
      seq += 1;
      await tx.insert(schema.runEvents).values({
        companyId,
        projectId,
        runId,
        sequence: seq,
        type: 'execution.progress',
        schemaVersion: 1,
        payload: { n: i } as Record<string, unknown>,
        actorType: 'system',
        actorId: null,
        traceId: null,
        occurredAt: now,
      });
    }
    await tx
      .update(schema.missionRuns)
      .set({ lastEventSequence: seq, updatedAt: now })
      .where(eq(schema.missionRuns.id, runId));
  });
}

const eventsUrl = (companyId: string, projectId: string, runId: string) =>
  `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/events`;

// ---------------------------------------------------------------------------
// VAL-RUN-022: JSON replay is complete through bounded pages
// ---------------------------------------------------------------------------

describe('Mission JSON event replay (VAL-RUN-022)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ replay pages', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Replay Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Replay Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reconstructs every committed event through bounded pages in order with no duplicates', async () => {
    // Start creates 4 events (sequences 1..4). Append 6 more (5..10) → 10 total.
    const start = await startRun(db, companyId, projectId, threadId, 'replay-pages-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6);
    const expectedTotal = 10;

    // Page through with limit=1 (the tightest bound). Every sequence 1..10
    // must appear exactly once, in strictly increasing order.
    const seen: number[] = [];
    const types: string[] = [];
    let cursor = 0;
    for (let page = 0; page < expectedTotal + 2; page++) {
      const res = await request(app)
        .get(eventsUrl(companyId, projectId, start.run.id))
        .query({ after: cursor, limit: 1 })
        .expect(200);
      const events = res.body.data.events as { sequence: number; type: string }[];
      for (const e of events) {
        seen.push(e.sequence);
        types.push(e.type);
      }
      cursor = res.body.data.nextCursor;
      if (events.length === 0) {
        break;
      }
    }

    // Complete coverage, strict order, uniqueness, beginning with creation.
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(seen).size).toBe(expectedTotal);
    expect(types[0]).toBe('run.created');
    expect(cursor).toBe(expectedTotal);
  });

  it('returns a bounded page with stable nextCursor and no duplicate sequence', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-stable-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    const page1 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 3 })
      .expect(200);
    const e1 = page1.body.data.events as { sequence: number }[];
    expect(e1.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(page1.body.data.nextCursor).toBe(3);
    expect(page1.body.data.latestSequence).toBe(10);

    const page2 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 3, limit: 3 })
      .expect(200);
    const e2 = page2.body.data.events as { sequence: number }[];
    expect(e2.map((e) => e.sequence)).toEqual([4, 5, 6]);
    expect(page2.body.data.nextCursor).toBe(6);

    const page3 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 6, limit: 3 })
      .expect(200);
    const e3 = page3.body.data.events as { sequence: number }[];
    expect(e3.map((e) => e.sequence)).toEqual([7, 8, 9]);
    expect(page3.body.data.nextCursor).toBe(9);

    const page4 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 9, limit: 3 })
      .expect(200);
    const e4 = page4.body.data.events as { sequence: number }[];
    expect(e4.map((e) => e.sequence)).toEqual([10]);
    expect(page4.body.data.nextCursor).toBe(10);

    // Following cursors until an empty page reconstructs every event.
    const finalPage = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 10, limit: 3 })
      .expect(200);
    expect(finalPage.body.data.events).toEqual([]);
    expect(finalPage.body.data.nextCursor).toBe(10);

    const all = [...e1, ...e2, ...e3, ...e4].map((e) => e.sequence);
    expect(all).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(all).size).toBe(10);
  });

  it('exercises limit boundaries 1 and 1000', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-limit-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    // limit=1 returns exactly one event.
    const one = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 1 })
      .expect(200);
    expect(one.body.data.events).toHaveLength(1);
    expect(one.body.data.events[0].sequence).toBe(1);

    // limit=1000 returns all events in one page (VAL-M1-037).
    const big = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 1000 })
      .expect(200);
    expect(big.body.data.events).toHaveLength(10);
    expect(big.body.data.nextCursor).toBe(10);
  });

  it('rejects limit 0 and 1001 with 400 VALIDATION_ERROR', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-limit-bad-001');
    const zero = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ limit: 0 })
      .expect(400);
    expect(zero.body.code).toBe('VALIDATION_ERROR');

    const over = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ limit: 1001 })
      .expect(400);
    expect(over.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects non-numeric limit with 400 VALIDATION_ERROR (VAL-M1-048)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-limit-nan-001');
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ limit: 'abc' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects negative limit with 400 VALIDATION_ERROR (VAL-M1-049)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-limit-neg-001');
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ limit: -1 })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('default limit returns up to 50 events (VAL-M1-039)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-limit-default-001');
    await appendEvents(db, companyId, projectId, start.run.id, 56); // 60 total

    // No limit query → default 50 → exactly 50 events.
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .expect(200);
    expect(res.body.data.events).toHaveLength(50);
    expect(res.body.data.events[0].sequence).toBe(1);
    expect(res.body.data.events[49].sequence).toBe(50);
    expect(res.body.data.nextCursor).toBe(50);
    expect(res.body.data.latestSequence).toBe(60);
  });

  it('limit=1000 returns all events for a run with 750 events (VAL-M1-043)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-limit-750-001');
    await appendEvents(db, companyId, projectId, start.run.id, 746); // 750 total

    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 1000 })
      .expect(200);
    expect(res.body.data.events).toHaveLength(750);
    expect(res.body.data.nextCursor).toBe(750);
    expect(res.body.data.latestSequence).toBe(750);
  });

  it('limit=1000 paginates a run with 1200 events (VAL-M1-044)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-limit-1200-001');
    await appendEvents(db, companyId, projectId, start.run.id, 1196); // 1200 total

    // First page: 1000 events with a nextCursor.
    const page1 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 1000 })
      .expect(200);
    expect(page1.body.data.events).toHaveLength(1000);
    expect(page1.body.data.nextCursor).toBe(1000);
    expect(page1.body.data.latestSequence).toBe(1200);

    // Second page: remaining 200 events, nextCursor null (caught up).
    const page2 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 1000, limit: 1000 })
      .expect(200);
    expect(page2.body.data.events).toHaveLength(200);
    expect(page2.body.data.events[0].sequence).toBe(1001);
    expect(page2.body.data.events[199].sequence).toBe(1200);
    expect(page2.body.data.nextCursor).toBe(1200);
  });

  it('returns nextCursor when more events exist (VAL-M1-040)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-next-cursor-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 5 })
      .expect(200);
    expect(res.body.data.events).toHaveLength(5);
    expect(res.body.data.nextCursor).toBe(5);
    expect(res.body.data.nextCursor).toBeLessThan(res.body.data.latestSequence);
  });

  it('returns nextCursor equal to latestSequence (null page) when no more events (VAL-M1-041)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-no-more-001');
    // 4 events, limit=50 → all fit, nextCursor == latestSequence (caught up).
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 50 })
      .expect(200);
    expect(res.body.data.events).toHaveLength(4);
    expect(res.body.data.nextCursor).toBe(res.body.data.latestSequence);
  });

  it('cursor pagination returns next page with no duplicates (VAL-M1-042)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-no-dup-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    const page1 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 5 })
      .expect(200);
    const seqs1 = page1.body.data.events.map((e: { sequence: number }) => e.sequence);
    expect(seqs1).toEqual([1, 2, 3, 4, 5]);

    const page2 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: page1.body.data.nextCursor, limit: 5 })
      .expect(200);
    const seqs2 = page2.body.data.events.map((e: { sequence: number }) => e.sequence);
    expect(seqs2).toEqual([6, 7, 8, 9, 10]);

    // No overlap.
    const all = [...seqs1, ...seqs2];
    expect(new Set(all).size).toBe(10);
    // latestSequence consistent across pages.
    expect(page1.body.data.latestSequence).toBe(page2.body.data.latestSequence);
  });

  it('events are ordered by sequence ascending (VAL-M1-045)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-ascending-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    const page1 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 5 })
      .expect(200);
    const seqs1 = page1.body.data.events.map((e: { sequence: number }) => e.sequence);
    for (let i = 1; i < seqs1.length; i++) {
      expect(seqs1[i]).toBeGreaterThan(seqs1[i - 1]);
    }

    const page2 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: page1.body.data.nextCursor, limit: 5 })
      .expect(200);
    const seqs2 = page2.body.data.events.map((e: { sequence: number }) => e.sequence);
    for (let i = 1; i < seqs2.length; i++) {
      expect(seqs2[i]).toBeGreaterThan(seqs2[i - 1]);
    }
    // Cross-page: page2 first > page1 last.
    expect(seqs2[0]).toBeGreaterThan(seqs1[seqs1.length - 1]);
  });

  it('same limit produces same page boundaries — deterministic (VAL-M1-052)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-deterministic-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    const req1 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 5 })
      .expect(200);
    const req2 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 5 })
      .expect(200);

    expect(req1.body.data.events.map((e: { sequence: number }) => e.sequence)).toEqual(
      req2.body.data.events.map((e: { sequence: number }) => e.sequence),
    );
    expect(req1.body.data.nextCursor).toBe(req2.body.data.nextCursor);
  });

  it('response includes latestSequence field (VAL-M1-054)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-latest-seq-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 50 })
      .expect(200);
    expect(res.body.data).toHaveProperty('latestSequence');
    expect(res.body.data.latestSequence).toBe(10);
  });

  it('run with zero events returns empty array and null nextCursor (VAL-M1-110)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-zero-events-001');
    // Delete all events to simulate zero events.
    await db.drizzle.execute(sql`
      DELETE FROM "run_events" WHERE "run_id" = ${start.run.id}
    `);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "last_event_sequence" = 0, "updated_at" = ${new Date()}
      WHERE "id" = ${start.run.id}
    `);

    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 50 })
      .expect(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.nextCursor).toBe(0);
    expect(res.body.data.latestSequence).toBe(0);
  });

  it('after cursor for non-existent sequence returns 409 CURSOR_AHEAD (VAL-M1-051)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-nonexistent-001');
    // 4 events, latest=4. after=999 is beyond latest.
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 999, limit: 50 })
      .expect(409);
    expect(res.body.code).toBe('CURSOR_AHEAD');
  });

  it('defaults after to 0 for a complete initial replay', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-default-001');
    // No `after` query → default 0 → all 4 creation events.
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .expect(200);
    expect(res.body.data.events.map((e: { sequence: number }) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(res.body.data.nextCursor).toBe(4);
    expect(res.body.data.latestSequence).toBe(4);
  });

  it('returns 404 RUN_NOT_FOUND for a cross-scope run id without revealing existence', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-xscope-001');

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ replay other', settings: { testFixture: true } })
      .expect(201);
    const otherCompanyId = otherCompany.body.data.id;
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other' })
      .expect(201);
    const otherProjectId = otherProject.body.data.id;

    const res = await request(app)
      .get(eventsUrl(otherCompanyId, otherProjectId, start.run.id))
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-023: JSON replay resumes after a cursor
// ---------------------------------------------------------------------------

describe('Mission JSON replay resumes after a cursor (VAL-RUN-023)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ replay resume', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Resume Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Resume Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns only events with greater sequence, in order, with a usable next cursor', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-resume-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    // Baseline: observe up to sequence 4 (the creation events).
    const baseline = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 4 })
      .expect(200);
    const baselineSeqs = baseline.body.data.events.map((e: { sequence: number }) => e.sequence);
    expect(baselineSeqs).toEqual([1, 2, 3, 4]);

    // Resume after the previously observed sequence (4).
    const resumed = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 4, limit: 100 })
      .expect(200);
    const resumedSeqs = resumed.body.data.events.map((e: { sequence: number }) => e.sequence);
    // Only events with sequence > 4, in strict order.
    expect(resumedSeqs).toEqual([5, 6, 7, 8, 9, 10]);
    for (const s of resumedSeqs) {
      expect(s).toBeGreaterThan(4);
    }
    // Strictly increasing.
    for (let i = 1; i < resumedSeqs.length; i++) {
      expect(resumedSeqs[i]).toBeGreaterThan(resumedSeqs[i - 1]);
    }
    // Usable next cursor equals the last returned sequence.
    expect(resumed.body.data.nextCursor).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-024: Replay at latest sequence is empty
// ---------------------------------------------------------------------------

describe('Mission JSON replay at latest sequence is empty (VAL-RUN-024)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ replay empty', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Empty Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Empty Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns an empty event page and the same next cursor at the latest sequence (terminal)', async () => {
    // Start (4 events) then move the run to a terminal state directly.
    const start = await startRun(db, companyId, projectId, threadId, 'replay-empty-term-001');
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'completed', "terminal_at" = ${new Date()},
        "state_version" = "state_version" + 1, "updated_at" = ${new Date()}
      WHERE "id" = ${start.run.id}
    `);

    const latest = 4;
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: latest, limit: 50 })
      .expect(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.nextCursor).toBe(latest);
    expect(res.body.data.latestSequence).toBe(latest);

    // A later snapshot proves no intervening event was committed.
    const snap = await request(app)
      .get(`/api/companies/${companyId}/projects/${projectId}/mission-runs/${start.run.id}`)
      .expect(200);
    expect(snap.body.data.run.lastEventSequence).toBe(latest);
    expect(snap.body.data.run.status).toBe('completed');
  });

  it('returns an empty event page and the same next cursor at the latest sequence (waiting)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-empty-wait-001');
    // Hold the run in a waiting state (awaiting_input) without appending events.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'awaiting_input', "waiting_from_status" = 'planning',
        "state_version" = "state_version" + 1, "updated_at" = ${new Date()}
      WHERE "id" = ${start.run.id}
    `);

    const latest = 4;
    const first = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 50 })
      .expect(200);
    expect(first.body.data.events.map((e: { sequence: number }) => e.sequence)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(first.body.data.latestSequence).toBe(latest);

    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: latest, limit: 50 })
      .expect(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.nextCursor).toBe(latest);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-025: Cursor ahead is rejected
// ---------------------------------------------------------------------------

describe('Mission JSON replay rejects a cursor ahead (VAL-RUN-025)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ replay ahead', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Ahead Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Ahead Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a cursor greater than the latest committed sequence with 409 CURSOR_AHEAD', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-ahead-001');
    await appendEvents(db, companyId, projectId, start.run.id, 2); // 6 total

    // Confirm the latest sequence first.
    const probe = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 6, limit: 50 })
      .expect(200);
    expect(probe.body.data.latestSequence).toBe(6);

    // A cursor intentionally higher than the latest sequence.
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 7, limit: 50 })
      .expect(409);
    expect(res.body.status).toBe(409);
    expect(res.body.code).toBe('CURSOR_AHEAD');
    expect(res.body.message).toBeTruthy();
  });

  it('does not change run state or append an event when rejecting a cursor ahead', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-ahead-inert-001');
    await appendEvents(db, companyId, projectId, start.run.id, 2); // 6 total
    const beforeSeq = 6;

    await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 999, limit: 50 })
      .expect(409);

    const snap = await request(app)
      .get(`/api/companies/${companyId}/projects/${projectId}/mission-runs/${start.run.id}`)
      .expect(200);
    expect(snap.body.data.run.lastEventSequence).toBe(beforeSeq);
  });

  it('treats after == latest as caught-up (empty), not cursor-ahead', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-ahead-eq-001');
    await appendEvents(db, companyId, projectId, start.run.id, 2); // 6 total
    const latest = 6;

    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: latest, limit: 50 })
      .expect(200);
    expect(res.body.data.events).toEqual([]);
    expect(res.body.data.nextCursor).toBe(latest);
  });

  it('rejects a negative after with 400 VALIDATION_ERROR', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-ahead-neg-001');
    const res = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: -1, limit: 50 })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-053: Concurrent event insertion during pagination does not skip/duplicate
// ---------------------------------------------------------------------------

describe('Events pagination handles concurrent insertion (VAL-M1-053)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ replay concurrent', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Concurrent Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Concurrent Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not skip or duplicate events when new events are inserted between page fetches', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-concurrent-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    // Fetch first page (events 1..5).
    const page1 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 5 })
      .expect(200);
    const seqs1 = page1.body.data.events.map((e: { sequence: number }) => e.sequence);
    expect(seqs1).toEqual([1, 2, 3, 4, 5]);
    expect(page1.body.data.nextCursor).toBe(5);

    // Insert 3 new events (sequences 11, 12, 13) between page fetches.
    await appendEvents(db, companyId, projectId, start.run.id, 3); // 13 total

    // Fetch second page using the cursor from page1.
    const page2 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: page1.body.data.nextCursor, limit: 50 })
      .expect(200);
    const seqs2 = page2.body.data.events.map((e: { sequence: number }) => e.sequence);

    // The second page must include events 6..13 (no skips, no duplicates).
    expect(seqs2).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);

    // Combined: all 13 events, no duplicates.
    const all = [...seqs1, ...seqs2];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(13);
  });
});

// ---------------------------------------------------------------------------
// VAL-M1-116: Cursor survives server restart (durable Postgres sequence)
// ---------------------------------------------------------------------------

describe('Events pagination cursor is durable across server restart (VAL-M1-116)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ replay restart', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Restart Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Restart Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('cursor remains valid after server restart because it references a durable Postgres sequence', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'replay-restart-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    // Fetch first page and capture cursor.
    const page1 = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 5 })
      .expect(200);
    expect(page1.body.data.events.map((e: { sequence: number }) => e.sequence)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    const cursor = page1.body.data.nextCursor;
    expect(cursor).toBe(5);

    // Simulate a server restart by creating a new server instance
    // pointing at the same durable Postgres database.
    const app2 = await createTestServer(db);

    // The cursor is still valid — the second page fetches correctly.
    const page2 = await request(app2)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: cursor, limit: 50 })
      .expect(200);
    expect(page2.body.data.events.map((e: { sequence: number }) => e.sequence)).toEqual([
      6, 7, 8, 9, 10,
    ]);
    expect(page2.body.data.nextCursor).toBe(10);
  });
});
