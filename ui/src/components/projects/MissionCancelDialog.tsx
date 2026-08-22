import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Ban } from 'lucide-react';
import type { MissionRunSummary } from '@/lib/api';

/** Generate a stable random idempotency key for a logical confirmation. */
function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Determine whether a command error is recoverable (the user may resubmit
 * the same logical cancellation, reusing the same idempotency key) versus
 * terminal/handled elsewhere. A stale-version (`412 RUN_VERSION_MISMATCH`)
 * or a network failure is recoverable: the reason must be preserved and the
 * dialog kept open for the user to refresh and retry (VAL-RUN-038).
 */
export function isRecoverableCancelError(error: unknown): boolean {
  if (!error) {
    return false;
  }
  // Structured API error with a status / body code
  const status = (error as { status?: number }).status;
  const code = (error as { body?: { code?: string } }).body?.code;
  if (status === 412 || code === 'RUN_VERSION_MISMATCH') {
    return true;
  }
  // Network failure (no status — fetch threw before a response)
  if (status === undefined && code === undefined) {
    return true;
  }
  return false;
}

/**
 * Produce a user-safe, actionable message for any cancel error category.
 * Every error category — including non-recoverable 4xx (400/401/403/404/
 * 409/422/428) — is surfaced to the user with focus management, not only
 * recoverable errors (Normative Boundary 4 / VAL-RUN-038 / VAL-RUN-130).
 * The message never includes credentials, raw provider bodies, prompts, or
 * stack traces; it conveys only a safe status/code-derived explanation.
 */
export function describeCancelError(error: unknown): string {
  if (!error) {
    return 'Cancellation could not be applied.';
  }
  const status = (error as { status?: number }).status;
  const code = (error as { body?: { code?: string } }).body?.code;
  const safeCode = code ?? 'ERROR';
  // Recoverable: stale version or network failure (VAL-RUN-038).
  if (status === 412 || code === 'RUN_VERSION_MISMATCH') {
    return 'Cancellation could not be applied right now. The Mission may have changed or the connection failed. Your reason is preserved — refresh and try again.';
  }
  if (status === undefined && code === undefined) {
    return 'Cancellation could not be applied right now. The connection failed. Your reason is preserved — refresh and try again.';
  }
  // Non-recoverable categories: surface a safe, actionable message that
  // includes the stable error code so the user can act on it.
  const messages: Record<number, string> = {
    400: `The cancellation request was rejected (${code ?? 'VALIDATION_ERROR'}). Check your reason and try again.`,
    422: `The cancellation request was rejected (${code ?? 'VALIDATION_ERROR'}). Check your reason and try again.`,
    401: `You are not signed in (${code ?? 'UNAUTHENTICATED'}). Sign in and try again.`,
    403: `You don't have permission to cancel this Mission (${code ?? 'INSUFFICIENT_PERMISSION'}).`,
    404: `This Mission could not be found (${code ?? 'RUN_NOT_FOUND'}). It may have been removed.`,
    409: `This Mission can no longer be cancelled (${code ?? 'INVALID_RUN_STATE'}). It may have already finished.`,
    428: `The Mission state could not be verified (${code ?? 'PRECONDITION_REQUIRED'}). Refresh and try again.`,
  };
  return messages[status ?? -1] ?? `Cancellation could not be applied (${safeCode}).`;
}

/**
 * Accessible cancellation confirmation dialog for a Mission run.
 *
 * Cancellation is a destructive action that requires explicit confirmation
 * (VAL-RUN-036). Activating the originating Cancel control opens this
 * dialog; no cancel command is issued until the user confirms. A safe
 * "Keep running" control backs out without changing run state (VAL-RUN-037).
 *
 * The dialog uses a native `<dialog>` element so the browser handles the
 * focus trap and restores focus to the originating control on close
 * (VAL-RUN-090). The dialog names the affected Mission (run ID).
 *
 * Submission is self-contained: `onSubmit` returns a promise that resolves
 * on success and rejects on error. On a recoverable error (stale version or
 * network failure), the typed reason is preserved and an accessible
 * `role="alert"` error is shown so the user can refresh and resubmit
 * (VAL-RUN-038). The same idempotency key is reused across the recoverable
 * retry so duplicate/retry submissions are idempotent (VAL-RUN-039,
 * VAL-RUN-057). On success the dialog closes and the authoritative snapshot
 * refetch reveals `cancellation requested` → `cancelled` (VAL-RUN-035).
 *
 * While a request is pending, the confirm control is disabled so rapid
 * repeated activation produces a single command (VAL-RUN-057).
 *
 * Accessibility:
 * - Fully keyboard operable: native dialog focuses the first control on
 *   open and returns focus to the trigger on close (VAL-RUN-091, VAL-RUN-090).
 * - Status conveyed with text/icon, never color alone (VAL-RUN-092,
 *   VAL-RUN-111). Disabled states expose `aria-disabled`.
 * - Motion is removed under `prefers-reduced-motion`.
 */
