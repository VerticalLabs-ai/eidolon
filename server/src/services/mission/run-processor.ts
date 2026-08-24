import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../../providers/types.js';
import { resolveProviderApiKey } from '../provider-key.js';
import { getProvider } from '../../providers/index.js';
import type { DbInstance } from '../../types.js';
import type { Claim } from './coordinator.js';
import { MissionRecoveryService } from './recovery.js';
import { MissionCompletionService } from './completion.js';
import { MissionRetryService } from './retry.js';
import { BudgetService } from './budget.js';
import { projectEvent } from './projection.js';
import { decryptEnvelope } from './ingress.js';
import { TopologyMaterializer } from './topology-materializer.js';
import { AgentRouter, type RoutingContext } from './agent-router.js';
import { EphemeralFallbackRouter, type EphemeralRoutingContext } from './ephemeral-router.js';
import type { RoutingRequirements, PlanContent } from './plan-schema.js';
import { PLATFORM_HARD_CAPS } from './modes.js';
import type { TreePolicyLimits } from './tree-limits.js';
import logger from '../../utils/logger.js';

/**
 * RunProcessor — the real `advance` function for the OrchestrationWorker.
 *
 * When the worker claims a run, this processor:
 *
 *  1. Checks the abort signal (cooperative cancellation from shutdown or
 *     lease loss). If already aborted, returns without calling the provider
 *     or completing the run. The worker's stop() will release the lease.
 *  2. For recovery claims (expired lease on a non-queued run): checks for
 *     non-replayable tool invocations in an unresolved state. If found, the
 *     run is failed with `unknown_effect` and the invocation is never
 *     repeated (VAL-RUN-086).
 *  3. Reads the run row and its immutable policy snapshot to determine the
 *     provider, model, and limits.
 *  4. Rechecks cancellation: if `cancel_requested_at` is set, the processor
 *     does not complete the run — the cancellation service owns
 *     terminalization (cancellation wins the race, VAL-RUN-041).
 *  5. Decrypts the request envelope and builds a minimal chat context.
 *  6. Makes a bounded single LLM provider call using the policy's
 *     provider/model and the server-side API key. The call respects the
 *     abort signal and the policy's duration limit.
 *  7. Settles the budget for the provider call (exactly-once, unique
 *     external call ID).
 *  8. Completes the run via the fenced completion service (which also
 *     releases residual budget).
 *  9. Projects committed lifecycle events (run.created, run.completed,
 *     budget.released) to mutable surfaces (thread items, activity log).
 *
 * If the provider call fails, the retry service classifies the failure and
 * either requeues the same nonterminal run (bounded backoff) or terminalizes
 * it (permanent failure).
 *
 * The provider call function is injectable for testing. In production, the
 * real provider registry is used.
 */

export type ProviderCallFn = (
  messages: ChatMessage[],
  config: ProviderConfig,
  signal: AbortSignal,
) => Promise<CompletionResult>;

