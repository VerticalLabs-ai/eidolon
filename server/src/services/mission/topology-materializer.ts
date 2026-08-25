import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../../types.js';
import { encryptEnvelope } from './ingress.js';
import type { PlanContent, PlanStep } from './plan-schema.js';
import { SubthreadProjectionService } from './subthread-projection.js';
import { TreeLimitsService, type TreePolicyLimits } from './tree-limits.js';

/**
 * TopologyMaterializer — materializes an approved plan topology into stable
 * child run shells and step assignments.
 *
 * (VAL-SUB-001, VAL-SUB-002, VAL-SUB-003, VAL-SUB-004, VAL-SUB-005,
 *  VAL-SUB-095, VAL-SUB-107)
 *
 * Called after plan approval when the worker claims the root run. For each
 * non-root executable topology node (step with `parentStepKey !== null`),
 * the materializer creates exactly one child run shell and one
 * `run_step_assignments` row, linked to the step key, parent step, child
 * ordinal, approved revision, and content hash.
 *
 * **Idempotency (VAL-SUB-005):** If assignments already exist for the root
 * run, the materializer is a no-op. A nonterminal retry reuses the existing
 * child run — no second child is created for the same approved step.
 *
 * **Dependency gating (VAL-SUB-003):** Each child's `assignment_status` is
 * set to `pending_dependencies` if the step has required dependencies, or
 * `pending_routing` if all dependencies are resolved (no dependencies, or
 * only optional dependencies). A child with unresolved required bindings
 * remains `pending_dependencies` and starts no routing or effect.
 *
 * **Independent parallel steps (VAL-SUB-004):** Ready independent children
 * (pending_routing) are made claimable by setting `available_at = now` and
 * `status = 'queued'`, so the worker can claim and advance them concurrently
 * (within concurrency/fan-out/budget limits enforced by later features).
 *
 * **Revision boundary (VAL-SUB-095):** The `child.created` events emitted by
 * materialization cause `hasApprovedStepEffectStarted` to return true, so
 * any post-materialization revision request returns 409
 * `EXECUTION_ALREADY_STARTED`.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

export interface TopologyMaterializerDeps {
  clock?: () => Date;
}

/** Result of materialization. */
export interface MaterializeResult {
  /** Whether new children were created in this call (false = already materialized). */
  created: boolean;
  /** IDs of the child runs created (empty if already materialized). */
  childRunIds: string[];
  /** The latest event sequence on the root run after materialization. */
  lastEventSequence: number;
  /** The root run's state version after materialization. */
  stateVersion: number;
}

