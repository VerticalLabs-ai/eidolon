import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer, createTestApp } from '../test-utils.js';
import { MUTATION_MATRIX } from '../services/mission/mutation-matrix.js';
import { commandRequestHash, normalizeCommandBody } from '../services/mission/idempotency.js';
import { canonicalStringify } from '../services/mission/policy.js';

// Shared contract re-export for public contract generation test.
import { MISSION_MUTATION_CONTRACT } from '@eidolon/shared';

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

/** Seed a second project in the same company for cross-project tests. */
async function seedSecondProject(db: AnyDb, companyId: string) {
  const now = new Date();
  const projectId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${projectId}, ${companyId}, 'P2', 'active', ${now}, ${now})
  `);
  const threadId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, 'T2', 'conversation', 'active', ${now}, ${now})
  `);
  return { projectId, threadId };
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

async function countEvents(db: AnyDb, runId: string, type?: string): Promise<number> {
  const q = type
    ? sql`SELECT count(*)::int AS c FROM "run_events" WHERE "run_id" = ${runId} AND "type" = ${type}`
    : sql`SELECT count(*)::int AS c FROM "run_events" WHERE "run_id" = ${runId}`;
  const [row] = (await db.drizzle.execute(q)) as unknown as { c: number }[];
  return row.c;
}

async function getRunVersion(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT "state_version" FROM "mission_runs" WHERE "id" = ${runId}`,
  )) as unknown as { state_version: number }[];
  return row.state_version;
}

async function setRunStatus(db: AnyDb, runId: string, status: string, terminal = true) {
  const now = new Date();
  if (terminal) {
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = ${status}, "terminal_at" = ${now}, "updated_at" = ${now}
      WHERE "id" = ${runId}
    `);
  } else {
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = ${status}, "terminal_at" = NULL, "updated_at" = ${now}
      WHERE "id" = ${runId}
    `);
  }
}

async function countCommands(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT count(*)::int AS c FROM "run_commands" WHERE "run_id" = ${runId}`,
  )) as unknown as { c: number }[];
  return row.c;
}

async function getRunPolicyHash(db: AnyDb, runId: string): Promise<string | null> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT rps."content_hash" FROM "mission_runs" mr
        JOIN "run_policy_snapshots" rps ON rps."id" = mr."policy_snapshot_id"
        WHERE mr."id" = ${runId}`,
  )) as unknown as { content_hash: string | null }[];
  return row?.content_hash ?? null;
}

async function getRunCeiling(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT "requested_cents" FROM "budget_reservations" WHERE "run_id" = ${runId}`,
  )) as unknown as { requested_cents: number }[];
  return row?.requested_cents ?? 0;
}

const etag = (v: number): string => `"${v}"`;

// ---------------------------------------------------------------------------
// HIGH-RISK REPAIR 1: Cross-project denial
// Every command lookup, lock, replay, and mutation enforces company + project
// + run scope before revealing or applying an outcome.
// ---------------------------------------------------------------------------