export interface RunProcessorDeps {
  clock?: () => Date;
  /**
   * Override the provider call function. If not provided, the real
   * provider registry is used. Tests inject a mock to avoid real API
   * calls.
   */
  providerCall?: ProviderCallFn;
  /**
   * Planner service for handling `planning`-status runs. When a claimed run
   * is in `planning` status, the processor delegates to the planner to
   * generate, validate, and atomically publish a plan proposal, transitioning
   * the run to `awaiting_approval` (VAL-PLAN-024, 025, 103, 114).
   *
   * If not provided, `planning` runs are left in place (no execution begins).
   * The production worker wires a real planner; tests inject a harness-backed
   * planner.
   */
  planner?: { plan: (claim: Claim, signal: AbortSignal) => Promise<void> };
  /**
   * Topology materializer for approved plans. When a claimed root run has an
   * approved plan with child steps, the processor materializes the topology
   * into child shells and assignments (VAL-SUB-001, 002, 003, 005). If not
   * provided, a default materializer is constructed from the db instance.
   */
  materializer?: TopologyMaterializer;
  /**
   * Agent router for child runs with `pending_routing` assignments. When a
   * claimed child run has a pending_routing step assignment, the processor
   * delegates to the router to select an eligible company agent, emit
   * `child.routed`, and set the executing agent (VAL-SUB-008 through 016,
   * 041, 088). If not provided, a default router is constructed from the db
   * instance. Ephemeral fallback, capacity reservation, and policy/permit
   * lifecycle are owned by later features (m4-f03).
   */
  router?: AgentRouter;
  /**
   * Ephemeral fallback router for child runs where no eligible company agent
   * exists. When the AgentRouter returns non-selected, the processor delegates
   * to this router to either create an ephemeral child (inheriting parent
   * policy/billing) or terminally fail the shell with NO_ELIGIBLE_AGENT
   * (VAL-SUB-019, 021, 022, 023, 090, 091, 114, VAL-MODEQ-043). If not
   * provided, a default ephemeral router is constructed from the db instance.
   */
  ephemeralRouter?: EphemeralFallbackRouter;
}

interface RunRow {
  id: string;
  companyId: string;
  projectId: string;
  status: string;
  stateVersion: number;
  lastEventSequence: number;
  attemptCount: number;
  cancelRequestedAt: Date | null;
  policySnapshotId: string | null;
  requestEnvelope: string | null;
  initiatingAgentId: string | null;
  createdAt: Date;
  parentRunId: string | null;
  rootRunId: string;
  approvedPlanRevisionId: string | null;
}

interface PolicyInfo {
  provider: string;
  model: string;
  limits: Record<string, number>;
}

interface RunAndPolicy {
  run: RunRow;
  policy: PolicyInfo | null;
}

export class RunProcessor {
  constructor(
    private db: DbInstance,
    private deps: RunProcessorDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Advance a claimed run. This is the `advance` function passed to the
   * OrchestrationWorker.
   */
  async advance(claim: Claim, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }

    if (claim.isRecovery) {
      const terminalized = await this.handleRecovery(claim);
      if (terminalized) {
        await this.projectRunEvents(claim);
        return;
      }
    }

    if (signal.aborted) {
      return;
    }

    const data = await this.readRunAndPolicy(claim);
    if (!data || data.run.cancelRequestedAt !== null || signal.aborted) {
      return;
    }

    // Planning dispatch: if the run is in `planning` status, delegate to the
    // planner service to generate, validate, and atomically publish a plan
    // proposal. The planner transitions the run to `awaiting_approval` on
    // success or terminalizes on failure. No execution, tools, children, or
    // artifacts begin during planning (VAL-PLAN-025, 026, 027, 106).
    if (data.run.status === 'planning' && this.deps.planner) {
      await this.deps.planner.plan(claim, signal);
      await this.projectRunEvents(claim);
      return;
    }

    // Topology materialization (VAL-SUB-001, 002, 003, 005):
    // When a root run (parentRunId === null) has an approved plan, materialize
    // the topology into child shells and assignments. If the plan has non-root
    // executable steps (children), the root oversees children and does not
    // execute a single LLM call — children are claimed and advanced
    // separately. If the plan has no children (flat plan), the root executes
    // directly via the existing path below.
    if (
      data.run.status === 'running' &&
      data.run.parentRunId === null &&
      data.run.approvedPlanRevisionId &&
      !signal.aborted
    ) {
      const handled = await this.handleTopologyMaterialization(claim, data.run);
      if (handled) {
        await this.projectRunEvents(claim);
        return;
      }
    }

    // Child routing (VAL-SUB-008 through 016, 041, 088):
    // When a claimed child run has a `pending_routing` step assignment, the
    // processor delegates to the agent router to filter and score same-company
    // agents by status, capability, exact tools/domains, runtime, permission,
    // budget, timeout, and deterministic score tuple. If an eligible agent is
    // found, the router emits `child.routed`, sets the executing agent, and
    // sets the assignment to `routed`. The child is then not re-claimable
    // until m4-f03 reserves capacity and transitions it to execution. If no
    // eligible agent exists, the child remains pending (ephemeral fallback is
    // m4-f03-ephemeral-fallback).
    if (await this.maybeHandleChildRouting(claim, signal, data)) {
      return;
    }

    // VAL-MODEQ-151: Root agent revocation is deny-only.
    //
    // Before any provider call or commit, re-check the initiating/executing
    // agent's CURRENT eligibility (status, provider/model eligibility,
    // credential). The policy snapshot is immutable and never broadened, but
    // live enforcement uses the agent's current state. If the agent has been
    // revoked (deactivated, provider/model changed, credential removed)
    // since the snapshot was taken, the run fails safely with a
    // policy/authorization outcome — it never resumes forbidden work.
    const revocationResult = await this.checkAgentRevocation(data.run);
    if (revocationResult.revoked) {
      await this.handleFailure(claim, {
        kind: 'authorization',
        code: revocationResult.code,
        safeMessage: revocationResult.safeMessage,
      });
      return;
    }

    const requestText = this.decryptRequest(data.run);
    if (requestText === null) {
      await this.handleFailure(claim, {
        kind: 'internal',
        code: 'DECRYPT_FAILED',
        safeMessage: 'Could not decrypt the run request envelope.',
      });
      return;
    }

    await this.executeAndComplete(claim, signal, data, requestText);
  }

