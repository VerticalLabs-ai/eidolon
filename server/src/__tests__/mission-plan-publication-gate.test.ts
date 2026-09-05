import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlanPublicationService } from '../services/mission/plan-publication.js';
import { PlannerService, type PlanGenerator } from '../services/mission/planner.js';
import {
  PlannerTestHarness,
  isTestHarnessEnabled,
  HARNESS_ENV_FLAG,
  type HarnessConfig,
} from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { OrchestrationWorker } from '../services/mission/worker.js';
import { RunProcessor } from '../services/mission/run-processor.js';
import {
  planContentHash,
  validatePlan,
  PLAN_CONTENT_SCHEMA_VERSION,
} from '../services/mission/plan-schema.js';

/**
 * Atomic plan publication and governance gate.
 *
 * (VAL-PLAN-024, 025, 026, 027, 103, 106, 114, 130)
 *
 * Exercises invalid plans, failpoints, planner restart/recovery, approval
 * bypass attempts, effect ledgers, proposal cardinality, and the
 * nonproduction planner harness.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

/** Enable the test planner harness (VAL-PLAN-130). */
function enableHarness() {
  vi.stubEnv(HARNESS_ENV_FLAG, '1');
}

function disableHarness() {
  vi.stubEnv(HARNESS_ENV_FLAG, '0');
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

/** Build a valid minimal PlanContentV1 for testing. */
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
    presentationMetadata: { cardTitle: 'Quarterly Analysis', summary: 'Analyze Q3 data' },
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

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "current_plan_revision_id",
           "approved_plan_revision_id", "terminal_at", "failure_category", "failure_code",
           "lease_owner", "lease_token"
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
    leaseOwner: (row['lease_owner'] as string) ?? null,
    leaseToken: (row['lease_token'] as string) ?? null,
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

async function getPlanRevisions(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "revision", "status", "content_hash", "parent_revision_id"
    FROM "run_plan_revisions" WHERE "run_id" = ${runId}
    ORDER BY "revision" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    revision: r['revision'] as number,
    status: r['status'] as string,
    contentHash: r['content_hash'] as string,
    parentRevisionId: (r['parent_revision_id'] as string) ?? null,
  }));
}

async function getApprovalBindings(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "plan_revision_id", "content_hash", "approval_id", "decision"
    FROM "run_plan_approval_bindings" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    planRevisionId: r['plan_revision_id'] as string,
    contentHash: r['content_hash'] as string,
    approvalId: r['approval_id'] as string,
    decision: (r['decision'] as string) ?? null,
  }));
}

async function getApproval(db: AnyDb, approvalId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "kind", "status", "payload", "project_id"
    FROM "approvals" WHERE "id" = ${approvalId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0]
    ? {
        id: rows[0]['id'] as string,
        kind: rows[0]['kind'] as string,
        status: rows[0]['status'] as string,
        payload: rows[0]['payload'] as Record<string, unknown>,
        projectId: (rows[0]['project_id'] as string) ?? null,
      }
    : null;
}

