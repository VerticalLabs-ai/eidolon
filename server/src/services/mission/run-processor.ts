import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../../providers/types.js';
import { resolveProviderApiKey } from '../provider-key.js';
import { getProvider } from '../../providers/index.js';
import type { DbInstance } from '../../types.js';
import { AppError } from '../../middleware/error-handler.js';
import type { Claim } from './coordinator.js';
import { MissionRecoveryService } from './recovery.js';
import { MissionCompletionService } from './completion.js';
import { MissionRetryService } from './retry.js';
import { BudgetService } from './budget.js';
import { MissionSynthesisService, type ManifestEntry } from './synthesis.js';
import type {
  SynthesisArtifactCreator,
  CreateSynthesisArtifactResult,
} from './synthesis-artifact-creator.js';
import { projectEvent } from './projection.js';
import { decryptEnvelope } from './ingress.js';
import { TopologyMaterializer } from './topology-materializer.js';
import { AgentRouter, type RoutingContext } from './agent-router.js';
import { EphemeralFallbackRouter, type EphemeralRoutingContext } from './ephemeral-router.js';
import type { RoutingRequirements, PlanContent } from './plan-schema.js';
import { PLATFORM_HARD_CAPS } from './modes.js';
import type { TreePolicyLimits } from './tree-limits.js';
import type { ResearchOperation } from './research/spi.js';
import logger from '../../utils/logger.js';

// ---------------------------------------------------------------------------
// Research operation detection
// ---------------------------------------------------------------------------

/**
 * Mapping from plan step tool-allowlist entries to research operations.
 *
 * A child run whose approved plan step includes any of these tools has
 * research operations. The RunProcessor invokes the ResearchExecutionService
 * for those operations instead of making a single LLM provider call.
 *
 * (architecture.md: ResearchProvider SPI, fix-ut-m5-research-execution-wiring)
 */
const RESEARCH_TOOL_TO_OPERATION: Record<string, ResearchOperation> = {
  // Canonical internal research.* tool names (architecture.md: ResearchProvider SPI).
  'research.search': 'search',
  'research.extract': 'extract',
  'research.scrape': 'scrape',
  'research.structured_extract': 'structured_extract',
  // LLM-planner-generated aliases. The planner may emit generic web_* or
  // provider-prefixed tool names in plan step `toolAllowlist` fields. Map
  // them to the same research operations so children execute research
  // instead of silently falling through to a plain LLM provider call
  // (fix-ut-m5-tool-name-mapping).
  web_search: 'search',
  web_fetch: 'extract',
  web_browse: 'search',
  'tavily.search': 'search',
  'firecrawl.search': 'search',
  'firecrawl.scrape': 'scrape',
  'firecrawl.extract': 'extract',
  'firecrawl.structured_extract': 'structured_extract',
};

/** Extract research operations from a step's tool allowlist. */
function extractResearchOperations(toolAllowlist: string[]): ResearchOperation[] {
  const ops: ResearchOperation[] = [];
  for (const tool of toolAllowlist) {
    const op = RESEARCH_TOOL_TO_OPERATION[tool];
    if (op) {
      ops.push(op);
    }
  }
  return ops;
}

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
  /**
   * Research executor for child runs with research operations. When a
   * claimed child run's approved plan step includes research tools
   * (research.search, research.extract, research.scrape,
   * research.structured_extract), the processor delegates to this executor
   * to invoke the ResearchExecutionService with real Tavily/Firecrawl
   * adapters, persist source revisions, and settle budget before completing
   * the run. If not provided, research-operation children fall through to
   * the existing LLM provider call path (fix-ut-m5-research-execution-wiring).
   */
  researchExecutor?: ResearchExecutor;
  /**
   * Synthesis artifact creator for composite runs. When a composite (parent)
   * run completes synthesis, the processor delegates to this creator to
   * gather research sources from child runs, make an LLM call to synthesize
   * a research report, and commit the report as an artifact with citations
   * and provenance (fix-ut-m5-synthesis-artifact-citation-wiring). If not
   * provided, synthesis completes without creating an artifact (existing
   * behavior).
   */
  synthesisArtifactCreator?: SynthesisArtifactCreator;
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
  /** Tool allowlist from the immutable policy snapshot. */
  toolAllowlist: string[];
  /** Domain allowlist from the immutable policy snapshot. */
  domainAllowlist: string[];
}

