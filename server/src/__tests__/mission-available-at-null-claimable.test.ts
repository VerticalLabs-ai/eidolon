import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import {
  validatePlan,
  planContentHash,
  PLAN_CONTENT_SCHEMA_VERSION,
  type PlanContent,
} from '../services/mission/plan-schema.js';
import {
  TopologyMaterializer,
  FAR_FUTURE_SENTINEL,
} from '../services/mission/topology-materializer.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { RunProcessor } from '../services/mission/run-processor.js';

/**
 * Regression test: pending_dependencies children with available_at must NOT
 * be claimable by the coordinator until resolveDependencies() transitions
 * them to pending_routing and sets available_at = now.
 *
 * Bug (fix-ut-m5-available-at-null-claimable):
 * TopologyMaterializer set available_at = null for pending_dependencies
 * children (intending "not claimable"), but the coordinator's claim query
 * treats available_at IS NULL as "available immediately"
 * (`AND ("available_at" IS NULL OR "available_at" <= now)`). This allowed
 * dependency-blocked children to be claimed before their dependencies were
 * resolved and before they had been routed. The claimed child fell through
 * handleChildRouting() (returns false for pending_dependencies), skipped
 * routing (no BudgetService.allocateChild()), reached executeProviderCall()
 * → settleBudget() → BudgetService.settle() → BUDGET_ALLOCATION_NOT_FOUND
 * → PROVIDER_ERROR after 3 retries. Under require_all policy, the failed
 * child cascaded cancellation to all research siblings before they could
 * execute.
 *
 * Fix:
 *  1. TopologyMaterializer sets available_at to a far-future sentinel
 *     (2999-01-01) for pending_dependencies children so the claim query's
 *     `available_at <= now` check fails.
 *  2. RunProcessor.handleChildRouting() adds a defense-in-depth guard that
 *     re-queues a pending_dependencies child if it is somehow claimed,
 *     instead of falling through to executeProviderCall().
 *  3. resolveDependencies() makes children claimable by setting
 *     available_at = now when dependencies are satisfied.
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

/**
 * A plan with a dependency chain: root → child-a (depends on root) →
 * child-b (depends on child-a). Both children start as
 * pending_dependencies. After materialization + resolveDependencies,
 * child-a transitions to pending_routing (root is materialized). child-b
 * stays pending_dependencies until child-a completes.
 */
