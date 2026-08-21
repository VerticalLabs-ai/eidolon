import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionCancellationService } from '../services/mission/cancellation.js';
import { MissionCompletionService } from '../services/mission/completion.js';
import {
  normalizeReason,
  validateReason,
  redactCanaries,
  encryptReason,
  decryptReason,
} from '../services/mission/reason-security.js';

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

async function setRunStatus(
  db: AnyDb,
  runId: string,
  status: string,
  opts: { leaseOwner?: string; waitingFromStatus?: string } = {},
) {
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const leaseToken = opts.leaseOwner ? randomUUID() : null;
  const leaseExpires = opts.leaseOwner ? new Date(now.getTime() + 30000) : null;

  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status},
        "terminal_at" = ${isTerminal ? now : null},
        "updated_at" = ${now},
        "lease_owner" = ${opts.leaseOwner ?? null},
        "lease_token" = ${leaseToken},
        "lease_expires_at" = ${leaseExpires},
        "heartbeat_at" = ${opts.leaseOwner ? now : null},
        "started_at" = ${opts.leaseOwner ? now : null},
        "waiting_from_status" = ${opts.waitingFromStatus ?? null}
    WHERE "id" = ${runId}
  `);
}

async function getRunRow(
  db: AnyDb,
  runId: string,
): Promise<
  | (Record<string, unknown> & {
      state_version: number;
      last_event_sequence: number;
    })
  | null
> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "terminal_at",
           "cancel_requested_at", "cancel_requested_by",
           "cancellation_deadline_at", "lease_owner", "created_at"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    ...row,
    state_version: Number(row.state_version),
    last_event_sequence: Number(row.last_event_sequence),
  } as Record<string, unknown> & { state_version: number; last_event_sequence: number };
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{
    sequence: string | number;
    type: string;
    payload: Record<string, unknown>;
  }>;
  return rows.map((r) => ({ ...r, sequence: Number(r.sequence) }));
}

async function getReservation(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "reserved_cents" AS "reserved", "settled_cents" AS "settled",
           "released_cents" AS "released", "status", "terminal_at"
    FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function getCommandPayload(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "type", "payload", "request_hash"
    FROM "run_commands" WHERE "run_id" = ${runId} AND "type" = 'run.cancel'
    ORDER BY "created_at" ASC
  `)) as unknown as Array<{
    type: string;
    payload: Record<string, unknown>;
    request_hash: string;
  }>;
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// VAL-CROSS-059: Cancellation-completion race is singular
// VAL-RUN-041: Cancellation wins without late output
// VAL-RUN-042: Completion wins without contradictory cancellation
// ---------------------------------------------------------------------------

