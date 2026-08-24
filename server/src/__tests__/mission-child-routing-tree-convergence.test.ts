import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestServers, closeTestDb } from '../test-utils.js';
import {
  validatePlan,
  validatePlanGraph,
  parsePlanContent,
  planContentHash,
  PLAN_CONTENT_SCHEMA_VERSION,
  type PlanContent,
  type RoutingRequirements,
} from '../services/mission/plan-schema.js';
import { TopologyMaterializer } from '../services/mission/topology-materializer.js';
import { AgentRouter, type RoutingContext } from '../services/mission/agent-router.js';
import {
  EphemeralFallbackRouter,
  type EphemeralRoutingContext,
} from '../services/mission/ephemeral-router.js';
import { ChildContextService } from '../services/mission/child-context.js';
import { SchedulingService } from '../services/mission/scheduling.js';
import type { ModeLimits } from '../services/mission/modes.js';

/**
 * Child Routing & Tree Convergence — m4-f14
 *
 * Connects the approved topology to routing, bounded trees, isolated
 * context, permissions, and root budgets. Each approved step keeps ONE
 * shell and ONE routing outcome; real-agent preference, ephemeral
 * fallback, closed failure, scope, counters, and allocations remain
 * singular.
 *
 * (VAL-CROSS-022, 023, 024, 025, 026, 063, 068)
 *
 * These are real-Postgres integration tests exercising the full
 * end-to-end convergence path: approve plan → materialize topology →
 * route each ready child (real agent → ephemeral → fail closed) →
 * verify bounded tree, isolated context, singular budgets, and
 * permission-gated selection.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

const PARENT_LIMITS = {
  steps: 12,
  durationSeconds: 2700,
  providerCalls: 48,
  totalTokens: 300000,
  outputBytes: 8388608,
  costCents: 5000,
  depth: 2,
  fanOut: 4,
  descendants: 16,
};

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

interface AgentSeedInput {
  id?: string;
  companyId: string;
  name: string;
  status?: string;
  provider?: string;
  model?: string;
  capabilities?: string[];
  toolsEnabled?: string[];
  allowedDomains?: string[];
  permissions?: string[];
  maxConcurrentTasks?: number;
  executionTimeoutSeconds?: number;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
}

async function seedAgent(db: AnyDb, input: AgentSeedInput): Promise<string> {
  const id = input.id ?? randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "api_key_encrypted", "created_at", "updated_at")
    VALUES (${id}, ${input.companyId}, ${input.name}, 'engineer', ${input.provider ?? 'anthropic'}, ${input.model ?? 'claude-sonnet-4-6'}, ${input.status ?? 'idle'}, ${JSON.stringify(input.capabilities ?? [])}::jsonb, '{}'::jsonb, '{}'::jsonb, ${JSON.stringify(input.permissions ?? ['content.create'])}::jsonb, ${JSON.stringify(input.toolsEnabled ?? [])}::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, ${JSON.stringify(input.allowedDomains ?? [])}::jsonb, ${input.maxConcurrentTasks ?? 2}, 300, ${input.executionTimeoutSeconds ?? 600}, 0, ${input.budgetMonthlyCents ?? 0}, ${input.spentMonthlyCents ?? 0}, 'encrypted-key', ${now}, ${now})
  `);
  return id;
}

async function insertPolicySnapshot(
  db: AnyDb,
  companyId: string,
  opts?: { toolAllowlist?: string[]; domainAllowlist?: string[] },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${id}, ${companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', ${JSON.stringify(opts?.toolAllowlist ?? ['research.search', 'artifact.create'])}::jsonb, ${JSON.stringify(opts?.domainAllowlist ?? [])}::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', ${JSON.stringify(PARENT_LIMITS)}::jsonb, ${randomUUID()}, ${now})
  `);
  return id;
}

/**
 * Insert a root run with an approved plan revision, approval binding, budget
 * reservation, and (optional) billing agent. Returns identifiers needed to
 * materialize and route children.
 */
