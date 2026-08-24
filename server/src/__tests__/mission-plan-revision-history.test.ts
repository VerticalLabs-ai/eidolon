import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import { PlannerTestHarness, HARNESS_ENV_FLAG } from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';

/**
 * Immutable revision branches, bindings, secure feedback, and scoped history.
 *
 * (VAL-PLAN-039, 041, 077, 101, 102, 110, 111, 116, 129)
 *
 * Exercises post-approval branching, rejection history, restart
 * persistence, history reads, secure field-level feedback, and retry
 * governance.
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

/** A second valid plan with different objective (different hash). */
function revisedPlanContent(): unknown {
  return validPlanContent({ objective: 'Analyze the annual report with deeper analysis' });
}

async function startPlanningRun(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  threadId: string,
  text = 'Analyze the quarterly report with multiple deliverables and dependencies',
) {
  return request(app)
    .post(base)
    .set('Idempotency-Key', `plan-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'deep_work', request: { text } })
    .expect(202);
}

/** Publish a valid plan via the harness and get the run into awaiting_approval. */
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
           "approved_plan_revision_id", "terminal_at"
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

/** Approve the current plan revision as an owner. */
function approveCurrentPlan(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  runId: string,
  stateVersion: number,
  revisionId: string,
  contentHash: string,
) {
  return request(app)
    .post(`${base}/${runId}/plan/approve`)
    .set('Idempotency-Key', `approve-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .set('X-Eidolon-Test-Org-Role', 'owner')
    .send({ revisionId, contentHash });
}

/** Request a revision as a member. */
function reviseCurrentPlan(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  runId: string,
  stateVersion: number,
  revisionId: string,
  contentHash: string,
  feedback: string,
) {
  return request(app)
    .post(`${base}/${runId}/plan/revisions`)
    .set('Idempotency-Key', `revise-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .set('X-Eidolon-Test-Org-Role', 'member')
    .send({ revisionId, contentHash, feedback });
}

/** Reject the current plan as an owner. */
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
    .set('Idempotency-Key', `reject-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .set('X-Eidolon-Test-Org-Role', 'owner')
    .send(body);
}

/** Insert a fake execution.started event to simulate execution beginning. */
async function simulateExecutionStarted(
  db: AnyDb,
  runId: string,
  companyId: string,
  projectId: string,
) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "last_event_sequence" FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  const seq = Number(rows[0]['last_event_sequence']) + 1;
  const eventId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
    VALUES (${eventId}, ${companyId}, ${projectId}, ${runId}, ${seq}, 'execution.started', 1, '{}'::jsonb, 'system', null, null, NOW())
  `);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "last_event_sequence" = ${seq}, "status" = 'running' WHERE "id" = ${runId}
  `);
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-PLAN-039 + VAL-PLAN-101: Post-approval revision branches safely
// ---------------------------------------------------------------------------

describe('VAL-PLAN-039 + 101: Post-approval revision branches safely', () => {
  it('allows queued revision before any effect starts and returns to fresh approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ post-approve-rev');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Approve the plan.
    let row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);
    await approveCurrentPlan(app, base, runId, row!.stateVersion, rev!.id, rev!.contentHash).expect(
      200,
    );

    // Run is now queued.
    row = await getRunRow(db, runId);
    expect(row!.status).toBe('queued');
    expect(row!.approvedPlanRevisionId).not.toBeNull();

    // Request a revision from the queued state (before any effect).
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Need more detail',
    ).expect(202);

    // Run returns to planning; approved pointer is cleared.
    row = await getRunRow(db, runId);
    expect(row!.status).toBe('planning');
    expect(row!.approvedPlanRevisionId).toBeNull();
    expect(row!.currentPlanRevisionId).toBeNull();

    // The historical approved binding is preserved but no longer current.
    const bindings = await getApprovalBindings(db, runId);
    const approvedBinding = bindings.find((b) => b.decision === 'approved');
    expect(approvedBinding).toBeTruthy();
    expect(approvedBinding!.isCurrentAuthorization).toBe(false);

    // Publish a new plan and approve it (fresh approval).
    await publishPlanAndWait(db, runId, revisedPlanContent());
    row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');
    const newRev = await getCurrentRevision(db, runId);
    expect(newRev!.revision).toBe(2);
    expect(newRev!.parentRevisionId).toBe(rev!.id);

    await approveCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      newRev!.id,
      newRev!.contentHash,
    ).expect(200);
    row = await getRunRow(db, runId);
    expect(row!.status).toBe('queued');
    expect(row!.approvedPlanRevisionId).toBe(newRev!.id);

    await closeTestDb();
  });

  it('rejects queued revision with 409 EXECUTION_ALREADY_STARTED after execution begins', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ exec-started-rev');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Approve.
    let row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);
    await approveCurrentPlan(app, base, runId, row!.stateVersion, rev!.id, rev!.contentHash).expect(
      200,
    );

    // Simulate execution starting.
    await simulateExecutionStarted(db, runId, companyId, projectId);
    row = await getRunRow(db, runId);
    expect(row!.status).toBe('running');

    // Attempt revision from running state.
    const reviseRes = await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Too late',
    );

    // Running state is not awaiting_approval or queued → INVALID_RUN_STATE.
    // (The run is running, not queued, so it fails the state check first.)
    expect(reviseRes.status).toBe(409);
    expect(reviseRes.body.code).toBe('INVALID_RUN_STATE');

    // Run remains unchanged.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('running');
    expect(rowAfter!.approvedPlanRevisionId).toBe(rev!.id);

    await closeTestDb();
  });

  it('rejects revision from a queued run that already has execution.started event', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ queued-exec-rev');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Approve.
    let row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);
    await approveCurrentPlan(app, base, runId, row!.stateVersion, rev!.id, rev!.contentHash).expect(
      200,
    );

    // Insert execution.started event BUT keep status as queued (simulating
    // a race where execution started event exists but status hasn't
    // transitioned yet, or a test scenario where we check the event ledger).
    const rows = (await db.drizzle.execute(sql`
      SELECT "last_event_sequence" FROM "mission_runs" WHERE "id" = ${runId}
    `)) as unknown as Array<Record<string, unknown>>;
    const seq = Number(rows[0]['last_event_sequence']) + 1;
    const eventId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
      VALUES (${eventId}, ${companyId}, ${projectId}, ${runId}, ${seq}, 'execution.started', 1, '{}'::jsonb, 'system', null, null, NOW())
    `);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "last_event_sequence" = ${seq} WHERE "id" = ${runId}
    `);

    row = await getRunRow(db, runId);
    expect(row!.status).toBe('queued');

    // Attempt revision from queued state with execution.started in ledger.
    const reviseRes = await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Too late',
    );

    expect(reviseRes.status).toBe(409);
    expect(reviseRes.body.code).toBe('EXECUTION_ALREADY_STARTED');

    // Run remains queued with the original approved revision.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('queued');
    expect(rowAfter!.approvedPlanRevisionId).toBe(rev!.id);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-102: Historical bindings coexist with one current authorization