// ---------------------------------------------------------------------------
// Research executor interface
// ---------------------------------------------------------------------------

/**
 * Context for research execution within RunProcessor.executeAndComplete().
 */
export interface ResearchExecutionContext {
  claim: Claim;
  run: RunRow;
  policy: PolicyInfo;
  /** Decrypted request text (used as the search query). */
  requestText: string;
  /** Research operations to execute (derived from the step's toolAllowlist). */
  operations: ResearchOperation[];
  /** Abort signal for cooperative cancellation. */
  signal: AbortSignal;
}

/**
 * Result of a research execution attempt.
 */
export interface ResearchExecutionOutcome {
  /** Whether research was executed (true) or no research ops found (false). */
  executed: boolean;
  /** Number of sources persisted (0 if not executed). */
  sourceCount: number;
}

/**
 * Research executor: invoked by RunProcessor when a child run's approved
 * plan step includes research operations. The executor constructs
 * Tavily/Firecrawl adapters with the resolved credentials, invokes the
 * ResearchExecutionService, and persists source revisions. Budget
 * settlement is handled by the ResearchExecutionService's accounting
 * service. The RunProcessor completes the run after research finishes.
 *
 * (fix-ut-m5-research-execution-wiring)
 */
export interface ResearchExecutor {
  execute(ctx: ResearchExecutionContext): Promise<ResearchExecutionOutcome>;
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
        // VAL-SUB-064, 065, 066, 111: After topology materialization (or if
        // already materialized), attempt synthesis. If all direct children are
        // terminal, the synthesis service commits exactly one ordered manifest,
        // synthesis result, completion event, and terminal outcome. If children
        // are not all terminal, the run remains nonterminal. The lease is left
        // to expire naturally (the worker stops renewing it when advance
        // returns), so the run stays in 'running' and is re-claimed later.
        await this.attemptCompositeSynthesis(claim);
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

