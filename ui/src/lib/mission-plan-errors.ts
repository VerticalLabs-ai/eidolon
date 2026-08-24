/**
 * Safe, actionable UI messages for Mission plan decision errors
 * (VAL-PLAN-092, VAL-PLAN-093).
 *
 * Every structured API error category returned by a plan decision
 * (approve/reject/revise) is mapped to a clear, actionable user-facing
 * message. Messages never include credentials, raw provider bodies, prompts,
 * stack traces, or retrieved content — only a safe status/code-derived
 * explanation. Non-recoverable categories surface the stable error code so
 * the user can act on it; recoverable categories (stale version or network
 * failure) tell the user their typed feedback/reason is preserved for
 * refresh and resubmission (VAL-PLAN-092).
 *
 * The mapping is shared by every decision surface so Project Work and
 * Approvals present identical safe messaging (VAL-PLAN-104).
 */

/**
 * Determine whether a plan decision error is recoverable: the user may
 * resubmit the same logical command, reusing the same idempotency key, and
 * the typed feedback/reason must be preserved (VAL-PLAN-092). A stale
 * run version (`412 RUN_VERSION_MISMATCH`) or a network failure (no HTTP
 * status — fetch threw before a response) is recoverable.
 */
export function isRecoverablePlanDecisionError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const status = (error as { status?: number }).status;
  const code = (error as { body?: { code?: string } }).body?.code;
  if (status === 412 || code === 'RUN_VERSION_MISMATCH') {
    return true;
  }
  if (status === undefined && code === undefined) {
    return true;
  }
  return false;
}

/**
 * Produce a user-safe, actionable message for any plan decision error
 * category (VAL-PLAN-093). Covers `VALIDATION_ERROR`, `INSUFFICIENT_PERMISSION`,
 * `INVALID_RUN_STATE`, `PLAN_HASH_MISMATCH`, `PLAN_REVISION_NOT_CURRENT`,
 * `RUN_VERSION_MISMATCH`, `PRECONDITION_REQUIRED`, `BUDGET_UNAVAILABLE`,
 * `FEATURE_NOT_AVAILABLE`, `RUN_NOT_FOUND`, `IDEMPOTENCY_KEY_REUSED`, and a
 * sanitized fallback for internal errors. The message never includes
 * credentials, raw provider bodies, prompts, stack traces, or retrieved
 * content.
 *
 * `intentNoun` is "feedback" or "reason" so the recoverable message names
 * the preserved field the user typed (VAL-PLAN-092).
 */
export function describePlanDecisionError(
  error: unknown,
  intentNoun: 'feedback' | 'reason' = 'feedback',
): string {
  if (!error) {
    return 'The decision could not be applied.';
  }
  const status = (error as { status?: number }).status;
  const code = (error as { body?: { code?: string } }).body?.code;
  const safeCode = code ?? 'ERROR';

  // Recoverable: stale version or network failure (VAL-PLAN-092).
  if (status === 412 || code === 'RUN_VERSION_MISMATCH') {
    return `The decision could not be applied right now. The Mission may have changed or the connection failed. Your ${intentNoun} is preserved — refresh and try again.`;
  }
  if (status === undefined && code === undefined) {
    return `The decision could not be applied right now. The connection failed. Your ${intentNoun} is preserved — refresh and try again.`;
  }

  // Stale revision: another session created a newer proposal; the user must
  // refresh to see the current revision before deciding (VAL-PLAN-045).
  if (code === 'PLAN_REVISION_NOT_CURRENT' || code === 'PLAN_HASH_MISMATCH') {
    return 'This plan is no longer the current proposal. Refresh to see the latest revision before deciding.';
  }

  // Non-recoverable categories: surface a safe, actionable message that
  // includes the stable error code so the user can act on it.
  const byCode: Record<string, string> = {
    VALIDATION_ERROR: `The decision was rejected because the input was invalid (${safeCode}). Check your ${intentNoun} and try again.`,
    ANSWER_VALIDATION_FAILED: `The decision was rejected because the input was invalid (${safeCode}). Check your ${intentNoun} and try again.`,
    INSUFFICIENT_PERMISSION: `You don't have permission to make this decision (${safeCode}). Only owners and admins can approve or reject plans.`,
    INVALID_RUN_STATE: `This Mission can no longer be decided in its current state (${safeCode}). It may have already advanced, been cancelled, or finished.`,
    PRECONDITION_REQUIRED: `The Mission state could not be verified (${safeCode}). Refresh and try again.`,
    BUDGET_UNAVAILABLE: `The Mission budget could not cover this decision (${safeCode}). Request a lower-budget revision or cancel and retry.`,
    FEATURE_NOT_AVAILABLE: `Mission decisions are not available for this company (${safeCode}).`,
    RUN_NOT_FOUND: `This Mission could not be found (${safeCode}). It may have been removed.`,
    IDEMPOTENCY_KEY_REUSED: `This decision conflicts with an earlier submission (${safeCode}). Refresh to see the current state.`,
    POLICY_UNSATISFIABLE: `The plan no longer satisfies current policy (${safeCode}). Request a revision or cancel and retry.`,
    EXECUTION_ALREADY_STARTED: `Execution has already started for this plan (${safeCode}). Revision is no longer possible — cancel and retry if needed.`,
    CURSOR_AHEAD: `The Mission state could not be verified (${safeCode}). Refresh and try again.`,
  };

  if (code && byCode[code]) {
    return byCode[code];
  }

  // Status-based fallback for codes not explicitly listed above.
  const byStatus: Record<number, string> = {
    400: `The decision was rejected because the input was invalid (${safeCode}). Check your ${intentNoun} and try again.`,
    401: `You are not signed in (${safeCode}). Sign in and try again.`,
    403: `You don't have permission to make this decision (${safeCode}). Only owners and admins can approve or reject plans.`,
    404: `This Mission could not be found (${safeCode}). It may have been removed.`,
    409: `This Mission can no longer be decided in its current state (${safeCode}). It may have already advanced, been cancelled, or finished.`,
    422: `The decision was rejected because the input was invalid (${safeCode}). Check your ${intentNoun} and try again.`,
    428: `The Mission state could not be verified (${safeCode}). Refresh and try again.`,
  };

  if (status && byStatus[status]) {
    return byStatus[status];
  }

  // Sanitized internal error fallback: never exposes provider bodies,
  // prompts, credentials, or stack traces.
  return `The decision could not be applied (${safeCode}). Try again, or refresh and retry.`;
}

/**
 * Whether a plan decision error indicates the proposal is no longer current
 * and the user must refresh before deciding again (VAL-PLAN-045). Distinct
 * from a generic stale run version: a stale revision specifically means
 * another session advanced the proposal, so the decision controls should
 * surface a refresh action rather than a retry of the same revision.
 */
export function isStaleRevisionError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  const code = (error as { body?: { code?: string } }).body?.code;
  return code === 'PLAN_REVISION_NOT_CURRENT' || code === 'PLAN_HASH_MISMATCH';
}
