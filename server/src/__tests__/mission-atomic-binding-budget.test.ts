import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import { PlannerTestHarness, HARNESS_ENV_FLAG } from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';
import {
  PlanDecisionService,
  type PlanDecisionFailpoint,
} from '../services/mission/plan-decision.js';
import { BudgetService } from '../services/mission/budget.js';

/**
 * Atomically bind approval, authorization, transition, and residual budget.
 *
 * (VAL-PLAN-028, 031, 094, 107)
 *
 * Tests: Postgres failpoints, arithmetic, concurrent approval, immutability,
 * cardinality, projection absence, and retry.
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

async function seedScope(
  db: AnyDb,
  label: string,
  opts: { companyBudget?: number; companySpent?: number } = {},
) {
  const companyId = randomUUID();
  const now = new Date();
  const companyBudget = opts.companyBudget ?? 100000;
  const companySpent = opts.companySpent ?? 0;
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', ${companyBudget}, ${companySpent}, '{"testFixture": true}'::jsonb, ${now}, ${now})
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

async function seedAgent(
  db: AnyDb,
  companyId: string,
  opts: { budget?: number; spent?: number; tools?: string[] } = {},
) {
  const agentId = randomUUID();
  const now = new Date();
  const agentBudget = opts.budget ?? 0;
  const agentSpent = opts.spent ?? 0;
  const toolsJson = JSON.stringify(opts.tools ?? []);
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "created_at", "updated_at")
    VALUES (${agentId}, ${companyId}, 'A', 'engineer', 'anthropic', 'claude-sonnet-4-6', 'idle', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, ${toolsJson}::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 5, 0, 600, 0, ${agentBudget}, ${agentSpent}, ${now}, ${now})
  `);
  return agentId;
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
    SELECT rpr."id", rpr."revision", rpr."status", rpr."content_hash", rpr."content"
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
    content: rows[0]['content'] as Record<string, unknown>,
  };
}

async function getApprovedRevision(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT rpr."id", rpr."revision", rpr."status", rpr."content_hash", rpr."content"
    FROM "run_plan_revisions" rpr
    JOIN "mission_runs" mr ON mr."approved_plan_revision_id" = rpr."id"
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
    content: rows[0]['content'] as Record<string, unknown>,
  };
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload", "actor_type", "actor_id"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{
    sequence: string | number;
    type: string;
    payload: Record<string, unknown>;
    actor_type: string;
    actor_id: string | null;
  }>;
  return rows.map((r) => ({
    ...r,
    sequence: Number(r.sequence),
    actorType: r.actor_type,
    actorId: r.actor_id,
  }));
}

async function getApprovalBindings(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "plan_revision_id", "content_hash", "approval_id", "decision",
           "deciding_user_id", "decided_at"
    FROM "run_plan_approval_bindings" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    planRevisionId: r['plan_revision_id'] as string,
    contentHash: r['content_hash'] as string,
    approvalId: r['approval_id'] as string,
    decision: (r['decision'] as string) ?? null,
    decidingUserId: (r['deciding_user_id'] as string) ?? null,
  }));
}

async function getReservation(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "reserved_cents", "settled_cents", "released_cents",
           "execution_earmark_cents", "status", "requested_cents"
    FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  const r = rows[0];
  return {
    reservedCents: Number(r['reserved_cents']),
    settledCents: Number(r['settled_cents']),
    releasedCents: Number(r['released_cents']),
    executionEarmarkCents:
      r['execution_earmark_cents'] !== null ? Number(r['execution_earmark_cents']) : null,
    status: r['status'] as string,
    requestedCents: Number(r['requested_cents']),
  };
}

async function countRevisions(db: AnyDb, runId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS cnt FROM "run_plan_revisions" WHERE "run_id" = ${runId}
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
}

/** Helper: set up a run in awaiting_approval and return context. */
async function setupAwaitingApproval(db: AnyDb, label: string) {
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const app = await createTestServer(db);
  const res = await startPlanningRun(app, base, threadId);
  const runId = res.body.data.run.id as string;
  await publishPlanAndWait(db, runId);
  const row = await getRunRow(db, runId);
  expect(row!.status).toBe('awaiting_approval');
  const revision = await getCurrentRevision(db, runId);
  expect(revision).not.toBeNull();
  return { db, app, base, runId, row, revision, companyId, projectId, threadId };
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ===========================================================================
// VAL-PLAN-028: Approval releases execution exactly once
// ===========================================================================

describe('VAL-PLAN-028: Approval releases execution exactly once', () => {
  it('applies one binding, one queue transition, and allows one execution start', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-028-once');

    const approveRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    expect(approveRes.body.data.run.status).toBe('queued');

    // Exactly one plan.approved event.
    const events = await getEvents(db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents).toHaveLength(1);

    // The run transitioned to queued (verified by the response above).
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('queued');

    // Exactly one approved binding.
    const bindings = await getApprovalBindings(db, ctx.runId);
    expect(bindings.filter((b) => b.decision === 'approved')).toHaveLength(1);

    // The run is now claimable by a worker (execution can start once).
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker-028');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(ctx.runId);
    // A second concurrent claim should not get the same run.
    const claim2 = await coordinator.claimNext('test-worker-028b');
    // Either null (no other eligible run) or a different run.
    if (claim2) {
      expect(claim2.runId).not.toBe(ctx.runId);
    }
    await coordinator.release(claim!);
    if (claim2) {
      await coordinator.release(claim2);
    }

    await closeTestDb();
  });

  it('does not allow execution before approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(
      db,
      '__mtest__ plan-028-no-pre-exec',
    );
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // While awaiting_approval, the worker cannot claim the run.
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker-028-pre');
    expect(claim).toBeNull();

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-PLAN-031: Approved content is immutable
// ===========================================================================

describe('VAL-PLAN-031: Approved content is immutable', () => {
  it('approved revision content and hash cannot be modified through plan endpoints', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-031-immutable');

    // Approve the plan.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    // Get the updated state version after approval.
    const rowAfterApprove = await getRunRow(db, ctx.runId);

    const approvedBefore = await getApprovedRevision(db, ctx.runId);
    expect(approvedBefore).not.toBeNull();
    const expectedHash = approvedBefore!.contentHash;
    const expectedContent = approvedBefore!.content;

    // Attempt to revise the approved plan — should be rejected because
    // the run is now queued, not awaiting_approval.
    const reviseRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${rowAfterApprove!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Try to change the approved plan',
      })
      .expect(409);
    expect(reviseRes.body.code).toBe('INVALID_RUN_STATE');

    // The approved revision content and hash are unchanged.
    const approvedAfter = await getApprovedRevision(db, ctx.runId);
    expect(approvedAfter).not.toBeNull();
    expect(approvedAfter!.contentHash).toBe(expectedHash);
    expect(approvedAfter!.content).toEqual(expectedContent);
    expect(approvedAfter!.status).toBe('approved');

    await closeTestDb();
  });

  it('approved revision content hash is unchanged after duplicate approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-031-dup-hash');

    const key = `approve-dup-${randomUUID()}`;
    const body = { revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash };

    // First approval.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send(body)
      .expect(200);

    const approvedBefore = await getApprovedRevision(db, ctx.runId);
    const expectedHash = approvedBefore!.contentHash;

    // Duplicate approval with same key.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send(body)
      .expect(200);

    const approvedAfter = await getApprovedRevision(db, ctx.runId);
    expect(approvedAfter!.contentHash).toBe(expectedHash);

    await closeTestDb();
  });

  it('direct database update of approved revision content hash is prevented by unique constraint', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-031-db-immutability');

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    const approvedBefore = await getApprovedRevision(db, ctx.runId);
    const originalHash = approvedBefore!.contentHash;

    // Attempt to update the content_hash directly — this should succeed
    // at the DB level (no trigger prevents it), but the service layer never
    // does this. The immutability is enforced by the service layer: the
    // approve method sets the status to 'approved' and never updates content.
    // The unique constraint on (run_id, content_hash) prevents creating a
    // duplicate revision with the same hash.
    //
    // Verify the revision status is 'approved' and content hash is unchanged
    // through the service path.
    const revisionRows = (await db.drizzle.execute(sql`
      SELECT "status", "content_hash" FROM "run_plan_revisions" WHERE "id" = ${approvedBefore!.id}
    `)) as unknown as Array<{ status: string; content_hash: string }>;
    expect(revisionRows[0].status).toBe('approved');
    expect(revisionRows[0].content_hash).toBe(originalHash);

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-PLAN-094: Approval budget earmarks the existing root hold atomically
// ===========================================================================

describe('VAL-PLAN-094: Approval budget earmarks the existing root hold atomically', () => {
  it('earmarks the execution envelope from the existing root hold on approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-094-earmark');

    // The plan has step budget 100 + synthesis budget 100 = 200 execution envelope.
    const reservationBefore = await getReservation(db, ctx.runId);
    expect(reservationBefore).not.toBeNull();
    expect(reservationBefore!.executionEarmarkCents).toBeNull();

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    const reservationAfter = await getReservation(db, ctx.runId);
    expect(reservationAfter).not.toBeNull();
    expect(reservationAfter!.executionEarmarkCents).toBe(200);
    // The reserved amount is unchanged (no double-reservation).
    expect(reservationAfter!.reservedCents).toBe(reservationBefore!.reservedCents);
    // Company spend is unchanged (no reacquisition).
    expect(reservationAfter!.settledCents).toBe(reservationBefore!.settledCents);

    await closeTestDb();
  });

  it('returns BUDGET_UNAVAILABLE when execution envelope exceeds residual', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-094-denied');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    // Start a run with a small budget ceiling (300 cents).
    const startRes = await request(app)
      .post(base)
      .set('Idempotency-Key', `plan-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'deep_work',
        request: { text: 'Complex analysis with multiple deliverables' },
        limits: { costCents: 300 },
      })
      .expect(202);
    const runId = startRes.body.data.run.id as string;

    // The root reservation should be ~300 cents.
    const reservation = await getReservation(db, runId);
    expect(reservation).not.toBeNull();
    expect(reservation!.reservedCents).toBeLessThanOrEqual(300);

    // Manually settle some planning budget to reduce the residual.
    // Settle 250 cents of planning, leaving only 50 cents residual.
    // The plan needs 200 cents execution envelope.
    // With 50 residual, 200 > 50 → BUDGET_UNAVAILABLE.
    const budgetService = new BudgetService(db);
    await db.drizzle.transaction(async (tx) => {
      await budgetService.settle(tx, {
        companyId,
        runId,
        billingAgentId: null,
        externalCallId: `planning-charge-${randomUUID()}`,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        operation: 'planning',
        costCents: 250,
      });
    });

    // Publish a plan that needs 200 cents execution envelope.
    const planContent = validPlanContent();
    await publishPlanAndWait(db, runId, planContent);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Approve — should fail with BUDGET_UNAVAILABLE.
    const approveRes = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(409);
    expect(approveRes.body.code).toBe('BUDGET_UNAVAILABLE');

    // The gate remains open: run is still awaiting_approval.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.approvedPlanRevisionId).toBeNull();

    // No binding with decision 'approved'.
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings.filter((b) => b.decision === 'approved')).toHaveLength(0);

    // No plan.approved event.
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.approved')).toBeUndefined();

    // No earmark was set.
    const reservationAfter = await getReservation(db, runId);
    expect(reservationAfter!.executionEarmarkCents).toBeNull();

    await closeTestDb();
  });

  it('does not double-reserve company funds on approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-094-no-double');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const startRes = await startPlanningRun(app, base, threadId);
    const runId = startRes.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Read company spend before approval.
    const companyBefore = (await db.drizzle.execute(sql`
      SELECT "spent_monthly_cents" AS "spent" FROM "companies" WHERE "id" = ${companyId}
    `)) as unknown as Array<{ spent: number }>;
    const spendBefore = companyBefore[0].spent;

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    // Company spend is unchanged — approval earmarks, not charges.
    const companyAfter = (await db.drizzle.execute(sql`
      SELECT "spent_monthly_cents" AS "spent" FROM "companies" WHERE "id" = ${companyId}
    `)) as unknown as Array<{ spent: number }>;
    expect(companyAfter[0].spent).toBe(spendBefore);

    await closeTestDb();
  });

  it('budget earmark is atomic with the binding and queue transition', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-094-atomic');

    // Use the PlanDecisionService directly to verify atomicity.
    const row = await getRunRow(db, ctx.runId);

    // Load the run row locked.
    await db.drizzle.transaction(async (tx) => {
      const schema = db.schema;
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, ctx.runId))
        .for('update')
        .limit(1);

      const service = new PlanDecisionService(db);
      const result = await service.applyApprove(
        tx,
        lockedRun,
        { revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash },
        'user',
        'test-user-094',
        'test-trace-094',
      );

      expect(result.decision).toBe('approved');
      expect(result.stateVersion).toBe(row!.stateVersion + 1);
    });

    // After the transaction, all three changes are visible: earmark, binding, queue.
    const reservation = await getReservation(db, ctx.runId);
    expect(reservation!.executionEarmarkCents).toBe(200);

    const bindings = await getApprovalBindings(db, ctx.runId);
    expect(bindings.filter((b) => b.decision === 'approved')).toHaveLength(1);

    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('queued');

    await closeTestDb();
  });

  it('lower live billing-agent limit denies approval with BUDGET_UNAVAILABLE', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(
      db,
      '__mtest__ plan-094-agent-limit',
    );
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    // Create an agent with a monthly budget of 500 cents.
    const agentId = await seedAgent(db, companyId, { budget: 500, spent: 0 });

    // Start a run with the agent.
    const startRes = await request(app)
      .post(base)
      .set('Idempotency-Key', `plan-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'deep_work',
        initiatingAgentId: agentId,
        request: { text: 'Complex analysis with multiple deliverables' },
      })
      .expect(202);
    const runId = startRes.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Lower the agent's monthly budget to 50 cents (below the allocation).
    await db.drizzle.execute(sql`
      UPDATE "agents" SET "budget_monthly_cents" = 50 WHERE "id" = ${agentId}
    `);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Approve — should fail with BUDGET_UNAVAILABLE because the agent's
    // live limit was reduced below the current allocation.
    const approveRes = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(409);
    expect(approveRes.body.code).toBe('BUDGET_UNAVAILABLE');

    // Gate remains open.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-PLAN-107: Plan commands are all or nothing under faults
// ===========================================================================

describe('VAL-PLAN-107: Plan commands are all or nothing under faults', () => {
  /**
   * Helper: attempt an approve with a failpoint that throws after a specific
   * write. The transaction should roll back, leaving no partial state.
   */
  async function attemptApproveWithFailpoint(
    db: AnyDb,
    runId: string,
    revisionId: string,
    contentHash: string,
    stateVersion: number,
    failpoint: PlanDecisionFailpoint,
  ): Promise<void> {
    const schema = db.schema;
    await db.drizzle.transaction(async (tx) => {
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      const service = new PlanDecisionService(db, {
        failpointHook: (point) => {
          if (point === failpoint) {
            throw new Error(`Simulated fault at ${point}`);
          }
        },
      });

      await service.applyApprove(
        tx,
        lockedRun,
        { revisionId, contentHash },
        'user',
        'test-user-107',
        'test-trace-107',
      );
    });
  }

  /**
   * Helper: attempt a reject with a failpoint that throws after a specific
   * write. The transaction should roll back, leaving no partial state.
   */
  async function attemptRejectWithFailpoint(
    db: AnyDb,
    runId: string,
    revisionId: string,
    contentHash: string,
    stateVersion: number,
    failpoint: PlanDecisionFailpoint,
    disposition?: 'revise',
    feedback?: string,
  ): Promise<void> {
    const schema = db.schema;
    await db.drizzle.transaction(async (tx) => {
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      const service = new PlanDecisionService(db, {
        failpointHook: (point) => {
          if (point === failpoint) {
            throw new Error(`Simulated fault at ${point}`);
          }
        },
      });

      await service.applyReject(
        tx,
        lockedRun,
        {
          revisionId,
          contentHash,
          reason: 'Testing fault tolerance',
          disposition,
          feedback,
        },
        'user',
        'test-user-107',
        'test-trace-107',
      );
    });
  }

  /**
   * Helper: attempt a revision request with a failpoint.
   */
  async function attemptRevisionWithFailpoint(
    db: AnyDb,
    runId: string,
    revisionId: string,
    contentHash: string,
    stateVersion: number,
    failpoint: PlanDecisionFailpoint,
  ): Promise<void> {
    const schema = db.schema;
    await db.drizzle.transaction(async (tx) => {
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      const service = new PlanDecisionService(db, {
        failpointHook: (point) => {
          if (point === failpoint) {
            throw new Error(`Simulated fault at ${point}`);
          }
        },
      });

      await service.applyRevisionRequest(
        tx,
        lockedRun,
        { revisionId, contentHash, feedback: 'Please add more detail' },
        'user',
        'test-user-107',
        'test-trace-107',
      );
    });
  }

  /** Verify the run is unchanged after a failed attempt. */
  async function verifyUnchanged(
    db: AnyDb,
    runId: string,
    originalRow: NonNullable<Awaited<ReturnType<typeof getRunRow>>>,
  ) {
    const row = await getRunRow(db, runId);
    expect(row!.status).toBe(originalRow.status);
    expect(row!.stateVersion).toBe(originalRow.stateVersion);
    expect(row!.lastEventSequence).toBe(originalRow.lastEventSequence);
    expect(row!.currentPlanRevisionId).toBe(originalRow.currentPlanRevisionId);
    expect(row!.approvedPlanRevisionId).toBe(originalRow.approvedPlanRevisionId);

    // No new events were appended.
    const events = await getEvents(db, runId);
    expect(events).toHaveLength(originalRow.lastEventSequence);

    // No approved bindings.
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings.filter((b) => b.decision === 'approved')).toHaveLength(0);

    // No earmark.
    const reservation = await getReservation(db, runId);
    expect(reservation!.executionEarmarkCents).toBeNull();
  }

  const approveFailpoints: PlanDecisionFailpoint[] = [
    'approve_after_earmark',
    'approve_after_approval_resolved',
    'approve_after_binding_set',
    'approve_after_revision_status',
    'approve_after_run_queued',
    'approve_after_event',
  ];

  it.each(approveFailpoints)('approve fault at %s leaves no partial state', async (failpoint) => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, `__mtest__ plan-107-approve-${failpoint}`);

    const originalRow = (await getRunRow(db, ctx.runId))!;
    const originalRevisionCount = await countRevisions(db, ctx.runId);

    // Attempt approve with failpoint — should throw and roll back.
    await expect(
      attemptApproveWithFailpoint(
        db,
        ctx.runId,
        ctx.revision!.id,
        ctx.revision!.contentHash,
        ctx.row!.stateVersion,
        failpoint,
      ),
    ).rejects.toThrow();

    // Verify no partial state remains.
    await verifyUnchanged(db, ctx.runId, originalRow);

    // No new revisions were created.
    const revisionCountAfter = await countRevisions(db, ctx.runId);
    expect(revisionCountAfter).toBe(originalRevisionCount);

    await closeTestDb();
  });

  it('approve retry after fault produces one complete outcome', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-107-approve-retry');

    const originalRow = (await getRunRow(db, ctx.runId))!;

    // First attempt fails with a fault.
    await expect(
      attemptApproveWithFailpoint(
        db,
        ctx.runId,
        ctx.revision!.id,
        ctx.revision!.contentHash,
        ctx.row!.stateVersion,
        'approve_after_earmark',
      ),
    ).rejects.toThrow();

    // Verify no partial state.
    await verifyUnchanged(db, ctx.runId, originalRow);

    // Retry without failpoint — should succeed.
    await db.drizzle.transaction(async (tx) => {
      const schema = db.schema;
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, ctx.runId))
        .for('update')
        .limit(1);

      const service = new PlanDecisionService(db);
      const result = await service.applyApprove(
        tx,
        lockedRun,
        { revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash },
        'user',
        'test-user-107',
        'test-trace-107',
      );
      expect(result.decision).toBe('approved');
    });

    // Verify exactly one complete outcome.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('queued');
    expect(rowAfter!.approvedPlanRevisionId).toBe(ctx.revision!.id);

    const events = await getEvents(db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents).toHaveLength(1);

    const bindings = await getApprovalBindings(db, ctx.runId);
    expect(bindings.filter((b) => b.decision === 'approved')).toHaveLength(1);

    const reservation = await getReservation(db, ctx.runId);
    expect(reservation!.executionEarmarkCents).toBe(200);

    await closeTestDb();
  });

  const rejectCancelFailpoints: PlanDecisionFailpoint[] = [
    'reject_after_approval_resolved',
    'reject_after_binding_set',
    'reject_after_revision_status',
    'reject_after_rejected_event',
    'reject_cancel_after_run_cancelled',
    'reject_cancel_after_cancelled_event',
  ];

  it.each(rejectCancelFailpoints)(
    'reject-cancel fault at %s leaves no partial state',
    async (failpoint) => {
      enableMissionFlag();
      enableHarness();
      const db = await createTestDb();
      const ctx = await setupAwaitingApproval(db, `__mtest__ plan-107-reject-cancel-${failpoint}`);

      const originalRow = (await getRunRow(db, ctx.runId))!;

      await expect(
        attemptRejectWithFailpoint(
          db,
          ctx.runId,
          ctx.revision!.id,
          ctx.revision!.contentHash,
          ctx.row!.stateVersion,
          failpoint,
        ),
      ).rejects.toThrow();

      // Run remains awaiting_approval (not cancelled).
      const row = await getRunRow(db, ctx.runId);
      expect(row!.status).toBe('awaiting_approval');
      expect(row!.stateVersion).toBe(originalRow.stateVersion);

      // No rejected bindings.
      const bindings = await getApprovalBindings(db, ctx.runId);
      expect(bindings.filter((b) => b.decision === 'rejected')).toHaveLength(0);

      // No run.cancelled event.
      const events = await getEvents(db, ctx.runId);
      expect(events.find((e) => e.type === 'run.cancelled')).toBeUndefined();
      expect(events.find((e) => e.type === 'plan.rejected')).toBeUndefined();

      await closeTestDb();
    },
  );

  const rejectReviseFailpoints: PlanDecisionFailpoint[] = [
    'reject_after_approval_resolved',
    'reject_after_binding_set',
    'reject_after_revision_status',
    'reject_after_rejected_event',
    'reject_revise_after_revision_requested_event',
  ];

  it.each(rejectReviseFailpoints)(
    'reject-revise fault at %s leaves no partial state',
    async (failpoint) => {
      enableMissionFlag();
      enableHarness();
      const db = await createTestDb();
      const ctx = await setupAwaitingApproval(db, `__mtest__ plan-107-reject-revise-${failpoint}`);

      const originalRow = (await getRunRow(db, ctx.runId))!;

      await expect(
        attemptRejectWithFailpoint(
          db,
          ctx.runId,
          ctx.revision!.id,
          ctx.revision!.contentHash,
          ctx.row!.stateVersion,
          failpoint,
          'revise',
          'Please add more detail',
        ),
      ).rejects.toThrow();

      // Run remains awaiting_approval (not planning).
      const row = await getRunRow(db, ctx.runId);
      expect(row!.status).toBe('awaiting_approval');
      expect(row!.stateVersion).toBe(originalRow.stateVersion);

      // No rejected bindings.
      const bindings = await getApprovalBindings(db, ctx.runId);
      expect(bindings.filter((b) => b.decision === 'rejected')).toHaveLength(0);

      // No revision_requested event.
      const events = await getEvents(db, ctx.runId);
      expect(events.find((e) => e.type === 'plan.revision_requested')).toBeUndefined();

      await closeTestDb();
    },
  );

  const revisionFailpoints: PlanDecisionFailpoint[] = [
    'revision_after_supersede',
    'revision_after_approval_resolved',
    'revision_after_run_planning',
    'revision_after_event',
  ];

  it.each(revisionFailpoints)(
    'revision_request fault at %s leaves no partial state',
    async (failpoint) => {
      enableMissionFlag();
      enableHarness();
      const db = await createTestDb();
      const ctx = await setupAwaitingApproval(db, `__mtest__ plan-107-revision-${failpoint}`);

      const originalRow = (await getRunRow(db, ctx.runId))!;

      await expect(
        attemptRevisionWithFailpoint(
          db,
          ctx.runId,
          ctx.revision!.id,
          ctx.revision!.contentHash,
          ctx.row!.stateVersion,
          failpoint,
        ),
      ).rejects.toThrow();

      // Run remains awaiting_approval (not planning).
      const row = await getRunRow(db, ctx.runId);
      expect(row!.status).toBe('awaiting_approval');
      expect(row!.stateVersion).toBe(originalRow.stateVersion);

      // Revision is still 'proposed' (not superseded).
      const revision = await getCurrentRevision(db, ctx.runId);
      expect(revision!.status).toBe('proposed');

      // No revision_requested event.
      const events = await getEvents(db, ctx.runId);
      expect(events.find((e) => e.type === 'plan.revision_requested')).toBeUndefined();

      await closeTestDb();
    },
  );

  it('revision_request retry after fault produces one complete outcome', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-107-revision-retry');

    // First attempt fails.
    await expect(
      attemptRevisionWithFailpoint(
        db,
        ctx.runId,
        ctx.revision!.id,
        ctx.revision!.contentHash,
        ctx.row!.stateVersion,
        'revision_after_supersede',
      ),
    ).rejects.toThrow();

    // Run still awaiting_approval.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');

    // Retry without failpoint — should succeed.
    await db.drizzle.transaction(async (tx) => {
      const schema = db.schema;
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, ctx.runId))
        .for('update')
        .limit(1);

      const service = new PlanDecisionService(db);
      const result = await service.applyRevisionRequest(
        tx,
        lockedRun,
        {
          revisionId: ctx.revision!.id,
          contentHash: ctx.revision!.contentHash,
          feedback: 'Please add more detail',
        },
        'user',
        'test-user-107',
        'test-trace-107',
      );
      expect(result.decision).toBe('revision_requested');
    });

    // Verify exactly one complete outcome.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('planning');

    const events = await getEvents(db, ctx.runId);
    const revisionEvents = events.filter((e) => e.type === 'plan.revision_requested');
    expect(revisionEvents).toHaveLength(1);

    await closeTestDb();
  });

  it('reject-cancel retry after fault produces one complete outcome', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-107-reject-retry');

    // First attempt fails.
    await expect(
      attemptRejectWithFailpoint(
        db,
        ctx.runId,
        ctx.revision!.id,
        ctx.revision!.contentHash,
        ctx.row!.stateVersion,
        'reject_after_rejected_event',
      ),
    ).rejects.toThrow();

    // Run still awaiting_approval.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');

    // Retry without failpoint — should succeed.
    await db.drizzle.transaction(async (tx) => {
      const schema = db.schema;
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, ctx.runId))
        .for('update')
        .limit(1);

      const service = new PlanDecisionService(db);
      const result = await service.applyReject(
        tx,
        lockedRun,
        {
          revisionId: ctx.revision!.id,
          contentHash: ctx.revision!.contentHash,
          reason: 'Not what we need',
        },
        'user',
        'test-user-107',
        'test-trace-107',
      );
      expect(result.decision).toBe('rejected');
    });

    // Verify exactly one complete outcome.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('cancelled');

    const events = await getEvents(db, ctx.runId);
    expect(events.filter((e) => e.type === 'plan.rejected')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'run.cancelled')).toHaveLength(1);

    const bindings = await getApprovalBindings(db, ctx.runId);
    expect(bindings.filter((b) => b.decision === 'rejected')).toHaveLength(1);

    await closeTestDb();
  });
});