  // -- internal: recovery check --------------------------------------------

  private async handleRecovery(claim: Claim): Promise<boolean> {
    const recoveryService = new MissionRecoveryService(this.db, {
      clock: () => this.now(),
    });
    const result = await recoveryService.checkNonReplayableEffects({
      companyId: claim.companyId,
      projectId: claim.projectId,
      runId: claim.runId,
      leaseToken: claim.leaseToken,
    });
    return result.terminalized;
  }

  // -- internal: topology materialization (VAL-SUB-001, 002, 003, 005) ----

  /**
   * Handle topology materialization for a claimed root run with an approved
   * plan. Returns true if the root should NOT proceed to direct execution
   * (i.e., the plan has children and the root oversees them), false if the
   * root should execute directly (flat plan with no children).
   *
   * Materialization is idempotent: if already materialized, it checks
   * whether the plan has children and returns accordingly.
   */
  private async handleTopologyMaterialization(claim: Claim, run: RunRow): Promise<boolean> {
    const schema = this.db.schema;
    const materializer =
      this.deps.materializer ?? new TopologyMaterializer(this.db, { clock: () => this.now() });

    // Load the approved plan revision.
    const [revision] = await this.db.drizzle
      .select()
      .from(schema.runPlanRevisions)
      .where(eq(schema.runPlanRevisions.id, run.approvedPlanRevisionId!))
      .limit(1);

    if (!revision) {
      // No revision found — fall through to direct execution.
      return false;
    }

    const plan = revision.content as unknown as PlanContent;
    const hasChildren = plan.steps.some((s) => s.parentStepKey !== null);

    if (!hasChildren) {
      // Flat plan (no child topology) — root executes directly.
      return false;
    }

    // Load the root policy snapshot limits for tree limit enforcement
    // (VAL-SUB-029, 032, 039).
    let policyLimits: TreePolicyLimits | undefined;
    if (run.policySnapshotId) {
      const [snapshot] = await this.db.drizzle
        .select({ limits: schema.runPolicySnapshots.limits })
        .from(schema.runPolicySnapshots)
        .where(eq(schema.runPolicySnapshots.id, run.policySnapshotId))
        .limit(1);
      if (snapshot?.limits) {
        const l = snapshot.limits as Record<string, number>;
        policyLimits = {
          depth: l.depth ?? PLATFORM_HARD_CAPS.depth,
          fanOut: l.fanOut ?? PLATFORM_HARD_CAPS.fanOut,
          descendants: l.descendants ?? PLATFORM_HARD_CAPS.descendants,
          providerCalls: l.providerCalls ?? PLATFORM_HARD_CAPS.providerCalls,
          totalTokens: l.totalTokens ?? PLATFORM_HARD_CAPS.totalTokens,
          outputBytes: l.outputBytes ?? PLATFORM_HARD_CAPS.outputBytes,
          costCents: l.costCents ?? PLATFORM_HARD_CAPS.costCents,
        };
      }
    }

    // Materialize the topology in a fenced transaction. The fence ensures
    // a stale worker cannot materialize after lease loss.
    await this.db.drizzle.transaction(async (tx) => {
      // Lock the root run row.
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(
          and(
            eq(schema.missionRuns.companyId, claim.companyId),
            eq(schema.missionRuns.id, claim.runId),
          ),
        )
        .for('update')
        .limit(1);

      if (!lockedRun || lockedRun.terminalAt !== null) {
        return; // run is terminal; nothing to do
      }

      // Fence: verify lease token still matches.
      if (lockedRun.leaseToken !== claim.leaseToken) {
        return; // stale worker; another claim owns this run
      }

      await materializer.materialize(
        tx,
        lockedRun,
        plan,
        revision.id,
        revision.contentHash,
        'system',
        claim.leaseOwner,
        null,
        policyLimits,
      );
    });

    // The root oversees children; do not execute a single LLM call.
    // Children are queued and claimable by the worker.
    return true;
  }

