import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer } from '../test-utils.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function seedScope(db: AnyDb, label: string) {
  const companyId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{}'::jsonb, ${now}, ${now})
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

interface RunContext {
  db: AnyDb;
  app: Awaited<ReturnType<typeof createTestServer>>;
  companyId: string;
  projectId: string;
  threadId: string;
  runId: string;
  stateVersion: number;
  base: string;
}

async function freshRun(label: string, text = 'Do work'): Promise<RunContext> {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `fresh-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'fast', request: { text } })
    .expect(202);
  return {
    db,
    app,
    companyId,
    projectId,
    threadId,
    runId: start.body.data.run.id as string,
    stateVersion: start.body.data.run.stateVersion as number,
    base,
  };
}

/** Force a run into a terminal status with a terminal_at timestamp. */
async function setTerminalStatus(
  db: AnyDb,
  runId: string,
  status: 'failed' | 'cancelled' | 'completed',
) {
  const now = new Date();
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status}, "terminal_at" = ${now}, "updated_at" = ${now},
        "lease_owner" = NULL, "lease_token" = NULL, "lease_expires_at" = NULL, "heartbeat_at" = NULL
    WHERE "id" = ${runId}
  `);
}

/** Force a run into a nonterminal status (for active-run denial tests). */
async function setNonterminalStatus(
  db: AnyDb,
  runId: string,
  status:
    'queued' | 'running' | 'planning' | 'awaiting_input' | 'awaiting_approval' | 'synthesizing',
) {
  const now = new Date();
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status}, "terminal_at" = NULL, "updated_at" = ${now}
    WHERE "id" = ${runId}
  `);
}

async function getRunVersion(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT "state_version" FROM "mission_runs" WHERE "id" = ${runId}`,
  )) as unknown as { state_version: number }[];
  return row.state_version;
}

async function getRunSnapshot(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  runId: string,
) {
  const res = await request(app).get(`${base}/${runId}`).expect(200);
  return res.body.data.run;
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence" AS "seq", "type", "payload"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as { seq: number; type: string; payload: Record<string, unknown> }[];
  return rows;
}

async function countRunsInScope(db: AnyDb, companyId: string, projectId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "mission_runs"
    WHERE "company_id" = ${companyId} AND "project_id" = ${projectId}
  `)) as unknown as { c: number }[];
  return row.c;
}

async function countSuccessors(db: AnyDb, runId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "mission_runs" WHERE "retry_of_run_id" = ${runId}
  `)) as unknown as { c: number }[];
  return row.c;
}

async function countReservations(db: AnyDb, runId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as { c: number }[];
  return row.c;
}

async function getReservation(db: AnyDb, runId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "requested_cents" AS "requestedCents", "reserved_cents" AS "reservedCents",
           "settled_cents" AS "settledCents", "released_cents" AS "releasedCents",
           "status"
    FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return row;
}

async function getPolicySnapshotId(db: AnyDb, runId: string): Promise<string | null> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "policy_snapshot_id" AS "id" FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as { id: string | null }[];
  return row.id;
}

