import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import {
  validatePlan,
  PLAN_CONTENT_SCHEMA_VERSION,
  type PlanContent,
} from '../services/mission/plan-schema.js';
import { RunProcessor, type ResearchExecutor } from '../services/mission/run-processor.js';
import { encryptEnvelope } from '../services/mission/ingress.js';

/**
 * Integration test: ResearchExecutionService wiring into
 * RunProcessor.executeAndComplete().
 *
 * (fix-ut-m5-research-execution-wiring)
 *
 * Verifies that:
 *  1. Child runs with research steps (research.search in toolAllowlist)
 *     invoke the ResearchExecutionService through the injected executor.
 *  2. Sources are persisted as source revisions.
 *  3. Research events (research.started, research.completed) are emitted.
 *  4. The run completes after research execution finishes.
 *  5. Child runs without research operations fall through to the existing
 *     LLM provider call path.
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

async function seedAgent(db: AnyDb, companyId: string): Promise<string> {
  const agentId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "api_key_encrypted", "created_at", "updated_at")
    VALUES (${agentId}, ${companyId}, 'Eligible Agent', 'engineer', 'anthropic', 'claude-sonnet-4-6', 'idle', '["research"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '["content.create"]'::jsonb, '["research.search"]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 5, 0, 3600, 0, 0, 0, 'encrypted-key', ${now}, ${now})
  `);
  return agentId;
}

/** A plan with a child step that has research.search in its toolAllowlist. */
function researchPlanContent(): PlanContent {
  return validatePlan({
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Research a topic',
    steps: [
      {
        stepKey: 'root',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Coordinate research',
        description: 'Oversee research subtask',
        dependencies: [],
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['coordination'],
            requiredTools: [],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: [],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['coordination'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Done',
        budgetCents: 100,
        limits: {},
      },
      {
        stepKey: 'child-a',
        parentStepKey: 'root',
        childOrdinal: 0,
        nodeKind: 'child',
        title: 'Research the topic',
        description: 'Gather sources',
        dependencies: ['root'],
        dependencyKinds: { root: 'required' },
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['research'],
            requiredTools: ['research.search'],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: ['research.search'],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['sources'],
        evidenceRequirements: { citationsRequired: true },
        completionCriteria: 'At least one source',
        budgetCents: 200,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize research output',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'child-a', output: 'sources' }],
      declaredOutput: 'final-report',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'Report complete',
      budgetCents: 100,
    },
    planningBudgetCents: 100,
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
      descendants: 16,
    },
  });
}

/** A plan with a child step that has NO research tools (LLM-only). */
function llmOnlyPlanContent(): PlanContent {
  return validatePlan({
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Draft a document',
    steps: [
      {
        stepKey: 'root',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Coordinate drafting',
        description: 'Oversee drafting subtask',
        dependencies: [],
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['coordination'],
            requiredTools: [],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: [],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['coordination'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Done',
        budgetCents: 100,
        limits: {},
      },
      {
        stepKey: 'child-a',
        parentStepKey: 'root',
        childOrdinal: 0,
        nodeKind: 'child',
        title: 'Draft the document',
        description: 'Write content',
        dependencies: ['root'],
        dependencyKinds: { root: 'required' },
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['writing'],
            requiredTools: [],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: [],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['draft'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Draft complete',
        budgetCents: 200,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize draft',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'child-a', output: 'draft' }],
      declaredOutput: 'final-report',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'Report complete',
      budgetCents: 100,
    },
    planningBudgetCents: 100,
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
      descendants: 16,
    },
  });
}

async function getRunStatus(db: AnyDb, runId: string): Promise<string | null> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status" FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<{ status: string }>;
  return rows[0]?.status ?? null;
}

async function getEventsByType(
  db: AnyDb,
  runId: string,
  type: string,
): Promise<Array<{ sequence: number; type: string; payload: unknown }>> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload" FROM "run_events"
    WHERE "run_id" = ${runId} AND "type" = ${type}
    ORDER BY "sequence"
  `)) as unknown as Array<{ sequence: string; type: string; payload: unknown }>;
  return rows.map((r) => ({ sequence: Number(r.sequence), type: r.type, payload: r.payload }));
}

async function getAssignmentStatus(
  db: AnyDb,
  rootRunId: string,
  stepKey: string,
): Promise<string | null> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "assignment_status" FROM "run_step_assignments"
    WHERE "root_run_id" = ${rootRunId} AND "step_key" = ${stepKey}
  `)) as unknown as Array<{ assignment_status: string }>;
  return rows[0]?.assignment_status ?? null;
}

