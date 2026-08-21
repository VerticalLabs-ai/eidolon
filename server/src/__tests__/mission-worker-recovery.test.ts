import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { OrchestrationWorker } from '../services/mission/worker.js';
import { MissionCompletionService } from '../services/mission/completion.js';
import { MissionRecoveryService } from '../services/mission/recovery.js';
import { MissionRetryService } from '../services/mission/retry.js';

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

async function freshRun(
  label: string,
  text = 'Do work',
): Promise<{
  db: AnyDb;
  app: Awaited<ReturnType<typeof createTestServer>>;
  companyId: string;
  projectId: string;
  threadId: string;
  runId: string;
  base: string;
}> {
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
  opts: {
    leaseOwner?: string | null;
    leaseToken?: string | null;
    leaseExpiresAt?: Date | null;
    heartbeatAt?: Date | null;
    availableAt?: Date | null;
    attemptCount?: number;
  } = {},
) {
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const availableAt = opts.availableAt !== undefined ? opts.availableAt : now;

  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status},
        "terminal_at" = ${isTerminal ? now : null},
        "updated_at" = ${now},
        "available_at" = ${availableAt},
        "lease_owner" = ${opts.leaseOwner ?? null},
        "lease_token" = ${opts.leaseToken ?? null},
        "lease_expires_at" = ${opts.leaseExpiresAt ?? null},
        "heartbeat_at" = ${opts.heartbeatAt ?? null},
        "started_at" = ${['running', 'synthesizing'].includes(status) ? now : null},
        "attempt_count" = ${opts.attemptCount ?? 0}
    WHERE "id" = ${runId}
  `);
}

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_events"
    WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function getInvocations(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_tool_invocations"
    WHERE "run_id" = ${runId}
    ORDER BY "created_at" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function insertInvocation(
  db: AnyDb,
  runId: string,
  companyId: string,
  projectId: string,
  opts: {
    stepKey?: string;
    attempt?: number;
    toolId?: string;
    ordinal?: number;
    replayClass: string;
    state: string;
    logicalCallId?: string;
  },
) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_tool_invocations" (
      "id", "company_id", "project_id", "run_id",
      "step_key", "attempt", "tool_id", "ordinal",
      "replay_class", "state", "logical_call_id",
      "created_at", "updated_at"
    ) VALUES (
      ${id}, ${companyId}, ${projectId}, ${runId},
      ${opts.stepKey ?? 'root'}, ${opts.attempt ?? 0}, ${opts.toolId ?? 'test.tool'}, ${opts.ordinal ?? 0},
      ${opts.replayClass}, ${opts.state}, ${opts.logicalCallId ?? null},
      ${now}, ${now}
    )
  `);
  return id;
}

afterEach(async () => {
  await closeTestServers();
});

// ---------------------------------------------------------------------------
// VAL-RUN-079: API restart preserves run state
// ---------------------------------------------------------------------------

