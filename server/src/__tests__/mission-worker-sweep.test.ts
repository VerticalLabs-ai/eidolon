import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { OrchestrationWorker } from '../services/mission/worker.js';
import { MissionKillSwitchService } from '../services/mission/kill-switch.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

function disableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: false } }),
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

async function freshRun(label: string, text = 'Do work') {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `sweep-${randomUUID()}`)
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
  opts: { availableAt?: Date | null } = {},
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
        "started_at" = ${['running', 'synthesizing'].includes(status) ? now : null}
    WHERE "id" = ${runId}
  `);
}

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

afterEach(async () => {
  await closeTestServers();
});

// ---------------------------------------------------------------------------
// Worker sweep integration: kill-switch wired into the poll loop
// ---------------------------------------------------------------------------

describe('Worker sweep integration', () => {
  it('calls the sweep function on each poll cycle before claiming', async () => {
    const db = await createTestDb();
    const coordinator = new RunCoordinator(db);

    let sweepCallCount = 0;
    const sweep = vi.fn(async () => {
      sweepCallCount++;
    });

    const worker = new OrchestrationWorker({
      coordinator,
      workerId: 'sweep-test-worker',
      pollIntervalMs: 50,
      renewalIntervalMs: 100,
      advance: vi.fn(async () => {}),
      sweep,
    });

    await worker.start();

    // Wait for a few poll cycles.
    await new Promise((resolve) => setTimeout(resolve, 180));

    await worker.stop();

    // The sweep should have been called at least 2 times (3 poll cycles
    // in 180ms with 50ms interval).
    expect(sweepCallCount).toBeGreaterThanOrEqual(2);
    expect(sweep).toHaveBeenCalled();

    await closeTestDb();
  });

  it('continues polling after a sweep function throws', async () => {
    const db = await createTestDb();
    const coordinator = new RunCoordinator(db);

    let sweepCallCount = 0;
    const sweep = vi.fn(async () => {
      sweepCallCount++;
      if (sweepCallCount === 1) {
        throw new Error('sweep failure');
      }
    });

    const worker = new OrchestrationWorker({
      coordinator,
      workerId: 'sweep-error-worker',
      pollIntervalMs: 50,
      renewalIntervalMs: 100,
      advance: vi.fn(async () => {}),
      sweep,
    });

    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 180));
    await worker.stop();

    // The sweep should have been called more than once despite the first
    // call throwing — the worker must not crash on sweep errors.
    expect(sweepCallCount).toBeGreaterThan(1);

    await closeTestDb();
  });

  it('kill-switch sweep cancels nonterminal runs when the flag is disabled', async () => {
    const ctx = await freshRun('kill-sweep');
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Enable flag initially — run is queued and claimable.
    enableMissionFlag();

    const killSwitch = new MissionKillSwitchService(ctx.db);

    // Disable the flag and sweep.
    disableMissionFlag();
    const result = await killSwitch.sweepAllDisabled();

    // The company had a nonterminal run and the flag is now disabled.
    expect(result.sweptCompanies).toBeGreaterThanOrEqual(1);
    expect(result.cancelledRuns).toBeGreaterThanOrEqual(1);

    // `queued` with no active lease has no worker to observe a
    // cancellation request, so the sweep terminalizes it immediately
    // (VAL-SUB-046). The cancel request is recorded and the run is
    // cancelled in the same sweep; enforceDeadlines is a no-op on the
    // already-terminal run.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row?.cancel_requested_at).not.toBeNull();
    expect(row?.status).toBe('cancelled');
    expect(row?.terminal_at).not.toBeNull();

    // enforceDeadlines must not re-terminalize or alter an already
    // terminal run, even with a past cancellation deadline.
    const past = new Date(Date.now() - 120_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "cancellation_deadline_at" = ${past}
      WHERE "id" = ${ctx.runId}
    `);

    const deadlineResult = await killSwitch.enforceDeadlines();
    expect(deadlineResult.terminalized).toBe(0);

    const finalRow = await getRunRow(ctx.db, ctx.runId);
    expect(finalRow?.status).toBe('cancelled');
    expect(finalRow?.terminal_at).not.toBeNull();

    await closeTestDb();
  });

  it('enforceDeadlines terminalizes runs past their cancellation deadline', async () => {
    const ctx = await freshRun('deadline-sweep');
    // Put the run in running state with a lease (lease state).
    const now = new Date();
    const past = new Date(now.getTime() - 120_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "status" = 'running',
          "terminal_at" = NULL,
          "updated_at" = ${now},
          "available_at" = ${now},
          "started_at" = ${now},
          "cancel_requested_at" = ${past},
          "cancellation_deadline_at" = ${past},
          "lease_owner" = 'stale-worker',
          "lease_token" = 'stale-token',
          "lease_expires_at" = ${past}
      WHERE "id" = ${ctx.runId}
    `);

    const killSwitch = new MissionKillSwitchService(ctx.db);
    const result = await killSwitch.enforceDeadlines();

    expect(result.terminalized).toBeGreaterThanOrEqual(1);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row?.status).toBe('cancelled');
    expect(row?.terminal_at).not.toBeNull();

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// Bounded cancellation-deadline sweep wired into the worker tick
// (VAL-CROSS-058, VAL-RUN-109, VAL-SUB-096)
// ---------------------------------------------------------------------------

async function seedFixtureScope(db: AnyDb, label: string) {
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

async function insertPolicySnapshot(db: AnyDb, companyId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "provider", "model", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${id}, ${companyId}, 1, 'anthropic', 'claude-sonnet-4-6', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'require_all', '{"costCents": 5000, "durationSeconds": 3600, "providerCalls": 64, "totalTokens": 500000, "outputBytes": 10485760, "steps": 12, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
  `);
  return id;
}

async function insertBudget(db: AnyDb, companyId: string, runId: string, cents: number) {
  const reservationId = randomUUID();
  const allocationId = randomUUID();
  const now = new Date();
  const periodKey = now.toISOString().slice(0, 7);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${companyId}, ${runId}, null, ${cents}, ${cents}, 0, 0, ${periodKey}, 'held', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${allocationId}, ${companyId}, ${reservationId}, ${runId}, null, ${cents}, 0, 0, 'held', ${now}, ${now})
  `);
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{ sequence: string | number; type: string }>;
  return rows.map((r) => ({ sequence: Number(r.sequence), type: r.type }));
}

async function getBudgetStatus(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "released_cents" AS "released", "reserved_cents" AS "reserved"
    FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

describe('Worker bounded cancellation-deadline sweep', () => {
  it('throttles the deadline sweep to the configured interval', async () => {
    const db = await createTestDb();
    const coordinator = new RunCoordinator(db);

    let deadlineCallCount = 0;
    const deadlineSweep = vi.fn(async () => {
      deadlineCallCount++;
    });
    // Per-poll sweep should NOT call the deadline sweep — they are separate.
    const sweep = vi.fn(async () => {});

    const worker = new OrchestrationWorker({
      coordinator,
      workerId: 'throttle-test-worker',
      pollIntervalMs: 20,
      renewalIntervalMs: 1000,
      deadlineSweepIntervalMs: 100,
      advance: vi.fn(async () => {}),
      sweep,
      deadlineSweep,
    });

    await worker.start();
    // ~250ms = ~12 poll cycles, but at 100ms throttle the deadline sweep
    // should fire at most ~3 times (initial + ~2 intervals), far fewer
    // than the poll count.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await worker.stop();

    expect(deadlineCallCount).toBeGreaterThanOrEqual(2);
    expect(deadlineCallCount).toBeLessThanOrEqual(4);

    await closeTestDb();
  });

  it('converges a cancel-requested run with past-deadline queued children to terminal within the sweep interval', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedFixtureScope(
      db,
      '__mtest__ deadline-converge',
    );
    const policy = await insertPolicySnapshot(db, companyId);

    // Root run: running, cancel-requested, past cancellation deadline, with
    // a STALE (expired) lease — simulating a worker that became unavailable
    // after the cancel request so the cancellation cascade never observed
    // it. The root cannot terminalize until its queued child settles
    // (subtree-terminal barrier, VAL-SUB-048/110).
    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const now = new Date();
    const past = new Date(now.getTime() - 120_000);

    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "cancel_requested_at", "cancel_requested_by", "cancellation_deadline_at", "lease_owner", "lease_token", "lease_expires_at", "started_at", "available_at", "created_at", "updated_at")
      VALUES (${rootRunId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policy}, 'running', 1, 0, 'require_all', null, ${past}, null, ${past}, 'stale-worker', 'stale-token', ${past}, ${now}, ${now}, ${now}, ${now})
    `);
    // Queued child: cancel-requested, past deadline, no lease. This is the
    // convergence gap — the cascade marked it cancel-requested and released
    // its lease/allocation but left it `queued`, and only the periodic
    // deadline sweep terminalizes it.
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "cancel_requested_at", "cancel_requested_by", "cancellation_deadline_at", "lease_owner", "lease_token", "lease_expires_at", "available_at", "created_at", "updated_at")
      VALUES (${childRunId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, ${rootRunId}, 1, 0, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'deep_work', ${policy}, 'queued', 1, 0, 'require_all', null, ${past}, null, ${past}, null, null, null, null, ${now}, ${now})
    `);
    await insertBudget(db, companyId, rootRunId, 5000);
    await insertBudget(db, companyId, childRunId, 500);

    const coordinator = new RunCoordinator(db);
    const killSwitch = new MissionKillSwitchService(db);

    // The advance function must never be called: cancel-requested runs are
    // not claimable (claimNext filters cancel_requested_at IS NULL), so the
    // worker only sweeps this convergence scenario.
    const advance = vi.fn(async () => {});

    const worker = new OrchestrationWorker({
      coordinator,
      workerId: 'converge-test-worker',
      pollIntervalMs: 20,
      renewalIntervalMs: 1000,
      deadlineSweepIntervalMs: 50,
      advance,
      deadlineSweep: async () => {
        await killSwitch.enforceDeadlines();
      },
    });

    await worker.start();

    // Wait well beyond two sweep intervals (50ms) so the child terminalizes
    // on the first sweep and the root terminalizes on the next once the
    // subtree barrier clears.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await worker.stop();

    expect(advance).not.toHaveBeenCalled();

    // Queued child terminalized to cancelled by the sweep.
    const childRow = await getRunRow(db, childRunId);
    expect(childRow?.status).toBe('cancelled');
    expect(childRow?.terminal_at).not.toBeNull();

    // Root transitions to cancelled after all descendants settle.
    const rootRow = await getRunRow(db, rootRunId);
    expect(rootRow?.status).toBe('cancelled');
    expect(rootRow?.terminal_at).not.toBeNull();
    expect(rootRow?.lease_owner).toBeNull();

    // Ordered journal events for both runs.
    const childEvents = await getEvents(db, childRunId);
    const childTypes = childEvents.map((e) => e.type);
    expect(childTypes).toContain('run.cancelled');
    expect(childTypes).toContain('budget.released');
    expect(childTypes.indexOf('run.cancelled')).toBeLessThan(childTypes.indexOf('budget.released'));

    const rootEvents = await getEvents(db, rootRunId);
    const rootTypes = rootEvents.map((e) => e.type);
    expect(rootTypes).toContain('run.cancelled');
    expect(rootTypes).toContain('budget.released');

    // Residual budget released for both runs.
    const rootBudget = await getBudgetStatus(db, rootRunId);
    expect(rootBudget?.status).toBe('released');
    const childBudget = await getBudgetStatus(db, childRunId);
    expect(childBudget?.status).toBe('released');

    await closeTestDb();
  });
});
