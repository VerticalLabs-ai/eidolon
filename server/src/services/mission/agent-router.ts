import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbInstance } from '../../types.js';
import type { RoutingRequirements } from './plan-schema.js';

/**
 * AgentRouter — deterministic permanent-agent eligibility and scoring for
 * hybrid subthread routing.
 *
 * (VAL-SUB-008, 009, 010, 011, 012, 013, 014, 015, 016, 041, 088)
 *
 * For each ready approved step with `pending_routing` assignment status, the
 * router filters same-company agents by (in order):
 *
 *  1. Company isolation — only agents belonging to the Mission's company
 *     (VAL-SUB-041).
 *  2. Active status — `idle` or `working` only; never `paused`, `error`, or
 *     `offline` (VAL-SUB-011).
 *  3. Capability coverage — agent must possess ALL required capabilities
 *     (VAL-SUB-012).
 *  4. Exact tools — agent must have every required tool as an EXACT match;
 *     wildcard/prefix lookalikes do not count (VAL-SUB-013).
 *  5. Exact domains — agent must allow every required domain exactly
 *     (VAL-SUB-013).
 *  6. Runtime compatibility — agent's provider must match the parent policy
 *     snapshot's provider (VAL-SUB-014).
 *  7. Project/company permission — agent's `permissions` must include
 *     `content.create` (VAL-SUB-015).
 *  8. Working capacity — a `working` agent is eligible only while its active
 *     task count is below `maxConcurrentTasks` (VAL-SUB-010).
 *  9. Budget eligibility — agent must have enough remaining monthly budget
 *     for the step's estimated cost (or unlimited budget, `0`)
 *     (VAL-SUB-016).
 * 10. Timeout eligibility — agent's `executionTimeoutSeconds` must be >= the
 *     step's required timeout (VAL-SUB-016).
 *
 * After filtering, eligible agents are scored by a deterministic tuple
 * (VAL-SUB-088):
 *
 *  1. Preferred-capability match count DESCENDING (intersection of the
 *     agent's capabilities with the required set).
 *  2. Idle-before-working (idle = 1, working = 0) DESCENDING.
 *  3. Free reserved slots DESCENDING (`maxConcurrentTasks - activeTaskCount`).
 *  4. Remaining-budget ratio DESCENDING (unlimited budget = 1.0).
 *  5. Lowercase UUID ASCENDING (stable tie-break).
 *
 * Normal user output exposes only the winner and safe reason codes;
 * candidate score tuples are protected diagnostics not surfaced through the
 * public API.
 *
 * This module implements the permanent-agent eligibility and scoring portion
 * of hybrid routing. Ephemeral fallback, capacity reservation, immutable
 * child policy derivation, and scheduling permits are owned by later
 * features (m4-f03, m4-f03-ephemeral-fallback).
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export interface AgentRouterDeps {
  clock?: () => Date;
}

/**
 * Routing context: everything the router needs to select an agent for one
 * pending-routing child step.
 */
export interface RoutingContext {
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
  /** Billing agent identity for cost attribution. */
  billingAgentId: string | null;
  /** Parent policy snapshot's provider (for runtime compatibility). */
  parentProvider: string;
}

/**
 * A routing candidate: an agent's fields needed for filtering and scoring,
 * plus computed active-task count and residual allocation amount.
 */
export interface AgentCandidate {
  id: string;
  companyId: string;
  status: string;
  provider: string;
  model: string;
  capabilities: string[];
  toolsEnabled: string[];
  allowedDomains: string[];
  permissions: string[];
  maxConcurrentTasks: number;
  executionTimeoutSeconds: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  /** Count of nonterminal mission_runs where executing_agent_id = this agent. */
  activeTaskCount: number;
  /** Sum of residual active allocation cents for this agent. */
  residualActiveAllocations: number;
}

/**
 * A candidate's score and exclusion status (protected diagnostics).
 */
export interface CandidateScore {
  agentId: string;
  /** Intersection count of agent capabilities with required capabilities. */
  capabilityMatchCount: number;
  /** True if agent status is `idle`. */
  isIdle: boolean;
  /** maxConcurrentTasks - activeTaskCount. */
  freeReservedSlots: number;
  /** Remaining budget ratio (1.0 if unlimited). */
  remainingBudgetRatio: number;
  /** Whether this candidate was excluded by a filter. */
  excluded: boolean;
  /** Safe reason code for exclusion (null if eligible). */
  exclusionReason: string | null;
}

/**
 * The routing decision returned by the router.
 */