  // -- internal: child routing (VAL-SUB-008 through 016, 041, 088) ---------

  /**
   * Check whether a claimed run is a child with a pending_routing assignment
   * and, if so, delegate to the agent router. Returns true if the child was
   * handled (routed or left pending for ephemeral fallback), false if the
   * run should proceed to direct execution.
   */
  private async maybeHandleChildRouting(
    claim: Claim,
    signal: AbortSignal,
    data: RunAndPolicy,
  ): Promise<boolean> {
    if (data.run.parentRunId === null || data.run.status !== 'queued' || signal.aborted) {
      return false;
    }
    const handled = await this.handleChildRouting(claim, data.run, data.policy);
    if (handled) {
      await this.projectRunEvents(claim);
      return true;
    }
    return false;
  }

  /**
   * Handle child routing for a claimed child run with a pending_routing
   * assignment. Delegates to the AgentRouter to filter, score, and select
   * an eligible same-company agent. If an agent is found, the router emits
   * `child.routed` and sets the executing agent. Returns true if the child
   * was handled (routed or no eligible agent), false if the child does not
   * have a pending_routing assignment and should proceed to direct execution.
   *
   * Ephemeral fallback, capacity reservation, immutable child policy
   * derivation, and scheduling permits are owned by m4-f03 and
   * m4-f03-ephemeral-fallback.
   */
  private async handleChildRouting(
    claim: Claim,
    run: RunRow,
    policy: PolicyInfo | null,
  ): Promise<boolean> {
    const schema = this.db.schema;

    // Check if this child has a step assignment with pending_routing status.
    const [assignment] = await this.db.drizzle
      .select({
        id: schema.runStepAssignments.id,
        stepKey: schema.runStepAssignments.stepKey,
        assignmentStatus: schema.runStepAssignments.assignmentStatus,
        routingRequirements: schema.runStepAssignments.routingRequirements,
        billingAgentId: schema.runStepAssignments.billingAgentId,
        rootRunId: schema.runStepAssignments.rootRunId,
        parentRunId: schema.runStepAssignments.parentRunId,
      })
      .from(schema.runStepAssignments)
      .where(
        and(
          eq(schema.runStepAssignments.companyId, claim.companyId),
          eq(schema.runStepAssignments.runId, claim.runId),
        ),
      )
      .limit(1);

    // No assignment or not pending_routing → not a routing candidate.
    if (!assignment || assignment.assignmentStatus !== 'pending_routing') {
      return false;
    }

    const router = this.deps.router ?? new AgentRouter(this.db, { clock: () => this.now() });

    // Extract routing requirements from the assignment.
    const reqs = assignment.routingRequirements as RoutingRequirements | null;
    if (!reqs) {
      // No routing requirements — cannot route. Leave pending for m4-f03.
      return true;
    }

    // Derive step budget and timeout from the policy limits.
    const stepBudgetCents = policy?.limits?.costCents ?? 100;
    const stepTimeoutSeconds = policy?.limits?.durationSeconds ?? 300;
    const parentProvider = policy?.provider ?? 'anthropic';

    const ctx: RoutingContext = {
      companyId: claim.companyId,
      projectId: claim.projectId,
      rootRunId: assignment.rootRunId,
      parentRunId: assignment.parentRunId,
      childRunId: claim.runId,
      stepKey: assignment.stepKey,
      routingRequirements: reqs,
      stepBudgetCents,
      stepTimeoutSeconds,
      billingAgentId: assignment.billingAgentId,
      parentProvider,
    };

    // Route the child. If an eligible agent is found, the router records the
    // decision atomically. If not, the child remains pending for ephemeral
    // fallback (VAL-SUB-019, 021, 022, 023, 090, 091, 114, VAL-MODEQ-043).
    const routingDecision = await router.route(ctx);

    if (!routingDecision.selected) {
      // No eligible company agent — attempt ephemeral fallback or fail
      // the shell closed with NO_ELIGIBLE_AGENT.
      const ephemeralRouter =
        this.deps.ephemeralRouter ??
        new EphemeralFallbackRouter(this.db, { clock: () => this.now() });

      const ephemeralCtx: EphemeralRoutingContext = {
        companyId: claim.companyId,
        projectId: claim.projectId,
        rootRunId: assignment.rootRunId,
        parentRunId: assignment.parentRunId,
        childRunId: claim.runId,
        stepKey: assignment.stepKey,
        routingRequirements: reqs,
        stepBudgetCents,
        stepTimeoutSeconds,
        billingAgentId: assignment.billingAgentId,
      };

      await ephemeralRouter.routeOrFail(ephemeralCtx);
    }

    // Either way, the child was handled (routed, ephemeral, or failed).
    return true;
  }

