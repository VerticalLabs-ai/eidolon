import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb, closeTestServers } from '../test-utils.js';
import { MissionPlanGovernanceProjectionService } from '../services/mission/plan-governance-projection.js';
import { MissionProjectionService, type ProjectableEvent } from '../services/mission/projection.js';

/**
 * fix-s3-unlocked-event-sequence: projection failure recording must not
 * corrupt the RunEvent Journal invariant. `recordFailure()` (governance)
 * and `recordProjectionFailure()` (base projection) allocate event
 * sequence numbers by reading `mission_runs.last_event_sequence` and
 * writing `run_events` + bumping the counter. Without a lock or
 * transaction, concurrent projection failures on the same run can produce
 * duplicate or missing sequence numbers.
 *
 * These tests verify concurrent projection failures produce a strict,
 * gap-free, duplicate-free sequence run and that the run counter converges
 * to the maximum committed sequence, while the projection failure remains
 * recorded and observable.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

async function seedScope(db: AnyDb, label: string) {
  const companyId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{"testFixture": true}'::jsonb, ${now}, ${now})
  `);
  const projectId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${projectId}, ${companyId}, 'P', 'active', ${now}, ${now})
  `);
  const threadId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, 'T', 'conversation', 'active', ${now}, ${now})
  `);
  return { companyId, projectId, threadId };
}

/**
 * Insert a minimal nonterminal mission_runs row with a known starting
 * `last_event_sequence` so the concurrent appenders race on a shared
 * counter. Returns the runId.
 */
