import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { OrchestrationWorker } from '../services/mission/worker.js';
import { MissionCompletionService } from '../services/mission/completion.js';
import { MissionCancellationService } from '../services/mission/cancellation.js';

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

/**
 * Start a Mission run via the API and return the run context.
 * The run starts in `draft` status; use `setRunStatus` to move it.
 */
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

/**
 * Move a run to a specific status with optional lease fields.
 * Sets `available_at` to now for claimable states.
 */
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

/** Read a run row's raw columns via SQL. */
async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/** Read all events for a run ordered by sequence. */
async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_events"
    WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

afterEach(async () => {
  await closeTestServers();
});

// ---------------------------------------------------------------------------
// VAL-RUN-119: Concurrent workers execute one fenced claim
// ---------------------------------------------------------------------------

describe('VAL-RUN-119: Concurrent workers execute one fenced claim', () => {
  it('exactly one of two concurrent workers claims a queued run', async () => {
    const ctx = await freshRun('claim-race');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    // First worker claims the run.
    const claim1 = await coordinator.claimNext('worker-A');

    // Second worker should find no eligible runs (the run is now running with A's lease).
    const claim2 = await coordinator.claimNext('worker-B');

    // Exactly one claim wins.
    expect(claim1).not.toBeNull();
    expect(claim2).toBeNull();

    // The winning claim has the correct run and a non-empty lease token.
    expect(claim1!.runId).toBe(ctx.runId);
    expect(claim1!.leaseToken).toBeTruthy();
    expect(claim1!.leaseToken).toHaveLength(36); // UUID format
    expect(claim1!.leaseOwner).toMatch(/^worker-/);

    // The run is now `running` with the winner's lease.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('running');
    expect(row.lease_owner).toBe(claim1!.leaseOwner);
    expect(row.lease_token).toBe(claim1!.leaseToken);
    expect(row.lease_expires_at).not.toBeNull();

    // A run.claimed event was appended.
    const events = await getEvents(ctx.db, ctx.runId);
    const claimedEvent = events.find((e) => e.type === 'run.claimed');
    expect(claimedEvent).toBeDefined();
    // The event must NOT contain the lease token.
    const payload = claimedEvent!.payload as Record<string, unknown>;
    expect(payload.leaseToken).toBeUndefined();
    expect(payload.lease_owner).toBeUndefined();
    expect(payload.leaseOwner).toBeUndefined();

    await closeTestDb();
  });

  it('stale worker cannot commit after another claim (fenced completion)', async () => {
    const ctx = await freshRun('stale-commit');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    // Worker A claims the run.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Simulate lease expiry: set lease_expires_at to the past.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "lease_expires_at" = ${past}
      WHERE "id" = ${ctx.runId}
    `);

    // Worker B claims the same run (recovery).
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();
    expect(claimB!.leaseToken).not.toBe(claimA!.leaseToken);

    // A run.recovered event was appended for worker B's claim.
    const events = await getEvents(ctx.db, ctx.runId);
    const recoveredEvent = events.find((e) => e.type === 'run.recovered');
    expect(recoveredEvent).toBeDefined();
    // Token must NOT appear in the event payload.
    const recoveredPayload = recoveredEvent!.payload as Record<string, unknown>;
    expect(recoveredPayload.leaseToken).toBeUndefined();

    // Worker A tries to complete the run with its stale lease token.
    // The fenced mutation must reject it.
    const completionService = new MissionCompletionService(ctx.db);
    await expect(
      ctx.db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          leaseToken: claimA!.leaseToken,
        });
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
    expect(row.lease_token).toBeNull();

    // Only one run.completed event.
    const eventsAfter = await getEvents(ctx.db, ctx.runId);
    const completedEvents = eventsAfter.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);

    await closeTestDb();
  });

  it('claim does not increment attempt_count for first claim', async () => {
    const ctx = await freshRun('attempt-count');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-A');
    expect(claim).not.toBeNull();
    expect(claim!.attemptCount).toBe(0);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.attempt_count).toBe(0);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-120: Healthy lease renewal prevents false recovery
// ---------------------------------------------------------------------------

describe('VAL-RUN-120: Healthy lease renewal prevents false recovery', () => {
  it('successful renewal extends the lease and prevents recovery', async () => {
    const ctx = await freshRun('renewal-ok');
    // Set available_at before the injected clock's start time.
    await setRunStatus(ctx.db, ctx.runId, 'queued', {
      availableAt: new Date('2025-12-31T00:00:00.000Z'),
    });

    let now = new Date('2026-01-01T00:00:00.000Z');
    const coordinator = new RunCoordinator(ctx.db, { clock: () => now });

    // Worker A claims the run.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();
    expect(claimA!.leaseExpiresAt.toISOString()).toBe(
      new Date('2026-01-01T00:00:30.000Z').toISOString(),
    );

    // Advance time 10 seconds — renewal should extend the lease.
    now = new Date('2026-01-01T00:00:10.000Z');
    const renewed = await coordinator.renew(claimA!);
    expect(renewed.leaseExpiresAt.toISOString()).toBe(
      new Date('2026-01-01T00:00:40.000Z').toISOString(),
    );

    // Another worker cannot claim because the lease is still valid.
    now = new Date('2026-01-01T00:00:15.000Z');
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).toBeNull();

    // A run.lease_renewed event was appended.
    const events = await getEvents(ctx.db, ctx.runId);
    const renewEvent = events.find((e) => e.type === 'run.lease_renewed');
    expect(renewEvent).toBeDefined();
    const renewPayload = renewEvent!.payload as Record<string, unknown>;
    expect(renewPayload.leaseToken).toBeUndefined();

    await closeTestDb();
  });

  it('forced renewal failure prevents the old worker from committing', async () => {
    const ctx = await freshRun('renewal-fail');
    await setRunStatus(ctx.db, ctx.runId, 'queued', {
      availableAt: new Date('2025-12-31T00:00:00.000Z'),
    });

    let now = new Date('2026-01-01T00:00:00.000Z');
    const coordinator = new RunCoordinator(ctx.db, { clock: () => now });

    // Worker A claims the run.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Advance time past the lease expiry (40 seconds — past the 30s lease).
    now = new Date('2026-01-01T00:00:40.000Z');

    // Worker A tries to renew — should fail (lease expired, another worker may have claimed).
    await expect(coordinator.renew(claimA!)).rejects.toThrow();

    // Worker B claims the run (recovery).
    const claimB = await coordinator.claimNext('worker-B');
    expect(claimB).not.toBeNull();
    expect(claimB!.leaseToken).not.toBe(claimA!.leaseToken);

    // Worker A tries to complete — fenced, must reject.
    const completionService = new MissionCompletionService(ctx.db);
    await expect(
      ctx.db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          leaseToken: claimA!.leaseToken,
        });
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

    await closeTestDb();
  });

  it('heartbeat updates heartbeat_at without extending lease', async () => {
    const ctx = await freshRun('heartbeat');
    await setRunStatus(ctx.db, ctx.runId, 'queued', {
      availableAt: new Date('2025-12-31T00:00:00.000Z'),
    });

    let now = new Date('2026-01-01T00:00:00.000Z');
    const coordinator = new RunCoordinator(ctx.db, { clock: () => now });

    const claim = await coordinator.claimNext('worker-A');
    expect(claim).not.toBeNull();

    // Advance 5 seconds, heartbeat.
    now = new Date('2026-01-01T00:00:05.000Z');
    await coordinator.heartbeat(claim!);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(new Date(row.heartbeat_at as string).toISOString()).toBe(
      new Date('2026-01-01T00:00:05.000Z').toISOString(),
    );
    // Lease should NOT have been extended by heartbeat alone.
    expect(new Date(row.lease_expires_at as string).toISOString()).toBe(
      new Date('2026-01-01T00:00:30.000Z').toISOString(),
    );

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-121: Missed wake hints cannot strand queued runs
// ---------------------------------------------------------------------------

describe('VAL-RUN-121: Missed wake hints cannot strand queued runs', () => {
  it('periodic polling claims a queued run without any notification', async () => {
    const ctx = await freshRun('poll-no-notify');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Use the worker with a short poll interval and NO notification mechanism.
    // The polling loop must still find and claim the run.
    let claimed = false;
    const coordinator = new RunCoordinator(ctx.db);
    const worker = new OrchestrationWorker({
      coordinator,
      workerId: 'poll-worker',
      pollIntervalMs: 50,
      advance: async (claim) => {
        claimed = true;
        // Immediately complete the run.
        const completionService = new MissionCompletionService(ctx.db);
        await ctx.db.drizzle.transaction(async (tx) => {
          await completionService.completeRun(tx, claim.companyId, claim.projectId, claim.runId, {
            leaseToken: claim.leaseToken,
          });
        });
      },
    });

    await worker.start();

    // Wait for the polling loop to claim and process the run.
    await vi.waitFor(
      async () => {
        expect(claimed).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    await worker.stop();

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('completed');
    expect(row.lease_token).toBeNull();

    await closeTestDb();
  });

  it('polling claims a run with a future available_at only when it becomes eligible', async () => {
    const ctx = await freshRun('poll-future');
    const future = new Date(Date.now() + 300);
    await setRunStatus(ctx.db, ctx.runId, 'queued', { availableAt: future });

    let claimed = false;
    const coordinator = new RunCoordinator(ctx.db);
    const worker = new OrchestrationWorker({
      coordinator,
      workerId: 'future-worker',
      pollIntervalMs: 50,
      advance: async (claim) => {
        claimed = true;
        const completionService = new MissionCompletionService(ctx.db);
        await ctx.db.drizzle.transaction(async (tx) => {
          await completionService.completeRun(tx, claim.companyId, claim.projectId, claim.runId, {
            leaseToken: claim.leaseToken,
          });
        });
      },
    });

    await worker.start();

    // Wait for the polling loop to claim and process the run after available_at passes.
    await vi.waitFor(
      async () => {
        expect(claimed).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );

    await worker.stop();

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('completed');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-127: Graceful worker shutdown is lease safe
// ---------------------------------------------------------------------------

describe('VAL-RUN-127: Graceful worker shutdown is lease safe', () => {
  it('shutdown stops new claims and aborts active calls', async () => {
    const ctx = await freshRun('shutdown');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    let wasAborted = false;
    let startedProcessing = false;

    const worker = new OrchestrationWorker({
      coordinator,
      workerId: 'shutdown-worker',
      pollIntervalMs: 50,
      shutdownCommitWindowMs: 200,
      advance: async (_claim, signal) => {
        startedProcessing = true;
        // Simulate a long cancellable call that waits for abort.
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            wasAborted = true;
            resolve();
            return;
          }
          signal.addEventListener('abort', () => {
            wasAborted = true;
            resolve();
          });
        });
      },
    });

    await worker.start();

    // Wait for processing to start.
    await vi.waitFor(
      async () => {
        expect(startedProcessing).toBe(true);
      },
      { timeout: 3000, interval: 50 },
    );

    // Trigger graceful shutdown.
    await worker.stop();

    // The active call was aborted.
    expect(wasAborted).toBe(true);

    // The lease was released by the worker — the run is back to queued
    // (or completed if the advance function committed before release).
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.lease_token).toBeNull();

    await closeTestDb();
  });

  it('replacement worker recovers the same run after lease expiry', async () => {
    const ctx = await freshRun('replacement');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);

    // Worker A claims the run.
    const claimA = await coordinator.claimNext('worker-A');
    expect(claimA).not.toBeNull();

    // Simulate worker A crashing without releasing the lease.
    // The lease is still held but will expire.
    // Set the lease to expire in the past.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "lease_expires_at" = ${past}
      WHERE "id" = ${ctx.runId}
    `);

    // Worker B claims the run via polling (recovery).
    let recovered = false;
    const workerB = new OrchestrationWorker({
      coordinator,
      workerId: 'worker-B',
      pollIntervalMs: 50,
      advance: async (claim) => {
        recovered = true;
        // Complete the run.
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

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row.status).toBe('completed');
    expect(row.lease_token).toBeNull();

    // Only one run.completed event.
    const events = await getEvents(ctx.db, ctx.runId);
    const completedEvents = events.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);

    // A run.recovered event was appended.
    const recoveredEvents = events.filter((e) => e.type === 'run.recovered');
    expect(recoveredEvents).toHaveLength(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-128: Lease and fencing capabilities are never exposed
// ---------------------------------------------------------------------------

describe('VAL-RUN-128: Lease and fencing capabilities are never exposed', () => {
  it('snapshot does not expose lease token, lease owner, or heartbeat', async () => {
    const ctx = await freshRun('secret-snapshot');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-A');
    expect(claim).not.toBeNull();

    // Seed a canary token to verify negative searches.
    const canaryToken = `canary-lease-${randomUUID()}`;
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "lease_token" = ${canaryToken}
      WHERE "id" = ${ctx.runId}
    `);

    // Fetch the snapshot via the API.
    const res = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);
    const snapshot = JSON.stringify(res.body);

    // The raw canary token must NOT appear in the snapshot.
    expect(snapshot).not.toContain(canaryToken);
    expect(snapshot).not.toContain('leaseToken');
    expect(snapshot).not.toContain('lease_token');
    expect(snapshot).not.toContain('leaseOwner');
    expect(snapshot).not.toContain('lease_owner');
    expect(snapshot).not.toContain('heartbeatAt');
    expect(snapshot).not.toContain('heartbeat_at');

    await closeTestDb();
  });

  it('run events do not expose lease tokens', async () => {
    const ctx = await freshRun('secret-events');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-A');
    expect(claim).not.toBeNull();

    // Fetch events via the API.
    const res = await request(ctx.app).get(`${ctx.base}/${ctx.runId}/events?after=0`).expect(200);
    const eventsStr = JSON.stringify(res.body);

    // The lease token must NOT appear in any event.
    expect(eventsStr).not.toContain(claim!.leaseToken);

    // Also verify via raw DB that no event payload contains the token.
    const events = await getEvents(ctx.db, ctx.runId);
    for (const e of events) {
      const payloadStr = JSON.stringify(e.payload);
      expect(payloadStr).not.toContain(claim!.leaseToken);
    }

    await closeTestDb();
  });

  it('SSE stream does not expose lease tokens', async () => {
    const ctx = await freshRun('secret-sse');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-A');
    expect(claim).not.toBeNull();

    // Fetch SSE stream. Use a short buffer and parse the text.
    const res = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/stream?after=0`)
      .expect(200)
      .buffer(true);
    const sseText = typeof res.text === 'string' ? res.text : res.body.toString('utf8');

    // The lease token must NOT appear in the SSE stream.
    expect(sseText).not.toContain(claim!.leaseToken);

    await closeTestDb();
  });

  it('command history does not expose lease tokens', async () => {
    const ctx = await freshRun('secret-commands');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-A');
    expect(claim).not.toBeNull();

    // Cancel the run to create a command.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', `cancel-${randomUUID()}`)
      .set('If-Match', `"${claim!.stateVersion}"`)
      .send({ type: 'run.cancel', reason: 'done' })
      .expect(202);

    // Fetch command history.
    const res = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/commands?limit=100`)
      .expect(200);
    const commandsStr = JSON.stringify(res.body);

    // The lease token must NOT appear in command history.
    expect(commandsStr).not.toContain(claim!.leaseToken);

    await closeTestDb();
  });

  it('sanitization redacts leaseToken field name', async () => {
    // The sanitize module must have 'leasetoken' in its sensitive field names
    // to prevent accidental leakage through event payloads.
    const { SENSITIVE_FIELD_NAMES } = await import('../services/mission/sanitize.js');
    expect(SENSITIVE_FIELD_NAMES.has('leasetoken')).toBe(true);
    expect(SENSITIVE_FIELD_NAMES.has('leasekey')).toBe(true);
  });
});