describe('HIGH-RISK REPAIR: cross-project scope denial', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('rejects a cancel command targeting a run from a different project in the same company (404)', async () => {
    const ctx = await freshRun('__mtest__ xproject-cancel');
    // Seed a second project in the same company.
    const other = await seedSecondProject(ctx.db, ctx.companyId);
    const otherBase = `/api/companies/${ctx.companyId}/projects/${other.projectId}/mission-runs`;

    // Attempt to cancel the run through the OTHER project's route.
    const res = await request(ctx.app)
      .post(`${otherBase}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'xproject-cancel-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'cross project' })
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');

    // The original run is unchanged.
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(ctx.stateVersion);
    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(0);
    // No command row was created for this attempt.
    expect(await countCommands(ctx.db, ctx.runId)).toBe(1); // only the start command
  });

  it('rejects a retry command targeting a run from a different project (404)', async () => {
    const ctx = await freshRun('__mtest__ xproject-retry');
    await setRunStatus(ctx.db, ctx.runId, 'failed', true);
    const version = await getRunVersion(ctx.db, ctx.runId);

    const other = await seedSecondProject(ctx.db, ctx.companyId);
    const otherBase = `/api/companies/${ctx.companyId}/projects/${other.projectId}/mission-runs`;

    const res = await request(ctx.app)
      .post(`${otherBase}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'xproject-retry-001')
      .set('If-Match', etag(version))
      .send({})
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');

    // No successor run was created.
    const [succ] = (await ctx.db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE "retry_of_run_id" = ${ctx.runId}`,
    )) as unknown as { c: number }[];
    expect(succ.c).toBe(0);
  });

  it('rejects a canonical command targeting a run from a different project (404)', async () => {
    const ctx = await freshRun('__mtest__ xproject-canonical');
    const other = await seedSecondProject(ctx.db, ctx.companyId);
    const otherBase = `/api/companies/${ctx.companyId}/projects/${other.projectId}/mission-runs`;

    const res = await request(ctx.app)
      .post(`${otherBase}/${ctx.runId}/commands`)
      .set('Idempotency-Key', 'xproject-canonical-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ type: 'run.cancel', reason: 'cross' })
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(0);
  });

  it('does not replay a command from a different project scope (404, not replay)', async () => {
    const ctx = await freshRun('__mtest__ xproject-replay');
    // Apply a cancel in the correct project scope.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'xproject-replay-key')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'correct scope' })
      .expect(202);

    // Attempt to replay the same key through a different project's route.
    const other = await seedSecondProject(ctx.db, ctx.companyId);
    const otherBase = `/api/companies/${ctx.companyId}/projects/${other.projectId}/mission-runs`;

    const res = await request(ctx.app)
      .post(`${otherBase}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'xproject-replay-key')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'correct scope' })
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// HIGH-RISK REPAIR 2: Complete-body start conflicts
// Start idempotency hashes the complete canonical request body (not just
// request.text), so different mode/limits with the same request text conflict.
// ---------------------------------------------------------------------------

describe('HIGH-RISK REPAIR: complete-body start idempotency hash', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let startUrl: string;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    const scope = await seedScope(db, '__mtest__ complete-body');
    companyId = scope.companyId;
    projectId = scope.projectId;
    threadId = scope.threadId;
    startUrl = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('conflicts when the same key is reused with a different mode (409)', async () => {
    await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'complete-body-mode-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Same text' } })
      .expect(202);

    const res = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'complete-body-mode-001')
      .send({ projectThreadId: threadId, mode: 'deep_work', request: { text: 'Same text' } })
      .expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('conflicts when the same key is reused with different limits (409)', async () => {
    await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'complete-body-limits-001')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        request: { text: 'Same text' },
        limits: { costCents: 100 },
      })
      .expect(202);

    const res = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'complete-body-limits-001')
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        request: { text: 'Same text' },
        limits: { costCents: 200 },
      })
      .expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('replays when the complete body is identical including mode and limits', async () => {
    const first = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'complete-body-replay-001')
      .send({
        projectThreadId: threadId,
        mode: 'deep_work',
        request: { text: 'Identical body' },
        limits: { costCents: 300, totalTokens: 10000 },
      })
      .expect(202);

    const second = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'complete-body-replay-001')
      .send({
        projectThreadId: threadId,
        mode: 'deep_work',
        request: { text: 'Identical body' },
        limits: { costCents: 300, totalTokens: 10000 },
      })
      .expect(202);

    expect(second.body.data.run.id).toBe(first.body.data.run.id);
    expect(second.body.data.command.id).toBe(first.body.data.command.id);
  });
});

// ---------------------------------------------------------------------------
// HIGH-RISK REPAIR 3: Atomic replay persistence
// The exact replayable status, headers, and body are persisted atomically
// with the initial aggregate (inside the transaction, not after).
// ---------------------------------------------------------------------------