/** Count rows in a table for a run. */
async function countRows(db: AnyDb, table: string, runId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS cnt FROM ${sql.raw(`"${table}"`)} WHERE "run_id" = ${runId}
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-PLAN-024: Invalid plan never reaches approval
// ---------------------------------------------------------------------------

describe('VAL-PLAN-024: Invalid plan never reaches approval', () => {
  it('rejects a cyclic dependency plan without exposing a gate', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-cyclic');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // Inject a cyclic plan: step-1 depends on step-2, step-2 depends on step-1.
    const cyclicPlan = validPlanContent({
      steps: [
        {
          ...((validPlanContent() as Record<string, unknown[]>).steps[0] as Record<
            string,
            unknown
          >),
          stepKey: 'step-1',
          dependencies: ['step-2'],
          expectedOutputs: ['out-1'],
        },
        {
          ...((validPlanContent() as Record<string, unknown[]>).steps[0] as Record<
            string,
            unknown
          >),
          stepKey: 'step-2',
          dependencies: ['step-1'],
          expectedOutputs: ['out-2'],
        },
      ],
      synthesis: {
        instructions: 'Synthesize',
        declaredInputs: [
          { kind: 'stepOutput', stepKey: 'step-1', output: 'out-1' },
          { kind: 'stepOutput', stepKey: 'step-2', output: 'out-2' },
        ],
        declaredOutput: 'final',
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Done',
        budgetCents: 100,
      },
    });

    // Use the harness to inject the invalid plan and run the planner.
    const harness = new PlannerTestHarness({ vectors: [{ content: cyclicPlan }] });
    const planner = new PlannerService(db, { generator: harness, maxAttempts: 1 });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(runId);

    await planner.plan(claim!, new AbortController().signal);

    // The run should NOT be in awaiting_approval (invalid plan).
    const row = await getRunRow(db, runId);
    expect(row!.status).not.toBe('awaiting_approval');

    // No plan revision or gate approval should be visible.
    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(0);
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings).toHaveLength(0);

    // The run should be failed with a safe planning/validation error.
    expect(row!.status).toBe('failed');
    expect(row!.failureCategory).toBe('validation');

    await coordinator.release(claim!);
    await closeTestDb();
  });

  it('rejects a budget-above-residual plan without exposing a gate', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-budget');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // Plan with step budgets exceeding the cost ceiling.
    const overBudgetPlan = validPlanContent({
      steps: [
        {
          ...((validPlanContent() as Record<string, unknown[]>).steps[0] as Record<
            string,
            unknown
          >),
          budgetCents: 999999,
        },
      ],
      synthesis: {
        ...((validPlanContent() as Record<string, unknown>).synthesis as Record<string, unknown>),
        budgetCents: 999999,
      },
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
    });

    const harness = new PlannerTestHarness({ vectors: [{ content: overBudgetPlan }] });
    const planner = new PlannerService(db, { generator: harness, maxAttempts: 1 });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    const row = await getRunRow(db, runId);
    expect(row!.status).not.toBe('awaiting_approval');
    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(0);
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings).toHaveLength(0);

    await coordinator.release(claim!);
    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-025: Complex run halts before execution
// ---------------------------------------------------------------------------

describe('VAL-PLAN-025: Complex run halts before execution', () => {
  it('awaiting_approval run stays put with no execution events', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-halt');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // Publish a valid plan via the harness.
    const harness = new PlannerTestHarness({ vectors: [{ content: validPlanContent() }] });
    const planner = new PlannerService(db, { generator: harness });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');

    // No execution/child/tool/synthesis/artifact events.
    const events = await getEvents(db, runId);
    const forbiddenTypes = [
      'execution.started',
      'execution.progress',
      'child.created',
      'tool.started',
      'synthesis.started',
      'artifact.committed',
    ];
    for (const ft of forbiddenTypes) {
      expect(events.find((e) => e.type === ft)).toBeUndefined();
    }

    // Now let a worker poll — the run should NOT be claimed for execution.
    await coordinator.release(claim!);
    const claim2 = await coordinator.claimNext('test-worker-2');
    expect(claim2).toBeNull(); // awaiting_approval is not claimable

    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-027: Worker cannot bypass approval
// ---------------------------------------------------------------------------

describe('VAL-PLAN-027: Worker cannot bypass approval', () => {
  it('restarted worker does not claim an awaiting_approval run', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-bypass');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    const harness = new PlannerTestHarness({ vectors: [{ content: validPlanContent() }] });
    const planner = new PlannerService(db, { generator: harness });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('worker-A');
    expect(claim).not.toBeNull();
    await planner.plan(claim!, new AbortController().signal);
    await coordinator.release(claim!);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');

    // Simulate a worker restart: a new coordinator (new worker) tries to claim.
    const coordinator2 = new RunCoordinator(db);
    const claimAfterRestart = await coordinator2.claimNext('worker-B');
    expect(claimAfterRestart).toBeNull(); // Cannot bypass approval

    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    // No execution events after restart attempt.
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'execution.started')).toBeUndefined();
    expect(events.find((e) => e.type === 'tool.started')).toBeUndefined();

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-103: Proposal and governance gate are atomically linked
// ---------------------------------------------------------------------------

describe('VAL-PLAN-103: Proposal and governance gate are atomically linked', () => {
  it('publishing creates exactly one revision and one unresolved gate approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-atomic');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    const harness = new PlannerTestHarness({ vectors: [{ content: validPlanContent() }] });
    const planner = new PlannerService(db, { generator: harness });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    // Exactly one revision, one binding, one pending approval.
    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].status).toBe('proposed');

    const bindings = await getApprovalBindings(db, runId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].decision).toBeNull(); // unresolved

    const approval = await getApproval(db, bindings[0].approvalId);
    expect(approval).not.toBeNull();
    expect(approval!.kind).toBe('plan_gate');
    expect(approval!.status).toBe('pending');
    expect(approval!.payload['runId']).toBe(runId);
    expect(approval!.payload['planRevisionId']).toBe(revisions[0].id);
    expect(approval!.payload['contentHash']).toBe(revisions[0].contentHash);

    // The run's currentPlanRevisionId matches.
    const row = await getRunRow(db, runId);
    expect(row!.currentPlanRevisionId).toBe(revisions[0].id);
    expect(row!.status).toBe('awaiting_approval');

    // plan.proposed event exists.
    const events = await getEvents(db, runId);
    const proposedEvent = events.find((e) => e.type === 'plan.proposed');
    expect(proposedEvent).toBeDefined();
    expect((proposedEvent!.payload as Record<string, unknown>)['revisionId']).toBe(revisions[0].id);

    await coordinator.release(claim!);
    await closeTestDb();
  });

  it('a fault between internal writes exposes neither plan nor orphan approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-fault');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // Inject a failpoint that throws after the revision is inserted but
    // before the approval/binding is created.
    const harness = new PlannerTestHarness({
      vectors: [
        {
          content: validPlanContent(),
        },
      ],
    });
    const planner = new PlannerService(db, {
      generator: harness,
    });

    // We need to inject the failpoint at the publication level. Use a custom
    // generator that wraps the harness and injects a failpoint hook via the
    // publication service directly.
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    // Manually invoke the publication with a failpoint that throws after
    // the revision insert — simulating a persistence fault.
    const publicationService = new PlanPublicationService(db);
    const runRow = (await db.drizzle.execute(sql`
      SELECT * FROM "mission_runs" WHERE "id" = ${runId} FOR UPDATE
    `)) as unknown as Array<Record<string, unknown>>;
    expect(runRow[0]).toBeDefined();

    // Map to the expected shape.
    const rawRow = runRow[0];
    const mappedRun = {
      id: rawRow['id'] as string,
      companyId: rawRow['company_id'] as string,
      projectId: rawRow['project_id'] as string,
      projectThreadId: rawRow['project_thread_id'] as string,
      rootRunId: rawRow['root_run_id'] as string,
      parentRunId: (rawRow['parent_run_id'] as string) ?? null,
      retryOfRunId: (rawRow['retry_of_run_id'] as string) ?? null,
      depth: rawRow['depth'] as number,
      childOrdinal: (rawRow['child_ordinal'] as number) ?? null,
      initiatingUserId: (rawRow['initiating_user_id'] as string) ?? null,
      initiatingAgentId: (rawRow['initiating_agent_id'] as string) ?? null,
      executingAgentId: (rawRow['executing_agent_id'] as string) ?? null,
      billingAgentId: (rawRow['billing_agent_id'] as string) ?? null,
      routingKind: rawRow['routing_kind'] as 'company_agent' | 'ephemeral',
      requestEnvelope: rawRow['request_envelope'] as string,
      requestContentHash: rawRow['request_content_hash'] as string,
      requestSafeSummary: (rawRow['request_safe_summary'] as string) ?? null,
      modeProfileId: (rawRow['mode_profile_id'] as string) ?? null,
      resolvedMode: rawRow['resolved_mode'] as 'fast' | 'deep_work' | 'analyst' | 'auto' | 'custom',
      policySnapshotId: (rawRow['policy_snapshot_id'] as string) ?? null,
      status: rawRow['status'] as
        | 'running'
        | 'queued'
        | 'draft'
        | 'awaiting_input'
        | 'planning'
        | 'awaiting_approval'
        | 'synthesizing'
        | 'completed'
        | 'failed'
        | 'cancelled',
      stateVersion: rawRow['state_version'] as number,
      lastEventSequence: Number(rawRow['last_event_sequence']),
      waitingFromStatus: (rawRow['waiting_from_status'] as 'running' | 'planning' | null) ?? null,
      currentQuestionSetId: (rawRow['current_question_set_id'] as string) ?? null,
      currentPlanRevisionId: (rawRow['current_plan_revision_id'] as string) ?? null,
      approvedPlanRevisionId: (rawRow['approved_plan_revision_id'] as string) ?? null,
      partialResultPolicy: rawRow['partial_result_policy'] as 'require_all' | 'best_effort',
      availableAt: (rawRow['available_at'] as Date) ?? null,
      leaseOwner: (rawRow['lease_owner'] as string) ?? null,
      leaseToken: (rawRow['lease_token'] as string) ?? null,
      leaseExpiresAt: (rawRow['lease_expires_at'] as Date) ?? null,
      heartbeatAt: (rawRow['heartbeat_at'] as Date) ?? null,
      attemptCount: rawRow['attempt_count'] as number,
      providerCallCount: rawRow['provider_call_count'] as number,
      descendantCount: rawRow['descendant_count'] as number,
      inputTokens: rawRow['input_tokens'] as number,
      outputTokens: rawRow['output_tokens'] as number,
      outputBytes: rawRow['output_bytes'] as number,
      actualCostCents: rawRow['actual_cost_cents'] as number,
      cancelRequestedAt: (rawRow['cancel_requested_at'] as Date) ?? null,
      cancelRequestedBy: (rawRow['cancel_requested_by'] as string) ?? null,
      cancellationDeadlineAt: (rawRow['cancellation_deadline_at'] as Date) ?? null,
      failureCategory: (rawRow['failure_category'] as string) ?? null,
      failureCode: (rawRow['failure_code'] as string) ?? null,
      safeErrorMessage: (rawRow['safe_error_message'] as string) ?? null,
      resultCompleteness: (rawRow['result_completeness'] as 'full' | 'partial') ?? null,
      startedAt: (rawRow['started_at'] as Date) ?? null,
      terminalAt: (rawRow['terminal_at'] as Date) ?? null,
      createdAt: rawRow['created_at'] as Date,
      updatedAt: rawRow['updated_at'] as Date,
    };

    // Attempt publication with a failpoint that throws after revision insert.
    await expect(
      db.drizzle.transaction(async (tx) => {
        await publicationService.publishPlanProposal(tx, mappedRun, {
          planContent: validPlanContent(),
          failpointHook: (point) => {
            if (point === 'after_revision') {
              throw new Error('SIMULATED_PERSISTENCE_FAULT');
            }
          },
        });
      }),
    ).rejects.toThrow('SIMULATED_PERSISTENCE_FAULT');

    // The transaction rolled back: no revision, no binding, no approval.
    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(0);
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings).toHaveLength(0);

    // No plan_gate approvals for this run.
    const approvalRows = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS cnt FROM "approvals"
      WHERE "company_id" = ${companyId} AND "kind" = 'plan_gate'
        AND ("payload"->>'runId') = ${runId}
    `)) as unknown as Array<{ cnt: number }>;
    expect(approvalRows[0]?.cnt).toBe(0);

    // The run stays in planning (not awaiting_approval).
    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('planning');

    await coordinator.release(claim!);
    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-106: Preapproval effect ledger contains only declared planning work
// ---------------------------------------------------------------------------

describe('VAL-PLAN-106: Preapproval effect ledger contains only declared planning work', () => {
  it('before approval, no children/tools/artifacts/synthesis events exist', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-ledger');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    const harness = new PlannerTestHarness({ vectors: [{ content: validPlanContent() }] });
    const planner = new PlannerService(db, { generator: harness });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    await planner.plan(claim!, new AbortController().signal);

    // Verify the preapproval ledger via the publication service.
    const publicationService = new PlanPublicationService(db);
    const ledger = await publicationService.verifyPreapprovalLedger(companyId, runId);
    expect(ledger.ok).toBe(true);
    expect(ledger.violations).toHaveLength(0);

    // No child runs, no tool invocations, no artifacts.
    const childRows = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS cnt FROM "mission_runs" WHERE "parent_run_id" = ${runId}
    `)) as unknown as Array<{ cnt: number }>;
    expect(childRows[0]?.cnt).toBe(0);

    const toolCount = await countRows(db, 'run_tool_invocations', runId);
    expect(toolCount).toBe(0);

    await coordinator.release(claim!);
    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-114: Planner failures recover without ghost plans