describe('VAL-RUN-079: API restart preserves run state', () => {
  it('queued run remains retrievable with same identity, version, and history after API restart', async () => {
    const ctx = await freshRun('api-restart-queued');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Capture pre-restart state.
    const preSnapshot = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);
    const preVersion = preSnapshot.headers.etag;
    const preEvents = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/events?after=0&limit=100`)
      .expect(200);
    const preEventCount = preEvents.body.data.events.length;
    const preLatestSeq = preEvents.body.data.latestSequence;

    // Simulate API restart: close the server and create a new one against
    // the same database (Postgres is the system of record).
    await closeTestServers();
    const app2 = await createTestServer(ctx.db);

    // Post-restart: the run is retrievable at the same Location.
    const postSnapshot = await request(app2).get(`${ctx.base}/${ctx.runId}`).expect(200);

    // Same identity, no regressed state version.
    expect(postSnapshot.body.data.run.id).toBe(ctx.runId);
    expect(postSnapshot.body.data.run.status).toBe('queued');
    expect(postSnapshot.headers.etag).toBe(preVersion);

    // Complete event history preserved.
    const postEvents = await request(app2)
      .get(`${ctx.base}/${ctx.runId}/events?after=0&limit=100`)
      .expect(200);
    expect(postEvents.body.data.events.length).toBe(preEventCount);
    expect(postEvents.body.data.latestSequence).toBe(preLatestSeq);

    // Events are identical (same types, sequences, payloads).
    for (let i = 0; i < preEventCount; i++) {
      expect(postEvents.body.data.events[i].sequence).toBe(preEvents.body.data.events[i].sequence);
      expect(postEvents.body.data.events[i].type).toBe(preEvents.body.data.events[i].type);
    }

    await closeTestDb();
  });

  it('terminal run remains retrievable and immutable after API restart', async () => {
    const ctx = await freshRun('api-restart-terminal');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Complete the run.
    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-A');
    expect(claim).not.toBeNull();
    const completionService = new MissionCompletionService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        leaseToken: claim!.leaseToken,
      });
    });

    const preSnapshot = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);
    expect(preSnapshot.body.data.run.status).toBe('completed');

    // Simulate API restart.
    await closeTestServers();
    const app2 = await createTestServer(ctx.db);

    const postSnapshot = await request(app2).get(`${ctx.base}/${ctx.runId}`).expect(200);
    expect(postSnapshot.body.data.run.id).toBe(ctx.runId);
    expect(postSnapshot.body.data.run.status).toBe('completed');
    expect(postSnapshot.headers.etag).toBe(preSnapshot.headers.etag);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-081: Worker restart recovers queued work
// ---------------------------------------------------------------------------

describe('VAL-RUN-081: Worker restart recovers queued work', () => {
  it('queued run progresses under a restarted worker without new start or run ID', async () => {
    const ctx = await freshRun('worker-restart-queued');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Capture the run ID before worker restart.
    const runId = ctx.runId;

    // Start worker A, let it claim the run, then stop it (simulating crash).
    const coordinator = new RunCoordinator(ctx.db);
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Simulate worker A crashing: expire its lease.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "lease_expires_at" = ${past}
      WHERE "id" = ${runId}
    `);

    // Start worker B (replacement). It should recover and complete the run.
    let recovered = false;
    const workerB = new OrchestrationWorker({
      coordinator,
      workerId: 'worker-B',
      pollIntervalMs: 50,
      advance: async (claim) => {
        recovered = true;
        const completionService = new MissionCompletionService(ctx.db);
        await ctx.db.drizzle.transaction(async (tx) => {
          await completionService.completeRun(tx, claim.companyId, claim.projectId, claim.runId, {
            leaseToken: claim.leaseToken,
          });
        });
      },
    });

    await workerB.start();

    await vi.waitFor(
      async () => {
        expect(recovered).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    await workerB.stop();

    // Same run ID, now completed.
    const row = await getRunRow(ctx.db, runId);
    expect(row.status).toBe('completed');
    expect(row.id).toBe(runId);

    // A run.recovered event was appended (distinguishes recovery from fresh).
    const events = await getEvents(ctx.db, runId);
    const recoveredEvents = events.filter((e) => e.type === 'run.recovered');
    expect(recoveredEvents.length).toBeGreaterThanOrEqual(1);

    // Only one run.completed event.
    const completedEvents = events.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-083: Recovery preserves monotonic history
// ---------------------------------------------------------------------------

describe('VAL-RUN-083: Recovery preserves monotonic history', () => {
  it('state version and event sequence only increase after recovery', async () => {
    const ctx = await freshRun('monotonic-history');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    // Worker A claims the run.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Capture pre-recovery state.
    const preRow = await getRunRow(ctx.db, ctx.runId);
    const preVersion = preRow.state_version as number;
    const preSeq = Number(preRow.last_event_sequence as string | number);
    const preEvents = await getEvents(ctx.db, ctx.runId);
    const preEventTypes = preEvents.map((e) => ({
      sequence: Number(e.sequence),
      type: e.type as string,
      payload: e.payload,
    }));

    // Expire worker A's lease.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);

    // Worker B recovers.
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();
    expect(claimB!.isRecovery).toBe(true);

    // Post-recovery: version and sequence only increased.
    const postRow = await getRunRow(ctx.db, ctx.runId);
    expect(postRow.state_version as number).toBeGreaterThan(preVersion);
    expect(Number(postRow.last_event_sequence)).toBeGreaterThan(preSeq);

    // Prior events remain unchanged.
    const postEvents = await getEvents(ctx.db, ctx.runId);
    for (let i = 0; i < preEventTypes.length; i++) {
      expect(Number(postEvents[i].sequence)).toBe(preEventTypes[i].sequence);
      expect(postEvents[i].type).toBe(preEventTypes[i].type);
      expect(postEvents[i].payload).toEqual(preEventTypes[i].payload);
    }

    // A run.recovered event was appended (distinguishes recovery from fresh).
    const recoveredEvent = postEvents.find((e) => e.type === 'run.recovered');
    expect(recoveredEvent).toBeDefined();
    const recoveredPayload = recoveredEvent!.payload as Record<string, unknown>;
    expect(recoveredPayload.isRecovery).toBe(true);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-084: Recovery does not duplicate terminal output
// ---------------------------------------------------------------------------

describe('VAL-RUN-084: Recovery does not duplicate terminal output', () => {
  it('restarting after completion does not create a second completion or duplicate events', async () => {
    const ctx = await freshRun('no-dup-output');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const completionService = new MissionCompletionService(ctx.db);

    // Worker A claims and completes the run.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        leaseToken: claimA!.leaseToken,
      });
    });

    // Capture post-completion state.
    const preRow = await getRunRow(ctx.db, ctx.runId);
    expect(preRow.status).toBe('completed');
    const preEvents = await getEvents(ctx.db, ctx.runId);
    const preCompletedCount = preEvents.filter((e) => e.type === 'run.completed').length;
    expect(preCompletedCount).toBe(1);
    const preVersion = preRow.state_version as number;
    const preSeq = Number(preRow.last_event_sequence as string | number);

    // Simulate worker restart: try to claim the completed run.
    // The coordinator should NOT claim a terminal run.
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).toBeNull();

    // State is unchanged.
    const postRow = await getRunRow(ctx.db, ctx.runId);
    expect(postRow.status).toBe('completed');
    expect(postRow.state_version).toBe(preVersion);
    expect(Number(postRow.last_event_sequence)).toBe(preSeq);

    // No new events.
    const postEvents = await getEvents(ctx.db, ctx.runId);
    expect(postEvents.length).toBe(preEvents.length);
    const postCompletedCount = postEvents.filter((e) => e.type === 'run.completed').length;
    expect(postCompletedCount).toBe(1);

    await closeTestDb();
  });

  it('recovery after completion does not duplicate budget release', async () => {
    const ctx = await freshRun('no-dup-budget');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const completionService = new MissionCompletionService(ctx.db);

    // Complete the run.
    const claimA = await coordinator.claimNext('worker-A');
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        leaseToken: claimA!.leaseToken,
      });
    });

    const preEvents = await getEvents(ctx.db, ctx.runId);
    const preBudgetReleasedCount = preEvents.filter((e) => e.type === 'budget.released').length;
    expect(preBudgetReleasedCount).toBe(1);

    // Try to claim again — should not claim a terminal run.
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).toBeNull();

    // No new budget.released events.
    const postEvents = await getEvents(ctx.db, ctx.runId);
    const postBudgetReleasedCount = postEvents.filter((e) => e.type === 'budget.released').length;
    expect(postBudgetReleasedCount).toBe(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-085: Stale worker cannot overwrite recovery
// ---------------------------------------------------------------------------

describe('VAL-RUN-085: Stale worker cannot overwrite recovery', () => {
  it('late completion from stale worker is rejected after recovery', async () => {
    const ctx = await freshRun('stale-overwrite');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const completionService = new MissionCompletionService(ctx.db);
    const retryService = new MissionRetryService(ctx.db);

    // Worker A claims the run.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Expire worker A's lease.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);

    // Worker B recovers.
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();
    expect(claimB!.leaseToken).not.toBe(claimA!.leaseToken);

    // Worker A tries to complete — fenced, must reject.
    await expect(
      ctx.db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          leaseToken: claimA!.leaseToken,
        });
      }),
    ).rejects.toThrow();

    // Worker A tries to report failure and requeue — fenced, must reject.
    await expect(
      retryService.handleExecutionFailure({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        failure: {
          kind: 'provider',
          httpStatus: 500,
          code: 'STALE_FAILURE',
          safeMessage: 'Stale worker failure',
        },
        leaseToken: claimA!.leaseToken,
      }),
    ).rejects.toThrow();

    // Worker B completes successfully.
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        leaseToken: claimB!.leaseToken,
      });
    });

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('completed');

    // Only one run.completed event.
    const events = await getEvents(ctx.db, ctx.runId);
    const completedEvents = events.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);

    await closeTestDb();
  });

  it('stale worker cannot produce another transition after recovery completes', async () => {
    const ctx = await freshRun('stale-transition');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const completionService = new MissionCompletionService(ctx.db);

    // Worker A claims.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Expire A's lease, B recovers.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();

    // B completes.
    await ctx.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
        leaseToken: claimB!.leaseToken,
      });
    });

    const preRow = await getRunRow(ctx.db, ctx.runId);
    const preVersion = preRow.state_version as number;
    const preSeq = Number(preRow.last_event_sequence as string | number);

    // A tries to complete after B already completed — fenced rejection.
    await expect(
      ctx.db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          leaseToken: claimA!.leaseToken,
        });
      }),
    ).rejects.toThrow();

    // State unchanged.
    const postRow = await getRunRow(ctx.db, ctx.runId);
    expect(postRow.state_version).toBe(preVersion);
    expect(Number(postRow.last_event_sequence)).toBe(preSeq);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-086: Unknown nonreplayable work fails safely