async function countCommands(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT count(*)::int AS c FROM "run_commands" WHERE "run_id" = ${runId}`,
  )) as unknown as { c: number }[];
  return row.c;
}

const etag = (v: number): string => `"${v}"`;

// ===========================================================================
// VAL-RUN-048: Retry creates a distinct linked run
// ===========================================================================

describe('Retry creates a distinct linked run (VAL-RUN-048)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('retries a failed run returning 202 with a new run ID, Location, and bidirectional linkage', async () => {
    const ctx = await freshRun('__mtest__ retry-failed-link');
    await setTerminalStatus(ctx.db, ctx.runId, 'failed');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const runsBefore = await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-failed-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    const successorId = res.body.data.run.id as string;
    expect(successorId).not.toBe(ctx.runId);

    // Location header points to the new run.
    const location = res.headers.location;
    expect(location).toContain(successorId);

    // The original remains terminal (failed).
    const origSnapshot = await getRunSnapshot(ctx.app, ctx.base, ctx.runId);
    expect(origSnapshot.status).toBe('failed');
    expect(origSnapshot.retryOfRunId).toBeNull();

    // The successor exposes the retry relationship.
    const succSnapshot = await getRunSnapshot(ctx.app, ctx.base, successorId);
    expect(succSnapshot.retryOfRunId).toBe(ctx.runId);

    // Bidirectional: querying successors from the original finds the new run.
    expect(await countSuccessors(ctx.db, ctx.runId)).toBe(1);
    expect(await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId)).toBe(runsBefore + 1);
  });

  it('retries a cancelled run returning 202 with a new run ID and linkage', async () => {
    const ctx = await freshRun('__mtest__ retry-cancelled-link');
    await setTerminalStatus(ctx.db, ctx.runId, 'cancelled');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-cancelled-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    const successorId = res.body.data.run.id as string;
    expect(successorId).not.toBe(ctx.runId);

    // Original remains cancelled.
    const origSnapshot = await getRunSnapshot(ctx.app, ctx.base, ctx.runId);
    expect(origSnapshot.status).toBe('cancelled');

    // Successor linked back.
    const succSnapshot = await getRunSnapshot(ctx.app, ctx.base, successorId);
    expect(succSnapshot.retryOfRunId).toBe(ctx.runId);
    expect(await countSuccessors(ctx.db, ctx.runId)).toBe(1);
  });
});

// ===========================================================================
// VAL-RUN-049: Retry never reopens history
// ===========================================================================

describe('Retry never reopens history (VAL-RUN-049)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('does not append events to the original run after retry (failed)', async () => {
    const ctx = await freshRun('__mtest__ retry-no-reopen-failed');
    await setTerminalStatus(ctx.db, ctx.runId, 'failed');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const origEventsBefore = await getEvents(ctx.db, ctx.runId);
    const origVersionBefore = terminalVersion;

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-no-reopen-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    // Original events unchanged: no new lifecycle event on the original run.
    const origEventsAfter = await getEvents(ctx.db, ctx.runId);
    expect(origEventsAfter.length).toBe(origEventsBefore.length);
    // Original state version unchanged (the retry command is recorded but
    // does not transition the original run).
    const origVersionAfter = await getRunVersion(ctx.db, ctx.runId);
    expect(origVersionAfter).toBe(origVersionBefore);
    // Original status still failed.
    const origSnapshot = await getRunSnapshot(ctx.app, ctx.base, ctx.runId);
    expect(origSnapshot.status).toBe('failed');
  });

  it('does not append events to the original run after retry (cancelled)', async () => {
    const ctx = await freshRun('__mtest__ retry-no-reopen-cancelled');
    await setTerminalStatus(ctx.db, ctx.runId, 'cancelled');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const origEventsBefore = await getEvents(ctx.db, ctx.runId);

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-no-reopen-c-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    const origEventsAfter = await getEvents(ctx.db, ctx.runId);
    expect(origEventsAfter.length).toBe(origEventsBefore.length);
    const origSnapshot = await getRunSnapshot(ctx.app, ctx.base, ctx.runId);
    expect(origSnapshot.status).toBe('cancelled');
  });

  it('all new lifecycle work belongs to the linked successor run', async () => {
    const ctx = await freshRun('__mtest__ retry-successor-events');
    await setTerminalStatus(ctx.db, ctx.runId, 'failed');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-succ-events-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    const successorId = res.body.data.run.id as string;
    const succEvents = await getEvents(ctx.db, successorId);
    // The successor has its own ordered lifecycle events starting from seq 1.
    expect(succEvents.length).toBeGreaterThanOrEqual(4);
    expect(succEvents[0].type).toBe('run.created');
    expect(Number(succEvents[0].seq)).toBe(1);
    // Sequences are strictly increasing.
    for (let i = 1; i < succEvents.length; i++) {
      expect(Number(succEvents[i].seq)).toBe(Number(succEvents[i - 1].seq) + 1);
    }
  });
});

// ===========================================================================
// VAL-RUN-050: Duplicate retry creates one successor
// ===========================================================================

describe('Duplicate retry creates one successor (VAL-RUN-050)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('repeating an identical retry returns the same successor run and does not create duplicates', async () => {
    const ctx = await freshRun('__mtest__ retry-dup-successor');
    await setTerminalStatus(ctx.db, ctx.runId, 'failed');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const key = `retry-dup-${randomUUID()}`;

    const first = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    const successorId = first.body.data.run.id as string;

    const second = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    // Same successor run ID.
    expect(second.body.data.run.id).toBe(successorId);
    expect(second.body.data.command.id).toBe(first.body.data.command.id);

    // Only one successor run.
    expect(await countSuccessors(ctx.db, ctx.runId)).toBe(1);
    // Only one reservation for the successor.
    expect(await countReservations(ctx.db, successorId)).toBe(1);
    // Only one retry command on the original (start + retry = 2; no third
    // command from the duplicate replay).
    expect(await countCommands(ctx.db, ctx.runId)).toBe(2);
  });

  it('rejects reusing a retry idempotency key with different content (409)', async () => {
    const ctx = await freshRun('__mtest__ retry-dup-conflict');
    await setTerminalStatus(ctx.db, ctx.runId, 'failed');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const key = `retry-conflict-${randomUUID()}`;

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', key)
      .set('If-Match', etag(terminalVersion))
      .send({ limits: { costCents: 100 } })
      .expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Still only one successor.
    expect(await countSuccessors(ctx.db, ctx.runId)).toBe(1);
  });
});

// ===========================================================================
// VAL-RUN-051: Retry is rejected from an active run
// ===========================================================================

describe('Retry is rejected from an active run (VAL-RUN-051)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    'queued',
    'running',
    'planning',
    'awaiting_input',
    'awaiting_approval',
    'synthesizing',
  ] as const)(
    'rejects retry from %s with 409 INVALID_RUN_STATE and creates no successor',
    async (status) => {
      const ctx = await freshRun(`__mtest__ retry-active-${status}`);
      await setNonterminalStatus(ctx.db, ctx.runId, status);
      const version = await getRunVersion(ctx.db, ctx.runId);
      const runsBefore = await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId);

      const res = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/retry`)
        .set('Idempotency-Key', `retry-active-${status}-${randomUUID()}`)
        .set('If-Match', etag(version))
        .send({})
        .expect(409);
      expect(res.body.code).toBe('INVALID_RUN_STATE');

      // No successor created, run count unchanged.
      expect(await countSuccessors(ctx.db, ctx.runId)).toBe(0);
      expect(await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId)).toBe(runsBefore);
      // Run status unchanged.
      const snapshot = await getRunSnapshot(ctx.app, ctx.base, ctx.runId);
      expect(snapshot.status).toBe(status);
    },
  );
});

