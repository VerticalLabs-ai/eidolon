import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../../types.js';
import type { Claim } from './coordinator.js';
import { PlanPublicationService, type PlanPublicationFailpoint } from './plan-publication.js';
import { decryptEnvelope } from './ingress.js';
import logger from '../../utils/logger.js';

/**
 * Planner service — generates, validates, and atomically publishes Mission
 * plans (VAL-PLAN-024, 025, 026, 027, 103, 106, 114, 130).
 *
 * When the worker claims a `planning` run, this service:
 *
 *  1. Reads the run row, policy snapshot, and decrypted request.
 *  2. Calls the injectable `PlanGenerator` to produce a structured plan.
 *  3. Validates the generated plan through production schemas and
 *     canonicalizers (VAL-PLAN-113, VAL-PLAN-124).
 *  4. Publishes the plan atomically via `PlanPublicationService`: one
 *     revision, one unresolved `plan_gate` approval, and a transition to
 *     `awaiting_approval` — all in one transaction (VAL-PLAN-103).
 *  5. On transient failure or malformed output: bounded retry within the
 *     same claim (up to `maxAttempts`). Each attempt may settle a planning
 *     LLM charge exactly once (VAL-PLAN-114).
 *  6. On permanent failure or retry exhaustion: terminalizes the run with
 *     a safe failure category. No ghost plan is ever visible — uncommitted
 *     output is never actionable (VAL-PLAN-114).
 *
 * The plan generator is injectable. In production, an LLM-backed generator
 * calls the provider. In tests, the nonproduction `PlannerTestHarness`
 * injects deterministic plan vectors and failpoints (VAL-PLAN-130).
 */

/** Planner failure categories (stable, safe). */
export type PlannerFailureCategory =
  'provider_transient' | 'provider_permanent' | 'timeout' | 'validation' | 'internal';

/** Outcome of a plan generation attempt. */
export type PlanGeneratorOutcome =
  | {
      kind: 'plan';
      /** Raw plan content to be validated by production validators. */
      content: unknown;
      /** Safe metadata about what generated this plan. */
      generatedBy: Record<string, unknown>;
    }
  | {
      kind: 'malformed';
      /** Malformed structured output that failed validation. */
      raw: unknown;
      code: string;
      safeMessage: string;
    }
  | {
      kind: 'failure';
      category: PlannerFailureCategory;
      code: string;
      safeMessage: string;
    };

/** Context passed to the plan generator. */
export interface PlannerContext {
  runId: string;
  companyId: string;
  projectId: string;
  requestText: string;
  resolvedMode: string;
  policySnapshotId: string | null;
}

/**
 * Injectable plan generator. In production, an LLM-backed implementation
 * calls the provider. In tests, the nonproduction harness injects
 * deterministic vectors and failpoints (VAL-PLAN-130).
 *
 * Production routes NEVER accept validator-authored plans: the production
 * generator always calls the real provider. The harness is gated by a
 * test-only configuration flag and cannot be constructed in production
 * builds.
 */
export interface PlanGenerator {
  generate(ctx: PlannerContext, signal: AbortSignal): Promise<PlanGeneratorOutcome>;
}

export interface PlannerDeps {
  generator: PlanGenerator;
  clock?: () => Date;
  /** Maximum planner attempts within one claim. Default: 3. */
  maxAttempts?: number;
  /**
   * Optional budget settlement for planning LLM calls. If provided, each
   * generation attempt settles a planning charge exactly once
   * (VAL-PLAN-114).
   */
  settlePlanningCharge?: (
    tx: Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0],
    params: {
      companyId: string;
      runId: string;
      externalCallId: string;
      costCents: number;
      inputTokens: number;
      outputTokens: number;
    },
  ) => Promise<void>;
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
  resolvedMode: string;
  leaseToken: string | null;
}

/** Default maximum planner attempts (VAL-PLAN-114). */
const DEFAULT_MAX_ATTEMPTS = 3;