// ---------------------------------------------------------------------------

describe('VAL-PLAN-114: Planner failures recover without ghost plans', () => {
  it('transient failure then success publishes one plan (no ghost)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-recover');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // First attempt: transient failure. Second attempt: valid plan.
    const harness = new PlannerTestHarness({
      vectors: [
        { content: validPlanContent(), failpoint: { kind: 'transient_failure' } },
        { content: validPlanContent() },
      ],
    });
    const planner = new PlannerService(db, { generator: harness, maxAttempts: 3 });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');

    // Exactly one revision (no ghost from the failed attempt).
    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(1);

    // Exactly one binding.
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings).toHaveLength(1);

    await coordinator.release(claim!);
    await closeTestDb();
  });

  it('malformed output then success publishes one plan', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-malformed');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    const harness = new PlannerTestHarness({
      vectors: [
        { content: validPlanContent(), failpoint: { kind: 'malformed_output' } },
        { content: validPlanContent() },
      ],
    });
    const planner = new PlannerService(db, { generator: harness, maxAttempts: 3 });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');
    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(1);

    await coordinator.release(claim!);
    await closeTestDb();
  });

  it('retry exhaustion terminalizes the run with no ghost plan', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-exhaust');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // All attempts fail transiently.
    const harness = new PlannerTestHarness({
      vectors: [],
      globalFailpoint: { kind: 'transient_failure' },
    });
    const planner = new PlannerService(db, { generator: harness, maxAttempts: 2 });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('failed');
    expect(row!.failureCategory).toBe('provider_transient');

    // No ghost plan.
    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(0);
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings).toHaveLength(0);

    await coordinator.release(claim!);
    await closeTestDb();
  });

  it('permanent failure terminalizes immediately with no ghost plan', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-permanent');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    const harness = new PlannerTestHarness({
      vectors: [],
      globalFailpoint: { kind: 'permanent_failure' },
    });
    const planner = new PlannerService(db, { generator: harness, maxAttempts: 3 });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('failed');
    expect(row!.failureCategory).toBe('provider_permanent');

    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(0);

    await coordinator.release(claim!);
    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-130: Planner validation uses one nonproduction harness
