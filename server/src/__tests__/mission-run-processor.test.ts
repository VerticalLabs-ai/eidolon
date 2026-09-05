import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { RunProcessor, type ProviderCallFn } from '../services/mission/run-processor.js';

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

async function freshRun(label: string, text = 'Summarize the project status') {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `proc-${randomUUID()}`)
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

async function setRunQueued(db: AnyDb, runId: string) {
  const now = new Date();
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = 'queued',
        "terminal_at" = NULL,
        "updated_at" = ${now},
        "available_at" = ${now}
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
    SELECT * FROM "run_events" WHERE "run_id" = ${runId} ORDER BY "sequence" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function getSettlements(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "budget_settlements" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function getThreadItems(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "task_thread_items"
    WHERE "payload"->>'runId' = ${runId}
    ORDER BY "created_at" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

/** Mock provider that returns a fixed response with token usage. */
function mockProviderCall(outputText = 'Summary: All systems operational.'): ProviderCallFn {
  return vi.fn(async () => ({
    content: outputText,
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputTokens: 100,
    outputTokens: 50,
    costCents: 1,
    finishReason: 'end_turn',
    latencyMs: 500,
  }));
}

afterEach(async () => {
  await closeTestServers();
});

// ---------------------------------------------------------------------------
// RunProcessor: advances a claimed run to completion
// ---------------------------------------------------------------------------

describe('RunProcessor', () => {
  it('claims a queued run, calls the provider, settles budget, and completes', async () => {
    const ctx = await freshRun('proc-complete');
    await setRunQueued(ctx.db, ctx.runId);

    const coordinator = new RunCoordinator(ctx.db);
    const providerCall = mockProviderCall();
    const processor = new RunProcessor(ctx.db, { providerCall });

    // Claim the run.
    const claim = await coordinator.claimNext('worker-proc');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(ctx.runId);

    // Advance the run.
    const controller = new AbortController();
    await processor.advance(claim!, controller.signal);

    // The run should be completed.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row?.status).toBe('completed');
    expect(row?.terminal_at).not.toBeNull();

    // The provider was called once.
    expect(providerCall).toHaveBeenCalledTimes(1);

    // A budget settlement was recorded for the provider call.
    const settlements = await getSettlements(ctx.db, ctx.runId);
    expect(settlements.length).toBe(1);
    expect(settlements[0].cost_cents).toBe(1);

    // A run.completed event was appended.
    const events = await getEvents(ctx.db, ctx.runId);
    const completedEvent = events.find((e) => e.type === 'run.completed');
    expect(completedEvent).toBeDefined();

    // Lifecycle events were projected to thread items.
    const items = await getThreadItems(ctx.db, ctx.runId);
    expect(items.length).toBeGreaterThanOrEqual(1);

    await closeTestDb();
  });

  it('does not call the provider when the abort signal is already set', async () => {
    const ctx = await freshRun('proc-abort');
    await setRunQueued(ctx.db, ctx.runId);

    const coordinator = new RunCoordinator(ctx.db);
    const providerCall = mockProviderCall();
    const processor = new RunProcessor(ctx.db, { providerCall });

    const claim = await coordinator.claimNext('worker-abort');
    expect(claim).not.toBeNull();

    // Abort before advancing.
    const controller = new AbortController();
    controller.abort();
    await processor.advance(claim!, controller.signal);

    // The provider should NOT have been called.
    expect(providerCall).not.toHaveBeenCalled();

    // The run should NOT be completed (the worker stop() will release the lease).
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row?.status).toBe('running');

    await closeTestDb();
  });

  it('does not complete a run that has a pending cancellation request', async () => {
    const ctx = await freshRun('proc-cancel-race');
    await setRunQueued(ctx.db, ctx.runId);

    const coordinator = new RunCoordinator(ctx.db);
    const providerCall = mockProviderCall();
    const processor = new RunProcessor(ctx.db, { providerCall });

    const claim = await coordinator.claimNext('worker-cancel');
    expect(claim).not.toBeNull();

    // Simulate a cancellation request arriving while the worker is processing.
    const now = new Date();
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "cancel_requested_at" = ${now}
      WHERE "id" = ${ctx.runId}
    `);

    const controller = new AbortController();
    await processor.advance(claim!, controller.signal);

    // The provider may have been called, but the run should NOT be completed.
    // The cancellation service will terminalize it.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row?.status).not.toBe('completed');

    await closeTestDb();
  });

  it('handles provider failure by calling the retry service', async () => {
    const ctx = await freshRun('proc-failure');
    await setRunQueued(ctx.db, ctx.runId);

    const coordinator = new RunCoordinator(ctx.db);
    const providerCall = vi.fn(async () => {
      throw new Error('provider network error');
    });
    const processor = new RunProcessor(ctx.db, { providerCall });

    const claim = await coordinator.claimNext('worker-fail');
    expect(claim).not.toBeNull();

    const controller = new AbortController();
    await processor.advance(claim!, controller.signal);

    // The provider was called.
    expect(providerCall).toHaveBeenCalledTimes(1);

    // The run should NOT be completed — it was either requeued or failed.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row?.status).not.toBe('completed');

    // A run.failed or execution.progress (requeue) event should exist.
    const events = await getEvents(ctx.db, ctx.runId);
    const failureEvent = events.find(
      (e) => e.type === 'run.failed' || e.type === 'execution.progress',
    );
    expect(failureEvent).toBeDefined();

    await closeTestDb();
  });

  it('checks non-replayable effects on recovery claims', async () => {
    const ctx = await freshRun('proc-recovery');
    await setRunQueued(ctx.db, ctx.runId);

    const coordinator = new RunCoordinator(ctx.db);
    const providerCall = mockProviderCall();
    const processor = new RunProcessor(ctx.db, { providerCall });

    // First claim (first claim, not recovery).
    const claim1 = await coordinator.claimNext('worker-recovery');
    expect(claim1).not.toBeNull();
    expect(claim1!.isRecovery).toBe(false);

    // Simulate lease expiry.
    const past = new Date(Date.now() - 60_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "lease_expires_at" = ${past}
      WHERE "id" = ${ctx.runId}
    `);

    // Second claim (recovery — expired lease on a running run).
    const claim2 = await coordinator.claimNext('worker-recovery-2');
    expect(claim2).not.toBeNull();
    expect(claim2!.isRecovery).toBe(true);

    // Advance with the recovery claim. Since there are no non-replayable
    // tool invocations, the processor should proceed normally.
    const controller = new AbortController();
    await processor.advance(claim2!, controller.signal);

    // The run should be completed.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row?.status).toBe('completed');

    await closeTestDb();
  });
});