export class PlannerService {
  private readonly maxAttempts: number;

  constructor(
    private db: DbInstance,
    private deps: PlannerDeps,
  ) {
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Plan a claimed run: generate, validate, and atomically publish a plan
   * proposal, transitioning the run to `awaiting_approval`.
   *
   * Called by the run-processor when a `planning` run is claimed.
   */
  async plan(claim: Claim, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return;
    }

    const run = await this.readRun(claim);
    if (!run || run.cancelRequestedAt !== null || signal.aborted) {
      return;
    }

    const requestText = this.decryptRequest(run);

    const ctx: PlannerContext = {
      runId: run.id,
      companyId: run.companyId,
      projectId: run.projectId,
      requestText,
      resolvedMode: run.resolvedMode,
      policySnapshotId: run.policySnapshotId,
    };

    let attempt = 0;
    let lastFailure: {
      category: PlannerFailureCategory;
      code: string;
      safeMessage: string;
    } | null = null;

    while (attempt < this.maxAttempts && !signal.aborted) {
      attempt += 1;
      const externalCallId = `planner-${run.id}-attempt-${attempt}-${randomUUID().slice(0, 8)}`;

      let outcome: PlanGeneratorOutcome;
      try {
        outcome = await this.deps.generator.generate(ctx, signal);
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        // Treat thrown errors as transient failures.
        lastFailure = {
          category: 'provider_transient',
          code: 'PLANNER_ERROR',
          safeMessage: `Planner generation failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
        continue;
      }

      if (signal.aborted) {
        return;
      }

      if (outcome.kind === 'failure') {
        lastFailure = {
          category: outcome.category,
          code: outcome.code,
          safeMessage: outcome.safeMessage,
        };
        // Permanent failures stop immediately.
        if (outcome.category === 'provider_permanent' || outcome.category === 'validation') {
          break;
        }
        // Transient/timeout failures retry.
        continue;
      }

      if (outcome.kind === 'malformed') {
        lastFailure = {
          category: 'validation',
          code: outcome.code,
          safeMessage: outcome.safeMessage,
        };
        // Malformed output counts as an attempt; retry.
        continue;
      }

      // outcome.kind === 'plan': validate and publish atomically.
      try {
        const published = await this.db.drizzle.transaction(async (tx) => {
          // Lock the run row.
          const lockedRun = await this.lockRun(tx, run.id, claim.leaseToken);
          if (!lockedRun) {
            return null;
          }

          // Re-check cancellation under the lock.
          if (lockedRun.cancelRequestedAt !== null) {
            return null;
          }

          // Settle the planning LLM charge exactly once (VAL-PLAN-114).
          if (this.deps.settlePlanningCharge) {
            await this.deps.settlePlanningCharge(tx, {
              companyId: run.companyId,
              runId: run.id,
              externalCallId,
              costCents: 0,
              inputTokens: 0,
              outputTokens: 0,
            });
          }

          const publicationService = new PlanPublicationService(this.db, {
            clock: () => this.now(),
          });

          return publicationService.publishPlanProposal(tx, lockedRun, {
            planContent: outcome.content,
            generatedBy: outcome.generatedBy,
            actorType: 'system',
            actorId: claim.leaseOwner,
            traceId: null,
          });
        });

        if (published) {
          // Successfully published: the run is now awaiting_approval.
          return;
        }

        // If published is null, cancellation won the race or the lease was
        // lost. Either way, stop.
        return;
      } catch (err) {
        if (signal.aborted) {
          return;
        }
        // Publication failure (validation, budget, or persistence fault).
        // The transaction rolled back — no ghost plan (VAL-PLAN-114).
        lastFailure = {
          category: 'internal',
          code: 'PLAN_PUBLICATION_FAILED',
          safeMessage: `Plan publication failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        };
        // If it's a validation error (422), it's a plan-graph issue — retry
        // with a new generation. Otherwise treat as transient.
        const appErr = err as { status?: number; code?: string };
        if (appErr?.status === 422) {
          lastFailure.category = 'validation';
          lastFailure.code = appErr.code ?? 'PLAN_GRAPH_INVALID';
        }
        continue;
      }
    }

    // Retry exhausted or permanent failure: terminalize the run.
    if (lastFailure && !signal.aborted) {
      await this.terminalizeFailure(claim, run, lastFailure);
    }
  }

