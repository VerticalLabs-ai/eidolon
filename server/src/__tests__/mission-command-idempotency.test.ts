import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer, createTestApp } from '../test-utils.js';
import { MUTATION_MATRIX } from '../services/mission/mutation-matrix.js';
import { validateIdempotencyKey, commandRequestHash } from '../services/mission/idempotency.js';

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

/** Start a fresh run in a fresh scope so each test owns an isolated,
 * un-cancelled, current-version run. */
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

const etag = (v: number): string => `"${v}"`;

// ---------------------------------------------------------------------------
// VAL-RUN-114: Idempotency keys enforce syntax and length
// ---------------------------------------------------------------------------

describe('Mission idempotency key syntax and length (VAL-RUN-114)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  // The validator is the seam for boundary cases that HTTP cannot transport
  // (control chars are rejected by the HTTP layer; leading/trailing whitespace
  // is stripped by HTTP header parsing), so the contract is proven here.
  describe('validateIdempotencyKey boundary matrix', () => {
    const valid = [
      ['a', 'length 1'],
      ['x'.repeat(128), 'length 128'],
      ['key-with.symbols_123', 'safe symbols'],
    ];
    const invalid: Array<[string, string]> = [
      ['', 'empty'],
      [' ', 'whitespace only'],
      ['x'.repeat(129), 'over 128'],
      ['k\u0000ey', 'control char NUL'],
      ['k\u001fey', 'control char US'],
      ['k\u007fey', 'control char DEL'],
      [' key', 'leading whitespace'],
      ['key ', 'trailing whitespace'],
      ['\tkey', 'leading tab'],
    ];

    for (const [key, label] of valid) {
      it(`accepts a valid key (${label})`, () => {
        expect(validateIdempotencyKey(key)).toBe(key);
      });
    }
    for (const [key, label] of invalid) {
      it(`rejects an invalid key (${label}) with VALIDATION_ERROR`, () => {
        expect(() => validateIdempotencyKey(key)).toThrow();
        try {
          validateIdempotencyKey(key);
        } catch (err) {
          expect((err as { code: string }).code).toBe('VALIDATION_ERROR');
          expect((err as { status: number }).status).toBe(400);
        }
      });
    }
    it('rejects a missing key with VALIDATION_ERROR', () => {
      expect(() => validateIdempotencyKey(undefined)).toThrow();
    });
  });

  describe('route-level rejection is inert', () => {
    it('rejects a cancel without an Idempotency-Key with 400 and creates no command', async () => {
      const ctx = await freshRun('__mtest__ key-missing');
      const before = await countCommands(ctx.db, ctx.runId);
      const res = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .send({ reason: 'r' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(await countCommands(ctx.db, ctx.runId)).toBe(before);
      expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(0);
    });

    it('rejects an over-128 idempotency key with 400 and creates no command', async () => {
      const ctx = await freshRun('__mtest__ key-over128');
      const before = await countCommands(ctx.db, ctx.runId);
      const res = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', 'x'.repeat(129))
        .set('If-Match', etag(ctx.stateVersion))
        .send({ reason: 'r' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(await countCommands(ctx.db, ctx.runId)).toBe(before);
    });

    it('rejects an over-128 key on the canonical command route with 400', async () => {
      const ctx = await freshRun('__mtest__ key-over128-canonical');
      const before = await countCommands(ctx.db, ctx.runId);
      const res = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/commands`)
        .set('Idempotency-Key', 'x'.repeat(129))
        .set('If-Match', etag(ctx.stateVersion))
        .send({ type: 'run.cancel', reason: 'r' })
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(await countCommands(ctx.db, ctx.runId)).toBe(before);
    });

    it('accepts a valid 1- and 128-char key for cancel', async () => {
      for (const key of ['a', 'x'.repeat(128)]) {
        const ctx = await freshRun('__mtest__ key-valid');
        const res = await request(ctx.app)
          .post(`${ctx.base}/${ctx.runId}/cancel`)
          .set('Idempotency-Key', key)
          .set('If-Match', etag(ctx.stateVersion))
          .send({ reason: 'r' });
        expect([200, 202]).toContain(res.status);
        expect(res.body.code).toBeUndefined();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-052 / VAL-CROSS-004 / VAL-RUN-053: start exact replay & conflict
// ---------------------------------------------------------------------------

describe('Mission start idempotent replay and conflict (VAL-RUN-052, VAL-CROSS-004, VAL-RUN-053)', () => {
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
    const scope = await seedScope(db, '__mtest__ replay');
    companyId = scope.companyId;
    projectId = scope.projectId;
    threadId = scope.threadId;
    startUrl = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  });
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  const body = (text: string) => ({
    projectThreadId: threadId,
    mode: 'fast' as const,
    request: { text },
  });

  it('replays an identical start returning the same status, Location, ETag, command id, and body (one run, one reservation)', async () => {
    const first = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'replay-exact-001')
      .send(body('Do work'))
      .expect(202);
    const second = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'replay-exact-001')
      .send(body('Do work'))
      .expect(202);

    expect(second.status).toBe(first.status);
    expect(second.headers.location).toBe(first.headers.location);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(second.body.data.run.id).toBe(first.body.data.run.id);
    expect(second.body.data.command.id).toBe(first.body.data.command.id);
    expect(second.body.data.run).toEqual(first.body.data.run);
    expect(second.body.data.command).toEqual(first.body.data.command);

    const [runCount] = (await db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE "id" = ${first.body.data.run.id}`,
    )) as unknown as { c: number }[];
    expect(runCount.c).toBe(1);
    const [resCount] = (await db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "budget_reservations" WHERE "run_id" = ${first.body.data.run.id}`,
    )) as unknown as { c: number }[];
    expect(resCount.c).toBe(1);
    // Replay returned the original ETag even though the run is unchanged.
    expect(second.headers.etag).toBe(`"${first.body.data.run.stateVersion}"`);
  });

  it('replays an identical start with the original result even after the run advanced', async () => {
    const first = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'replay-advanced-001')
      .send(body('Advance me'))
      .expect(202);
    const runId = first.body.data.run.id as string;
    const originalEtag = first.headers.etag;

    // Advance the run version independently (simulate work progressing).
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "state_version" = "state_version" + 1, "updated_at" = ${new Date()} WHERE "id" = ${runId}
    `);

    const second = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'replay-advanced-001')
      .send(body('Advance me'))
      .expect(202);
    // Durable replay returns the ORIGINAL ETag/body, not the current snapshot.
    expect(second.headers.etag).toBe(originalEtag);
    expect(second.body.data.run.stateVersion).toBe(first.body.data.run.stateVersion);
    expect(second.body.data.run.id).toBe(runId);
  });

  it('rejects reusing a start idempotency key with different content (409 IDEMPOTENCY_KEY_REUSED)', async () => {
    await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'replay-conflict-001')
      .send(body('Original'))
      .expect(202);

    const res = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'replay-conflict-001')
      .send(body('Different content'))
      .expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-039: Duplicate cancellation is idempotent
// ---------------------------------------------------------------------------

describe('Mission duplicate cancellation is idempotent (VAL-RUN-039)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('repeats the same cancellation command returning the original outcome with no duplicate event', async () => {
    const ctx = await freshRun('__mtest__ cancel-dup');
    const first = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'cancel-dup-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'too slow' })
      .expect(202);
    expect(first.body.data.run.cancelRequestedAt).not.toBeNull();

    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(1);

    const second = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'cancel-dup-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'too slow' })
      .expect(202);

    expect(second.body.data.command.id).toBe(first.body.data.command.id);
    expect(second.body.data.run.id).toBe(first.body.data.run.id);
    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(1);
  });

  it('rejects reusing a cancel idempotency key with different content (409)', async () => {
    const ctx = await freshRun('__mtest__ cancel-conflict');
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'cancel-conflict-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'first reason' })
      .expect(202);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'cancel-conflict-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'different reason' })
      .expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-054 / VAL-RUN-055: preconditions (If-Match required + stale)
// ---------------------------------------------------------------------------

describe('Mission command preconditions (VAL-RUN-054, VAL-RUN-055)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('rejects a nonterminal cancel without If-Match (428 PRECONDITION_REQUIRED)', async () => {
    const ctx = await freshRun('__mtest__ precond-missing');
    const before = await getRunVersion(ctx.db, ctx.runId);
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'cancel-precond-001')
      .send({ reason: 'r' })
      .expect(428);
    expect(res.body.code).toBe('PRECONDITION_REQUIRED');
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(before);
    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(0);
  });

  it('rejects a cancel with a stale If-Match (412 RUN_VERSION_MISMATCH)', async () => {
    const ctx = await freshRun('__mtest__ precond-stale');
    const staleVersion = ctx.stateVersion;
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'cancel-advance-001')
      .set('If-Match', etag(staleVersion))
      .send({ reason: 'advance' })
      .expect(202);
    const newVersion = await getRunVersion(ctx.db, ctx.runId);
    expect(newVersion).toBeGreaterThan(staleVersion);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'cancel-stale-001')
      .set('If-Match', etag(staleVersion))
      .send({ reason: 'stale' })
      .expect(412);
    expect(res.body.code).toBe('RUN_VERSION_MISMATCH');
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(newVersion);
  });

  it('rejects a retry without If-Match (428) and with a stale If-Match (412)', async () => {
    const ctx = await freshRun('__mtest__ retry-precond');
    await setRunStatus(ctx.db, ctx.runId, 'failed', true);
    const terminalVersion = await getRunVersion(ctx.db, ctx.runId);

    const noMatch = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'retry-precond-001')
      .send({})
      .expect(428);
    expect(noMatch.body.code).toBe('PRECONDITION_REQUIRED');

    const stale = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'retry-precond-002')
      .set('If-Match', etag(terminalVersion - 1))
      .send({})
      .expect(412);
    expect(stale.body.code).toBe('RUN_VERSION_MISMATCH');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-058: Invalid transition is explicit
// ---------------------------------------------------------------------------

describe('Mission invalid transition is explicit (VAL-RUN-058)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('rejects a retry from a nonterminal run with 409 INVALID_RUN_STATE and leaves it unchanged', async () => {
    const ctx = await freshRun('__mtest__ retry-nonterminal');
    const version = await getRunVersion(ctx.db, ctx.runId);
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'retry-nonterminal-001')
      .set('If-Match', etag(version))
      .send({})
      .expect(409);
    expect(res.body.code).toBe('INVALID_RUN_STATE');
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(version);
    const [succ] = (await ctx.db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE "retry_of_run_id" = ${ctx.runId}`,
    )) as unknown as { c: number }[];
    expect(succ.c).toBe(0);
  });

  it('rejects a retry from a completed run with 409 INVALID_RUN_STATE', async () => {
    const ctx = await freshRun('__mtest__ retry-completed');
    await setRunStatus(ctx.db, ctx.runId, 'completed', true);
    const version = await getRunVersion(ctx.db, ctx.runId);
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', 'retry-completed-001')
      .set('If-Match', etag(version))
      .send({})
      .expect(409);
    expect(res.body.code).toBe('INVALID_RUN_STATE');
    const [succ] = (await ctx.db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE "retry_of_run_id" = ${ctx.runId}`,
    )) as unknown as { c: number }[];
    expect(succ.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-115: Canonical and convenience command routes are equivalent
// ---------------------------------------------------------------------------

describe('Mission canonical and convenience routes are equivalent (VAL-RUN-115)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('replays an identical cancel across canonical and convenience routes (one command, one outcome)', async () => {
    const ctx = await freshRun('__mtest__ xroute-cancel');
    const canonical = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', 'xroute-cancel-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ type: 'run.cancel', reason: 'cross route' })
      .expect(202);

    const convenience = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'xroute-cancel-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ reason: 'cross route' })
      .expect(202);

    expect(convenience.body.data.command.id).toBe(canonical.body.data.command.id);
    expect(convenience.body.data.run.id).toBe(canonical.body.data.run.id);
    expect(await countEvents(ctx.db, ctx.runId, 'run.cancel_requested')).toBe(1);
    const [cmdCount] = (await ctx.db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "run_commands" WHERE "run_id" = ${ctx.runId} AND "idempotency_key" = 'xroute-cancel-001'`,
    )) as unknown as { c: number }[];
    expect(cmdCount.c).toBe(1);
  });

  it('returns 409 IDEMPOTENCY_KEY_REUSED when the same key carries changed discriminated content', async () => {
    const ctx = await freshRun('__mtest__ xroute-conflict');
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', 'xroute-conflict-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ type: 'run.cancel', reason: 'one' })
      .expect(202);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', 'xroute-conflict-001')
      .set('If-Match', etag(ctx.stateVersion))
      .send({ type: 'run.retry' })
      .expect(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('commandRequestHash matches across canonical and convenience logical content', () => {
    expect(commandRequestHash('run.cancel', { reason: 'x' })).toBe(
      commandRequestHash('run.cancel', { reason: 'x' }),
    );
    expect(commandRequestHash('run.cancel', { reason: 'x' })).not.toBe(
      commandRequestHash('run.cancel', { reason: 'y' }),
    );
    expect(commandRequestHash('run.cancel', { reason: 'x' })).not.toBe(
      commandRequestHash('run.retry', {}),
    );
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-116: Applied idempotency survives process restart
// ---------------------------------------------------------------------------

describe('Mission applied idempotency survives restart (VAL-RUN-116)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
  });
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('replays start, cancel, and retry identically after a fresh app instance with no second effect', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ restart');
    const startUrl = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const base = startUrl;

    const start1 = await request(app)
      .post(startUrl)
      .set('Idempotency-Key', 'restart-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } })
      .expect(202);
    const runId = start1.body.data.run.id as string;
    const version = start1.body.data.run.stateVersion as number;

    const cancel1 = await request(app)
      .post(`${base}/${runId}/cancel`)
      .set('Idempotency-Key', 'restart-cancel-001')
      .set('If-Match', etag(version))
      .send({ reason: 'restart cancel' })
      .expect(202);

    await setRunStatus(db, runId, 'failed', true);
    const failedVersion = await getRunVersion(db, runId);
    const retry1 = await request(app)
      .post(`${base}/${runId}/retry`)
      .set('Idempotency-Key', 'restart-retry-001')
      .set('If-Match', etag(failedVersion))
      .send({})
      .expect(202);
    const successorId = retry1.body.data.run.id as string;

    const eventsBefore = await countEvents(db, runId);
    const successorEventsBefore = await countEvents(db, successorId);
    const [resBefore] = (await db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "budget_reservations" WHERE "run_id" = ${successorId}`,
    )) as unknown as { c: number }[];
    const [succBefore] = (await db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE "retry_of_run_id" = ${runId}`,
    )) as unknown as { c: number }[];

    // Simulate an API restart: a brand-new Express app over the SAME db.
    const restartedApp = createTestApp(db);

    const start2 = await request(restartedApp)
      .post(startUrl)
      .set('Idempotency-Key', 'restart-start-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } })
      .expect(202);
    expect(start2.status).toBe(start1.status);
    expect(start2.headers.location).toBe(start1.headers.location);
    expect(start2.headers.etag).toBe(start1.headers.etag);
    expect(start2.body.data.run.id).toBe(runId);
    expect(start2.body.data.command.id).toBe(start1.body.data.command.id);

    const cancel2 = await request(restartedApp)
      .post(`${base}/${runId}/cancel`)
      .set('Idempotency-Key', 'restart-cancel-001')
      .set('If-Match', etag(version))
      .send({ reason: 'restart cancel' })
      .expect(202);
    expect(cancel2.body.data.command.id).toBe(cancel1.body.data.command.id);
    expect(cancel2.body.data.run.id).toBe(runId);

    const retry2 = await request(restartedApp)
      .post(`${base}/${runId}/retry`)
      .set('Idempotency-Key', 'restart-retry-001')
      .set('If-Match', etag(failedVersion))
      .send({})
      .expect(202);
    expect(retry2.body.data.run.id).toBe(successorId);
    expect(retry2.body.data.command.id).toBe(retry1.body.data.command.id);

    expect(await countEvents(db, runId)).toBe(eventsBefore);
    expect(await countEvents(db, successorId)).toBe(successorEventsBefore);
    const [resAfter] = (await db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "budget_reservations" WHERE "run_id" = ${successorId}`,
    )) as unknown as { c: number }[];
    expect(resAfter.c).toBe(resBefore.c);
    const [succAfter] = (await db.drizzle.execute(
      sql`SELECT count(*)::int AS c FROM "mission_runs" WHERE "retry_of_run_id" = ${runId}`,
    )) as unknown as { c: number }[];
    expect(succAfter.c).toBe(succBefore.c);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-137: Mutation preconditions have one declared matrix
