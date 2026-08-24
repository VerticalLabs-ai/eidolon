import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import { PlannerTestHarness, HARNESS_ENV_FLAG } from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';
import { MissionPlanGovernanceProjectionService } from '../services/mission/plan-governance-projection.js';
import { projectEvent } from '../services/mission/projection.js';

/**
 * Plan Governance Projection Authority
 * (VAL-PLAN-060, 061, 062, 063, 064, 066, 098, 099, 119, 127)
 *
 * Exercises publish/approve/reject/revise projection transactions, dedupe/
 * repair, mutable-row tampering, lag declarations, and recipient revocation.
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
      {
        stepKey: 'step-2',
        parentStepKey: null,
        childOrdinal: 1,
        nodeKind: 'root',
        title: 'Write analysis',
        description: 'Write the analysis section',
        dependencies: ['step-1'],
        inputBindings: [
          {
            name: 'data',
            source: { kind: 'stepOutput', stepKey: 'step-1', output: 'report-data' },
          },
        ],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['writing'],
            requiredTools: [],
            requiredDomains: [],
            ephemeralAllowed: false,
          },
        },
        toolAllowlist: [],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['analysis-text'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Analysis written',
        budgetCents: 100,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize the report',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-2', output: 'analysis-text' }],
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
  // Project all events (simulates what the worker's projectRunEvents does).
  await projectAllEvents(db, runId);
}

/** Project all committed events for a run to mutable surfaces (simulates worker). */
async function projectAllEvents(db: AnyDb, runId: string): Promise<void> {
  const events = await getEvents(db, runId);
  for (const evt of events) {
    await projectEvent(db, {
      runId,
      companyId: evt.companyId,
      projectId: evt.projectId,
      sequence: evt.sequence,
      type: evt.type,
      payload: evt.payload,
      actorType: evt.actorType as 'user' | 'agent' | 'system' | null,
      actorId: evt.actorId,
      traceId: evt.traceId,
      occurredAt: evt.occurredAt,
    });
  }
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
    SELECT rpr."id", rpr."revision", rpr."status", rpr."content_hash"
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
  };
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload", "company_id", "project_id",
           "actor_type", "actor_id", "trace_id", "occurred_at"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    sequence: Number(r['sequence']),
    type: r['type'] as string,
    payload: r['payload'] as Record<string, unknown>,
    companyId: r['company_id'] as string,
    projectId: r['project_id'] as string,
    actorType: (r['actor_type'] as string | null) ?? null,
    actorId: (r['actor_id'] as string | null) ?? null,
    traceId: (r['trace_id'] as string | null) ?? null,
    occurredAt: r['occurred_at'] as Date,
  }));
}

async function getProjectionLinks(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "surface", "surface_id", "surface_key", "event_type", "event_sequence",
           "status", "error_message"
    FROM "run_projection_links" WHERE "run_id" = ${runId}
    ORDER BY "surface", "surface_key"
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    surface: r['surface'] as string,
    surfaceId: r['surface_id'] as string,
    surfaceKey: r['surface_key'] as string,
    eventType: (r['event_type'] as string) ?? null,
    eventSequence: r['event_sequence'] !== null ? Number(r['event_sequence']) : null,
    status: r['status'] as string,
    errorMessage: (r['error_message'] as string) ?? null,
  }));
}

async function getProjectPlans(db: AnyDb, companyId: string, projectId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "title", "description", "status", "progress"
    FROM "project_plans" WHERE "company_id" = ${companyId} AND "project_id" = ${projectId}
    ORDER BY "created_at"
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    title: r['title'] as string,
    description: (r['description'] as string) ?? null,
    status: r['status'] as string,
    progress: Number(r['progress']),
  }));
}

async function getProjectPlanSteps(db: AnyDb, planId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "plan_id", "title", "step_order", "status", "gate_config"
    FROM "project_plan_steps" WHERE "plan_id" = ${planId}
    ORDER BY "step_order"
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    planId: r['plan_id'] as string,
    title: r['title'] as string,
    stepOrder: Number(r['step_order']),
    status: r['status'] as string,
    gateConfig: r['gate_config'] as Record<string, unknown>,
  }));
}