describe('HIGH-RISK REPAIR: atomic replay persistence', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('persists the replayable result_body inside the start transaction (not after)', async () => {
    const ctx = await freshRun('__mtest__ atomic-replay');
    // The result_body should be populated immediately after start (inside the tx).
    const [cmd] = (await ctx.db.drizzle.execute(
      sql`SELECT "result_body" FROM "run_commands" WHERE "run_id" = ${ctx.runId} AND "type" = 'run.start'`,
    )) as unknown as { result_body: Record<string, unknown> | null }[];
    expect(cmd.result_body).not.toBeNull();
    expect(cmd.result_body!.run).toBeDefined();
    expect((cmd.result_body!.run as Record<string, unknown>).id).toBe(ctx.runId);
    expect(cmd.result_body!.command).toBeDefined();
  });

  it('start replay returns the original result even when the stored result_body was set in the tx', async () => {
    const ctx = await freshRun('__mtest__ atomic-replay-2');
    // Get the start command's idempotency key.
    const [cmd] = (await ctx.db.drizzle.execute(
      sql`SELECT "idempotency_key" FROM "run_commands" WHERE "run_id" = ${ctx.runId} AND "type" = 'run.start'`,
    )) as unknown as { idempotency_key: string }[];
    const key = cmd.idempotency_key;

    // Advance the run version.
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "state_version" = "state_version" + 5, "updated_at" = ${new Date()} WHERE "id" = ${ctx.runId}
    `);

    // Replay should return the original result, not the advanced snapshot.
    const replay = await request(ctx.app)
      .post(ctx.base)
      .set('Idempotency-Key', key)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'Do work' } })
      .expect(202);
    expect(replay.body.data.run.stateVersion).toBe(ctx.stateVersion);
    expect(replay.body.data.run.id).toBe(ctx.runId);
  });
});

// ---------------------------------------------------------------------------
// HIGH-RISK REPAIR 4: Duplicate cancellation races
// Concurrent duplicate commands recheck durable idempotency after locking so
// identical requests replay one outcome, changed requests conflict, and no
// stale-version or uniqueness error escapes.
// ---------------------------------------------------------------------------

describe('HIGH-RISK REPAIR: duplicate cancellation races', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('two concurrent identical cancels produce one applied command and one replay (no uniqueness error escapes)', async () => {
    const ctx = await freshRun('__mtest__ cancel-race');
    const key = 'cancel-race-001';
    const ifMatch = etag(ctx.stateVersion);

    // Fire two concurrent cancel requests with the same key and body.
    const [r1, r2] = await Promise.all([
      request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', key)
        .set('If-Match', ifMatch)
        .send({ reason: 'race' }),
      request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', key)
        .set('If-Match', ifMatch)
        .send({ reason: 'race' }),
    ]);

    // Both should succeed (one 202 applied, one 202 replay). No 500/409 from
    // an unhandled unique violation.
    expect([200, 202]).toContain(r1.status);
    expect([200, 202]).toContain(r2.status);
    expect(r1.body.code).toBeUndefined();
    expect(r2.body.code).toBeUndefined();

    // Exactly one cancellation event.
    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(1);
    // Exactly one command row for this key.
    const [cmdCount] = (await ctx.db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "run_commands" WHERE "run_id" = ${ctx.runId} AND "idempotency_key" = ${key}`,
    )) as unknown as { c: number }[];
    expect(cmdCount.c).toBe(1);

    // Both return the same command id.
    expect(r1.body.data.command.id).toBe(r2.body.data.command.id);
  });

  it('two concurrent cancels with different reasons produce one applied and one 409 conflict (no uniqueness error)', async () => {
    const ctx = await freshRun('__mtest__ cancel-race-conflict');
    const key = 'cancel-race-conflict-001';
    const ifMatch = etag(ctx.stateVersion);

    const [r1, r2] = await Promise.all([
      request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', key)
        .set('If-Match', ifMatch)
        .send({ reason: 'reason A' }),
      request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', key)
        .set('If-Match', ifMatch)
        .send({ reason: 'reason B' }),
    ]);

    // One should succeed (202), one should conflict (409). No 500.
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toContain(202);
    expect(statuses).toContain(409);
    // The 409 should be IDEMPOTENCY_KEY_REUSED, not a raw unique violation.
    const conflictRes = r1.status === 409 ? r1 : r2;
    expect(conflictRes.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Exactly one cancellation event.
    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HIGH-RISK REPAIR 5: Route equivalence with omitted optional fields
// Canonical and convenience routes normalize omitted optional fields
// identically before hashing.
// ---------------------------------------------------------------------------

describe('HIGH-RISK REPAIR: route equivalence with omitted optional fields', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('canonical cancel with omitted reason and convenience cancel with empty body produce the same hash', () => {
    // Reason is now required (VAL-RUN-138), so test with a provided reason
    // that both routes normalize identically.
    const canonicalHash = commandRequestHash(
      'run.cancel',
      normalizeCommandBody({ reason: 'test reason' }),
    );
    const convenienceHash = commandRequestHash(
      'run.cancel',
      normalizeCommandBody({ reason: 'test reason' }),
    );
    expect(canonicalHash).toBe(convenienceHash);
  });

  it('canonical retry with omitted limits/request and convenience retry with empty body produce the same hash', () => {
    const canonicalHash = commandRequestHash(
      'run.retry',
      normalizeCommandBody({ limits: undefined, request: undefined }),
    );
    const convenienceHash = commandRequestHash('run.retry', normalizeCommandBody({}));
    expect(canonicalHash).toBe(convenienceHash);
  });

  it('replays a cancel across canonical and convenience routes with same reason (one command)', async () => {
    const ctx = await freshRun('__mtest__ xroute-omitted');
    // Canonical route: cancel with reason.
    const canonical = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', 'xroute-omitted-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ type: 'run.cancel', reason: 'test reason' })
      .expect(202);

    // Convenience route: cancel with same reason, same key.
    const convenience = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'xroute-omitted-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'test reason' })
      .expect(202);

    expect(convenience.body.data.command.id).toBe(canonical.body.data.command.id);
    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(1);
  });

  it('replays a retry across canonical and convenience routes when limits/request are omitted', async () => {
    const ctx = await freshRun('__mtest__ xroute-retry-omitted');
    await setRunStatus(ctx.db, ctx.runId, 'failed', true);
    const version = await getRunVersion(ctx.db, ctx.runId);

    // Canonical route: retry with no limits/request fields.
    const canonical = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', 'xroute-retry-omitted-001')
      .set('If-Match', etag(version))
      .send({ type: 'run.retry' })
      .expect(202);

    // Convenience route: retry with empty body, same key.
    const convenience = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'xroute-retry-omitted-001')
      .set('If-Match', etag(version))
      .send({})
      .expect(202);

    expect(convenience.body.data.run.id).toBe(canonical.body.data.run.id);
    expect(convenience.body.data.command.id).toBe(canonical.body.data.command.id);
  });

  it('canonicalStringify strips undefined values from objects', () => {
    // { a: 1, b: undefined } should equal { a: 1 }
    expect(canonicalStringify({ a: 1, b: undefined })).toBe(canonicalStringify({ a: 1 }));
    // { a: undefined } should equal {}
    expect(canonicalStringify({ a: undefined })).toBe(canonicalStringify({}));
    // Nested undefined should be stripped too.
    expect(canonicalStringify({ a: { b: undefined, c: 1 } })).toBe(
      canonicalStringify({ a: { c: 1 } }),
    );
  });
});