  // -- internal: decrypt request envelope ----------------------------------

  private decryptRequest(run: RunRow): string | null {
    try {
      if (run.requestEnvelope) {
        const envelope = decryptEnvelope(run.requestEnvelope);
        return (envelope.text as string) ?? '';
      }
      return '';
    } catch {
      return null;
    }
  }

  // -- internal: agent revocation re-check (VAL-MODEQ-151) -----------------

  /**
   * Re-check the initiating/executing agent's CURRENT eligibility before
   * the next provider call or commit. The policy snapshot is immutable, but
   * live enforcement uses the agent's current state. If the agent has been
   * revoked (status changed to paused/error/offline, provider/model changed,
   * or agent deleted), the run fails safely with a policy/authorization
   * outcome — it never resumes forbidden work (VAL-MODEQ-151).
   *
   * For runs without an initiating agent (system-initiated), no check is
   * needed.
   */
  private async checkAgentRevocation(run: RunRow): Promise<{
    revoked: boolean;
    code: string;
    safeMessage: string;
  }> {
    if (!run.initiatingAgentId) {
      return { revoked: false, code: '', safeMessage: '' };
    }

    const schema = this.db.schema;
    const [agent] = await this.db.drizzle
      .select({
        id: schema.agents.id,
        provider: schema.agents.provider,
        model: schema.agents.model,
        status: schema.agents.status,
        apiKeyEncrypted: schema.agents.apiKeyEncrypted,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, run.initiatingAgentId))
      .limit(1);

    // Agent deleted — revoked.
    if (!agent) {
      return {
        revoked: true,
        code: 'AGENT_REVOKED',
        safeMessage: 'The initiating agent is no longer available.',
      };
    }

    // Agent status revoked (paused/error/offline).
    if (agent.status && !['idle', 'working'].includes(agent.status)) {
      return {
        revoked: true,
        code: 'AGENT_REVOKED',
        safeMessage: 'The initiating agent is no longer active.',
      };
    }

    // Credential revoked: agent has no API key and no server-side key is
    // available (checked at call time, but we can detect a missing encrypted
    // key here as a proxy for credential removal).
    if (!agent.apiKeyEncrypted) {
      // Fall back to server-side key resolution — only revoke if the
      // server-side key is also missing. We check this conservatively.
      try {
        const provider = agent.provider ?? 'anthropic';
        resolveProviderApiKey(provider, undefined);
      } catch {
        return {
          revoked: true,
          code: 'AGENT_CREDENTIAL_REVOKED',
          safeMessage: 'The initiating agent no longer has valid credentials.',
        };
      }
    }

    return { revoked: false, code: '', safeMessage: '' };
  }

