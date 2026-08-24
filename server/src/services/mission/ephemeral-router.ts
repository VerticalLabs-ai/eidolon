import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../../types.js';
import type { RoutingRequirements } from './plan-schema.js';
import { policyContentHash, type ResolvedPolicy } from './policy.js';
import type { ModeLimits } from './modes.js';
import { BudgetService } from './budget.js';
import { getServerProviderApiKey } from '../provider-key.js';
import { AppError } from '../../middleware/error-handler.js';

/**
 * EphemeralFallbackRouter — bounded ephemeral fallback when no eligible
 * company agent exists for a child step.
 *
 * (VAL-SUB-019, VAL-SUB-021, VAL-SUB-022, VAL-SUB-023, VAL-SUB-090,
 *  VAL-SUB-091, VAL-SUB-114, VAL-MODEQ-043)
 *
 * When the AgentRouter returns `selected: false` (no eligible company agent),
 * this router decides the child's fate:
 *
 *  - If ephemeral routing is **allowed** by the approved step's routing
 *    requirements AND all independent requirements are satisfied, the child
 *    becomes an **ephemeral** run: it inherits the parent's provider/model,
 *    instruction hash, tools, domains, billing identity, and all parent caps
 *    (narrowed by the step budget). It has **no permanent executing agent**
 *    (`executing_agent_id = NULL`) but charges the inherited **non-null
 *    billing-agent** identity. It creates **no agent, profile, memory,
 *    session, or long-term instruction record** and never becomes a routing
 *    candidate (VAL-SUB-021, VAL-SUB-091).
 *
 *  - If ephemeral routing is **disallowed** or **infeasible** (any independent
 *    requirement fails), the already-created topology shell **terminally
 *    fails** with safe code `NO_ELIGIBLE_AGENT`. It retains null routing
 *    kind, counts once toward descendant/fan-out cardinality, consumes zero
 *    provider calls/tokens/output/settled cost, and releases any provisional
 *    permit/allocation exactly once (VAL-SUB-019, VAL-SUB-114).
 *
 * Independent requirements (VAL-SUB-090):
 *  1. `ephemeralAllowed` must be true in the routing requirements.
 *  2. Parent-snapshot provider must have a server-side credential available.
 *  3. Required tools must be a subset of the parent policy's tool allowlist.
 *  4. Required domains must be a subset of the parent policy's domain allowlist.
 *  5. Billing agent must be non-null (ephemeral children charge a real
 *     billing identity — VAL-SUB-023).
 *  6. Billing agent must have remaining budget headroom for the step cost
 *     (unless unlimited).
 *  7. Step timeout must not exceed the parent policy's duration limit.
 *
 * Any missing requirement fails closed — ephemeral fallback compensates
 * only for workforce availability/capacity, never for policy, credential,
 * or authority gaps (VAL-SUB-090).
 *
 * The ephemeral child's policy is **equal to or narrower than** its parent
 * for every field (VAL-MODEQ-043, VAL-SUB-022). It ignores live broadening
 * (the snapshot is immutable) while current deny-only security revocation
 * still blocks future effects without changing the immutable hash
 * (VAL-SUB-022).
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export interface EphemeralRouterDeps {
  clock?: () => Date;
  /**
   * Override credential availability check. If not provided, the real
   * server-side provider key check is used. Tests inject `true` to avoid
   * needing real API keys in the test environment.
   */
  hasCredential?: boolean;
}

/** Context for ephemeral fallback routing. */
export interface EphemeralRoutingContext {
  companyId: string;
  projectId: string;
  rootRunId: string;
  parentRunId: string;
  childRunId: string;
  stepKey: string;
  routingRequirements: RoutingRequirements;
  /** Estimated step cost in integer cents. */
  stepBudgetCents: number;
  /** Required execution timeout in seconds. */
  stepTimeoutSeconds: number;
  /** Billing agent identity for cost attribution (must be non-null for ephemeral). */
  billingAgentId: string | null;
}

/** Result of ephemeral fallback routing. */
export interface EphemeralRoutingResult {
  /** 'ephemeral' if the child was routed as ephemeral, 'failed' if it terminally failed. */
  outcome: 'ephemeral' | 'failed';
  /** Routing kind: 'ephemeral' or null (for failed). */
  routingKind: 'ephemeral' | null;
  /** Safe reason code. 'ephemeral' on success, 'NO_ELIGIBLE_AGENT' on failure. */
  reason: string;
  /** Child policy snapshot ID (if routed as ephemeral). */
  policySnapshotId: string | null;
  /** Child policy content hash (if routed as ephemeral). */
  policyContentHash: string | null;
  /** Budget allocation ID (if routed as ephemeral). */
  budgetAllocationId: string | null;
  /** Safe denial reason if the outcome is 'failed' (protected diagnostics). */
  denialReason: string | null;
}