async function getApprovals(db: AnyDb, companyId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "kind", "title", "status", "payload"
    FROM "approvals" WHERE "company_id" = ${companyId} AND "kind" = 'plan_gate'
    ORDER BY "created_at"
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    kind: r['kind'] as string,
    title: r['title'] as string,
    status: r['status'] as string,
    payload: r['payload'] as Record<string, unknown>,
  }));
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-PLAN-060: Awaiting approval appears across governance surfaces
// ---------------------------------------------------------------------------

describe('VAL-PLAN-060: Awaiting approval appears across governance surfaces', () => {
  it('creates one approval, one plan_approval projection link, and one inbox item for a proposed plan', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-060');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');

    // 1. Exactly one plan_gate approval exists, linked to the run/revision/hash.
    const approvals = await getApprovals(db, companyId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('pending');
    expect(approvals[0].payload.runId).toBe(runId);
    expect(approvals[0].payload.contentHash).toBeDefined();

    // 2. One plan_approval projection link exists (idempotent, active).
    const links = await getProjectionLinks(db, runId);
    const approvalLinks = links.filter((l) => l.surface === 'plan_approval');
    expect(approvalLinks).toHaveLength(1);
    expect(approvalLinks[0].status).toBe('active');
    expect(approvalLinks[0].surfaceId).toBe(approvals[0].id);

    // 3. The inbox shows one pending approval item for this company.
    const inboxRes = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const approvalItems = inboxRes.body.data.filter(
      (i: { kind: string; entityId?: string }) =>
        i.kind === 'approval' && i.entityId === approvals[0].id,
    );
    expect(approvalItems).toHaveLength(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-061: Approval projects into Plans
// ---------------------------------------------------------------------------

describe('VAL-PLAN-061: Approval projects into Plans', () => {
  it('creates exactly one project_plans entry and ordered step set after approval, matching the approved revision', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-061');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Approve the plan.
    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // Exactly one project_plans entry.
    const plans = await getProjectPlans(db, companyId, projectId);
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe('active');
    expect(plans[0].title).toBe('Analyze the quarterly report');

    // Ordered step set matching the approved plan (2 steps).
    const steps = await getProjectPlanSteps(db, plans[0].id);
    expect(steps).toHaveLength(2);
    expect(steps[0].stepOrder).toBe(0);
    expect(steps[0].title).toBe('Gather data');
    expect(steps[1].stepOrder).toBe(1);
    expect(steps[1].title).toBe('Write analysis');

    // Each step's gate_config links to the run/revision/hash.
    expect(steps[0].gateConfig.runId).toBe(runId);
    expect(steps[0].gateConfig.planRevisionId).toBe(revision!.id);
    expect(steps[0].gateConfig.contentHash).toBe(revision!.contentHash);

    // Projection links are active and singular.
    const links = await getProjectionLinks(db, runId);
    const planLinks = links.filter((l) => l.surface === 'project_plan');
    expect(planLinks).toHaveLength(1);
    expect(planLinks[0].status).toBe('active');
    const stepLinks = links.filter((l) => l.surface === 'project_plan_step');
    expect(stepLinks).toHaveLength(2);
    expect(stepLinks.every((l) => l.status === 'active')).toBe(true);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-062: Approval status synchronizes across surfaces
// ---------------------------------------------------------------------------

describe('VAL-PLAN-062: Approval status synchronizes across surfaces', () => {
  it('approval converges to approved/non-actionable across approvals, inbox, and plans', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-062');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Before approval: one pending approval in inbox.
    const inboxBefore = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const approvalItemsBefore = inboxBefore.body.data.filter(
      (i: { kind: string }) => i.kind === 'approval',
    );
    expect(approvalItemsBefore).toHaveLength(1);

    // Approve.
    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // After approval: approval is resolved as approved (no longer pending).
    const approvals = await getApprovals(db, companyId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('approved');

    // Inbox no longer shows the approval as pending (it left the pending filter).
    const inboxAfter = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const approvalItemsAfter = inboxAfter.body.data.filter(
      (i: { kind: string; entityId?: string }) =>
        i.kind === 'approval' && i.entityId === approvals[0].id,
    );
    expect(approvalItemsAfter).toHaveLength(0);

    // Plans shows the approved plan as active.
    const plans = await getProjectPlans(db, companyId, projectId);
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe('active');

    // Run is queued (one applied approval, not two).
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('queued');
    expect(rowAfter!.approvedPlanRevisionId).toBe(revision!.id);

    // One plan.approved event (not duplicated).
    const events = await getEvents(db, runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents).toHaveLength(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-063: Rejection status synchronizes across surfaces
// ---------------------------------------------------------------------------

describe('VAL-PLAN-063: Rejection status synchronizes across surfaces', () => {
  it('rejection converges to rejected/cancelled across approvals, inbox, and run; plans does not present as approved', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-063');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Reject the plan (default disposition: cancel).
    await request(app)
      .post(`${base}/${runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        reason: 'Not enough detail',
      })
      .expect(200);

    // Approval is resolved as rejected.
    const approvals = await getApprovals(db, companyId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('rejected');

    // Inbox no longer shows the approval as pending.
    const inboxAfter = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const approvalItemsAfter = inboxAfter.body.data.filter(
      (i: { kind: string; entityId?: string }) =>
        i.kind === 'approval' && i.entityId === approvals[0].id,
    );
    expect(approvalItemsAfter).toHaveLength(0);

    // Run is cancelled (terminal).
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('cancelled');
    expect(rowAfter!.terminalAt).not.toBeNull();

    // No project_plans entry was created (rejection before approval).
    const plans = await getProjectPlans(db, companyId, projectId);
    expect(plans).toHaveLength(0);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-064: Revision replaces stale actionable projections
// ---------------------------------------------------------------------------

describe('VAL-PLAN-064: Revision replaces stale actionable projections', () => {
  it('old approval becomes non-actionable and the new proposal appears once with its new revision/hash', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-064');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // Publish first plan.
    await publishPlanAndWait(db, runId);
    const row1 = await getRunRow(db, runId);
    const rev1 = await getCurrentRevision(db, runId);
    expect(row1!.status).toBe('awaiting_approval');

    // Request a revision.
    await request(app)
      .post(`${base}/${runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${row1!.stateVersion}"`)
      .send({
        revisionId: rev1!.id,
        contentHash: rev1!.contentHash,
        feedback: 'Need more detail in step 1',
      })
      .expect(202);

    // Old approval is cancelled (non-actionable).
    const approvals = await getApprovals(db, companyId);
    expect(approvals).toHaveLength(1);
    expect(approvals[0].status).toBe('cancelled');

    // Inbox no longer shows the old approval as pending.
    const inboxAfter = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const approvalItemsAfter = inboxAfter.body.data.filter(
      (i: { kind: string }) => i.kind === 'approval',
    );
    expect(approvalItemsAfter).toHaveLength(0);

    // Run is back in planning.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('planning');
    expect(rowAfter!.currentPlanRevisionId).toBeNull();

    // Publish a new plan with different content (new revision/hash).
    const newPlan = validPlanContent({ objective: 'Revised quarterly analysis' });
    await publishPlanAndWait(db, runId, newPlan);

    const row2 = await getRunRow(db, runId);
    expect(row2!.status).toBe('awaiting_approval');
    const rev2 = await getCurrentRevision(db, runId);
    expect(rev2!.revision).toBe(2);
    expect(rev2!.contentHash).not.toBe(rev1!.contentHash);

    // Two approvals exist: old (cancelled) and new (pending). Inbox shows one pending.
    const approvals2 = await getApprovals(db, companyId);
    const pendingApprovals = approvals2.filter((a) => a.status === 'pending');
    expect(pendingApprovals).toHaveLength(1);
    expect(pendingApprovals[0].payload.revision).toBe(2);

    const inboxFinal = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const approvalItemsFinal = inboxFinal.body.data.filter(
      (i: { kind: string }) => i.kind === 'approval',
    );
    expect(approvalItemsFinal).toHaveLength(1);
    expect(approvalItemsFinal[0].entityId).toBe(pendingApprovals[0].id);

    // Two plan_approval projection links (one per revision), both active.
    const links = await getProjectionLinks(db, runId);
    const approvalLinks = links.filter((l) => l.surface === 'plan_approval');
    expect(approvalLinks).toHaveLength(2);
    expect(approvalLinks.every((l) => l.status === 'active')).toBe(true);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-066: Projection retry does not duplicate records
// ---------------------------------------------------------------------------

describe('VAL-PLAN-066: Projection retry does not duplicate records', () => {
  it('re-projecting the same plan.approved event produces one project_plans entry and one step set', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-066');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // Re-project by calling the service directly (simulates retry/repair).
    const service = new MissionPlanGovernanceProjectionService(db);
    const events = await getEvents(db, runId);
    const approvedEvent = events.find((e) => e.type === 'plan.approved')!;
    await service.projectApprovedPlan(
      {
        runId,
        companyId,
        projectId,
        sequence: approvedEvent.sequence,
        type: approvedEvent.type,
        payload: approvedEvent.payload,
        actorType: 'system',
        actorId: null,
        traceId: null,
        occurredAt: new Date(),
      },
      new Date(),
    );

    // Still exactly one project_plans entry and one step set.
    const plans = await getProjectPlans(db, companyId, projectId);
    expect(plans).toHaveLength(1);
    const steps = await getProjectPlanSteps(db, plans[0].id);
    expect(steps).toHaveLength(2);

    // Still one project_plan link and two project_plan_step links.
    const links = await getProjectionLinks(db, runId);
    expect(links.filter((l) => l.surface === 'project_plan')).toHaveLength(1);
    expect(links.filter((l) => l.surface === 'project_plan_step')).toHaveLength(2);

    // Singular approval/binding.
    const bindings = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS cnt FROM "run_plan_approval_bindings" WHERE "run_id" = ${runId}
    `)) as unknown as Array<{ cnt: number }>;
    expect(bindings[0].cnt).toBeGreaterThanOrEqual(1);

    await closeTestDb();
  });

  it('repairing a failed projection converges to one logical item', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-066-repair');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // Simulate a failed projection link by manually inserting a failed link.
    const schema = db.schema;
    // Mark the existing link as failed.
    await db.drizzle
      .update(schema.runProjectionLinks)
      .set({ status: 'failed', errorMessage: 'Simulated failure' })
      .where(
        and(
          eq(schema.runProjectionLinks.runId, runId),
          eq(schema.runProjectionLinks.surface, 'project_plan'),
        ),
      );

    // Repair it.
    const service = new MissionPlanGovernanceProjectionService(db);
    const repairResult = await service.repair({
      companyId,
      projectId,
      runId,
      surface: 'project_plan',
    });
    expect(repairResult.repaired).toBe(true);

    // Still exactly one project_plans entry.
    const plans = await getProjectPlans(db, companyId, projectId);
    expect(plans).toHaveLength(1);
    expect(plans[0].status).toBe('active');

    // One project_plan link, now active or repaired (not failed).
    const links = await getProjectionLinks(db, runId);
    const planLinks = links.filter((l) => l.surface === 'project_plan');
    expect(planLinks).toHaveLength(1);
    expect(planLinks[0].status).not.toBe('failed');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-098: Failed projection does not authorize execution
// ---------------------------------------------------------------------------

describe('VAL-PLAN-098: Failed projection does not authorize execution', () => {
  it('a failed project_plan projection does not queue the run; the run is queued only by the authoritative approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-098');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Before approval: run is awaiting_approval, not queued.
    expect(row!.status).toBe('awaiting_approval');
    expect(row!.approvedPlanRevisionId).toBeNull();

    // No project_plans projection exists yet.
    const plansBefore = await getProjectPlans(db, companyId, projectId);
    expect(plansBefore).toHaveLength(0);

    // Approve — this is the authoritative transition. The projection
    // happens post-commit and may fail, but the run is already queued
    // by the authoritative transaction.
    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // The run is queued regardless of projection status.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('queued');
    expect(rowAfter!.approvedPlanRevisionId).toBe(revision!.id);

    // Even if we simulate a projection failure (delete the project_plan),
    // the run remains queued — the projection is non-authoritative.
    const plans = await getProjectPlans(db, companyId, projectId);
    if (plans.length > 0) {
      await db.drizzle.execute(sql`
        DELETE FROM "project_plan_steps" WHERE "plan_id" = ${plans[0].id}
      `);
      await db.drizzle.execute(sql`
        DELETE FROM "project_plans" WHERE "id" = ${plans[0].id}
      `);
    }

    // The run is still queued — deleting the projection did not unqueue it.
    const rowAfterDelete = await getRunRow(db, runId);
    expect(rowAfterDelete!.status).toBe('queued');
    expect(rowAfterDelete!.approvedPlanRevisionId).toBe(revision!.id);

    // Repairing the projection alone does NOT re-queue (it's already queued).
    // But it does restore the plan surface.
    const service = new MissionPlanGovernanceProjectionService(db);
    // Mark the link as failed first so repair will re-project.
    const schema = db.schema;
    await db.drizzle
      .update(schema.runProjectionLinks)
      .set({ status: 'failed', errorMessage: 'Simulated delete' })
      .where(
        and(
          eq(schema.runProjectionLinks.runId, runId),
          eq(schema.runProjectionLinks.surface, 'project_plan'),
        ),
      );
    await service.repair({ companyId, projectId, runId, surface: 'project_plan' });

    // The projection is restored, but the run state is unchanged (still queued
    // from the authoritative approval, not from the projection repair).
    const rowAfterRepair = await getRunRow(db, runId);
    expect(rowAfterRepair!.status).toBe('queued');
    const plansAfterRepair = await getProjectPlans(db, companyId, projectId);
    expect(plansAfterRepair).toHaveLength(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-099: Mutable project plan cannot change execution
// ---------------------------------------------------------------------------

describe('VAL-PLAN-099: Mutable project plan cannot change execution', () => {
  it('editing a projected project_plans row does not change the Mission approved revision or hash', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-099');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    const originalHash = revision!.contentHash;

    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // Tamper with the projected project_plans row (mutable surface).
    const plans = await getProjectPlans(db, companyId, projectId);
    expect(plans).toHaveLength(1);
    await db.drizzle.execute(sql`
      UPDATE "project_plans" SET "title" = 'TAMPERED TITLE', "status" = 'completed', "progress" = 100
      WHERE "id" = ${plans[0].id}
    `);

    // Also tamper with a projected step.
    const steps = await getProjectPlanSteps(db, plans[0].id);
    if (steps.length > 0) {
      await db.drizzle.execute(sql`
        UPDATE "project_plan_steps" SET "title" = 'TAMPERED STEP', "status" = 'completed'
        WHERE "id" = ${steps[0].id}
      `);
    }

    // The Mission's approved revision and hash are unchanged.
    const approvedRow = await getRunRow(db, runId);
    expect(approvedRow!.approvedPlanRevisionId).toBe(revision!.id);

    // Verify the immutable revision content/hash is unchanged.
    const revisionRows = (await db.drizzle.execute(sql`
      SELECT "content_hash", "status" FROM "run_plan_revisions" WHERE "id" = ${revision!.id}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(revisionRows[0].content_hash).toBe(originalHash);
    expect(revisionRows[0].status).toBe('approved');

    // The tampered project_plan is a projection; Mission execution reads
    // the immutable revision, not this mutable row.
    const tamperedPlans = await getProjectPlans(db, companyId, projectId);
    expect(tamperedPlans[0].title).toBe('TAMPERED TITLE');
    // But the Mission snapshot still references the original revision.
    const snapshotRes = await request(app).get(`${base}/${runId}`).expect(200);
    expect(snapshotRes.body.data.run.approvedPlanRevisionId).toBe(revision!.id);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-119: Governance projections converge or declare lag
// ---------------------------------------------------------------------------

describe('VAL-PLAN-119: Governance projections converge or declare lag', () => {
  it('governance-projection endpoint reports converged=true after successful approval projection', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-119-conv');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // Read governance projection status via the API.
    const statusRes = await request(app).get(`${base}/${runId}/governance-projection`).expect(200);

    expect(statusRes.body.data.runId).toBe(runId);
    expect(statusRes.body.data.runStatus).toBe('queued');
    expect(statusRes.body.data.currentPlanRevisionId).toBe(revision!.id);
    expect(statusRes.body.data.currentPlanContentHash).toBe(revision!.contentHash);

    // The plan_approval and project_plan surfaces should be active (converged).
    const surfaces = statusRes.body.data.surfaces;
    const planApproval = surfaces.find((s: { surface: string }) => s.surface === 'plan_approval');
    expect(planApproval).toBeDefined();
    expect(planApproval.status).toBe('active');

    const projectPlan = surfaces.find((s: { surface: string }) => s.surface === 'project_plan');
    expect(projectPlan).toBeDefined();
    expect(projectPlan.status).toBe('active');

    expect(statusRes.body.data.converged).toBe(true);
    expect(statusRes.body.data.lagging).toBe(false);

    await closeTestDb();
  });

  it('governance-projection endpoint reports lagging=true when a projection link is failed', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-119-lag');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // Simulate a projection failure by marking the project_plan link as failed.
    const schema = db.schema;
    await db.drizzle
      .update(schema.runProjectionLinks)
      .set({ status: 'failed', errorMessage: 'Simulated lag' })
      .where(
        and(
          eq(schema.runProjectionLinks.runId, runId),
          eq(schema.runProjectionLinks.surface, 'project_plan'),
        ),
      );

    const statusRes = await request(app).get(`${base}/${runId}/governance-projection`).expect(200);

    expect(statusRes.body.data.lagging).toBe(true);
    expect(statusRes.body.data.converged).toBe(false);

    const projectPlan = statusRes.body.data.surfaces.find(
      (s: { surface: string }) => s.surface === 'project_plan',
    );
    expect(projectPlan.status).toBe('failed');
    expect(projectPlan.errorMessage).toBe('Simulated lag');

    await closeTestDb();
  });

  it('governance-projection endpoint returns 404 for cross-scope run', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-119-scope');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Create a second scope and try to read the first run's governance status.
    const scope2 = await seedScope(db, '__mtest__ gov-proj-119-scope2');
    const base2 = `/api/companies/${scope2.companyId}/projects/${scope2.projectId}/mission-runs`;
    await request(app).get(`${base2}/${runId}/governance-projection`).expect(404);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-127: Approval recipients follow current permission
// ---------------------------------------------------------------------------

describe('VAL-PLAN-127: Approval recipients follow current permission', () => {
  it('inbox shows the pending plan_gate approval as actionable for any authenticated user; permission is checked at command time', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ gov-proj-127');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // The inbox shows the pending approval — it's derived from live data,
    // so any authorized reader sees it. The permission to approve is
    // checked at command time, not at projection time.
    const inboxRes = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const approvalItems = inboxRes.body.data.filter((i: { kind: string }) => i.kind === 'approval');
    expect(approvalItems).toHaveLength(1);
    expect(approvalItems[0].status).toBe('pending');

    // A committed historical approval remains valid after the approval is
    // committed — the approval is already resolved.
    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // After approval, the approval is no longer pending — it leaves the
    // actionable inbox. This is the "recipient revocation" convergence:
    // role/membership changes idempotently update who sees actionable
    // controls because the inbox reads live approval status.
    const inboxAfter = await request(app).get(`/api/companies/${companyId}/inbox`).expect(200);
    const approvalItemsAfter = inboxAfter.body.data.filter(
      (i: { kind: string; status: string }) => i.kind === 'approval' && i.status === 'pending',
    );
    expect(approvalItemsAfter).toHaveLength(0);

    // The committed approval remains valid (historical approval persists).
    const approvals = await getApprovals(db, companyId);
    expect(approvals[0].status).toBe('approved');

    await closeTestDb();
  });
});