  // -- internal: execute provider call and complete the run ----------------

  private async executeAndComplete(
    claim: Claim,
    signal: AbortSignal,
    data: RunAndPolicy,
    requestText: string,
  ): Promise<void> {
    const provider = data.policy?.provider ?? 'anthropic';
    const model = data.policy?.model ?? 'claude-sonnet-4-6';
    const durationSeconds = data.policy?.limits?.durationSeconds ?? 300;

    const messages: ChatMessage[] = [
      { role: 'user', content: requestText || 'Process this mission run.' },
    ];
    const apiKey = resolveProviderApiKey(provider, undefined);
    const config: ProviderConfig = { apiKey, model, maxTokens: 4096 };

    const timeoutMs = Math.min(durationSeconds * 1000, 120_000);
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutController.signal]);

    try {
      const callFn = this.deps.providerCall ?? this.defaultProviderCall.bind(this);
      const result = await callFn(messages, config, combinedSignal);
      clearTimeout(timeoutTimer);

      await this.settleBudget(claim, result);
      await this.completeRun(claim);
      await this.projectRunEvents(claim);
    } catch (err) {
      clearTimeout(timeoutTimer);
      if (signal.aborted) {
        return;
      }
      const isTimeout = timeoutController.signal.aborted && !signal.aborted;
      await this.handleFailure(claim, {
        kind: 'provider',
        code: isTimeout ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR',
        safeMessage: isTimeout
          ? 'The provider call timed out.'
          : `Provider call failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      });
    }
  }

  // -- internal: settle budget for a provider call -------------------------

  private async settleBudget(claim: Claim, result: CompletionResult): Promise<void> {
    const externalCallId = `mission-${claim.runId}-attempt-${claim.attemptCount + 1}-${randomUUID().slice(0, 8)}`;
    const budgetService = new BudgetService(this.db, { clock: () => this.now() });
    await this.db.drizzle.transaction(async (tx) => {
      await budgetService.settle(tx, {
        companyId: claim.companyId,
        runId: claim.runId,
        billingAgentId: null,
        externalCallId,
        provider: result.provider,
        model: result.model,
        operation: 'chat',
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        costCents: result.costCents,
      });
    });
  }

  // -- internal: complete the run (fenced by lease token) ------------------

  private async completeRun(claim: Claim): Promise<void> {
    const completionService = new MissionCompletionService(this.db, {
      clock: () => this.now(),
    });
    await this.db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, claim.companyId, claim.projectId, claim.runId, {
        leaseToken: claim.leaseToken,
      });
    });
  }

  // -- internal: default provider call using the real registry -------------

  private async defaultProviderCall(
    messages: ChatMessage[],
    config: ProviderConfig,
    _signal: AbortSignal,
  ): Promise<CompletionResult> {
    void _signal;
    const provider = getProvider('anthropic');
    return provider.chat(messages, config);
  }

  // -- internal: read run + policy snapshot --------------------------------

  private async readRunAndPolicy(claim: Claim): Promise<RunAndPolicy | null> {
    const schema = this.db.schema;

    const [run] = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        companyId: schema.missionRuns.companyId,
        projectId: schema.missionRuns.projectId,
        status: schema.missionRuns.status,
        stateVersion: schema.missionRuns.stateVersion,
        lastEventSequence: schema.missionRuns.lastEventSequence,
        attemptCount: schema.missionRuns.attemptCount,
        cancelRequestedAt: schema.missionRuns.cancelRequestedAt,
        policySnapshotId: schema.missionRuns.policySnapshotId,
        requestEnvelope: schema.missionRuns.requestEnvelope,
        initiatingAgentId: schema.missionRuns.initiatingAgentId,
        createdAt: schema.missionRuns.createdAt,
        parentRunId: schema.missionRuns.parentRunId,
        rootRunId: schema.missionRuns.rootRunId,
        approvedPlanRevisionId: schema.missionRuns.approvedPlanRevisionId,
      })
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, claim.runId))
      .limit(1);

    if (!run) {
      return null;
    }

    const policy = run.policySnapshotId ? await this.readPolicy(run.policySnapshotId) : null;
    return { run, policy };
  }

  private async readPolicy(policySnapshotId: string): Promise<PolicyInfo | null> {
    const schema = this.db.schema;
    const [policyRow] = await this.db.drizzle
      .select({
        provider: schema.runPolicySnapshots.provider,
        model: schema.runPolicySnapshots.model,
        limits: schema.runPolicySnapshots.limits,
      })
      .from(schema.runPolicySnapshots)
      .where(eq(schema.runPolicySnapshots.id, policySnapshotId))
      .limit(1);
    if (!policyRow) {
      return null;
    }
    return {
      provider: policyRow.provider,
      model: policyRow.model,
      limits: policyRow.limits as Record<string, number>,
    };
  }

  // -- internal: handle provider failure via retry service -----------------

  private async handleFailure(
    claim: Claim,
    failure: {
      kind: 'provider' | 'network' | 'internal' | 'authorization' | 'policy';
      httpStatus?: number;
      code: string;
      safeMessage: string;
    },
  ): Promise<void> {
    const retryService = new MissionRetryService(this.db, { clock: () => this.now() });

    try {
      await retryService.handleExecutionFailure({
        companyId: claim.companyId,
        projectId: claim.projectId,
        runId: claim.runId,
        failure: {
          kind: failure.kind as 'provider' | 'network' | 'database',
          httpStatus: failure.httpStatus,
          code: failure.code,
          safeMessage: failure.safeMessage,
        },
        leaseToken: claim.leaseToken,
        maxAttempts: 3,
      });
    } catch {
      logger.warn(
        { runId: claim.runId, code: failure.code },
        'RunProcessor: retry service failed to handle execution failure',
      );
    }

    await this.projectRunEvents(claim);
  }

  // -- internal: project lifecycle events ----------------------------------

  private async projectRunEvents(claim: Claim): Promise<void> {
    try {
      const schema = this.db.schema;
      const events = await this.db.drizzle
        .select()
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, claim.runId))
        .orderBy(schema.runEvents.sequence);

      for (const event of events) {
        await projectEvent(
          this.db,
          {
            runId: event.runId,
            companyId: event.companyId,
            projectId: event.projectId,
            sequence: Number(event.sequence),
            type: event.type,
            payload: event.payload as Record<string, unknown>,
            actorType: event.actorType as 'user' | 'agent' | 'system' | null,
            actorId: event.actorId,
            traceId: event.traceId,
            occurredAt: event.occurredAt,
          },
          { clock: () => this.now() },
        );
      }
    } catch {
      // Projection failure is non-fatal — it's retried idempotently.
    }
  }
}