/**
 * Derive an immutable ephemeral child policy from the parent policy
 * narrowed by the step's budget and timeout (VAL-MODEQ-043, VAL-SUB-022).
 *
 * The ephemeral child inherits the parent's provider/model, instruction hash,
 * tools, domains, research/planning/approval/fallback policies, partial-result
 * policy, and resolved mode. It narrows only the numeric limits:
 * - costCents = min(parent.costCents, stepBudgetCents)
 * - durationSeconds = min(parent.durationSeconds, stepTimeoutSeconds)
 *
 * Tools and domains are inherited as-is from the parent (the step's required
 * tools/domains are eligibility checks, not additional narrowing — they are
 * already a subset of the parent's allowlist, verified before calling this
 * function). This ensures the child policy is **equal to or narrower than**
 * the parent for every field (VAL-MODEQ-043).
 *
 * This is a pure function: it does not touch Postgres.
 */
export function deriveEphemeralChildPolicy(input: {
  parentPolicy: ResolvedPolicy;
  stepBudgetCents: number;
  stepTimeoutSeconds: number;
}): ResolvedPolicy {
  const { parentPolicy } = input;

  const limits: ModeLimits = {
    steps: parentPolicy.limits.steps,
    durationSeconds: Math.min(parentPolicy.limits.durationSeconds, input.stepTimeoutSeconds),
    providerCalls: parentPolicy.limits.providerCalls,
    totalTokens: parentPolicy.limits.totalTokens,
    outputBytes: parentPolicy.limits.outputBytes,
    costCents: Math.min(parentPolicy.limits.costCents, input.stepBudgetCents),
    depth: parentPolicy.limits.depth,
    fanOut: parentPolicy.limits.fanOut,
    descendants: parentPolicy.limits.descendants,
  };

  return {
    schemaVersion: parentPolicy.schemaVersion,
    sourceProfile: parentPolicy.sourceProfile,
    sourceProfileName: parentPolicy.sourceProfileName,
    sourceProfileDescription: parentPolicy.sourceProfileDescription,
    sourceProfileVersion: parentPolicy.sourceProfileVersion ?? null,
    modeProfileId: parentPolicy.modeProfileId ?? null,
    provider: parentPolicy.provider,
    adapterId: parentPolicy.adapterId,
    model: parentPolicy.model,
    reasoningDepth: parentPolicy.reasoningDepth,
    systemPromptHash: parentPolicy.systemPromptHash,
    instructionHash: parentPolicy.instructionHash,
    toolAllowlist: [...parentPolicy.toolAllowlist],
    domainAllowlist: [...parentPolicy.domainAllowlist],
    researchPolicy: parentPolicy.researchPolicy,
    planningPolicy: parentPolicy.planningPolicy,
    approvalPolicy: parentPolicy.approvalPolicy,
    fallbackPolicy: parentPolicy.fallbackPolicy,
    partialResultPolicy: parentPolicy.partialResultPolicy,
    limits,
    resolvedMode: parentPolicy.resolvedMode,
  };
}

/**
 * Check all independent requirements for ephemeral fallback (VAL-SUB-090).
 *
 * Ephemeral fallback compensates only for workforce availability/capacity
 * and independently requires:
 *  1. ephemeralAllowed is true.
 *  2. Parent-snapshot provider has a server-side credential.
 *  3. Required tools are a subset of parent tool allowlist.
 *  4. Required domains are a subset of parent domain allowlist.
 *  5. Billing agent is non-null.
 *  6. Billing agent has remaining budget headroom (if budget is finite).
 *  7. Step timeout does not exceed parent duration limit.
 *
 * @returns `null` if all requirements are satisfied, or a safe denial
 *   reason code if any requirement fails.
 */