  // -- internal: read run row ------------------------------------------------

  private async readRun(claim: Claim): Promise<RunRow | null> {
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
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
        resolvedMode: schema.missionRuns.resolvedMode,
        leaseToken: schema.missionRuns.leaseToken,
      })
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, claim.runId))
      .limit(1);
    if (!row) {
      return null;
    }
    return {
      ...row,
      lastEventSequence: Number(row.lastEventSequence),
      leaseToken: row.leaseToken,
    } as RunRow;
  }

  // -- internal: lock run row within a transaction --------------------------

  private async lockRun(
    tx: Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0],
    runId: string,
    leaseToken: string,
  ): Promise<MissionRunRow | null> {
    const rows = (await tx.execute(sql`
      SELECT * FROM "mission_runs"
      WHERE "id" = ${runId} AND "lease_token" = ${leaseToken}
      FOR UPDATE
    `)) as unknown as Array<Record<string, unknown>>;
    if (!rows[0]) {
      return null;
    }
    const row = rows[0];
    // Map snake_case to the $inferSelect shape expected by PlanPublicationService.
    return {
      id: row['id'] as string,
      companyId: row['company_id'] as string,
      projectId: row['project_id'] as string,
      projectThreadId: row['project_thread_id'] as string,
      rootRunId: row['root_run_id'] as string,
      parentRunId: (row['parent_run_id'] as string) ?? null,
      retryOfRunId: (row['retry_of_run_id'] as string) ?? null,
      depth: row['depth'] as number,
      childOrdinal: (row['child_ordinal'] as number) ?? null,
      initiatingUserId: (row['initiating_user_id'] as string) ?? null,
      initiatingAgentId: (row['initiating_agent_id'] as string) ?? null,
      executingAgentId: (row['executing_agent_id'] as string) ?? null,
      billingAgentId: (row['billing_agent_id'] as string) ?? null,
      routingKind: row['routing_kind'] as 'company_agent' | 'ephemeral',
      requestEnvelope: row['request_envelope'] as string,
      requestContentHash: row['request_content_hash'] as string,
      requestSafeSummary: (row['request_safe_summary'] as string) ?? null,
      modeProfileId: (row['mode_profile_id'] as string) ?? null,
      resolvedMode: row['resolved_mode'] as 'fast' | 'deep_work' | 'analyst' | 'auto' | 'custom',
      policySnapshotId: (row['policy_snapshot_id'] as string) ?? null,
      status: row['status'] as MissionRunRow['status'],
      stateVersion: row['state_version'] as number,
      lastEventSequence: Number(row['last_event_sequence']),
      waitingFromStatus: (row['waiting_from_status'] as MissionRunRow['waitingFromStatus']) ?? null,
      currentQuestionSetId: (row['current_question_set_id'] as string) ?? null,
      currentPlanRevisionId: (row['current_plan_revision_id'] as string) ?? null,
      approvedPlanRevisionId: (row['approved_plan_revision_id'] as string) ?? null,
      partialResultPolicy: row['partial_result_policy'] as 'require_all' | 'best_effort',
      availableAt: (row['available_at'] as Date) ?? null,
      leaseOwner: (row['lease_owner'] as string) ?? null,
      leaseToken: (row['lease_token'] as string) ?? null,
      leaseExpiresAt: (row['lease_expires_at'] as Date) ?? null,
      heartbeatAt: (row['heartbeat_at'] as Date) ?? null,
      attemptCount: row['attempt_count'] as number,
      providerCallCount: row['provider_call_count'] as number,
      descendantCount: row['descendant_count'] as number,
      inputTokens: row['input_tokens'] as number,
      outputTokens: row['output_tokens'] as number,
      outputBytes: row['output_bytes'] as number,
      actualCostCents: row['actual_cost_cents'] as number,
      cancelRequestedAt: (row['cancel_requested_at'] as Date) ?? null,
      cancelRequestedBy: (row['cancel_requested_by'] as string) ?? null,
      cancellationDeadlineAt: (row['cancellation_deadline_at'] as Date) ?? null,
      failureCategory: (row['failure_category'] as string) ?? null,
      failureCode: (row['failure_code'] as string) ?? null,
      safeErrorMessage: (row['safe_error_message'] as string) ?? null,
      resultCompleteness: (row['result_completeness'] as 'full' | 'partial') ?? null,
      startedAt: (row['started_at'] as Date) ?? null,
      terminalAt: (row['terminal_at'] as Date) ?? null,
      createdAt: row['created_at'] as Date,
      updatedAt: row['updated_at'] as Date,
    };
  }

  // -- internal: decrypt request envelope -----------------------------------

  private decryptRequest(run: RunRow): string {
    try {
      if (run.requestEnvelope) {
        const envelope = decryptEnvelope(run.requestEnvelope);
        return (envelope.text as string) ?? '';
      }
      return '';
    } catch {
      return '';
    }
  }

  // -- internal: terminalize the run on planner failure ----------------------

  private async terminalizeFailure(
    claim: Claim,
    run: RunRow,
    failure: { category: PlannerFailureCategory; code: string; safeMessage: string },
  ): Promise<void> {
    const now = this.now();
    const schema = this.db.schema;

    const failureCategory = this.mapFailureCategory(failure.category);

    try {
      await this.db.drizzle.transaction(async (tx) => {
        // Verify lease under lock.
        const rows = (await tx.execute(sql`
          SELECT "state_version", "last_event_sequence", "cancel_requested_at", "terminal_at"
          FROM "mission_runs"
          WHERE "id" = ${run.id} AND "lease_token" = ${claim.leaseToken}
          FOR UPDATE
        `)) as unknown as Array<Record<string, unknown>>;

        if (!rows[0]) {
          return;
        } // Lease lost — nothing to do.
        const row = rows[0];
        if (row['cancel_requested_at'] !== null || row['terminal_at'] !== null) {
          return;
        }

        const currentVersion = row['state_version'] as number;
        const currentSeq = Number(row['last_event_sequence']);
        const seq = currentSeq + 1;

        await tx
          .update(schema.missionRuns)
          .set({
            status: 'failed',
            failureCategory,
            failureCode: failure.code,
            safeErrorMessage: failure.safeMessage,
            terminalAt: now,
            stateVersion: currentVersion + 1,
            lastEventSequence: seq,
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            availableAt: null,
            updatedAt: now,
          })
          .where(eq(schema.missionRuns.id, run.id));

        await tx.insert(schema.runEvents).values({
          companyId: run.companyId,
          projectId: run.projectId,
          runId: run.id,
          sequence: seq,
          type: 'run.failed',
          schemaVersion: 1,
          payload: {
            category: failureCategory,
            code: failure.code,
            safeMessage: failure.safeMessage,
          },
          actorType: 'system',
          actorId: claim.leaseOwner,
          traceId: null,
          occurredAt: now,
        });
      });
    } catch (err) {
      logger.warn(
        { runId: run.id, code: failure.code, err },
        'PlannerService: failed to terminalize run after planner failure',
      );
    }
  }

  private mapFailureCategory(category: PlannerFailureCategory): string {
    switch (category) {
      case 'provider_transient':
        return 'provider_transient';
      case 'provider_permanent':
        return 'provider_permanent';
      case 'timeout':
        return 'limit';
      case 'validation':
        return 'validation';
      case 'internal':
        return 'internal';
      default:
        return 'internal';
    }
  }
}

type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

export { type PlanPublicationFailpoint };