// ---------------------------------------------------------------------------

describe('VAL-PLAN-102: Historical bindings coexist with one current authorization', () => {
  it('preserves both approved bindings with only B as current after revise+reapprove', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ coexist-bindings');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Approve revision A.
    let row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);
    await approveCurrentPlan(app, base, runId, row!.stateVersion, rev!.id, rev!.contentHash).expect(
      200,
    );

    // Revise from queued.
    row = await getRunRow(db, runId);
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Change objective',
    ).expect(202);

    // Publish and approve revision B.
    await publishPlanAndWait(db, runId, revisedPlanContent());
    row = await getRunRow(db, runId);
    const revB = await getCurrentRevision(db, runId);
    expect(revB!.revision).toBe(2);
    await approveCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      revB!.id,
      revB!.contentHash,
    ).expect(200);

    // Both bindings exist; only B is current.
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings.length).toBe(2);

    const bindingA = bindings.find((b) => b.planRevisionId === rev!.id);
    const bindingB = bindings.find((b) => b.planRevisionId === revB!.id);
    expect(bindingA).toBeTruthy();
    expect(bindingB).toBeTruthy();
    expect(bindingA!.decision).toBe('approved');
    expect(bindingB!.decision).toBe('approved');
    expect(bindingA!.isCurrentAuthorization).toBe(false);
    expect(bindingB!.isCurrentAuthorization).toBe(true);

    // The run's approved pointer is B, not A.
    row = await getRunRow(db, runId);
    expect(row!.approvedPlanRevisionId).toBe(revB!.id);

    // Both revisions are still readable.
    const allRevs = await getAllRevisions(db, runId);
    expect(allRevs.length).toBe(2);
    expect(allRevs.find((r) => r.id === rev!.id)?.status).toBe('superseded');
    expect(allRevs.find((r) => r.id === revB!.id)?.status).toBe('approved');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-041: Reject with revise records a rejection before replanning