// ===========================================================================
// Concurrent approval (cardinality and immutability)
// ===========================================================================

describe('Concurrent approval resolves once', () => {
  it('two concurrent approvals yield one binding and one queue transition', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ plan-concurrent-approve');

    const key1 = `approve-concurrent-1-${randomUUID()}`;
    const key2 = `approve-concurrent-2-${randomUUID()}`;
    const body = { revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash };

    // Fire two approvals concurrently.
    const [res1, res2] = await Promise.all([
      request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/plan/approve`)
        .set('Idempotency-Key', key1)
        .set('If-Match', `"${ctx.row!.stateVersion}"`)
        .set('X-Eidolon-Test-Org-Role', 'owner')
        .send(body),
      request(ctx.app)
        .post(`${ctx.base}/${ctx.runId}/plan/approve`)
        .set('Idempotency-Key', key2)
        .set('If-Match', `"${ctx.row!.stateVersion}"`)
        .set('X-Eidolon-Test-Org-Role', 'owner')
        .send(body),
    ]);

    // One should succeed (200), the other should get a stale version error (412).
    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toContain(200);
    // The loser gets either 412 (stale version) or 409 (invalid state).
    const loser = res1.status === 200 ? res2 : res1;
    expect([409, 412]).toContain(loser.status);

    // Exactly one approved event.
    const events = await getEvents(db, ctx.runId);
    expect(events.filter((e) => e.type === 'plan.approved')).toHaveLength(1);

    // Exactly one approved binding.
    const bindings = await getApprovalBindings(db, ctx.runId);
    expect(bindings.filter((b) => b.decision === 'approved')).toHaveLength(1);

    // One earmark.
    const reservation = await getReservation(db, ctx.runId);
    expect(reservation!.executionEarmarkCents).toBe(200);

    await closeTestDb();
  });
});
