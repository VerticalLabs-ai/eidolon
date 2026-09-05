import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import {
  encryptReason,
  redactCanaries,
  normalizeReason,
  validateReason,
} from './reason-security.js';
import type { PlanContent } from './plan-schema.js';
import { BudgetService } from './budget.js';
import { normalizeToolAlias, isResearchTool } from './research-tools.js';

/**
 * Canonical hash/revision-bound plan decision commands and idempotency.
 *
 * (VAL-PLAN-029, 030, 043, 044, 046, 047, 095, 096, 118, 128)
 *
 * This module owns the in-transaction decision logic for `plan.approve`,
 * `plan.reject`, and `plan.revision_request`. It is called from within the
 * locked transaction in `MissionCommandService.submit` after the run lock is
 * acquired and the state version is verified.
 *
 * Deterministic error precedence (VAL-PLAN-128):
 *  1. authentication/company/project/resource scope and feature policy
 *     → handled by route middleware + loadRun (404)
 *  2. exact idempotency replay or key conflict
 *     → handled by submit's idempotency lookup
 *  3. required/current run ETag
 *     → 428 PRECONDITION_REQUIRED (missing), 412 RUN_VERSION_MISMATCH (stale)
 *     → handled by submit (pre-tx 428, in-tx 412)
 *  4. legal run state
 *     → 409 INVALID_RUN_STATE (must be awaiting_approval)
 *  5. current same-run revision identity
 *     → 409 PLAN_REVISION_NOT_CURRENT
 *  6. current content hash
 *     → 409 PLAN_HASH_MISMATCH (only for the current same-run revision)
 *  7. live permission/policy/budget revalidation
 *     → deny-only: can only reject, never broaden
 *
 * Foreign revision IDs are 404, stale ETag is 412, stale same-run revision is
 * 409 PLAN_REVISION_NOT_CURRENT, and PLAN_HASH_MISMATCH applies only to the
 * current same-run revision.
 *
 * The plan content is immutable (stored in run_plan_revisions). A live policy
 * change cannot alter the proposed plan content or hash (VAL-PLAN-095). At
 * approval time, the system revalidates the plan against the current live
 * policy in a deny-only fashion: if a tool, domain, or budget is no longer
 * permitted, the approval fails with a policy-specific error requiring
 * replanning (VAL-PLAN-118).
 *
 * Decision errors never leak secrets: feedback/reason text is canary-redacted
 * and encrypted at rest; API responses, events, and payloads contain no
 * credentials, headers, prompts, or provider bodies (VAL-PLAN-096).
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

/** Terminal lifecycle statuses (VAL-RUN-117). */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Body shape for plan.approve. */
export interface PlanApproveBody {
  revisionId: string;
  contentHash: string;
}

/** Body shape for plan.reject. */
export interface PlanRejectBody {
  revisionId: string;
  contentHash: string;
  reason: string;
  /** When 'revise', the run returns to planning instead of being cancelled. */
  disposition?: 'revise';
  /** Feedback for revise disposition (required when disposition is 'revise'). */
  feedback?: string;
}

/** Body shape for plan.revision_request. */
export interface PlanRevisionRequestBody {
  revisionId: string;
  contentHash: string;
  feedback: string;
}

/** Result of a plan decision. */
export interface PlanDecisionResult {
  statusCode: number;
  /** New run state version (ETag). */
  stateVersion: number;
  /** Latest event sequence after the decision. */
  lastEventSequence: number;
  /** The decision that was applied. */
  decision: 'approved' | 'rejected' | 'revision_requested';
}

export interface PlanDecisionDeps {
  clock?: () => Date;
  /**
   * Test-only failpoint hook (VAL-PLAN-107). When set, the decision methods
   * call this function at each named checkpoint. Throwing aborts the
   * transaction, simulating a fault between internal writes. Production
   * code never sets this field; only the nonproduction test harness does.
   */
  failpointHook?: (point: PlanDecisionFailpoint) => void;
}

/**
 * Failpoint checkpoints for plan decision methods (VAL-PLAN-107).
 * Throwing at any checkpoint aborts the caller's transaction, proving
 * that failures after each internal write leave no partial state.
 */