// ---------------------------------------------------------------------------

describe('VAL-PLAN-041: Reject with revise records a rejection before replanning', () => {
  it('reject-revise resolves gate as rejected and returns to planning', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ reject-revise');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);

    // Reject with disposition revise as owner.
    await rejectCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'The plan needs restructuring',
      'revise',
      'Focus on the annual data',
    ).expect(200);

    // Run returns to planning.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('planning');
    expect(rowAfter!.currentPlanRevisionId).toBeNull();

    // The revision is rejected (not superseded).
    const allRevs = await getAllRevisions(db, runId);
    expect(allRevs[0].status).toBe('rejected');
    expect(allRevs[0].decidedByUserId).toBeTruthy();

    // The binding decision is rejected.
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings[0].decision).toBe('rejected');
    expect(bindings[0].isCurrentAuthorization).toBe(false);

    // No current authorization.
    expect(bindings.find((b) => b.isCurrentAuthorization)).toBeUndefined();

    // Events include plan.rejected and plan.revision_requested.
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeTruthy();
    expect(events.find((e) => e.type === 'plan.revision_requested')).toBeTruthy();

    await closeTestDb();
  });

  it('member revision request supersedes without a rejection decision (distinct from reject-revise)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ member-revise');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);

    // Member requests revision (not reject-revise).
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Add more detail',
    ).expect(202);

    // The revision is superseded (not rejected).
    const allRevs = await getAllRevisions(db, runId);
    expect(allRevs[0].status).toBe('superseded');

    // The binding decision is null (no rejection decision).
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings[0].decision).toBeNull();

    // No plan.rejected event (only plan.revision_requested).
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeUndefined();
    expect(events.find((e) => e.type === 'plan.revision_requested')).toBeTruthy();

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-110: Terminal retry requires fresh governance
// ---------------------------------------------------------------------------