async function seedRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  startSeq = 0,
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id","company_id","project_id","project_thread_id","root_run_id",
      "parent_run_id","depth","child_ordinal","request_envelope","request_content_hash",
      "resolved_mode","status","state_version","last_event_sequence","created_at","updated_at")
    VALUES (${runId},${companyId},${projectId},${threadId},${runId},
      null,0,0,'{}'::jsonb,'x','deep_work','running',1,${startSeq},${now},${now})
  `);
  return runId;
}

function makeEvent(
  runId: string,
  companyId: string,
  projectId: string,
  sequence: number,
  payload: Record<string, unknown> = {},
): ProjectableEvent {
  return {
    runId,
    companyId,
    projectId,
    sequence,
    type: 'plan.approved',
    payload,
    actorType: 'system',
    actorId: null,
    traceId: null,
    occurredAt: new Date(),
  };
}

async function getProjectionFailureEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    sequence: Number(r['sequence']),
    type: r['type'] as string,
    payload: r['payload'] as Record<string, unknown>,
  }));
}

async function getRunLastEventSequence(db: AnyDb, runId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "last_event_sequence" FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return Number(rows[0]['last_event_sequence']);
}

async function getFailedLinks(db: AnyDb, runId: string) {
  const schema = db.schema;
  const rows = await db.drizzle
    .select()
    .from(schema.runProjectionLinks)
    .where(
      and(
        eq(schema.runProjectionLinks.runId, runId),
        eq(schema.runProjectionLinks.status, 'failed'),
      ),
    );
  return rows;
}

describe('fix-s3-unlocked-event-sequence: concurrent projection failure journal integrity', () => {
  it('concurrent governance recordFailure() calls produce no duplicate or missing sequence numbers', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ proj-fail-lock-gov');
    const runId = await seedRun(db, companyId, projectId, threadId, 5);

    const service = new MissionPlanGovernanceProjectionService(db);
    const concurrency = 12;
    // Each concurrent call uses a distinct revisionId so the failed-link
    // surface_key differs (no link-upsert race masking the journal race).
    const events: ProjectableEvent[] = Array.from({ length: concurrency }, (_, i) =>
      makeEvent(runId, companyId, projectId, 100 + i, {
        revisionId: `rev-${i}`,
        approvalId: `approval-${i}`,
        contentHash: `hash-${i}`,
      }),
    );

    await Promise.all(
      events.map((evt) =>
        service.recordFailure(evt, 'plan_approval', new Error(`fail-${evt.sequence}`), new Date()),
      ),
    );

    const failureEvents = await getProjectionFailureEvents(db, runId);
    const seqs = failureEvents.map((e) => e.sequence);

    // 1. Exactly `concurrency` projection.failed events were appended.
    expect(failureEvents).toHaveLength(concurrency);
    expect(failureEvents.every((e) => e.type === 'projection.failed')).toBe(true);

    // 2. No duplicate sequences.
    expect(new Set(seqs).size).toBe(seqs.length);

    // 3. Strictly increasing, contiguous, and starting right after the
    //    seed sequence (5 + 1 = 6). No gaps, no overlaps.
    seqs.sort((a, b) => a - b);
    expect(seqs[0]).toBe(6);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
    expect(seqs[seqs.length - 1]).toBe(5 + concurrency);

    // 4. The run counter converged to the maximum committed sequence.
    expect(await getRunLastEventSequence(db, runId)).toBe(5 + concurrency);

    // 5. The projection failure is still recorded: one failed link per
    //    concurrent failure (distinct surface_key per revisionId).
    const failedLinks = await getFailedLinks(db, runId);
    expect(failedLinks).toHaveLength(concurrency);

    await closeTestDb();
  });

  it('concurrent base projection recordProjectionFailure() calls produce no duplicate or missing sequence numbers', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ proj-fail-lock-base');
    const runId = await seedRun(db, companyId, projectId, threadId, 3);

    const service = new MissionProjectionService(db);
    const concurrency = 10;
    const events: ProjectableEvent[] = Array.from({ length: concurrency }, (_, i) =>
      makeEvent(runId, companyId, projectId, 200 + i),
    );

    await Promise.all(
      events.map((evt) =>
        service.recordProjectionFailure(
          db,
          evt,
          'thread_item',
          new Error(`base-fail-${evt.sequence}`),
          new Date(),
        ),
      ),
    );

    const failureEvents = await getProjectionFailureEvents(db, runId);
    const seqs = failureEvents.map((e) => e.sequence);

    expect(failureEvents).toHaveLength(concurrency);
    expect(new Set(seqs).size).toBe(seqs.length);
    seqs.sort((a, b) => a - b);
    expect(seqs[0]).toBe(4);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
    expect(await getRunLastEventSequence(db, runId)).toBe(3 + concurrency);

    const failedLinks = await getFailedLinks(db, runId);
    expect(failedLinks.length).toBeGreaterThanOrEqual(concurrency);

    await closeTestDb();
  });

  it('mixed concurrent governance + base projection failures share one contiguous sequence run', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(
      db,
      '__mtest__ proj-fail-lock-mixed',
    );
    const runId = await seedRun(db, companyId, projectId, threadId, 0);

    const govService = new MissionPlanGovernanceProjectionService(db);
    const baseService = new MissionProjectionService(db);
    const govCount = 6;
    const baseCount = 6;

    const govEvents: ProjectableEvent[] = Array.from({ length: govCount }, (_, i) =>
      makeEvent(runId, companyId, projectId, 300 + i, {
        revisionId: `grev-${i}`,
        approvalId: `gappr-${i}`,
        contentHash: `ghash-${i}`,
      }),
    );
    const baseEvents: ProjectableEvent[] = Array.from({ length: baseCount }, (_, i) =>
      makeEvent(runId, companyId, projectId, 400 + i),
    );

    await Promise.all([
      ...govEvents.map((evt) =>
        govService.recordFailure(evt, 'project_plan', new Error('g'), new Date()),
      ),
      ...baseEvents.map((evt) =>
        baseService.recordProjectionFailure(db, evt, 'activity_log', new Error('b'), new Date()),
      ),
    ]);

    const failureEvents = await getProjectionFailureEvents(db, runId);
    const seqs = failureEvents.map((e) => e.sequence);

    expect(failureEvents).toHaveLength(govCount + baseCount);
    expect(new Set(seqs).size).toBe(seqs.length);
    seqs.sort((a, b) => a - b);
    expect(seqs[0]).toBe(1);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1);
    }
    expect(seqs[seqs.length - 1]).toBe(govCount + baseCount);
    expect(await getRunLastEventSequence(db, runId)).toBe(govCount + baseCount);

    await closeTestDb();
  });
});