export function checkEphemeralRequirements(input: {
  routingRequirements: RoutingRequirements;
  parentPolicy: ResolvedPolicy;
  billingAgentId: string | null;
  billingAgentBudgetMonthlyCents: number;
  billingAgentSpentMonthlyCents: number;
  billingAgentResidualAllocations: number;
  stepBudgetCents: number;
  stepTimeoutSeconds: number;
  /** Whether a server-side credential is available for the parent provider. */
  hasCredential?: boolean;
}): string | null {
  const { routingRequirements: req, parentPolicy } = input;

  // 1. Ephemeral must be explicitly allowed.
  if (!req.ephemeralAllowed) {
    return 'EPHEMERAL_DISALLOWED';
  }

  // 2. Parent-snapshot provider must have a server-side credential.
  const hasCredential = input.hasCredential ?? !!getServerProviderApiKey(parentPolicy.provider);
  if (!hasCredential) {
    return 'NO_CREDENTIAL';
  }

  // 3. Required tools must be a subset of parent tool allowlist.
  const parentTools = new Set(parentPolicy.toolAllowlist);
  const missingTools = req.requiredTools.filter((t) => !parentTools.has(t));
  if (missingTools.length > 0) {
    return 'MISSING_TOOLS';
  }

  // 4. Required domains must be a subset of parent domain allowlist.
  const parentDomains = new Set(parentPolicy.domainAllowlist);
  const missingDomains = req.requiredDomains.filter((d) => !parentDomains.has(d));
  if (missingDomains.length > 0) {
    return 'MISSING_DOMAINS';
  }

  // 5. Billing agent must be non-null (VAL-SUB-023).
  if (!input.billingAgentId) {
    return 'NO_BILLING_AGENT';
  }

  // 6. Billing agent must have remaining budget headroom.
  if (input.billingAgentBudgetMonthlyCents > 0) {
    const remaining =
      input.billingAgentBudgetMonthlyCents -
      input.billingAgentSpentMonthlyCents -
      input.billingAgentResidualAllocations;
    if (remaining < input.stepBudgetCents) {
      return 'INSUFFICIENT_BILLING_HEADROOM';
    }
  }

  // 7. Step timeout must not exceed parent duration limit.
  if (input.stepTimeoutSeconds > parentPolicy.limits.durationSeconds) {
    return 'INSUFFICIENT_TIMEOUT';
  }

  return null;
}

