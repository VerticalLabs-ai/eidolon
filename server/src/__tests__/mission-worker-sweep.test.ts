import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { OrchestrationWorker } from '../services/mission/worker.js';
import { MissionKillSwitchService } from '../services/mission/kill-switch.js';
import { MissionCancellationService } from '../services/mission/cancellation.js';

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