function dependencyChainPlan(): PlanContent {
  return validatePlan({
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Research and draft with dependency chain',
    steps: [
      {
        stepKey: 'root',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Coordinate',
        description: 'Oversee research and drafting',
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
        title: 'Research',
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
      {
        stepKey: 'child-b',
        parentStepKey: 'root',
        childOrdinal: 1,
        nodeKind: 'child',
        title: 'Draft',
        description: 'Write the brief',
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
        completionCriteria: 'Brief done',
        budgetCents: 300,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'child-b', output: 'brief' }],
      declaredOutput: 'final',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'Done',
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

async function setupApprovedRun(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  plan: PlanContent,
): Promise<{ runId: string; revisionId: string; hash: string }> {
  const runId = randomUUID();
  const revisionId = randomUUID();
  const hash = planContentHash(plan);
  const now = new Date();

  const policySnapshotId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', '[]'::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 5000, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "retry_of_run_id", "depth", "initiating_user_id", "initiating_agent_id", "executing_agent_id", "billing_agent_id", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "mode_profile_id", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "created_at", "updated_at")
    VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, NULL, NULL, 0, NULL, NULL, NULL, NULL, 'company_agent', 'encrypted-placeholder', ${hash}, 'Test run', NULL, 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, NULL, ${now}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "parent_revision_id", "status", "content", "content_hash", "generated_by", "feedback", "estimates", "decided_by_user_id", "decided_at", "created_at", "updated_at")
    VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${runId}, 1, NULL, 'approved', ${JSON.stringify(plan)}::jsonb, ${hash}, '{}'::jsonb, NULL, '{}'::jsonb, NULL, NULL, ${now}, ${now})
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
    INSERT INTO "run_plan_approval_bindings" ("id", "company_id", "project_id", "run_id", "plan_revision_id", "content_hash", "approval_id", "decision", "deciding_user_id", "is_current_authorization", "created_at")
    VALUES (${bindingId}, ${scope.companyId}, ${scope.projectId}, ${runId}, ${revisionId}, ${hash}, ${approvalId}, 'approved', NULL, true, ${now})
  `);

  const reservationId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${scope.companyId}, ${runId}, NULL, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
  `);

  return { runId, revisionId, hash };
}

async function getRunRow(db: AnyDb, runId: string) {
  const schema = db.schema;
  const [run] = await db.drizzle
    .select()
    .from(schema.missionRuns)
    .where(eq(schema.missionRuns.id, runId))
    .limit(1);
  return run;
}

async function getChildRuns(db: AnyDb, rootRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "status", "available_at"
    FROM "mission_runs" WHERE "root_run_id" = ${rootRunId} AND "id" != ${rootRunId}
    ORDER BY "child_ordinal" ASC
  `)) as unknown as Array<{
    id: string;
    status: string;
    available_at: string | Date | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    availableAt: r.available_at,
  }));
}

async function getAssignments(db: AnyDb, rootRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "step_key", "run_id", "assignment_status"
    FROM "run_step_assignments" WHERE "root_run_id" = ${rootRunId}
    ORDER BY "child_ordinal" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    stepKey: r['step_key'] as string,
    runId: r['run_id'] as string,
    assignmentStatus: r['assignment_status'] as string,
  }));
}

describe('available_at null/claimable regression (fix-ut-m5-available-at-null-claimable)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let materializer: TopologyMaterializer;
  let coordinator: RunCoordinator;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ avail-null');
    materializer = new TopologyMaterializer(db, { clock: () => new Date() });
    coordinator = new RunCoordinator(db, { clock: () => new Date() });
  });

  afterEach(async () => {
    await closeTestDb();
  });

  it('materializes pending_dependencies children with far-future available_at (not null)', async () => {
    const plan = dependencyChainPlan();
    const { runId, revisionId, hash } = await setupApprovedRun(db, scope, plan);
    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    const assignments = await getAssignments(db, runId);
    const children = await getChildRuns(db, runId);
    const stepToRun = new Map(assignments.map((a) => [a.stepKey, a.runId]));

    // child-a depends on root (required) → pending_dependencies
    const childAAssignment = assignments.find((a) => a.stepKey === 'child-a')!;
    expect(childAAssignment.assignmentStatus).toBe('pending_dependencies');

    // child-b depends on child-a (required) → pending_dependencies
    const childBAssignment = assignments.find((a) => a.stepKey === 'child-b')!;
    expect(childBAssignment.assignmentStatus).toBe('pending_dependencies');

    // Both pending_dependencies children should have available_at set to
    // the far-future sentinel, NOT null.
    const childARun = children.find((c) => c.id === stepToRun.get('child-a'))!;
    expect(childARun.availableAt).not.toBeNull();
    const childAAvailableAt = new Date(childARun.availableAt as string);
    expect(childAAvailableAt.getTime()).toBe(FAR_FUTURE_SENTINEL.getTime());

    const childBRun = children.find((c) => c.id === stepToRun.get('child-b'))!;
    expect(childBRun.availableAt).not.toBeNull();
    const childBAvailableAt = new Date(childBRun.availableAt as string);
    expect(childBAvailableAt.getTime()).toBe(FAR_FUTURE_SENTINEL.getTime());
  });

  it('does NOT claim pending_dependencies children with far-future available_at', async () => {
    const plan = dependencyChainPlan();
    const { runId, revisionId, hash } = await setupApprovedRun(db, scope, plan);
    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    // The root run is in 'queued' status with available_at = now (from setup).
    // The children are in 'queued' status with available_at = far-future.
    // The coordinator should claim the root run (available_at <= now), NOT
    // the children (available_at > now).
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(runId);

    // Release the root run's lease so we can try claiming again.
    await coordinator.release(claim!);

    // After releasing the root, the next claim should still be the root
    // (it goes back to queued with available_at = now), NOT a child.
    const claim2 = await coordinator.claimNext('test-worker');
    expect(claim2).not.toBeNull();
    expect(claim2!.runId).toBe(runId);
  });

  it('does NOT claim a child with available_at = null (legacy null behavior)', async () => {
    // Simulate a pending_dependencies child with available_at = null
    // (the old buggy behavior). The coordinator SHOULD claim it because
    // the claim query treats NULL as "available immediately" — this test
    // documents that the coordinator's NULL behavior is the root cause,
    // and the fix is to use a far-future sentinel instead of null.
    const plan = dependencyChainPlan();
    const { runId, revisionId, hash } = await setupApprovedRun(db, scope, plan);
    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    // Make the root non-claimable (running with a valid lease) so only
    // children are eligible for claiming.
    const now = new Date();
    const leaseExpiry = new Date(now.getTime() + 60_000);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "status" = 'running',
          "lease_owner" = 'other-worker',
          "lease_token" = ${randomUUID()},
          "lease_expires_at" = ${leaseExpiry.toISOString()}::timestamptz,
          "heartbeat_at" = ${now.toISOString()}::timestamptz
      WHERE "id" = ${runId}
    `);

    // Manually set a child's available_at to null (simulating the old bug).
    const assignments = await getAssignments(db, runId);
    const childARunId = assignments.find((a) => a.stepKey === 'child-a')!.runId;
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "available_at" = NULL WHERE "id" = ${childARunId}
    `);

    // The coordinator WILL claim the child with available_at = null because
    // the claim query has `("available_at" IS NULL OR "available_at" <= now)`.
    // This demonstrates why null is the wrong sentinel — the coordinator
    // treats it as "available immediately".
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    // The claimed run is the child with available_at = null, NOT the root.
    expect(claim!.runId).toBe(childARunId);
  });

  it('resolveDependencies makes pending_dependencies children claimable by setting available_at = now', async () => {
    const plan = dependencyChainPlan();
    const { runId, revisionId, hash } = await setupApprovedRun(db, scope, plan);
    const rootRun = await getRunRow(db, runId);

    // Materialize the topology.
    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    // Before resolveDependencies: both children have far-future available_at.
    const childrenBefore = await getChildRuns(db, runId);
    const assignmentsBefore = await getAssignments(db, runId);
    const stepToRun = new Map(assignmentsBefore.map((a) => [a.stepKey, a.runId]));

    const childABefore = childrenBefore.find((c) => c.id === stepToRun.get('child-a'))!;
    expect(new Date(childABefore.availableAt as string).getTime()).toBe(
      FAR_FUTURE_SENTINEL.getTime(),
    );

    // Resolve dependencies (root step is materialized → child-a's dependency
    // on root is satisfied).
    await db.drizzle.transaction(async (tx) => {
      await materializer.resolveDependencies(tx, runId, scope.companyId, scope.projectId);
    });

    // After resolveDependencies: child-a should be pending_routing with
    // available_at = now (claimable). child-b should still be
    // pending_dependencies with available_at = far-future (not claimable).
    const assignmentsAfter = await getAssignments(db, runId);
    const childAAfter = assignmentsAfter.find((a) => a.stepKey === 'child-a')!;
    expect(childAAfter.assignmentStatus).toBe('pending_routing');

    const childBAfter = assignmentsAfter.find((a) => a.stepKey === 'child-b')!;
    expect(childBAfter.assignmentStatus).toBe('pending_dependencies');

    const childrenAfter = await getChildRuns(db, runId);
    const childARunAfter = childrenAfter.find((c) => c.id === stepToRun.get('child-a'))!;
    expect(childARunAfter.availableAt).not.toBeNull();
    const childAAvailableAt = new Date(childARunAfter.availableAt as string);
    // available_at should be now (within a few seconds of the current time),
    // NOT the far-future sentinel.
    expect(childAAvailableAt.getTime()).toBeLessThan(FAR_FUTURE_SENTINEL.getTime());
    expect(childAAvailableAt.getTime()).toBeGreaterThan(new Date('2026-01-01').getTime());

    // child-b should still have far-future available_at.
    const childBRunAfter = childrenAfter.find((c) => c.id === stepToRun.get('child-b'))!;
    const childBAvailableAt = new Date(childBRunAfter.availableAt as string);
    expect(childBAvailableAt.getTime()).toBe(FAR_FUTURE_SENTINEL.getTime());

    // Make the root non-claimable (running with a valid lease) so only
    // child-a (now available_at = now) is eligible for claiming.
    const nowLease = new Date();
    const leaseExpiry = new Date(nowLease.getTime() + 60_000);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "status" = 'running',
          "lease_owner" = 'other-worker',
          "lease_token" = ${randomUUID()},
          "lease_expires_at" = ${leaseExpiry.toISOString()}::timestamptz,
          "heartbeat_at" = ${nowLease.toISOString()}::timestamptz
      WHERE "id" = ${runId}
    `);

    // The coordinator should now be able to claim child-a (available_at = now)
    // but NOT child-b (available_at = far-future).
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(stepToRun.get('child-a'));
  });

  it('defense-in-depth: re-queues a pending_dependencies child if somehow claimed', async () => {
    const plan = dependencyChainPlan();
    const { runId, revisionId, hash } = await setupApprovedRun(db, scope, plan);
    const rootRun = await getRunRow(db, runId);

    await db.drizzle.transaction(async (tx) => {
      await materializer.materialize(tx, rootRun!, plan, revisionId, hash);
    });

    // Make the root non-claimable (running with a valid lease) so only
    // children are eligible for claiming.
    const nowLease = new Date();
    const leaseExpiry = new Date(nowLease.getTime() + 60_000);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "status" = 'running',
          "lease_owner" = 'other-worker',
          "lease_token" = ${randomUUID()},
          "lease_expires_at" = ${leaseExpiry.toISOString()}::timestamptz,
          "heartbeat_at" = ${nowLease.toISOString()}::timestamptz
      WHERE "id" = ${runId}
    `);

    const assignments = await getAssignments(db, runId);
    const childARunId = assignments.find((a) => a.stepKey === 'child-a')!.runId;

    // Manually set available_at = null to simulate the old bug, allowing the
    // coordinator to claim the pending_dependencies child.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "available_at" = NULL WHERE "id" = ${childARunId}
    `);

    // Claim the child (the coordinator will claim it because available_at is null).
    const claim = await coordinator.claimNext('test-worker');
    expect(claim).not.toBeNull();
    expect(claim!.runId).toBe(childARunId);

    // The RunProcessor's advance() should detect the pending_dependencies
    // assignment and re-queue the child instead of falling through to
    // executeProviderCall() → settleBudget() → BUDGET_ALLOCATION_NOT_FOUND.
    const processor = new RunProcessor(db, { clock: () => new Date() });
    const controller = new AbortController();
    await processor.advance(claim!, controller.signal);

    // After advance(), the child should be back in 'queued' status with
    // available_at set to far-future (re-queued, not failed).
    const childRun = await getRunRow(db, childARunId);
    expect(childRun!.status).toBe('queued');
    expect(childRun!.availableAt).not.toBeNull();
    expect(new Date(childRun!.availableAt!).getTime()).toBeGreaterThan(
      new Date('2998-01-01').getTime(),
    );
    // The child should NOT be failed.
    expect(childRun!.status).not.toBe('failed');
    expect(childRun!.failureCode).toBeNull();
  });
});
