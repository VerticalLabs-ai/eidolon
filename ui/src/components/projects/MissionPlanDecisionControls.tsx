import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, RefreshCw, SquarePen, XOctagon } from 'lucide-react';
import { useApproveMissionPlan, useRejectMissionPlan, useReviseMissionPlan } from '@/lib/hooks';
import {
  describePlanDecisionError,
  isRecoverablePlanDecisionError,
  isStaleRevisionError,
} from '@/lib/mission-plan-errors';
import { buildDraftKey, readDraft, writeDraft, clearDraft } from '@/lib/mission-drafts';
import type { MissionPlanRevision } from '@/lib/api';

/** The authenticated user's company role, used to gate decision controls
 *  (VAL-PLAN-055, VAL-PLAN-104). Only owners/admins may approve or reject;
 *  members may request revisions; viewers may not decide. Server RBAC is
 *  the authority — the UI hides/disables controls but never relies on that
 *  alone (VAL-PLAN-056). */
export type DecisionRole = 'owner' | 'admin' | 'member' | 'viewer' | 'unknown';

/** Generate a stable random idempotency key for a logical decision. */
function makeIdempotencyKey(kind: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Detect `prefers-reduced-motion` without a layout effect warning. */
function useReducedMotion(): boolean {
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

/**
 * Plan decision controls for a Mission awaiting approval.
 *
 * Renders Approve, Revise, and Reject controls bound to the exact current
 * plan revision ID and content hash, submitting through the canonical
 * `plan.approve` / `plan.revision_request` / `plan.reject` commands so
 * every actionable surface shares one command identity, RBAC, confirmation,
 * stale-state, validation, and attribution behavior (VAL-PLAN-104).
 *
 * Authority and safety invariants:
 * - The browser never advances decision state optimistically. Controls
 *   become non-actionable and an approved/rejected indicator appears only
 *   after the server applies the command (VAL-PLAN-042).
 * - Approve is a direct action (no confirmation — it is not destructive);
 *   Reject requires confirmation because its default disposition cancels
 *   the Mission (VAL-PLAN-040).
 * - Revise requires feedback; an empty/whitespace submission is blocked
 *   with a field-level validation error and focus moved to the field
 *   (VAL-PLAN-038).
 * - Double-click protection: every control disables while a decision is
 *   pending so rapid repeated activation produces a single command
 *   (VAL-PLAN-050).
 * - Recoverable errors (stale run version or network failure) preserve the
 *   typed feedback/reason for refresh and resubmission, reusing the same
 *   idempotency key (VAL-PLAN-092).
 * - Stale revision: if the rendered revision is no longer the current
 *   proposal (caller-reported or server-returned `PLAN_REVISION_NOT_CURRENT`
 *   / `PLAN_HASH_MISMATCH`), the controls are replaced by an accessible
 *   refresh message and no decision is implied (VAL-PLAN-045).
 * - Viewer denial: viewers see no actionable controls; members see
 *   approve/reject disabled with a safe reason and may revise; only
 *   owners/admins see all controls enabled (VAL-PLAN-055).
 * - Every error is surfaced through a `role="alert"` with a safe,
 *   actionable message and no secrets (VAL-PLAN-093).
 *
 * Accessibility:
 * - Revise/Reject open labelled native `<dialog>` modals that contain focus,
 *   announce errors, return focus to the originating control on dismissal,
 *   and move focus to the current status after success (VAL-PLAN-120).
 * - All controls are keyboard operable with visible focus.
 * - Status is conveyed with text and icons, never color alone.
 */
export function MissionPlanDecisionControls({
  companyId,
  projectId,
  runId,
  revision,
  stateVersion,
  role,
  principalId,
  /** Whether `revision` is still the run's current proposed revision. When
   *  false, the controls render a stale-revision refresh message instead of
   *  actionable controls (VAL-PLAN-045). */
  isCurrentRevision,
  /** Refresh the authoritative run snapshot + plan revision so the user
   *  sees the current proposal after a stale-revision error. */
  onRefresh,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  revision: MissionPlanRevision;
  stateVersion?: number;
  role: DecisionRole;
  principalId?: string;
  isCurrentRevision: boolean;
  onRefresh: () => void;
}) {
  const approveMutation = useApproveMissionPlan(companyId, projectId, runId);
  const reviseMutation = useReviseMissionPlan(companyId, projectId, runId);
  const rejectMutation = useRejectMissionPlan(companyId, projectId, runId);

  const [approveError, setApproveError] = useState<unknown>(null);
  const [staleRevision, setStaleRevision] = useState(false);
  const reducedMotion = useReducedMotion();

  // A decision is pending if any of the three mutations is in flight. Used
  // to disable all controls while one decision is submitting so a second
  // control cannot fire a conflicting command (VAL-PLAN-050).
  const anyPending =
    approveMutation.isPending || reviseMutation.isPending || rejectMutation.isPending;

  // Stable idempotency keys for the current logical approve flow. Retained
  // across recoverable retries so a lost response replays the identical
  // command (VAL-PLAN-092). Cleared on success.
  const [approveKey, setApproveKey] = useState('');

  const canApproveOrReject = role === 'owner' || role === 'admin';
  const canRevise = role === 'owner' || role === 'admin' || role === 'member';

  // If the caller reports the rendered revision is no longer current, surface
  // the stale-revision refresh message and no actionable controls
  // (VAL-PLAN-045).
  if (!isCurrentRevision || staleRevision) {
    return <StaleRevisionNotice onRefresh={onRefresh} />;
  }

  const handleApprove = async () => {
    if (anyPending) {
      return;
    }
    const key = approveKey || makeIdempotencyKey('approve');
    setApproveKey(key);
    setApproveError(null);
    try {
      await approveMutation.mutateAsync({
        planRevisionId: revision.id,
        contentHash: revision.contentHash,
        idempotencyKey: key,
        ifMatch: stateVersion,
      });
      setApproveKey('');
    } catch (err) {
      if (isStaleRevisionError(err)) {
        setStaleRevision(true);
      } else {
        setApproveError(err);
      }
    }
  };

  const handleRefreshAfterStale = () => {
    setStaleRevision(false);
    setApproveError(null);
    onRefresh();
  };

  return (
    <section
      aria-labelledby={`plan-decision-heading-${revision.id}`}
      data-testid="plan-decision-controls"
      className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 w-full max-w-full break-words overflow-hidden"
    >
      <h4
        id={`plan-decision-heading-${revision.id}`}
        className="text-sm font-semibold text-text-primary font-display mb-2"
      >
        Decision
      </h4>

      <p className="text-xs text-text-secondary mb-2.5 break-words">
        Approve to start execution, revise to request changes, or reject to cancel.
      </p>

      {/* Batched polite live region for meaningful decision state changes
       * (VAL-PLAN-084). Announces decision applied, stale revision, or error
       * states without per-event progress noise. High-frequency progress
       * events are not routed through this region. The pending notice above
       * handles the in-flight announcement; this region handles outcome
       * announcements so they are batched rather than per-event. */}
      <div
        aria-live="polite"
        aria-atomic="true"
        data-testid="decision-live-region"
        className="sr-only"
      >
        {approveError != null && !staleRevision ? 'Decision could not be applied.' : ''}
      </div>

      {anyPending && (
        <p
          className="mb-2.5 text-xs text-text-secondary"
          role="status"
          aria-live="polite"
          data-testid="decision-pending-notice"
        >
          Applying your decision…
        </p>
      )}

      {approveError != null && !staleRevision && (
        <p
          ref={(el) => {
            if (el) {
              el.tabIndex = -1;
            }
          }}
          role="alert"
          tabIndex={-1}
          className="mb-2.5 rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs text-error focus-visible:outline-none break-words"
        >
          {describePlanDecisionError(approveError, 'feedback')}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void handleApprove()}
          disabled={!canApproveOrReject || anyPending}
          aria-disabled={!canApproveOrReject || anyPending ? 'true' : undefined}
          aria-label={`Approve plan revision ${revision.revision}`}
          data-testid="plan-approve-button"
          className="inline-flex items-center gap-1.5 rounded-lg border border-success/30 bg-success/15 px-3 py-1.5 min-h-[44px] text-xs font-semibold text-success transition-colors hover:bg-success/25 focus-visible:ring-2 focus-visible:ring-success/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          {approveMutation.isPending ? 'Approving…' : 'Approve'}
        </button>
        <ReviseControl
          companyId={companyId}
          projectId={projectId}
          runId={runId}
          revision={revision}
          stateVersion={stateVersion}
          principalId={principalId}
          canRevise={canRevise}
          anyPending={anyPending}
          reviseMutation={reviseMutation}
          onStaleRevision={() => setStaleRevision(true)}
          onRefresh={handleRefreshAfterStale}
          reducedMotion={reducedMotion}
        />
        <RejectControl
          companyId={companyId}
          projectId={projectId}
          runId={runId}
          revision={revision}
          stateVersion={stateVersion}
          principalId={principalId}
          canReject={canApproveOrReject}
          anyPending={anyPending}
          rejectMutation={rejectMutation}
          onStaleRevision={() => setStaleRevision(true)}
          onRefresh={handleRefreshAfterStale}
          reducedMotion={reducedMotion}
        />
      </div>

      {!canApproveOrReject && role !== 'unknown' && (
        <p className="mt-2 text-xs text-text-muted break-words">
          {role === 'viewer'
            ? 'You can read this plan but cannot make decisions.'
            : 'Approve and reject require owner or admin permission.'}
        </p>
      )}
    </section>
  );
}

/** Stale-revision refresh notice (VAL-PLAN-045). No decision is implied. */
function StaleRevisionNotice({ onRefresh }: { onRefresh: () => void }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    // Move focus to the notice so the user is not lost to the document body
    // and the refresh action is reachable (VAL-PLAN-086).
    ref.current?.focus();
  }, []);
  return (
    <section
      aria-labelledby="plan-stale-heading"
      data-testid="plan-stale-revision-notice"
      className="mt-3 rounded-xl border border-warning/20 bg-warning/[0.04] p-3 w-full max-w-full break-words"
    >
      <p
        ref={(el) => {
          ref.current = el;
          if (el) {
            el.tabIndex = -1;
          }
        }}
        id="plan-stale-heading"
        role="alert"
        tabIndex={-1}
        className="text-xs text-warning mb-2 focus-visible:outline-none"
      >
        This plan is no longer the current proposal. Refresh to see the latest revision before
        deciding.
      </p>
      <button
        type="button"
        onClick={onRefresh}
        aria-label="Refresh plan"
        className="inline-flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-warning/40 focus-visible:outline-none motion-reduce:transition-none"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Refresh
      </button>
    </section>
  );
}

/** Revise control: opens a modal requiring feedback (VAL-PLAN-037, 038). */
function ReviseControl({
  companyId,
  projectId,
  runId,
  revision,
  stateVersion,
  principalId,
  canRevise,
  anyPending,
  reviseMutation,
  onStaleRevision,
  onRefresh,
  reducedMotion,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  revision: MissionPlanRevision;
  stateVersion?: number;
  principalId?: string;
  canRevise: boolean;
  anyPending: boolean;
  reviseMutation: ReturnType<typeof useReviseMissionPlan>;
  onStaleRevision: () => void;
  onRefresh: () => void;
  reducedMotion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        disabled={!canRevise || anyPending}
        aria-disabled={!canRevise || anyPending ? 'true' : undefined}
        aria-label={`Revise plan revision ${revision.revision}`}
        data-testid="plan-revise-button"
        className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 min-h-[44px] text-xs font-medium text-accent transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <SquarePen className="h-3.5 w-3.5" aria-hidden="true" />
        Revise
      </button>
      {open && (
        <PlanFeedbackDialog
          companyId={companyId}
          projectId={projectId}
          runId={runId}
          revision={revision}
          stateVersion={stateVersion}
          principalId={principalId}
          mode="revise"
          canSubmit={canRevise}
          isPending={reviseMutation.isPending}
          onSubmit={async (text, key) => {
            await reviseMutation.mutateAsync({
              planRevisionId: revision.id,
              contentHash: revision.contentHash,
              feedback: text,
              idempotencyKey: key,
              ifMatch: stateVersion,
            });
          }}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          onStaleRevision={onStaleRevision}
          onRefresh={onRefresh}
          reducedMotion={reducedMotion}
        />
      )}
    </>
  );
}

/** Reject control: opens a modal requiring confirmation (VAL-PLAN-040). */
function RejectControl({
  companyId,
  projectId,
  runId,
  revision,
  stateVersion,
  principalId,
  canReject,
  anyPending,
  rejectMutation,
  onStaleRevision,
  onRefresh,
  reducedMotion,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  revision: MissionPlanRevision;
  stateVersion?: number;
  principalId?: string;
  canReject: boolean;
  anyPending: boolean;
  rejectMutation: ReturnType<typeof useRejectMissionPlan>;
  onStaleRevision: () => void;
  onRefresh: () => void;
  reducedMotion: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        disabled={!canReject || anyPending}
        aria-disabled={!canReject || anyPending ? 'true' : undefined}
        aria-label={`Reject plan revision ${revision.revision}`}
        data-testid="plan-reject-button"
        className="inline-flex items-center gap-1.5 rounded-lg border border-error/30 bg-error/15 px-3 py-1.5 min-h-[44px] text-xs font-semibold text-error transition-colors hover:bg-error/25 focus-visible:ring-2 focus-visible:ring-error/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
      >
        <XOctagon className="h-3.5 w-3.5" aria-hidden="true" />
        Reject
      </button>
      {open && (
        <PlanFeedbackDialog
          companyId={companyId}
          projectId={projectId}
          runId={runId}
          revision={revision}
          stateVersion={stateVersion}
          principalId={principalId}
          mode="reject"
          canSubmit={canReject}
          isPending={rejectMutation.isPending}
          onSubmit={async (text, key) => {
            await rejectMutation.mutateAsync({
              planRevisionId: revision.id,
              contentHash: revision.contentHash,
              reason: text,
              // Default disposition cancels the Mission (VAL-PLAN-040).
              disposition: 'cancel',
              idempotencyKey: key,
              ifMatch: stateVersion,
            });
          }}
          onClose={() => {
            setOpen(false);
            triggerRef.current?.focus();
          }}
          onStaleRevision={onStaleRevision}
          onRefresh={onRefresh}
          reducedMotion={reducedMotion}
        />
      )}
    </>
  );
}

/**
 * Shared labelled modal dialog for revise (feedback) and reject (reason)
 * decisions (VAL-PLAN-120). Both require a 1–2,000 code-point text input.
 * Revise submits `plan.revision_request`; reject submits `plan.reject` with
 * the default cancel disposition. The dialog contains focus, announces
 * errors with `role="alert"`, returns focus to the originating control on
 * dismissal, and preserves the typed text across recoverable errors
 * (VAL-PLAN-092). Double-click protection disables the confirm control
 * while pending (VAL-PLAN-050).
 */
function PlanFeedbackDialog({
  companyId,
  projectId,
  runId,
  revision,
  stateVersion,
  principalId,
  mode,
  canSubmit,
  isPending,
  onSubmit,
  onClose,
  onStaleRevision,
  onRefresh,
  reducedMotion,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  revision: MissionPlanRevision;
  stateVersion?: number;
  principalId?: string;
  mode: 'revise' | 'reject';
  canSubmit: boolean;
  /** Whether the canonical command mutation is in flight. Disables the
   *  confirm control for double-click protection (VAL-PLAN-050). */
  isPending: boolean;
  /** Submit the canonical decision command with the validated text and a
   *  stable idempotency key. Resolves on success; rejects on error so the
   *  dialog can preserve the typed text and show a recoverable error
   *  (VAL-PLAN-092). The parent binds this to the appropriate canonical
   *  command hook (VAL-PLAN-104). */
  onSubmit: (text: string, idempotencyKey: string) => Promise<void>;
  onClose: () => void;
  onStaleRevision: () => void;
  onRefresh: () => void;
  reducedMotion: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const intentNoun = mode === 'revise' ? 'feedback' : 'reason';
  const scope = mode === 'revise' ? 'plan-revision' : 'plan-rejection';
  const heading = mode === 'revise' ? 'Revise plan' : 'Reject plan';
  const confirmLabel = mode === 'revise' ? 'Request revision' : 'Confirm rejection';

  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [staleRevision, setStaleRevision] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [succeeded, setSucceeded] = useState(false);

  const draftKey = useMemo(() => {
    if (!principalId || !companyId || !projectId) {
      return null;
    }
    return buildDraftKey({
      principalId,
      scope,
      companyId,
      projectId,
      runId,
      cardVersion: stateVersion !== undefined ? String(stateVersion) : undefined,
    });
  }, [principalId, scope, companyId, projectId, runId, stateVersion]);

  // Open the native dialog and restore any persisted draft. Focus the text
  // field (user-triggered → useful focus).
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    setIdempotencyKey((prev) => prev || makeIdempotencyKey(mode));
    setSubmitError(null);
    if (draftKey) {
      const restored = readDraft(draftKey);
      if (restored) {
        setText(restored);
      }
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    window.setTimeout(() => textRef.current?.focus(), 0);
  }, [draftKey, mode]);

  const handleDismiss = () => {
    setText('');
    setFieldError(null);
    setSubmitError(null);
    setIdempotencyKey('');
    if (draftKey) {
      clearDraft(draftKey);
    }
    onClose();
  };

  const validateText = (value: string): string | null => {
    const codepoints = [...value].length;
    if (codepoints < 1) {
      return `${intentNoun.charAt(0).toUpperCase() + intentNoun.slice(1)} is required.`;
    }
    if (codepoints > 2000) {
      return `${intentNoun.charAt(0).toUpperCase() + intentNoun.slice(1)} must be at most 2,000 characters.`;
    }
    return null;
  };

  const handleConfirm = async () => {
    if (isPending || succeeded) {
      return;
    }
    const trimmed = text.trim();
    const error = validateText(trimmed);
    if (error) {
      setFieldError(error);
      // Move focus to the first invalid field and announce the error
      // (VAL-PLAN-038, VAL-PLAN-085).
      window.setTimeout(() => textRef.current?.focus(), 0);
      return;
    }
    setFieldError(null);
    setSubmitError(null);
    const key = idempotencyKey || makeIdempotencyKey(mode);
    setIdempotencyKey(key);
    try {
      // The parent binds `onSubmit` to the canonical command hook so every
      // decision surface shares one command identity (VAL-PLAN-104). The
      // browser never advances state optimistically; the authoritative
      // snapshot refetch reveals the applied decision (VAL-PLAN-042).
      await onSubmit(trimmed, key);
      setSucceeded(true);
      if (draftKey) {
        clearDraft(draftKey);
      }
      // Move focus to the success status so the user is not lost to the
      // document body (VAL-PLAN-120).
      window.setTimeout(() => statusRef.current?.focus(), 0);
    } catch (err) {
      if (isStaleRevisionError(err)) {
        setStaleRevision(true);
        onStaleRevision();
        return;
      }
      setSubmitError(err);
      window.setTimeout(() => errorRef.current?.focus(), 0);
    }
  };

  // The confirm control is enabled even when the text is empty so that an
  // empty submission surfaces a field-level validation error and moves
  // focus to the first invalid field (VAL-PLAN-038, VAL-PLAN-085) rather
  // than silently disabling. Double-click protection comes from
  // `mutation.isPending`; a second empty click only re-renders the same
  // validation error and fires no command (VAL-PLAN-050).
  const canConfirm = canSubmit && !isPending && !succeeded;
  const codepoints = [...text].length;

  if (staleRevision) {
    return <StaleRevisionNotice onRefresh={onRefresh} />;
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="m-auto max-h-[85vh] w-full max-w-[calc(100vw-2rem)] rounded-2xl border border-white/[0.12] bg-surface p-0 text-text-primary shadow-2xl shadow-black/70 sm:max-w-md"
      onClose={handleDismiss}
    >
      <div className="p-6">
        <div className="mb-4 flex items-start gap-3">
          {mode === 'reject' ? (
            <XOctagon className="mt-0.5 h-5 w-5 shrink-0 text-error" aria-hidden="true" />
          ) : (
            <SquarePen className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden="true" />
          )}
          <div>
            <h2 id={titleId} className="text-base font-semibold font-display text-text-primary">
              {heading}
            </h2>
            <p id={descId} className="mt-1 text-sm text-text-secondary break-words">
              {mode === 'revise' ? (
                <>
                  Request changes to plan revision{' '}
                  <span className="font-medium text-text-primary">{revision.revision}</span>. The
                  current proposal will be superseded and the Mission will return to planning.
                </>
              ) : (
                <>
                  Reject plan revision{' '}
                  <span className="font-medium text-text-primary">{revision.revision}</span>. The
                  Mission will be cancelled. This cannot be undone.
                </>
              )}
            </p>
          </div>
        </div>

        {succeeded ? (
          <p
            ref={(el) => {
              statusRef.current = el;
              if (el) {
                el.tabIndex = -1;
              }
            }}
            role="status"
            tabIndex={-1}
            className="mb-4 rounded-lg border border-success/20 bg-success/10 px-3 py-2 text-sm text-success focus-visible:outline-none break-words"
          >
            {mode === 'revise'
              ? 'Revision requested. The Mission is returning to planning.'
              : 'Plan rejected. The Mission is being cancelled.'}
          </p>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleConfirm();
            }}
          >
            <div className="mb-4">
              <label
                htmlFor={`plan-${mode}-text`}
                className="mb-1 block text-xs font-medium text-text-secondary"
              >
                {mode === 'revise' ? 'Feedback' : 'Reason'}{' '}
                <span className="text-text-muted">(required)</span>
              </label>
              <textarea
                ref={textRef}
                id={`plan-${mode}-text`}
                name={mode === 'revise' ? 'feedback' : 'reason'}
                aria-label={mode === 'revise' ? 'Feedback' : 'Reason'}
                aria-required="true"
                aria-invalid={fieldError ? 'true' : undefined}
                aria-describedby={fieldError ? `plan-${mode}-error` : undefined}
                rows={3}
                maxLength={2000}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  if (fieldError) {
                    setFieldError(null);
                  }
                  if (draftKey) {
                    writeDraft(draftKey, e.target.value);
                  }
                }}
                disabled={isPending}
                className="w-full resize-y rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-60"
                placeholder={
                  mode === 'revise'
                    ? 'What changes should the planner make?'
                    : 'Why should this plan be rejected?'
                }
              />
              <p className="mt-1 text-xs text-text-muted">{codepoints}/2000 characters</p>
              {fieldError && (
                <p
                  id={`plan-${mode}-error`}
                  role="alert"
                  className="mt-1 text-xs text-error break-words"
                >
                  {fieldError}
                </p>
              )}
            </div>

            {submitError != null && (
              <p
                ref={(el) => {
                  errorRef.current = el;
                  if (el) {
                    el.tabIndex = -1;
                  }
                }}
                role="alert"
                tabIndex={-1}
                className="mb-4 rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-sm text-error focus-visible:outline-none break-words"
              >
                {describePlanDecisionError(submitError, intentNoun)}
              </p>
            )}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={handleDismiss}
                disabled={isPending}
                aria-label={mode === 'revise' ? 'Keep current plan' : 'Keep plan'}
                className="rounded-lg border border-white/[0.08] bg-white/[0.025] px-4 py-2 min-h-[44px] text-sm font-medium text-text-secondary transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 motion-reduce:transition-none"
              >
                {mode === 'revise' ? 'Keep current plan' : 'Keep plan'}
              </button>
              <button
                type="button"
                onClick={() => void handleConfirm()}
                disabled={!canConfirm}
                aria-disabled={!canConfirm ? 'true' : undefined}
                aria-label={confirmLabel}
                className={`inline-flex items-center justify-center gap-1.5 rounded-lg border px-4 py-2 min-h-[44px] text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none ${
                  mode === 'reject'
                    ? 'border-error/30 bg-error/15 text-error hover:bg-error/25 focus-visible:ring-error/40'
                    : 'border-accent/30 bg-accent/15 text-accent hover:bg-accent/25 focus-visible:ring-accent/40'
                }`}
              >
                {mode === 'reject' ? (
                  <XOctagon
                    className={reducedMotion ? 'h-4 w-4' : 'h-4 w-4 motion-safe:animate-pulse'}
                    aria-hidden="true"
                  />
                ) : (
                  <SquarePen className="h-4 w-4" aria-hidden="true" />
                )}
                {isPending ? (mode === 'revise' ? 'Requesting…' : 'Rejecting…') : confirmLabel}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}

export { isRecoverablePlanDecisionError, describePlanDecisionError };