export class EphemeralFallbackRouter {
  constructor(
    private db: DbInstance,
    private deps: EphemeralRouterDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Attempt ephemeral fallback routing for a child step that had no eligible
   * company agent.
   *
   * If all independent requirements pass, atomically:
   * - Derives and persists one immutable child execution-policy snapshot
   *   (parent policy narrowed by step budget/timeout).
   * - Creates a child budget allocation from the root reservation.
   * - Sets `routing_kind='ephemeral'`, `executing_agent_id=NULL`,
   *   `billing_agent_id` on the child run.
   * - Sets `assignment_status='routed'`, `routing_kind='ephemeral'` on the
   *   step assignment.
   * - Emits `child.routed` on the root run journal with `routingKind: 'ephemeral'`.
   * - Creates NO agent, profile, memory, session, or long-term instruction
   *   record (VAL-SUB-021, VAL-SUB-091).
   *
   * If any requirement fails, atomically terminally fails the child with
   * `NO_ELIGIBLE_AGENT`:
   * - Sets the child run to `failed` with safe code `NO_ELIGIBLE_AGENT`.
   * - Retains null `routing_kind` on the step assignment.
   * - Releases any provisional permit/allocation exactly once.
   * - Emits `child.failed` on the root journal.
   * - Consumes zero provider calls/tokens/output/settled cost (VAL-SUB-019,
   *   VAL-SUB-114).
   *
   * Idempotent: if the assignment is already routed or failed, returns the
   * existing result without duplicating events.
   */
  async routeOrFail(ctx: EphemeralRoutingContext): Promise<EphemeralRoutingResult> {
    // Idempotency: check if the child is already routed or failed.
    const existing = await this.checkExistingState(ctx);
    if (existing) {
      return existing;
    }

    const resultRef: { value: EphemeralRoutingResult | null } = { value: null };

    await this.db.drizzle.transaction(async (tx) => {
      // Re-check idempotency inside the transaction.
      const alreadyHandled = await this.checkExistingStateInTx(tx, ctx);
      if (alreadyHandled) {
        resultRef.value = alreadyHandled;
        return;
      }

      // Load and reconstruct the parent policy snapshot.
      const parentPolicy = await this.loadParentPolicy(tx, ctx);
      if (!parentPolicy) {
        resultRef.value = await this.failChild(tx, ctx, 'NO_PARENT_POLICY');
        return;
      }

      // Load billing agent budget info.
      const billing = await this.loadBillingInfo(tx, ctx);

      // Check all independent requirements.
      const denialReason = checkEphemeralRequirements({
        routingRequirements: ctx.routingRequirements,
        parentPolicy,
        billingAgentId: ctx.billingAgentId,
        billingAgentBudgetMonthlyCents: billing.budgetMonthlyCents,
        billingAgentSpentMonthlyCents: billing.spentMonthlyCents,
        billingAgentResidualAllocations: billing.residualAllocations,
        stepBudgetCents: ctx.stepBudgetCents,
        stepTimeoutSeconds: ctx.stepTimeoutSeconds,
        hasCredential: this.deps.hasCredential,
      });

      if (denialReason !== null) {
        resultRef.value = await this.failChild(tx, ctx, denialReason);
        return;
      }

      // All requirements pass — create the ephemeral child. If the root
      // residual is insufficient for the child allocation, allocateChild
      // throws BUDGET_UNAVAILABLE; catch it and fail the shell closed
      // instead of propagating an unhandled error (VAL-CROSS-063:
      // concurrent allocations either succeed within the hold or fail
      // explicitly without overspending).
      try {
        resultRef.value = await this.createEphemeralChild(tx, ctx, parentPolicy);
      } catch (err) {
        if (err instanceof AppError && err.code === 'BUDGET_UNAVAILABLE') {
          resultRef.value = await this.failChild(tx, ctx, 'INSUFFICIENT_ROOT_RESIDUAL');
        } else {
          throw err;
        }
      }
    });

    return resultRef.value!;
  }

  /**
   * Load and reconstruct the parent run's ResolvedPolicy from its
   * immutable policy snapshot (inside a transaction).
   * Returns null if the parent run or snapshot is not found.
   */
  private async loadParentPolicy(
    tx: Tx,
    ctx: EphemeralRoutingContext,
  ): Promise<ResolvedPolicy | null> {
    const schema = this.db.schema;

    const [parentRun] = await tx
      .select({
        policySnapshotId: schema.missionRuns.policySnapshotId,
        resolvedMode: schema.missionRuns.resolvedMode,
        modeProfileId: schema.missionRuns.modeProfileId,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.parentRunId),
        ),
      )
      .limit(1);

    if (!parentRun || !parentRun.policySnapshotId) {
      return null;
    }

    const [parentSnapshot] = await tx
      .select()
      .from(schema.runPolicySnapshots)
      .where(
        and(
          eq(schema.runPolicySnapshots.companyId, ctx.companyId),
          eq(schema.runPolicySnapshots.id, parentRun.policySnapshotId),
        ),
      )
      .limit(1);

    if (!parentSnapshot) {
      return null;
    }

    return {
      schemaVersion: parentSnapshot.schemaVersion,
      sourceProfile: parentSnapshot.sourceProfile ?? '',
      sourceProfileName: parentSnapshot.sourceProfileName,
      sourceProfileDescription: parentSnapshot.sourceProfileDescription,
      sourceProfileVersion: parentSnapshot.sourceProfileVersion ?? null,
      modeProfileId: parentRun.modeProfileId ?? null,
      provider: parentSnapshot.provider,
      adapterId: parentSnapshot.adapterId,
      model: parentSnapshot.model,
      reasoningDepth: parentSnapshot.reasoningDepth,
      systemPromptHash: parentSnapshot.systemPromptHash,
      instructionHash: parentSnapshot.instructionHash,
      toolAllowlist: (parentSnapshot.toolAllowlist as string[]) ?? [],
      domainAllowlist: (parentSnapshot.domainAllowlist as string[]) ?? [],
      researchPolicy: (parentSnapshot.researchPolicy as Record<string, unknown>) ?? {},
      planningPolicy: (parentSnapshot.planningPolicy as Record<string, unknown>) ?? {},
      approvalPolicy: (parentSnapshot.approvalPolicy as Record<string, unknown>) ?? {},
      fallbackPolicy: (parentSnapshot.fallbackPolicy as Record<string, unknown>) ?? {},
      partialResultPolicy:
        (parentSnapshot.partialResultPolicy as 'require_all' | 'best_effort') ?? 'require_all',
      limits: (parentSnapshot.limits as unknown as ModeLimits) ?? ({} as ModeLimits),
      resolvedMode: parentRun.resolvedMode as ResolvedPolicy['resolvedMode'],
    };
  }