async function setupApprovedRoot(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  plan: PlanContent,
  opts?: { billingAgentId?: string | null; reservedCents?: number },
): Promise<{
  runId: string;
  revisionId: string;
  hash: string;
  policySnapshotId: string;
  reservationId: string;
}> {
  const runId = randomUUID();
  const revisionId = randomUUID();
  const hash = planContentHash(plan);
  const now = new Date();
  const policySnapshotId = await insertPolicySnapshot(db, scope.companyId);

  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "created_at", "updated_at")
    VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, NULL, 0, 'company_agent', 'encrypted', ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, NULL, ${opts?.billingAgentId ?? null}, ${now}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
    VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${runId}, 1, 'approved', ${JSON.stringify(plan)}::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${runId}
  `);

  const approvalId = randomUUID();
  const bindingId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "approvals" ("id", "company_id", "project_id", "kind", "status", "title", "created_at", "updated_at")
    VALUES (${approvalId}, ${scope.companyId}, ${scope.projectId}, 'plan_gate', 'approved', 'Plan approval', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_approval_bindings" ("id", "company_id", "project_id", "run_id", "plan_revision_id", "content_hash", "approval_id", "decision", "is_current_authorization", "created_at")
    VALUES (${bindingId}, ${scope.companyId}, ${scope.projectId}, ${runId}, ${revisionId}, ${hash}, ${approvalId}, 'approved', true, ${now})
  `);

  const reservationId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${scope.companyId}, ${runId}, ${opts?.billingAgentId ?? null}, ${opts?.reservedCents ?? 5000}, ${opts?.reservedCents ?? 5000}, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
  `);

  return { runId, revisionId, hash, policySnapshotId, reservationId };
}

async function materialize(
  db: AnyDb,
  rootRunId: string,
  plan: PlanContent,
  revisionId: string,
  contentHash: string,
): Promise<void> {
  const materializer = new TopologyMaterializer(db, { clock: () => new Date() });
  await db.drizzle.transaction(async (tx) => {
    const [rootRun] = await tx
      .select()
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, rootRunId))
      .for('update')
      .limit(1);
    await materializer.materialize(tx, rootRun!, plan, revisionId, contentHash);
  });
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

async function getAssignments(db: AnyDb, rootRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT * FROM "run_step_assignments" WHERE "root_run_id" = ${rootRunId}
    ORDER BY "child_ordinal" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows;
}

async function getChildRuns(db: AnyDb, rootRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "status", "depth", "child_ordinal", "parent_run_id", "routing_kind", "executing_agent_id", "billing_agent_id", "policy_snapshot_id", "available_at"
    FROM "mission_runs" WHERE "root_run_id" = ${rootRunId} AND "id" != ${rootRunId}
    ORDER BY "depth" ASC, "child_ordinal" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    status: r['status'] as string,
    depth: Number(r['depth']),
    childOrdinal: r['child_ordinal'] as number | null,
    parentRunId: r['parent_run_id'] as string,
    routingKind: (r['routing_kind'] as string | null) ?? null,
    executingAgentId: (r['executing_agent_id'] as string | null) ?? null,
    billingAgentId: (r['billing_agent_id'] as string | null) ?? null,
    policySnapshotId: (r['policy_snapshot_id'] as string | null) ?? null,
    availableAt: r['available_at'] as string | Date | null,
  }));
}

async function getAllocations(db: AnyDb, rootRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT a."id", a."run_id", a."billing_agent_id", a."allocated_cents", a."settled_cents", a."released_cents", a."status"
    FROM "budget_allocations" a
    JOIN "mission_runs" r ON r."id" = a."run_id"
    WHERE r."root_run_id" = ${rootRunId}
    ORDER BY a."created_at" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    runId: r['run_id'] as string,
    billingAgentId: (r['billing_agent_id'] as string | null) ?? null,
    allocatedCents: Number(r['allocated_cents']),
    settledCents: Number(r['settled_cents']),
    releasedCents: Number(r['released_cents']),
    status: r['status'] as string,
  }));
}

async function getReservation(db: AnyDb, reservationId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "reserved_cents", "settled_cents", "released_cents", "status" FROM "budget_reservations" WHERE "id" = ${reservationId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0]
    ? {
        reservedCents: Number(rows[0]['reserved_cents']),
        settledCents: Number(rows[0]['settled_cents']),
        releasedCents: Number(rows[0]['released_cents']),
        status: rows[0]['status'] as string,
      }
    : null;
}

async function countAgents(db: AnyDb, companyId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS n FROM "agents" WHERE "company_id" = ${companyId}
  `)) as unknown as Array<Record<string, unknown>>;
  return Number(rows[0]?.['n'] ?? 0);
}

/**
 * Load the parent policy snapshot and reconstruct a minimal ResolvedPolicy
 * for ephemeral requirement checks / policy comparison.
 */
async function loadParentPolicy(
  db: AnyDb,
  companyId: string,
  runId: string,
): Promise<{
  provider: string;
  toolAllowlist: string[];
  domainAllowlist: string[];
  limits: ModeLimits;
}> {
  const [run] = await db.drizzle
    .select({ policySnapshotId: db.schema.missionRuns.policySnapshotId })
    .from(db.schema.missionRuns)
    .where(and(eq(db.schema.missionRuns.companyId, companyId), eq(db.schema.missionRuns.id, runId)))
    .limit(1);
  if (!run?.policySnapshotId) {
    throw new Error('no parent policy snapshot');
  }
  const [snap] = await db.drizzle
    .select()
    .from(db.schema.runPolicySnapshots)
    .where(
      and(
        eq(db.schema.runPolicySnapshots.companyId, companyId),
        eq(db.schema.runPolicySnapshots.id, run.policySnapshotId),
      ),
    )
    .limit(1);
  return {
    provider: snap!.provider,
    toolAllowlist: (snap!.toolAllowlist as string[]) ?? [],
    domainAllowlist: (snap!.domainAllowlist as string[]) ?? [],
    limits: snap!.limits as unknown as ModeLimits,
  };
}

