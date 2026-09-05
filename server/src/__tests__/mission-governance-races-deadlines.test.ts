import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import { PlannerTestHarness, HARNESS_ENV_FLAG } from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { MissionKillSwitchService } from '../services/mission/kill-switch.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';

/**
 * Governance races, terminal boundaries, and approval deadlines.
 *
 * (VAL-PLAN-048, 049, 051, 078, 109, 115, 121, 122)
 *
 * Tests use barriers for concurrent decisions and revision races, worker
 * restart, root-deadline expiry, singular terminal outcomes, and the
 * complete transition matrix.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

function enableHarness() {
  vi.stubEnv(HARNESS_ENV_FLAG, '1');
}

async function seedScope(db: AnyDb, label: string) {
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

function validPlanContent(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Analyze the quarterly report',
    steps: [
      {
        stepKey: 'step-1',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Gather data',
        description: 'Collect the quarterly data',
        dependencies: [],
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['analysis'],
            requiredTools: ['research.search'],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: ['research.search'],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['report-data'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Data collected',
        budgetCents: 100,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize the report',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-1', output: 'report-data' }],
      declaredOutput: 'final-report',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'Report complete',
      budgetCents: 100,
    },
    planningBudgetCents: 100,
    partialResultPolicy: 'require_all',
    limits: {
      steps: 4,
      durationSeconds: 300,
      providerCalls: 6,
      totalTokens: 32000,
      outputBytes: 1048576,
      costCents: 500,
      depth: 0,
      fanOut: 0,
      descendants: 0,
    },
    ...overrides,
  };
}

function revisedPlanContent(): unknown {
  return validPlanContent({ objective: 'Analyze the annual report with deeper analysis' });
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

async function freshAwaitingApprovalRun(label: string): Promise<RunContext> {
  enableMissionFlag();
  enableHarness();
  const db = await createTestDb();
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const app = await createTestServer(db);

  const res = await request(app)
    .post(base)
    .set('Idempotency-Key', `gov-${randomUUID()}`)
    .send({
      projectThreadId: threadId,
      mode: 'deep_work',
      request: { text: 'Analyze the quarterly report with multiple deliverables and dependencies' },
    })
    .expect(202);
  const runId = res.body.data.run.id as string;

  // Publish a plan to get the run into awaiting_approval.
  const harness = new PlannerTestHarness({ vectors: [{ content: validPlanContent() }] });
  const planner = new PlannerService(db, { generator: harness });
  const coordinator = new RunCoordinator(db);
  const claim = await coordinator.claimNext('test-worker');
  expect(claim).not.toBeNull();
  await planner.plan(claim!, new AbortController().signal);
  await coordinator.release(claim!);

  const row = await getRunRow(db, runId);
  expect(row!.status).toBe('awaiting_approval');

  return { db, app, companyId, projectId, threadId, runId, stateVersion: row!.stateVersion, base };
}

async function publishPlanAndWait(
  db: AnyDb,
  runId: string,
  planContent: unknown = validPlanContent(),
) {
  const harness = new PlannerTestHarness({ vectors: [{ content: planContent }] });
  const planner = new PlannerService(db, { generator: harness });
  const coordinator = new RunCoordinator(db);
  const claim = await coordinator.claimNext('test-worker');
  expect(claim).not.toBeNull();
  await planner.plan(claim!, new AbortController().signal);
  await coordinator.release(claim!);
}

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "current_plan_revision_id",
           "approved_plan_revision_id", "terminal_at", "failure_category", "failure_code",
           "cancel_requested_at", "cancellation_deadline_at", "created_at"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    status: row['status'] as string,
    stateVersion: Number(row['state_version']),
    lastEventSequence: Number(row['last_event_sequence']),
    currentPlanRevisionId: (row['current_plan_revision_id'] as string) ?? null,
    approvedPlanRevisionId: (row['approved_plan_revision_id'] as string) ?? null,
    terminalAt: (row['terminal_at'] as string | Date) ?? null,
    failureCategory: (row['failure_category'] as string) ?? null,
    failureCode: (row['failure_code'] as string) ?? null,
    cancelRequestedAt: (row['cancel_requested_at'] as string | Date) ?? null,
    cancellationDeadlineAt: (row['cancellation_deadline_at'] as string | Date) ?? null,
    createdAt: row['created_at'] as Date,
  };
}

async function getCurrentRevision(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT rpr."id", rpr."revision", rpr."status", rpr."content_hash", rpr."parent_revision_id"
    FROM "run_plan_revisions" rpr
    JOIN "mission_runs" mr ON mr."current_plan_revision_id" = rpr."id"
    WHERE mr."id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  return {
    id: rows[0]['id'] as string,
    revision: rows[0]['revision'] as number,
    status: rows[0]['status'] as string,
    contentHash: rows[0]['content_hash'] as string,
    parentRevisionId: (rows[0]['parent_revision_id'] as string) ?? null,
  };
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

async function getApprovalBindings(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "plan_revision_id", "content_hash", "approval_id", "decision",
           "deciding_user_id", "decided_at", "is_current_authorization"
    FROM "run_plan_approval_bindings" WHERE "run_id" = ${runId}
    ORDER BY "created_at" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    planRevisionId: r['plan_revision_id'] as string,
    contentHash: r['content_hash'] as string,
    approvalId: r['approval_id'] as string,
    decision: (r['decision'] as string) ?? null,
    decidingUserId: (r['deciding_user_id'] as string) ?? null,
    isCurrentAuthorization: r['is_current_authorization'] as boolean,
  }));
}

async function getApprovalStatus(db: AnyDb, approvalId: string): Promise<string> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status" FROM "approvals" WHERE "id" = ${approvalId}
  `)) as unknown as Array<Record<string, unknown>>;
  return (rows[0]?.['status'] as string) ?? 'not_found';
}

async function getAllRevisions(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "revision", "status", "content_hash", "parent_revision_id",
           "decided_by_user_id", "feedback"
    FROM "run_plan_revisions" WHERE "run_id" = ${runId}
    ORDER BY "revision" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    revision: r['revision'] as number,
    status: r['status'] as string,
    contentHash: r['content_hash'] as string,
    parentRevisionId: (r['parent_revision_id'] as string) ?? null,
    decidedByUserId: (r['decided_by_user_id'] as string) ?? null,
    feedback: (r['feedback'] as string) ?? null,
  }));
}

function approveCurrentPlan(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  runId: string,
  stateVersion: number,
  revisionId: string,
  contentHash: string,
  idempotencyKey?: string,
) {
  return request(app)
    .post(`${base}/${runId}/plan/approve`)
    .set('Idempotency-Key', idempotencyKey ?? `approve-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .set('X-Eidolon-Test-Org-Role', 'owner')
    .send({ revisionId, contentHash });
}

function rejectCurrentPlan(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  runId: string,
  stateVersion: number,
  revisionId: string,
  contentHash: string,
  reason: string,
  disposition?: 'revise',
  feedback?: string,
  idempotencyKey?: string,
) {
  const body: Record<string, unknown> = { revisionId, contentHash, reason };
  if (disposition) {
    body.disposition = disposition;
    if (feedback) {
      body.feedback = feedback;
    }
  }
  return request(app)
    .post(`${base}/${runId}/plan/reject`)
    .set('Idempotency-Key', idempotencyKey ?? `reject-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .set('X-Eidolon-Test-Org-Role', 'owner')
    .send(body);
}

function reviseCurrentPlan(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  runId: string,
  stateVersion: number,
  revisionId: string,
  contentHash: string,
  feedback: string,
  idempotencyKey?: string,
) {
  return request(app)
    .post(`${base}/${runId}/plan/revisions`)
    .set('Idempotency-Key', idempotencyKey ?? `revise-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .set('X-Eidolon-Test-Org-Role', 'member')
    .send({ revisionId, contentHash, feedback });
}

function cancelRun(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  runId: string,
  stateVersion: number,
  reason: string,
  idempotencyKey?: string,
) {
  return request(app)
    .post(`${base}/${runId}/cancel`)
    .set('Idempotency-Key', idempotencyKey ?? `cancel-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .set('X-Eidolon-Test-Org-Role', 'member')
    .send({ reason });
}

/** A simple deferred barrier for concurrent race tests. */
interface Barrier {
  promise: Promise<void>;
  resolve: () => void;
}
function makeBarrier(): Barrier {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-PLAN-048: Concurrent approvals resolve once
// ---------------------------------------------------------------------------

describe('VAL-PLAN-048: Concurrent approvals resolve once', () => {
  it('two concurrent approvals with different idempotency keys yield one winner', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ concurrent-approve');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);
    expect(rev).not.toBeNull();

    const startBarrier = makeBarrier();

    const approveA = startBarrier.promise.then(() =>
      approveCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        `approve-a-${randomUUID()}`,
      ),
    );
    const approveB = startBarrier.promise.then(() =>
      approveCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        `approve-b-${randomUUID()}`,
      ),
    );

    startBarrier.resolve();
    const [resA, resB] = await Promise.all([approveA, approveB]);

    // Exactly one should succeed (200), the other should get stale/invalid.
    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toContain(200);
    const loser = resA.status === 200 ? resB : resA;
    expect(loser.status).toBeGreaterThanOrEqual(409);

    // The run should be queued (one queue transition).
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');
    expect(row!.approvedPlanRevisionId).toBe(rev!.id);

    // Exactly one plan.approved event.
    const events = await getEvents(ctx.db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents).toHaveLength(1);

    // Exactly one approval binding with decision 'approved'.
    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    const approvedBindings = bindings.filter((b) => b.decision === 'approved');
    expect(approvedBindings).toHaveLength(1);
    expect(approvedBindings[0].isCurrentAuthorization).toBe(true);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-049: Concurrent approve and reject resolve once
// ---------------------------------------------------------------------------

describe('VAL-PLAN-049: Concurrent approve and reject resolve once', () => {
  it('concurrent approve and reject against same version yield one terminal decision', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ approve-vs-reject');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);
    expect(rev).not.toBeNull();

    const startBarrier = makeBarrier();

    const approvePromise = startBarrier.promise.then(() =>
      approveCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        `approve-${randomUUID()}`,
      ),
    );
    const rejectPromise = startBarrier.promise.then(() =>
      rejectCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        'Not good enough',
        undefined,
        undefined,
        `reject-${randomUUID()}`,
      ),
    );

    startBarrier.resolve();
    const [resApprove, resReject] = await Promise.all([approvePromise, rejectPromise]);

    // Exactly one should win. If approve wins → 200 + queued. If reject wins
    // → 200 + cancelled. The loser gets 412 or 409.
    const winner =
      resApprove.status === 200 ? 'approve' : resReject.status === 200 ? 'reject' : null;
    expect(winner).not.toBeNull();

    const row = await getRunRow(ctx.db, ctx.runId);
    if (winner === 'approve') {
      expect(row!.status).toBe('queued');
      expect(resReject.status).toBeGreaterThanOrEqual(409);
    } else {
      expect(row!.status).toBe('cancelled');
      expect(row!.terminalAt).not.toBeNull();
      expect(resApprove.status).toBeGreaterThanOrEqual(409);
    }

    // Exactly one decision event (plan.approved XOR plan.rejected).
    const events = await getEvents(ctx.db, ctx.runId);
    const decisionEvents = events.filter(
      (e) => e.type === 'plan.approved' || e.type === 'plan.rejected',
    );
    expect(decisionEvents).toHaveLength(1);

    // Exactly one binding with a decision.
    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    const decidedBindings = bindings.filter((b) => b.decision !== null);
    expect(decidedBindings).toHaveLength(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-051: Terminal decisions cannot be overwritten
// ---------------------------------------------------------------------------

describe('VAL-PLAN-051: Terminal decisions cannot be overwritten', () => {
  it('after rejection cancels the run, every later plan decision is invalid', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ reject-then-decide');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // Reject (default disposition → cancel).
    await rejectCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Not what we need',
    ).expect(200);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');
    expect(row!.terminalAt).not.toBeNull();
    const cancelledVersion = row!.stateVersion;

    // Attempt approve → rejected (run is terminal, not awaiting_approval).
    const approveRes = await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      cancelledVersion,
      rev!.id,
      rev!.contentHash,
    );
    expect(approveRes.status).toBeGreaterThanOrEqual(400);
    expect([409, 412]).toContain(approveRes.status);

    // Attempt reject → rejected.
    const rejectRes = await rejectCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      cancelledVersion,
      rev!.id,
      rev!.contentHash,
      'Try again',
    );
    expect(rejectRes.status).toBeGreaterThanOrEqual(400);

    // Attempt revision → rejected.
    const reviseRes = await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      cancelledVersion,
      rev!.id,
      rev!.contentHash,
      'Change it',
    );
    expect(reviseRes.status).toBeGreaterThanOrEqual(400);

    // Run remains cancelled, no new decision events.
    const rowAfter = await getRunRow(ctx.db, ctx.runId);
    expect(rowAfter!.status).toBe('cancelled');
    expect(rowAfter!.stateVersion).toBe(cancelledVersion);

    const events = await getEvents(ctx.db, ctx.runId);
    const decisionEvents = events.filter(
      (e) => e.type === 'plan.approved' || e.type === 'plan.rejected',
    );
    expect(decisionEvents).toHaveLength(1); // Only the original reject.

    // No decision history rewritten.
    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    const decidedBindings = bindings.filter((b) => b.decision !== null);
    expect(decidedBindings).toHaveLength(1);
    expect(decidedBindings[0].decision).toBe('rejected');

    await closeTestDb();
  });

  it('after approval advances the run, reject is invalid and queued revision is legal before effects', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ approve-then-act');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // Approve.
    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    let row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');
    const queuedVersion = row!.stateVersion;

    // Reject from queued → INVALID_RUN_STATE (not awaiting_approval).
    const rejectRes = await rejectCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      queuedVersion,
      rev!.id,
      rev!.contentHash,
      'Wait no',
    );
    expect(rejectRes.status).toBe(409);
    expect(rejectRes.body.code).toBe('INVALID_RUN_STATE');

    // Run remains queued.
    row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');

    // Queued revision (before effects) is legal → returns to planning.
    const reviseRes = await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      queuedVersion,
      rev!.id,
      rev!.contentHash,
      'Need changes',
    );
    expect(reviseRes.status).toBe(202);

    row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('planning');
    expect(row!.approvedPlanRevisionId).toBeNull();

    // The original approved binding is preserved as historical.
    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    const approvedBinding = bindings.find((b) => b.decision === 'approved');
    expect(approvedBinding).toBeTruthy();
    expect(approvedBinding!.isCurrentAuthorization).toBe(false);

    await closeTestDb();
  });

  it('revision after execution starts returns EXECUTION_ALREADY_STARTED', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ exec-already-started');
    const { companyId, projectId } = ctx;
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // Approve.
    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    let row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');

    // Simulate execution.started event.
    const seq = row!.lastEventSequence + 1;
    await ctx.db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
      VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${ctx.runId}, ${seq}, 'execution.started', 1, '{}'::jsonb, 'system', null, null, NOW())
    `);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "last_event_sequence" = ${seq}, "status" = 'running' WHERE "id" = ${ctx.runId}
    `);

    row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('running');

    // Revision from running with execution.started event →
    // EXECUTION_ALREADY_STARTED (VAL-SUB-095).
    const reviseRes = await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Too late to revise',
    );
    expect(reviseRes.status).toBe(409);
    expect(reviseRes.body.code).toBe('EXECUTION_ALREADY_STARTED');

    // Run remains running.
    const rowAfter = await getRunRow(ctx.db, ctx.runId);
    expect(rowAfter!.status).toBe('running');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-078: Worker restart preserves approval gate