export function MissionCancelDialog({
  run,
  open,
  onClose,
  onSubmit,
  ifMatch,
}: {
  run: MissionRunSummary;
  open: boolean;
  onClose: () => void;
  /** Submit the cancellation. Resolves on success; rejects on error so the
   * dialog can preserve the reason and show a recoverable error. */
  onSubmit: (args: { reason: string; idempotencyKey: string; ifMatch?: number }) => Promise<void>;
  /** The authoritative snapshot's `stateVersion`, forwarded as the strong
   * quoted `If-Match` ETag so revision-sensitive cancel requests are
   * protected against stale-version overwrites (Normative Boundary 4 /
   * VAL-RUN-055). When undefined (snapshot still loading), no If-Match is
   * sent. */
  ifMatch?: number;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const reducedMotion = useReduction();

  const [reason, setReason] = useState('');
  // Stable idempotency key for the current confirmation flow. Regenerated
  // when the dialog opens fresh; reused across recoverable retries.
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<unknown>(null);

  // Open/close the native dialog. Regenerate the idempotency key on open so
  // each distinct confirmation flow has its own key.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      setIdempotencyKey((prev) => prev || makeIdempotencyKey());
      setSubmitError(null);
      dialog.showModal();
      // Move focus to the reason field (user-triggered → useful focus).
      window.setTimeout(() => reasonRef.current?.focus(), 0);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // Close the dialog if the run became terminal while it was open (e.g.
  // cancellation was applied by another surface). The authoritative snapshot
  // drives this; the browser never infers it.
  useEffect(() => {
    const terminal = ['completed', 'failed', 'cancelled'].includes(run.status);
    if (open && terminal) {
      onClose();
    }
  }, [open, run.status, onClose]);

  const handleDismiss = () => {
    // A clean back-out clears the in-progress reason so the next flow starts
    // fresh; the run state is untouched (VAL-RUN-037).
    setReason('');
    setIdempotencyKey('');
    setSubmitError(null);
    onClose();
  };

  const handleConfirm = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || submitting) {
      return;
    }
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit({ reason: trimmed, idempotencyKey, ifMatch });
      // Success: clear and close. The authoritative snapshot refetch
      // reveals the cancellation state (VAL-RUN-035).
      setReason('');
      setIdempotencyKey('');
      onClose();
    } catch (e) {
      setSubmitError(e);
      // Move focus to the accessible error so it is announced and the
      // user is not lost to the document body (VAL-RUN-090).
      window.setTimeout(() => errorRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  };

  // Surface every error category to the user with focus management, not
  // only recoverable errors (Normative Boundary 4 / VAL-RUN-130). The
  // message distinguishes recoverable (reason preserved, retry) from
  // non-recoverable (safe actionable error with code/status).
  const showError = !!submitError;
  const errorMessage = showError ? describeCancelError(submitError) : '';
  const trimmedReason = reason.trim();
  const canConfirm = trimmedReason.length >= 1 && !submitting;

  // When closed, render nothing so the (hidden) native <dialog> content does
  // not remain in the DOM and interfere with text queries or focus order.
  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="m-auto max-h-[85vh] w-full max-w-[calc(100vw-2rem)] rounded-2xl border border-error/20 bg-surface p-0 text-text-primary shadow-2xl shadow-black/70 sm:max-w-md"
      onClose={handleDismiss}
    >
      <div className="p-6">
        <div className="mb-4 flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-error" aria-hidden="true" />
          <div>
            <h2 id={titleId} className="text-base font-semibold font-display text-text-primary">
              Cancel Mission
            </h2>
            <p id={descId} className="mt-1 text-sm text-text-secondary">
              You are about to cancel Mission{' '}
              <span className="font-medium text-text-primary break-all">{run.id}</span>. The run
              will stop at the next cancellation checkpoint.
            </p>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleConfirm();
          }}
        >
          <div className="mb-4">
            <label
              htmlFor="cancel-reason"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              Reason <span className="text-text-muted">(required)</span>
            </label>
            <textarea
              ref={reasonRef}
              id="cancel-reason"
              name="reason"
              aria-label="Reason"
              aria-required="true"
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              className="w-full resize-y rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-60"
              placeholder="Why should this Mission be cancelled?"
            />
            <p className="mt-1 text-xs text-text-muted">{trimmedReason.length}/2000 characters</p>
          </div>

          {showError && (
            <p
              ref={(el) => {
                errorRef.current = el;
                if (el) {
                  el.tabIndex = -1;
                }
              }}
              role="alert"
              tabIndex={-1}
              className="mb-4 rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-sm text-error focus-visible:outline-none"
            >
              {errorMessage}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={handleDismiss}
              disabled={submitting}
              aria-label="Keep running"
              className="rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
            >
              Keep running
            </button>
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={!canConfirm}
              aria-disabled={!canConfirm ? 'true' : undefined}
              aria-label="Confirm cancellation"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-error/30 bg-error/15 px-4 py-2 text-sm font-semibold text-error transition-colors hover:bg-error/25 focus-visible:ring-2 focus-visible:ring-error/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
            >
              <Ban
                className={reducedMotion ? 'h-4 w-4' : 'h-4 w-4 motion-safe:animate-pulse'}
                aria-hidden="true"
              />
              {submitting ? 'Cancelling…' : 'Confirm cancellation'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

/** Detect `prefers-reduced-motion` without a layout effect warning. */
function useReduction(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener?.('change', update);
    return () => mq.removeEventListener?.('change', update);
  }, []);
  return reduced;
}