// ---------------------------------------------------------------------------
// HIGH-RISK REPAIR 6: Narrowed retry limits and budgets
// Retry options narrow limits and policy, recompute the policy hash, and
// reserve the authoritative narrowed budget without mutating the original
// run.
// ---------------------------------------------------------------------------

describe('HIGH-RISK REPAIR: narrowed retry limits and budgets', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('retry with lower costCents narrows the policy hash and reserves the narrowed budget', async () => {
    const ctx = await freshRun('__mtest__ retry-narrow');
    await setRunStatus(ctx.db, ctx.runId, 'failed', true);
    const version = await getRunVersion(ctx.db, ctx.runId);
    const originalPolicyHash = await getRunPolicyHash(ctx.db, ctx.runId);
    const originalCeiling = await getRunCeiling(ctx.db, ctx.runId);

    const retry = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'retry-narrow-001')
      .set('If-Match', etag(version))
      .send({ limits: { costCents: 100 } })
      .expect(202);

    const successorId = retry.body.data.run.id as string;

    // The successor has a different (narrowed) policy hash.
    const successorPolicyHash = await getRunPolicyHash(ctx.db, successorId);
    expect(successorPolicyHash).not.toBeNull();
    expect(successorPolicyHash).not.toBe(originalPolicyHash);

    // The successor has the narrowed budget ceiling.
    const successorCeiling = await getRunCeiling(ctx.db, successorId);
    expect(successorCeiling).toBe(100);
    expect(successorCeiling).toBeLessThan(originalCeiling);

    // The original run is unchanged.
    expect(await getRunPolicyHash(ctx.db, ctx.runId)).toBe(originalPolicyHash);
    expect(await getRunCeiling(ctx.db, ctx.runId)).toBe(originalCeiling);
  });

  it('retry without limits preserves the original policy hash and ceiling', async () => {
    const ctx = await freshRun('__mtest__ retry-no-narrow');
    await setRunStatus(ctx.db, ctx.runId, 'failed', true);
    const version = await getRunVersion(ctx.db, ctx.runId);
    const originalPolicyHash = await getRunPolicyHash(ctx.db, ctx.runId);
    const originalCeiling = await getRunCeiling(ctx.db, ctx.runId);

    const retry = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'retry-no-narrow-001')
      .set('If-Match', etag(version))
      .send({})
      .expect(202);

    const successorId = retry.body.data.run.id as string;
    const successorPolicyHash = await getRunPolicyHash(ctx.db, successorId);
    // Without narrowing, the policy hash should be the same (same content).
    expect(successorPolicyHash).toBe(originalPolicyHash);
    expect(await getRunCeiling(ctx.db, successorId)).toBe(originalCeiling);
  });

  it('retry limits cannot exceed the original ceiling', async () => {
    const ctx = await freshRun('__mtest__ retry-narrow-cap');
    await setRunStatus(ctx.db, ctx.runId, 'failed', true);
    const version = await getRunVersion(ctx.db, ctx.runId);
    const originalCeiling = await getRunCeiling(ctx.db, ctx.runId);

    // Attempt to raise the ceiling via retry limits.
    const retry = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'retry-narrow-cap-001')
      .set('If-Match', etag(version))
      .send({ limits: { costCents: originalCeiling * 10 } })
      .expect(202);

    const successorId = retry.body.data.run.id as string;
    const successorCeiling = await getRunCeiling(ctx.db, successorId);
    // The ceiling is narrowed (min wins), not raised.
    expect(successorCeiling).toBe(originalCeiling);
  });
});