// ---------------------------------------------------------------------------

describe('VAL-RUN-086: Unknown nonreplayable work fails safely', () => {
  it('non-replayable invocation in started state causes terminal unknown_effect failure', async () => {
    const ctx = await freshRun('unknown-effect');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    // Worker A claims the run.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Insert a non-replayable tool invocation in 'started' state.
    await insertInvocation(ctx.db, ctx.runId, ctx.companyId, ctx.projectId, {
      replayClass: 'non_replayable',
      state: 'started',
      toolId: 'irreversible.send_email',
      logicalCallId: 'call-1',
    });

    // Expire worker A's lease (simulating crash during the non-replayable call).
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);

    // Worker B recovers the run.
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();
    expect(claimB!.isRecovery).toBe(true);

    // Recovery service checks for non-replayable effects.
    const recoveryService = new MissionRecoveryService(ctx.db);
    const result = await recoveryService.checkNonReplayableEffects({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claimB!.leaseToken,
    });

    // The run was terminalized with unknown_effect.
    expect(result.terminalized).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.failureCategory).toBe('unknown_effect');
    expect(result.failureCode).toBe('NON_REPLAYABLE_UNRESOLVED');
    expect(result.effects.found).toBe(true);
    expect(result.effects.toolIds).toContain('irreversible.send_email');

    // The run is terminal.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('failed');
    expect(row.failure_category).toBe('unknown_effect');
    expect(row.terminal_at).not.toBeNull();

    // The invocation was marked as 'unknown' (not repeated).
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].state).toBe('unknown');

    // A run.failed event was appended with retry guidance.
    const events = await getEvents(ctx.db, ctx.runId);
    const failedEvent = events.find((e) => e.type === 'run.failed');
    expect(failedEvent).toBeDefined();
    const payload = failedEvent!.payload as Record<string, unknown>;
    expect(payload.category).toBe('unknown_effect');
    expect(payload.retryGuidance).toBeDefined();

    await closeTestDb();
  });

  it('read-only invocation in started state does NOT cause failure', async () => {
    const ctx = await freshRun('readonly-ok');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    // Worker A claims.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Insert a read-only tool invocation in 'started' state.
    await insertInvocation(ctx.db, ctx.runId, ctx.companyId, ctx.projectId, {
      replayClass: 'read_only',
      state: 'started',
      toolId: 'research.search',
    });

    // Expire A's lease.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);

    // Worker B recovers.
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();

    const recoveryService = new MissionRecoveryService(ctx.db);
    const result = await recoveryService.checkNonReplayableEffects({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claimB!.leaseToken,
    });

    // No non-replayable effects found — run is NOT terminalized.
    expect(result.terminalized).toBe(false);
    expect(result.effects.found).toBe(false);

    // The run is still nonterminal.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('running');

    await closeTestDb();
  });

  it('completed non-replayable invocation does NOT cause failure on recovery', async () => {
    const ctx = await freshRun('completed-nr-ok');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Insert a non-replayable invocation that already succeeded.
    await insertInvocation(ctx.db, ctx.runId, ctx.companyId, ctx.projectId, {
      replayClass: 'non_replayable',
      state: 'succeeded',
      toolId: 'irreversible.send_email',
    });

    // Expire A's lease, B recovers.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();

    const recoveryService = new MissionRecoveryService(ctx.db);
    const result = await recoveryService.checkNonReplayableEffects({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claimB!.leaseToken,
    });

    // Succeeded invocations are not unresolved — no failure.
    expect(result.terminalized).toBe(false);
    expect(result.effects.found).toBe(false);

    await closeTestDb();
  });

  it('recovery never repeats the non-replayable invocation (invocation count stays 1)', async () => {
    const ctx = await freshRun('no-repeat');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Insert a non-replayable invocation in 'started' state.
    const invocationId = await insertInvocation(ctx.db, ctx.runId, ctx.companyId, ctx.projectId, {
      replayClass: 'non_replayable',
      state: 'started',
      toolId: 'irreversible.charge_card',
    });

    // Expire A's lease, B recovers.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();

    const recoveryService = new MissionRecoveryService(ctx.db);
    await recoveryService.checkNonReplayableEffects({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claimB!.leaseToken,
    });

    // Only ONE invocation exists — it was not repeated.
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].id).toBe(invocationId);
    expect(invocations[0].state).toBe('unknown');

    await closeTestDb();
  });

  it('stale worker cannot call recovery check with old lease token', async () => {
    const ctx = await freshRun('stale-recovery');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    await insertInvocation(ctx.db, ctx.runId, ctx.companyId, ctx.projectId, {
      replayClass: 'non_replayable',
      state: 'started',
      toolId: 'irreversible.send_email',
    });

    // Expire A's lease, B recovers.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();

    // Worker A tries to call recovery check with its stale token — must reject.
    const recoveryService = new MissionRecoveryService(ctx.db);
    await expect(
      recoveryService.checkNonReplayableEffects({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        leaseToken: claimA!.leaseToken,
      }),
    ).rejects.toThrow();

    // Worker B can call it successfully.
    const result = await recoveryService.checkNonReplayableEffects({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      leaseToken: claimB!.leaseToken,
    });
    expect(result.terminalized).toBe(true);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-050: API restart preserves commands
// ---------------------------------------------------------------------------

describe('VAL-CROSS-050: API restart preserves commands', () => {
  it('run and command state survive API restart; post-restart command resumes the same run', async () => {
    const ctx = await freshRun('api-restart-commands');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Capture pre-restart state.
    const preSnapshot = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);
    const preVersion = preSnapshot.headers.etag;
    const preEvents = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/events?after=0&limit=100`)
      .expect(200);
    const preEventCount = preEvents.body.data.events.length;

    // Simulate API restart.
    await closeTestServers();
    const app2 = await createTestServer(ctx.db);

    // Post-restart: run is retrievable with same identity and version.
    const postSnapshot = await request(app2).get(`${ctx.base}/${ctx.runId}`).expect(200);
    expect(postSnapshot.body.data.run.id).toBe(ctx.runId);
    expect(postSnapshot.body.data.run.status).toBe('queued');
    expect(postSnapshot.headers.etag).toBe(preVersion);

    // Event sequence is complete and unchanged.
    const postEvents = await request(app2)
      .get(`${ctx.base}/${ctx.runId}/events?after=0&limit=100`)
      .expect(200);
    expect(postEvents.body.data.events.length).toBe(preEventCount);

    // A legal command submitted after restart resumes the same run exactly once.
    const cancelKey = `cancel-${randomUUID()}`;
    const cancelRes = await request(app2)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', cancelKey)
      .set('If-Match', preVersion!)
      .send({ type: 'run.cancel', reason: 'testing restart' })
      .expect(202);

    // The cancel command was applied to the same run.
    const postCancelSnapshot = await request(app2).get(`${ctx.base}/${ctx.runId}`).expect(200);
    expect(postCancelSnapshot.body.data.run.id).toBe(ctx.runId);
    expect(postCancelSnapshot.body.data.run.cancelRequestedAt).not.toBeNull();

    // Replay the same cancel command — idempotent, no duplicate.
    const replayRes = await request(app2)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', cancelKey)
      .set('If-Match', preVersion!)
      .send({ type: 'run.cancel', reason: 'testing restart' });

    // Same result, no new event.
    expect(replayRes.status).toBe(cancelRes.status);

    const finalEvents = await request(app2)
      .get(`${ctx.base}/${ctx.runId}/events?after=0&limit=100`)
      .expect(200);
    const cancelRequestedEvents = finalEvents.body.data.events.filter(
      (e: { type: string }) => e.type === 'run.cancel_requested',
    );
    expect(cancelRequestedEvents).toHaveLength(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-051: Worker restart recovers execution
// ---------------------------------------------------------------------------

describe('VAL-CROSS-051: Worker restart recovers execution', () => {
  it('worker restart during running state recovers without duplicate run or effect', async () => {
    const ctx = await freshRun('worker-restart-exec');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const completionService = new MissionCompletionService(ctx.db);

    // Worker A claims and is "running" the work.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Insert a read-only invocation (safe to replay).
    await insertInvocation(ctx.db, ctx.runId, ctx.companyId, ctx.projectId, {
      replayClass: 'read_only',
      state: 'started',
      toolId: 'research.search',
      logicalCallId: 'logical-1',
    });

    // Worker A crashes (lease expires).
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);

    // Worker B starts and recovers the run.
    let recovered = false;
    const workerB = new OrchestrationWorker({
      coordinator,
      workerId: 'worker-B',
      pollIntervalMs: 50,
      advance: async (claim) => {
        recovered = true;

        // Check for non-replayable effects first (recovery safety).
        const recoveryService = new MissionRecoveryService(ctx.db);
        const recoveryResult = await recoveryService.checkNonReplayableEffects({
          companyId: claim.companyId,
          projectId: claim.projectId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
        });

        // No non-replayable effects — safe to proceed.
        expect(recoveryResult.terminalized).toBe(false);

        // Complete the run.
        await ctx.db.drizzle.transaction(async (tx) => {
          await completionService.completeRun(tx, claim.companyId, claim.projectId, claim.runId, {
            leaseToken: claim.leaseToken,
          });
        });
      },
    });

    await workerB.start();

    await vi.waitFor(
      async () => {
        expect(recovered).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    await workerB.stop();

    // Same run ID, completed.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('completed');
    expect(row.id).toBe(ctx.runId);

    // One run.recovered event, one run.completed event.
    const events = await getEvents(ctx.db, ctx.runId);
    const recoveredEvents = events.filter((e) => e.type === 'run.recovered');
    expect(recoveredEvents).toHaveLength(1);
    const completedEvents = events.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);

    // No duplicate external effect (only one invocation row).
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);

    await closeTestDb();
  });

  it('worker restart with non-replayable effect fails safely without duplicate', async () => {
    const ctx = await freshRun('worker-restart-nr');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    // Worker A claims.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Insert a non-replayable invocation in 'started' state.
    await insertInvocation(ctx.db, ctx.runId, ctx.companyId, ctx.projectId, {
      replayClass: 'non_replayable',
      state: 'started',
      toolId: 'irreversible.payment',
      logicalCallId: 'pay-1',
    });

    // Worker A crashes.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "lease_expires_at" = ${past} WHERE "id" = ${ctx.runId}
    `);

    // Worker B recovers.
    let recovered = false;
    let failed = false;
    const workerB = new OrchestrationWorker({
      coordinator,
      workerId: 'worker-B',
      pollIntervalMs: 50,
      advance: async (claim) => {
        recovered = true;

        // Recovery check finds the non-replayable effect.
        const recoveryService = new MissionRecoveryService(ctx.db);
        const result = await recoveryService.checkNonReplayableEffects({
          companyId: claim.companyId,
          projectId: claim.projectId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
        });

        if (result.terminalized) {
          failed = true;
          return; // Do not proceed with execution.
        }
      },
    });

    await workerB.start();

    await vi.waitFor(
      async () => {
        expect(recovered).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    await vi.waitFor(
      async () => {
        expect(failed).toBe(true);
      },
      { timeout: 1000, interval: 50 },
    );

    await workerB.stop();

    // The run failed with unknown_effect.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('failed');
    expect(row.failure_category).toBe('unknown_effect');

    // Only ONE invocation (not repeated).
    const invocations = await getInvocations(ctx.db, ctx.runId);
    expect(invocations).toHaveLength(1);
    expect(invocations[0].state).toBe('unknown');

    await closeTestDb();
  });
});