// ---------------------------------------------------------------------------

describe('VAL-PLAN-130: Planner validation uses one nonproduction harness', () => {
  it('harness cannot be constructed without the test flag', async () => {
    disableHarness();
    expect(isTestHarnessEnabled()).toBe(false);
    expect(() => new PlannerTestHarness({ vectors: [] })).toThrow('test-only');
  });

  it('harness can be constructed with the test flag', async () => {
    enableHarness();
    expect(isTestHarnessEnabled()).toBe(true);
    const harness = new PlannerTestHarness({ vectors: [{ content: validPlanContent() }] });
    expect(harness).toBeDefined();
  });

  it('harness injects deterministic plan vectors through production validators', async () => {
    enableHarness();
    const db = await createTestDb();
    enableMissionFlag();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-harness');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // The harness injects a specific plan vector. The production validators
    // (plan-schema.ts) validate it, and the production publication service
    // publishes it through real Postgres transactions.
    const harness = new PlannerTestHarness({ vectors: [{ content: validPlanContent() }] });
    const planner = new PlannerService(db, { generator: harness });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    // The injected plan went through production validation and was published.
    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');

    const revisions = await getPlanRevisions(db, runId);
    expect(revisions).toHaveLength(1);

    // The content hash matches what production canonicalization produces.
    const validated = validatePlan(validPlanContent());
    const expectedHash = planContentHash(validated);
    expect(revisions[0].contentHash).toBe(expectedHash);

    await coordinator.release(claim!);
    await closeTestDb();
  });

  it('harness failpoints simulate planner faults at the generation boundary', async () => {
    enableHarness();
    const db = await createTestDb();
    enableMissionFlag();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-harness-fp');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // Inject a timeout failpoint, then a valid plan.
    const harness = new PlannerTestHarness({
      vectors: [
        { content: validPlanContent(), failpoint: { kind: 'timeout' } },
        { content: validPlanContent() },
      ],
    });
    const planner = new PlannerService(db, { generator: harness, maxAttempts: 3 });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();

    await planner.plan(claim!, new AbortController().signal);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');

    // The harness was called twice (timeout + success).
    expect(harness.calls).toBe(2);

    await coordinator.release(claim!);
    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-026: Preapproval planning research is read only
// ---------------------------------------------------------------------------

describe('VAL-PLAN-026: Preapproval planning research is read only', () => {
  it('preapproval ledger verification confirms no side-effecting effects', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-preapproval');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;

    // Inject a plan that declares read-only research tools (preapproval_read_only).
    const planWithResearch = validPlanContent({
      steps: [
        {
          ...((validPlanContent() as Record<string, unknown[]>).steps[0] as Record<
            string,
            unknown
          >),
          toolAllowlist: ['research.search'],
          replayClass: 'read_only',
          sideEffecting: false,
        },
      ],
    });

    const harness = new PlannerTestHarness({ vectors: [{ content: planWithResearch }] });
    const planner = new PlannerService(db, { generator: harness });
    const coordinator = new RunCoordinator(db);
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    await planner.plan(claim!, new AbortController().signal);

    // The plan is published with read-only research tools.
    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');

    // Verify the preapproval ledger: no side-effecting tools, children, artifacts.
    const publicationService = new PlanPublicationService(db);
    const ledger = await publicationService.verifyPreapprovalLedger(companyId, runId);
    expect(ledger.ok).toBe(true);

    // No children created.
    const childRows = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS cnt FROM "mission_runs" WHERE "parent_run_id" = ${runId}
    `)) as unknown as Array<{ cnt: number }>;
    expect(childRows[0]?.cnt).toBe(0);

    // No tool invocations.
    const toolCount = await countRows(db, 'run_tool_invocations', runId);
    expect(toolCount).toBe(0);

    await coordinator.release(claim!);
    await closeTestDb();
  });
});
