import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, Ban, RefreshCw } from 'lucide-react';
import { useCancelMissionRun, useMissionRunSnapshot } from '@/lib/hooks';

/**
 * MissionSubtreeCancelDialog — consequence-aware confirmation for direct
 * cancellation of a child subtree (VAL-SUB-096, VAL-RUN-109, VAL-SUB-083).
 *
 * Cancellation of a child uses the scoped Mission cancel endpoint on the
 * child run id; the server recursively requests cancellation for that
 * subtree and yields one terminal child outcome (VAL-SUB-096). The dialog
 * names the affected child and states the consequence ("its descendants
 * will be cancelled").
 *
 * The current child `state_version` is forwarded as the strong quoted
 * `If-Match` ETag so a stale child action is rejected by the server
 * (VAL-SUB-083). A stale-version (`412 RUN_VERSION_MISMATCH`) or network
 * failure is recoverable: the typed reason is preserved and an accessible
 * `role="alert"` with a Refresh control is shown so the user can refresh
 * and resubmit the identical command (VAL-SUB-083). The same idempotency
 * key is reused across the recoverable retry so duplicate/retry
 * submissions are idempotent (Normative Boundary 2).
 *
 * While a request is pending, the confirm control is disabled so rapid
 * repeated activation produces a single command (VAL-SUB-096).
 *
 * Accessibility:
 * - Native `<dialog>` handles the focus trap and restores focus to the
 *   originating control on close (VAL-RUN-090).
 * - Status conveyed with text/icon, never color alone.
 * - Motion is removed under `prefers-reduced-motion`.
 */
export function MissionSubtreeCancelDialog({
  companyId,
  projectId,
  runId,
  childTitle,
  open,
  onClose,
  onRefreshChild,
}: {
  companyId: string;
  projectId: string;
  /** The child run id to cancel (the subtree root). */
  runId: string;
  childTitle: string;
  open: boolean;
  onClose: () => void;
  /** Refresh the child snapshot after a stale-version error. */
  onRefreshChild: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const reducedMotion = useReduction();

  const snapshotQuery = useMissionRunSnapshot(companyId, projectId, runId);
  const childStateVersion = snapshotQuery.data?.stateVersion;
  const cancelMutation = useCancelMissionRun(companyId, projectId, runId);

  const [reason, setReason] = useState('');
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorKind, setErrorKind] = useState<'stale' | 'network' | 'other' | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      setIdempotencyKey((prev) => prev || makeIdempotencyKey());
      setErrorKind(null);
      setErrorMessage('');
      dialog.showModal();
      window.setTimeout(() => reasonRef.current?.focus(), 0);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const handleDismiss = () => {
    setReason('');
    setIdempotencyKey('');
    setErrorKind(null);
    setErrorMessage('');
    onClose();
  };

  const handleRefreshAfterStale = () => {
    onRefreshChild();
    setErrorKind(null);
    setErrorMessage('');
  };

  const handleConfirm = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < 1 || submitting) {
      return;
    }
    setErrorKind(null);
    setErrorMessage('');
    setSubmitting(true);
    const key = idempotencyKey || makeIdempotencyKey();
    setIdempotencyKey(key);
    try {
      await cancelMutation.mutateAsync({
        reason: trimmed,
        idempotencyKey: key,
        ifMatch: childStateVersion,
      });
      setReason('');
      setIdempotencyKey('');
      onClose();
    } catch (err) {
      const apiErr = err as { status?: number; body?: { code?: string } };
      const status = apiErr?.status;
      const code = apiErr?.body?.code;
      if (status === 412 || code === 'RUN_VERSION_MISMATCH') {
        setErrorKind('stale');
        setErrorMessage(
          'The child may have changed or the connection failed. Your reason is preserved — refresh and try again.',
        );
      } else if (status === undefined && code === undefined) {
        setErrorKind('network');
        setErrorMessage(
          'Cancellation could not be applied right now. The connection failed. Your reason is preserved — try again.',
        );
      } else {
        setErrorKind('other');
        setErrorMessage(describeOtherError(status, code));
      }
      window.setTimeout(() => errorRef.current?.focus(), 0);
    } finally {
      setSubmitting(false);
    }
  };

  const trimmedReason = reason.trim();
  const canConfirm = trimmedReason.length >= 1 && !submitting;

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
              Cancel subtree
            </h2>
            <p id={descId} className="mt-1 text-sm text-text-secondary">
              You are about to cancel{' '}
              <span className="font-medium text-text-primary">{childTitle}</span> (run{' '}
              <span className="font-mono break-all text-text-primary">{runId}</span>) and its
              descendants will be cancelled. The subtree will stop at the next cancellation
              checkpoint.
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
              htmlFor="subtree-cancel-reason"
              className="mb-1 block text-xs font-medium text-text-secondary"
            >
              Reason <span className="text-text-muted">(required)</span>
            </label>
            <textarea
              ref={reasonRef}
              id="subtree-cancel-reason"
              name="reason"
              aria-label="Reason"
              aria-required="true"
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={submitting}
              className="w-full resize-y rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-60"
              placeholder="Why should this subtree be cancelled?"
            />
            <p className="mt-1 text-xs text-text-muted">{trimmedReason.length}/2000 characters</p>
          </div>

          {errorKind && (
            <div className="mb-4">
              <p
                ref={(el) => {
                  errorRef.current = el;
                  if (el) {
                    el.tabIndex = -1;
                  }
                }}
                role="alert"
                tabIndex={-1}
                className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-sm text-error focus-visible:outline-none"
              >
                {errorMessage}
              </p>
              {errorKind === 'stale' && (
                <button
                  type="button"
                  onClick={handleRefreshAfterStale}
                  aria-label="Refresh child snapshot"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-warning/40 focus-visible:outline-none motion-reduce:transition-none"
                >
                  <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                  Refresh
                </button>
              )}
            </div>
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

/** Generate a stable random idempotency key for a logical confirmation. */
function makeIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `subtree-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Safe, actionable message for a non-recoverable cancellation error. */
function describeOtherError(status: number | undefined, code: string | undefined): string {
  const messages: Record<number, string> = {
    400: `The cancellation request was rejected (${code ?? 'VALIDATION_ERROR'}). Check your reason and try again.`,
    422: `The cancellation request was rejected (${code ?? 'VALIDATION_ERROR'}). Check your reason and try again.`,
    401: `You are not signed in (${code ?? 'UNAUTHENTICATED'}). Sign in and try again.`,
    403: `You don't have permission to cancel this subtree (${code ?? 'INSUFFICIENT_PERMISSION'}).`,
    404: `This child could not be found (${code ?? 'RUN_NOT_FOUND'}). It may have been removed.`,
    409: `This subtree can no longer be cancelled (${code ?? 'INVALID_RUN_STATE'}). It may have already finished.`,
    428: `The child state could not be verified (${code ?? 'PRECONDITION_REQUIRED'}). Refresh and try again.`,
  };
  return messages[status ?? -1] ?? `Cancellation could not be applied (${code ?? 'ERROR'}).`;
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