export class TopologyMaterializer {
  constructor(
    private db: DbInstance,
    private deps: TopologyMaterializerDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Materialize the approved plan topology into child shells and assignments.
   *
   * Must be called inside a locked transaction where the root run row is
   * already locked via `FOR UPDATE`. The root run must have an
   * `approved_plan_revision_id`.
   *
   * If already materialized (assignments exist), this is a no-op and returns
   * `created: false` (VAL-SUB-005).
   */
  async materialize(
    tx: Tx,
    rootRun: MissionRunRow,
    plan: PlanContent,
    approvedRevisionId: string,
    approvedContentHash: string,
    actorType: 'user' | 'agent' | 'system' = 'system',
    actorId: string | null = null,
    traceId: string | null = null,
    /**
     * Effective root policy limits for tree limit enforcement
     * (VAL-SUB-029, 032, 039). When provided, depth and descendant
     * limits are enforced transactionally before creating child shells.
     */
    policyLimits?: TreePolicyLimits,
  ): Promise<MaterializeResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Idempotency: check if assignments already exist for this root run.
    const existing = await tx
      .select({ id: schema.runStepAssignments.id })
      .from(schema.runStepAssignments)
      .where(eq(schema.runStepAssignments.rootRunId, rootRun.id))
      .limit(1);

    if (existing.length > 0) {
      return {
        created: false,
        childRunIds: [],
        lastEventSequence: Number(rootRun.lastEventSequence),
        stateVersion: rootRun.stateVersion,
      };
    }

    // Separate root steps (parentStepKey === null) from non-root steps.
    // Only non-root executable topology nodes produce child shells
    // (VAL-SUB-002). Root steps are executed by the root run directly.
    const nonRootSteps = plan.steps.filter((s) => s.parentStepKey !== null);

    if (nonRootSteps.length === 0) {
      // No children to materialize — the root executes directly.
      return {
        created: false,
        childRunIds: [],
        lastEventSequence: Number(rootRun.lastEventSequence),
        stateVersion: rootRun.stateVersion,
      };
    }

    // Enforce tree limits (depth + descendants) before creating any child
    // shells (VAL-SUB-029, 032, 039). This is transactional and race-safe:
    // the root run is locked FOR UPDATE inside enforceTopologyLimits.
    if (policyLimits) {
      const treeLimits = new TreeLimitsService(this.db, { clock: () => now });
      // Compute the depth of each non-root step.
      const childDepths = nonRootSteps.map((step) => this.computeDepth(plan, step));
      await treeLimits.enforceTopologyLimits(tx, {
        rootRunId: rootRun.id,
        companyId: rootRun.companyId,
        projectId: rootRun.projectId,
        childDepths,
        policyLimits,
        actorType,
        actorId,
        traceId,
      });
    }

    // Build stepKey → runId map. Root steps map to the root run.
    // Non-root steps map to their newly created child runs.
    const stepRunMap = new Map<string, string>();
    for (const step of plan.steps) {
      if (step.parentStepKey === null) {
        stepRunMap.set(step.stepKey, rootRun.id);
      }
    }

    const childRunIds: string[] = [];
    let seq = Number(rootRun.lastEventSequence);

    // Process steps in topological order (parents before children) so that
    // a child's parent run exists when the child is created.
    const ordered = this.topologicalSort(plan.steps);

    for (const step of ordered) {
      if (step.parentStepKey === null) {
        continue;
      }

      const parentRunId = stepRunMap.get(step.parentStepKey);
      if (!parentRunId) {
        // This should not happen after topology validation, but guard
        // against an inconsistent plan.
        throw new Error(
          `Topology materializer: parent run not found for step "${step.stepKey}" (parent "${step.parentStepKey}")`,
        );
      }

      const childRunId = randomUUID();
      stepRunMap.set(step.stepKey, childRunId);
      childRunIds.push(childRunId);

      // Compute depth: parent depth + 1.
      const parentStep = plan.steps.find((s) => s.stepKey === step.parentStepKey);
      const parentDepth =
        parentStep?.parentStepKey === null ? 0 : this.computeDepth(plan, parentStep!);
      const childDepth = parentDepth + 1;

      // Compute dependency readiness.
      const hasRequiredDeps = this.hasUnresolvedRequiredDependencies(step);
      const assignmentStatus = hasRequiredDeps ? 'pending_dependencies' : 'pending_routing';
      const isReady = assignmentStatus === 'pending_routing';

      // Create the child run shell.
      await tx.insert(schema.missionRuns).values({
        id: childRunId,
        companyId: rootRun.companyId,
        projectId: rootRun.projectId,
        projectThreadId: rootRun.projectThreadId,
        rootRunId: rootRun.id,
        parentRunId,
        depth: childDepth,
        childOrdinal: step.childOrdinal,
        initiatingUserId: rootRun.initiatingUserId,
        initiatingAgentId: rootRun.initiatingAgentId,
        // Child policy is inherited from the parent; narrowing is m4-f03.
        policySnapshotId: rootRun.policySnapshotId,
        routingKind: 'company_agent',
        // Minimal request envelope from the step's title + description.
        // Full context isolation is m4-f04.
        requestEnvelope: encryptEnvelope({
          text: step.title,
          description: step.description,
          stepKey: step.stepKey,
          parentStepKey: step.parentStepKey,
        }),
        requestContentHash: approvedContentHash,
        requestSafeSummary: step.title,
        modeProfileId: rootRun.modeProfileId,
        resolvedMode: rootRun.resolvedMode,
        status: 'queued',
        stateVersion: 1,
        lastEventSequence: 0,
        partialResultPolicy: rootRun.partialResultPolicy,
        // Ready children are claimable immediately; dependency-blocked
        // children are not claimable until dependencies resolve.
        availableAt: isReady ? now : null,
        createdAt: now,
        updatedAt: now,
      });

      // Create the step assignment.
      await tx.insert(schema.runStepAssignments).values({
        companyId: rootRun.companyId,
        projectId: rootRun.projectId,
        rootRunId: rootRun.id,
        parentRunId,
        runId: childRunId,
        stepKey: step.stepKey,
        parentStepKey: step.parentStepKey,
        childOrdinal: step.childOrdinal,
        nodeKind: step.nodeKind,
        approvedPlanRevisionId: approvedRevisionId,
        approvedContentHash,
        assignmentStatus,
        routingRequirements:
          step.routing.kind === 'requirements' ? step.routing.routingRequirements : null,
        billingAgentId: rootRun.billingAgentId,
        createdAt: now,
        updatedAt: now,
      });

      // Create a dedicated nested subthread projection for the child
      // (VAL-SUB-007). The subthread is company/project scoped, marked
      // is_mission_subthread=true, and linked via run_projection_links
      // with a deterministic surface_key so repeated projection processing
      // does not create duplicate subthreads.
      const subthreadService = new SubthreadProjectionService(this.db, {
        clock: () => now,
      });
      await subthreadService.projectChildSubthread(tx, {
        companyId: rootRun.companyId,
        projectId: rootRun.projectId,
        runId: childRunId,
        title: step.title,
        rootThreadId: rootRun.projectThreadId,
      });

      // Emit child.created event on the root run journal.
      seq += 1;
      await tx.insert(schema.runEvents).values({
        companyId: rootRun.companyId,
        projectId: rootRun.projectId,
        runId: rootRun.id,
        sequence: seq,
        type: 'child.created',
        schemaVersion: 1,
        payload: {
          childRunId,
          stepKey: step.stepKey,
          parentStepKey: step.parentStepKey,
          childOrdinal: step.childOrdinal,
          depth: childDepth,
          assignmentStatus,
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });
    }

    // Update the root run's event sequence and state version.
    const newVersion = rootRun.stateVersion + 1;
    await tx
      .update(schema.missionRuns)
      .set({
        lastEventSequence: seq,
        stateVersion: newVersion,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, rootRun.id));

    return {
      created: true,
      childRunIds,
      lastEventSequence: seq,
      stateVersion: newVersion,
    };
  }

  /**
   * Check if a step has unresolved required dependencies.
   *
   * A dependency is required unless explicitly marked optional in
   * `dependencyKinds`. Required dependencies gate readiness: the child
   * remains `pending_dependencies` until all required predecessors have
   * completed (VAL-SUB-003). Optional dependencies do not block readiness.
   */
  private hasUnresolvedRequiredDependencies(step: PlanStep): boolean {
    if (step.dependencies.length === 0) {
      return false;
    }
    const kinds = step.dependencyKinds ?? {};
    for (const dep of step.dependencies) {
      const kind = kinds[dep] ?? 'required';
      if (kind === 'required') {
        return true;
      }
    }
    return false;
  }

  // -- dependency-success resolution (fix-ut-m5-dependency-resolution) ----

  /**
   * Resolve satisfied dependencies: transition step assignments from
   * `pending_dependencies` to `pending_routing` when all their required
   * dependencies are satisfied, and make the corresponding child runs
   * claimable by setting `available_at = now`.
   *
   * A required dependency is satisfied when:
   *  - The predecessor step is a root orchestration step (nodeKind='root')
   *    that has been materialized — the root's job was to decompose, so once
   *    children exist, the root step's dependency is satisfied.
   *  - The predecessor step's assignment is `completed` — the predecessor
   *    child run has finished successfully.
   *
   * Optional dependencies never block readiness and are always considered
   * satisfied.
   *
   * Must be called inside a locked transaction. Idempotent: assignments
   * already in `pending_routing` or later are not affected.
   *
   * Returns the step keys that were resolved in this call.
   */
  async resolveDependencies(
    tx: Tx,
    rootRunId: string,
    companyId: string,
    projectId: string,
    options: {
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
    } = {},
  ): Promise<{ resolvedStepKeys: string[] }> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = options.actorType ?? 'system';
    const actorId = options.actorId ?? null;
    const traceId = options.traceId ?? null;

    // Load all assignments for this root run.
    const assignments = await tx
      .select()
      .from(schema.runStepAssignments)
      .where(eq(schema.runStepAssignments.rootRunId, rootRunId));

    if (assignments.length === 0) {
      return { resolvedStepKeys: [] };
    }

    // Early return: if no assignments are in pending_dependencies status,
    // there is nothing to resolve. This avoids loading the root run/plan
    // revision and writing to the root run's lastEventSequence/stateVersion
    // inside a child's completion transaction, which could cause a conflict
    // (fix-ut-m5-dependency-resolution).
    const hasPendingDeps = assignments.some((a) => a.assignmentStatus === 'pending_dependencies');
    if (!hasPendingDeps) {
      return { resolvedStepKeys: [] };
    }

    // Load the approved plan revision to inspect step dependencies and
    // node kinds.
    const [rootRun] = await tx
      .select({ approvedPlanRevisionId: schema.missionRuns.approvedPlanRevisionId })
      .from(schema.missionRuns)
      .where(and(eq(schema.missionRuns.companyId, companyId), eq(schema.missionRuns.id, rootRunId)))
      .limit(1);

    if (!rootRun || !rootRun.approvedPlanRevisionId) {
      return { resolvedStepKeys: [] };
    }

    const [revision] = await tx
      .select({ content: schema.runPlanRevisions.content })
      .from(schema.runPlanRevisions)
      .where(eq(schema.runPlanRevisions.id, rootRun.approvedPlanRevisionId))
      .limit(1);

    if (!revision) {
      return { resolvedStepKeys: [] };
    }

    const plan = revision.content as unknown as PlanContent;
    const planStepByKey = new Map(plan.steps.map((s) => [s.stepKey, s]));
    const assignmentByStepKey = new Map(assignments.map((a) => [a.stepKey, a]));

    const resolvedStepKeys: string[] = [];

    for (const assignment of assignments) {
      // Only resolve assignments currently in pending_dependencies.
      if (assignment.assignmentStatus !== 'pending_dependencies') {
        continue;
      }

      const step = planStepByKey.get(assignment.stepKey);
      if (!step) {
        continue;
      }

      // Check whether all required dependencies are satisfied.
      if (this.areRequiredDependenciesSatisfied(step, planStepByKey, assignmentByStepKey)) {
        // Transition the assignment to pending_routing.
        await tx
          .update(schema.runStepAssignments)
          .set({
            assignmentStatus: 'pending_routing',
            updatedAt: now,
          })
          .where(eq(schema.runStepAssignments.id, assignment.id));

        // Make the child run claimable by setting available_at = now.
        await tx
          .update(schema.missionRuns)
          .set({
            availableAt: now,
            updatedAt: now,
          })
          .where(eq(schema.missionRuns.id, assignment.runId));

        // Emit a child.dependencies_resolved event on the root journal.
        const rootSeq = await this.getNextSequence(tx, companyId, rootRunId);
        await tx.insert(schema.runEvents).values({
          companyId,
          projectId,
          runId: rootRunId,
          sequence: rootSeq.seq,
          type: 'child.dependencies_resolved',
          schemaVersion: 1,
          payload: {
            childRunId: assignment.runId,
            stepKey: assignment.stepKey,
            resolvedDependencies: step.dependencies,
          },
          actorType,
          actorId,
          traceId,
          occurredAt: now,
        });

        // Update root run sequence and state version.
        await tx
          .update(schema.missionRuns)
          .set({
            lastEventSequence: rootSeq.seq,
            stateVersion: rootSeq.newVersion,
            updatedAt: now,
          })
          .where(eq(schema.missionRuns.id, rootRunId));

        resolvedStepKeys.push(assignment.stepKey);
      }
    }

    return { resolvedStepKeys };
  }

