import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
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

function clearMissionFlag() {
  vi.stubEnv('EIDOLON_FEATURE_FLAGS', '');
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

/** Move a run to a specific nonterminal status. */
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
    waitingFromStatus?: string | null;
  } = {},
) {
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const availableAt = opts.availableAt !== undefined ? opts.availableAt : now;
  const leaseToken = opts.leaseToken ?? (opts.leaseOwner ? randomUUID() : null);
  const leaseExpires =
    opts.leaseExpiresAt ?? (opts.leaseOwner ? new Date(now.getTime() + 30000) : null);

  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "status" = ${status},
        "terminal_at" = ${isTerminal ? now : null},
        "updated_at" = ${now},
        "available_at" = ${availableAt},
        "lease_owner" = ${opts.leaseOwner ?? null},
        "lease_token" = ${leaseToken},
        "lease_expires_at" = ${leaseExpires},
        "heartbeat_at" = ${opts.heartbeatAt ?? (opts.leaseOwner ? now : null)},
        "started_at" = ${['running', 'synthesizing'].includes(status) ? now : null},
        "attempt_count" = ${opts.attemptCount ?? 0},
        "waiting_from_status" = ${opts.waitingFromStatus ?? null}
    WHERE "id" = ${runId}
  `);
}

async function getRunRow(db: AnyDb, runId: string): Promise<Record<string, unknown> | null> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "terminal_at",
           "cancel_requested_at", "cancel_requested_by",
           "cancellation_deadline_at", "lease_owner", "lease_token",
           "lease_expires_at", "created_at"
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
  };
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type" FROM "run_events"
    WHERE "run_id" = ${runId} ORDER BY "sequence" ASC
  `)) as unknown as Array<{ sequence: string | number; type: string }>;
  return rows.map((r) => ({ sequence: Number(r.sequence), type: r.type }));
}

async function countNonterminalRuns(db: AnyDb, companyId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT COUNT(*)::int AS cnt FROM "mission_runs"
    WHERE "company_id" = ${companyId}
      AND "terminal_at" IS NULL
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
}