    // VAL-SUB-064, 065, 066, 111: Intermediate composite synthesis.
    // A non-root run that has children (an intermediate composite) must not
    // execute a direct LLM call — it synthesizes from its direct children.
    // When claimed, attempt synthesis. If children are not all terminal,
    // the run stays nonterminal and the lease expires naturally for re-claim.
    if (
      data.run.parentRunId !== null &&
      data.run.status === 'running' &&
      data.run.approvedPlanRevisionId &&
      !signal.aborted
    ) {
      const hasChildren = await this.runHasChildren(claim, data.run.id);
      if (hasChildren) {
        await this.attemptCompositeSynthesis(claim);
        await this.projectRunEvents(claim);
        return;
      }
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

  // -- internal: composite synthesis (VAL-SUB-051, 052, 053, 064, 065, 066, 111)

  /**
   * Check whether a run has any direct children (is a composite).
   */
  private async runHasChildren(claim: Claim, runId: string): Promise<boolean> {
    // projectId-scoped so a child-count query can never match another
    // project's runs (defense-in-depth, fix-misc-company-scoping).
    const result = await this.db.drizzle.execute(sql`
      SELECT count(*)::int AS cnt FROM "mission_runs"
      WHERE "company_id" = ${claim.companyId}
        AND "project_id" = ${claim.projectId}
        AND "parent_run_id" = ${runId}
    `);
    const rows = result as unknown as Array<{ cnt: number }>;
    return rows.length > 0 && Number(rows[0]!.cnt) > 0;
  }

  /**
   * Attempt composite synthesis for a parent run with children. Returns
   * true if synthesis was performed (the run is now terminal), false if
   * children are not all terminal or synthesis was skipped.
   *
   * After synthesis completes successfully (run is 'completed'), if a
   * synthesis artifact creator is available, the processor delegates to
   * it to gather research sources from child runs, make an LLM call to
   * synthesize a research report, and commit the report as an artifact
   * with citations and provenance
   * (fix-ut-m5-synthesis-artifact-citation-wiring).
   *
   * (VAL-SUB-064, 065, 066, 111)
   */
  private async attemptCompositeSynthesis(claim: Claim): Promise<boolean> {
    const synthesisService = new MissionSynthesisService(this.db, {
      clock: () => this.now(),
    });
    let synthesized = false;
    let completedStatus: string | null = null;
    let manifest: ManifestEntry[] | null = null;
    let approvedPlanRevisionId: string | null = null;
    let approvedContentHash: string | null = null;
    let policySnapshotId: string | null = null;
    try {
      const result = await this.db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId: claim.companyId,
          projectId: claim.projectId,
          runId: claim.runId,
          leaseToken: claim.leaseToken,
        });
      });
      synthesized = result.synthesized;
      completedStatus = result.status;
      manifest = result.manifest;
      // Read the run's approved plan revision ID and policy snapshot ID
      // for the artifact creator. These are needed to build provenance.
      if (synthesized && result.status === 'completed') {
        const schema = this.db.schema;
        const [run] = await this.db.drizzle
          .select({
            approvedPlanRevisionId: schema.missionRuns.approvedPlanRevisionId,
            policySnapshotId: schema.missionRuns.policySnapshotId,
            rootRunId: schema.missionRuns.rootRunId,
          })
          .from(schema.missionRuns)
          .where(eq(schema.missionRuns.id, claim.runId))
          .limit(1);
        approvedPlanRevisionId = run?.approvedPlanRevisionId ?? null;
        policySnapshotId = run?.policySnapshotId ?? null;

        if (approvedPlanRevisionId) {
          const [revision] = await this.db.drizzle
            .select({ contentHash: schema.runPlanRevisions.contentHash })
            .from(schema.runPlanRevisions)
            .where(eq(schema.runPlanRevisions.id, approvedPlanRevisionId))
            .limit(1);
          approvedContentHash = revision?.contentHash ?? null;
        }
      }
    } catch {
      // Synthesis may fail due to concurrent transaction (exactly-once
      // unique constraint) or lease fencing. In either case, the run
      // remains nonterminal and will be retried on re-claim.
      return false;
    }

    // After synthesis completes successfully, create the research artifact
    // with citations and provenance (fix-ut-m5-synthesis-artifact-citation-wiring).
    if (
      synthesized &&
      completedStatus === 'completed' &&
      this.deps.synthesisArtifactCreator &&
      approvedPlanRevisionId &&
      approvedContentHash
    ) {
      await this.createSynthesisArtifact(claim, {
        approvedPlanRevisionId,
        approvedContentHash,
        policySnapshotId,
        manifest,
      });
    }

    return synthesized;
  }

  /**
   * Create a research synthesis artifact with citations and provenance
   * after synthesis completes (fix-ut-m5-synthesis-artifact-citation-wiring).
   *
   * Delegates to the SynthesisArtifactCreator to gather research sources
   * from child runs, make an LLM call, and commit the artifact. Emits
   * artifact.committed and citation.committed events to the run journal.
   */
  private async createSynthesisArtifact(
    claim: Claim,
    info: {
      approvedPlanRevisionId: string;
      approvedContentHash: string;
      policySnapshotId: string | null;
      manifest: ManifestEntry[] | null;
    },
  ): Promise<void> {
    try {
      const result = await this.deps.synthesisArtifactCreator!.createSynthesisArtifact({
        companyId: claim.companyId,
        projectId: claim.projectId,
        runId: claim.runId,
        rootRunId: claim.runId, // Root run is the composite run itself
        approvedPlanRevisionId: info.approvedPlanRevisionId,
        approvedContentHash: info.approvedContentHash,
        policySnapshotId: info.policySnapshotId,
      });

      if (!result) {
        return; // No research sources found — no artifact to create.
      }

      // Emit artifact.committed and citation.committed events to the run
      // journal so consumers know an artifact was created during synthesis.
      await this.emitArtifactEvents(claim, result);
    } catch (err) {
      // Artifact creation failure is non-fatal — the run is already completed.
      // Log the error but do not change the run's terminal state.
      logger.warn(
        {
          runId: claim.runId,
          err: err instanceof Error ? err.message : String(err),
        },
        'RunProcessor: synthesis artifact creation failed (non-fatal, run already completed)',
      );
    }
  }

  /**
   * Emit artifact.committed and citation.committed events to the run journal
   * after a synthesis artifact is created.
   */
  private async emitArtifactEvents(
    claim: Claim,
    result: CreateSynthesisArtifactResult,
  ): Promise<void> {
    const schema = this.db.schema;
    const now = this.now();

    await this.db.drizzle.transaction(async (tx) => {
      // Lock and read the run row to get the current sequence.
      const rows = (await tx.execute(sql`
        SELECT "state_version", "last_event_sequence"
        FROM "mission_runs"
        WHERE "id" = ${claim.runId} AND "company_id" = ${claim.companyId}
        FOR UPDATE
      `)) as unknown as Array<{
        state_version: string;
        last_event_sequence: string;
      }>;
      if (!rows[0]) {
        return;
      }

      const currentSeq = Number(rows[0]!.last_event_sequence);
      const artifactSeq = currentSeq + 1;
      const citationSeq = currentSeq + 2;
      const newVersion = Number(rows[0]!.state_version) + 2;

      // Emit artifact.committed event.
      await tx.insert(schema.runEvents).values({
        companyId: claim.companyId,
        projectId: claim.projectId,
        runId: claim.runId,
        sequence: artifactSeq,
        type: 'artifact.committed',
        schemaVersion: 1,
        payload: {
          artifactId: result.artifactId,
          artifactRevisionId: result.artifactRevisionId,
          provenanceId: result.provenanceId,
          source: 'synthesis',
        },
        actorType: 'system',
        actorId: null,
        traceId: null,
        occurredAt: now,
      });

      // Emit citation.committed event.
      await tx.insert(schema.runEvents).values({
        companyId: claim.companyId,
        projectId: claim.projectId,
        runId: claim.runId,
        sequence: citationSeq,
        type: 'citation.committed',
        schemaVersion: 1,
        payload: {
          artifactId: result.artifactId,
          artifactRevisionId: result.artifactRevisionId,
          citationIds: result.citationIds,
          citationCount: result.citationIds.length,
        },
        actorType: 'system',
        actorId: null,
        traceId: null,
        occurredAt: now,
      });

      // Update the run's last_event_sequence and state_version.
      await tx
        .update(schema.missionRuns)
        .set({
          lastEventSequence: citationSeq,
          stateVersion: newVersion,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, claim.runId));
    });
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

      // After materialization, resolve dependencies on the root orchestration
      // step (nodeKind='root'). The root's job was to decompose — once
      // children are materialized, the root step's dependency is satisfied.
      // This transitions children that depend on the root from
      // pending_dependencies to pending_routing, making them claimable
      // (fix-ut-m5-dependency-resolution).
      await materializer.resolveDependencies(tx, claim.runId, claim.companyId, claim.projectId, {
        actorType: 'system',
        actorId: claim.leaseOwner,
      });
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
    if (data.run.parentRunId === null || signal.aborted) {
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
        approvedPlanRevisionId: schema.runStepAssignments.approvedPlanRevisionId,
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

    // Derive step budget from the approved plan step's budgetCents, not the
    // policy's total costCents ceiling. Using the total ceiling would
    // allocate the entire root reservation to each child, causing a
    // CHECK constraint violation (settled + released > reserved) when
    // multiple children settle (fix-ut-m5-dependency-resolution).
    const stepBudgetCents = await this.resolveStepBudgetCents(
      assignment.approvedPlanRevisionId,
      assignment.stepKey,
      policy,
    );

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

  /**
   * Resolve the per-step budget for a child allocation. Reads the step's
   * `budgetCents` from the approved plan revision, falling back to the
   * policy's total costCents ceiling only when the step budget is absent.
   *
   * Using the total ceiling as the per-step budget would allocate the
   * entire root reservation to each child, causing a CHECK constraint
   * violation (settled + released > reserved) when multiple children
   * settle (fix-ut-m5-dependency-resolution).
   */
  private async resolveStepBudgetCents(
    approvedPlanRevisionId: string | null,
    stepKey: string,
    policy: PolicyInfo | null,
  ): Promise<number> {
    if (approvedPlanRevisionId) {
      const schema = this.db.schema;
      const [revision] = await this.db.drizzle
        .select({ content: schema.runPlanRevisions.content })
        .from(schema.runPlanRevisions)
        .where(eq(schema.runPlanRevisions.id, approvedPlanRevisionId))
        .limit(1);
      if (revision?.content) {
        const plan = revision.content as unknown as PlanContent;
        const step = plan.steps?.find((s) => s.stepKey === stepKey);
        if (step?.budgetCents) {
          return step.budgetCents;
        }
      }
    }
    return policy?.limits?.costCents ?? 100;
  }

  /**
   * Resolve research operations for a child run by looking up its step
   * assignment's stepKey and the approved plan step's toolAllowlist.
   *
   * Returns the list of research operations (search/extract/scrape/
   * structured_extract) found in the step's toolAllowlist. Returns an
   * empty array if the run is not a child, has no step assignment, or the
   * step has no research tools.
   *
   * (fix-ut-m5-research-execution-wiring)
   */
  private async resolveResearchOperations(claim: Claim, run: RunRow): Promise<ResearchOperation[]> {
    if (run.parentRunId === null) {
      return [];
    }

    const schema = this.db.schema;

    // Look up the step assignment to get the stepKey and approved plan revision.
    const [assignment] = await this.db.drizzle
      .select({
        stepKey: schema.runStepAssignments.stepKey,
        approvedPlanRevisionId: schema.runStepAssignments.approvedPlanRevisionId,
      })
      .from(schema.runStepAssignments)
      .where(
        and(
          eq(schema.runStepAssignments.companyId, claim.companyId),
          eq(schema.runStepAssignments.runId, claim.runId),
        ),
      )
      .limit(1);

    if (!assignment || !assignment.approvedPlanRevisionId) {
      return [];
    }

    // Load the approved plan revision to get the step's toolAllowlist.
    const [revision] = await this.db.drizzle
      .select({ content: schema.runPlanRevisions.content })
      .from(schema.runPlanRevisions)
      .where(eq(schema.runPlanRevisions.id, assignment.approvedPlanRevisionId))
      .limit(1);

    if (!revision?.content) {
      return [];
    }

    const plan = revision.content as unknown as PlanContent;
    const step = plan.steps?.find((s) => s.stepKey === assignment.stepKey);
    if (!step) {
      return [];
    }

    return extractResearchOperations(step.toolAllowlist);
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
    // Research execution path (fix-ut-m5-research-execution-wiring):
    // When a child run's approved plan step includes research operations,
    // invoke the ResearchExecutionService instead of the LLM provider.
    if (await this.maybeExecuteResearch(claim, signal, data, requestText)) {
      return;
    }

    await this.executeProviderCall(claim, signal, data, requestText);
  }

  /**
   * Research execution path (fix-ut-m5-research-execution-wiring).
   *
   * When a child run's approved plan step includes research operations
   * (research.search, research.extract, research.scrape,
   * research.structured_extract), invoke the ResearchExecutionService to
   * make real Tavily/Firecrawl calls, persist source revisions, and settle
   * budget before completing the run. Returns true if research was executed
   * and the run was completed, false if no research operations were found
   * (fall through to the LLM provider call path).
   */
  private async maybeExecuteResearch(
    claim: Claim,
    signal: AbortSignal,
    data: RunAndPolicy,
    requestText: string,
  ): Promise<boolean> {
    if (!this.deps.researchExecutor || !data.policy || data.run.parentRunId === null) {
      return false;
    }

    const operations = await this.resolveResearchOperations(claim, data.run);
    if (operations.length === 0 || signal.aborted) {
      return false;
    }

    const outcome = await this.deps.researchExecutor.execute({
      claim,
      run: data.run,
      policy: data.policy,
      requestText,
      operations,
      signal,
    });

    if (!outcome.executed || signal.aborted) {
      return false;
    }

    await this.completeRun(claim);
    await this.projectRunEvents(claim);
    return true;
  }

  /**
   * Existing LLM provider call path: make a bounded single LLM provider
   * call, settle budget, and complete the run.
   */
  private async executeProviderCall(
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
      // VAL-SUB-072: If the provider call succeeded (known charge settled)
      // but cancellation won the run lock before completion, the charge
      // remains visible while the result is discarded. The cancellation
      // service owns terminalization — do not retry as a provider error.
      if (err instanceof AppError && err.code === 'INVALID_RUN_STATE') {
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
        toolAllowlist: schema.runPolicySnapshots.toolAllowlist,
        domainAllowlist: schema.runPolicySnapshots.domainAllowlist,
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
      toolAllowlist: (policyRow.toolAllowlist as string[]) ?? [],
      domainAllowlist: (policyRow.domainAllowlist as string[]) ?? [],
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