  /**
   * Load the billing agent's budget info for ephemeral requirement checks
   * (inside a transaction). Returns zeros if no billing agent is set.
   */
  private async loadBillingInfo(
    tx: Tx,
    ctx: EphemeralRoutingContext,
  ): Promise<{
    budgetMonthlyCents: number;
    spentMonthlyCents: number;
    residualAllocations: number;
  }> {
    if (!ctx.billingAgentId) {
      return { budgetMonthlyCents: 0, spentMonthlyCents: 0, residualAllocations: 0 };
    }

    const schema = this.db.schema;
    const [billingAgent] = await tx
      .select({
        budgetMonthlyCents: schema.agents.budgetMonthlyCents,
        spentMonthlyCents: schema.agents.spentMonthlyCents,
      })
      .from(schema.agents)
      .where(
        and(eq(schema.agents.id, ctx.billingAgentId), eq(schema.agents.companyId, ctx.companyId)),
      )
      .limit(1);

    if (!billingAgent) {
      return { budgetMonthlyCents: 0, spentMonthlyCents: 0, residualAllocations: 0 };
    }

    const [allocRow] = await tx
      .select({
        residual: sql<number>`coalesce(sum(${schema.budgetAllocations.allocatedCents} - ${schema.budgetAllocations.settledCents} - ${schema.budgetAllocations.releasedCents})::int, 0)`,
      })
      .from(schema.budgetAllocations)
      .where(
        and(
          eq(schema.budgetAllocations.billingAgentId, ctx.billingAgentId),
          sql`${schema.budgetAllocations.status} IN ('held', 'partially_settled')`,
        ),
      );

    return {
      budgetMonthlyCents: billingAgent.budgetMonthlyCents,
      spentMonthlyCents: billingAgent.spentMonthlyCents,
      residualAllocations: allocRow?.residual ?? 0,
    };
  }

  /**
   * Create an ephemeral child: derive policy, create allocation, set routing,
   * emit child.routed (VAL-SUB-021, VAL-SUB-022, VAL-SUB-023).
   */
  private async createEphemeralChild(
    tx: Tx,
    ctx: EphemeralRoutingContext,
    parentPolicy: ResolvedPolicy,
  ): Promise<EphemeralRoutingResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Derive the ephemeral child policy (parent narrowed by step budget/timeout).
    const childPolicy = deriveEphemeralChildPolicy({
      parentPolicy,
      stepBudgetCents: ctx.stepBudgetCents,
      stepTimeoutSeconds: ctx.stepTimeoutSeconds,
    });
    const childHash = policyContentHash(childPolicy);
    const childSnapshotId = randomUUID();

    // Create a child budget allocation from the root reservation BEFORE
    // persisting the policy snapshot. If the root residual is insufficient,
    // allocateChild throws BUDGET_UNAVAILABLE and no snapshot/run/assignment
    // writes have occurred, so the caller (routeOrFail) can catch and fail
    // the shell closed cleanly (VAL-CROSS-063).
    const budgetService = new BudgetService(this.db, { clock: () => now });
    const rootReservationId = await this.findRootReservationId(tx, ctx);
    let allocationId: string | null = null;
    if (rootReservationId) {
      const result = await budgetService.allocateChild(tx, {
        companyId: ctx.companyId,
        rootReservationId,
        runId: ctx.childRunId,
        billingAgentId: ctx.billingAgentId,
        allocatedCents: ctx.stepBudgetCents,
        projectId: ctx.projectId,
        stepKey: ctx.stepKey,
      });
      allocationId = result.allocationId;
    }

    // Persist the child policy snapshot as a new immutable row.
    await tx.insert(schema.runPolicySnapshots).values({
      id: childSnapshotId,
      companyId: ctx.companyId,
      schemaVersion: childPolicy.schemaVersion,
      sourceProfile: childPolicy.sourceProfile,
      sourceProfileName: childPolicy.sourceProfileName,
      sourceProfileDescription: childPolicy.sourceProfileDescription,
      sourceProfileVersion: childPolicy.sourceProfileVersion,
      provider: childPolicy.provider,
      adapterId: childPolicy.adapterId,
      model: childPolicy.model,
      reasoningDepth: childPolicy.reasoningDepth,
      systemPromptHash: childPolicy.systemPromptHash,
      instructionHash: childPolicy.instructionHash,
      toolAllowlist: childPolicy.toolAllowlist,
      domainAllowlist: childPolicy.domainAllowlist,
      researchPolicy: childPolicy.researchPolicy,
      planningPolicy: childPolicy.planningPolicy,
      approvalPolicy: childPolicy.approvalPolicy,
      fallbackPolicy: childPolicy.fallbackPolicy,
      partialResultPolicy: childPolicy.partialResultPolicy,
      limits: childPolicy.limits as unknown as Record<string, number>,
      contentHash: childHash,
      createdAt: now,
    });

