import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import { PlanPublicationService } from '../services/mission/plan-publication.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';

/**
 * GET /mission-runs/:runId/plan exposes the current immutable plan revision
 * content for card rendering (VAL-PLAN-008..017, VAL-PLAN-125).
 *
 * Verifies that the route returns the complete PlanContentV1 (objective,
 * ordered steps, dependencies, routing, tools, outputs, completion
 * criteria, evidence requirements) plus revision metadata, is scoped to
 * company/project (cross-scope 404), and returns 404 PLAN_NOT_FOUND when
 * the run has no current plan revision.
 */

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

/** A valid two-step Analyst evidence plan. */
function analystPlanContent(): unknown {
  return {
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Analyze the quarterly revenue report and produce a cited summary',
    steps: [
      {
        stepKey: 'step-1',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Gather source data',
        description: 'Retrieve quarterly revenue figures',
        dependencies: [],
        inputBindings: [{ name: 'report', source: { kind: 'requestContext', key: 'reportRef' } }],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['research'],
            requiredTools: ['research.search'],
            requiredDomains: ['example.com'],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: ['research.search'],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['sourceSet'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Three independent sources retrieved',
        budgetCents: 500,
        limits: {},
      },
      {
        stepKey: 'step-2',
        parentStepKey: null,
        childOrdinal: 1,
        nodeKind: 'child',
        title: 'Synthesize cited summary',
        description: 'Produce a cited summary',
        dependencies: ['step-1'],
        inputBindings: [
          {
            name: 'sources',
            source: { kind: 'stepOutput', stepKey: 'step-1', output: 'sourceSet' },
          },
        ],
        routing: { kind: 'concreteAgent', executingAgentId: 'agent-42' },
        toolAllowlist: ['artifact.create'],
        replayClass: 'idempotent_write',
        sideEffecting: true,
        expectedOutputs: ['summaryArtifact'],
        evidenceRequirements: { citationsRequired: true },
        completionCriteria: 'Summary committed with inline citations',
        budgetCents: 1000,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Merge step outputs into one cited summary artifact',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-2', output: 'summaryArtifact' }],
      declaredOutput: 'finalSummary',
      evidenceRequirements: { citationsRequired: true },
      completionCriteria: 'Final summary cites every external factual claim',
      budgetCents: 200,
    },
    planningBudgetCents: 50,
    partialResultPolicy: 'require_all',
    limits: {
      steps: 12,
      durationSeconds: 2700,
      providerCalls: 48,
      totalTokens: 300000,
      outputBytes: 8388608,
      costCents: 5000,
      depth: 2,
      fanOut: 4,
      descendants: 12,
    },
    presentationMetadata: { cardTitle: 'Quarterly revenue analysis', summary: 'Two-step plan' },
  };
}

/** Map a raw mission_runs row to the shape publishPlanProposal expects. */
function mapRun(rawRow: Record<string, unknown>) {
  return {
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
}

async function startRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  mode: 'fast' | 'deep_work' | 'analyst' = 'analyst',
) {
  const startService = new MissionStartService(db);
  const start = await startService.start({
    companyId,
    projectId,
    idempotencyKey: `plan-route-${randomUUID()}`,
    body: { projectThreadId: threadId, mode, request: { text: 'Analyze quarterly revenue' } },
    actorType: 'user',
    actorId: 'dev-user-000',
    traceId: `trace-${randomUUID()}`,
  });
  return start.run.id;
}

/** Publish a plan proposal for a run inside a locked transaction. */
async function publishPlan(db: AnyDb, runId: string) {
  const publicationService = new PlanPublicationService(db);
  const runRow = (await db.drizzle.execute(sql`
    SELECT * FROM "mission_runs" WHERE "id" = ${runId} FOR UPDATE
  `)) as unknown as Array<Record<string, unknown>>;
  const mappedRun = mapRun(runRow[0]);
  return db.drizzle.transaction(async (tx) =>
    publicationService.publishPlanProposal(tx, mappedRun, {
      planContent: analystPlanContent(),
      actorType: 'system',
      actorId: null,
      traceId: null,
    }),
  );
}

describe('Mission plan route (GET /:runId/plan)', () => {
  beforeEach(() => enableMissionFlag());
  afterEach(() => vi.unstubAllEnvs());

  it('returns the complete current plan revision content', async () => {
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-route-content');
    const runId = await startRun(db, companyId, projectId, threadId);
    const published = await publishPlan(db, runId);

    const res = await request(app).get(
      `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/plan`,
    );

    expect(res.status).toBe(200);
    const planRevision = res.body.data.planRevision;
    expect(planRevision.id).toBe(published.revisionId);
    expect(planRevision.revision).toBe(1);
    expect(planRevision.status).toBe('proposed');
    expect(planRevision.contentHash).toBe(published.contentHash);
    // Objective (VAL-PLAN-011)
    expect(planRevision.content.objective).toBe(
      'Analyze the quarterly revenue report and produce a cited summary',
    );
    // Ordered steps (VAL-PLAN-012)
    expect(planRevision.content.steps).toHaveLength(2);
    expect(planRevision.content.steps[0].stepKey).toBe('step-1');
    expect(planRevision.content.steps[1].stepKey).toBe('step-2');
    // Dependencies (VAL-PLAN-013)
    expect(planRevision.content.steps[1].dependencies).toEqual(['step-1']);
    // Routing authority vs assignment (VAL-PLAN-014, VAL-PLAN-125)
    expect(planRevision.content.steps[0].routing.kind).toBe('requirements');
    expect(planRevision.content.steps[1].routing.kind).toBe('concreteAgent');
    expect(planRevision.content.steps[1].routing.executingAgentId).toBe('agent-42');
    // Exact tools (VAL-PLAN-015)
    expect(planRevision.content.steps[0].toolAllowlist).toEqual(['research.search']);
    // Expected outputs (VAL-PLAN-016)
    expect(planRevision.content.steps[0].expectedOutputs).toEqual(['sourceSet']);
    // Completion criteria (VAL-PLAN-017)
    expect(planRevision.content.steps[0].completionCriteria).toBe(
      'Three independent sources retrieved',
    );
    // Analyst evidence plan (VAL-PLAN-008)
    expect(planRevision.content.steps[1].evidenceRequirements.citationsRequired).toBe(true);
    expect(planRevision.content.synthesis.evidenceRequirements.citationsRequired).toBe(true);
  });

  it('returns 404 PLAN_NOT_FOUND when the run has no current plan revision', async () => {
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-route-none');
    const runId = await startRun(db, companyId, projectId, threadId, 'fast');

    const res = await request(app).get(
      `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/plan`,
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('PLAN_NOT_FOUND');
  });

  it('returns 404 RUN_NOT_FOUND for a cross-scope run id', async () => {
    const db = await createTestDb();
    const app = await createTestServer(db);
    const { companyId, projectId, threadId } = await seedScope(
      db,
      '__mtest__ plan-route-crossscope',
    );
    const runId = await startRun(db, companyId, projectId, threadId);
    await publishPlan(db, runId);

    // A different company/project scope.
    const other = await seedScope(db, '__mtest__ plan-route-other');

    const res = await request(app).get(
      `/api/companies/${other.companyId}/projects/${other.projectId}/mission-runs/${runId}/plan`,
    );

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });
});