describe('Terminal race resolution — VAL-CROSS-059, VAL-RUN-041, VAL-RUN-042', () => {
  let ctx: RunContext;

  afterEach(async () => {
    if (ctx?.db) {
      const { closeTestDb } = await import('../test-utils.js');
      await closeTestDb();
    }
    vi.unstubAllEnvs();
  });

  it('cancellation wins the lock — no late completion (VAL-RUN-041)', async () => {
    ctx = await freshRun('race-cancel-wins');
    // Move to running with a lease so cancel records the request but does
    // not immediately terminalize (lease state).
    await setRunStatus(ctx.db, ctx.runId, 'running', { leaseOwner: `worker-${randomUUID()}` });
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    // Step 1: Cancel the run (acquires the lock, sets cancelRequestedAt).
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `race-cancel-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'User cancelled before completion' });
    expect(cancelRes.status).toBe(202);

    // Step 2: Worker tries to complete AFTER cancellation won the lock.
    // The completion service should see cancelRequestedAt and refuse.
    const completionService = new MissionCompletionService(ctx.db);
    await expect(
      ctx.db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          actorType: 'system',
          actorId: null,
        });
      }),
    ).rejects.toThrow();

    // Step 3: Terminalize the cancellation (worker observes cancel and stops).
    const cancelService = new MissionCancellationService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      await cancelService.terminalize(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        actorType: 'system',
        actorId: null,
      });
    });

    // Verify: run is cancelled, NOT completed.
    const afterRow = await getRunRow(ctx.db, ctx.runId);
    expect(afterRow!.status).toBe('cancelled');
    expect(afterRow!.terminal_at).not.toBeNull();

    // Verify: no completion event was appended.
    const events = await getEvents(ctx.db, ctx.runId);
    expect(events.find((e) => e.type === 'run.completed')).toBeUndefined();

    // Verify: exactly one terminal lifecycle event (cancelled).
    const lifecycleEvents = events.filter((e) =>
      ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type),
    );
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0].type).toBe('run.cancelled');

    // Verify: budget released, no settlements.
    const reservation = await getReservation(ctx.db, ctx.runId);
    expect(reservation!.status).toBe('released');
  });

  it('completion wins the lock — no contradictory cancellation (VAL-RUN-042)', async () => {
    ctx = await freshRun('race-complete-wins');
    // Move to running with a lease.
    await setRunStatus(ctx.db, ctx.runId, 'running', { leaseOwner: `worker-${randomUUID()}` });

    // Step 1: Worker completes the run (acquires the lock, transitions to
    // completed).
    const completionService = new MissionCompletionService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        actorType: 'system',
        actorId: null,
        traceId: null,
      });
    });

    // Verify: run is completed.
    const completedRow = await getRunRow(ctx.db, ctx.runId);
    expect(completedRow!.status).toBe('completed');
    expect(completedRow!.terminal_at).not.toBeNull();
    const completedVersion = completedRow!.state_version as number;

    // Step 2: User tries to cancel AFTER completion won the lock.
    // Cancel should return 200 with the completed snapshot (already terminal).
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `race-complete-${randomUUID()}`)
      .send({ reason: 'Too late, already done' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.run.status).toBe('completed');

    // Verify: no cancelled event was appended after completion.
    const events = await getEvents(ctx.db, ctx.runId);
    expect(events.find((e) => e.type === 'run.cancelled')).toBeUndefined();
    expect(events.find((e) => e.type === 'run.cancel_requested')).toBeUndefined();

    // Verify: exactly one terminal lifecycle event (completed).
    const lifecycleEvents = events.filter((e) =>
      ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type),
    );
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0].type).toBe('run.completed');

    // Verify: state version did not change from the cancel attempt.
    const finalRow = await getRunRow(ctx.db, ctx.runId);
    expect(finalRow!.state_version).toBe(completedVersion);
  });

  it('concurrent completion and cancellation produce one terminal outcome (VAL-CROSS-059)', async () => {
    ctx = await freshRun('race-concurrent');
    // Move to running with a lease.
    await setRunStatus(ctx.db, ctx.runId, 'running', { leaseOwner: `worker-${randomUUID()}` });

    // Start both operations concurrently. The run lock (FOR UPDATE) ensures
    // only one can proceed at a time. The first to acquire the lock wins.
    const completionService = new MissionCompletionService(ctx.db);
    const cancelService = new MissionCancellationService(ctx.db);

    // Use a barrier to start both at the same time.
    const startBarrier = { resolve: () => {} };
    const startPromise = new Promise<void>((resolve) => {
      startBarrier.resolve = resolve;
    });

    const completePromise = startPromise.then(() =>
      ctx.db.drizzle.transaction(async (tx) => {
        try {
          await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
            actorType: 'system',
            actorId: null,
            traceId: null,
          });
          return 'completed';
        } catch {
          return 'rejected';
        }
      }),
    );

    const cancelPromise = startPromise.then(() =>
      ctx.db.drizzle.transaction(async (tx) => {
        try {
          const run = await (async () => {
            const schema = ctx.db.schema;
            const [row] = await tx
              .select()
              .from(schema.missionRuns)
              .where(sql`"id" = ${ctx.runId}`)
              .for('update')
              .limit(1);
            return row;
          })();
          if (!run) {
            return 'rejected';
          }
          if (['completed', 'failed', 'cancelled'].includes(run.status)) {
            return 'terminal';
          }
          await cancelService.requestCancellation(tx, run, {
            companyId: ctx.companyId,
            projectId: ctx.projectId,
            runId: ctx.runId,
            actorType: 'user',
            actorId: 'test-user',
            traceId: null,
          });
          return 'cancelled';
        } catch {
          return 'rejected';
        }
      }),
    );

    // Release the barrier to start both concurrently.
    startBarrier.resolve();

    const [completeResult, cancelResult] = await Promise.all([completePromise, cancelPromise]);

    // Exactly one should have won; the other should have been rejected or
    // observed terminal state.
    const winners = [completeResult, cancelResult].filter(
      (r) => r === 'completed' || r === 'cancelled',
    );
    expect(winners).toHaveLength(1);

    // Verify: run has exactly one terminal status.
    const afterRow = await getRunRow(ctx.db, ctx.runId);
    expect(['completed', 'cancelled']).toContain(afterRow!.status);

    // Verify: exactly one terminal lifecycle event.
    const events = await getEvents(ctx.db, ctx.runId);
    const lifecycleEvents = events.filter((e) =>
      ['run.completed', 'run.cancelled', 'run.failed'].includes(e.type),
    );
    expect(lifecycleEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-043: Completed state is immutable
// ---------------------------------------------------------------------------

describe('Completed state immutability — VAL-RUN-043', () => {
  let ctx: RunContext;

  afterEach(async () => {
    if (ctx?.db) {
      const { closeTestDb } = await import('../test-utils.js');
      await closeTestDb();
    }
    vi.unstubAllEnvs();
  });

  it('duplicate cancel after completion returns 200 with unchanged state', async () => {
    ctx = await freshRun('immutable-completed');
    // Complete the run.
    const completionService = new MissionCompletionService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        actorType: 'system',
        actorId: null,
        traceId: null,
      });
    });

    const completedRow = await getRunRow(ctx.db, ctx.runId);
    expect(completedRow!.status).toBe('completed');
    const completedVersion = completedRow!.state_version as number;
    const completedSeq = completedRow!.last_event_sequence as number;

    // Send a cancel command (already terminal → 200, no change).
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `immutable-cancel-${randomUUID()}`)
      .send({ reason: 'Attempt to cancel completed' });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.run.status).toBe('completed');

    // State version and event sequence unchanged.
    const finalRow = await getRunRow(ctx.db, ctx.runId);
    expect(finalRow!.state_version).toBe(completedVersion);
    expect(finalRow!.last_event_sequence).toBe(completedSeq);

    // No new lifecycle events.
    const events = await getEvents(ctx.db, ctx.runId);
    const lifecycleEvents = events.filter((e) =>
      ['run.completed', 'run.cancelled', 'run.failed', 'run.cancel_requested'].includes(e.type),
    );
    expect(lifecycleEvents).toHaveLength(1);
    expect(lifecycleEvents[0].type).toBe('run.completed');
  });

  it('completion is idempotent — calling completeRun twice does not duplicate', async () => {
    ctx = await freshRun('immutable-complete-idempotent');
    const completionService = new MissionCompletionService(ctx.db);

    // First completion.
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        actorType: 'system',
        actorId: null,
        traceId: null,
      });
    });

    const firstRow = await getRunRow(ctx.db, ctx.runId);
    expect(firstRow!.status).toBe('completed');
    const firstVersion = firstRow!.state_version as number;
    const firstSeq = firstRow!.last_event_sequence as number;

    // Second completion — should be a no-op.
    await ctx.db.drizzle.transaction(async (tx) => {
      const result = await completionService.completeRun(
        tx,
        ctx.companyId,
        ctx.projectId,
        ctx.runId,
        { actorType: 'system', actorId: null, traceId: null },
      );
      expect(result.terminalized).toBe(false);
      expect(result.status).toBe('completed');
    });

    // State unchanged.
    const finalRow = await getRunRow(ctx.db, ctx.runId);
    expect(finalRow!.state_version).toBe(firstVersion);
    expect(finalRow!.last_event_sequence).toBe(firstSeq);

    // Only one completion event.
    const events = await getEvents(ctx.db, ctx.runId);
    const completedEvents = events.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);
  });

  it('retry after completion is rejected (VAL-RUN-118)', async () => {
    ctx = await freshRun('immutable-retry-completed');
    // Complete the run.
    const completionService = new MissionCompletionService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        actorType: 'system',
        actorId: null,
        traceId: null,
      });
    });

    const completedRow = await getRunRow(ctx.db, ctx.runId);
    const completedVersion = completedRow!.state_version as number;

    // Attempt retry — should be rejected with 409 INVALID_RUN_STATE.
    const retryRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `immutable-retry-${randomUUID()}`)
      .set('If-Match', `"${completedVersion}"`)
      .send({});

    expect(retryRes.status).toBe(409);
    expect(retryRes.body.code).toBe('INVALID_RUN_STATE');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-040: Cancellation after terminal state is harmless
// ---------------------------------------------------------------------------

describe('Cancellation after terminal state — VAL-RUN-040', () => {
  let ctx: RunContext;

  afterEach(async () => {
    if (ctx?.db) {
      const { closeTestDb } = await import('../test-utils.js');
      await closeTestDb();
    }
    vi.unstubAllEnvs();
  });

  for (const terminalStatus of ['completed', 'failed', 'cancelled'] as const) {
    it(`cancelling a ${terminalStatus} run returns 200 with no state change`, async () => {
      ctx = await freshRun(`terminal-cancel-${terminalStatus}`);
      await setRunStatus(ctx.db, ctx.runId, terminalStatus);

      const beforeRow = await getRunRow(ctx.db, ctx.runId);
      const beforeVersion = beforeRow!.state_version as number;
      const beforeSeq = beforeRow!.last_event_sequence as number;

      const cancelRes = await request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/cancel`)
        .set('Idempotency-Key', `terminal-${terminalStatus}-${randomUUID()}`)
        .send({ reason: `Cancel after ${terminalStatus}` });

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.run.status).toBe(terminalStatus);

      // No state change.
      const afterRow = await getRunRow(ctx.db, ctx.runId);
      expect(afterRow!.state_version).toBe(beforeVersion);
      expect(afterRow!.last_event_sequence).toBe(beforeSeq);

      // No new cancellation events.
      const events = await getEvents(ctx.db, ctx.runId);
      expect(events.find((e) => e.type === 'run.cancel_requested')).toBeUndefined();
      expect(events.find((e) => e.type === 'run.cancelled')).toBeUndefined();
    });
  }
});