    // Update the child run: set routing kind to ephemeral, no executing agent,
    // set billing agent, update policy snapshot, clear available_at.
    // executing_agent_id remains NULL (no permanent executing agent —
    // VAL-SUB-021, VAL-SUB-023, VAL-SUB-091).
    await tx
      .update(schema.missionRuns)
      .set({
        routingKind: 'ephemeral',
        executingAgentId: null,
        billingAgentId: ctx.billingAgentId,
        policySnapshotId: childSnapshotId,
        availableAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.childRunId),
        ),
      );

    // Update the step assignment: routed, ephemeral, no executing agent.
    await tx
      .update(schema.runStepAssignments)
      .set({
        assignmentStatus: 'routed',
        routingKind: 'ephemeral',
        executingAgentId: null,
        billingAgentId: ctx.billingAgentId,
        childPolicySnapshotId: childSnapshotId,
        childPolicyContentHash: childHash,
        admissionSlotHeld: true,
        budgetAllocationId: allocationId,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.runStepAssignments.companyId, ctx.companyId),
          eq(schema.runStepAssignments.rootRunId, ctx.rootRunId),
          eq(schema.runStepAssignments.stepKey, ctx.stepKey),
        ),
      );

    // Emit child.routed on the root run journal.
    const [rootRun] = await tx
      .select({
        lastEventSequence: schema.missionRuns.lastEventSequence,
        stateVersion: schema.missionRuns.stateVersion,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.rootRunId),
        ),
      )
      .for('update')
      .limit(1);

    if (!rootRun) {
      throw new Error(`EphemeralRouter: root run not found: ${ctx.rootRunId}`);
    }

    const seq = Number(rootRun.lastEventSequence) + 1;
    const newVersion = rootRun.stateVersion + 1;

    await tx.insert(schema.runEvents).values({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.rootRunId,
      sequence: seq,
      type: 'child.routed',
      schemaVersion: 1,
      payload: {
        childRunId: ctx.childRunId,
        stepKey: ctx.stepKey,
        executingAgentId: null,
        routingKind: 'ephemeral',
        billingAgentId: ctx.billingAgentId,
        policySnapshotId: childSnapshotId,
        policyContentHash: childHash,
      },
      actorType: 'system',
      actorId: null,
      traceId: null,
      occurredAt: now,
    });

    await tx
      .update(schema.missionRuns)
      .set({
        lastEventSequence: seq,
        stateVersion: newVersion,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.rootRunId),
        ),
      );

    return {
      outcome: 'ephemeral',
      routingKind: 'ephemeral',
      reason: 'ephemeral',
      policySnapshotId: childSnapshotId,
      policyContentHash: childHash,
      budgetAllocationId: allocationId,
      denialReason: null,
    };
  }

  /**
   * Terminally fail a child with NO_ELIGIBLE_AGENT (VAL-SUB-019, VAL-SUB-114).
   *
   * - Sets the child run to `failed` with safe code `NO_ELIGIBLE_AGENT`.
   * - Retains null `routing_kind` on the step assignment.
   * - Releases any provisional allocation exactly once.
   * - Emits `run.failed` on the child journal and `child.failed` on the root.
   * - Consumes zero provider calls/tokens/output/settled cost.
   */
  private async failChild(
    tx: Tx,
    ctx: EphemeralRoutingContext,
    denialReason: string,
  ): Promise<EphemeralRoutingResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Lock and update the child run to failed.
    const [childRun] = await tx
      .select({
        stateVersion: schema.missionRuns.stateVersion,
        lastEventSequence: schema.missionRuns.lastEventSequence,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.childRunId),
        ),
      )
      .for('update')
      .limit(1);

    if (!childRun) {
      return {
        outcome: 'failed',
        routingKind: null,
        reason: 'NO_ELIGIBLE_AGENT',
        policySnapshotId: null,
        policyContentHash: null,
        budgetAllocationId: null,
        denialReason,
      };
    }

    const childSeq = Number(childRun.lastEventSequence) + 1;
    const childNewVersion = childRun.stateVersion + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'failed',
        failureCategory: 'routing',
        failureCode: 'NO_ELIGIBLE_AGENT',
        safeErrorMessage: 'No eligible agent or ephemeral fallback available for this step.',
        terminalAt: now,
        stateVersion: childNewVersion,
        lastEventSequence: childSeq,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.childRunId),
        ),
      );

    // Emit run.failed on the child journal.
    await tx.insert(schema.runEvents).values({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      runId: ctx.childRunId,
      sequence: childSeq,
      type: 'run.failed',
      schemaVersion: 1,
      payload: {
        category: 'routing',
        code: 'NO_ELIGIBLE_AGENT',
      },
      actorType: 'system',
      actorId: null,
      traceId: null,
      occurredAt: now,
    });

    // Update the assignment to failed with null routing kind.
    await tx
      .update(schema.runStepAssignments)
      .set({
        assignmentStatus: 'failed',
        resultStatus: 'failed',
        failureCategory: 'routing',
        failureCode: 'NO_ELIGIBLE_AGENT',
        safeErrorMessage: 'No eligible agent or ephemeral fallback available for this step.',
        routingKind: null,
        admissionSlotHeld: false,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.runStepAssignments.companyId, ctx.companyId),
          eq(schema.runStepAssignments.rootRunId, ctx.rootRunId),
          eq(schema.runStepAssignments.stepKey, ctx.stepKey),
        ),
      );

    // Release any provisional child allocation exactly once.
    await this.releaseProvisionalAllocation(tx, ctx);

    // Emit child.failed on the root journal.
    const [rootRun] = await tx
      .select({
        lastEventSequence: schema.missionRuns.lastEventSequence,
        stateVersion: schema.missionRuns.stateVersion,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.rootRunId),
        ),
      )
      .for('update')
      .limit(1);

    if (rootRun) {
      const rootSeq = Number(rootRun.lastEventSequence) + 1;
      const rootNewVersion = rootRun.stateVersion + 1;

      await tx.insert(schema.runEvents).values({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        runId: ctx.rootRunId,
        sequence: rootSeq,
        type: 'child.failed',
        schemaVersion: 1,
        payload: {
          childRunId: ctx.childRunId,
          stepKey: ctx.stepKey,
          category: 'routing',
          code: 'NO_ELIGIBLE_AGENT',
        },
        actorType: 'system',
        actorId: null,
        traceId: null,
        occurredAt: now,
      });

      await tx
        .update(schema.missionRuns)
        .set({
          lastEventSequence: rootSeq,
          stateVersion: rootNewVersion,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.missionRuns.companyId, ctx.companyId),
            eq(schema.missionRuns.id, ctx.rootRunId),
          ),
        );
    }

    return {
      outcome: 'failed',
      routingKind: null,
      reason: 'NO_ELIGIBLE_AGENT',
      policySnapshotId: null,
      policyContentHash: null,
      budgetAllocationId: null,
      denialReason,
    };
  }

  /**
   * Release any provisional child budget allocation exactly once
   * (VAL-SUB-019, VAL-SUB-114).
   */
  private async releaseProvisionalAllocation(tx: Tx, ctx: EphemeralRoutingContext): Promise<void> {
    const schema = this.db.schema;
    const now = this.now();

    // Find any held allocation for this child run.
    const [allocation] = await tx
      .select({
        id: schema.budgetAllocations.id,
        allocatedCents: schema.budgetAllocations.allocatedCents,
        settledCents: schema.budgetAllocations.settledCents,
        releasedCents: schema.budgetAllocations.releasedCents,
        status: schema.budgetAllocations.status,
      })
      .from(schema.budgetAllocations)
      .where(eq(schema.budgetAllocations.runId, ctx.childRunId))
      .for('update')
      .limit(1);

    if (!allocation || allocation.status === 'released' || allocation.status === 'settled') {
      return;
    }

    const unreleased =
      allocation.allocatedCents - allocation.settledCents - allocation.releasedCents;
    if (unreleased > 0) {
      await tx
        .update(schema.budgetAllocations)
        .set({
          releasedCents: sql`${schema.budgetAllocations.releasedCents} + ${unreleased}`,
          status: 'released',
          updatedAt: now,
        })
        .where(eq(schema.budgetAllocations.id, allocation.id));
    } else {
      await tx
        .update(schema.budgetAllocations)
        .set({ status: 'released', updatedAt: now })
        .where(eq(schema.budgetAllocations.id, allocation.id));
    }
  }

  /**
   * Find the root reservation ID for a root run (inside a transaction).
   */
  private async findRootReservationId(
    tx: Tx,
    ctx: EphemeralRoutingContext,
  ): Promise<string | null> {
    const schema = this.db.schema;
    const [reservation] = await tx
      .select({ id: schema.budgetReservations.id })
      .from(schema.budgetReservations)
      .where(
        and(
          eq(schema.budgetReservations.companyId, ctx.companyId),
          eq(schema.budgetReservations.runId, ctx.rootRunId),
        ),
      )
      .limit(1);
    return reservation?.id ?? null;
  }

  // -- idempotency checks --------------------------------------------------

  private async checkExistingState(
    ctx: EphemeralRoutingContext,
  ): Promise<EphemeralRoutingResult | undefined> {
    const schema = this.db.schema;
    const [assignment] = await this.db.drizzle
      .select({
        assignmentStatus: schema.runStepAssignments.assignmentStatus,
        routingKind: schema.runStepAssignments.routingKind,
        childPolicySnapshotId: schema.runStepAssignments.childPolicySnapshotId,
        childPolicyContentHash: schema.runStepAssignments.childPolicyContentHash,
        budgetAllocationId: schema.runStepAssignments.budgetAllocationId,
      })
      .from(schema.runStepAssignments)
      .where(
        and(
          eq(schema.runStepAssignments.companyId, ctx.companyId),
          eq(schema.runStepAssignments.rootRunId, ctx.rootRunId),
          eq(schema.runStepAssignments.stepKey, ctx.stepKey),
        ),
      )
      .limit(1);

    if (!assignment) {
      return undefined;
    }

    if (assignment.assignmentStatus === 'routed' && assignment.routingKind === 'ephemeral') {
      return {
        outcome: 'ephemeral',
        routingKind: 'ephemeral',
        reason: 'ephemeral',
        policySnapshotId: assignment.childPolicySnapshotId,
        policyContentHash: assignment.childPolicyContentHash,
        budgetAllocationId: assignment.budgetAllocationId,
        denialReason: null,
      };
    }

    if (assignment.assignmentStatus === 'failed') {
      return {
        outcome: 'failed',
        routingKind: null,
        reason: 'NO_ELIGIBLE_AGENT',
        policySnapshotId: null,
        policyContentHash: null,
        budgetAllocationId: null,
        denialReason: 'ALREADY_FAILED',
      };
    }

    return undefined;
  }

  private async checkExistingStateInTx(
    tx: Tx,
    ctx: EphemeralRoutingContext,
  ): Promise<EphemeralRoutingResult | undefined> {
    const schema = this.db.schema;
    const [assignment] = await tx
      .select({
        assignmentStatus: schema.runStepAssignments.assignmentStatus,
        routingKind: schema.runStepAssignments.routingKind,
        childPolicySnapshotId: schema.runStepAssignments.childPolicySnapshotId,
        childPolicyContentHash: schema.runStepAssignments.childPolicyContentHash,
        budgetAllocationId: schema.runStepAssignments.budgetAllocationId,
      })
      .from(schema.runStepAssignments)
      .where(
        and(
          eq(schema.runStepAssignments.companyId, ctx.companyId),
          eq(schema.runStepAssignments.rootRunId, ctx.rootRunId),
          eq(schema.runStepAssignments.stepKey, ctx.stepKey),
        ),
      )
      .limit(1);

    if (!assignment) {
      return undefined;
    }

    if (assignment.assignmentStatus === 'routed' && assignment.routingKind === 'ephemeral') {
      return {
        outcome: 'ephemeral',
        routingKind: 'ephemeral',
        reason: 'ephemeral',
        policySnapshotId: assignment.childPolicySnapshotId,
        policyContentHash: assignment.childPolicyContentHash,
        budgetAllocationId: assignment.budgetAllocationId,
        denialReason: null,
      };
    }

    if (assignment.assignmentStatus === 'failed') {
      return {
        outcome: 'failed',
        routingKind: null,
        reason: 'NO_ELIGIBLE_AGENT',
        policySnapshotId: null,
        policyContentHash: null,
        budgetAllocationId: null,
        denialReason: 'ALREADY_FAILED',
      };
    }

    return undefined;
  }
}