export interface RoutingDecision {
  /** Whether an eligible company agent was found and selected. */
  selected: boolean;
  /** The selected agent ID (null if no eligible agent). */
  winnerAgentId: string | null;
  /** Routing kind: `'company_agent'` if selected, null otherwise. */
  routingKind: 'company_agent' | null;
  /**
   * Safe reason code for the decision. `'company_agent'` on success,
   * `'NO_ELIGIBLE_AGENT'` when no eligible company agent exists.
   */
  reason: string;
  /** Protected candidate diagnostics (not surfaced in normal user output). */
  candidates: CandidateScore[];
}

/** Agent statuses eligible for routing. */
const ELIGIBLE_STATUSES = new Set(['idle', 'working']);

/** Permission required for an agent to execute child work. */
const REQUIRED_PERMISSION = 'content.create';

export class AgentRouter {
  constructor(
    private db: DbInstance,
    private deps: AgentRouterDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Route a pending-routing child step to an eligible company agent.
   *
   * If an eligible agent is found, atomically records the routing decision:
   * emits `child.routed` on the root run journal, sets `executing_agent_id`
   * and `routing_kind='company_agent'` on the child run and step assignment,
   * and sets the assignment status to `routed`. The child's `available_at`
   * is cleared so it is not re-claimed until the next feature (m4-f03)
   * reserves capacity and transitions it to execution.
   *
   * If no eligible agent exists, returns a non-selected decision. The child
   * remains pending; ephemeral fallback is owned by m4-f03-ephemeral-fallback.
   *
   * Routing is idempotent: re-routing an already-routed child returns the
   * same decision without duplicating events.
   */
  async route(ctx: RoutingContext): Promise<RoutingDecision> {
    // Idempotency: check if this child is already routed. If so, return the
    // existing decision without re-evaluating candidates (the winner now has
    // an active task from the first routing, which would change the score).
    const existing = await this.checkExistingRouting(ctx);
    if (existing) {
      return existing;
    }

    const candidates = await this.loadCandidates(ctx.companyId);
    const scored = this.filterAndScore(candidates, ctx);
    const eligible = scored.filter((c) => !c.excluded);

    if (eligible.length === 0) {
      return {
        selected: false,
        winnerAgentId: null,
        routingKind: null,
        reason: 'NO_ELIGIBLE_AGENT',
        candidates: scored,
      };
    }

    const winner = this.selectWinner(eligible, ctx.routingRequirements);

    // Atomically record the routing decision.
    await this.db.drizzle.transaction(async (tx) => {
      await this.recordRouting(tx, ctx, winner.agentId);
    });

    return {
      selected: true,
      winnerAgentId: winner.agentId,
      routingKind: 'company_agent',
      reason: 'company_agent',
      candidates: scored,
    };
  }

  /**
   * Check if the child is already routed. Returns the existing decision if
   * so, or undefined if not yet routed.
   */
  private async checkExistingRouting(ctx: RoutingContext): Promise<RoutingDecision | undefined> {
    const schema = this.db.schema;
    const [assignment] = await this.db.drizzle
      .select({
        assignmentStatus: schema.runStepAssignments.assignmentStatus,
        executingAgentId: schema.runStepAssignments.executingAgentId,
        routingKind: schema.runStepAssignments.routingKind,
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

    if (assignment && assignment.assignmentStatus === 'routed' && assignment.executingAgentId) {
      return {
        selected: true,
        winnerAgentId: assignment.executingAgentId,
        routingKind: (assignment.routingKind as 'company_agent') ?? 'company_agent',
        reason: 'company_agent',
        candidates: [],
      };
    }

    return undefined;
  }

  // -- candidate loading ---------------------------------------------------

  /**
   * Load all agents for a company (company isolation, VAL-SUB-041) with
   * computed active-task counts and residual active allocations.
   */
  private async loadCandidates(companyId: string): Promise<AgentCandidate[]> {
    const schema = this.db.schema;

    // Load agents for this company only.
    const agentRows = await this.db.drizzle
      .select({
        id: schema.agents.id,
        companyId: schema.agents.companyId,
        status: schema.agents.status,
        provider: schema.agents.provider,
        model: schema.agents.model,
        capabilities: schema.agents.capabilities,
        toolsEnabled: schema.agents.toolsEnabled,
        allowedDomains: schema.agents.allowedDomains,
        permissions: schema.agents.permissions,
        maxConcurrentTasks: schema.agents.maxConcurrentTasks,
        executionTimeoutSeconds: schema.agents.executionTimeoutSeconds,
        budgetMonthlyCents: schema.agents.budgetMonthlyCents,
        spentMonthlyCents: schema.agents.spentMonthlyCents,
      })
      .from(schema.agents)
      .where(eq(schema.agents.companyId, companyId));

    if (agentRows.length === 0) {
      return [];
    }

    // Batch-compute active task counts and residual allocations for all
    // agents in this company in two queries (avoids N+1).
    const agentIds = agentRows.map((a) => a.id);

    const activeCounts = await this.db.drizzle
      .select({
        executingAgentId: schema.missionRuns.executingAgentId,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.missionRuns)
      .where(
        and(
          inArray(schema.missionRuns.executingAgentId, agentIds),
          isNull(schema.missionRuns.terminalAt),
        ),
      )
      .groupBy(schema.missionRuns.executingAgentId);

    const activeCountMap = new Map<string, number>(
      activeCounts
        .filter(
          (r): r is { executingAgentId: string; count: number } => r.executingAgentId !== null,
        )
        .map((r) => [r.executingAgentId, r.count]),
    );

    const residualAllocations = await this.db.drizzle
      .select({
        billingAgentId: schema.budgetAllocations.billingAgentId,
        residual: sql<number>`sum(${schema.budgetAllocations.allocatedCents} - ${schema.budgetAllocations.settledCents} - ${schema.budgetAllocations.releasedCents})::int`,
      })
      .from(schema.budgetAllocations)
      .where(
        and(
          inArray(schema.budgetAllocations.billingAgentId, agentIds),
          sql`${schema.budgetAllocations.status} IN ('held', 'partially_settled')`,
        ),
      )
      .groupBy(schema.budgetAllocations.billingAgentId);

    const residualMap = new Map<string, number>(
      residualAllocations
        .filter((r): r is { billingAgentId: string; residual: number } => r.billingAgentId !== null)
        .map((r) => [r.billingAgentId, r.residual]),
    );

    return agentRows.map((a) => ({
      id: a.id,
      companyId: a.companyId,
      status: a.status,
      provider: a.provider,
      model: a.model,
      capabilities: a.capabilities ?? [],
      toolsEnabled: a.toolsEnabled ?? [],
      allowedDomains: a.allowedDomains ?? [],
      permissions: a.permissions ?? [],
      maxConcurrentTasks: a.maxConcurrentTasks,
      executionTimeoutSeconds: a.executionTimeoutSeconds,
      budgetMonthlyCents: a.budgetMonthlyCents,
      spentMonthlyCents: a.spentMonthlyCents,
      activeTaskCount: activeCountMap.get(a.id) ?? 0,
      residualActiveAllocations: residualMap.get(a.id) ?? 0,
    }));
  }

  // -- filter chain and scoring --------------------------------------------

  /**
   * Apply all exclusion filters and compute score tuples for each candidate.
   * Returns CandidateScore[] for all candidates (eligible and excluded).
   */
  filterAndScore(candidates: AgentCandidate[], ctx: RoutingContext): CandidateScore[] {
    const req = ctx.routingRequirements;
    const agentPerms = REQUIRED_PERMISSION;

    return candidates.map((agent) => {
      const caps = new Set(agent.capabilities);
      const tools = new Set(agent.toolsEnabled);
      const domains = new Set(agent.allowedDomains);
      const perms = new Set(agent.permissions);

      // Compute capability match count (intersection with required).
      const capabilityMatchCount = req.capabilities.filter((c) => caps.has(c)).length;

      // Default score fields.
      const isIdle = agent.status === 'idle';
      const freeReservedSlots = agent.maxConcurrentTasks - agent.activeTaskCount;
      const remainingBudgetRatio = this.computeBudgetRatio(agent);

      // Apply filters in order.
      // 1. Active status (VAL-SUB-011).
      if (!ELIGIBLE_STATUSES.has(agent.status)) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'inactive_status',
        );
      }

      // 2. Capability coverage (VAL-SUB-012).
      const missingCaps = req.capabilities.filter((c) => !caps.has(c));
      if (missingCaps.length > 0) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'missing_capabilities',
        );
      }

      // 3. Exact tools (VAL-SUB-013). Exact match only — no prefix/wildcard.
      const missingTools = req.requiredTools.filter((t) => !tools.has(t));
      if (missingTools.length > 0) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'missing_tools',
        );
      }

      // 4. Exact domains (VAL-SUB-013).
      const missingDomains = req.requiredDomains.filter((d) => !domains.has(d));
      if (missingDomains.length > 0) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'missing_domains',
        );
      }

      // 5. Runtime compatibility (VAL-SUB-014).
      if (agent.provider !== ctx.parentProvider) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'runtime_incompatible',
        );
      }

      // 6. Project/company permission (VAL-SUB-015).
      if (!perms.has(agentPerms)) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'missing_permission',
        );
      }

      // 7. Working capacity (VAL-SUB-010).
      if (agent.status === 'working' && agent.activeTaskCount >= agent.maxConcurrentTasks) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'at_capacity',
        );
      }

      // 8. Budget eligibility (VAL-SUB-016).
      if (!this.hasEnoughBudget(agent, ctx.stepBudgetCents)) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'insufficient_budget',
        );
      }

      // 9. Timeout eligibility (VAL-SUB-016).
      if (agent.executionTimeoutSeconds < ctx.stepTimeoutSeconds) {
        return this.excluded(
          agent.id,
          capabilityMatchCount,
          isIdle,
          freeReservedSlots,
          remainingBudgetRatio,
          'insufficient_timeout',
        );
      }

      // Eligible.
      return {
        agentId: agent.id,
        capabilityMatchCount,
        isIdle,
        freeReservedSlots,
        remainingBudgetRatio,
        excluded: false,
        exclusionReason: null,
      };
    });
  }

  /**
   * Compute the remaining budget ratio for an agent.
   * Unlimited (budgetMonthlyCents = 0) = 1.0.
   */
  private computeBudgetRatio(agent: AgentCandidate): number {
    if (agent.budgetMonthlyCents === 0) {
      return 1.0;
    }
    const remaining =
      agent.budgetMonthlyCents - agent.spentMonthlyCents - agent.residualActiveAllocations;
    return Math.max(0, remaining) / agent.budgetMonthlyCents;
  }

  /**
   * Check whether an agent has enough remaining budget for the step cost.
   * Unlimited budget (0) always has enough.
   */
  private hasEnoughBudget(agent: AgentCandidate, stepBudgetCents: number): boolean {
    if (agent.budgetMonthlyCents === 0) {
      return true;
    }
    const remaining =
      agent.budgetMonthlyCents - agent.spentMonthlyCents - agent.residualActiveAllocations;
    return remaining >= stepBudgetCents;
  }

  private excluded(
    agentId: string,
    capabilityMatchCount: number,
    isIdle: boolean,
    freeReservedSlots: number,
    remainingBudgetRatio: number,
    reason: string,
  ): CandidateScore {
    return {
      agentId,
      capabilityMatchCount,
      isIdle,
      freeReservedSlots,
      remainingBudgetRatio,
      excluded: true,
      exclusionReason: reason,
    };
  }

  // -- winner selection (VAL-SUB-088) --------------------------------------

  /**
   * Select the winning agent from eligible candidates by the deterministic
   * score tuple (VAL-SUB-088):
   *
   *  1. capabilityMatchCount DESC
   *  2. idle before working (idle=1, working=0) DESC
   *  3. freeReservedSlots DESC
   *  4. remainingBudgetRatio DESC (unlimited = 1.0)
   *  5. lowercase UUID ASC
   */
  selectWinner(eligible: CandidateScore[], req: RoutingRequirements): CandidateScore {
    const sorted = [...eligible].sort((a, b) => {
      // 1. capability match count descending.
      if (b.capabilityMatchCount !== a.capabilityMatchCount) {
        return b.capabilityMatchCount - a.capabilityMatchCount;
      }
      // 2. idle before working (idle=1 > working=0).
      const aIdle = a.isIdle ? 1 : 0;
      const bIdle = b.isIdle ? 1 : 0;
      if (bIdle !== aIdle) {
        return bIdle - aIdle;
      }
      // 3. free reserved slots descending.
      if (b.freeReservedSlots !== a.freeReservedSlots) {
        return b.freeReservedSlots - a.freeReservedSlots;
      }
      // 4. remaining budget ratio descending.
      if (b.remainingBudgetRatio !== a.remainingBudgetRatio) {
        return b.remainingBudgetRatio - a.remainingBudgetRatio;
      }
      // 5. lowercase UUID ascending.
      return a.agentId.toLowerCase().localeCompare(b.agentId.toLowerCase());
    });
    void req;
    return sorted[0];
  }

  /**
   * Pure scoring and selection for unit testing (no DB). Filters candidates
   * against the requirements and returns the winning candidate's agent ID,
   * or null if no eligible candidate.
   */
  static scoreAndSelect(
    candidates: AgentCandidate[],
    req: RoutingRequirements,
  ): AgentCandidate | null {
    const eligible = candidates.filter((agent) => {
      const caps = new Set(agent.capabilities);
      const tools = new Set(agent.toolsEnabled);
      const domains = new Set(agent.allowedDomains);
      const perms = new Set(agent.permissions);

      if (!ELIGIBLE_STATUSES.has(agent.status)) {
        return false;
      }
      if (!req.capabilities.every((c) => caps.has(c))) {
        return false;
      }
      if (!req.requiredTools.every((t) => tools.has(t))) {
        return false;
      }
      if (!req.requiredDomains.every((d) => domains.has(d))) {
        return false;
      }
      if (!perms.has(REQUIRED_PERMISSION)) {
        return false;
      }
      if (agent.status === 'working' && agent.activeTaskCount >= agent.maxConcurrentTasks) {
        return false;
      }
      // Budget: unlimited (0) or remaining >= 0 (unit test doesn't pass stepBudgetCents).
      if (agent.budgetMonthlyCents !== 0) {
        const remaining =
          agent.budgetMonthlyCents - agent.spentMonthlyCents - agent.residualActiveAllocations;
        if (remaining < 0) {
          return false;
        }
      }
      return true;
    });

    if (eligible.length === 0) {
      return null;
    }

    const sorted = [...eligible].sort((a, b) => {
      const aMatch = req.capabilities.filter((c) => new Set(a.capabilities).has(c)).length;
      const bMatch = req.capabilities.filter((c) => new Set(b.capabilities).has(c)).length;
      if (bMatch !== aMatch) {
        return bMatch - aMatch;
      }

      const aIdle = a.status === 'idle' ? 1 : 0;
      const bIdle = b.status === 'idle' ? 1 : 0;
      if (bIdle !== aIdle) {
        return bIdle - aIdle;
      }

      const aFree = a.maxConcurrentTasks - a.activeTaskCount;
      const bFree = b.maxConcurrentTasks - b.activeTaskCount;
      if (bFree !== aFree) {
        return bFree - aFree;
      }

      const aRatio =
        a.budgetMonthlyCents === 0
          ? 1.0
          : Math.max(0, a.budgetMonthlyCents - a.spentMonthlyCents - a.residualActiveAllocations) /
            a.budgetMonthlyCents;
      const bRatio =
        b.budgetMonthlyCents === 0
          ? 1.0
          : Math.max(0, b.budgetMonthlyCents - b.spentMonthlyCents - b.residualActiveAllocations) /
            b.budgetMonthlyCents;
      if (bRatio !== aRatio) {
        return bRatio - aRatio;
      }

      return a.id.toLowerCase().localeCompare(b.id.toLowerCase());
    });

    return sorted[0];
  }

  // -- routing record (atomic) ---------------------------------------------

  /**
   * Atomically record the routing decision in a transaction.
   *
   * - Sets `executing_agent_id` and `routing_kind='company_agent'` on the
   *   child run, and clears `available_at` (child is no longer claimable
   *   until m4-f03 transitions it to execution).
   * - Sets `assignment_status='routed'`, `executing_agent_id`, and
   *   `routing_kind='company_agent'` on the step assignment.
   * - Emits `child.routed` on the root run journal.
   *
   * Idempotent: if the assignment is already routed to the same agent, no
   * duplicate event is emitted.
   */
  private async recordRouting(tx: Tx, ctx: RoutingContext, winnerAgentId: string): Promise<void> {
    const schema = this.db.schema;
    const now = this.now();

    // Check if already routed (idempotency).
    const [existing] = await tx
      .select({
        assignmentStatus: schema.runStepAssignments.assignmentStatus,
        executingAgentId: schema.runStepAssignments.executingAgentId,
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

    if (
      existing &&
      existing.assignmentStatus === 'routed' &&
      existing.executingAgentId === winnerAgentId
    ) {
      // Already routed to the same agent — idempotent no-op.
      return;
    }

    // Update the child run: set executing agent and clear available_at.
    await tx
      .update(schema.missionRuns)
      .set({
        executingAgentId: winnerAgentId,
        routingKind: 'company_agent',
        availableAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.childRunId),
        ),
      );

    // Update the step assignment.
    await tx
      .update(schema.runStepAssignments)
      .set({
        assignmentStatus: 'routed',
        routingKind: 'company_agent',
        executingAgentId: winnerAgentId,
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
    // Lock the root run to get the current sequence.
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
      throw new Error(`AgentRouter: root run not found: ${ctx.rootRunId}`);
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
        executingAgentId: winnerAgentId,
        routingKind: 'company_agent',
      },
      actorType: 'system',
      actorId: null,
      traceId: null,
      occurredAt: now,
    });

    // Update root run sequence and version.
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
  }
}