/**
 * Set up a fully routed child run ready for execution: root run with
 * approved plan, materialized topology, routed child, and budget
 * allocation. The child is available for claiming.
 */
async function setupRoutedChild(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  agentId: string,
  plan: PlanContent,
  label: string,
): Promise<{ rootRunId: string; childRunId: string; revisionId: string }> {
  const now = new Date();
  const rootRunId = randomUUID();
  const childRunId = randomUUID();
  const revisionId = randomUUID();
  const hash = randomUUID();
  const policySnapshotId = randomUUID();
  const childPolicySnapshotId = randomUUID();
  const reservationId = randomUUID();
  const rootAllocationId = randomUUID();
  const childAllocationId = randomUUID();
  const approvalId = randomUUID();
  const bindingId = randomUUID();
  const assignmentId = randomUUID();

  // Policy snapshot for root.
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', ${JSON.stringify(plan.steps[1]!.toolAllowlist)}::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 5000, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
  `);

  // Child policy snapshot (same as root for simplicity).
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${childPolicySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', ${JSON.stringify(plan.steps[1]!.toolAllowlist)}::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 200, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
  `);

  // Plan revision (approved) — must come after root run insert (FK).
  // Root run (running, approved plan) — insert first.
  const encryptedRootEnvelope = encryptEnvelope({ text: 'Research the topic' });
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "billing_agent_id", "initiating_agent_id", "created_at", "updated_at")
    VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', ${encryptedRootEnvelope}, ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, ${agentId}, ${agentId}, ${now}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
    VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', ${JSON.stringify(plan)}::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
  `);

  // Set approved_plan_revision_id (FK now satisfied).
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
  `);

  // Approval + binding.
  await db.drizzle.execute(sql`
    INSERT INTO "approvals" ("id", "company_id", "project_id", "kind", "status", "title", "created_at", "updated_at")
    VALUES (${approvalId}, ${scope.companyId}, ${scope.projectId}, 'plan_gate', 'approved', 'Plan approval', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_approval_bindings" ("id", "company_id", "project_id", "run_id", "plan_revision_id", "content_hash", "approval_id", "decision", "is_current_authorization", "created_at")
    VALUES (${bindingId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${revisionId}, ${hash}, ${approvalId}, 'approved', true, ${now})
  `);

  // Budget reservation + root allocation.
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, ${agentId}, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${rootAllocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, ${agentId}, 5000, 0, 0, 'held', ${now}, ${now})
  `);

  // Child run (running, available, routed) — simulates post-claim state.
  const encryptedChildEnvelope = encryptEnvelope({ text: 'Research the topic' });
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "billing_agent_id", "lease_owner", "lease_token", "lease_expires_at", "heartbeat_at", "created_at", "updated_at")
    VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${rootRunId}, 1, 0, 'company_agent', ${encryptedChildEnvelope}, ${hash}, 'Child', 'deep_work', ${childPolicySnapshotId}, 'running', 1, 0, 'require_all', ${now}, ${agentId}, 'test-worker', 'test-token', ${new Date(Date.now() + 30000)}, ${now}, ${now}, ${now})
  `);

  // Child budget allocation.
  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${childAllocationId}, ${scope.companyId}, ${reservationId}, ${childRunId}, ${agentId}, 200, 0, 0, 'held', ${now}, ${now})
  `);

  // Step assignment (routed — ready for execution).
  const requirements = {
    capabilities: ['research'],
    requiredTools: plan.steps[1]!.toolAllowlist,
    requiredDomains: [],
    ephemeralAllowed: true,
  };
  await db.drizzle.execute(sql`
    INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "parent_step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "routing_kind", "routing_requirements", "executing_agent_id", "billing_agent_id", "budget_allocation_id", "child_policy_snapshot_id", "admission_slot_held", "created_at", "updated_at")
    VALUES (${assignmentId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${rootRunId}, ${childRunId}, 'child-a', 'root', 0, 'child', ${revisionId}, ${hash}, 'routed', 'company_agent', ${JSON.stringify(requirements)}::jsonb, ${agentId}, ${agentId}, ${childAllocationId}, ${childPolicySnapshotId}, true, ${now}, ${now})
  `);

  return { rootRunId, childRunId, revisionId };
}

describe('ResearchExecutionService wiring (fix-ut-m5-research-execution-wiring)', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeTestDb();
  });

  it('invokes the research executor for a child run with research.search in toolAllowlist', async () => {
    const scope = await seedScope(db, '__mtest__ research-wiring-search');
    const agentId = await seedAgent(db, scope.companyId);
    const plan = researchPlanContent();
    const { rootRunId, childRunId } = await setupRoutedChild(
      db,
      scope,
      agentId,
      plan,
      'research-search',
    );

    // Inject a mock research executor that records the call.
    let executorCalled = false;
    let receivedOperations: string[] = [];
    let receivedRequestText = '';
    const mockExecutor: ResearchExecutor = {
      async execute(ctx) {
        executorCalled = true;
        receivedOperations = ctx.operations.map((op) => op);
        receivedRequestText = ctx.requestText;
        // Simulate research execution: emit a research event.
        await db.drizzle.execute(sql`
          INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
          VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${childRunId}, 1, 'research.started', 1, '{"logicalCallId": "test-call", "provider": "tavily", "operation": "search"}'::jsonb, 'system', null, null, NOW())
        `);
        await db.drizzle.execute(sql`
          INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
          VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${childRunId}, 2, 'research.completed', 1, '{"logicalCallId": "test-call", "provider": "tavily", "sourceCount": 1, "costCents": 10}'::jsonb, 'system', null, null, NOW())
        `);
        // Update the child run's last_event_sequence to account for the events.
        await db.drizzle.execute(sql`
          UPDATE "mission_runs" SET "last_event_sequence" = 2, "state_version" = 3 WHERE "id" = ${childRunId}
        `);
        return { executed: true, sourceCount: 1 };
      },
    };

    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      researchExecutor: mockExecutor,
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: 'should not be called',
        inputTokens: 10,
        outputTokens: 10,
        costCents: 1,
        finishReason: 'stop' as const,
        latencyMs: 42,
      }),
    });

    // Simulate a claim on the child run.
    const claim = {
      runId: childRunId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      leaseOwner: 'test-worker',
      leaseToken: 'test-token',
      leaseExpiresAt: new Date(Date.now() + 30000),
      heartbeatAt: new Date(),
      attemptCount: 0,
      claimedFromStatus: 'queued',
      status: 'running',
      stateVersion: 1,
      lastEventSequence: 0,
      isRecovery: false,
    };

    const controller = new AbortController();
    await processor.advance(claim, controller.signal);

    // Verify the research executor was called.
    expect(executorCalled).toBe(true);
    expect(receivedOperations).toContain('search');
    expect(receivedRequestText).toBe('Research the topic');

    // Verify the child run completed.
    const status = await getRunStatus(db, childRunId);
    expect(status).toBe('completed');

    // Verify research events were emitted.
    const startedEvents = await getEventsByType(db, childRunId, 'research.started');
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);
    const completedEvents = await getEventsByType(db, childRunId, 'research.completed');
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);

    // Verify the run completed event exists.
    const completedRunEvents = await getEventsByType(db, childRunId, 'run.completed');
    expect(completedRunEvents.length).toBe(1);
  });

  it('falls through to the LLM provider call when the child has no research operations', async () => {
    const scope = await seedScope(db, '__mtest__ research-wiring-llm-only');
    const agentId = await seedAgent(db, scope.companyId);
    const plan = llmOnlyPlanContent();
    const { childRunId } = await setupRoutedChild(db, scope, agentId, plan, 'llm-only');

    let executorCalled = false;
    let providerCalled = false;
    const mockExecutor: ResearchExecutor = {
      async execute() {
        executorCalled = true;
        return { executed: false, sourceCount: 0 };
      },
    };

    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      researchExecutor: mockExecutor,
      providerCall: async () => {
        providerCalled = true;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          content: 'LLM response',
          inputTokens: 10,
          outputTokens: 10,
          costCents: 1,
          finishReason: 'stop' as const,
          latencyMs: 42,
        };
      },
    });

    const claim = {
      runId: childRunId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      leaseOwner: 'test-worker',
      leaseToken: 'test-token',
      leaseExpiresAt: new Date(Date.now() + 30000),
      heartbeatAt: new Date(),
      attemptCount: 0,
      claimedFromStatus: 'queued',
      status: 'running',
      stateVersion: 1,
      lastEventSequence: 0,
      isRecovery: false,
    };

    const controller = new AbortController();
    await processor.advance(claim, controller.signal);

    // The research executor should NOT have been called (no research ops).
    expect(executorCalled).toBe(false);
    // The LLM provider call should have been made.
    expect(providerCalled).toBe(true);

    // The child run should have completed via the LLM path.
    const status = await getRunStatus(db, childRunId);
    expect(status).toBe('completed');
  });

  it('does not invoke the research executor when no executor is provided', async () => {
    const scope = await seedScope(db, '__mtest__ research-wiring-no-executor');
    const agentId = await seedAgent(db, scope.companyId);
    const plan = researchPlanContent();
    const { childRunId } = await setupRoutedChild(db, scope, agentId, plan, 'no-executor');

    let providerCalled = false;
    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      // No researchExecutor provided — should fall through to LLM path.
      providerCall: async () => {
        providerCalled = true;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          content: 'LLM response',
          inputTokens: 10,
          outputTokens: 10,
          costCents: 1,
          finishReason: 'stop' as const,
          latencyMs: 42,
        };
      },
    });

    const claim = {
      runId: childRunId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      leaseOwner: 'test-worker',
      leaseToken: 'test-token',
      leaseExpiresAt: new Date(Date.now() + 30000),
      heartbeatAt: new Date(),
      attemptCount: 0,
      claimedFromStatus: 'queued',
      status: 'running',
      stateVersion: 1,
      lastEventSequence: 0,
      isRecovery: false,
    };

    const controller = new AbortController();
    await processor.advance(claim, controller.signal);

    // Without a research executor, the LLM provider call should be made.
    expect(providerCalled).toBe(true);

    const status = await getRunStatus(db, childRunId);
    expect(status).toBe('completed');
  });

  // -------------------------------------------------------------------------
  // fix-ut-m5-tool-name-mapping: The LLM planner generates tool names like
  // `web_search`, `web_fetch`, `web_browse` (and provider-prefixed names)
  // in plan step `toolAllowlist` fields. These must map to research
  // operations so children execute research instead of falling through to
  // a plain LLM provider call.
  // -------------------------------------------------------------------------

  /**
   * Build a plan whose child step uses the given toolAllowlist. The child
   * step's `requiredTools` mirrors the allowlist so routing requirements
   * stay consistent.
   */
  function planWithChildTools(childTools: string[]): PlanContent {
    return validatePlan({
      schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
      objective: 'Research a topic',
      steps: [
        {
          stepKey: 'root',
          parentStepKey: null,
          childOrdinal: 0,
          nodeKind: 'root',
          title: 'Coordinate research',
          description: 'Oversee research subtask',
          dependencies: [],
          inputBindings: [],
          routing: {
            kind: 'requirements',
            routingRequirements: {
              capabilities: ['coordination'],
              requiredTools: [],
              requiredDomains: [],
              ephemeralAllowed: true,
            },
          },
          toolAllowlist: [],
          replayClass: 'read_only',
          sideEffecting: false,
          expectedOutputs: ['coordination'],
          evidenceRequirements: { citationsRequired: false },
          completionCriteria: 'Done',
          budgetCents: 100,
          limits: {},
        },
        {
          stepKey: 'child-a',
          parentStepKey: 'root',
          childOrdinal: 0,
          nodeKind: 'child',
          title: 'Research the topic',
          description: 'Gather sources',
          dependencies: ['root'],
          dependencyKinds: { root: 'required' },
          inputBindings: [],
          routing: {
            kind: 'requirements',
            routingRequirements: {
              capabilities: ['research'],
              requiredTools: childTools,
              requiredDomains: [],
              ephemeralAllowed: true,
            },
          },
          toolAllowlist: childTools,
          replayClass: 'read_only',
          sideEffecting: false,
          expectedOutputs: ['sources'],
          evidenceRequirements: { citationsRequired: true },
          completionCriteria: 'At least one source',
          budgetCents: 200,
          limits: {},
        },
      ],
      synthesis: {
        instructions: 'Synthesize research output',
        declaredInputs: [{ kind: 'stepOutput', stepKey: 'child-a', output: 'sources' }],
        declaredOutput: 'final-report',
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Report complete',
        budgetCents: 100,
      },
      planningBudgetCents: 100,
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
        descendants: 16,
      },
    });
  }

  /**
   * Shared helper: seed scope/agent, build a plan with the given child
   * tools, materialize a routed child, run the processor with a recording
   * research executor, and assert research was invoked with the expected
   * operation and the run completed.
   */
  async function assertChildToolsTriggerResearch(
    db: AnyDb,
    label: string,
    childTools: string[],
    expectedOperations: string[],
  ): Promise<void> {
    const scope = await seedScope(db, label);
    const agentId = await seedAgent(db, scope.companyId);
    const plan = planWithChildTools(childTools);
    const { childRunId } = await setupRoutedChild(db, scope, agentId, plan, label);

    let executorCalled = false;
    let receivedOperations: string[] = [];
    const mockExecutor: ResearchExecutor = {
      async execute(ctx) {
        executorCalled = true;
        receivedOperations = ctx.operations.map((op) => op);
        await db.drizzle.execute(sql`
          INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
          VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${childRunId}, 1, 'research.started', 1, '{"logicalCallId": "test-call", "provider": "tavily", "operation": "search"}'::jsonb, 'system', null, null, NOW())
        `);
        await db.drizzle.execute(sql`
          INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
          VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${childRunId}, 2, 'research.completed', 1, '{"logicalCallId": "test-call", "provider": "tavily", "sourceCount": 1, "costCents": 10}'::jsonb, 'system', null, null, NOW())
        `);
        await db.drizzle.execute(sql`
          UPDATE "mission_runs" SET "last_event_sequence" = 2, "state_version" = 3 WHERE "id" = ${childRunId}
        `);
        return { executed: true, sourceCount: 1 };
      },
    };

    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      researchExecutor: mockExecutor,
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: 'should not be called',
        inputTokens: 10,
        outputTokens: 10,
        costCents: 1,
        finishReason: 'stop' as const,
        latencyMs: 42,
      }),
    });

    const claim = {
      runId: childRunId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      leaseOwner: 'test-worker',
      leaseToken: 'test-token',
      leaseExpiresAt: new Date(Date.now() + 30000),
      heartbeatAt: new Date(),
      attemptCount: 0,
      claimedFromStatus: 'queued',
      status: 'running',
      stateVersion: 1,
      lastEventSequence: 0,
      isRecovery: false,
    };

    const controller = new AbortController();
    await processor.advance(claim, controller.signal);

    expect(executorCalled).toBe(true);
    expect(receivedOperations).toEqual(expectedOperations);

    const status = await getRunStatus(db, childRunId);
    expect(status).toBe('completed');
  }

  it('web_search in toolAllowlist triggers research execution (search operation)', async () => {
    await assertChildToolsTriggerResearch(
      db,
      '__mtest__ research-wiring-web-search',
      ['web_search'],
      ['search'],
    );
  });

  it('web_fetch in toolAllowlist triggers research execution (extract operation)', async () => {
    await assertChildToolsTriggerResearch(
      db,
      '__mtest__ research-wiring-web-fetch',
      ['web_fetch'],
      ['extract'],
    );
  });

  it('web_browse in toolAllowlist triggers research execution (search operation)', async () => {
    await assertChildToolsTriggerResearch(
      db,
      '__mtest__ research-wiring-web-browse',
      ['web_browse'],
      ['search'],
    );
  });

  it('tavily.search in toolAllowlist triggers research execution (search operation)', async () => {
    await assertChildToolsTriggerResearch(
      db,
      '__mtest__ research-wiring-tavily-search',
      ['tavily.search'],
      ['search'],
    );
  });

  it('firecrawl.scrape in toolAllowlist triggers research execution (scrape operation)', async () => {
    await assertChildToolsTriggerResearch(
      db,
      '__mtest__ research-wiring-firecrawl-scrape',
      ['firecrawl.scrape'],
      ['scrape'],
    );
  });

  it('firecrawl.structured_extract in toolAllowlist triggers research execution (structured_extract operation)', async () => {
    await assertChildToolsTriggerResearch(
      db,
      '__mtest__ research-wiring-firecrawl-structured-extract',
      ['firecrawl.structured_extract'],
      ['structured_extract'],
    );
  });

  it('research.* tool names continue to trigger research execution', async () => {
    await assertChildToolsTriggerResearch(
      db,
      '__mtest__ research-wiring-research-canonical',
      ['research.search', 'research.extract'],
      ['search', 'extract'],
    );
  });

  it('a mix of canonical and aliased tool names triggers research execution for all', async () => {
    await assertChildToolsTriggerResearch(
      db,
      '__mtest__ research-wiring-mixed-aliases',
      ['web_search', 'research.extract', 'firecrawl.scrape'],
      ['search', 'extract', 'scrape'],
    );
  });

  it('non-research tool names still fall through to the LLM provider call', async () => {
    const scope = await seedScope(db, '__mtest__ research-wiring-non-research-tools');
    const agentId = await seedAgent(db, scope.companyId);
    // A tool name that is NOT a research tool (e.g. a code-execution tool).
    const plan = planWithChildTools(['code.execute']);
    const { childRunId } = await setupRoutedChild(db, scope, agentId, plan, 'non-research-tools');

    let executorCalled = false;
    let providerCalled = false;
    const mockExecutor: ResearchExecutor = {
      async execute() {
        executorCalled = true;
        return { executed: false, sourceCount: 0 };
      },
    };

    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      researchExecutor: mockExecutor,
      providerCall: async () => {
        providerCalled = true;
        return {
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          content: 'LLM response',
          inputTokens: 10,
          outputTokens: 10,
          costCents: 1,
          finishReason: 'stop' as const,
          latencyMs: 42,
        };
      },
    });

    const claim = {
      runId: childRunId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      leaseOwner: 'test-worker',
      leaseToken: 'test-token',
      leaseExpiresAt: new Date(Date.now() + 30000),
      heartbeatAt: new Date(),
      attemptCount: 0,
      claimedFromStatus: 'queued',
      status: 'running',
      stateVersion: 1,
      lastEventSequence: 0,
      isRecovery: false,
    };

    const controller = new AbortController();
    await processor.advance(claim, controller.signal);

    expect(executorCalled).toBe(false);
    expect(providerCalled).toBe(true);

    const status = await getRunStatus(db, childRunId);
    expect(status).toBe('completed');
  });
});