  /**
   * Check whether all required dependencies of a step are satisfied.
   *
   * A required dependency is satisfied when:
   *  - The predecessor step has nodeKind='root' (the root orchestration
   *    step whose job was to decompose — once children are materialized,
   *    the root's dependency is satisfied).
   *  - The predecessor step's assignment is 'completed' (the predecessor
   *    child run has finished successfully).
   *
   * Optional dependencies are always considered satisfied.
   */
  private areRequiredDependenciesSatisfied(
    step: PlanStep,
    planStepByKey: Map<string, PlanStep>,
    assignmentByStepKey: Map<string, { assignmentStatus: string }>,
  ): boolean {
    if (step.dependencies.length === 0) {
      return true;
    }

    const kinds = step.dependencyKinds ?? {};
    for (const dep of step.dependencies) {
      const kind = kinds[dep] ?? 'required';
      if (kind === 'optional') {
        continue; // optional deps never block
      }

      // Required dependency — check if satisfied.
      const predecessorStep = planStepByKey.get(dep);
      if (!predecessorStep) {
        // Unknown dependency — cannot resolve.
        return false;
      }

      // A root orchestration step (nodeKind='root') is satisfied once
      // children are materialized. The root's job was to decompose; once
      // assignments exist, the root step's dependency is satisfied.
      if (predecessorStep.nodeKind === 'root') {
        continue; // satisfied — root was materialized
      }

      // A non-root predecessor is satisfied when its assignment is
      // 'completed'.
      const predecessorAssignment = assignmentByStepKey.get(dep);
      if (!predecessorAssignment || predecessorAssignment.assignmentStatus !== 'completed') {
        return false;
      }
    }

    return true;
  }