// ---------------------------------------------------------------------------

describe('Mission mutation precondition matrix (VAL-RUN-137)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('declares a machine-readable matrix entry for every stable command type', () => {
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
      expect(MUTATION_MATRIX[t]).toBeDefined();
      const entry = MUTATION_MATRIX[t];
      expect(entry.idempotencyKeyRequired).toBe(true);
      expect(typeof entry.ifMatch).toBe('string');
      expect(typeof entry.successStatus).toBe('number');
      expect(Array.isArray(entry.legalSourceStates)).toBe(true);
    }
    expect(MUTATION_MATRIX['run.start'].ifMatch).toBe('none');
    expect(MUTATION_MATRIX['questions.answer'].ifMatch).toBe('required');
    expect(MUTATION_MATRIX['plan.approve'].ifMatch).toBe('required');
    expect(MUTATION_MATRIX['plan.reject'].ifMatch).toBe('required');
    expect(MUTATION_MATRIX['plan.revision_request'].ifMatch).toBe('required');
    expect(MUTATION_MATRIX['run.cancel'].ifMatch).toBe('required-nonterminal');
    expect(MUTATION_MATRIX['run.retry'].ifMatch).toBe('required-terminal');
  });

  it('cancel already-terminal behavior returns 200 with the current snapshot and no new event', async () => {
    const ctx = await freshRun('__mtest__ matrix-cancel-terminal');
    await setRunStatus(ctx.db, ctx.runId, 'completed', true);
    const v = await getRunVersion(ctx.db, ctx.runId);
    const eventsBefore = await countEvents(ctx.db, ctx.runId);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'matrix-cancel-terminal-001')
      .send({ reason: 'late cancel' })
      .expect(200);
    expect(res.body.data.run.status).toBe('completed');
    expect(await getRunVersion(ctx.db, ctx.runId)).toBe(v);
    expect(await countEvents(ctx.db, ctx.runId)).toBe(eventsBefore);
  });

  it('cancel same-key replay wins after the run advanced (no 412)', async () => {
    const ctx = await freshRun('__mtest__ matrix-advance');
    const v0 = ctx.stateVersion;
    const applied = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'matrix-adv-cancel-001')
      .set('If-Match', etag(v0))
      .send({ reason: 'advance' })
      .expect(202);

    // Advance the run version independently.
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "state_version" = "state_version" + 1, "updated_at" = ${new Date()} WHERE "id" = ${ctx.runId}
    `);

    const replay = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', 'matrix-adv-cancel-001')
      .set('If-Match', etag(v0))
      .send({ reason: 'advance' })
      .expect(202);
    expect(replay.body.data.command.id).toBe(applied.body.data.command.id);
  });

  it('rejects mutations with a cross-scope run id (404 RUN_NOT_FOUND)', async () => {
    const ctx = await freshRun('__mtest__ matrix-xscope');
    const other = await seedScope(ctx.db, '__mtest__ matrix other');
    const otherUrl = `/api/companies/${other.companyId}/projects/${other.projectId}/mission-runs`;
    const start = await request(ctx.app)
      .post(otherUrl)
      .set('Idempotency-Key', 'matrix-xscope-start-001')
      .send({ projectThreadId: other.threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);
    const otherRunId = start.body.data.run.id as string;

    const res = await request(ctx.app)
      .post(`${ctx.base}/${otherRunId}/cancel`)
      .set('Idempotency-Key', 'matrix-xscope-cancel-001')
      .set('If-Match', etag(1))
      .send({ reason: 'x' })
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });
});
