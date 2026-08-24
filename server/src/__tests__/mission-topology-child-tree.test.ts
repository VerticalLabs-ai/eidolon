import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql, eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import {
  validatePlanGraph,
  parsePlanContent,
  planContentHash,
  validatePlan,
  PLAN_CONTENT_SCHEMA_VERSION,
  type PlanContent,
} from '../services/mission/plan-schema.js';
import { TopologyMaterializer } from '../services/mission/topology-materializer.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { OrchestrationWorker } from '../services/mission/worker.js';
import { RunProcessor } from '../services/mission/run-processor.js';
import { PlanDecisionService, PlanDecisionError } from '../services/mission/plan-decision.js';
import { BudgetService } from '../services/mission/budget.js';

/**
 * Topology child tree materialization.
 *
 * (VAL-SUB-001, 002, 003, 004, 005, 085, 095, 106, 107)
 *
 * Tests depth-two topology, dependencies, retries, topology hashes, fan-out,
 * shell cardinality, and the revision boundary.
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

/** A depth-two topology plan: root → two children → one grandchild under child-a. */
function depthTwoPlanContent(): PlanContent {
  return validatePlan({
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Produce a cited market brief with research and drafting',
    steps: [
      {
        stepKey: 'root',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Coordinate the market brief',
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
        title: 'Research the market',
        description: 'Gather cited sources',
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
        completionCriteria: 'At least three cited sources',
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
        dependencies: ['child-a'],
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
            ephemeralAllowed: false,
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
      {
        stepKey: 'grandchild-a1',
        parentStepKey: 'child-a',
        childOrdinal: 0,
        nodeKind: 'child',
        title: 'Deep web search',
        description: 'Perform deep web research',
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
        expectedOutputs: ['deep-sources'],
        evidenceRequirements: { citationsRequired: true },
        completionCriteria: 'Deep sources gathered',
        budgetCents: 100,
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

/** A plan with two independent ready steps (no dependencies) under the root. */
function independentStepsPlanContent(): PlanContent {
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
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: [],
            requiredTools: [],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
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
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['analysis'],
            requiredTools: [],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: [],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['alpha-out'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Alpha done',
        budgetCents: 100,
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
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['analysis'],
            requiredTools: [],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: [],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['beta-out'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Beta done',
        budgetCents: 100,
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

/** Fetch a run row using Drizzle's query builder (camelCase mapping). */
async function getRunRow(db: AnyDb, runId: string) {
  const schema = db.schema;
  const [run] = await db.drizzle
    .select()
    .from(schema.missionRuns)
    .where(eq(schema.missionRuns.id, runId))
    .limit(1);
  return run;
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
    SELECT "id", "status", "depth", "child_ordinal", "parent_run_id", "available_at"
    FROM "mission_runs" WHERE "root_run_id" = ${rootRunId} AND "id" != ${rootRunId}
    ORDER BY "depth" ASC, "child_ordinal" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    status: r['status'] as string,
    depth: Number(r['depth']),
    childOrdinal: r['child_ordinal'] as number | null,
    parentRunId: r['parent_run_id'] as string,
    availableAt: r['available_at'] as string | Date | null,
  }));
}

// ---------------------------------------------------------------------------
// Plan topology validation (VAL-SUB-085, VAL-SUB-106) — pure unit tests
// ---------------------------------------------------------------------------

describe('Plan topology validation (VAL-SUB-085, VAL-SUB-106)', () => {
  it('accepts a valid depth-two topology', () => {
    const plan = depthTwoPlanContent();
    expect(plan.steps).toHaveLength(4);
    expect(plan.steps.filter((s) => s.parentStepKey !== null)).toHaveLength(3);
  });

  it('rejects a missing parent reference', () => {
    const plan = depthTwoPlanContent();
    (plan.steps[1] as unknown as { parentStepKey: string }).parentStepKey = 'nonexistent';
    expect(() => validatePlanGraph(plan)).toThrow(/missing parent step/);
  });

  it('rejects a parent-chain cycle', () => {
    const plan = depthTwoPlanContent();
    // Make child-a point to grandchild-a1 (creating a cycle).
    (plan.steps[1] as unknown as { parentStepKey: string }).parentStepKey = 'grandchild-a1';
    expect(() => validatePlanGraph(plan)).toThrow(/cycle/i);
  });

  it('rejects duplicate child ordinals under the same parent', () => {
    const plan = depthTwoPlanContent();
    // Set child-b's ordinal to 0 (same as child-a).
    (plan.steps[2] as unknown as { childOrdinal: number }).childOrdinal = 0;
    expect(() => validatePlanGraph(plan)).toThrow(/Duplicate child ordinal/);
  });

  it('rejects depth exceeding the plan limit', () => {
    const plan = depthTwoPlanContent();
    // Set depth limit to 1 (grandchild-a1 is at depth 2).
    plan.limits.depth = 1;
    expect(() => validatePlanGraph(plan)).toThrow(/exceeds plan depth limit/);
  });

  it('rejects fan-out exceeding the effective limit (VAL-SUB-085)', () => {
    const plan = depthTwoPlanContent();
    // Set fan-out to 1 (root has 2 direct children).
    plan.limits.fanOut = 1;
    expect(() => validatePlanGraph(plan)).toThrow(/exceeding effective fan-out/);
  });

  it('rejects descendant count exceeding the plan limit', () => {
    const plan = depthTwoPlanContent();
    plan.limits.descendants = 2;
    expect(() => validatePlanGraph(plan)).toThrow(/exceeding descendants limit/);
  });

  it('hash changes for every topology mutation (VAL-SUB-106)', () => {
    const base = depthTwoPlanContent();
    const baseHash = planContentHash(base);

    // Mutation 1: change a step key
    const m1 = parsePlanContent(JSON.parse(JSON.stringify(base)) as unknown) as PlanContent;
    m1.steps[1].stepKey = 'child-a-renamed';
    // Fix the dependency reference and parent reference
    m1.steps[2].dependencies = ['child-a-renamed'];
    (m1.steps[2].inputBindings[0].source as { stepKey: string }).stepKey = 'child-a-renamed';
    m1.steps[3].parentStepKey = 'child-a-renamed';
    expect(planContentHash(m1)).not.toBe(baseHash);

    // Mutation 2: change parentStepKey (reparenting)
    const m2 = parsePlanContent(JSON.parse(JSON.stringify(base)) as unknown) as PlanContent;
    m2.steps[3].parentStepKey = 'root';
    m2.steps[3].childOrdinal = 2;
    expect(planContentHash(m2)).not.toBe(baseHash);

    // Mutation 3: change childOrdinal
    const m3 = parsePlanContent(JSON.parse(JSON.stringify(base)) as unknown) as PlanContent;
    m3.steps[1].childOrdinal = 99;
    expect(planContentHash(m3)).not.toBe(baseHash);

    // Mutation 4: add dependencyKinds
    const m4 = parsePlanContent(JSON.parse(JSON.stringify(base)) as unknown) as PlanContent;
    m4.steps[2].dependencyKinds = { 'child-a': 'optional' };
    expect(planContentHash(m4)).not.toBe(baseHash);
  });

  it('canonically equivalent topology hashes identically (VAL-SUB-106)', () => {
    const base = depthTwoPlanContent();
    const baseHash = planContentHash(base);
    // Re-parse the same content — should produce the same hash.
    const reParsed = parsePlanContent(JSON.parse(JSON.stringify(base)) as unknown) as PlanContent;
    expect(planContentHash(reParsed)).toBe(baseHash);
  });

  it('rejects dependencyKinds for non-dependency keys (VAL-SUB-003)', () => {
    const plan = depthTwoPlanContent();
    plan.steps[2].dependencyKinds = { 'child-a': 'required', 'child-x': 'optional' };
    expect(() => validatePlanGraph(plan)).toThrow(/non-dependency/);
  });

  it('accepts a flat plan (all root steps, no children) without topology errors', () => {
    const plan = independentStepsPlanContent();
    // Remove the child steps to make it flat.
    const flatPlan = parsePlanContent({
      schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
      objective: 'Flat plan',
      steps: [
        {
          stepKey: 'only-root',
          parentStepKey: null,
          childOrdinal: 0,
          nodeKind: 'root',
          title: 'Root',
          description: 'The only step',
          dependencies: [],
          inputBindings: [],
          routing: {
            kind: 'requirements',
            routingRequirements: {
              capabilities: [],
              requiredTools: [],
              requiredDomains: [],
              ephemeralAllowed: true,
            },
          },
          toolAllowlist: [],
          replayClass: 'read_only',
          sideEffecting: false,
          expectedOutputs: ['out'],
          evidenceRequirements: { citationsRequired: false },
          completionCriteria: 'Done',
          budgetCents: 100,
          limits: {},
        },
      ],
      synthesis: {
        instructions: 'Synthesize',
        declaredInputs: [{ kind: 'stepOutput', stepKey: 'only-root', output: 'out' }],
        declaredOutput: 'final',
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Done',
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
    });
    expect(flatPlan.steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Topology materialization (VAL-SUB-001, 002, 003, 004, 005, 095, 107)
// — real Postgres integration tests
// ---------------------------------------------------------------------------

describe('Topology materialization (VAL-SUB-001, 002, 003, 005, 095)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let materializer: TopologyMaterializer;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ topology');
    materializer = new TopologyMaterializer(db, { clock: () => new Date() });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  /** Insert a root run and an approved plan revision directly into the DB. */
  async function setupApprovedRun(
    plan: PlanContent,
  ): Promise<{ runId: string; revisionId: string; hash: string }> {
    const runId = randomUUID();
    const revisionId = randomUUID();
    const hash = planContentHash(plan);
    const now = new Date();

    // Insert policy snapshot (minimal).
    const policySnapshotId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', '[]'::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 5000, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
    `);

    // Insert root run (queued, approved_plan_revision_id set after revision insert).
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "retry_of_run_id", "depth", "initiating_user_id", "initiating_agent_id", "executing_agent_id", "billing_agent_id", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "mode_profile_id", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "created_at", "updated_at")
      VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, NULL, NULL, 0, NULL, NULL, NULL, NULL, 'company_agent', 'encrypted-placeholder', ${hash}, 'Test run', NULL, 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, NULL, ${now}, ${now})
    `);

    // Insert the plan revision as approved (FK run_id → mission_runs satisfied).
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "parent_revision_id", "status", "content", "content_hash", "generated_by", "feedback", "estimates", "decided_by_user_id", "decided_at", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${runId}, 1, NULL, 'approved', ${JSON.stringify(plan)}::jsonb, ${hash}, '{}'::jsonb, NULL, '{}'::jsonb, NULL, NULL, ${now}, ${now})
    `);

    // Now set the approved_plan_revision_id (FK approved_plan_revision_id → run_plan_revisions satisfied).
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${runId}
    `);

    // Insert an approval binding.
    const approvalId = randomUUID();
    const bindingId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "approvals" ("id", "company_id", "project_id", "kind", "status", "title", "created_at", "updated_at")
      VALUES (${approvalId}, ${scope.companyId}, ${scope.projectId}, 'plan_gate', 'approved', 'Plan approval', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_approval_bindings" ("id", "company_id", "project_id", "run_id", "plan_revision_id", "content_hash", "approval_id", "decision", "deciding_user_id", "is_current_authorization", "created_at")
      VALUES (${bindingId}, ${scope.companyId}, ${scope.projectId}, ${runId}, ${revisionId}, ${hash}, ${approvalId}, 'approved', NULL, true, ${now})
    `);

    // Insert a budget reservation (minimal).
    const reservationId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
      VALUES (${reservationId}, ${scope.companyId}, ${runId}, NULL, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
    `);

    return { runId, revisionId, hash };
  }

  it('creates exactly one child shell per non-root topology node (VAL-SUB-002)', async () => {
    const plan = depthTwoPlanContent();
    const { runId, revisionId, hash } = await setupApprovedRun(plan);

    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    const children = await getChildRuns(db, runId);
    // 3 non-root steps: child-a, child-b, grandchild-a1
    expect(children).toHaveLength(3);

    // Each child maps to exactly one assignment.
    const assignments = await getAssignments(db, runId);
    expect(assignments).toHaveLength(3);

    // Verify step-to-child uniqueness: each step key appears once.
    const stepKeys = assignments.map((a) => a['step_key']);
    expect(new Set(stepKeys).size).toBe(3);

    // Verify no unknown or synthesis-only child.
    expect(stepKeys).toContain('child-a');
    expect(stepKeys).toContain('child-b');
    expect(stepKeys).toContain('grandchild-a1');
  });

  it('creates child shells with correct depth and parent linkage (VAL-SUB-002)', async () => {
    const plan = depthTwoPlanContent();
    const { runId, revisionId, hash } = await setupApprovedRun(plan);

    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    const children = await getChildRuns(db, runId);
    const byKey = new Map(children.map((c) => [c.id, c]));

    // Get assignments to map step keys to run IDs.
    const assignments = await getAssignments(db, runId);
    const stepToRun = new Map(
      assignments.map((a) => [a['step_key'] as string, a['run_id'] as string]),
    );

    // child-a and child-b are at depth 1, parent is root.
    const childA = byKey.get(stepToRun.get('child-a')!)!;
    expect(childA.depth).toBe(1);
    expect(childA.parentRunId).toBe(runId);

    const childB = byKey.get(stepToRun.get('child-b')!)!;
    expect(childB.depth).toBe(1);
    expect(childB.parentRunId).toBe(runId);

    // grandchild-a1 is at depth 2, parent is child-a's run.
    const grandchild = byKey.get(stepToRun.get('grandchild-a1')!)!;
    expect(grandchild.depth).toBe(2);
    expect(grandchild.parentRunId).toBe(stepToRun.get('child-a'));
  });

  it('emits child.created events after plan approval, with sequence after plan.approved (VAL-SUB-001)', async () => {
    const plan = depthTwoPlanContent();
    const { runId, revisionId, hash } = await setupApprovedRun(plan);

    const rootRun = await getRunRow(db, runId);

    // Before materialization: no child.created events.
    const eventsBefore = await getEvents(db, runId);
    expect(eventsBefore.filter((e) => e.type === 'child.created')).toHaveLength(0);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    // After materialization: child.created events exist.
    const eventsAfter = await getEvents(db, runId);
    const childCreatedEvents = eventsAfter.filter((e) => e.type === 'child.created');
    expect(childCreatedEvents).toHaveLength(3);

    // All child.created events should have increasing sequences.
    const seqs = childCreatedEvents.map((e) => e.sequence);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('gates children with required dependencies as pending_dependencies (VAL-SUB-003)', async () => {
    const plan = depthTwoPlanContent();
    const { runId, revisionId, hash } = await setupApprovedRun(plan);

    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    const assignments = await getAssignments(db, runId);
    const byStep = new Map(assignments.map((a) => [a['step_key'] as string, a]));

    // child-a: no dependencies → pending_routing (ready)
    expect(byStep.get('child-a')!['assignment_status']).toBe('pending_routing');

    // child-b: depends on child-a (required) → pending_dependencies
    expect(byStep.get('child-b')!['assignment_status']).toBe('pending_dependencies');

    // grandchild-a1: no dependencies → pending_routing (ready)
    expect(byStep.get('grandchild-a1')!['assignment_status']).toBe('pending_routing');

    // Dependency-blocked children should NOT be claimable (available_at is null).
    const children = await getChildRuns(db, runId);
    const stepToRun = new Map(
      assignments.map((a) => [a['step_key'] as string, a['run_id'] as string]),
    );
    const childBRun = children.find((c) => c.id === stepToRun.get('child-b'))!;
    expect(childBRun.availableAt).toBeNull();

    // Ready children SHOULD be claimable (available_at is set).
    const childARun = children.find((c) => c.id === stepToRun.get('child-a'))!;
    expect(childARun.availableAt).not.toBeNull();
  });

  it('makes independent ready steps claimable in parallel (VAL-SUB-004)', async () => {
    const plan = independentStepsPlanContent();
    const { runId, revisionId, hash } = await setupApprovedRun(plan);

    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    const children = await getChildRuns(db, runId);
    // Two independent children, both ready (pending_routing) and claimable.
    expect(children).toHaveLength(2);
    for (const child of children) {
      expect(child.status).toBe('queued');
      expect(child.availableAt).not.toBeNull();
    }

    const assignments = await getAssignments(db, runId);
    for (const a of assignments) {
      expect(a['assignment_status']).toBe('pending_routing');
    }
  });

  it('is idempotent: re-materializing creates no duplicate children (VAL-SUB-005)', async () => {
    const plan = depthTwoPlanContent();
    const { runId, revisionId, hash } = await setupApprovedRun(plan);

    const rootRun = await getRunRow(db, runId);

    // First materialization.
    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    const childrenAfterFirst = await getChildRuns(db, runId);
    expect(childrenAfterFirst).toHaveLength(3);

    // Reload root run (state version changed).
    const rootRun2 = await getRunRow(db, runId);

    // Second materialization — should be a no-op.
    const result = await db.drizzle.transaction(async (tx) => {
      return materializer.materialize(tx, rootRun2!, plan, revisionId, hash);
    });
    expect(result.created).toBe(false);

    const childrenAfterSecond = await getChildRuns(db, runId);
    expect(childrenAfterSecond).toHaveLength(3);

    const assignments = await getAssignments(db, runId);
    expect(assignments).toHaveLength(3);

    // Only one child.created event per step (no duplicates).
    const events = await getEvents(db, runId);
    expect(events.filter((e) => e.type === 'child.created')).toHaveLength(3);
  });

  it('blocks revision after child shells exist (VAL-SUB-095)', async () => {
    const plan = depthTwoPlanContent();
    const { runId, revisionId, hash } = await setupApprovedRun(plan);

    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    // Now try to revise the plan via the PlanDecisionService.
    // The run is in 'queued' status with child.created events.
    // Revision from queued should be rejected with EXECUTION_ALREADY_STARTED.
    const decisionService = new PlanDecisionService(db, { clock: () => new Date() });

    // The run is 'queued'. Attempt a revision request.
    const schema = db.schema;
    await db.drizzle.transaction(async (tx) => {
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, runId))
        .for('update')
        .limit(1);

      // PlanDecisionError wraps the underlying AppError; check the wrapped code.
      try {
        await decisionService.applyRevisionRequest(
          tx,
          lockedRun!,
          { revisionId, contentHash: hash, feedback: 'Need changes' },
          'user',
          'test-user',
          null,
        );
        expect.unreachable('applyRevisionRequest should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(PlanDecisionError);
        expect((err as PlanDecisionError).error.code).toBe('EXECUTION_ALREADY_STARTED');
      }
    });

    // Verify children are unchanged.
    const children = await getChildRuns(db, runId);
    expect(children).toHaveLength(3);
  });

  it('propagates required predecessor failure to dependents as DEPENDENCY_UNAVAILABLE (VAL-SUB-107)', async () => {
    const plan = depthTwoPlanContent();
    const { runId, revisionId, hash } = await setupApprovedRun(plan);

    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    const assignments = await getAssignments(db, runId);
    const stepToRun = new Map(
      assignments.map((a) => [a['step_key'] as string, a['run_id'] as string]),
    );
    const childARunId = stepToRun.get('child-a')!;
    const childBRunId = stepToRun.get('child-b')!;

    // Simulate child-a failing (required predecessor of child-b).
    await db.drizzle.transaction(async (tx) => {
      await materializer.propagateDependencyFailure(
        tx,
        runId,
        scope.companyId,
        scope.projectId,
        'child-a',
        childARunId,
      );
    });

    // child-b should now be failed with DEPENDENCY_UNAVAILABLE.
    const [childBRow] = (await db.drizzle.execute(sql`
      SELECT "status", "failure_category", "failure_code" FROM "mission_runs" WHERE "id" = ${childBRunId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(childBRow['status']).toBe('failed');
    expect(childBRow['failure_code']).toBe('DEPENDENCY_UNAVAILABLE');

    // The assignment should also reflect the failure.
    const [childBAssignment] = (await db.drizzle.execute(sql`
      SELECT "assignment_status", "result_status" FROM "run_step_assignments" WHERE "run_id" = ${childBRunId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(childBAssignment['assignment_status']).toBe('failed');
    expect(childBAssignment['result_status']).toBe('dependency_unavailable');

    // child-b should have a run.failed event.
    const childBEvents = await getEvents(db, childBRunId);
    expect(childBEvents.some((e) => e.type === 'run.failed')).toBe(true);

    // The root should have a child.failed event for child-b.
    const rootEvents = await getEvents(db, runId);
    const childFailedEvents = rootEvents.filter((e) => e.type === 'child.failed');
    expect(childFailedEvents.length).toBeGreaterThanOrEqual(1);
    expect(
      childFailedEvents.some(
        (e) => (e.payload as Record<string, unknown>)?.['failedDependencyStepKey'] === 'child-a',
      ),
    ).toBe(true);

    // Independent nodes (grandchild-a1) should NOT be failed.
    const grandchildRunId = stepToRun.get('grandchild-a1')!;
    const [grandchildRow] = (await db.drizzle.execute(sql`
      SELECT "status" FROM "mission_runs" WHERE "id" = ${grandchildRunId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(grandchildRow['status']).not.toBe('failed');
  });

  it('optional dependency does not block readiness (VAL-SUB-003, VAL-SUB-107)', async () => {
    // Build a plan where child-b has an optional dependency on child-a.
    const plan = depthTwoPlanContent();
    // Mark the dependency as optional.
    plan.steps[2].dependencyKinds = { 'child-a': 'optional' };

    // Re-validate and re-hash.
    const revalidated = validatePlan(plan);
    const { runId, revisionId, hash } = await setupApprovedRun(revalidated);

    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, revalidated, revisionId, hash);
    });

    const assignments = await getAssignments(db, runId);
    const byStep = new Map(assignments.map((a) => [a['step_key'] as string, a]));

    // child-b has only an optional dependency → should be ready (pending_routing).
    expect(byStep.get('child-b')!['assignment_status']).toBe('pending_routing');
  });

  it('does not materialize children for a flat plan (no non-root steps)', async () => {
    const flatPlan = validatePlan({
      schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
      objective: 'Flat plan',
      steps: [
        {
          stepKey: 'only-root',
          parentStepKey: null,
          childOrdinal: 0,
          nodeKind: 'root',
          title: 'Root',
          description: 'The only step',
          dependencies: [],
          inputBindings: [],
          routing: {
            kind: 'requirements',
            routingRequirements: {
              capabilities: [],
              requiredTools: [],
              requiredDomains: [],
              ephemeralAllowed: true,
            },
          },
          toolAllowlist: [],
          replayClass: 'read_only',
          sideEffecting: false,
          expectedOutputs: ['out'],
          evidenceRequirements: { citationsRequired: false },
          completionCriteria: 'Done',
          budgetCents: 100,
          limits: {},
        },
      ],
      synthesis: {
        instructions: 'Synthesize',
        declaredInputs: [{ kind: 'stepOutput', stepKey: 'only-root', output: 'out' }],
        declaredOutput: 'final',
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Done',
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
    });

    const { runId, revisionId, hash } = await setupApprovedRun(flatPlan);

    const rootRun = await getRunRow(db, runId);

    const result = await db.drizzle.transaction(async (tx) => {
      return materializer.materialize(tx, rootRun!, flatPlan, revisionId, hash);
    });
    expect(result.created).toBe(false);

    const children = await getChildRuns(db, runId);
    expect(children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// RunProcessor topology integration (VAL-SUB-001)
// ---------------------------------------------------------------------------

describe('RunProcessor topology materialization integration (VAL-SUB-001)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ topology-processor');
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('materializes topology when the worker claims a queued root with an approved plan', async () => {
    const plan = depthTwoPlanContent();
    const runId = randomUUID();
    const revisionId = randomUUID();
    const hash = planContentHash(plan);
    const now = new Date();

    // Insert policy snapshot.
    const policySnapshotId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', '[]'::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 5000, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
    `);

    // Insert root run as queued (approved_plan_revision_id set after revision insert).
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "retry_of_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "created_at", "updated_at")
      VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, NULL, NULL, 0, 'company_agent', 'encrypted-placeholder', ${hash}, 'Test run', 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, NULL, ${now}, ${now})
    `);

    // Insert approved plan revision (FK run_id → mission_runs satisfied).
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "parent_revision_id", "status", "content", "content_hash", "generated_by", "feedback", "estimates", "decided_by_user_id", "decided_at", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${runId}, 1, NULL, 'approved', ${JSON.stringify(plan)}::jsonb, ${hash}, '{}'::jsonb, NULL, '{}'::jsonb, NULL, NULL, ${now}, ${now})
    `);

    // Set the approved_plan_revision_id.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${runId}
    `);

    // Insert approval binding.
    const approvalId = randomUUID();
    const bindingId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "approvals" ("id", "company_id", "project_id", "kind", "status", "title", "created_at", "updated_at")
      VALUES (${approvalId}, ${scope.companyId}, ${scope.projectId}, 'plan_gate', 'approved', 'Plan approval', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_approval_bindings" ("id", "company_id", "project_id", "run_id", "plan_revision_id", "content_hash", "approval_id", "decision", "deciding_user_id", "is_current_authorization", "created_at")
      VALUES (${bindingId}, ${scope.companyId}, ${scope.projectId}, ${runId}, ${revisionId}, ${hash}, ${approvalId}, 'approved', NULL, true, ${now})
    `);

    // Insert budget reservation.
    const reservationId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
      VALUES (${reservationId}, ${scope.companyId}, ${runId}, NULL, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
    `);

    // Set up the worker with the run processor.
    const coordinator = new RunCoordinator(db, { clock: () => new Date() });
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
    const worker = new OrchestrationWorker({
      coordinator,
      advance: (claim, signal) => processor.advance(claim, signal),
      pollIntervalMs: 50,
    });

    await worker.start();
    // Wait for the worker to claim and process the root run.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await worker.stop();

    // Verify children were materialized.
    const children = await getChildRuns(db, runId);
    expect(children).toHaveLength(3);

    // Verify the root run is no longer queued (it should be running).
    const [rootRow] = (await db.drizzle.execute(sql`
      SELECT "status" FROM "mission_runs" WHERE "id" = ${runId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(rootRow['status']).toBe('running');

    // Verify child.created events exist.
    const events = await getEvents(db, runId);
    expect(events.filter((e) => e.type === 'child.created')).toHaveLength(3);
  });
});