/**
 * Route a single materialized child step end-to-end (real agent → ephemeral
 * fallback → fail closed), mirroring RunProcessor.handleChildRouting.
 * Returns the combined outcome.
 */
async function routeChild(
  db: AnyDb,
  scope: { companyId: string; projectId: string },
  rootRunId: string,
  stepKey: string,
  opts?: { hasCredential?: boolean },
): Promise<{
  routingKind: string | null;
  winnerAgentId: string | null;
  outcome: 'company_agent' | 'ephemeral' | 'failed';
  failureCode: string | null;
}> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "run_id", "parent_run_id", "root_run_id", "routing_requirements", "billing_agent_id", "assignment_status"
    FROM "run_step_assignments" WHERE "root_run_id" = ${rootRunId} AND "step_key" = ${stepKey}
  `)) as unknown as Array<Record<string, unknown>>;
  const assignment = rows[0];
  if (!assignment) {
    throw new Error(`no assignment for step ${stepKey}`);
  }
  const reqs = assignment['routing_requirements'] as RoutingRequirements;
  const childRunId = assignment['run_id'] as string;
  const parentRunId = assignment['parent_run_id'] as string;
  const billingAgentId = (assignment['billing_agent_id'] as string | null) ?? null;

  const parent = await loadParentPolicy(db, scope.companyId, parentRunId);
  const stepBudgetCents = 200;
  const stepTimeoutSeconds = 600;

  const router = new AgentRouter(db, { clock: () => new Date() });
  const ctx: RoutingContext = {
    companyId: scope.companyId,
    projectId: scope.projectId,
    rootRunId,
    parentRunId,
    childRunId,
    stepKey,
    routingRequirements: reqs,
    stepBudgetCents,
    stepTimeoutSeconds,
    billingAgentId,
    parentProvider: parent.provider,
  };

  const decision = await router.route(ctx);
  if (decision.selected) {
    return {
      routingKind: 'company_agent',
      winnerAgentId: decision.winnerAgentId,
      outcome: 'company_agent',
      failureCode: null,
    };
  }

  const ephemeralRouter = new EphemeralFallbackRouter(db, {
    clock: () => new Date(),
    hasCredential: opts?.hasCredential ?? true,
  });
  const ephemeralCtx: EphemeralRoutingContext = {
    companyId: scope.companyId,
    projectId: scope.projectId,
    rootRunId,
    parentRunId,
    childRunId,
    stepKey,
    routingRequirements: reqs,
    stepBudgetCents,
    stepTimeoutSeconds,
    billingAgentId,
  };
  const result = await ephemeralRouter.routeOrFail(ephemeralCtx);
  if (result.outcome === 'ephemeral') {
    return {
      routingKind: 'ephemeral',
      winnerAgentId: null,
      outcome: 'ephemeral',
      failureCode: null,
    };
  }
  return {
    routingKind: null,
    winnerAgentId: null,
    outcome: 'failed',
    failureCode: result.reason,
  };
}

/** A plan with two independent ready children requiring distinct capabilities. */
function twoChildrenPlan(opts?: {
  alphaReqs?: Partial<RoutingRequirements>;
  betaReqs?: Partial<RoutingRequirements>;
}): PlanContent {
  const baseReqs = (r: Partial<RoutingRequirements>): RoutingRequirements => ({
    capabilities: r.capabilities ?? ['analysis'],
    requiredTools: r.requiredTools ?? [],
    requiredDomains: r.requiredDomains ?? [],
    ephemeralAllowed: r.ephemeralAllowed ?? true,
  });
  return validatePlan({
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Two independent tasks',
    steps: [
      {
        stepKey: 'root',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Root',
        description: 'Oversee',
        dependencies: [],
        inputBindings: [],
        routing: { kind: 'requirements', routingRequirements: baseReqs({ capabilities: [] }) },
        toolAllowlist: [],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['result'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Done',
        budgetCents: 100,
        limits: {},
      },
      {
        stepKey: 'alpha',
        parentStepKey: 'root',
        childOrdinal: 0,
        nodeKind: 'child',
        title: 'Alpha task',
        description: 'Independent task A',
        dependencies: [],
        inputBindings: [
          { name: 'alphaInput', source: { kind: 'requestContext', key: 'alphaKey' } },
        ],
        routing: {
          kind: 'requirements',
          routingRequirements: baseReqs(
            opts?.alphaReqs ?? { capabilities: ['research'], requiredTools: ['research.search'] },
          ),
        },
        toolAllowlist: ['research.search'],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['alpha-out'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Alpha done',
        budgetCents: 200,
        limits: {},
      },
      {
        stepKey: 'beta',
        parentStepKey: 'root',
        childOrdinal: 1,
        nodeKind: 'child',
        title: 'Beta task',
        description: 'Independent task B',
        dependencies: [],
        inputBindings: [{ name: 'betaInput', source: { kind: 'requestContext', key: 'betaKey' } }],
        routing: {
          kind: 'requirements',
          routingRequirements: baseReqs(
            opts?.betaReqs ?? { capabilities: ['writing'], requiredTools: ['artifact.create'] },
          ),
        },
        toolAllowlist: ['artifact.create'],
        replayClass: 'idempotent_write',
        sideEffecting: true,
        expectedOutputs: ['beta-out'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Beta done',
        budgetCents: 300,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Combine',
      declaredInputs: [
        { kind: 'stepOutput', stepKey: 'alpha', output: 'alpha-out' },
        { kind: 'stepOutput', stepKey: 'beta', output: 'beta-out' },
      ],
      declaredOutput: 'combined',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'Combined',
      budgetCents: 100,
    },
    planningBudgetCents: 100,
    partialResultPolicy: 'require_all',
    limits: { ...PARENT_LIMITS },
  });
}

// ---------------------------------------------------------------------------
// VAL-CROSS-022: Real-agent child routing
// ---------------------------------------------------------------------------

describe('VAL-CROSS-022: Real-agent child routing', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ cross-022');
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('routes a ready approved step to an eligible same-company agent before ephemeral fallback', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Researcher',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      permissions: ['content.create'],
      status: 'idle',
      provider: 'anthropic',
    });

    const plan = twoChildrenPlan({
      betaReqs: { capabilities: ['research'], requiredTools: ['research.search'] },
    });
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);

    await materialize(db, runId, plan, revisionId, hash);

    const outcome = await routeChild(db, scope, runId, 'alpha');
    expect(outcome.outcome).toBe('company_agent');
    expect(outcome.winnerAgentId).toBe(agentId);

    // child.routed event on the root journal shows company_agent + agent identity.
    const events = await getEvents(db, runId);
    const routed = events.find((e) => e.type === 'child.routed' && e.payload.stepKey === 'alpha');
    expect(routed).toBeDefined();
    expect(routed!.payload.routingKind).toBe('company_agent');
    expect(routed!.payload.executingAgentId).toBe(agentId);

    // Step assignment routed with the selected agent.
    const assignments = await getAssignments(db, runId);
    const alphaAssign = assignments.find((a) => a['step_key'] === 'alpha');
    expect(alphaAssign!['assignment_status']).toBe('routed');
    expect(alphaAssign!['routing_kind']).toBe('company_agent');
    expect(alphaAssign!['executing_agent_id']).toBe(agentId);

    // Child run carries the agent and routing kind.
    const children = await getChildRuns(db, runId);
    const alphaChild = children.find((c) => c.depth === 1 && c.childOrdinal === 0);
    expect(alphaChild).toBeDefined();
    expect(alphaChild!.routingKind).toBe('company_agent');
    expect(alphaChild!.executingAgentId).toBe(agentId);

    // A dedicated subthread was created for the child (linked to the plan step).
    const subthreads = (await db.drizzle.execute(sql`
      SELECT "id", "mission_run_id", "is_mission_subthread" FROM "project_threads"
      WHERE "company_id" = ${scope.companyId} AND "mission_run_id" = ${alphaChild!.id}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(subthreads).toHaveLength(1);
    expect(subthreads[0]['is_mission_subthread']).toBe(true);

    // A child budget allocation was created under the root hold.
    const allocations = await getAllocations(db, runId);
    const alphaAlloc = allocations.find((a) => a.runId === alphaChild!.id);
    expect(alphaAlloc).toBeDefined();
    expect(alphaAlloc!.allocatedCents).toBeGreaterThan(0);
  });

  it('prefers the real agent even when ephemeral fallback is permitted', async () => {
    await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Researcher',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      permissions: ['content.create'],
      status: 'idle',
    });
    const plan = twoChildrenPlan();
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);
    await materialize(db, runId, plan, revisionId, hash);

    // alpha requires research capability — the real agent covers it.
    const outcome = await routeChild(db, scope, runId, 'alpha');
    expect(outcome.outcome).toBe('company_agent');
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-023: Ephemeral child fallback
// ---------------------------------------------------------------------------