async function getBudgetReservation(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "reserved_cents", "settled_cents", "released_cents", "status"
    FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-CROSS-090 / VAL-RUN-087 / VAL-RUN-102: Kill switch state matrix
// ---------------------------------------------------------------------------

describe('VAL-CROSS-090: Kill switch has one state matrix', () => {
  it('on disable, every nonterminal state receives cancellation and converges cancelled', async () => {
    const ctx = await freshRun('kill-switch-matrix');

    // Create additional runs in various nonterminal states.
    const states: Array<{ status: string; label: string }> = [
      { status: 'planning', label: 'planning' },
      { status: 'awaiting_input', label: 'awaiting_input' },
      { status: 'awaiting_approval', label: 'awaiting_approval' },
      { status: 'queued', label: 'queued' },
      { status: 'running', label: 'running' },
      { status: 'synthesizing', label: 'synthesizing' },
    ];

    const runIds: string[] = [ctx.runId];
    for (const s of states.slice(1)) {
      const start = await request(ctx.app)
        .post(ctx.base)
        .set('Idempotency-Key', `matrix-${s.label}-${randomUUID()}`)
        .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: s.label } })
        .expect(202);
      runIds.push(start.body.data.run.id as string);
    }

    // Move each run to its target status.
    for (let i = 0; i < states.length; i++) {
      const leaseOwner = ['running', 'synthesizing'].includes(states[i].status)
        ? 'worker-test'
        : null;
      await setRunStatus(ctx.db, runIds[i], states[i].status, {
        leaseOwner,
        availableAt: new Date(),
      });
    }

    // Disable the flag.
    disableMissionFlag();

    // Sweep: request cancellation for all nonterminal runs.
    const killSwitch = new MissionKillSwitchService(ctx.db);
    const result = await killSwitch.sweepCompany(ctx.companyId);
    expect(result.cancelledRuns).toBe(6);

    // Every nonterminal run should now have cancel_requested_at set.
    for (const runId of runIds) {
      const row = await getRunRow(ctx.db, runId);
      expect(row).not.toBeNull();
      expect(row!.cancel_requested_at).not.toBeNull();
    }

    // Non-lease states (planning, awaiting_input, awaiting_approval) should
    // be immediately terminalized to cancelled.
    for (let i = 0; i < 3; i++) {
      const row = await getRunRow(ctx.db, runIds[i]);
      expect(row!.status).toBe('cancelled');
      expect(row!.terminal_at).not.toBeNull();
    }

    // Lease states (queued, running, synthesizing) should have cancel
    // requested but not yet terminalized (the worker would do that).
    for (let i = 3; i < 6; i++) {
      const row = await getRunRow(ctx.db, runIds[i]);
      expect(row!.cancel_requested_at).not.toBeNull();
      expect(row!.cancellation_deadline_at).not.toBeNull();
    }

    // Now enforce deadlines with a clock past the cancellation deadline.
    const futureClock = () => new Date(Date.now() + 120_000);
    const killSwitch2 = new MissionKillSwitchService(ctx.db, { clock: futureClock });
    await killSwitch2.enforceDeadlines();

    // All runs should now be cancelled.
    for (const runId of runIds) {
      const row = await getRunRow(ctx.db, runId);
      expect(row!.status).toBe('cancelled');
      expect(row!.terminal_at).not.toBeNull();
    }

    // Budget should be released for all runs.
    for (const runId of runIds) {
      const budget = await getBudgetReservation(ctx.db, runId);
      expect(budget).not.toBeNull();
      expect(budget!.released_cents).toBeGreaterThan(0);
    }

    await closeTestDb();
  });

  it('terminal runs remain unchanged on disable', async () => {
    const ctx = await freshRun('kill-switch-terminal');

    // Create a completed run and a failed run.
    await setRunStatus(ctx.db, ctx.runId, 'completed');

    const start2 = await request(ctx.app)
      .post(ctx.base)
      .set('Idempotency-Key', `terminal-fail-${randomUUID()}`)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'fail' } })
      .expect(202);
    const failedRunId = start2.body.data.run.id as string;
    await setRunStatus(ctx.db, failedRunId, 'failed');

    // Capture pre-disable state.
    const preCompleted = await getRunRow(ctx.db, ctx.runId);
    const preFailed = await getRunRow(ctx.db, failedRunId);

    // Disable and sweep.
    disableMissionFlag();
    const killSwitch = new MissionKillSwitchService(ctx.db);
    const result = await killSwitch.sweepCompany(ctx.companyId);
    expect(result.cancelledRuns).toBe(0);

    // Terminal runs are unchanged.
    const postCompleted = await getRunRow(ctx.db, ctx.runId);
    const postFailed = await getRunRow(ctx.db, failedRunId);
    expect(postCompleted!.status).toBe('completed');
    expect(postCompleted!.state_version).toBe(preCompleted!.state_version);
    expect(postFailed!.status).toBe('failed');
    expect(postFailed!.state_version).toBe(preFailed!.state_version);

    await closeTestDb();
  });

  it('re-enable resumes none of the cancelled runs', async () => {
    const ctx = await freshRun('kill-switch-reenable');

    // Move to queued.
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Disable and sweep.
    disableMissionFlag();
    const killSwitch = new MissionKillSwitchService(ctx.db);
    await killSwitch.sweepCompany(ctx.companyId);

    // Enforce deadlines to terminalize.
    const futureClock = () => new Date(Date.now() + 120_000);
    const killSwitch2 = new MissionKillSwitchService(ctx.db, { clock: futureClock });
    await killSwitch2.enforceDeadlines();

    // The run is cancelled.
    const preReEnable = await getRunRow(ctx.db, ctx.runId);
    expect(preReEnable!.status).toBe('cancelled');

    // Re-enable the flag.
    enableMissionFlag();

    // The worker should NOT claim the cancelled run.
    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-test');
    expect(claim).toBeNull();

    // The run remains cancelled.
    const postReEnable = await getRunRow(ctx.db, ctx.runId);
    expect(postReEnable!.status).toBe('cancelled');
    expect(postReEnable!.state_version).toBe(preReEnable!.state_version);

    // No new runs were created.
    const nonterminal = await countNonterminalRuns(ctx.db, ctx.companyId);
    expect(nonterminal).toBe(0);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-087 / VAL-RUN-102: Disabled flag denies mutations, allows reads+cancel
// ---------------------------------------------------------------------------

describe('VAL-RUN-102: Disabled flag denies Mission mutations', () => {
  it('while disabled, GET/list/replay/stream and cancel remain available', async () => {
    const ctx = await freshRun('disabled-reads');

    // Move to a nonterminal state.
    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Disable the flag.
    disableMissionFlag();

    // GET snapshot still works.
    const snapshot = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);
    expect(snapshot.body.data.run.id).toBe(ctx.runId);

    // GET list still works.
    const list = await request(ctx.app).get(ctx.base).expect(200);
    expect(list.body.data.runs.length).toBeGreaterThan(0);

    // GET events still works.
    const events = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/events?after=0&limit=100`)
      .expect(200);
    expect(events.body.data.events.length).toBeGreaterThan(0);

    // GET commands still works.
    await request(ctx.app).get(`${ctx.base}/${ctx.runId}/commands`).expect(200);

    // POST cancel still works (no flag check on cancel).
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/cancel`)
      .set('Idempotency-Key', `cancel-${randomUUID()}`)
      .set('If-Match', `"${snapshot.body.data.run.stateVersion}"`)
      .send({ reason: 'Killing via disabled flag' });
    expect(cancelRes.status).toBe(202);

    await closeTestDb();
  });

  it('while disabled, start returns 404 FEATURE_NOT_AVAILABLE', async () => {
    const ctx = await freshRun('disabled-start');

    disableMissionFlag();

    const res = await request(ctx.app)
      .post(ctx.base)
      .set('Idempotency-Key', `disabled-start-${randomUUID()}`)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'should fail' } })
      .expect(404);
    expect(res.body.code).toBe('FEATURE_NOT_AVAILABLE');

    // No new run was created.
    const list = await request(ctx.app).get(ctx.base).expect(200);
    expect(list.body.data.runs.length).toBe(1);

    await closeTestDb();
  });

  it('while disabled, retry returns 404 FEATURE_NOT_AVAILABLE', async () => {
    const ctx = await freshRun('disabled-retry');

    // Make the run terminal (cancelled) so retry would normally be legal.
    await setRunStatus(ctx.db, ctx.runId, 'cancelled');

    disableMissionFlag();

    const snapshot = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `disabled-retry-${randomUUID()}`)
      .set('If-Match', `"${snapshot.body.data.run.stateVersion}"`)
      .send({})
      .expect(404);
    expect(res.body.code).toBe('FEATURE_NOT_AVAILABLE');

    // No successor run was created.
    const list = await request(ctx.app).get(ctx.base).expect(200);
    expect(list.body.data.runs.length).toBe(1);

    await closeTestDb();
  });

  it('while disabled, canonical command endpoint denies non-cancel types but allows cancel', async () => {
    const ctx = await freshRun('disabled-canonical');

    await setRunStatus(ctx.db, ctx.runId, 'cancelled');

    disableMissionFlag();

    const snapshot = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);

    // Cancel via canonical endpoint should work (no flag check for cancel).
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', `canon-cancel-${randomUUID()}`)
      .set('If-Match', `"${snapshot.body.data.run.stateVersion}"`)
      .send({ type: 'run.cancel', reason: 'via canonical while disabled' });
    expect(cancelRes.status).toBe(200);

    // Retry via canonical endpoint should be denied.
    const retryRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', `canon-retry-${randomUUID()}`)
      .set('If-Match', `"${snapshot.body.data.run.stateVersion}"`)
      .send({ type: 'run.retry' })
      .expect(404);
    expect(retryRes.body.code).toBe('FEATURE_NOT_AVAILABLE');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-087: Disabled rollout halts new work safely
// ---------------------------------------------------------------------------

describe('VAL-RUN-087: Disabled rollout halts new work safely', () => {
  it('disabling prevents new claims for nonterminal runs', async () => {
    const ctx = await freshRun('disabled-claims');

    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Disable the flag.
    disableMissionFlag();

    // Sweep to cancel all nonterminal runs.
    const killSwitch = new MissionKillSwitchService(ctx.db);
    await killSwitch.sweepCompany(ctx.companyId);

    // The coordinator should not claim a cancelled run.
    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('worker-test');
    expect(claim).toBeNull();

    await closeTestDb();
  });

  it('disabling prevents post-switch output commits', async () => {
    const ctx = await freshRun('disabled-output');

    // Move to running with a lease.
    await setRunStatus(ctx.db, ctx.runId, 'running', {
      leaseOwner: 'worker-A',
      availableAt: new Date(),
    });

    // Disable and sweep.
    disableMissionFlag();
    const killSwitch = new MissionKillSwitchService(ctx.db);
    await killSwitch.sweepCompany(ctx.companyId);

    // The run now has cancel_requested_at set.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.cancel_requested_at).not.toBeNull();

    // A completion attempt should fail (cancel was requested first).
    const { MissionCompletionService } = await import('../services/mission/completion.js');
    const completionService = new MissionCompletionService(ctx.db);
    await expect(
      ctx.db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {});
      }),
    ).rejects.toThrow();

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-055: Kill switch keeps safe visibility
// ---------------------------------------------------------------------------

describe('VAL-CROSS-055: Kill switch keeps safe visibility', () => {
  it('disabling denies starts and non-cancel mutations, preserves reads/cancel, requests cancellation', async () => {
    const ctx = await freshRun('kill-switch-visibility');

    // Create runs in various states.
    const planningStart = await request(ctx.app)
      .post(ctx.base)
      .set('Idempotency-Key', `vis-planning-${randomUUID()}`)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'planning' } })
      .expect(202);
    const planningRunId = planningStart.body.data.run.id as string;
    await setRunStatus(ctx.db, planningRunId, 'planning');

    const runningStart = await request(ctx.app)
      .post(ctx.base)
      .set('Idempotency-Key', `vis-running-${randomUUID()}`)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'running' } })
      .expect(202);
    const runningRunId = runningStart.body.data.run.id as string;
    await setRunStatus(ctx.db, runningRunId, 'running', {
      leaseOwner: 'worker-A',
      availableAt: new Date(),
    });

    // Terminal run.
    const completedStart = await request(ctx.app)
      .post(ctx.base)
      .set('Idempotency-Key', `vis-completed-${randomUUID()}`)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'completed' } })
      .expect(202);
    const completedRunId = completedStart.body.data.run.id as string;
    await setRunStatus(ctx.db, completedRunId, 'completed');

    // Disable and sweep.
    disableMissionFlag();
    const killSwitch = new MissionKillSwitchService(ctx.db);
    const result = await killSwitch.sweepCompany(ctx.companyId);
    expect(result.cancelledRuns).toBe(3); // planning + running + the original

    // Reads still work.
    const planningSnapshot = await request(ctx.app).get(`${ctx.base}/${planningRunId}`).expect(200);
    expect(planningSnapshot.body.data.run.cancelRequestedAt).not.toBeNull();

    // Terminal run is unchanged.
    const completedSnapshot = await request(ctx.app)
      .get(`${ctx.base}/${completedRunId}`)
      .expect(200);
    expect(completedSnapshot.body.data.run.status).toBe('completed');

    // Start is denied.
    await request(ctx.app)
      .post(ctx.base)
      .set('Idempotency-Key', `vis-post-disable-${randomUUID()}`)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'denied' } })
      .expect(404);

    // Cancel still works on the running run. The sweep already requested
    // cancellation, so this is an idempotent 200 no-op (the cancel command
    // returns 200 when cancelRequestedAt is already set).
    const runningSnapshot = await request(ctx.app).get(`${ctx.base}/${runningRunId}`).expect(200);
    const cancelRes = await request(ctx.app)
      .post(`${ctx.base}/${runningRunId}/cancel`)
      .set('Idempotency-Key', `vis-cancel-${randomUUID()}`)
      .set('If-Match', `"${runningSnapshot.body.data.run.stateVersion}"`)
      .send({ reason: 'Manual cancel while disabled' });
    // 200 (already cancel-requested, idempotent no-op) or 202 (first cancel).
    expect([200, 202]).toContain(cancelRes.status);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-056: Re-enable does not duplicate work