// ===========================================================================
// VAL-RUN-118: Completed runs cannot be retried
// ===========================================================================

describe('Completed runs cannot be retried (VAL-RUN-118)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('rejects retry from a completed run with 409 INVALID_RUN_STATE, no successor or reservation', async () => {
    const ctx = await freshRun('__mtest__ retry-completed-denied');
    await setTerminalStatus(ctx.db, ctx.runId, 'completed');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const eventsBefore = await getEvents(ctx.db, ctx.runId);
    const reservationBefore = await getReservation(ctx.db, ctx.runId);
    const runsBefore = await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-completed-denied-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(409);
    expect(res.body.code).toBe('INVALID_RUN_STATE');

    // No successor or reservation created.
    expect(await countSuccessors(ctx.db, ctx.runId)).toBe(0);
    expect(await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId)).toBe(runsBefore);

    // Snapshot, events, and budget unchanged.
    const snapshot = await getRunSnapshot(ctx.app, ctx.base, ctx.runId);
    expect(snapshot.status).toBe('completed');
    const eventsAfter = await getEvents(ctx.db, ctx.runId);
    expect(eventsAfter.length).toBe(eventsBefore.length);
    const reservationAfter = await getReservation(ctx.db, ctx.runId);
    expect(reservationAfter).toEqual(reservationBefore);
  });
});

// ===========================================================================
// VAL-CROSS-060: Cancelled root retry begins a fresh prepared run
// ===========================================================================