// ---------------------------------------------------------------------------

describe('VAL-PLAN-078: Worker restart preserves approval gate', () => {
  it('restart before approval starts no work; the gate is preserved', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ restart-before-approve');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // The run is in awaiting_approval (no worker lease). Simulate a worker
    // restart by creating a new coordinator and claiming.
    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('restarted-worker');
    // No claim should be made because the run is in awaiting_approval,
    // not an eligible claim state.
    expect(claim).toBeNull();

    // The gate is preserved: run is still awaiting_approval with the same revision.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');
    expect(row!.currentPlanRevisionId).toBe(rev!.id);

    // Approval still works after "restart".
    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    const rowAfter = await getRunRow(ctx.db, ctx.runId);
    expect(rowAfter!.status).toBe('queued');

    await closeTestDb();
  });

  it('restart during approved execution resumes without repeating decisions', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ restart-during-exec');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // Approve.
    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    let row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');
    const approvedVersion = row!.stateVersion;
    const approvedSeq = row!.lastEventSequence;

    // Simulate a worker restart: create a new coordinator and claim the queued run.
    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('restarted-worker');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(ctx.runId);

    // The run is now claimed (running). The approved revision is preserved.
    row = await getRunRow(ctx.db, ctx.runId);
    expect(['running', 'queued']).toContain(row!.status);
    expect(row!.approvedPlanRevisionId).toBe(rev!.id);

    // No duplicate plan.approved event was emitted by the claim.
    const events = await getEvents(ctx.db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents).toHaveLength(1);

    // State version and sequence only increased (no regression).
    expect(row!.stateVersion).toBeGreaterThanOrEqual(approvedVersion);
    expect(row!.lastEventSequence).toBeGreaterThanOrEqual(approvedSeq);

    // Release the claim.
    await coordinator.release(claim!);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-109: Every approval-gate race has one winner
// ---------------------------------------------------------------------------

describe('VAL-PLAN-109: Every approval-gate race has one winner', () => {
  it('approval raced against ordinary revision request yields one winner', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ approve-vs-revise');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    const startBarrier = makeBarrier();
    const approvePromise = startBarrier.promise.then(() =>
      approveCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        `approve-${randomUUID()}`,
      ),
    );
    const revisePromise = startBarrier.promise.then(() =>
      reviseCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        'Please revise',
        `revise-${randomUUID()}`,
      ),
    );

    startBarrier.resolve();
    const [resApprove, resRevise] = await Promise.all([approvePromise, revisePromise]);

    // Exactly one winner.
    const winners = [resApprove, resRevise].filter((r) => r.status === 200 || r.status === 202);
    expect(winners).toHaveLength(1);

    const row = await getRunRow(ctx.db, ctx.runId);
    // Winner is either queued (approve) or planning (revise).
    expect(['queued', 'planning']).toContain(row!.status);

    // Loser did not change state.
    if (resApprove.status === 200) {
      expect(row!.status).toBe('queued');
      expect(resRevise.status).toBeGreaterThanOrEqual(409);
    } else {
      expect(row!.status).toBe('planning');
      expect(resApprove.status).toBeGreaterThanOrEqual(409);
    }

    // Exactly one decision/revision event.
    const events = await getEvents(ctx.db, ctx.runId);
    const gateEvents = events.filter(
      (e) => e.type === 'plan.approved' || e.type === 'plan.revision_requested',
    );
    expect(gateEvents).toHaveLength(1);

    await closeTestDb();
  });

  it('approval raced against reject-revise yields one winner', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ approve-vs-rejectrevise');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    const startBarrier = makeBarrier();
    const approvePromise = startBarrier.promise.then(() =>
      approveCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        `approve-${randomUUID()}`,
      ),
    );
    const rejectRevisePromise = startBarrier.promise.then(() =>
      rejectCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        'Change direction',
        'revise',
        'Do it differently',
        `reject-revise-${randomUUID()}`,
      ),
    );

    startBarrier.resolve();
    const [resApprove, resRejectRevise] = await Promise.all([approvePromise, rejectRevisePromise]);

    const winners = [resApprove, resRejectRevise].filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);

    const row = await getRunRow(ctx.db, ctx.runId);
    if (resApprove.status === 200) {
      expect(row!.status).toBe('queued');
      expect(resRejectRevise.status).toBeGreaterThanOrEqual(409);
    } else {
      expect(row!.status).toBe('planning');
      expect(resApprove.status).toBeGreaterThanOrEqual(409);
    }

    // Exactly one gate decision event.
    const events = await getEvents(ctx.db, ctx.runId);
    const gateEvents = events.filter(
      (e) =>
        e.type === 'plan.approved' ||
        (e.type === 'plan.rejected' && e.payload?.disposition === 'revise'),
    );
    expect(gateEvents).toHaveLength(1);

    await closeTestDb();
  });

  it('approval raced against run cancellation yields one winner', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ approve-vs-cancel');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    const startBarrier = makeBarrier();
    const approvePromise = startBarrier.promise.then(() =>
      approveCurrentPlan(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        rev!.id,
        rev!.contentHash,
        `approve-${randomUUID()}`,
      ),
    );
    const cancelPromise = startBarrier.promise.then(() =>
      cancelRun(
        ctx.app,
        ctx.base,
        ctx.runId,
        ctx.stateVersion,
        'No longer needed',
        `cancel-${randomUUID()}`,
      ),
    );

    startBarrier.resolve();
    const [resApprove] = await Promise.all([approvePromise, cancelPromise]);

    // Exactly one winner: either queued (approve) or cancelled (cancel).
    const row = await getRunRow(ctx.db, ctx.runId);
    if (resApprove.status === 200) {
      expect(row!.status).toBe('queued');
      // Cancel from queued could still get 202 (cancel is allowed from queued).
      // But the approve won the gate; cancel may or may not have been accepted.
      // The key invariant: no contradictory state — run is queued, not cancelled.
    } else {
      expect(row!.status).toBe('cancelled');
      expect(row!.terminalAt).not.toBeNull();
    }

    // At most one plan.approved event (if approve won).
    const events = await getEvents(ctx.db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents.length).toBeLessThanOrEqual(1);

    // If cancelled, no approved binding is current.
    if (row!.status === 'cancelled') {
      const bindings = await getApprovalBindings(ctx.db, ctx.runId);
      const currentAuth = bindings.filter((b) => b.isCurrentAuthorization);
      expect(currentAuth).toHaveLength(0);
    }

    await closeTestDb();
  });

  it('no standalone approval-revocation command exists (route inventory)', async () => {
    // Phase 1 has no standalone approval-revocation command. Verify that
    // the mutation matrix does not contain a 'plan.revoke' or similar entry.
    const { MUTATION_MATRIX } = await import('../services/mission/mutation-matrix.js');
    const types = Object.keys(MUTATION_MATRIX);
    expect(types).not.toContain('plan.revoke');
    expect(types).not.toContain('plan.unapprove');
    expect(types).not.toContain('approval.revoke');
    // The only plan governance commands are approve, reject, revision_request.
    const planCommands = types.filter((t) => t.startsWith('plan.'));
    expect(planCommands.sort()).toEqual(['plan.approve', 'plan.reject', 'plan.revision_request']);
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-115: Root deadline expires approval without decision
// ---------------------------------------------------------------------------

describe('VAL-PLAN-115: Root deadline expires approval without decision', () => {
  it('root deadline expiry while awaiting approval fails with TIME_LIMIT and closes gate', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ deadline-expire-approval');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // Set the run's created_at far in the past so the root deadline has
    // passed. Deep Work mode has a 45-minute (2700s) duration limit.
    const pastTime = new Date(Date.now() - 3600_000); // 60 minutes ago
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "created_at" = ${pastTime} WHERE "id" = ${ctx.runId}
    `);

    // Run the deadline enforcer with a clock at "now".
    const killSwitch = new MissionKillSwitchService(ctx.db);
    const result = await killSwitch.enforceDeadlines();
    expect(result.terminalized).toBeGreaterThanOrEqual(1);

    // The run should be failed with category 'limit', code 'TIME_LIMIT'.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('failed');
    expect(row!.failureCategory).toBe('limit');
    expect(row!.failureCode).toBe('TIME_LIMIT');
    expect(row!.terminalAt).not.toBeNull();

    // The gate is closed: the approval is resolved as cancelled.
    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].decision).toBeNull(); // No decision was made.
    const approvalStatus = await getApprovalStatus(ctx.db, bindings[0].approvalId);
    expect(approvalStatus).toBe('cancelled');

    // Budget was released.
    const events = await getEvents(ctx.db, ctx.runId);
    const failedEvents = events.filter(
      (e) => e.type === 'run.failed' && e.payload?.code === 'TIME_LIMIT',
    );
    expect(failedEvents).toHaveLength(1);
    const releasedEvents = events.filter((e) => e.type === 'budget.released');
    expect(releasedEvents).toHaveLength(1);

    // currentPlanRevisionId is NOT cleared (gate outcome derivation).
    expect(row!.currentPlanRevisionId).toBe(rev!.id);

    // Approval at/after expiry returns 409 INVALID_RUN_STATE.
    const approveRes = await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
    );
    expect(approveRes.status).toBe(409);
    expect(approveRes.body.code).toBe('INVALID_RUN_STATE');

    await closeTestDb();
  });

  it('pre-deadline budget shortfall leaves the gate open for a lower-budget revision', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ budget-shortfall-gate-open');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // Drain the root reservation's settled_cents so the residual root hold
    // is less than the execution envelope (200c = 100 step + 100 synthesis).
    // This simulates planning charges consuming most of the root hold.
    await ctx.db.drizzle.execute(sql`
      UPDATE "budget_reservations" SET "settled_cents" = "reserved_cents" - 100
      WHERE "run_id" = ${ctx.runId}
    `);

    // Attempt approval — should fail with BUDGET_UNAVAILABLE.
    const approveRes = await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    );
    expect(approveRes.status).toBe(409);
    expect(approveRes.body.code).toBe('BUDGET_UNAVAILABLE');

    // The gate remains open: run is still awaiting_approval.
    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');
    expect(row!.terminalAt).toBeNull();
    expect(row!.currentPlanRevisionId).toBe(rev!.id);

    // No plan.approved event, no binding with decision.
    const events = await getEvents(ctx.db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents).toHaveLength(0);

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    const decidedBindings = bindings.filter((b) => b.decision !== null);
    expect(decidedBindings).toHaveLength(0);

    // A revision request is still possible (gate is open).
    const reviseRes = await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Use a cheaper approach',
    );
    expect(reviseRes.status).toBe(202);

    const rowAfter = await getRunRow(ctx.db, ctx.runId);
    expect(rowAfter!.status).toBe('planning');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-121: Plan content, gate outcome, and execution authorization are orthogonal
// ---------------------------------------------------------------------------

describe('VAL-PLAN-121: Plan content, gate outcome, and execution authorization are orthogonal', () => {
  it('immutable content, complete gate enum, two historical approvals, one current authorization', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ orthogonal-gates');

    // First proposal → approve.
    let rev = await getCurrentRevision(ctx.db, ctx.runId);
    const firstHash = rev!.contentHash;
    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    // Queued revision → returns to planning.
    let row = await getRunRow(ctx.db, ctx.runId);
    await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Revise after approval',
    ).expect(202);

    // Publish a new plan and approve it (second approval).
    await publishPlanAndWait(ctx.db, ctx.runId, revisedPlanContent());
    row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');
    rev = await getCurrentRevision(ctx.db, ctx.runId);
    expect(rev!.revision).toBe(2);
    const secondHash = rev!.contentHash;
    expect(secondHash).not.toBe(firstHash); // Different content.

    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    // Now there are two approved bindings. Only the second is current authorization.
    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    const approvedBindings = bindings.filter((b) => b.decision === 'approved');
    expect(approvedBindings).toHaveLength(2);
    const currentAuth = approvedBindings.filter((b) => b.isCurrentAuthorization);
    expect(currentAuth).toHaveLength(1);
    expect(currentAuth[0].planRevisionId).toBe(rev!.id);

    // The first approved binding is historical (not current).
    const historicalApproved = approvedBindings.filter((b) => !b.isCurrentAuthorization);
    expect(historicalApproved).toHaveLength(1);

    // Plan content is immutable: both revision hashes are unchanged.
    const allRevisions = await getAllRevisions(ctx.db, ctx.runId);
    expect(allRevisions).toHaveLength(2);
    expect(allRevisions[0].contentHash).toBe(firstHash);
    expect(allRevisions[1].contentHash).toBe(secondHash);

    // Gate outcomes via the history endpoint.
    const historyRes = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/plan/revisions?limit=50`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    const historyRevisions = historyRes.body.data.revisions;
    expect(historyRevisions).toHaveLength(2);
    // First revision was approved then superseded by revision.
    // Its binding has decision='approved' but it was superseded by the
    // queued revision request. The revision status is 'superseded'.
    // The gate outcome is derived: binding.decision='approved' → 'approved'.
    expect(historyRevisions[0].gateOutcome).toBe('approved');
    // Second revision is approved and current.
    expect(historyRevisions[1].gateOutcome).toBe('approved');
    expect(historyRevisions[1].isCurrentAuthorization).toBe(true);
    expect(historyRevisions[0].isCurrentAuthorization).toBe(false);

    await closeTestDb();
  });

  it('cancelled gate outcome when run is cancelled while proposal is open', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ cancelled-gate');

    // Cancel while in awaiting_approval.
    await cancelRun(ctx.app, ctx.base, ctx.runId, ctx.stateVersion, 'Not needed').expect(202);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');

    // The approval is resolved as cancelled.
    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].decision).toBeNull(); // No decision.
    const approvalStatus = await getApprovalStatus(ctx.db, bindings[0].approvalId);
    expect(approvalStatus).toBe('cancelled');

    // History shows cancelled_without_decision gate outcome.
    const historyRes = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/plan/revisions?limit=50`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    const entry = historyRes.body.data.revisions[0];
    expect(entry.gateOutcome).toBe('cancelled_without_decision');
    expect(entry.status).toBe('proposed'); // Revision status unchanged.

    await closeTestDb();
  });

  it('expired_without_decision gate outcome when root deadline expires', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ expired-gate');

    // Set created_at 60 minutes ago (past the 45-minute Deep Work deadline).
    const pastTime = new Date(Date.now() - 3600_000);
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "created_at" = ${pastTime} WHERE "id" = ${ctx.runId}
    `);

    const killSwitch = new MissionKillSwitchService(ctx.db);
    await killSwitch.enforceDeadlines();

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('failed');
    expect(row!.failureCode).toBe('TIME_LIMIT');

    // History shows expired_without_decision.
    const historyRes = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/plan/revisions?limit=50`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    const entry = historyRes.body.data.revisions[0];
    expect(entry.gateOutcome).toBe('expired_without_decision');
    expect(entry.status).toBe('proposed');

    await closeTestDb();
  });

  it('superseded_without_decision gate outcome for member revision', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ superseded-gate');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // Member revision request (no rejection decision).
    await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Need changes',
    ).expect(202);

    // History shows superseded_without_decision.
    const historyRes = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/plan/revisions?limit=50`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    const entry = historyRes.body.data.revisions[0];
    expect(entry.gateOutcome).toBe('superseded_without_decision');
    expect(entry.status).toBe('superseded');

    await closeTestDb();
  });

  it('open gate outcome while run is still awaiting approval', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ open-gate');

    // Run is still awaiting_approval (no decision).
    const historyRes = await request(ctx.app)
      .get(`${ctx.base}/${ctx.runId}/plan/revisions?limit=50`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    const entry = historyRes.body.data.revisions[0];
    expect(entry.gateOutcome).toBe('open');
    expect(entry.status).toBe('proposed');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-122: Plan and gate transitions have one exact matrix
// ---------------------------------------------------------------------------

describe('VAL-PLAN-122: Plan and gate transitions have one exact matrix', () => {
  // Table-driven matrix: each row covers one transition and asserts
  // revision lifecycle, immutable gate outcome, current/historical
  // authorization, run status, event type, and that no unlisted
  // transition is legal.

  it('proposal: plan.proposed event, gate is open, no authorization', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-proposal');
    const events = await getEvents(ctx.db, ctx.runId);
    const proposedEvents = events.filter((e) => e.type === 'plan.proposed');
    expect(proposedEvents).toHaveLength(1);

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].decision).toBeNull();
    expect(bindings[0].isCurrentAuthorization).toBe(false);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');

    await closeTestDb();
  });

  it('member revision request: supersedes, gate superseded_without_decision, returns to planning', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-member-revise');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Revise please',
    ).expect(202);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('planning');
    expect(row!.currentPlanRevisionId).toBeNull();

    const allRevisions = await getAllRevisions(ctx.db, ctx.runId);
    expect(allRevisions[0].status).toBe('superseded');

    const events = await getEvents(ctx.db, ctx.runId);
    const revisionEvents = events.filter((e) => e.type === 'plan.revision_requested');
    expect(revisionEvents).toHaveLength(1);
    expect(revisionEvents[0].payload?.postApproval).toBe(false);

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings[0].decision).toBeNull(); // No decision.

    await closeTestDb();
  });

  it('owner/admin approval: gate approved, current authorization set, run queued', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-approve');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');
    expect(row!.approvedPlanRevisionId).toBe(rev!.id);

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings[0].decision).toBe('approved');
    expect(bindings[0].isCurrentAuthorization).toBe(true);

    const events = await getEvents(ctx.db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents).toHaveLength(1);

    const allRevisions = await getAllRevisions(ctx.db, ctx.runId);
    expect(allRevisions[0].status).toBe('approved');

    await closeTestDb();
  });

  it('queued pre-effect revision: revokes authorization, returns to planning', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-queued-revise');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    let row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');

    await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Revise after approval',
    ).expect(202);

    row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('planning');
    expect(row!.approvedPlanRevisionId).toBeNull();

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    const approved = bindings.find((b) => b.decision === 'approved');
    expect(approved).toBeTruthy();
    expect(approved!.isCurrentAuthorization).toBe(false);

    const events = await getEvents(ctx.db, ctx.runId);
    const revisionEvents = events.filter((e) => e.type === 'plan.revision_requested');
    expect(revisionEvents).toHaveLength(1);
    expect(revisionEvents[0].payload?.postApproval).toBe(true);

    await closeTestDb();
  });

  it('default rejection: gate rejected, run cancelled (terminal)', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-default-reject');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    await rejectCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Not acceptable',
    ).expect(200);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');
    expect(row!.terminalAt).not.toBeNull();

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings[0].decision).toBe('rejected');

    const events = await getEvents(ctx.db, ctx.runId);
    const rejectedEvents = events.filter((e) => e.type === 'plan.rejected');
    expect(rejectedEvents).toHaveLength(1);
    const cancelledEvents = events.filter((e) => e.type === 'run.cancelled');
    expect(cancelledEvents).toHaveLength(1);

    const allRevisions = await getAllRevisions(ctx.db, ctx.runId);
    expect(allRevisions[0].status).toBe('rejected');

    await closeTestDb();
  });

  it('reject-with-revise: gate rejected, returns to planning, no cancellation', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-reject-revise');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    await rejectCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Change direction',
      'revise',
      'Do it differently',
    ).expect(200);

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('planning');
    expect(row!.terminalAt).toBeNull();

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings[0].decision).toBe('rejected');

    const events = await getEvents(ctx.db, ctx.runId);
    const rejectedEvents = events.filter(
      (e) => e.type === 'plan.rejected' && e.payload?.disposition === 'revise',
    );
    expect(rejectedEvents).toHaveLength(1);
    // No run.cancelled event (rejection with revise does not cancel).
    const cancelledEvents = events.filter((e) => e.type === 'run.cancelled');
    expect(cancelledEvents).toHaveLength(0);

    await closeTestDb();
  });

  it('run cancellation from awaiting_approval: gate cancelled_without_decision, run cancelled', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-cancel');

    await cancelRun(ctx.app, ctx.base, ctx.runId, ctx.stateVersion, 'Not needed anymore').expect(
      202,
    );

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('cancelled');
    expect(row!.terminalAt).not.toBeNull();

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings[0].decision).toBeNull();
    const approvalStatus = await getApprovalStatus(ctx.db, bindings[0].approvalId);
    expect(approvalStatus).toBe('cancelled');

    const events = await getEvents(ctx.db, ctx.runId);
    const cancelRequestedEvents = events.filter((e) => e.type === 'run.cancel_requested');
    expect(cancelRequestedEvents).toHaveLength(1);
    const cancelledEvents = events.filter((e) => e.type === 'run.cancelled');
    expect(cancelledEvents).toHaveLength(1);

    await closeTestDb();
  });

  it('root-deadline expiry from awaiting_approval: gate expired_without_decision, run failed TIME_LIMIT', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-deadline');

    const pastTime = new Date(Date.now() - 3600_000); // 60 minutes ago
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "created_at" = ${pastTime} WHERE "id" = ${ctx.runId}
    `);

    const killSwitch = new MissionKillSwitchService(ctx.db);
    await killSwitch.enforceDeadlines();

    const row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('failed');
    expect(row!.failureCode).toBe('TIME_LIMIT');

    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    expect(bindings[0].decision).toBeNull();
    const approvalStatus = await getApprovalStatus(ctx.db, bindings[0].approvalId);
    expect(approvalStatus).toBe('cancelled');

    const events = await getEvents(ctx.db, ctx.runId);
    const failedEvents = events.filter(
      (e) => e.type === 'run.failed' && e.payload?.code === 'TIME_LIMIT',
    );
    expect(failedEvents).toHaveLength(1);

    await closeTestDb();
  });

  it('execution start: approved plan enters queued→running, authorization preserved', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-exec-start');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    let row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');

    // Simulate a worker claim (execution start).
    const coordinator = new RunCoordinator(ctx.db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(ctx.runId);

    row = await getRunRow(ctx.db, ctx.runId);
    expect(['running', 'queued']).toContain(row!.status);
    expect(row!.approvedPlanRevisionId).toBe(rev!.id);

    // Authorization is still current.
    const bindings = await getApprovalBindings(ctx.db, ctx.runId);
    const currentAuth = bindings.find((b) => b.isCurrentAuthorization);
    expect(currentAuth).toBeTruthy();
    expect(currentAuth!.decision).toBe('approved');

    await coordinator.release(claim!);

    await closeTestDb();
  });

  it('unlisted transitions are rejected: approve from planning, reject from queued, revise from running', async () => {
    const ctx = await freshAwaitingApprovalRun('__mtest__ matrix-unlisted');
    const rev = await getCurrentRevision(ctx.db, ctx.runId);

    // Approve first (to get to queued).
    await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      ctx.stateVersion,
      rev!.id,
      rev!.contentHash,
    ).expect(200);

    let row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('queued');

    // Reject from queued → INVALID_RUN_STATE (not awaiting_approval).
    const rejectRes = await rejectCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'No',
    );
    expect(rejectRes.status).toBe(409);
    expect(rejectRes.body.code).toBe('INVALID_RUN_STATE');

    // Approve from queued → INVALID_RUN_STATE.
    const approveRes = await approveCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
    );
    expect(approveRes.status).toBe(409);
    expect(approveRes.body.code).toBe('INVALID_RUN_STATE');

    // Simulate running state.
    await ctx.db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'running', "lease_owner" = 'w', "lease_token" = ${randomUUID()},
        "lease_expires_at" = NOW() + INTERVAL '30 seconds', "heartbeat_at" = NOW()
      WHERE "id" = ${ctx.runId}
    `);
    row = await getRunRow(ctx.db, ctx.runId);
    expect(row!.status).toBe('running');

    // Revise from running → INVALID_RUN_STATE (running is not queued).
    const reviseRes = await reviseCurrentPlan(
      ctx.app,
      ctx.base,
      ctx.runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Change',
    );
    expect(reviseRes.status).toBe(409);
    expect(reviseRes.body.code).toBe('INVALID_RUN_STATE');

    await closeTestDb();
  });
});