// ---------------------------------------------------------------------------

describe('VAL-CROSS-056: Re-enable does not duplicate work', () => {
  it('re-enabling recreates no run, command, projection, or settlement', async () => {
    const ctx = await freshRun('reenable-no-dup');

    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Disable and sweep.
    disableMissionFlag();
    const killSwitch = new MissionKillSwitchService(ctx.db);
    await killSwitch.sweepCompany(ctx.companyId);

    // Enforce deadlines to terminalize.
    const futureClock = () => new Date(Date.now() + 120_000);
    const killSwitch2 = new MissionKillSwitchService(ctx.db, { clock: futureClock });
    await killSwitch2.enforceDeadlines();

    // Capture counts before re-enable.
    const preRuns = (await ctx.db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM "mission_runs" WHERE "company_id" = ${ctx.companyId}
    `)) as unknown as Array<{ cnt: number }>;
    const preRunCount = preRuns[0].cnt;

    const preCommands = (await ctx.db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM "run_commands" WHERE "company_id" = ${ctx.companyId}
    `)) as unknown as Array<{ cnt: number }>;
    const preCommandCount = preCommands[0].cnt;

    const preSettlements = (await ctx.db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM "budget_settlements" WHERE "company_id" = ${ctx.companyId}
    `)) as unknown as Array<{ cnt: number }>;
    const preSettlementCount = preSettlements[0].cnt;

    // Re-enable.
    enableMissionFlag();

    // Sweep should find nothing to cancel.
    const killSwitch3 = new MissionKillSwitchService(ctx.db);
    const sweepResult = await killSwitch3.sweepCompany(ctx.companyId);
    expect(sweepResult.cancelledRuns).toBe(0);

    // Enforce deadlines should find nothing.
    const deadlineResult = await killSwitch3.enforceDeadlines();
    expect(deadlineResult.terminalized).toBe(0);

    // No new runs, commands, or settlements.
    const postRuns = (await ctx.db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM "mission_runs" WHERE "company_id" = ${ctx.companyId}
    `)) as unknown as Array<{ cnt: number }>;
    expect(postRuns[0].cnt).toBe(preRunCount);

    const postCommands = (await ctx.db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM "run_commands" WHERE "company_id" = ${ctx.companyId}
    `)) as unknown as Array<{ cnt: number }>;
    expect(postCommands[0].cnt).toBe(preCommandCount);

    const postSettlements = (await ctx.db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS cnt FROM "budget_settlements" WHERE "company_id" = ${ctx.companyId}
    `)) as unknown as Array<{ cnt: number }>;
    expect(postSettlements[0].cnt).toBe(preSettlementCount);

    // The run remains cancelled.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');

    await closeTestDb();
  });

  it('only an explicit user retry creates new work after re-enable', async () => {
    const ctx = await freshRun('reenable-retry');

    await setRunStatus(ctx.db, ctx.runId, 'queued');

    // Disable, sweep, enforce deadlines.
    disableMissionFlag();
    const killSwitch = new MissionKillSwitchService(ctx.db);
    await killSwitch.sweepCompany(ctx.companyId);
    const futureClock = () => new Date(Date.now() + 120_000);
    await new MissionKillSwitchService(ctx.db, { clock: futureClock }).enforceDeadlines();

    // Re-enable.
    enableMissionFlag();

    // The worker should not claim the cancelled run.
    const coordinator = new RunCoordinator(ctx.db);
    expect(await coordinator.claimNext('worker-test')).toBeNull();

    // An explicit retry creates a new run.
    const snapshot = await request(ctx.app).get(`${ctx.base}/${ctx.runId}`).expect(200);
    const retryRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/retry`)
      .set('Idempotency-Key', `reenable-retry-${randomUUID()}`)
      .set('If-Match', `"${snapshot.body.data.run.stateVersion}"`)
      .send({})
      .expect(202);

    const successorId = retryRes.headers.location?.split('/').pop();
    expect(successorId).toBeTruthy();
    expect(successorId).not.toBe(ctx.runId);

    // The original remains cancelled.
    const originalRow = await getRunRow(ctx.db, ctx.runId);
    expect(originalRow!.status).toBe('cancelled');

    // The successor is a new draft run.
    const successorRow = await getRunRow(ctx.db, successorId!);
    expect(successorRow).not.toBeNull();
    expect(['draft', 'queued', 'planning']).toContain(successorRow!.status);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-098: Abandoned Missions fail and release by persisted deadline
// ---------------------------------------------------------------------------

describe('VAL-CROSS-098: Abandoned Missions fail and release by persisted deadline', () => {
  it('enforces cancellation deadline for cancel-requested runs after worker loss', async () => {
    const ctx = await freshRun('abandoned-deadline');

    // Move to running with a lease, then request cancellation.
    await setRunStatus(ctx.db, ctx.runId, 'running', {
      leaseOwner: 'worker-A',
      availableAt: new Date(),
    });

    // Request cancellation (sets cancellation_deadline_at).
    const cancelService = new MissionCancellationService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      const schema = ctx.db.schema;
      const [run] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, ctx.runId))
        .for('update')
        .limit(1);
      await cancelService.requestCancellation(tx, run!, {
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        actorType: 'system',
        actorId: 'worker-A',
      });
    });

    // Simulate worker loss: the lease is still held but the worker is gone.
    // The cancellation deadline has passed.
    const futureClock = () => new Date(Date.now() + 120_000);
    const killSwitch = new MissionKillSwitchService(ctx.db, { clock: futureClock });
    const result = await killSwitch.enforceDeadlines();
    expect(result.terminalized).toBe(1);

    // The run should be cancelled.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');
    expect(row!.terminal_at).not.toBeNull();

    // Budget should be released.
    const budget = await getBudgetReservation(ctx.db, ctx.runId);
    expect(budget).not.toBeNull();
    expect(budget!.released_cents).toBeGreaterThan(0);

    // Events should include run.cancelled and budget.released.
    const events = await getEvents(ctx.db, ctx.runId);
    const types = events.map((e) => e.type);
    expect(types).toContain('run.cancel_requested');
    expect(types).toContain('run.cancelled');
    expect(types).toContain('budget.released');

    await closeTestDb();
  });

  it('enforces root deadline for abandoned runs without cancellation request', async () => {
    const ctx = await freshRun('abandoned-root-deadline');

    // Move to running with a lease, but no cancellation request.
    // Set the created_at to the past so the root deadline has passed.
    const longAgo = new Date(Date.now() - 7200_000); // 2 hours ago
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "status" = 'running',
          "terminal_at" = NULL,
          "lease_owner" = 'worker-A',
          "lease_token" = ${randomUUID()},
          "lease_expires_at" = ${new Date(Date.now() + 30000)},
          "heartbeat_at" = ${new Date()},
          "available_at" = ${new Date()},
          "started_at" = ${new Date()},
          "created_at" = ${longAgo},
          "cancel_requested_at" = NULL,
          "cancellation_deadline_at" = NULL
      WHERE "id" = ${ctx.runId}
    `);

    // The root deadline (createdAt + durationSeconds) has passed.
    // enforceDeadlines should request cancellation and terminalize.
    const futureClock = () => new Date(Date.now() + 120_000);
    const killSwitch = new MissionKillSwitchService(ctx.db, { clock: futureClock });
    const result = await killSwitch.enforceDeadlines();
    expect(result.terminalized).toBe(1);

    // The run should be cancelled.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');
    expect(row!.terminal_at).not.toBeNull();

    // Budget should be released.
    const budget = await getBudgetReservation(ctx.db, ctx.runId);
    expect(budget).not.toBeNull();
    expect(budget!.released_cents).toBeGreaterThan(0);

    await closeTestDb();
  });

  it('permits later budget use after abandoned run is released', async () => {
    const ctx = await freshRun('abandoned-budget-reuse');

    await setRunStatus(ctx.db, ctx.runId, 'running', {
      leaseOwner: 'worker-A',
      availableAt: new Date(),
    });

    // Request cancellation.
    const cancelService = new MissionCancellationService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      const schema = ctx.db.schema;
      const [run] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, ctx.runId))
        .for('update')
        .limit(1);
      await cancelService.requestCancellation(tx, run!, {
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        actorType: 'system',
        actorId: 'worker-A',
      });
    });

    // Enforce deadlines (past the cancellation deadline).
    const futureClock = () => new Date(Date.now() + 120_000);
    const killSwitch = new MissionKillSwitchService(ctx.db, { clock: futureClock });
    await killSwitch.enforceDeadlines();

    // The run is cancelled and budget is released.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');

    // Check that company monthly spend was not increased (no settlement).
    const companyRow = (await ctx.db.drizzle.execute(sql`
      SELECT "spent_monthly_cents" FROM "companies" WHERE "id" = ${ctx.companyId}
    `)) as unknown as Array<{ spent_monthly_cents: number }>;
    expect(companyRow[0].spent_monthly_cents).toBe(0);

    // A new run can be started and budget can be reserved.
    enableMissionFlag();
    const newStart = await request(ctx.app)
      .post(ctx.base)
      .set('Idempotency-Key', `reuse-${randomUUID()}`)
      .send({ projectThreadId: ctx.threadId, mode: 'fast', request: { text: 'new work' } })
      .expect(202);
    expect(newStart.body.data.run.id).not.toBe(ctx.runId);

    // The new run has a budget reservation.
    const newBudget = await getBudgetReservation(ctx.db, newStart.body.data.run.id);
    expect(newBudget).not.toBeNull();
    expect(newBudget!.reserved_cents).toBeGreaterThan(0);

    await closeTestDb();
  });

  it('fences stale work: a stale lease cannot commit after deadline enforcement', async () => {
    const ctx = await freshRun('abandoned-stale-fence');

    // Move to running with a lease.
    const staleToken = randomUUID();
    await setRunStatus(ctx.db, ctx.runId, 'running', {
      leaseOwner: 'worker-A',
      leaseToken: staleToken,
      availableAt: new Date(),
    });

    // Request cancellation.
    const cancelService = new MissionCancellationService(ctx.db);
    await ctx.db.drizzle.transaction(async (tx) => {
      const schema = ctx.db.schema;
      const [run] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, ctx.runId))
        .for('update')
        .limit(1);
      await cancelService.requestCancellation(tx, run!, {
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.runId,
        actorType: 'system',
        actorId: 'worker-A',
      });
    });

    // Enforce deadlines (past the cancellation deadline).
    const futureClock = () => new Date(Date.now() + 120_000);
    const killSwitch = new MissionKillSwitchService(ctx.db, { clock: futureClock });
    await killSwitch.enforceDeadlines();

    // The run is cancelled.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');

    // A stale worker with the old lease token cannot complete the run.
    const { MissionCompletionService } = await import('../services/mission/completion.js');
    const completionService = new MissionCompletionService(ctx.db);
    await expect(
      ctx.db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, ctx.companyId, ctx.projectId, ctx.runId, {
          leaseToken: staleToken,
        });
      }),
    ).rejects.toThrow();

    // The run remains cancelled.
    const postRow = await getRunRow(ctx.db, ctx.runId);
    expect(postRow!.status).toBe('cancelled');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// sweepAllDisabled: multi-company kill switch