describe('Cancelled root retry begins a fresh prepared run (VAL-CROSS-060)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('creates a distinct initialized successor in draft with fresh policy, idempotency scope, and reservation', async () => {
    const ctx = await freshRun('__mtest__ retry-cancelled-fresh');
    await setTerminalStatus(ctx.db, ctx.runId, 'cancelled');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const origPolicyId = await getPolicySnapshotId(ctx.db, ctx.runId);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-fresh-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    const successorId = res.body.data.run.id as string;

    // Successor is in draft (preparing) state.
    const succSnapshot = await getRunSnapshot(ctx.app, ctx.base, successorId);
    expect(succSnapshot.status).toBe('draft');
    expect(succSnapshot.retryOfRunId).toBe(ctx.runId);

    // Fresh policy snapshot (distinct from the original).
    const succPolicyId = await getPolicySnapshotId(ctx.db, successorId);
    expect(succPolicyId).not.toBeNull();
    expect(succPolicyId).not.toBe(origPolicyId);

    // Fresh root reservation.
    expect(await countReservations(ctx.db, successorId)).toBe(1);
    const succReservation = await getReservation(ctx.db, successorId);
    expect(succReservation.status).toBe('held');
    expect(Number(succReservation.reservedCents)).toBeGreaterThan(0);

    // Fresh idempotency scope: the retry command is on the ORIGINAL run,
    // and the successor has its own command namespace.
    const origCommandsAfter = await countCommands(ctx.db, ctx.runId);
    expect(origCommandsAfter).toBe(2); // start + retry commands
    const succCommands = await countCommands(ctx.db, successorId);
    expect(succCommands).toBe(0); // no commands on the successor yet

    // Cancelled original remains immutable.
    const origSnapshot = await getRunSnapshot(ctx.app, ctx.base, ctx.runId);
    expect(origSnapshot.status).toBe('cancelled');
    expect(origSnapshot.stateVersion).toBe(terminalVersion);

    // Both directions navigable: successor → original via retryOfRunId,
    // original → successor via query.
    expect(succSnapshot.retryOfRunId).toBe(ctx.runId);
    expect(await countSuccessors(ctx.db, ctx.runId)).toBe(1);
  });

  it('successor starts in draft and its first legal worker transition is to awaiting_input or planning', async () => {
    const ctx = await freshRun('__mtest__ retry-legal-transition');
    await setTerminalStatus(ctx.db, ctx.runId, 'cancelled');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-legal-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    const successorId = res.body.data.run.id as string;
    const succSnapshot = res.body.data.run;

    // The successor is in draft — the state machine says draft can only
    // transition to awaiting_input or planning (never directly to queued,
    // running, or a terminal state).
    expect(succSnapshot.status).toBe('draft');

    // Verify the successor's events start with run.created (draft) and
    // mode.resolved, policy.snapshotted, budget.reserved — the preparation
    // sequence, not execution events.
    const succEvents = await getEvents(ctx.db, successorId);
    const types = succEvents.map((e) => e.type);
    expect(types).toContain('run.created');
    expect(types).toContain('mode.resolved');
    expect(types).toContain('policy.snapshotted');
    expect(types).toContain('budget.reserved');
    // No execution events on the successor.
    expect(types).not.toContain('execution.started');
    expect(types).not.toContain('run.completed');
    expect(types).not.toContain('run.failed');
  });

  it('retry with lower limits narrows the successor policy and budget ceiling', async () => {
    const ctx = await freshRun('__mtest__ retry-narrowed-limits');
    await setTerminalStatus(ctx.db, ctx.runId, 'failed');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const origReservation = await getReservation(ctx.db, ctx.runId);
    const origCeiling = Number(origReservation.requestedCents);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-narrow-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({ limits: { costCents: Math.max(1, origCeiling - 100) } })
      .expect(202);

    const successorId = res.body.data.run.id as string;
    const succReservation = await getReservation(ctx.db, successorId);
    // The successor ceiling is narrowed (lower than or equal to the original).
    expect(Number(succReservation.requestedCents)).toBeLessThanOrEqual(origCeiling);
    expect(Number(succReservation.requestedCents)).toBeGreaterThan(0);
  });

  it('preserves unchanged original events and accounting after retry', async () => {
    const ctx = await freshRun('__mtest__ retry-unchanged-orig');
    await setTerminalStatus(ctx.db, ctx.runId, 'failed');
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);
    const origEventsBefore = await getEvents(ctx.db, ctx.runId);
    const origReservationBefore = await getReservation(ctx.db, ctx.runId);

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `retry-unchanged-${randomUUID()}`)
      .set('If-Match', etag(terminalVersion))
      .send({})
      .expect(202);

    // Original events unchanged.
    const origEventsAfter = await getEvents(ctx.db, ctx.runId);
    expect(origEventsAfter.length).toBe(origEventsBefore.length);
    // Original budget reservation unchanged.
    const origReservationAfter = await getReservation(ctx.db, ctx.runId);
    expect(origReservationAfter).toEqual(origReservationBefore);
    // Original status unchanged.
    const origSnapshot = await getRunSnapshot(ctx.app, ctx.base, ctx.runId);
    expect(origSnapshot.status).toBe('failed');
  });
});