  /**
   * Compute the depth of a step (distance from root via parent chain).
   */
  private computeDepth(plan: PlanContent, step: PlanStep): number {
    let depth = 0;
    let current: PlanStep | undefined = step;
    while (current && current.parentStepKey !== null) {
      depth += 1;
      current = plan.steps.find((s) => s.stepKey === current!.parentStepKey);
    }
    return depth;
  }

  /**
   * Topologically sort steps by parent chain (parents before children).
   * Uses Kahn's algorithm on the parent relationship.
   */
  private topologicalSort(steps: PlanStep[]): PlanStep[] {
    const byKey = new Map(steps.map((s) => [s.stepKey, s]));
    const inDegree = new Map<string, number>();
    const children = new Map<string, string[]>();

    for (const step of steps) {
      inDegree.set(step.stepKey, 0);
      children.set(step.stepKey, []);
    }

    for (const step of steps) {
      if (step.parentStepKey !== null && byKey.has(step.parentStepKey)) {
        inDegree.set(step.stepKey, (inDegree.get(step.stepKey) ?? 0) + 1);
        children.get(step.parentStepKey)!.push(step.stepKey);
      }
    }

    const queue: string[] = [];
    for (const [key, deg] of inDegree) {
      if (deg === 0) {
        queue.push(key);
      }
    }

    const result: PlanStep[] = [];
    while (queue.length > 0) {
      const key = queue.shift()!;
      result.push(byKey.get(key)!);
      for (const child of children.get(key) ?? []) {
        inDegree.set(child, (inDegree.get(child) ?? 0) - 1);
        if (inDegree.get(child) === 0) {
          queue.push(child);
        }
      }
    }

    return result;
  }