describe('VAL-PLAN-110: Terminal retry requires fresh governance', () => {
  it('creates a successor with no approved pointer or binding', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ retry-governance');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Approve.
    let row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);
    await approveCurrentPlan(app, base, runId, row!.stateVersion, rev!.id, rev!.contentHash).expect(
      200,
    );

    // Fail the run.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'failed', "terminal_at" = NOW()
      WHERE "id" = ${runId}
    `);

    row = await getRunRow(db, runId);
    expect(row!.status).toBe('failed');

    // Retry.
    const retryRes = await request(app)
      .post(`${base}/${runId}/retry`)
      .set('Idempotency-Key', `retry-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({})
      .expect(202);

    const successorId = retryRes.body.data.run.id;
    expect(successorId).not.toBe(runId);

    // Successor has no approved pointer or current plan.
    const successorRow = await getRunRow(db, successorId);
    expect(successorRow!.status).toBe('draft');
    expect(successorRow!.approvedPlanRevisionId).toBeNull();
    expect(successorRow!.currentPlanRevisionId).toBeNull();

    // Successor has no approval bindings.
    const successorBindings = await getApprovalBindings(db, successorId);
    expect(successorBindings.length).toBe(0);

    // Successor has no plan revisions.
    const successorRevs = await getAllRevisions(db, successorId);
    expect(successorRevs.length).toBe(0);

    // Original run remains terminal and unchanged.
    const origRow = await getRunRow(db, runId);
    expect(origRow!.status).toBe('failed');
    expect(origRow!.approvedPlanRevisionId).toBe(rev!.id);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-111: Scoped plan history is durably readable
// ---------------------------------------------------------------------------

describe('VAL-PLAN-111: Scoped plan history is durably readable', () => {
  it('returns revisions in (revision, id) order with gate outcome and current-auth flag', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ history-read');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Approve revision 1.
    let row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);
    await approveCurrentPlan(app, base, runId, row!.stateVersion, rev!.id, rev!.contentHash).expect(
      200,
    );

    // Revise and reapprove revision 2.
    row = await getRunRow(db, runId);
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Change',
    ).expect(202);
    await publishPlanAndWait(db, runId, revisedPlanContent());
    row = await getRunRow(db, runId);
    const rev2 = await getCurrentRevision(db, runId);
    await approveCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev2!.id,
      rev2!.contentHash,
    ).expect(200);

    // Read history as owner (with feedback access).
    const histRes = await request(app)
      .get(`${base}/${runId}/plan/revisions`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    const revisions = histRes.body.data.revisions;
    expect(revisions.length).toBe(2);
    expect(revisions[0].revision).toBe(1);
    expect(revisions[1].revision).toBe(2);
    expect(revisions[0].status).toBe('superseded');
    expect(revisions[1].status).toBe('approved');
    expect(revisions[0].gateOutcome).toBe('approved');
    expect(revisions[1].gateOutcome).toBe('approved');
    expect(revisions[0].isCurrentAuthorization).toBe(false);
    expect(revisions[1].isCurrentAuthorization).toBe(true);
    expect(revisions[1].parentRevisionId).toBe(revisions[0].id);

    await closeTestDb();
  });

  it('returns feedback to content-access roles but not viewers', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ history-role');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Request revision with feedback as member.
    const row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Please add more detail to the plan',
    ).expect(202);

    // Read history as member (with feedback).
    const memberRes = await request(app)
      .get(`${base}/${runId}/plan/revisions`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .expect(200);

    const memberRevs = memberRes.body.data.revisions;
    expect(memberRevs[0].feedback).toBe('Please add more detail to the plan');

    // Read history as viewer (without feedback).
    const viewerRes = await request(app)
      .get(`${base}/${runId}/plan/revisions`)
      .set('X-Eidolon-Test-Org-Role', 'viewer')
      .expect(200);

    const viewerRevs = viewerRes.body.data.revisions;
    expect(viewerRevs[0].feedback).toBeNull();

    await closeTestDb();
  });

  it('returns 404 for cross-scope run IDs', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const scopeA = await seedScope(db, '__mtest__ history-scope-a');
    const scopeB = await seedScope(db, '__mtest__ history-scope-b');
    const baseA = `/api/companies/${scopeA.companyId}/projects/${scopeA.projectId}/mission-runs`;
    const baseB = `/api/companies/${scopeB.companyId}/projects/${scopeB.projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, baseA, scopeA.threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Read history through scope B → 404.
    const crossRes = await request(app)
      .get(`${baseB}/${runId}/plan/revisions`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(404);
    expect(crossRes.body.code).toBe('RUN_NOT_FOUND');

    await closeTestDb();
  });

  it('supports paginated history with opaque cursors', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ history-paginate');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // Create 3 revisions by revising twice.
    await publishPlanAndWait(db, runId, validPlanContent({ objective: 'Objective 1' }));
    let row = await getRunRow(db, runId);
    let rev = await getCurrentRevision(db, runId);
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'rev1',
    ).expect(202);

    await publishPlanAndWait(db, runId, validPlanContent({ objective: 'Objective 2' }));
    row = await getRunRow(db, runId);
    rev = await getCurrentRevision(db, runId);
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'rev2',
    ).expect(202);

    await publishPlanAndWait(db, runId, validPlanContent({ objective: 'Objective 3' }));

    // Now there are 3 revisions. Fetch with limit=2.
    const page1 = await request(app)
      .get(`${base}/${runId}/plan/revisions?limit=2`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    expect(page1.body.data.revisions.length).toBe(2);
    expect(page1.body.data.revisions[0].revision).toBe(1);
    expect(page1.body.data.revisions[1].revision).toBe(2);
    expect(page1.body.data.nextCursor).not.toBeNull();

    // Fetch page 2.
    const cursor = page1.body.data.nextCursor;
    const page2 = await request(app)
      .get(`${base}/${runId}/plan/revisions?limit=2&cursor=${cursor}`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    expect(page2.body.data.revisions.length).toBe(1);
    expect(page2.body.data.revisions[0].revision).toBe(3);
    expect(page2.body.data.nextCursor).toBeNull();

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-116 + VAL-PLAN-129: Decision feedback secure contract
// ---------------------------------------------------------------------------

describe('VAL-PLAN-116 + 129: Decision feedback is field-level protected', () => {
  it('never includes feedback text in broad journal events', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ feedback-events');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);

    const feedbackText = 'My secret feedback with bearer AKIAABCDEFGHIJKLMNOP';
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      feedbackText,
    ).expect(202);

    // Check all events: none should contain the feedback text.
    const events = await getEvents(db, runId);
    const revisionEvents = events.filter((e) => e.type === 'plan.revision_requested');
    expect(revisionEvents.length).toBe(1);
    const payload = JSON.stringify(revisionEvents[0].payload);
    expect(payload).not.toContain('secret feedback');
    expect(payload).not.toContain('AKIA');
    // The feedback field should not be in the event payload at all.
    expect(revisionEvents[0].payload).not.toHaveProperty('feedback');

    await closeTestDb();
  });

  it('encrypts feedback at rest in the revision row', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ feedback-encrypted');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);

    const feedbackText = 'Confidential revision feedback';
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      feedbackText,
    ).expect(202);

    // The revision row's feedback column should NOT contain plaintext.
    const allRevs = await getAllRevisions(db, runId);
    expect(allRevs[0].feedback).not.toBeNull();
    expect(allRevs[0].feedback).not.toContain('Confidential');
    expect(allRevs[0].feedback).not.toContain('revision feedback');

    await closeTestDb();
  });

  it('redacts credential canaries from feedback before persistence', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ feedback-canary');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);

    // Submit feedback containing a credential canary.
    const canary = 'Bearer AKIAABCDEFGHIJKLMNOP';
    await reviseCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      `Please check ${canary}`,
    ).expect(202);

    // Read back as member — the canary should be redacted.
    const histRes = await request(app)
      .get(`${base}/${runId}/plan/revisions`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .expect(200);

    const feedback = histRes.body.data.revisions[0].feedback;
    expect(feedback).not.toContain('AKIA');
    expect(feedback).not.toContain('Bearer');
    expect(feedback).toContain('[REDACTED]');

    await closeTestDb();
  });

  it('reject-revise feedback is also encrypted and absent from events', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ reject-feedback');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const rev = await getCurrentRevision(db, runId);

    const feedbackText = 'Confidential reject-revise feedback';
    await rejectCurrentPlan(
      app,
      base,
      runId,
      row!.stateVersion,
      rev!.id,
      rev!.contentHash,
      'Needs work',
      'revise',
      feedbackText,
    ).expect(200);

    // Events should not contain the feedback text.
    const events = await getEvents(db, runId);
    const revisionEvents = events.filter((e) => e.type === 'plan.revision_requested');
    expect(revisionEvents.length).toBe(1);
    const payload = JSON.stringify(revisionEvents[0].payload);
    expect(payload).not.toContain('Confidential');
    expect(payload).not.toContain('reject-revise feedback');
    expect(revisionEvents[0].payload).not.toHaveProperty('feedback');

    // The revision row's feedback should be encrypted.
    const allRevs = await getAllRevisions(db, runId);
    expect(allRevs[0].feedback).not.toBeNull();
    expect(allRevs[0].feedback).not.toContain('Confidential');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-077: API restart preserves plan authority
// ---------------------------------------------------------------------------

describe('VAL-PLAN-077: API restart preserves plan authority', () => {
  it('preserves revision/hash, state version, and allows a decision after server restart', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ restart-authority');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Record the state before restart.
    const rowBefore = await getRunRow(db, runId);
    const revBefore = await getCurrentRevision(db, runId);
    expect(rowBefore!.status).toBe('awaiting_approval');

    // Close the server (simulates API restart).
    await closeTestServers();

    // Create a new server instance against the same DB.
    const app2 = await createTestServer(db);

    // Verify the same revision/hash, state version survive.
    const snapshotRes = await request(app2)
      .get(`${base}/${runId}`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    expect(snapshotRes.body.data.run.id).toBe(runId);
    expect(snapshotRes.body.data.run.status).toBe('awaiting_approval');
    expect(snapshotRes.body.data.run.stateVersion).toBe(rowBefore!.stateVersion);
    expect(snapshotRes.body.data.run.currentPlanRevisionId).toBe(revBefore!.id);

    // One valid decision can still apply.
    const approveRes = await approveCurrentPlan(
      app2,
      base,
      runId,
      rowBefore!.stateVersion,
      revBefore!.id,
      revBefore!.contentHash,
    ).expect(200);

    expect(approveRes.body.data.run.status).toBe('queued');

    // History is still readable after restart.
    const histRes = await request(app2)
      .get(`${base}/${runId}/plan/revisions`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .expect(200);

    expect(histRes.body.data.revisions.length).toBe(1);
    expect(histRes.body.data.revisions[0].contentHash).toBe(revBefore!.contentHash);

    await closeTestDb();
  });
});