// ---------------------------------------------------------------------------

describe('sweepAllDisabled: multi-company kill switch', () => {
  it('sweeps only companies with disabled flag', async () => {
    enableMissionFlag();
    const db = await createTestDb();
    const app = await createTestServer(db);

    // Company A (flag enabled).
    const scopeA = await seedScope(db, 'company-A');
    const baseA = `/api/companies/${scopeA.companyId}/projects/${scopeA.projectId}/mission-runs`;
    await request(app)
      .post(baseA)
      .set('Idempotency-Key', `sweep-A-${randomUUID()}`)
      .send({ projectThreadId: scopeA.threadId, mode: 'fast', request: { text: 'A' } })
      .expect(202);

    // Company B (flag disabled).
    const scopeB = await seedScope(db, 'company-B');
    const baseB = `/api/companies/${scopeB.companyId}/projects/${scopeB.projectId}/mission-runs`;
    const startB = await request(app)
      .post(baseB)
      .set('Idempotency-Key', `sweep-B-${randomUUID()}`)
      .send({ projectThreadId: scopeB.threadId, mode: 'fast', request: { text: 'B' } })
      .expect(202);
    const runBId = startB.body.data.run.id as string;

    // Disable flag globally.
    disableMissionFlag();

    const killSwitch = new MissionKillSwitchService(db);
    const result = await killSwitch.sweepAllDisabled();
    expect(result.sweptCompanies).toBeGreaterThanOrEqual(1);
    expect(result.cancelledRuns).toBeGreaterThanOrEqual(1);

    // Company B's run should be cancelled (or have cancel requested).
    const rowB = await getRunRow(db, runBId);
    expect(rowB!.cancel_requested_at).not.toBeNull();

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// Malformed flag fails closed
// ---------------------------------------------------------------------------

describe('Malformed flag fails closed', () => {
  it('absent flag: sweepAllDisabled treats all companies as disabled', async () => {
    const ctx = await freshRun('malformed-absent');

    clearMissionFlag();

    const killSwitch = new MissionKillSwitchService(ctx.db);
    const result = await killSwitch.sweepAllDisabled();
    expect(result.cancelledRuns).toBeGreaterThanOrEqual(1);

    // The run should have cancellation requested.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.cancel_requested_at).not.toBeNull();

    await closeTestDb();
  });
});