  // -- dependency outcome propagation (VAL-SUB-107) -----------------------

  /**
   * Propagate a predecessor's terminal outcome to dependent children.
   *
   * When a required predecessor fails or is cancelled, every bound
   * dependent shell fails `DEPENDENCY_UNAVAILABLE` with predecessor/node
   * IDs, zero routing/effects, and one cardinality count. Independent nodes
   * continue under best effort; optional edges supply a typed unavailable
   * value (VAL-SUB-107).
   *
   * Must be called inside a locked transaction. Returns the IDs of children
   * that were terminally failed.
   */
  async propagateDependencyFailure(
    tx: Tx,
    rootRunId: string,
    companyId: string,
    projectId: string,
    failedStepKey: string,
    failedRunId: string,
    actorType: 'user' | 'agent' | 'system' = 'system',
    actorId: string | null = null,
    traceId: string | null = null,
  ): Promise<{ failedChildRunIds: string[] }> {
    const schema = this.db.schema;
    const now = this.now();

    // Find all assignments for this root tree that depend on the failed step.
    const allAssignments = await tx
      .select()
      .from(schema.runStepAssignments)
      .where(eq(schema.runStepAssignments.rootRunId, rootRunId));

    // Load the approved plan to check dependency kinds.
    const [rootRun] = await tx
      .select()
      .from(schema.missionRuns)
      .where(and(eq(schema.missionRuns.companyId, companyId), eq(schema.missionRuns.id, rootRunId)))
      .limit(1);

    if (!rootRun || !rootRun.approvedPlanRevisionId) {
      return { failedChildRunIds: [] };
    }

    const [revision] = await tx
      .select()
      .from(schema.runPlanRevisions)
      .where(eq(schema.runPlanRevisions.id, rootRun.approvedPlanRevisionId))
      .limit(1);

    if (!revision) {
      return { failedChildRunIds: [] };
    }

    const plan = revision.content as unknown as PlanContent;
    const failedChildRunIds: string[] = [];

    for (const assignment of allAssignments) {
      // Skip already-terminal assignments.
      if (['completed', 'failed', 'cancelled'].includes(assignment.assignmentStatus)) {
        continue;
      }

      const step = plan.steps.find((s) => s.stepKey === assignment.stepKey);
      if (!step) {
        continue;
      }

      // Check if this step has a required dependency on the failed step.
      const kinds = step.dependencyKinds ?? {};
      const hasRequiredDep = step.dependencies.some(
        (dep) => dep === failedStepKey && (kinds[dep] ?? 'required') === 'required',
      );

      if (!hasRequiredDep) {
        continue;
      }

      // Fail the dependent child with DEPENDENCY_UNAVAILABLE.
      const childRunId = assignment.runId;
      failedChildRunIds.push(childRunId);

      // Update the child run to failed.
      const childSeq = await this.getNextSequence(tx, companyId, childRunId);
      await tx
        .update(schema.missionRuns)
        .set({
          status: 'failed',
          failureCategory: 'dependency',
          failureCode: 'DEPENDENCY_UNAVAILABLE',
          safeErrorMessage: `Required dependency "${failedStepKey}" is unavailable.`,
          terminalAt: now,
          stateVersion: childSeq.newVersion,
          lastEventSequence: childSeq.seq,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, childRunId));

      // Emit run.failed event on the child.
      await tx.insert(schema.runEvents).values({
        companyId,
        projectId,
        runId: childRunId,
        sequence: childSeq.seq,
        type: 'run.failed',
        schemaVersion: 1,
        payload: {
          category: 'dependency',
          code: 'DEPENDENCY_UNAVAILABLE',
          failedDependencyStepKey: failedStepKey,
          failedDependencyRunId: failedRunId,
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      // Update the assignment to failed.
      await tx
        .update(schema.runStepAssignments)
        .set({
          assignmentStatus: 'failed',
          resultStatus: 'dependency_unavailable',
          failureCategory: 'dependency',
          failureCode: 'DEPENDENCY_UNAVAILABLE',
          safeErrorMessage: `Required dependency "${failedStepKey}" is unavailable.`,
          updatedAt: now,
        })
        .where(eq(schema.runStepAssignments.id, assignment.id));

      // Emit child.failed event on the root run.
      const rootSeq = await this.getNextSequence(tx, companyId, rootRunId);
      await tx.insert(schema.runEvents).values({
        companyId,
        projectId,
        runId: rootRunId,
        sequence: rootSeq.seq,
        type: 'child.failed',
        schemaVersion: 1,
        payload: {
          childRunId,
          stepKey: assignment.stepKey,
          category: 'dependency',
          code: 'DEPENDENCY_UNAVAILABLE',
          failedDependencyStepKey: failedStepKey,
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      // Update root run sequence.
      await tx
        .update(schema.missionRuns)
        .set({
          lastEventSequence: rootSeq.seq,
          stateVersion: rootSeq.newVersion,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, rootRunId));
    }

    return { failedChildRunIds };
  }

  /**
   * Get the next event sequence and incremented state version for a run.
   */
  private async getNextSequence(
    tx: Tx,
    companyId: string,
    runId: string,
  ): Promise<{ seq: number; newVersion: number }> {
    const schema = this.db.schema;
    const [run] = await tx
      .select({
        stateVersion: schema.missionRuns.stateVersion,
        lastEventSequence: schema.missionRuns.lastEventSequence,
      })
      .from(schema.missionRuns)
      .where(and(eq(schema.missionRuns.companyId, companyId), eq(schema.missionRuns.id, runId)))
      .limit(1);
    if (!run) {
      throw new Error(`Run not found: ${runId}`);
    }
    return {
      seq: Number(run.lastEventSequence) + 1,
      newVersion: run.stateVersion + 1,
    };
  }

  /**
   * Check if a root run's topology has already been materialized.
   */
  async isMaterialized(rootRunId: string): Promise<boolean> {
    const schema = this.db.schema;
    const rows = await this.db.drizzle
      .select({ id: schema.runStepAssignments.id })
      .from(schema.runStepAssignments)
      .where(eq(schema.runStepAssignments.rootRunId, rootRunId))
      .limit(1);
    return rows.length > 0;
  }

  /**
   * Get all step assignments for a root run.
   */
  async getAssignments(rootRunId: string) {
    const schema = this.db.schema;
    return this.db.drizzle
      .select()
      .from(schema.runStepAssignments)
      .where(eq(schema.runStepAssignments.rootRunId, rootRunId));
  }
}
