import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import {
  validatePlan,
  planContentHash,
  PLAN_CONTENT_SCHEMA_VERSION,
  type PlanContent,
} from '../services/mission/plan-schema.js';
import { TopologyMaterializer } from '../services/mission/topology-materializer.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { RunProcessor } from '../services/mission/run-processor.js';
import { encryptEnvelope } from '../services/mission/ingress.js';

/**
 * Integration test: full production path for child runs —
 * claimNext → advance → routing → budget allocation → executeAndComplete → settleBudget.
 *
 * Bug: maybeHandleChildRouting() checked data.run.status !== 'queued', but
 * claimNext() transitions queued→running BEFORE advance() reads the run,
 * so the guard always failed and child routing was never called.
 * BudgetService.allocateChild() was never invoked, so no budget_allocations
 * row was created for the child. BudgetService.settle() then threw
 * BUDGET_ALLOCATION_NOT_FOUND, causing all child runs to fail with
 * PROVIDER_ERROR after 3 retries.
 *
 * Fix: Remove the status guard — the assignment status (pending_routing vs
 * routed) is the authoritative signal. handleChildRouting() already guards
 * on this.
 *
 * Dependency resolution (fix-ut-m5-dependency-resolution):
 * Children in deep_work decomposition are created with assignmentStatus
 * 'pending_dependencies' because they depend on the root orchestration step.
 * No code transitions pending_dependencies → pending_routing, creating a
 * deadlock (children wait for root, root waits for children). The fix adds
 * a dependency-success resolver that transitions assignments from
 * pending_dependencies to pending_routing when their dependencies are
 * satisfied (root step materialized, or predecessor child completed).
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

async function seedAgent(
  db: AnyDb,
  companyId: string,
  opts: {
    capabilities?: string[];
    toolsEnabled?: string[];
    provider?: string;
    status?: string;
    executionTimeoutSeconds?: number;
  } = {},
): Promise<string> {
  const agentId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "api_key_encrypted", "created_at", "updated_at")
    VALUES (${agentId}, ${companyId}, 'Eligible Agent', 'engineer', ${opts.provider ?? 'anthropic'}, 'claude-sonnet-4-6', ${opts.status ?? 'idle'}, ${JSON.stringify(opts.capabilities ?? ['research'])}::jsonb, '{}'::jsonb, '{}'::jsonb, '["content.create"]'::jsonb, ${JSON.stringify(opts.toolsEnabled ?? ['research.search'])}::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 5, 0, ${opts.executionTimeoutSeconds ?? 3600}, 0, 0, 0, 'encrypted-key', ${now}, ${now})
  `);
  return agentId;
}

/** A simple plan: root → one child step (research). */
function singleChildPlanContent(): PlanContent {
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
        dependencies: [],
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

/**
 * A plan with dependency chain: root → child-a (depends on root) → child-b
 * (depends on child-a). This reproduces the production deep_work decomposition
 * scenario where children depend on the root orchestration step.
 *
 * After materialization, child-a should be resolved from pending_dependencies
 * to pending_routing (root step is materialized). After child-a completes,
 * child-b should be resolved from pending_dependencies to pending_routing.
 */
function rootDependencyPlanContent(): PlanContent {
  return validatePlan({
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Research and draft with dependencies on root',
    steps: [
      {
        stepKey: 'root',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Coordinate research and drafting',
        description: 'Oversee research and drafting subtasks',
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
        expectedOutputs: ['root-coordination'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Brief produced',
        budgetCents: 100,
        limits: {},
      },
      {
        stepKey: 'child-a',
        parentStepKey: 'root',
        childOrdinal: 0,
        nodeKind: 'child',
        title: 'Research the topic',
        description: 'Gather cited sources',
        // child-a depends on the root orchestration step (required).
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
      {
        stepKey: 'child-b',
        parentStepKey: 'root',
        childOrdinal: 1,
        nodeKind: 'child',
        title: 'Draft the brief',
        description: 'Synthesize sources into a brief',
        // child-b depends on child-a (required).
        dependencies: ['child-a'],
        dependencyKinds: { 'child-a': 'required' },
        inputBindings: [
          {
            name: 'sources',
            source: { kind: 'stepOutput', stepKey: 'child-a', output: 'sources' },
          },
        ],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['writing'],
            requiredTools: ['artifact.create'],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: ['artifact.create'],
        replayClass: 'idempotent_write',
        sideEffecting: true,
        expectedOutputs: ['brief'],
        evidenceRequirements: { citationsRequired: true },
        completionCriteria: 'Brief references every source',
        budgetCents: 300,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize child outputs into the final brief',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'child-b', output: 'brief' }],
      declaredOutput: 'final-brief',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'Final brief complete',
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

async function getRunStatus(db: AnyDb, runId: string): Promise<string> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "status" FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<{ status: string }>;
  return row?.status ?? 'not_found';
}

async function getAssignmentStatus(
  db: AnyDb,
  rootRunId: string,
  stepKey: string,
): Promise<string | null> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "assignment_status" FROM "run_step_assignments"
    WHERE "root_run_id" = ${rootRunId} AND "step_key" = ${stepKey}
  `)) as unknown as Array<{ assignment_status: string }>;
  return row?.assignment_status ?? null;
}

async function getChildAllocation(db: AnyDb, childRunId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "allocated_cents" AS "allocated", "settled_cents" AS "settled",
           "released_cents" AS "released", "status"
    FROM "budget_allocations" WHERE "run_id" = ${childRunId}
  `)) as unknown as Array<{
    allocated: number;
    settled: number;
    released: number;
    status: string;
  }>;
  return row ?? null;
}

async function countSettlements(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "budget_settlements" WHERE "run_id" = ${runId}
  `)) as unknown as Array<{ c: number }>;
  return row?.c ?? 0;
}

async function getEventsByType(db: AnyDb, runId: string, type: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload" FROM "run_events"
    WHERE "run_id" = ${runId} AND "type" = ${type}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{
    sequence: string | number;
    type: string;
    payload: Record<string, unknown>;
  }>;
  return rows.map((r) => ({ ...r, sequence: Number(r.sequence) }));
}

describe('Child routing budget allocation integration (fix-ut-m5-budget-allocation-child-runs)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ child-routing-budget');
  });

  afterEach(async () => {
    await closeTestDb();
  });

  /**
   * Full production path: claimNext → advance → routing → budget allocation
   * → executeAndComplete → settleBudget.
   *
   * This test verifies that after the fix, a child run created by topology
   * materialization gets routed through AgentRouter when claimed by the
   * production worker, receives a budget allocation, and can execute
   * without 'Budget allocation not found for run' errors.
   */
  it('routes child run, allocates budget, executes, and settles on the full production path', async () => {
    const plan = singleChildPlanContent();
    const hash = planContentHash(plan);
    const now = new Date();

    // Set up an eligible agent for routing.
    const agentId = await seedAgent(db, scope.companyId, {
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      provider: 'anthropic',
      status: 'idle',
    });

    // Set up the root run with an approved plan.
    const rootRunId = randomUUID();
    const revisionId = randomUUID();
    const policySnapshotId = randomUUID();
    const reservationId = randomUUID();
    const rootAllocationId = randomUUID();

    // Insert policy snapshot.
    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', '["research.search"]'::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 5000, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
    `);

    // Insert root run (queued).
    const encryptedRootEnvelope = encryptEnvelope({ text: 'Research a topic' });
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "initiating_agent_id", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', ${encryptedRootEnvelope}, ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, NULL, ${agentId}, ${agentId}, ${now}, ${now})
    `);

    // Insert approved plan revision.
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', ${JSON.stringify(plan)}::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
    `);

    // Set approved_plan_revision_id.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    // Insert approval binding.
    const approvalId = randomUUID();
    const bindingId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "approvals" ("id", "company_id", "project_id", "kind", "status", "title", "created_at", "updated_at")
      VALUES (${approvalId}, ${scope.companyId}, ${scope.projectId}, 'plan_gate', 'approved', 'Plan approval', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_approval_bindings" ("id", "company_id", "project_id", "run_id", "plan_revision_id", "content_hash", "approval_id", "decision", "is_current_authorization", "created_at")
      VALUES (${bindingId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${revisionId}, ${hash}, ${approvalId}, 'approved', true, ${now})
    `);

    // Insert budget reservation + root allocation.
    await db.drizzle.execute(sql`
      INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
      VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, ${agentId}, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
      VALUES (${rootAllocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, ${agentId}, 5000, 0, 0, 'held', ${now}, ${now})
    `);

    // Step 1: Claim the root run and advance to materialize topology.
    const coordinator = new RunCoordinator(db, {
      clock: () => new Date(),
      leaseDurationMs: 30_000,
    });
    const materializer = new TopologyMaterializer(db, { clock: () => new Date() });

    const rootClaim = await coordinator.claimNext('test-worker');
    expect(rootClaim).not.toBeNull();
    expect(rootClaim!.runId).toBe(rootRunId);
    expect(rootClaim!.claimedFromStatus).toBe('queued');
    expect(rootClaim!.status).toBe('running');

    // Advance the root to materialize topology.
    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: 'done',
        inputTokens: 10,
        outputTokens: 10,
        costCents: 1,
        finishReason: 'stop' as const,
        latencyMs: 42,
      }),
      materializer,
    });
    const rootController = new AbortController();
    await processor.advance(rootClaim!, rootController.signal);

    // Verify topology was materialized: child shell exists.
    const [childRow] = (await db.drizzle.execute(sql`
      SELECT "id", "status", "available_at" FROM "mission_runs"
      WHERE "root_run_id" = ${rootRunId} AND "id" != ${rootRunId}
    `)) as unknown as Array<{ id: string; status: string; available_at: string | null }>;
    expect(childRow).toBeDefined();
    expect(childRow.status).toBe('queued');
    expect(childRow.available_at).not.toBeNull();

    const childRunId = childRow.id;

    // Verify the assignment is pending_routing.
    const assignmentStatusBefore = await getAssignmentStatus(db, rootRunId, 'child-a');
    expect(assignmentStatusBefore).toBe('pending_routing');

    // Keep the root claim active (lease held) so the root is not re-claimable
    // while we process the child. The root stays in 'running' with an active
    // lease, so claimNext will select the child instead.

    // Step 2: Claim the child run (transitions queued→running).
    const childClaim = await coordinator.claimNext('test-worker');
    expect(childClaim).not.toBeNull();
    expect(childClaim!.runId).toBe(childRunId);
    expect(childClaim!.claimedFromStatus).toBe('queued');
    // After claimNext, status is 'running' — this is the key: the run is
    // now 'running', not 'queued'. The old code checked data.run.status
    // !== 'queued' which would be true here, skipping routing.
    expect(childClaim!.status).toBe('running');

    // Step 3: Advance the child — should route it and create budget allocation.
    const childController = new AbortController();
    await processor.advance(childClaim!, childController.signal);

    // Verify routing happened: assignment is now 'routed'.
    const assignmentStatusAfter = await getAssignmentStatus(db, rootRunId, 'child-a');
    expect(assignmentStatusAfter).toBe('routed');

    // Verify a child.routed event was emitted on the root journal.
    const routedEvents = await getEventsByType(db, rootRunId, 'child.routed');
    expect(routedEvents.length).toBeGreaterThanOrEqual(1);

    // Verify a budget allocation was created for the child.
    const childAlloc = await getChildAllocation(db, childRunId);
    expect(childAlloc).not.toBeNull();
    expect(childAlloc!.allocated).toBeGreaterThan(0);
    expect(childAlloc!.status).toBe('held');

    // Release the child claim so it can be re-claimed for execution.
    await coordinator.release(childClaim!);

    // Step 4: Claim the child again (recovery — lease was released).
    const childClaim2 = await coordinator.claimNext('test-worker');
    expect(childClaim2).not.toBeNull();
    expect(childClaim2!.runId).toBe(childRunId);

    // Step 5: Advance the child — should execute and complete, settling budget.
    const childController2 = new AbortController();
    await processor.advance(childClaim2!, childController2.signal);

    // Verify the child completed.
    const childStatus = await getRunStatus(db, childRunId);
    expect(childStatus).toBe('completed');

    // Verify budget was settled (at least one settlement for the child).
    const settlementCount = await countSettlements(db, childRunId);
    expect(settlementCount).toBeGreaterThanOrEqual(1);

    // Verify the child allocation has a settlement.
    const childAllocAfter = await getChildAllocation(db, childRunId);
    expect(childAllocAfter).not.toBeNull();
    expect(childAllocAfter!.settled).toBeGreaterThan(0);

    // Verify a run.completed event exists for the child.
    const completedEvents = await getEventsByType(db, childRunId, 'run.completed');
    expect(completedEvents.length).toBe(1);
  });

  /**
   * Regression: verify that the old status guard would have prevented routing.
   * After the fix, a child run in 'running' status (post-claim) with a
   * pending_routing assignment IS routed.
   */
  it('routes a child run that is in running status after claim (regression for status guard bug)', async () => {
    const now = new Date();
    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const revisionId = randomUUID();
    const hash = randomUUID();
    const policySnapshotId = randomUUID();
    const reservationId = randomUUID();
    const rootAllocationId = randomUUID();

    // Set up an eligible agent.
    const agentId = await seedAgent(db, scope.companyId, {
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
    });

    // Policy snapshot.
    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', '["research.search"]'::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 5000, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
    `);

    // Root run (running, approved_plan_revision_id set after revision insert).
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "initiating_agent_id", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'enc', ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, NULL, ${agentId}, ${agentId}, ${now}, ${now})
    `);

    // Plan revision (approved).
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', '{}'::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
    `);

    // Set approved_plan_revision_id (FK now satisfied).
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    // Child run (queued, available — simulating post-materialization state).
    const encryptedChildEnvelope = encryptEnvelope({ text: 'Research the topic' });
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
      VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${rootRunId}, 1, 0, 'company_agent', ${encryptedChildEnvelope}, ${hash}, 'Child', 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
    `);

    // Step assignment (pending_routing).
    const requirements = {
      capabilities: ['research'],
      requiredTools: ['research.search'],
      requiredDomains: [],
      ephemeralAllowed: true,
    };
    await db.drizzle.execute(sql`
      INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "parent_step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "routing_kind", "routing_requirements", "billing_agent_id", "created_at", "updated_at")
      VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${rootRunId}, ${childRunId}, 'child-a', NULL, 0, 'child', ${revisionId}, ${hash}, 'pending_routing', NULL, ${JSON.stringify(requirements)}::jsonb, ${agentId}, ${now}, ${now})
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

    // Claim the child (transitions queued→running).
    const coordinator = new RunCoordinator(db, { clock: () => new Date() });
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(childRunId);
    expect(claim!.claimedFromStatus).toBe('queued');
    expect(claim!.status).toBe('running');

    // Advance — should route the child despite status being 'running'.
    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: 'done',
        inputTokens: 10,
        outputTokens: 10,
        costCents: 1,
        finishReason: 'stop' as const,
        latencyMs: 42,
      }),
    });
    const controller = new AbortController();
    await processor.advance(claim!, controller.signal);

    // Verify routing happened.
    const assignmentStatus = await getAssignmentStatus(db, rootRunId, 'child-a');
    expect(assignmentStatus).toBe('routed');

    // Verify budget allocation was created.
    const alloc = await getChildAllocation(db, childRunId);
    expect(alloc).not.toBeNull();
    expect(alloc!.allocated).toBeGreaterThan(0);
  });

  /**
   * Production scenario (fix-ut-m5-dependency-resolution):
   * Children with dependencies on the root step → materialization →
   * dependency resolution → routing → budget allocation → execute → settle.
   *
   * child-a depends on the root orchestration step (required). After
   * materialization, the root's decomposition job is done, so child-a's
   * dependency is resolved and it transitions to pending_routing.
   * child-b depends on child-a (required). After child-a completes,
   * child-b's dependency is resolved and it transitions to pending_routing.
   *
   * Without the dependency-success resolver, both children stay
   * pending_dependencies forever (deadlock: children wait for root, root
   * waits for children).
   */
  it('resolves root-step dependencies after materialization and child-completion dependencies after child completes', async () => {
    const plan = rootDependencyPlanContent();
    const hash = planContentHash(plan);
    const now = new Date();

    // Set up an eligible agent for both research and writing capabilities.
    const agentId = await seedAgent(db, scope.companyId, {
      capabilities: ['research', 'writing', 'coordination'],
      toolsEnabled: ['research.search', 'artifact.create'],
      provider: 'anthropic',
      status: 'idle',
    });

    // Set up the root run with an approved plan.
    const rootRunId = randomUUID();
    const revisionId = randomUUID();
    const policySnapshotId = randomUUID();
    const reservationId = randomUUID();
    const rootAllocationId = randomUUID();

    // Insert policy snapshot.
    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', '["research.search","artifact.create"]'::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 5000, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
    `);

    // Insert root run (queued).
    const encryptedRootEnvelope = encryptEnvelope({ text: 'Research and draft with dependencies' });
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "initiating_agent_id", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', ${encryptedRootEnvelope}, ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, NULL, ${agentId}, ${agentId}, ${now}, ${now})
    `);

    // Insert approved plan revision.
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', ${JSON.stringify(plan)}::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
    `);

    // Set approved_plan_revision_id.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    // Insert approval binding.
    const approvalId = randomUUID();
    const bindingId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "approvals" ("id", "company_id", "project_id", "kind", "status", "title", "created_at", "updated_at")
      VALUES (${approvalId}, ${scope.companyId}, ${scope.projectId}, 'plan_gate', 'approved', 'Plan approval', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_approval_bindings" ("id", "company_id", "project_id", "run_id", "plan_revision_id", "content_hash", "approval_id", "decision", "is_current_authorization", "created_at")
      VALUES (${bindingId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${revisionId}, ${hash}, ${approvalId}, 'approved', true, ${now})
    `);

    // Insert budget reservation + root allocation.
    await db.drizzle.execute(sql`
      INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
      VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, ${agentId}, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
      VALUES (${rootAllocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, ${agentId}, 5000, 0, 0, 'held', ${now}, ${now})
    `);

    // Step 1: Claim the root run and advance to materialize topology.
    const coordinator = new RunCoordinator(db, {
      clock: () => new Date(),
      leaseDurationMs: 30_000,
    });
    const materializer = new TopologyMaterializer(db, { clock: () => new Date() });

    const rootClaim = await coordinator.claimNext('test-worker');
    expect(rootClaim).not.toBeNull();
    expect(rootClaim!.runId).toBe(rootRunId);

    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      providerCall: async () => ({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: 'done',
        inputTokens: 10,
        outputTokens: 10,
        costCents: 1,
        finishReason: 'stop' as const,
        latencyMs: 42,
      }),
      materializer,
    });
    const rootController = new AbortController();
    await processor.advance(rootClaim!, rootController.signal);

    // After materialization, child-a (depends on root) should be resolved
    // from pending_dependencies to pending_routing because the root step's
    // decomposition job is done (root has been materialized).
    const childAAssignment = await getAssignmentStatus(db, rootRunId, 'child-a');
    expect(childAAssignment).toBe('pending_routing');

    // child-b (depends on child-a) should still be pending_dependencies
    // because child-a has not completed yet.
    const childBAssignment = await getAssignmentStatus(db, rootRunId, 'child-b');
    expect(childBAssignment).toBe('pending_dependencies');

    // child-a's run should be claimable (available_at is set).
    const [childARow] = (await db.drizzle.execute(sql`
      SELECT "id", "status", "available_at" FROM "mission_runs"
      WHERE "root_run_id" = ${rootRunId} AND "id" != ${rootRunId}
      ORDER BY "child_ordinal" ASC
      LIMIT 1
    `)) as unknown as Array<{ id: string; status: string; available_at: string | null }>;
    expect(childARow.status).toBe('queued');
    expect(childARow.available_at).not.toBeNull();
    const childARunId = childARow.id;

    // child-b's run should NOT be claimable. available_at is set to a
    // far-future sentinel (not null) because the coordinator's claim query
    // treats available_at IS NULL as "available immediately"
    // (fix-ut-m5-available-at-null-claimable).
    const [childBRow] = (await db.drizzle.execute(sql`
      SELECT "id", "status", "available_at" FROM "mission_runs"
      WHERE "root_run_id" = ${rootRunId} AND "id" != ${rootRunId} AND "id" != ${childARunId}
    `)) as unknown as Array<{ id: string; status: string; available_at: string | null }>;
    expect(childBRow.status).toBe('queued');
    expect(childBRow.available_at).not.toBeNull();
    expect(new Date(childBRow.available_at!).getTime()).toBeGreaterThan(
      new Date('2998-01-01').getTime(),
    );
    const childBRunId = childBRow.id;

    // Step 2: Claim child-a and route it.
    const childAClaim = await coordinator.claimNext('test-worker');
    expect(childAClaim).not.toBeNull();
    expect(childAClaim!.runId).toBe(childARunId);

    const childAController = new AbortController();
    await processor.advance(childAClaim!, childAController.signal);

    // Verify child-a was routed.
    const childAAfter = await getAssignmentStatus(db, rootRunId, 'child-a');
    expect(childAAfter).toBe('routed');

    // child-b should still be pending_dependencies (child-a not completed yet).
    const childBBeforeComplete = await getAssignmentStatus(db, rootRunId, 'child-b');
    expect(childBBeforeComplete).toBe('pending_dependencies');

    // Release child-a claim so it can be re-claimed for execution.
    await coordinator.release(childAClaim!);

    // Step 3: Claim child-a again and execute it to completion.
    const childAClaim2 = await coordinator.claimNext('test-worker');
    expect(childAClaim2).not.toBeNull();
    expect(childAClaim2!.runId).toBe(childARunId);

    const childAController2 = new AbortController();
    await processor.advance(childAClaim2!, childAController2.signal);

    // Verify child-a completed.
    const childAStatus = await getRunStatus(db, childARunId);
    expect(childAStatus).toBe('completed');

    // Step 4: After child-a completes, child-b should be resolved from
    // pending_dependencies to pending_routing (its dependency on child-a
    // is now satisfied).
    const childBAfterAComplete = await getAssignmentStatus(db, rootRunId, 'child-b');
    expect(childBAfterAComplete).toBe('pending_routing');

    // child-b's run should now be claimable (available_at is set).
    const [childBRowAfter] = (await db.drizzle.execute(sql`
      SELECT "available_at" FROM "mission_runs" WHERE "id" = ${childBRunId}
    `)) as unknown as Array<{ available_at: string | null }>;
    expect(childBRowAfter.available_at).not.toBeNull();

    // Step 5: Claim child-b, route it, and execute to completion.
    const childBClaim = await coordinator.claimNext('test-worker');
    expect(childBClaim).not.toBeNull();
    expect(childBClaim!.runId).toBe(childBRunId);

    const childBController = new AbortController();
    await processor.advance(childBClaim!, childBController.signal);

    // Verify child-b was routed.
    const childBAfterRoute = await getAssignmentStatus(db, rootRunId, 'child-b');
    expect(childBAfterRoute).toBe('routed');

    // Release and re-claim child-b to execute.
    await coordinator.release(childBClaim!);
    const childBClaim2 = await coordinator.claimNext('test-worker');
    expect(childBClaim2).not.toBeNull();
    expect(childBClaim2!.runId).toBe(childBRunId);

    const childBController2 = new AbortController();
    await processor.advance(childBClaim2!, childBController2.signal);

    // Verify child-b completed.
    const childBStatus = await getRunStatus(db, childBRunId);
    expect(childBStatus).toBe('completed');

    // Verify budget was settled for both children.
    const childASettlements = await countSettlements(db, childARunId);
    expect(childASettlements).toBeGreaterThanOrEqual(1);
    const childBSettlements = await countSettlements(db, childBRunId);
    expect(childBSettlements).toBeGreaterThanOrEqual(1);
  });
});