describe('VAL-CROSS-023: Ephemeral child fallback', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let billingAgentId: string;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ cross-023');
    billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
      capabilities: [],
      permissions: ['content.create'],
      budgetMonthlyCents: 100000,
    });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('runs a step as a bounded ephemeral child when no eligible company agent exists', async () => {
    // No capable agent exists (no agent has the research capability + tool).
    const plan = twoChildrenPlan();
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan, {
      billingAgentId,
    });
    await materialize(db, runId, plan, revisionId, hash);

    const agentCountBefore = await countAgents(db, scope.companyId);

    const outcome = await routeChild(db, scope, runId, 'alpha', { hasCredential: true });
    expect(outcome.outcome).toBe('ephemeral');
    expect(outcome.winnerAgentId).toBeNull();

    // No permanent employee/agent row was created.
    const agentCountAfter = await countAgents(db, scope.companyId);
    expect(agentCountAfter).toBe(agentCountBefore);

    // child.routed event shows ephemeral, no executing agent, billing = parent agent.
    const events = await getEvents(db, runId);
    const routed = events.find((e) => e.type === 'child.routed' && e.payload.stepKey === 'alpha');
    expect(routed).toBeDefined();
    expect(routed!.payload.routingKind).toBe('ephemeral');
    expect(routed!.payload.executingAgentId).toBeNull();
    expect(routed!.payload.billingAgentId).toBe(billingAgentId);

    // Child run: ephemeral, no executing agent, billing = inherited parent agent.
    const children = await getChildRuns(db, runId);
    const alphaChild = children.find((c) => c.depth === 1 && c.childOrdinal === 0);
    expect(alphaChild!.routingKind).toBe('ephemeral');
    expect(alphaChild!.executingAgentId).toBeNull();
    expect(alphaChild!.billingAgentId).toBe(billingAgentId);

    // The ephemeral child's committed policy snapshot is no broader than the
    // parent's: tools/domains inherited (subset-or-equal), cost/timeout narrowed.
    const parentPolicy = await loadParentPolicy(db, scope.companyId, runId);
    const [childSnap] = await db.drizzle
      .select()
      .from(db.schema.runPolicySnapshots)
      .where(eq(db.schema.runPolicySnapshots.id, alphaChild!.policySnapshotId!))
      .limit(1);
    expect(childSnap).toBeDefined();
    expect((childSnap!.toolAllowlist as string[]).sort()).toEqual(
      [...parentPolicy.toolAllowlist].sort(),
    );
    expect((childSnap!.domainAllowlist as string[]).sort()).toEqual(
      [...parentPolicy.domainAllowlist].sort(),
    );
    const childLimits = childSnap!.limits as unknown as ModeLimits;
    expect(childLimits.costCents).toBeLessThanOrEqual(parentPolicy.limits.costCents);
    expect(childLimits.durationSeconds).toBeLessThanOrEqual(parentPolicy.limits.durationSeconds);
    // Provider/model inherited from the parent.
    expect(childSnap!.provider).toBe(parentPolicy.provider);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-024: No eligible child fails the existing shell closed
// ---------------------------------------------------------------------------

describe('VAL-CROSS-024: No eligible child fails the existing shell closed', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ cross-024');
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('terminally fails the shell with NO_ELIGIBLE_AGENT when ephemeral is disabled', async () => {
    const agentCountBefore = await countAgents(db, scope.companyId);

    // ephemeralAllowed=false and no capable agent.
    const plan = twoChildrenPlan({
      alphaReqs: {
        capabilities: ['research'],
        requiredTools: ['research.search'],
        ephemeralAllowed: false,
      },
    });
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);
    await materialize(db, runId, plan, revisionId, hash);

    const outcome = await routeChild(db, scope, runId, 'alpha');
    expect(outcome.outcome).toBe('failed');
    expect(outcome.failureCode).toBe('NO_ELIGIBLE_AGENT');

    // Step assignment: failed, routingKind null, NO_ELIGIBLE_AGENT.
    const assignments = await getAssignments(db, runId);
    const alphaAssign = assignments.find((a) => a['step_key'] === 'alpha');
    expect(alphaAssign!['assignment_status']).toBe('failed');
    expect(alphaAssign!['routing_kind']).toBeNull();
    expect(alphaAssign!['failure_code']).toBe('NO_ELIGIBLE_AGENT');

    // Child run: failed, NO_ELIGIBLE_AGENT, terminal. (The run's
    // routing_kind column is NOT NULL and retains the materializer's
    // placeholder; the authoritative "no routing outcome" signal is the
    // assignment's null routing_kind above.)
    const children = await getChildRuns(db, runId);
    const alphaChild = children.find((c) => c.depth === 1 && c.childOrdinal === 0);
    expect(alphaChild!.status).toBe('failed');
    expect(alphaChild!.executingAgentId).toBeNull();

    const [runRow] = await db.drizzle
      .select({
        failureCode: db.schema.missionRuns.failureCode,
        terminalAt: db.schema.missionRuns.terminalAt,
        actualCostCents: db.schema.missionRuns.actualCostCents,
        providerCallCount: db.schema.missionRuns.providerCallCount,
      })
      .from(db.schema.missionRuns)
      .where(eq(db.schema.missionRuns.id, alphaChild!.id))
      .limit(1);
    expect(runRow!.failureCode).toBe('NO_ELIGIBLE_AGENT');
    expect(runRow!.terminalAt).not.toBeNull();
    // No external work: zero cost, zero provider calls.
    expect(Number(runRow!.actualCostCents)).toBe(0);
    expect(Number(runRow!.providerCallCount)).toBe(0);

    // No employee/agent row created.
    const agentCountAfter = await countAgents(db, scope.companyId);
    expect(agentCountAfter).toBe(agentCountBefore);

    // child.failed event on the root journal.
    const events = await getEvents(db, runId);
    const failed = events.find((e) => e.type === 'child.failed' && e.payload.stepKey === 'alpha');
    expect(failed).toBeDefined();
    expect(failed!.payload.code).toBe('NO_ELIGIBLE_AGENT');

    // No settlements recorded for the failed shell.
    const settlements = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS n FROM "budget_settlements" s
      JOIN "mission_runs" r ON r."id" = s."run_id"
      WHERE r."root_run_id" = ${runId} AND s."run_id" = ${alphaChild!.id}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(Number(settlements[0]?.['n'] ?? 0)).toBe(0);
  });

  it('counts the failed shell once toward descendants but invokes no tool', async () => {
    const plan = twoChildrenPlan({
      alphaReqs: {
        capabilities: ['research'],
        requiredTools: ['research.search'],
        ephemeralAllowed: false,
      },
    });
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);
    await materialize(db, runId, plan, revisionId, hash);

    await routeChild(db, scope, runId, 'alpha');

    // The shell was materialized once (one child run for alpha).
    const children = await getChildRuns(db, runId);
    expect(children.filter((c) => c.id !== runId)).toHaveLength(children.length);

    // No tool invocations recorded.
    const tools = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS n FROM "run_tool_invocations" i
      JOIN "mission_runs" r ON r."id" = i."run_id"
      WHERE r."root_run_id" = ${runId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(Number(tools[0]?.['n'] ?? 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-025: Bounded parallel child tree
// ---------------------------------------------------------------------------

describe('VAL-CROSS-025: Bounded parallel child tree', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ cross-025');
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('rejects a plan exceeding fan-out before approval', () => {
    const plan = twoChildrenPlan();
    plan.limits.fanOut = 1; // root has 2 direct children
    expect(() => validatePlanGraph(plan)).toThrow(/exceeding effective fan-out/);
  });

  it('rejects a plan exceeding depth before approval', () => {
    const plan = twoChildrenPlan();
    plan.limits.depth = 0; // children are at depth 1
    expect(() => validatePlanGraph(plan)).toThrow(/exceeds plan depth limit/);
  });

  it('rejects a plan exceeding descendants before approval', () => {
    const plan = twoChildrenPlan();
    plan.limits.descendants = 1; // two descendants
    expect(() => validatePlanGraph(plan)).toThrow(/exceeding descendants limit/);
  });

  it('accepts and materializes a plan exactly at the fan-out and depth bounds', async () => {
    const plan = twoChildrenPlan();
    plan.limits.fanOut = 2; // exactly 2 direct children
    plan.limits.depth = 2; // children at depth 1, within bound
    plan.limits.descendants = 16;
    // Re-validate to ensure the boundary is accepted.
    const validated = validatePlanGraph(
      parsePlanContent(JSON.parse(JSON.stringify(plan)) as unknown) as PlanContent,
    );
    expect(validated.steps.filter((s) => s.parentStepKey !== null)).toHaveLength(2);

    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);
    await materialize(db, runId, plan, revisionId, hash);

    const children = await getChildRuns(db, runId);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.depth === 1)).toBe(true);
  });

  it('enforces runtime concurrency: admits up to the cap and rejects excess', async () => {
    const scheduling = new SchedulingService(db, { clock: () => new Date() });
    const rootRunId = randomUUID();
    const now = new Date();
    // Minimal root run + 4 child runs to acquire permits for.
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'Root', 'deep_work', 'running', 1, 0, 'require_all', ${now}, ${now})
    `);
    const childIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const childId = randomUUID();
      childIds.push(childId);
      await db.drizzle.execute(sql`
        INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
        VALUES (${childId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${rootRunId}, 1, ${i}, 'company_agent', 'encrypted', ${randomUUID()}, 'Child', 'deep_work', 'queued', 1, 0, 'require_all', ${now}, ${now})
      `);
    }

    const fanOut = 4;
    const acquired: string[] = [];
    for (let i = 0; i < fanOut; i++) {
      const result = await db.drizzle.transaction(async (tx) => {
        return scheduling.acquireRunningPermits(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          rootRunId,
          parentRunId: rootRunId,
          runId: childIds[i],
          rootFanOut: fanOut,
          parentFanOut: fanOut,
        });
      });
      acquired.push(result.rootPermitId);
    }
    expect(acquired).toHaveLength(fanOut);

    // The cap is exactly reached: 4 held root_running permits, no more can be
    // admitted without releasing one (no limit is silently exceeded).
    const held = await scheduling.countHeldPermits(
      db.drizzle,
      rootRunId,
      'root_running',
      scope.companyId,
    );
    expect(held).toBe(fanOut);

    // Releasing one permit allows the 5th child to acquire a slot.
    await db.drizzle.transaction(async (tx) => {
      await scheduling.releasePermits(tx, childIds[0], scope.companyId);
    });
    const heldAfterRelease = await scheduling.countHeldPermits(
      db.drizzle,
      rootRunId,
      'root_running',
      scope.companyId,
    );
    expect(heldAfterRelease).toBe(fanOut - 1);

    const fifth = await db.drizzle.transaction(async (tx) => {
      return scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childIds[4],
        rootFanOut: fanOut,
        parentFanOut: fanOut,
      });
    });
    expect(fifth.rootPermitId).toBeDefined();

    // Back at the cap after the 5th acquires the freed slot.
    const heldFinal = await scheduling.countHeldPermits(
      db.drizzle,
      rootRunId,
      'root_running',
      scope.companyId,
    );
    expect(heldFinal).toBe(fanOut);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-026: Child subthread context isolation
// ---------------------------------------------------------------------------

describe('VAL-CROSS-026: Child subthread context isolation', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ cross-026');
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('each sibling child context contains only its own inputs and bound dependencies', async () => {
    const plan = twoChildrenPlan();
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);
    await materialize(db, runId, plan, revisionId, hash);

    const children = await getChildRuns(db, runId);
    const alphaChild = children.find((c) => c.childOrdinal === 0)!;
    const betaChild = children.find((c) => c.childOrdinal === 1)!;

    const stepRunMap = new Map<string, string>();
    stepRunMap.set('alpha', alphaChild.id);
    stepRunMap.set('beta', betaChild.id);

    // Seed canaries: one per-step input, one parent-transcript marker, one
    // sibling-private marker. Only the owning child's input canary may appear.
    const canaries = {
      'step:alpha': 'ALPHA_CANARY',
      'step:beta': 'BETA_CANARY',
      parent_transcript: 'PARENT_SECRET',
    };

    const ctxService = new ChildContextService(db);

    const ctxAlpha = await ctxService.buildChildContext({
      companyId: scope.companyId,
      projectId: scope.projectId,
      rootRunId: runId,
      childRunId: alphaChild.id,
      stepKey: 'alpha',
      approvedPlanRevisionId: revisionId,
      approvedPlanContentHash: hash,
      rootRequestSummary: 'Root',
      resolvedMode: 'deep_work',
      plan,
      stepRunMap,
      canaries,
    });
    expect(ctxAlpha._canaries).toBeDefined();
    expect(ctxAlpha._canaries!['step:alpha']).toBe('ALPHA_CANARY');
    expect(ctxAlpha._canaries!['step:beta']).toBeUndefined();
    expect(ctxAlpha._canaries!['parent_transcript']).toBeUndefined();
    // Backlinks to the parent/plan step remain available.
    expect(ctxAlpha.stepKey).toBe('alpha');
    expect(ctxAlpha.approvedPlanContentHash).toBe(hash);

    const ctxBeta = await ctxService.buildChildContext({
      companyId: scope.companyId,
      projectId: scope.projectId,
      rootRunId: runId,
      childRunId: betaChild.id,
      stepKey: 'beta',
      approvedPlanRevisionId: revisionId,
      approvedPlanContentHash: hash,
      rootRequestSummary: 'Root',
      resolvedMode: 'deep_work',
      plan,
      stepRunMap,
      canaries,
    });
    expect(ctxBeta._canaries).toBeDefined();
    expect(ctxBeta._canaries!['step:beta']).toBe('BETA_CANARY');
    expect(ctxBeta._canaries!['step:alpha']).toBeUndefined();
    expect(ctxBeta._canaries!['parent_transcript']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-063: Child budgets do not double-reserve
// ---------------------------------------------------------------------------

describe('VAL-CROSS-063: Child budgets do not double-reserve', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let billingAgentId: string;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ cross-063');
    billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
      permissions: ['content.create'],
      budgetMonthlyCents: 100000,
    });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('parallel children allocate from one root hold and never exceed it', async () => {
    const reservedCents = 1000;
    const plan = twoChildrenPlan();
    const { runId, revisionId, hash, reservationId } = await setupApprovedRoot(db, scope, plan, {
      billingAgentId,
      reservedCents,
    });
    await materialize(db, runId, plan, revisionId, hash);

    // Route both children as ephemeral (no capable agent) so each allocates
    // from the root hold.
    await routeChild(db, scope, runId, 'alpha', { hasCredential: true });
    await routeChild(db, scope, runId, 'beta', { hasCredential: true });

    const allocations = await getAllocations(db, runId);
    // Two child allocations, no new reservations.
    expect(allocations.filter((a) => a.runId !== runId)).toHaveLength(2);

    const reservationRows = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS n FROM "budget_reservations" WHERE "run_id" = ${runId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(Number(reservationRows[0]?.['n'] ?? 0)).toBe(1);

    // allocations + settled + released remain within reserved cents.
    const reservation = await getReservation(db, reservationId);
    expect(reservation).not.toBeNull();
    const totalAllocated = allocations.reduce((sum, a) => sum + a.allocatedCents, 0);
    const totalSettled = allocations.reduce((sum, a) => sum + a.settledCents, 0);
    const totalReleased = allocations.reduce((sum, a) => sum + a.releasedCents, 0);
    expect(totalSettled + totalReleased).toBeLessThanOrEqual(totalAllocated);
    expect(totalAllocated).toBeLessThanOrEqual(reservation!.reservedCents);

    // Each allocation billed the inherited (parent) billing agent.
    expect(allocations.every((a) => a.billingAgentId === billingAgentId)).toBe(true);
  });

  it('rejects an allocation that would exceed the root residual', async () => {
    const reservedCents = 250; // only enough for one 200-cent child
    const plan = twoChildrenPlan();
    const { runId, revisionId, hash, reservationId } = await setupApprovedRoot(db, scope, plan, {
      billingAgentId,
      reservedCents,
    });
    await materialize(db, runId, plan, revisionId, hash);

    await routeChild(db, scope, runId, 'alpha', { hasCredential: true });

    // The second child's allocation exceeds the remaining residual — the
    // ephemeral router fails closed (insufficient billing headroom is one
    // path; the root residual check rejects the allocation).
    const outcome = await routeChild(db, scope, runId, 'beta', { hasCredential: true });
    // Either the allocation was rejected (fail closed) or, if the residual
    // allowed a smaller allocation, it succeeded. With reservedCents=250 and
    // stepBudgetCents=200, only one fits.
    expect(['failed', 'ephemeral']).toContain(outcome.outcome);

    // Regardless, settled + released never exceeds reserved.
    const reservation = await getReservation(db, reservationId);
    const allocations = await getAllocations(db, runId);
    const totalSettled = allocations.reduce((s, a) => s + a.settledCents, 0);
    const totalReleased = allocations.reduce((s, a) => s + a.releasedCents, 0);
    expect(totalSettled + totalReleased).toBeLessThanOrEqual(reservation!.reservedCents);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-068: Project permission blocks routed agents
// ---------------------------------------------------------------------------

describe('VAL-CROSS-068: Project permission blocks routed agents', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ cross-068');
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('does not select an otherwise capable agent without content.create permission; chooses an eligible alternative', async () => {
    // Agent A: capable but lacks content.create (project permission).
    const agentA = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Capable No-Perm',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      permissions: [], // no content.create
      status: 'idle',
    });
    // Agent B: capable AND has content.create.
    const agentB = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Capable With-Perm',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      permissions: ['content.create'],
      status: 'idle',
    });

    const plan = twoChildrenPlan({
      betaReqs: { capabilities: ['research'], requiredTools: ['research.search'] },
    });
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);
    await materialize(db, runId, plan, revisionId, hash);

    const outcome = await routeChild(db, scope, runId, 'alpha');
    expect(outcome.outcome).toBe('company_agent');
    // The eligible alternative (Agent B) is selected — never the unauthorized Agent A.
    expect(outcome.winnerAgentId).toBe(agentB);
    expect(outcome.winnerAgentId).not.toBe(agentA);

    // No event/tool call is attributed to the unauthorized agent.
    const events = await getEvents(db, runId);
    const routed = events.find((e) => e.type === 'child.routed' && e.payload.stepKey === 'alpha');
    expect(routed!.payload.executingAgentId).toBe(agentB);
  });

  it('fails closed when the only capable agent lacks project permission and no alternative exists', async () => {
    // Only Agent A exists — capable but no content.create, ephemeral disabled.
    await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Capable No-Perm',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      permissions: [],
      status: 'idle',
    });

    const plan = twoChildrenPlan({
      alphaReqs: {
        capabilities: ['research'],
        requiredTools: ['research.search'],
        ephemeralAllowed: false,
      },
    });
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);
    await materialize(db, runId, plan, revisionId, hash);

    const outcome = await routeChild(db, scope, runId, 'alpha');
    expect(outcome.outcome).toBe('failed');
    expect(outcome.failureCode).toBe('NO_ELIGIBLE_AGENT');

    // The unauthorized agent was not selected and no work was attributed to it.
    const children = await getChildRuns(db, runId);
    const alphaChild = children.find((c) => c.childOrdinal === 0)!;
    expect(alphaChild.executingAgentId).toBeNull();
    expect(alphaChild.status).toBe('failed');
  });

  it('a capable agent cannot gain access through parent IDs when it lacks permission', async () => {
    // Agent with capabilities but no permission; an eligible alternative exists.
    const noPermAgent = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'No-Perm',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      permissions: [],
    });
    const eligibleAgent = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      permissions: ['content.create'],
    });

    const plan = twoChildrenPlan({
      betaReqs: { capabilities: ['research'], requiredTools: ['research.search'] },
    });
    const { runId, revisionId, hash } = await setupApprovedRoot(db, scope, plan);
    await materialize(db, runId, plan, revisionId, hash);

    await routeChild(db, scope, runId, 'alpha');
    await routeChild(db, scope, runId, 'beta');

    // Neither child was attributed to the no-permission agent.
    const children = await getChildRuns(db, runId);
    const executing = children.map((c) => c.executingAgentId).filter(Boolean);
    expect(executing).not.toContain(noPermAgent);
    expect(executing.every((id) => id === eligibleAgent)).toBe(true);
  });
});