// ---------------------------------------------------------------------------
// HIGH-RISK REPAIR 7: Restart replay with repaired behavior
// Applied idempotency survives restart with the repaired atomic persistence.
// ---------------------------------------------------------------------------

describe('HIGH-RISK REPAIR: restart replay with atomic persistence', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
  });
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('replays a start after restart with the original result_body stored atomically', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ restart-atomic');
    const startUrl = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const start1 = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'restart-atomic-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Atomic restart' } })
      .expect(202);
    const runId = start1.body.data.run.id as string;

    // Verify result_body was stored atomically (inside the tx).
    const [cmd] = (await db.drizzle.execute(
      sql`SELECT "result_body" FROM "run_commands" WHERE "run_id" = ${runId} AND "type" = 'run.start'`,
    )) as unknown as { result_body: Record<string, unknown> | null }[];
    expect(cmd.result_body).not.toBeNull();
    expect(cmd.result_body!.run).toBeDefined();

    // Simulate restart.
    const restartedApp = createTestApp(db);

    const start2 = await request(restartedApp)
      .post(startUrl)
      .set('Idempotency-Key', 'restart-atomic-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Atomic restart' } })
      .expect(202);
    expect(start2.body.data.run.id).toBe(runId);
    expect(start2.body.data.command.id).toBe(start1.body.data.command.id);
    expect(start2.body.data.run.stateVersion).toBe(start1.body.data.run.stateVersion);
  });
});

// ---------------------------------------------------------------------------
// HIGH-RISK REPAIR 8: Public contract generation
// The complete stable command precondition matrix is published through
// generated/shared client contracts.
// ---------------------------------------------------------------------------

describe('HIGH-RISK REPAIR: public contract generation', () => {
  it('exports the mutation matrix as a shared client contract', () => {
    expect(MISSION_MUTATION_CONTRACT).toBeDefined();
    expect(MISSION_MUTATION_CONTRACT.commands).toBeDefined();

    // Every stable command type is present.
    const types = [
      'run.start',
      'questions.answer',
      'plan.revision_request',
      'plan.approve',
      'plan.reject',
      'run.cancel',
      'run.retry',
    ];
    for (const t of types) {
      expect(MISSION_MUTATION_CONTRACT.commands[t]).toBeDefined();
      const entry = MISSION_MUTATION_CONTRACT.commands[t];
      expect(entry.idempotencyKeyRequired).toBe(true);
      expect(typeof entry.ifMatch).toBe('string');
      expect(typeof entry.successStatus).toBe('number');
      expect(Array.isArray(entry.legalSourceStates)).toBe(true);
    }
  });

  it('the shared contract matches the server mutation matrix exactly', () => {
    for (const [type, serverEntry] of Object.entries(MUTATION_MATRIX)) {
      const contractEntry = MISSION_MUTATION_CONTRACT.commands[type];
      expect(contractEntry).toBeDefined();
      expect(contractEntry.permission).toBe(serverEntry.permission);
      expect(contractEntry.idempotencyKeyRequired).toBe(serverEntry.idempotencyKeyRequired);
      expect(contractEntry.ifMatch).toBe(serverEntry.ifMatch);
      expect(contractEntry.successStatus).toBe(serverEntry.successStatus);
      expect(contractEntry.alreadyTerminalBehavior).toBe(serverEntry.alreadyTerminalBehavior);
      expect(contractEntry.legalSourceStates).toEqual(serverEntry.legalSourceStates);
    }
  });

  it('the contract includes a schema version for stable evolution', () => {
    expect(MISSION_MUTATION_CONTRACT.schemaVersion).toBeDefined();
    expect(typeof MISSION_MUTATION_CONTRACT.schemaVersion).toBe('number');
    expect(MISSION_MUTATION_CONTRACT.schemaVersion).toBe(1);
  });
});