// ---------------------------------------------------------------------------
// VAL-RUN-138: Cancellation reason is bounded and access controlled
// ---------------------------------------------------------------------------

describe('Cancellation reason security — VAL-RUN-138', () => {
  let ctx: RunContext;

  afterEach(async () => {
    if (ctx?.db) {
      const { closeTestDb } = await import('../test-utils.js');
      await closeTestDb();
    }
    vi.unstubAllEnvs();
  });

  // -- Reason validation ----------------------------------------------------

  it('reason is required for user-confirmed cancellation', async () => {
    ctx = await freshRun('reason-required');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    // Cancel without a reason → 400 VALIDATION_ERROR.
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `no-reason-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({});

    expect(cancelRes.status).toBe(400);
    expect(cancelRes.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects empty reason', async () => {
    ctx = await freshRun('reason-empty');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `empty-reason-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: '' });

    expect(cancelRes.status).toBe(400);
  });

  it('accepts 1 code point (minimum boundary)', async () => {
    ctx = await freshRun('reason-1cp');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `reason-1cp-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason: 'A' });

    expect(cancelRes.status).toBe(202);
  });

  it('accepts 2000 code points (maximum boundary)', async () => {
    ctx = await freshRun('reason-2000cp');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    const reason = 'x'.repeat(2000);
    expect([...reason].length).toBe(2000);

    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `reason-2000cp-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason });

    expect(cancelRes.status).toBe(202);
  });

  it('rejects 2001 code points (one over maximum)', async () => {
    ctx = await freshRun('reason-2001cp');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    const reason = 'x'.repeat(2001);
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `reason-2001cp-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason });

    expect(cancelRes.status).toBe(400);
  });

  it('counts Unicode code points, not UTF-16 code units', async () => {
    ctx = await freshRun('reason-emoji');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    // 2000 emoji code points = 4000 UTF-16 code units. Should be accepted.
    const emoji = '🎉';
    const reason = emoji.repeat(2000);
    expect(reason.length).toBe(4000); // UTF-16 code units
    expect([...reason].length).toBe(2000); // Unicode code points

    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `reason-emoji-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason });

    expect(cancelRes.status).toBe(202);
  });

  // -- NFC normalization ----------------------------------------------------

  it('normalizes reason to NFC without semantic trimming', async () => {
    // NFD form of é = e + combining acute (2 code points)
    // NFC form of é = é (1 code point)
    const nfdReason = 'e\u0301'; // NFD: e + combining accent
    const nfcReason = normalizeReason(nfdReason);
    expect(nfcReason).toBe('\u00E9'); // NFC: precomposed é
    expect([...nfcReason].length).toBe(1);
  });

  it('does not trim leading/trailing whitespace (no semantic trimming)', () => {
    const reason = '  hello world  ';
    const normalized = normalizeReason(reason);
    expect(normalized).toBe('  hello world  '); // whitespace preserved
  });

  // -- Canary redaction -----------------------------------------------------

  it('redacts credential-like patterns from reason', () => {
    const reason = 'Please cancel. API_KEY=sk-abc123secret';
    const { redacted, hadCanaries } = redactCanaries(reason);
    expect(hadCanaries).toBe(true);
    expect(redacted).not.toContain('sk-abc123secret');
    expect(redacted).toContain('[REDACTED]');
  });

  it('redacts bearer tokens', () => {
    const reason = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.token';
    const { redacted, hadCanaries } = redactCanaries(reason);
    expect(hadCanaries).toBe(true);
    expect(redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('redacts PEM key blocks', () => {
    const reason = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANB\n-----END PRIVATE KEY-----';
    const { redacted, hadCanaries } = redactCanaries(reason);
    expect(hadCanaries).toBe(true);
    expect(redacted).not.toContain('MIIEvQIBADANB');
  });

  it('passes through clean reasons without redaction', () => {
    const reason = 'I no longer need this analysis.';
    const { redacted, hadCanaries } = redactCanaries(reason);
    expect(hadCanaries).toBe(false);
    expect(redacted).toBe(reason);
  });

  // -- Encryption at rest ---------------------------------------------------

  it('reason is encrypted in command history payload', async () => {
    ctx = await freshRun('reason-encrypted');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    const reason = 'Sensitive cancellation reason with secrets';
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `encrypted-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason });
    expect(cancelRes.status).toBe(202);

    // Inspect the raw database row — the payload should NOT contain the
    // plaintext reason.
    const payload = await getCommandPayload(ctx.db, ctx.runId);
    expect(payload).not.toBeNull();
    const payloadStr = JSON.stringify(payload!.payload);
    expect(payloadStr).not.toContain(reason);

    // The payload should contain an encrypted reason field.
    const storedReason = (payload!.payload as Record<string, unknown>).reason;
    expect(typeof storedReason).toBe('string');
    expect(storedReason as string).not.toBe(reason);

    // Decrypting the stored reason should yield the original (after NFC).
    const decrypted = decryptReason(storedReason as string);
    expect(decrypted).toBe(reason.normalize('NFC'));
  });

  it('cancel event payload does not contain the reason text', async () => {
    ctx = await freshRun('reason-event-safe');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    const reason = 'Secret reason that should not appear in events';
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `event-safe-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason })
      .expect(202);

    // Check all events — none should contain the reason text.
    const events = await getEvents(ctx.db, ctx.runId);
    for (const event of events) {
      const eventStr = JSON.stringify(event.payload);
      expect(eventStr).not.toContain(reason);
    }
  });

  it('canary in reason is redacted before persistence', async () => {
    ctx = await freshRun('reason-canary-persist');
    const beforeRow = await getRunRow(ctx.db, ctx.runId);
    const beforeVersion = beforeRow!.state_version as number;

    const secretValue = 'sk-canary-secret-value-12345';
    const reason = `Please cancel. token=${secretValue}`;
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `canary-${randomUUID()}`)
      .set('If-Match', `"${beforeVersion}"`)
      .send({ reason });
    expect(cancelRes.status).toBe(202);

    // The raw database payload should NOT contain the secret value.
    const payload = await getCommandPayload(ctx.db, ctx.runId);
    expect(payload).not.toBeNull();
    const payloadStr = JSON.stringify(payload!.payload);
    expect(payloadStr).not.toContain(secretValue);

    // Events should not contain the secret value.
    const events = await getEvents(ctx.db, ctx.runId);
    for (const event of events) {
      const eventStr = JSON.stringify(event.payload);
      expect(eventStr).not.toContain(secretValue);
    }
  });

  // -- Unit tests for reason-security module -------------------------------

  it('validateReason accepts valid code point counts', () => {
    expect(() => validateReason('A')).not.toThrow();
    expect(() => validateReason('x'.repeat(2000))).not.toThrow();
  });

  it('validateReason rejects zero code points', () => {
    expect(() => validateReason('')).toThrow();
  });

  it('validateReason rejects over 2000 code points', () => {
    expect(() => validateReason('x'.repeat(2001))).toThrow();
  });

  it('encryptReason and decryptReason round-trip correctly', () => {
    const reason = 'Test cancellation reason';
    const encrypted = encryptReason(reason);
    expect(encrypted).not.toBe(reason);
    const decrypted = decryptReason(encrypted);
    expect(decrypted).toBe(reason);
  });
});
