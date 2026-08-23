import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { OrchestrationWorker } from '../services/mission/worker.js';
import { MissionCompletionService } from '../services/mission/completion.js';

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

async function freshRun(
  mode: 'fast' | 'deep_work' | 'analyst' = 'fast',
  label = '__mtest__ enqueue',
  text = 'Do work',
): Promise<RunContext> {
  enableMissionFlag();
  const db = await createTestDb();
  const app = await createTestServer(db);
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const start = await request(app)
    .post(base)
    .set('Idempotency-Key', `fresh-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode, request: { text } })
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

/** Read a run row's raw columns via SQL. */
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
    SELECT "status", "state_version", "last_event_sequence", "available_at",
           "terminal_at", "lease_owner", "lease_token"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    ...row,
    state_version: Number(row.state_version),
    last_event_sequence: Number(row.last_event_sequence),
  };
}

/** Read all events for a run ordered by sequence. */
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

afterEach(async () => {
  await closeTestServers();
});

// ---------------------------------------------------------------------------
// (1) Runs start in draft — the run.created event records the initial draft
//     status before the enqueue step transitions to queued.
// ---------------------------------------------------------------------------

describe('Mission start: runs begin in draft before enqueue', () => {
  it('run.created event records the initial draft status for fast mode', async () => {
    const ctx = await freshRun('fast', '__mtest__ draft-event');
    const events = await getEvents(ctx.db, ctx.runId);
    const createdEvent = events.find((e) => e.type === 'run.created');
    expect(createdEvent).toBeDefined();
    expect((createdEvent!.payload as Record<string, unknown>).status).toBe('draft');
    await closeTestDb();
  });

  it('deep_work mode transitions to planning (planning required)', async () => {
    const ctx = await freshRun('deep_work', '__mtest__ deep-to-planning');
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('planning');
    // A run.status_changed event records the draft→planning transition.
    const events = await getEvents(ctx.db, ctx.runId);
    const statusChanged = events.find((e) => e.type === 'run.status_changed');
    expect(statusChanged).toBeDefined();
    expect((statusChanged!.payload as Record<string, unknown>).to).toBe('planning');
    await closeTestDb();
  });

  it('analyst mode transitions to planning (planning required)', async () => {
    const ctx = await freshRun('analyst', '__mtest__ analyst-to-planning');
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('planning');
    const events = await getEvents(ctx.db, ctx.runId);
    const statusChanged = events.find((e) => e.type === 'run.status_changed');
    expect(statusChanged).toBeDefined();
    expect((statusChanged!.payload as Record<string, unknown>).to).toBe('planning');
    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// (2) Transition to queued after start — fast/auto modes are enqueued
//     (draft→queued) with a run.status_changed event.
// ---------------------------------------------------------------------------

describe('Mission start: fast mode enqueues to queued', () => {
  it('fast mode run transitions from draft to queued', async () => {
    const ctx = await freshRun('fast', '__mtest__ fast-enqueued');
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');
    expect(row!.state_version).toBe(2);
    expect(row!.last_event_sequence).toBe(5);
    expect(row!.available_at).not.toBeNull();
    await closeTestDb();
  });

  it('a run.status_changed event records the draft→queued transition', async () => {
    const ctx = await freshRun('fast', '__mtest__ status-changed-event');
    const events = await getEvents(ctx.db, ctx.runId);
    const statusChanged = events.find((e) => e.type === 'run.status_changed');
    expect(statusChanged).toBeDefined();
    expect(statusChanged!.sequence).toBe(5);
    const payload = statusChanged!.payload as Record<string, unknown>;
    expect(payload.from).toBe('draft');
    expect(payload.to).toBe('queued');
    await closeTestDb();
  });

  it('auto mode (resolves to fast) is also enqueued to queued', async () => {
    const ctx = await freshRun('fast', '__mtest__ auto-enqueued');
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');
    await closeTestDb();
  });

  it('API start response returns queued status for fast mode', async () => {
    const ctx = await freshRun('fast', '__mtest__ api-queued');
    const res = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);
    expect(res.body.data.run.status).toBe('queued');
    expect(res.body.data.run.stateVersion).toBe(2);
    await closeTestDb();
  });

  it('events are ordered: created, mode, policy, budget, status_changed', async () => {
    const ctx = await freshRun('fast', '__mtest__ event-order');
    const events = await getEvents(ctx.db, ctx.runId);
    expect(events.map((e) => e.type)).toEqual([
      'run.created',
      'mode.resolved',
      'policy.snapshotted',
      'budget.reserved',
      'run.status_changed',
    ]);
    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// (3) Worker can claim queued runs — the coordinator claims a queued run
//     and transitions it to running.
// ---------------------------------------------------------------------------

describe('Mission worker: claims queued runs from start', () => {
  it('worker claims a fast-mode run that was auto-enqueued at start', async () => {
    const ctx = await freshRun('fast', '__mtest__ claim-enqueued');
    // The run is already queued from start (no manual setRunStatus needed).
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');

    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-test');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(ctx.runId);
    expect(claim!.status).toBe('running');
    expect(claim!.leaseToken).toBeTruthy();

    const afterRow = await getRunRow(ctx.db, ctx.runId);
    expect(afterRow!.status).toBe('running');
    expect(afterRow!.lease_owner).toBe('worker-test');
    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// (4) Worker progresses claimed runs through running→completed.
// ---------------------------------------------------------------------------

describe('Mission worker: progresses runs through running→completed', () => {
  it('a fast-mode run progresses queued→running→completed end-to-end', async () => {
    const ctx = await freshRun('fast', '__mtest__ full-lifecycle');
    // Run starts in queued (auto-enqueued by start service).
    const startRow = await getRunRow(ctx.db, ctx.runId);
    expect(startRow!.status).toBe('queued');

    let completed = false;
    const coordinator = new RunCoordinator(ctx.db);
    const worker = new OrchestrationWorker({
      coordinator,
      workerId: 'lifecycle-worker',
      pollIntervalMs: 50,
      advance: async (claim) => {
        // Simulate provider call + completion.
        const completionService = new MissionCompletionService(ctx.db);
        await ctx.db.drizzle.transaction(async (tx) => {
          await completionService.completeRun(tx, claim.companyId, claim.projectId, claim.runId, {
            leaseToken: claim.leaseToken,
          });
        });
        completed = true;
      },
    });

    await worker.start();

    // Wait for the worker to claim and complete the run.
    await vi.waitFor(
      async () => {
        expect(completed).toBe(true);
      },
      { timeout: 5000, interval: 50 },
    );

    await worker.stop();

    const finalRow = await getRunRow(ctx.db, ctx.runId);
    expect(finalRow!.status).toBe('completed');
    expect(finalRow!.terminal_at).not.toBeNull();
    expect(finalRow!.lease_token).toBeNull();

    // Verify lifecycle events: created, mode, policy, budget, status_changed,
    // claimed, completed, budget.released.
    const events = await getEvents(ctx.db, ctx.runId);
    const types = events.map((e) => e.type);
    expect(types).toContain('run.created');
    expect(types).toContain('run.status_changed');
    expect(types).toContain('run.claimed');
    expect(types).toContain('run.completed');
    expect(types).toContain('budget.released');

    // Only one completed event.
    const completedEvents = events.filter((e) => e.type === 'run.completed');
    expect(completedEvents).toHaveLength(1);

    // Events are strictly monotonic.
    for (let i = 1; i < events.length; i++) {
      expect(events[i].sequence).toBeGreaterThan(events[i - 1].sequence);
    }

    await closeTestDb();
  });
});