export type PlanDecisionFailpoint =
  | 'approve_after_earmark'
  | 'approve_after_approval_resolved'
  | 'approve_after_binding_set'
  | 'approve_after_revision_status'
  | 'approve_after_run_queued'
  | 'approve_after_event'
  | 'reject_after_approval_resolved'
  | 'reject_after_binding_set'
  | 'reject_after_revision_status'
  | 'reject_after_rejected_event'
  | 'reject_cancel_after_run_cancelled'
  | 'reject_cancel_after_cancelled_event'
  | 'reject_revise_after_revision_requested_event'
  | 'revision_after_supersede'
  | 'revision_after_approval_resolved'
  | 'revision_after_run_planning'
  | 'revision_after_event';

/**
 * Sentinel thrown inside the transaction when a domain-specific plan error
 * is detected. The caller (submit) catches it and records a rejected
 * command row, then re-throws the original AppError.
 */
export class PlanDecisionError extends Error {
  constructor(readonly error: AppError) {
    super('Plan decision domain error');
    this.name = 'PlanDecisionError';
  }
}

export class PlanDecisionService {
  constructor(
    private db: DbInstance,
    private deps: PlanDecisionDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  // -- approve --------------------------------------------------------------

  /**
   * Apply a `plan.approve` command within the locked transaction.
   *
   * The run row is already locked and the state version has been verified
   * by the caller. This method:
   *  4. Checks the run is in `awaiting_approval` (409 INVALID_RUN_STATE).
   *  5. Checks the revision ID matches the run's current revision
   *     (409 PLAN_REVISION_NOT_CURRENT).
   *  6. Checks the content hash matches the revision's hash
   *     (409 PLAN_HASH_MISMATCH).
   *  7. Revalidates the plan against the current live policy (deny-only).
   *  Then applies: resolves the approval as approved, sets the binding
   *  decision, sets `approvedPlanRevisionId`, transitions to `queued`,
   *  and appends the `plan.approved` event.
   */
  async applyApprove(
    tx: Tx,
    run: MissionRunRow,
    body: PlanApproveBody,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    traceId: string | null,
  ): Promise<PlanDecisionResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Step 4: legal run state.
    if (run.status !== 'awaiting_approval') {
      throw new PlanDecisionError(
        new AppError(
          409,
          'INVALID_RUN_STATE',
          'Plan approval is only allowed from awaiting_approval',
        ),
      );
    }

    // Step 5: current same-run revision identity.
    const currentRevisionId = run.currentPlanRevisionId;
    if (!currentRevisionId) {
      throw new PlanDecisionError(
        new AppError(409, 'PLAN_REVISION_NOT_CURRENT', 'No current plan revision to approve'),
      );
    }
    if (body.revisionId !== currentRevisionId) {
      throw new PlanDecisionError(
        new AppError(
          409,
          'PLAN_REVISION_NOT_CURRENT',
          'Revision ID does not match the current plan revision',
        ),
      );
    }

    // Load the revision row (scoped to company).
    const [revision] = await tx
      .select()
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, run.companyId),
          eq(schema.runPlanRevisions.id, body.revisionId),
        ),
      )
      .limit(1);
    if (!revision) {
      throw new PlanDecisionError(
        new AppError(404, 'PLAN_REVISION_NOT_CURRENT', 'Plan revision not found'),
      );
    }

    // Step 6: current content hash.
    if (body.contentHash !== revision.contentHash) {
      throw new PlanDecisionError(
        new AppError(409, 'PLAN_HASH_MISMATCH', 'Content hash does not match the current revision'),
      );
    }

    const plan = revision.content as unknown as PlanContent;

    // Step 7a: live policy revalidation (deny-only) — tool allowlist check.
    await this.revalidatePolicyToolsForApproval(tx, run, plan);

    // Step 7b: atomic budget earmark from the existing root hold
    // (VAL-PLAN-094, VAL-PLAN-126). This never reacquires company funds;
    // it verifies the execution envelope fits the residual root hold and
    // earmarks it atomically. On failure, throws 409 BUDGET_UNAVAILABLE
    // and the gate remains open for a lower-budget revision.
    const budgetService = new BudgetService(this.db, { clock: () => now });
    const stepBudgetSum = plan.steps.reduce((acc, s) => acc + s.budgetCents, 0);
    const executionEnvelopeCents = stepBudgetSum + plan.synthesis.budgetCents;
    await budgetService.earmarkApproval(tx, run.id, executionEnvelopeCents);

    // Failpoint: simulate a fault after the earmark (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('approve_after_earmark');
    }

    // Apply the approval.
    // Find the binding for the current revision.
    const [binding] = await tx
      .select()
      .from(schema.runPlanApprovalBindings)
      .where(
        and(
          eq(schema.runPlanApprovalBindings.companyId, run.companyId),
          eq(schema.runPlanApprovalBindings.runId, run.id),
          eq(schema.runPlanApprovalBindings.planRevisionId, body.revisionId),
        ),
      )
      .limit(1);
    if (!binding) {
      throw new PlanDecisionError(
        new AppError(
          500,
          'INTERNAL_SERVER_ERROR',
          'Approval binding not found for current revision',
        ),
      );
    }

    // Resolve the approval row as approved.
    await tx
      .update(schema.approvals)
      .set({
        status: 'approved',
        resolvedByUserId: actorId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.approvals.id, binding.approvalId));

    // Failpoint: after approval resolution (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('approve_after_approval_resolved');
    }

    // Set the binding decision and mark it as the current execution
    // authorization. Any prior current authorization for this run is
    // cleared first so at most one binding carries the flag
    // (VAL-PLAN-102, VAL-PLAN-121). The historical approved binding
    // retains decision='approved' but loses current-authorization status.
    await tx
      .update(schema.runPlanApprovalBindings)
      .set({ isCurrentAuthorization: false })
      .where(
        and(
          eq(schema.runPlanApprovalBindings.companyId, run.companyId),
          eq(schema.runPlanApprovalBindings.runId, run.id),
          eq(schema.runPlanApprovalBindings.isCurrentAuthorization, true),
        ),
      );

    // Failpoint: after binding set (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('approve_after_binding_set');
    }

    await tx
      .update(schema.runPlanApprovalBindings)
      .set({
        decision: 'approved',
        decidingUserId: actorId,
        decidedAt: now,
        isCurrentAuthorization: true,
      })
      .where(eq(schema.runPlanApprovalBindings.id, binding.id));

    // Set the revision status to approved.
    await tx
      .update(schema.runPlanRevisions)
      .set({
        status: 'approved',
        decidedByUserId: actorId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.runPlanRevisions.id, body.revisionId));

    // Failpoint: after revision status (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('approve_after_revision_status');
    }

    // Transition the run to queued (claimable by a worker).
    const newVersion = run.stateVersion + 1;
    const seq = Number(run.lastEventSequence) + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'queued',
        approvedPlanRevisionId: body.revisionId,
        stateVersion: newVersion,
        lastEventSequence: seq,
        availableAt: now,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // Failpoint: after run queued (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('approve_after_run_queued');
    }

    // Append the plan.approved event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'plan.approved',
      schemaVersion: 1,
      payload: {
        revisionId: body.revisionId,
        revision: revision.revision,
        contentHash: revision.contentHash,
        approvalId: binding.approvalId,
        decidingUserId: actorId,
        executionEarmarkCents: executionEnvelopeCents,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Failpoint: after event append (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('approve_after_event');
    }

    return {
      statusCode: 200,
      stateVersion: newVersion,
      lastEventSequence: seq,
      decision: 'approved',
    };
  }

  // -- reject ---------------------------------------------------------------

  /**
   * Apply a `plan.reject` command within the locked transaction.
   *
   * Steps 4–6 are the same as approve. Then:
   * - If `disposition` is `'revise'`: resolves the approval as rejected,
   *   supersedes the revision, clears current/approved pointers, transitions
   *   to `planning`, and appends `plan.rejected` + `plan.revision_requested`
   *   events. Returns 200.
   * - If no `disposition` (default): resolves the approval as rejected,
   *   transitions the run to `cancelled` (terminal), and appends
   *   `plan.rejected` + `run.cancelled` events. Returns 200.
   */
  async applyReject(
    tx: Tx,
    run: MissionRunRow,
    body: PlanRejectBody,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    traceId: string | null,
  ): Promise<PlanDecisionResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Step 4: legal run state.
    if (run.status !== 'awaiting_approval') {
      throw new PlanDecisionError(
        new AppError(
          409,
          'INVALID_RUN_STATE',
          'Plan rejection is only allowed from awaiting_approval',
        ),
      );
    }

    // Step 5: current same-run revision identity.
    const currentRevisionId = run.currentPlanRevisionId;
    if (!currentRevisionId) {
      throw new PlanDecisionError(
        new AppError(409, 'PLAN_REVISION_NOT_CURRENT', 'No current plan revision to reject'),
      );
    }
    if (body.revisionId !== currentRevisionId) {
      throw new PlanDecisionError(
        new AppError(
          409,
          'PLAN_REVISION_NOT_CURRENT',
          'Revision ID does not match the current plan revision',
        ),
      );
    }

    // Load the revision row.
    const [revision] = await tx
      .select()
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, run.companyId),
          eq(schema.runPlanRevisions.id, body.revisionId),
        ),
      )
      .limit(1);
    if (!revision) {
      throw new PlanDecisionError(
        new AppError(404, 'PLAN_REVISION_NOT_CURRENT', 'Plan revision not found'),
      );
    }

    // Step 6: current content hash.
    if (body.contentHash !== revision.contentHash) {
      throw new PlanDecisionError(
        new AppError(409, 'PLAN_HASH_MISMATCH', 'Content hash does not match the current revision'),
      );
    }

    // If disposition is 'revise', validate feedback is provided before
    // applying any state change (fail fast, step 7 boundary).
    if (body.disposition === 'revise') {
      if (!body.feedback || body.feedback.trim().length === 0) {
        throw new PlanDecisionError(
          new AppError(
            400,
            'VALIDATION_ERROR',
            'Feedback is required when disposition is "revise"',
          ),
        );
      }
    }

    // Process the reason: NFC-normalize, validate, redact canaries.
    const processedReason = processFeedback(body.reason);

    // Find the binding.
    const [binding] = await tx
      .select()
      .from(schema.runPlanApprovalBindings)
      .where(
        and(
          eq(schema.runPlanApprovalBindings.companyId, run.companyId),
          eq(schema.runPlanApprovalBindings.runId, run.id),
          eq(schema.runPlanApprovalBindings.planRevisionId, body.revisionId),
        ),
      )
      .limit(1);
    if (!binding) {
      throw new PlanDecisionError(
        new AppError(
          500,
          'INTERNAL_SERVER_ERROR',
          'Approval binding not found for current revision',
        ),
      );
    }

    // Resolve the approval as rejected. The rejection reason is encrypted
    // at rest in the revision row's `feedback` column (set below) and is
    // NOT stored as plaintext in the approval's resolutionNote
    // (VAL-PLAN-116, VAL-PLAN-129). The approval row records only the
    // disposition metadata; exact text is field-level protected.
    await tx
      .update(schema.approvals)
      .set({
        status: 'rejected',
        resolvedByUserId: actorId,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.approvals.id, binding.approvalId));

    // Failpoint: after approval resolution (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('reject_after_approval_resolved');
    }

    // Set the binding decision to rejected.
    await tx
      .update(schema.runPlanApprovalBindings)
      .set({
        decision: 'rejected',
        decidingUserId: actorId,
        decidedAt: now,
      })
      .where(eq(schema.runPlanApprovalBindings.id, binding.id));

    // Failpoint: after binding set (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('reject_after_binding_set');
    }

    // Set the revision status to rejected.
    await tx
      .update(schema.runPlanRevisions)
      .set({
        status: 'rejected',
        decidedByUserId: actorId,
        decidedAt: now,
        feedback: encryptReason(processedReason.redacted),
        updatedAt: now,
      })
      .where(eq(schema.runPlanRevisions.id, body.revisionId));

    // Failpoint: after revision status (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('reject_after_revision_status');
    }

    const newVersion = run.stateVersion + 1;
    let seq = Number(run.lastEventSequence);

    // Append plan.rejected event.
    seq += 1;
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'plan.rejected',
      schemaVersion: 1,
      payload: {
        revisionId: body.revisionId,
        revision: revision.revision,
        contentHash: revision.contentHash,
        approvalId: binding.approvalId,
        decidingUserId: actorId,
        disposition: body.disposition ?? 'cancel',
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Failpoint: after rejected event (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('reject_after_rejected_event');
    }

    if (body.disposition === 'revise') {
      // Reject-with-revise: return to planning for a new proposal.
      // Feedback was already validated above (before any state change).
      const processedFeedback = processFeedback(body.feedback!);

      // Update the revision's feedback column to store the encrypted
      // revision feedback (not just the rejection reason) so the planner
      // and the scoped history endpoint can access it (VAL-PLAN-111,
      // VAL-PLAN-116, VAL-PLAN-129).
      await tx
        .update(schema.runPlanRevisions)
        .set({
          feedback: encryptReason(processedFeedback.redacted),
          updatedAt: now,
        })
        .where(eq(schema.runPlanRevisions.id, body.revisionId));

      // Clear the current revision pointer so the planner produces a
      // fresh proposal.
      seq += 1;
      await tx
        .update(schema.missionRuns)
        .set({
          status: 'planning',
          currentPlanRevisionId: null,
          stateVersion: newVersion + 1,
          lastEventSequence: seq,
          // Make the run claimable for planning work.
          availableAt: now,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, run.id));

      // Append plan.revision_requested event. Feedback text is NEVER
      // included in the broad event payload (VAL-PLAN-116, VAL-PLAN-129).
      // It is encrypted at rest in the revision row's `feedback` column
      // (set above when the revision status was set to rejected) and
      // exposed only through the scoped, role-gated plan history endpoint.
      await tx.insert(schema.runEvents).values({
        companyId: run.companyId,
        projectId: run.projectId,
        runId: run.id,
        sequence: seq,
        type: 'plan.revision_requested',
        schemaVersion: 1,
        payload: {
          revisionId: body.revisionId,
          revision: revision.revision,
          contentHash: revision.contentHash,
          decidingUserId: actorId,
          disposition: 'revise',
        },
        actorType,
        actorId,
        traceId,
        occurredAt: now,
      });

      // Failpoint: after revision_requested event (VAL-PLAN-107).
      if (this.deps.failpointHook) {
        this.deps.failpointHook('reject_revise_after_revision_requested_event');
      }

      return {
        statusCode: 200,
        stateVersion: newVersion + 1,
        lastEventSequence: seq,
        decision: 'rejected',
      };
    }

    // Default rejection: cancel the run (terminal).
    seq += 1;
    await tx
      .update(schema.missionRuns)
      .set({
        status: 'cancelled',
        currentPlanRevisionId: null,
        stateVersion: newVersion + 1,
        lastEventSequence: seq,
        terminalAt: now,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // Failpoint: after run cancelled (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('reject_cancel_after_run_cancelled');
    }

    // Append run.cancelled event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'run.cancelled',
      schemaVersion: 1,
      payload: {
        reason: 'plan_rejected',
        decidingUserId: actorId,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Failpoint: after cancelled event (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('reject_cancel_after_cancelled_event');
    }

    return {
      statusCode: 200,
      stateVersion: newVersion + 1,
      lastEventSequence: seq,
      decision: 'rejected',
    };
  }

  // -- revision_request -----------------------------------------------------

  /**
   * Apply a `plan.revision_request` command within the locked transaction.
   *
   * This is a member's ordinary revision request: it supersedes the current
   * revision without a rejection decision, resolves the approval as
   * cancelled (superseded_without_decision), clears current/approved
   * pointers, transitions to `planning`, and appends the
   * `plan.revision_requested` event (VAL-PLAN-037, 041).
   *
   * **Post-approval branching (VAL-PLAN-039, VAL-PLAN-101):** A revision
   * request is legal from `awaiting_approval` or, after approval, while
   * `queued` before any approved-step effect or child shell starts. A
   * queued revision atomically revokes execution eligibility: it clears
   * the run's `approved_plan_revision_id`, clears the current
   * authorization flag on the prior approved binding (the historical
   * decision remains readable), cancels the unresolved approval if any,
   * supersedes the approved revision, and returns the run to `planning`
   * for a fresh proposal and fresh approval.
   *
   * After any approved-step effect starts (`execution.started`,
   * `child.created`, `child.started`, `tool.started`, `synthesis.started`,
   * `artifact.committed`), revision returns 409
   * `EXECUTION_ALREADY_STARTED` and directs cancel/retry without changing
   * the original run (VAL-PLAN-101).
   *
   * Feedback is never included in the broad journal event payload
   * (VAL-PLAN-116). It is encrypted at rest in the revision row's
   * `feedback` column and exposed only through the scoped, role-gated plan
   * history endpoint (VAL-PLAN-111, VAL-PLAN-129).
   *
   * Steps 5–6 (revision identity and hash) are the same as approve.
   */
  async applyRevisionRequest(
    tx: Tx,
    run: MissionRunRow,
    body: PlanRevisionRequestBody,
    actorType: 'user' | 'agent' | 'system',
    actorId: string | null,
    traceId: string | null,
  ): Promise<PlanDecisionResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Step 4: legal run state. Revision is allowed from awaiting_approval
    // or, after approval, while queued before any approved-step effect
    // starts (VAL-PLAN-039, VAL-PLAN-101).
    const isAwaitingApproval = run.status === 'awaiting_approval';
    const isQueuedPostApproval = run.status === 'queued';
    if (!isAwaitingApproval && !isQueuedPostApproval) {
      // Non-awaiting, non-queued state. If the run is non-terminal and
      // execution has started (running, synthesizing with approved-step
      // effects), revision is rejected with EXECUTION_ALREADY_STARTED
      // (VAL-SUB-095, VAL-PLAN-101). Terminal states return
      // INVALID_RUN_STATE per the mutation matrix alreadyTerminalBehavior.
      if (!TERMINAL_STATUSES.has(run.status)) {
        const started = await this.hasApprovedStepEffectStarted(tx, run.companyId, run.id);
        if (started) {
          throw new PlanDecisionError(
            new AppError(
              409,
              'EXECUTION_ALREADY_STARTED',
              'Plan revision is not allowed after execution has started. Cancel and retry to start a new run.',
            ),
          );
        }
      }
      throw new PlanDecisionError(
        new AppError(
          409,
          'INVALID_RUN_STATE',
          'Plan revision request is only allowed from awaiting_approval or queued before execution starts',
        ),
      );
    }

    // Post-approval queued revision: verify no approved-step effect has
    // started (VAL-PLAN-101). If any forbidden event exists, revision is
    // rejected with EXECUTION_ALREADY_STARTED and the run is unchanged.
    if (isQueuedPostApproval) {
      const started = await this.hasApprovedStepEffectStarted(tx, run.companyId, run.id);
      if (started) {
        throw new PlanDecisionError(
          new AppError(
            409,
            'EXECUTION_ALREADY_STARTED',
            'Plan revision is not allowed after execution has started. Cancel and retry to start a new run.',
          ),
        );
      }
    }

    // Step 5: current same-run revision identity.
    const currentRevisionId = run.currentPlanRevisionId;
    if (!currentRevisionId) {
      throw new PlanDecisionError(
        new AppError(409, 'PLAN_REVISION_NOT_CURRENT', 'No current plan revision to revise'),
      );
    }
    if (body.revisionId !== currentRevisionId) {
      throw new PlanDecisionError(
        new AppError(
          409,
          'PLAN_REVISION_NOT_CURRENT',
          'Revision ID does not match the current plan revision',
        ),
      );
    }

    // Load the revision row.
    const [revision] = await tx
      .select()
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, run.companyId),
          eq(schema.runPlanRevisions.id, body.revisionId),
        ),
      )
      .limit(1);
    if (!revision) {
      throw new PlanDecisionError(
        new AppError(404, 'PLAN_REVISION_NOT_CURRENT', 'Plan revision not found'),
      );
    }

    // Step 6: current content hash.
    if (body.contentHash !== revision.contentHash) {
      throw new PlanDecisionError(
        new AppError(409, 'PLAN_HASH_MISMATCH', 'Content hash does not match the current revision'),
      );
    }

    // Process feedback: NFC-normalize, validate, redact canaries.
    const processedFeedback = processFeedback(body.feedback);

    // Supersede the current revision (without a rejection decision).
    await tx
      .update(schema.runPlanRevisions)
      .set({
        status: 'superseded',
        feedback: encryptReason(processedFeedback.redacted),
        updatedAt: now,
      })
      .where(eq(schema.runPlanRevisions.id, body.revisionId));

    // Failpoint: after supersede (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('revision_after_supersede');
    }

    // Find and resolve the binding's approval as cancelled
    // (superseded_without_decision per VAL-PLAN-121).
    const [binding] = await tx
      .select()
      .from(schema.runPlanApprovalBindings)
      .where(
        and(
          eq(schema.runPlanApprovalBindings.companyId, run.companyId),
          eq(schema.runPlanApprovalBindings.runId, run.id),
          eq(schema.runPlanApprovalBindings.planRevisionId, body.revisionId),
        ),
      )
      .limit(1);
    if (binding) {
      await tx
        .update(schema.approvals)
        .set({
          status: 'cancelled',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.approvals.id, binding.approvalId));
    }

    // Failpoint: after approval resolution (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('revision_after_approval_resolved');
    }

    // Post-approval queued revision: revoke execution eligibility
    // (VAL-PLAN-039, VAL-PLAN-101). Clear the current authorization flag
    // on any approved binding for this run and clear the run's approved
    // pointer. The historical approved binding remains readable but is no
    // longer the current execution authorization (VAL-PLAN-102).
    if (isQueuedPostApproval) {
      await tx
        .update(schema.runPlanApprovalBindings)
        .set({ isCurrentAuthorization: false })
        .where(
          and(
            eq(schema.runPlanApprovalBindings.companyId, run.companyId),
            eq(schema.runPlanApprovalBindings.runId, run.id),
            eq(schema.runPlanApprovalBindings.isCurrentAuthorization, true),
          ),
        );
    }

    // Transition the run to planning. Clear the current revision pointer
    // so the planner produces a fresh proposal. For post-approval queued
    // revision, also clear the approved pointer so no execution can start
    // until a fresh approval (VAL-PLAN-039, VAL-PLAN-101).
    const newVersion = run.stateVersion + 1;
    const seq = Number(run.lastEventSequence) + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'planning',
        currentPlanRevisionId: null,
        approvedPlanRevisionId: isQueuedPostApproval ? null : run.approvedPlanRevisionId,
        stateVersion: newVersion,
        lastEventSequence: seq,
        availableAt: now,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // Failpoint: after run transitioned to planning (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('revision_after_run_planning');
    }

    // Append the plan.revision_requested event. Feedback text is NEVER
    // included in the broad event payload (VAL-PLAN-116, VAL-PLAN-129).
    // It is encrypted at rest in the revision row and exposed only through
    // the scoped, role-gated plan history endpoint.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'plan.revision_requested',
      schemaVersion: 1,
      payload: {
        revisionId: body.revisionId,
        revision: revision.revision,
        contentHash: revision.contentHash,
        requestingUserId: actorId,
        postApproval: isQueuedPostApproval,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Failpoint: after event append (VAL-PLAN-107).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('revision_after_event');
    }

    return {
      statusCode: 202,
      stateVersion: newVersion,
      lastEventSequence: seq,
      decision: 'revision_requested',
    };
  }

  // -- root-deadline expiry while awaiting approval (VAL-PLAN-115) ---------

  /**
   * Terminalize a run whose root deadline has expired while in
   * `awaiting_approval` (VAL-PLAN-115). Delegates to the standalone
   * {@link terminalizeForApprovalDeadlineExpiry} module.
   *
   * Must be called inside a locked transaction where the run row is
   * already locked via `FOR UPDATE`.
   */
  async terminalizeForDeadlineExpiry(
    tx: Tx,
    run: MissionRunRow,
    opts: {
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
    } = {},
  ): Promise<{ terminalized: boolean; stateVersion: number; lastEventSequence: number }> {
    const { terminalizeForApprovalDeadlineExpiry } = await import('./plan-deadline-expiry.js');
    return terminalizeForApprovalDeadlineExpiry(
      this.db,
      tx,
      run,
      { clock: () => this.now() },
      opts,
    );
  }

  // -- post-approval effect detection (VAL-PLAN-101) ----------------------

  /**
   * Check whether any approved-step effect has started for a run. A
   * post-approval queued revision is legal only before any of these
   * events exist (VAL-PLAN-039, VAL-PLAN-101):
   * - `execution.started` — approved step execution began
   * - `child.created` / `child.started` — a child shell was created/started
   * - `tool.started` — an approved-step tool was invoked
   * - `synthesis.started` — synthesis began
   * - `artifact.committed` — an artifact was committed
   *
   * Returns true if any such event exists (scoped to company/run), false
   * otherwise. Called within the locked transaction so the result is
   * consistent with the run state under the lock.
   */
  private async hasApprovedStepEffectStarted(
    tx: Tx,
    companyId: string,
    runId: string,
  ): Promise<boolean> {
    const effectTypes = [
      'execution.started',
      'child.created',
      'child.started',
      'tool.started',
      'synthesis.started',
      'artifact.committed',
    ];
    const rows = (await tx.execute(sql`
      SELECT 1 FROM "run_events"
      WHERE "company_id" = ${companyId} AND "run_id" = ${runId}
        AND "type" IN (${sql.join(
          effectTypes.map((t) => sql`${t}`),
          sql`, `,
        )})
      LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;
    return rows.length > 0;
  }

  // -- policy revalidation (deny-only) --------------------------------------

  /**
   * Revalidate the plan's tools against the current live policy at approval
   * time (deny-only). This can only reject the approval, never broaden it
   * (VAL-PLAN-095, VAL-PLAN-118).
   *
   * Tool alias normalization (VAL-M1-001, VAL-M1-002, VAL-M1-005):
   * Before the exact-match check, each step's tool names are normalized to
   * their canonical form using the shared `RESEARCH_TOOL_TO_OPERATION` map.
   * Aliases like `web_search` are mapped to `research.search`. Canonical
   * names pass through unchanged (idempotent). Unknown tool names that are
   * neither canonical nor known aliases are rejected with a clear error.
   *
   * Research-policy bypass (VAL-M1-003, VAL-M1-004):
   * When the policy snapshot's `researchPolicy.access === 'allowed'`,
   * research tools (canonical or alias) are permitted even if they are not
   * in the snapshot's tool allowlist. This mirrors the existing bypass in
   * `agent-router.ts` and `ephemeral-router.ts`. When access is 'denied' or
   * absent, research tools must be in the allowlist or they are rejected.
   *
   * The budget validation is handled separately by `BudgetService.earmarkApproval`
   * which returns 409 BUDGET_UNAVAILABLE on failure (VAL-PLAN-094).
   *
   * The plan content hash is never changed by revalidation (VAL-PLAN-095).
   */
  private async revalidatePolicyToolsForApproval(
    tx: Tx,
    run: MissionRunRow,
    plan: PlanContent,
  ): Promise<void> {
    const schema = this.db.schema;

    const deny = (message: string): never => {
      throw new PlanDecisionError(new AppError(409, 'POLICY_UNSATISFIABLE', message));
    };
    if (!run.policySnapshotId) {
      deny('The run policy snapshot is missing.');
    }
    const [snapshot] = await tx
      .select()
      .from(schema.runPolicySnapshots)
      .where(eq(schema.runPolicySnapshots.id, run.policySnapshotId!))
      .limit(1);
    if (!snapshot) {
      deny('The run policy snapshot is missing.');
    }
    const [company] = await tx
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.id, run.companyId))
      .limit(1);
    if (!company) {
      deny('The company is no longer available.');
    }
    const governance = (
      company.settings as {
        missionPolicy?: {
          allowedTools?: string[];
          deniedTools?: string[];
          allowedProviders?: string[];
        };
      }
    ).missionPolicy;
    if (
      governance?.allowedProviders !== undefined &&
      !governance.allowedProviders.includes(snapshot.provider)
    ) {
      deny('The snapshotted provider is no longer permitted by company governance.');
    }
    const [agent] = run.initiatingAgentId
      ? await tx
          .select()
          .from(schema.agents)
          .where(
            and(
              eq(schema.agents.id, run.initiatingAgentId),
              eq(schema.agents.companyId, run.companyId),
            ),
          )
          .limit(1)
      : [];
    if (
      run.initiatingAgentId &&
      (!agent || ['terminated', 'paused', 'disabled'].includes(agent.status))
    ) {
      deny('The initiating agent is no longer active.');
    }
    const snapshotTools = new Set((snapshot.toolAllowlist ?? []).map(normalizeToolAlias));
    const liveTools = new Set((agent?.toolsEnabled ?? []).map(normalizeToolAlias));
    const companyAllowed = governance?.allowedTools?.map(normalizeToolAlias);
    const companyDenied = new Set((governance?.deniedTools ?? []).map(normalizeToolAlias));
    const researchAllowed = (snapshot.researchPolicy as { access?: string })?.access === 'allowed';
    for (const step of plan.steps) {
      for (const tool of step.toolAllowlist) {
        const canonical = normalizeToolAlias(tool);
        // A research policy is a distinct explicit grant, still narrowed by
        // current company governance. It never overrides a company deny.
        const researchGrant = isResearchTool(canonical) && researchAllowed;
        if (
          (!snapshotTools.has(canonical) && !researchGrant) ||
          (agent && !liveTools.has(canonical)) ||
          (companyAllowed !== undefined && !companyAllowed.includes(canonical)) ||
          companyDenied.has(canonical)
        ) {
          deny(
            `Plan step "${step.stepKey}" requires tool "${tool}" which is no longer permitted. Replan with permitted tools or cancel.`,
          );
        }
      }
    }

    // Budget validation is handled by `BudgetService.earmarkApproval`
    // which returns 409 BUDGET_UNAVAILABLE on failure (VAL-PLAN-094).
  }
}

// -- helpers ----------------------------------------------------------------

/** Result of processing feedback/reason text. */
interface ProcessedFeedback {
  /** Canary-redacted plaintext (for idempotency hash and event payload). */
  redacted: string;
  /** Whether canaries were found and redacted. */
  hadCanaries: boolean;
}

/**
 * Process feedback/reason text: NFC-normalize, validate length (1–2,000
 * code points), and redact credential/header canaries (VAL-PLAN-096).
 * Returns the redacted plaintext. Throws 400 VALIDATION_ERROR on length
 * violation.
 */
function processFeedback(raw: string): ProcessedFeedback {
  const normalized = normalizeReason(raw);
  validateReason(normalized);
  const { redacted, hadCanaries } = redactCanaries(normalized);
  // Re-validate after redaction in case it shortened below minimum.
  validateReason(redacted);
  return { redacted, hadCanaries };
}
