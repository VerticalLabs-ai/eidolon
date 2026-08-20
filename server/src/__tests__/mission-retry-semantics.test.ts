import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer } from '../test-utils.js';
import {
  MissionRetryService,
  classifyFailure,
  computeBackoff,
  decideRetry,
  type ExecutionFailureInput,
} from '../services/mission/retry.js';

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
    base,
  };
}

/** Move a run into the `running` execution state with a held lease. */
async function setRunning(
  db: AnyDb,
  runId: string,
  opts: { attemptCount?: number; leaseOwner?: string; cancelRequested?: boolean } = {},
) {
  const now = new Date();
  const leaseOwner = opts.leaseOwner ?? `worker-${randomUUID()}`;
  const leaseExpires = new Date(now.getTime() + 30_000);
  const cancelAt = opts.cancelRequested ? now : null;
  const cancelBy = opts.cancelRequested ? 'user-1' : null;
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = 'running',
        "terminal_at" = NULL,
        "started_at" = ${now},
        "available_at" = NULL,
        "lease_owner" = ${leaseOwner},
        "lease_token" = ${randomUUID()},
        "lease_expires_at" = ${leaseExpires},
        "heartbeat_at" = ${now},
        "attempt_count" = ${opts.attemptCount ?? 0},
        "cancel_requested_at" = ${cancelAt},
        "cancel_requested_by" = ${cancelBy},
        "updated_at" = ${now}
    WHERE "id" = ${runId}
  `);
}

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) {
    return null;
  }
  return v instanceof Date ? v : new Date(v as string);
}

async function getRun(db: AnyDb, runId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "id", "status", "state_version" AS "stateVersion",
           "last_event_sequence"::int AS "lastEventSequence",
           "attempt_count" AS "attemptCount",
           "available_at" AS "availableAt",
           "terminal_at" AS "terminalAt",
           "failure_category" AS "failureCategory",
           "failure_code" AS "failureCode",
           "safe_error_message" AS "safeErrorMessage",
           "lease_owner" AS "leaseOwner",
           "root_run_id" AS "rootRunId",
           "retry_of_run_id" AS "retryOfRunId",
           "policy_snapshot_id" AS "policySnapshotId"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return {
    id: row.id as string,
    status: row.status as string,
    stateVersion: row.stateVersion as number,
    lastEventSequence: row.lastEventSequence as number,
    attemptCount: row.attemptCount as number,
    availableAt: toDate(row.availableAt),
    terminalAt: toDate(row.terminalAt),
    failureCategory: (row.failureCategory as string | null) ?? null,
    failureCode: (row.failureCode as string | null) ?? null,
    safeErrorMessage: (row.safeErrorMessage as string | null) ?? null,
    leaseOwner: (row.leaseOwner as string | null) ?? null,
    rootRunId: row.rootRunId as string,
    retryOfRunId: (row.retryOfRunId as string | null) ?? null,
    policySnapshotId: (row.policySnapshotId as string | null) ?? null,
  };
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

const START_TIME = new Date('2026-08-20T12:00:00.000Z').getTime();

function clockAt(ms: number) {
  return () => new Date(START_TIME + ms);
}

// ---------------------------------------------------------------------------
// Unit: failure classification (VAL-RUN-108)
// ---------------------------------------------------------------------------

describe('classifyFailure', () => {
  it('classifies provider 429/408/5xx as transient and retryable', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const c = classifyFailure({
        kind: 'provider',
        httpStatus: status,
        code: 'PROVIDER_5XX',
        safeMessage: 'upstream error',
      });
      expect(c.category).toBe('provider_transient');
      expect(c.retryable).toBe(true);
    }
  });

  it('classifies provider 4xx (other) as permanent and non-retryable', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      const c = classifyFailure({
        kind: 'provider',
        httpStatus: status,
        code: 'PROVIDER_4XX',
        safeMessage: 'bad request',
      });
      expect(c.category).toBe('provider_permanent');
      expect(c.retryable).toBe(false);
    }
  });

  it('classifies provider with no status as transient (network-level)', () => {
    const c = classifyFailure({
      kind: 'provider',
      code: 'PROVIDER_UNKNOWN',
      safeMessage: 'no response',
    });
    expect(c.category).toBe('provider_transient');
    expect(c.retryable).toBe(true);
  });

  it('classifies network, database, and projection failures as retryable', () => {
    const net = classifyFailure({ kind: 'network', code: 'ECONNRESET', safeMessage: 'reset' });
    expect(net.category).toBe('provider_transient');
    expect(net.retryable).toBe(true);
    const db = classifyFailure({ kind: 'database', code: '40P01', safeMessage: 'deadlock' });
    expect(db.category).toBe('internal');
    expect(db.retryable).toBe(true);
    const proj = classifyFailure({
      kind: 'projection',
      code: 'PROJ_RETRY',
      safeMessage: 'projection failed',
    });
    expect(proj.category).toBe('projection');
    expect(proj.retryable).toBe(true);
  });

  it('classifies all permanent categories as non-retryable', () => {
    const permanent: ExecutionFailureInput[] = [
      { kind: 'authorization', code: 'AUTH', safeMessage: 'denied' },
      { kind: 'policy', code: 'POLICY', safeMessage: 'denied' },
      { kind: 'budget', code: 'BUDGET', safeMessage: 'exhausted' },
      { kind: 'limit', code: 'LIMIT', safeMessage: 'exceeded' },
      { kind: 'validation', code: 'VALIDATION', safeMessage: 'invalid' },
      { kind: 'unknown_effect', code: 'UNKNOWN', safeMessage: 'uncertain' },
      { kind: 'tool', code: 'TOOL_FAILED', safeMessage: 'tool error' },
    ];
    for (const input of permanent) {
      const c = classifyFailure(input);
      expect(c.retryable).toBe(false);
    }
  });

  it('maps tool denial to tool_denied and tool error to tool_failed', () => {
    const denied = classifyFailure({
      kind: 'tool',
      code: 'TOOL_DENIED',
      safeMessage: 'not allowed',
      denied: true,
    });
    expect(denied.category).toBe('tool_denied');
    expect(denied.retryable).toBe(false);
    const failed = classifyFailure({
      kind: 'tool',
      code: 'TOOL_FAILED',
      safeMessage: 'tool error',
    });
    expect(failed.category).toBe('tool_failed');
    expect(failed.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: bounded full-jitter backoff
// ---------------------------------------------------------------------------

describe('computeBackoff', () => {
  it('uses full jitter between 0 and the exponential base (1s, 2s, 4s)', () => {
    expect(computeBackoff({ attemptsCompleted: 1, remainingMs: 60_000, random: () => 0 })).toBe(0);
    expect(computeBackoff({ attemptsCompleted: 1, remainingMs: 60_000, random: () => 1 })).toBe(
      1000,
    );
    expect(computeBackoff({ attemptsCompleted: 2, remainingMs: 60_000, random: () => 1 })).toBe(
      2000,
    );
    expect(computeBackoff({ attemptsCompleted: 3, remainingMs: 60_000, random: () => 1 })).toBe(
      4000,
    );
  });

  it('caps the backoff at the configured maximum', () => {
    expect(
      computeBackoff({
        attemptsCompleted: 3,
        remainingMs: 60_000,
        maxBackoffMs: 3000,
        random: () => 1,
      }),
    ).toBe(3000);
  });

  it('bounds the backoff by remaining duration', () => {
    expect(computeBackoff({ attemptsCompleted: 3, remainingMs: 1500, random: () => 1 })).toBe(1500);
  });

  it('returns 0 when no remaining duration is left', () => {
    expect(computeBackoff({ attemptsCompleted: 1, remainingMs: 0, random: () => 1 })).toBe(0);
    expect(computeBackoff({ attemptsCompleted: 1, remainingMs: -5, random: () => 1 })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Unit: retry decision (VAL-RUN-106, VAL-RUN-107, VAL-RUN-108)
// ---------------------------------------------------------------------------

describe('decideRetry', () => {
  const retryable = {
    category: 'provider_transient' as const,
    code: 'PROVIDER_5XX',
    safeMessage: 'upstream',
    retryable: true,
  };
  const permanent = {
    category: 'provider_permanent' as const,
    code: 'PROVIDER_4XX',
    safeMessage: 'bad',
    retryable: false,
  };

  it('fails immediately for a permanent classification (no requeue)', () => {
    const d = decideRetry({
      classification: permanent,
      attemptsCompleted: 1,
      maxAttempts: 3,
      nowMs: START_TIME,
    });
    expect(d.kind).toBe('fail');
    if (d.kind === 'fail') {
      expect(d.reason).toBe('permanent');
    }
  });

  it('requeues a retryable failure within the attempt bound', () => {
    const d = decideRetry({
      classification: retryable,
      attemptsCompleted: 1,
      maxAttempts: 3,
      nowMs: START_TIME,
      random: () => 1,
    });
    expect(d.kind).toBe('requeue');
  });

  it('fails with attempts_exhausted when the attempt bound is reached', () => {
    const d = decideRetry({
      classification: retryable,
      attemptsCompleted: 3,
      maxAttempts: 3,
      nowMs: START_TIME,
      random: () => 1,
    });
    expect(d.kind).toBe('fail');
    if (d.kind === 'fail') {
      expect(d.reason).toBe('attempts_exhausted');
    }
  });

  it('fails with time_exhausted when the deadline has passed', () => {
    const d = decideRetry({
      classification: retryable,
      attemptsCompleted: 1,
      maxAttempts: 3,
      nowMs: START_TIME + 10_000,
      deadlineMs: START_TIME + 5_000,
      random: () => 1,
    });
    expect(d.kind).toBe('fail');
    if (d.kind === 'fail') {
      expect(d.reason).toBe('time_exhausted');
    }
  });

  it('fails with time_exhausted when remaining duration cannot fit a backoff', () => {
    const d = decideRetry({
      classification: retryable,
      attemptsCompleted: 1,
      maxAttempts: 3,
      nowMs: START_TIME,
      deadlineMs: START_TIME + 100,
      random: () => 1,
    });
    expect(d.kind).toBe('fail');
    if (d.kind === 'fail') {
      expect(d.reason).toBe('time_exhausted');
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: transactional retry against real Postgres
// ---------------------------------------------------------------------------

describe('MissionRetryService.handleExecutionFailure', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('requeues the same run on a transient provider throttle (VAL-RUN-047, VAL-RUN-106, VAL-CROSS-072)', async () => {
    const ctx = await freshRun('__mtest__ retry-transient');
    await setRunning(ctx.db, ctx.runId);
    const runsBefore = await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId);
    const runBefore = await getRun(ctx.db, ctx.runId);

    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });
    const outcome = await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: {
        kind: 'provider',
        httpStatus: 429,
        code: 'PROVIDER_THROTTLED',
        safeMessage: 'Rate limited',
      },
      maxAttempts: 3,
      logicalCallId: 'call-A',
    });

    expect(outcome.kind).toBe('requeue');
    const run = await getRun(ctx.db, ctx.runId);
    // Stable run identity: same id, no successor run created.
    expect(run.id).toBe(ctx.runId);
    expect(run.rootRunId).toBe(runBefore.rootRunId);
    expect(await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId)).toBe(runsBefore);
    // Requeued to queued, attempt counted, lease released, not terminal.
    expect(run.status).toBe('queued');
    expect(run.attemptCount).toBe(1);
    expect(run.terminalAt).toBeNull();
    expect(run.leaseOwner).toBeNull();
    expect(run.availableAt).not.toBeNull();
    // availableAt is now + bounded backoff (1s at attempt 1, full jitter=1).
    expect(run.availableAt!.getTime()).toBe(START_TIME + 1000);
    // State version and sequence advanced monotonically.
    expect(run.stateVersion).toBe(runBefore.stateVersion + 1);
    expect(run.lastEventSequence).toBe(runBefore.lastEventSequence + 1);

    // Throttle is run state, not a retroactive API 429: an execution.progress
    // retry event was appended carrying the bounded backoff and stable
    // logical call id (effect-dedup identity).
    const events = await getEvents(ctx.db, ctx.runId);
    const progress = events[events.length - 1];
    expect(progress.type).toBe('execution.progress');
    expect(progress.payload).toMatchObject({
      retry: true,
      attempt: 1,
      backoffMs: 1000,
      category: 'provider_transient',
      logicalCallId: 'call-A',
    });
  });

  it('applies increasing bounded backoff across successive transient retries (VAL-RUN-106)', async () => {
    const ctx = await freshRun('__mtest__ retry-backoff');
    await setRunning(ctx.db, ctx.runId);
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    // Attempt 1 fails -> requeue, 1s backoff.
    let outcome = await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: {
        kind: 'provider',
        httpStatus: 503,
        code: 'PROVIDER_503',
        safeMessage: 'unavailable',
      },
      maxAttempts: 3,
      logicalCallId: 'call-B',
    });
    expect(outcome.kind).toBe('requeue');
    let run = await getRun(ctx.db, ctx.runId);
    expect(run.attemptCount).toBe(1);
    expect(run.availableAt!.getTime()).toBe(START_TIME + 1000);

    // Simulate the worker re-claiming and failing again (attempt 2).
    await setRunning(ctx.db, ctx.runId, { attemptCount: 1 });
    outcome = await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: {
        kind: 'provider',
        httpStatus: 503,
        code: 'PROVIDER_503',
        safeMessage: 'unavailable',
      },
      maxAttempts: 3,
      logicalCallId: 'call-B',
    });
    expect(outcome.kind).toBe('requeue');
    run = await getRun(ctx.db, ctx.runId);
    expect(run.attemptCount).toBe(2);
    expect(run.availableAt!.getTime()).toBe(START_TIME + 2000);
  });

  it('fails the run after the attempt bound is exhausted (VAL-RUN-107)', async () => {
    const ctx = await freshRun('__mtest__ retry-exhaust');
    await setRunning(ctx.db, ctx.runId, { attemptCount: 2 });
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    const outcome = await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: {
        kind: 'provider',
        httpStatus: 503,
        code: 'PROVIDER_503',
        safeMessage: 'unavailable',
      },
      maxAttempts: 3,
      logicalCallId: 'call-C',
    });
    expect(outcome.kind).toBe('fail');

    const run = await getRun(ctx.db, ctx.runId);
    expect(run.status).toBe('failed');
    expect(run.terminalAt).not.toBeNull();
    expect(run.failureCategory).toBe('provider_transient');
    expect(run.failureCode).toBe('PROVIDER_503');
    expect(run.attemptCount).toBe(3);
    expect(run.leaseOwner).toBeNull();
    expect(run.availableAt).toBeNull();

    // A run.failed event was appended; no further requeue/progress event.
    const events = await getEvents(ctx.db, ctx.runId);
    const last = events[events.length - 1];
    expect(last.type).toBe('run.failed');
    expect(last.payload).toMatchObject({
      category: 'provider_transient',
      code: 'PROVIDER_503',
      attempts: 3,
      logicalCallId: 'call-C',
    });
    // No retry progress event was emitted on exhaustion.
    expect(events.filter((e) => e.type === 'execution.progress' && e.payload.retry).length).toBe(0);
  });

  it('fails the run when the remaining duration cannot fit a backoff (VAL-RUN-107)', async () => {
    const ctx = await freshRun('__mtest__ retry-time');
    await setRunning(ctx.db, ctx.runId);
    const deadline = START_TIME + 100;
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    const outcome = await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: { kind: 'network', code: 'ECONNRESET', safeMessage: 'reset' },
      maxAttempts: 3,
      deadlineMs: deadline,
      logicalCallId: 'call-D',
    });
    expect(outcome.kind).toBe('fail');
    const run = await getRun(ctx.db, ctx.runId);
    expect(run.status).toBe('failed');
    expect(run.failureCategory).toBe('provider_transient');
    expect(run.attemptCount).toBe(1);
  });

  it('does not auto-retry permanent failure categories (VAL-RUN-108)', async () => {
    const permanentFailures: { failure: ExecutionFailureInput; expectedCategory: string }[] = [
      {
        failure: { kind: 'authorization', code: 'AUTH_DENIED', safeMessage: 'denied' },
        expectedCategory: 'authorization',
      },
      {
        failure: { kind: 'policy', code: 'POLICY_DENIED', safeMessage: 'denied' },
        expectedCategory: 'policy',
      },
      {
        failure: { kind: 'budget', code: 'BUDGET_EXHAUSTED', safeMessage: 'exhausted' },
        expectedCategory: 'budget',
      },
      {
        failure: { kind: 'limit', code: 'LIMIT_EXCEEDED', safeMessage: 'exceeded' },
        expectedCategory: 'limit',
      },
      {
        failure: { kind: 'validation', code: 'INVALID_INPUT', safeMessage: 'invalid' },
        expectedCategory: 'validation',
      },
      {
        failure: { kind: 'unknown_effect', code: 'UNCERTAIN', safeMessage: 'uncertain' },
        expectedCategory: 'unknown_effect',
      },
      {
        failure: { kind: 'tool', code: 'TOOL_DENIED', safeMessage: 'not allowed', denied: true },
        expectedCategory: 'tool_denied',
      },
      {
        failure: {
          kind: 'provider',
          httpStatus: 404,
          code: 'PROVIDER_404',
          safeMessage: 'not found',
        },
        expectedCategory: 'provider_permanent',
      },
    ];

    for (const { failure, expectedCategory } of permanentFailures) {
      // Fresh isolated run per category.
      const c = await freshRun(`__mtest__ perm-${expectedCategory}`);
      await setRunning(c.db, c.runId);
      const seqBefore = (await getRun(c.db, c.runId)).lastEventSequence;
      const service = new MissionRetryService(c.db, { clock: clockAt(0), random: () => 1 });
      const outcome = await service.handleExecutionFailure({
        companyId: c.companyId,
        projectId: c.projectId,
        runId: c.runId,
        failure,
        maxAttempts: 3,
        logicalCallId: `call-${expectedCategory}`,
      });
      expect(outcome.kind).toBe('fail');
      const run = await getRun(c.db, c.runId);
      expect(run.status).toBe('failed');
      expect(run.failureCategory).toBe(expectedCategory);
      expect(run.attemptCount).toBe(1);
      // Exactly one new event (run.failed); no execution.progress retry event.
      const events = await getEvents(c.db, c.runId);
      expect(events.length).toBe(seqBefore + 1);
      expect(events[events.length - 1].type).toBe('run.failed');
      // Close the extra server from this isolated run.
      c.app.close();
    }
  });

  it('preserves stable run identity and does not create a successor run (VAL-CROSS-072)', async () => {
    const ctx = await freshRun('__mtest__ retry-identity');
    await setRunning(ctx.db, ctx.runId);
    const policyBefore = (await getRun(ctx.db, ctx.runId)).policySnapshotId;
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: {
        kind: 'provider',
        httpStatus: 502,
        code: 'PROVIDER_502',
        safeMessage: 'bad gateway',
      },
      maxAttempts: 3,
      logicalCallId: 'call-ID',
    });
    const run = await getRun(ctx.db, ctx.runId);
    expect(run.id).toBe(ctx.runId);
    expect(run.retryOfRunId ?? null).toBeNull();
    expect(run.policySnapshotId).toBe(policyBefore);
    // No new run rows appeared.
    expect(await countRunsInScope(ctx.db, ctx.companyId, ctx.projectId)).toBe(1);
  });

  it('is a no-op on an already-terminal run (terminal immutability)', async () => {
    const ctx = await freshRun('__mtest__ retry-terminal');
    // Force the run to a terminal completed state.
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'completed', "terminal_at" = ${new Date(START_TIME)},
        "lease_owner" = NULL, "lease_token" = NULL, "lease_expires_at" = NULL, "heartbeat_at" = NULL,
        "updated_at" = ${new Date(START_TIME)} WHERE "id" = ${ctx.runId}
    `);
    const before = await getRun(ctx.db, ctx.runId);
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    const outcome = await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: { kind: 'provider', httpStatus: 500, code: 'PROVIDER_500', safeMessage: 'err' },
      maxAttempts: 3,
      logicalCallId: 'call-T',
    });
    expect(outcome.kind).toBe('terminal_noop');
    const after = await getRun(ctx.db, ctx.runId);
    expect(after.status).toBe('completed');
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(after.lastEventSequence).toBe(before.lastEventSequence);
  });

  it('yields to a pending cancellation instead of retrying (cancellation wins)', async () => {
    const ctx = await freshRun('__mtest__ retry-cancel-pending');
    await setRunning(ctx.db, ctx.runId, { cancelRequested: true });
    const before = await getRun(ctx.db, ctx.runId);
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    const outcome = await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: { kind: 'provider', httpStatus: 500, code: 'PROVIDER_500', safeMessage: 'err' },
      maxAttempts: 3,
      logicalCallId: 'call-X',
    });
    expect(outcome.kind).toBe('superseded');
    const after = await getRun(ctx.db, ctx.runId);
    // No state transition: cancellation owns terminalization.
    expect(after.status).toBe('running');
    expect(after.stateVersion).toBe(before.stateVersion);
    expect(after.lastEventSequence).toBe(before.lastEventSequence);
  });

  it('does not requeue a run that is not in an active execution state', async () => {
    const ctx = await freshRun('__mtest__ retry-queued-state');
    // Leave the run in its initial draft state (not yet claimed/running).
    const before = await getRun(ctx.db, ctx.runId);
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    const outcome = await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: { kind: 'provider', httpStatus: 500, code: 'PROVIDER_500', safeMessage: 'err' },
      maxAttempts: 3,
      logicalCallId: 'call-Q',
    });
    expect(outcome.kind).toBe('superseded');
    const after = await getRun(ctx.db, ctx.runId);
    expect(after.status).toBe(before.status);
    expect(after.stateVersion).toBe(before.stateVersion);
  });

  it('honors a 404 for a cross-scope run without revealing existence', async () => {
    const ctx = await freshRun('__mtest__ retry-scope');
    await setRunning(ctx.db, ctx.runId);
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    await expect(
      service.handleExecutionFailure({
        companyId: ctx.companyId,
        projectId: randomUUID(),
        runId: ctx.runId,
        failure: { kind: 'provider', httpStatus: 500, code: 'PROVIDER_500', safeMessage: 'err' },
        maxAttempts: 3,
        logicalCallId: 'call-S',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'RUN_NOT_FOUND' });
  });

  it('emits a sanitized run.failed event with no provider secrets/content', async () => {
    const ctx = await freshRun('__mtest__ retry-sanitized');
    await setRunning(ctx.db, ctx.runId, { attemptCount: 2 });
    const service = new MissionRetryService(ctx.db, { clock: clockAt(0), random: () => 1 });

    await service.handleExecutionFailure({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      failure: {
        kind: 'provider',
        httpStatus: 500,
        code: 'PROVIDER_500',
        safeMessage: 'upstream error',
      },
      maxAttempts: 3,
      logicalCallId: 'call-SAN',
    });
    const events = await getEvents(ctx.db, ctx.runId);
    const payload = JSON.stringify(events[events.length - 1].payload);
    // No raw secrets, prompts, or provider bodies leak into the journal.
    expect(payload).not.toContain('sk-');
    expect(payload).not.toContain('authorization');
    expect(payload).not.toContain('Bearer');
    expect(payload).toContain('provider_transient');
  });
});
