import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  useMissionRunSnapshot,
  useMissionRunEvents,
  useMissionRequestText,
  useMissionRunStream,
  useCancelMissionRun,
  useRetryMissionRun,
} from '@/lib/hooks';
import { useSession } from '@/lib/auth';
import type { MissionRunSummary, MissionRunSnapshot, MissionReplayEvent } from '@/lib/api';
import { type MissionLinkTarget } from '@eidolon/shared';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Activity,
  DollarSign,
  RefreshCw,
  WifiOff,
  Ban,
  RotateCcw,
} from 'lucide-react';
import { MissionCancelDialog } from './MissionCancelDialog';
import { MissionQuestionCard } from './MissionQuestionCard';
import { MissionQuestionHistory } from './MissionQuestionHistory';
import { clearRunDrafts } from '@/lib/mission-drafts';

/** Terminal run statuses. */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Whether a status is terminal. */
function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/**
 * Resolve the authoritative run status for badge/flag derivation. The list
 * row's `status` is a projection that can lag the authoritative snapshot
 * during live lifecycle transitions; prefer the snapshot and fall back to
 * the list row only while the snapshot is still loading.
 * (Normative Boundary 1 / VAL-RUN-017.)
 */
function resolveAuthoritativeStatus(
  snapshot: MissionRunSnapshot | undefined,
  fallback: string,
): string {
  return snapshot?.status ?? fallback;
}

/** Map a status string to human-readable text (VAL-RUN-018). */
function statusToText(status: string): string {
  const map: Record<string, string> = {
    draft: 'Draft',
    awaiting_input: 'Awaiting input',
    planning: 'Planning',
    awaiting_approval: 'Awaiting approval',
    queued: 'Queued',
    running: 'Running',
    synthesizing: 'Synthesizing',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  return map[status] ?? status;
}

/** Map a mode string to human-readable text. */
function modeToText(mode: string): string {
  return mode.replace(/_/g, ' ');
}

/** Format integer cents as a currency string. */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Format an ISO timestamp as a readable date-time string. */
function formatTime(iso: string | null): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Pick a status variant for the badge (text always accompanies color). */
function statusBadgeVariant(status: string): 'default' | 'success' | 'warning' | 'error' | 'info' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'warning';
    case 'running':
    case 'queued':
      return 'info';
    default:
      return 'default';
  }
}

/** Pick a status icon (conveys status with text, never color alone). */
function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-error" aria-hidden="true" />;
    case 'cancelled':
      return <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />;
    case 'running':
    case 'queued':
    case 'synthesizing':
    case 'planning':
    case 'awaiting_input':
    case 'awaiting_approval':
      return <Activity className="h-4 w-4 text-neon-cyan" aria-hidden="true" />;
    default:
      return <Clock className="h-4 w-4 text-text-muted" aria-hidden="true" />;
  }
}

/**
 * Batched status announcement region (VAL-RUN-089).
 *
 * Tracks the previous lifecycle status and announces meaningful changes
 * through a polite `aria-live` region. High-frequency progress events
 * (execution.progress, heartbeats) do not trigger announcements — only
 * lifecycle status transitions (queued → running → completed, etc.) and
 * error/cancellation indicators are announced. This avoids one announcement
 * per token or progress event.
 */
function useBatchedStatusAnnouncement(runId: string, status: string): string {
  const [announcement, setAnnouncement] = useState('');
  const prevStatusRef = useRef<string | null>(null);

  useEffect(() => {
    const prev = prevStatusRef.current;
    // Only announce on a lifecycle status change, not on every re-render
    // or progress event. The first mount sets the baseline without
    // announcing (the user can already see the card).
    if (prev !== null && prev !== status) {
      setAnnouncement(`Run ${runId}: ${statusToText(status)}`);
    }
    prevStatusRef.current = status;
  }, [runId, status]);

  return announcement;
}

/**
 * Render an authoritative Mission run card with stable identity, textual
 * lifecycle status, chronological event timeline, budget state, and
 * terminal outcome details.
 *
 * The status comes from the authoritative run summary (server-provided). The
 * budget, terminal details, and cancellation indicator come from the full
 * snapshot. The event timeline comes from the journal replay. The browser
 * never infers or advances status; every visible field is server-authoritative.
 *
 * Accessibility:
 * - A batched polite live region announces lifecycle status changes
 *   (VAL-RUN-089).
 * - Status is conveyed with text and an icon, never color alone
 *   (VAL-RUN-092).
 * - Animated indicators respect `prefers-reduced-motion` (VAL-RUN-093).
 * - The card layout is responsive at narrow mobile viewports (VAL-RUN-094).
 * - The card has a scroll anchor id for deep-link navigation (VAL-RUN-097).
 */
export function MissionRunCard({
  companyId,
  projectId,
  run,
  requestText,
  highlighted,
  target,
}: {
  companyId: string;
  projectId: string;
  run: MissionRunSummary;
  requestText?: string;
  /** Whether this card is the deep-link target (VAL-RUN-097). */
  highlighted?: boolean;
  /** Optional canonical `links.ui` target. When the target is not `run`,
   * the highlighted card focuses the matching sub-element so reload and
   * Back/Forward restore exact target/focus (VAL-CROSS-076, VAL-CROSS-083).
   * In Phase 1 only the run-level focus target is rendered; sub-element
   * targets (question/plan/child/source/artifact/citation) fall back to
   * focusing the run card itself, which is the Phase 1 surface for those
   * future targets. */
  target?: MissionLinkTarget;
}) {
  const snapshotQuery = useMissionRunSnapshot(companyId, projectId, run.id);
  const eventsQuery = useMissionRunEvents(companyId, projectId, run.id);
  // Request text from the start mutation cache (prop takes precedence).
  const cachedRequestText = useMissionRequestText(run.id);
  const displayRequestText = requestText ?? cachedRequestText;
  // Authenticated principal for browser-local question draft scoping
  // (VAL-MODEQ-134).
  const session = useSession();
  const principalId = session.data?.user?.id ?? '';

  const snapshot = snapshotQuery.data as MissionRunSnapshot | undefined;
  const events = (eventsQuery.data?.events ?? []) as MissionReplayEvent[];

  // Status badge and all derived flags (isTerminal, canCancel, canRetry)
  // derive from the authoritative snapshot, falling back to the list row
  // only while the snapshot is still loading. The list row's `status` is a
  // projection that can lag the authoritative snapshot during live
  // lifecycle transitions (queued → running → completed); deriving from
  // `snapshot?.status ?? run.status` keeps the badge and action
  // availability authoritative. (Normative Boundary 1 / VAL-RUN-017.)
  const authoritativeStatus = resolveAuthoritativeStatus(snapshot, run.status);
  const isTerminal = isTerminalRunStatus(authoritativeStatus);

  // SSE stream for real-time updates. Only connect for nonterminal runs,
  // determined from the authoritative snapshot status so a stale list row
  // cannot keep (or drop) a stream for an actually-terminal run.
  const stream = useMissionRunStream(companyId, projectId, run.id, {
    enabled: !isTerminal,
  });

  const statusText = statusToText(authoritativeStatus);
  const announcement = useBatchedStatusAnnouncement(run.id, authoritativeStatus);

  // Clear all run-scoped browser drafts (question answers, revision/
  // rejection feedback, cancellation reason) when the run reaches a
  // terminal state. Drafts are non-authoritative local values; once the
  // run is finished/cancelled/failed they must not linger past the run's
  // lifetime (VAL-CROSS-084 terminalization). Idempotent: removing
  // already-absent keys is harmless, so running on every terminal render
  // is safe.
  useEffect(() => {
    if (isTerminal && principalId) {
      clearRunDrafts({
        principalId,
        companyId,
        projectId,
        runId: run.id,
      });
    }
  }, [isTerminal, principalId, companyId, projectId, run.id]);

  // Cancellation confirmation state (VAL-RUN-035, VAL-RUN-036). The cancel
  // control is shown only for nonterminal runs that have not already
  // requested cancellation. Once requested, the authoritative indicator
  // takes over (VAL-RUN-035). isTerminal derives from the authoritative
  // snapshot status so a stale list row cannot keep an actually-terminal
  // run cancellable (Normative Boundary 1).
  const cancelMutation = useCancelMissionRun(companyId, projectId, run.id);
  const qc = useQueryClient();
  const [cancelOpen, setCancelOpen] = useState(false);
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const cancelRequested =
    snapshot?.cancelRequestedAt !== null && snapshot?.cancelRequestedAt !== undefined;
  const canCancel = !isTerminal && !cancelRequested;

  // Retry control (VAL-RUN-045, VAL-CROSS-073, VAL-CROSS-074, VAL-CROSS-096).
  // Retry is shown only for terminal root runs (failed or cancelled, depth 0).
  // Completed runs and child runs (depth > 0) do not get a retry control.
  // The browser never advances state optimistically; the authoritative
  // snapshot/event refetch reveals the new successor run. canRetry derives
  // from the authoritative snapshot status so a stale list row cannot make
  // an actually-nonterminal run retryable (Normative Boundary 1).
  const isRootRun = !snapshot || (snapshot.depth ?? 0) === 0;
  const canRetry = isRetryEligible(authoritativeStatus, isRootRun);

  // When the confirmation dialog closes, restore focus to the originating
  // Cancel control so focus is never lost to the document body
  // (VAL-RUN-090). Native <dialog> restoration handles real browsers; this
  // makes the behavior deterministic across environments.
  const handleCancelClose = () => {
    setCancelOpen(false);
    // Focus synchronously while the originating control is still mounted
    // (it remains for a still-running, not-yet-cancelled run).
    cancelBtnRef.current?.focus();
  };

  // Scroll into view and restore focus when highlighted (deep-link target).
  // For Phase 1, the run card is the focus surface for every target kind.
  // When a more specific sub-element id is available (future milestones),
  // focus that element instead of the card (VAL-CROSS-076, VAL-CROSS-083).
  const cardRef = useRunCardHighlight(highlighted, run.id, target);

  return (
    <article
      ref={cardRef}
      id={`mission-run-${run.id}`}
      aria-labelledby={`run-heading-${run.id}`}
      data-highlighted={highlighted ? 'true' : undefined}
      data-target-kind={highlighted ? highlightTargetKind(target) : undefined}
      className={`rounded-xl border bg-surface p-4 w-full max-w-full break-words ${
        highlighted ? 'border-accent/40 ring-2 ring-accent/20' : 'border-white/[0.06]'
      }`}
    >
      {/* Batched polite live region for status announcements (VAL-RUN-089) */}
      <span role="status" aria-label="Mission status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <RunCardHeader run={run} status={authoritativeStatus} statusText={statusText} />
      <RunCardRequest displayRequestText={displayRequestText} run={run} />
      <RunCardMeta run={run} snapshot={snapshot} status={authoritativeStatus} />
      <RunCardStreamStatus stream={stream} isTerminal={isTerminal} />
      <RunCardQueueHealth snapshot={snapshot} status={authoritativeStatus} />
      <RunCardStaleRead
        snapshotError={snapshotQuery.isError && !!snapshotQuery.data}
        eventsError={eventsQuery.isError && !!eventsQuery.data}
        onRetrySnapshot={() => snapshotQuery.refetch()}
        onRetryEvents={() => eventsQuery.refetch()}
      />
      <RunCardCancellationIndicator snapshot={snapshot} status={authoritativeStatus} />
      <RunCardRetryLineage snapshot={snapshot} companyId={companyId} projectId={projectId} />
      <RunCardBudget snapshot={snapshot} />
      <RunCardFailure snapshot={snapshot} status={authoritativeStatus} />
      <RunCardOutput snapshot={snapshot} status={authoritativeStatus} />
      <RunCardCancelledDetail snapshot={snapshot} status={authoritativeStatus} />
      {snapshot?.currentQuestionSet && principalId && (
        <MissionQuestionCard
          companyId={companyId}
          projectId={projectId}
          runId={run.id}
          questionSet={snapshot.currentQuestionSet}
          stateVersion={snapshot.stateVersion}
          principalId={principalId}
        />
      )}
      {/* VAL-MODEQ-143: if the run is awaiting input but the snapshot
       * failed to load (no currentQuestionSet), show an accessible Retry
       * rather than an empty success or a disappeared question area. */}
      {authoritativeStatus === 'awaiting_input' &&
        !snapshot?.currentQuestionSet &&
        snapshotQuery.isError && (
          <RunCardQuestionLoadError onRetry={() => snapshotQuery.refetch()} />
        )}
      <MissionQuestionHistory companyId={companyId} projectId={projectId} runId={run.id} />
      <RunCardTimeline events={events} eventsError={eventsQuery.isError && !!eventsQuery.data} />
      <RunCardRetryControl
        companyId={companyId}
        projectId={projectId}
        runId={run.id}
        canRetry={canRetry}
        stateVersion={snapshot?.stateVersion}
        onRefreshSnapshot={() => snapshotQuery.refetch()}
      />
      {canCancel && (
        <div className="mt-3">
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={() => setCancelOpen(true)}
            aria-label={`Cancel ${run.id}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-error/30 bg-error/10 px-3 py-1.5 text-xs font-medium text-error transition-colors hover:bg-error/20 focus-visible:ring-2 focus-visible:ring-error/40 focus-visible:outline-none motion-reduce:transition-none"
          >
            <Ban className="h-3.5 w-3.5" aria-hidden="true" />
            Cancel Mission
          </button>
        </div>
      )}
      {canCancel && (
        <MissionCancelDialog
          run={run}
          open={cancelOpen}
          onClose={handleCancelClose}
          ifMatch={snapshot?.stateVersion}
          principalId={principalId}
          companyId={companyId}
          projectId={projectId}
          onSubmit={async (args) => {
            await cancelMutation.mutateAsync(args);
            // Invalidate the inbox projection so the mission-question
            // attention item converges to the resolved state after
            // cancellation (VAL-CROSS-057, Normative Boundary 1).
            qc.invalidateQueries({ queryKey: ['inbox', companyId] });
          }}
        />
      )}
    </article>
  );
}

/** Header with status icon, run ID heading, and textual status badge.
 * The icon and badge variant derive from the authoritative `status`
 * (snapshot?.status ?? run.status), not the stale list row
 * (Normative Boundary 1 / VAL-RUN-017). */
function RunCardHeader({
  run,
  status,
  statusText,
}: {
  run: MissionRunSummary;
  status: string;
  statusText: string;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <StatusIcon status={status} />
      <h3
        id={`run-heading-${run.id}`}
        className="text-sm font-semibold text-text-primary font-display break-all"
      >
        {run.id}
      </h3>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClass(statusBadgeVariant(status))}`}
      >
        {statusText}
      </span>
    </div>
  );
}

/** Request summary (safe text or hash fallback). */
function RunCardRequest({
  displayRequestText,
  run,
}: {
  displayRequestText?: string;
  run: MissionRunSummary;
}) {
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-text-secondary mb-0.5">Request</p>
      <p className="text-sm text-text-primary break-words">
        {displayRequestText ?? run.requestContentHash}
      </p>
    </div>
  );
}

/** Meta row: mode, immutable policy identity, creation time, and terminal
 * timestamps. `status` is the authoritative status
 * (snapshot?.status ?? run.status).
 *
 * The immutable policy identity (short prefix of the policy content hash)
 * is shown so the user can correlate the visible mode with the run's
 * immutable resolved policy, and observe that later composer mode changes
 * do not alter an existing run (VAL-CROSS-006). The hash is a safe,
 * non-secret commitment to the immutable policy snapshot. */
function RunCardMeta({
  run,
  snapshot,
  status,
}: {
  run: MissionRunSummary;
  snapshot?: MissionRunSnapshot;
  status: string;
}) {
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const terminalLabel =
    status === 'completed'
      ? 'Completed at: '
      : status === 'failed'
        ? 'Failed at: '
        : status === 'cancelled'
          ? 'Cancelled at: '
          : '';
  // Immutable policy identity: prefer the authoritative snapshot hash, fall
  // back to the list row hash while the snapshot loads. Show a short prefix
  // so the value is readable and comparable across reloads (VAL-CROSS-006).
  const policyHash = snapshot?.policyContentHash ?? run.policyContentHash ?? null;
  const policyShort = policyHash ? policyHash.slice(0, 12) : null;
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
      <span>
        Mode: <span className="text-text-secondary capitalize">{modeToText(run.resolvedMode)}</span>
      </span>
      {policyShort && (
        <span data-testid="run-policy-identity">
          Policy: <span className="text-text-secondary font-mono">{policyShort}</span>
        </span>
      )}
      <span>
        Created: <time dateTime={run.createdAt}>{formatTime(run.createdAt)}</time>
      </span>
      {snapshot?.startedAt && (
        <span>
          Started: <time dateTime={snapshot.startedAt}>{formatTime(snapshot.startedAt)}</time>
        </span>
      )}
      {isTerminal && snapshot?.terminalAt && (
        <span>
          {terminalLabel}
          <time dateTime={snapshot.terminalAt}>{formatTime(snapshot.terminalAt)}</time>
        </span>
      )}
    </div>
  );
}

/** Stream status indicator: reconnecting, gap recovery, or stream error (VAL-RUN-031, VAL-RUN-030, VAL-CROSS-052).
 * Each state has visible text alongside any color treatment (VAL-RUN-092).
 * Animated icons respect prefers-reduced-motion (VAL-RUN-093). */
function RunCardStreamStatus({
  stream,
  isTerminal,
}: {
  stream: { status: string; gapDetected: boolean };
  isTerminal: boolean;
}) {
  if (isTerminal) {
    return null;
  }
  if (stream.gapDetected) {
    return (
      <p
        className="mb-3 text-xs text-warning flex items-center gap-1.5"
        role="status"
        aria-live="polite"
      >
        <RefreshCw
          className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        Replaying missing events…
      </p>
    );
  }
  if (stream.status === 'reconnecting') {
    return (
      <p
        className="mb-3 text-xs text-warning flex items-center gap-1.5"
        role="status"
        aria-live="polite"
      >
        <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
        Reconnecting…
      </p>
    );
  }
  if (stream.status === 'error') {
    return (
      <p
        className="mb-3 text-xs text-error flex items-center gap-1.5"
        role="status"
        aria-live="polite"
      >
        <WifiOff className="h-3.5 w-3.5" aria-hidden="true" />
        Stream error. Updates may be delayed — refresh to see latest.
      </p>
    );
  }
  return null;
}

/** Queue health indicator: worker unavailable (VAL-RUN-088).
 * Only shown when the server reports queueHealth: "unavailable".
 * The browser never infers worker unavailability from a local timer. */
function RunCardQueueHealth({
  snapshot,
  status,
}: {
  snapshot?: MissionRunSnapshot;
  status: string;
}) {
  if (snapshot?.queueHealth !== 'unavailable') {
    return null;
  }
  // Only show for nonterminal waiting/queued states where worker
  // unavailability is meaningful.
  const showForStatus = ['queued', 'planning', 'running', 'synthesizing'].includes(status);
  if (!showForStatus) {
    return null;
  }
  return (
    <p
      className="mb-3 text-xs text-warning flex items-center gap-1.5"
      role="status"
      aria-live="polite"
    >
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      Worker unavailable. The run will continue when a worker recovers.
    </p>
  );
}

/** Stale-read indicator: snapshot or events refetch failed but previous data is shown (VAL-RUN-131). */
function RunCardStaleRead({
  snapshotError,
  eventsError,
  onRetrySnapshot,
  onRetryEvents,
}: {
  snapshotError: boolean;
  eventsError: boolean;
  onRetrySnapshot: () => void;
  onRetryEvents: () => void;
}) {
  if (!snapshotError && !eventsError) {
    return null;
  }
  return (
    <div className="mb-3 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
      <p className="text-xs text-warning mb-1.5" role="status" aria-live="polite">
        Some data may be outdated due to a connection issue.
      </p>
      <div className="flex flex-wrap gap-2">
        {snapshotError && (
          <button
            type="button"
            onClick={onRetrySnapshot}
            className="text-xs text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
            aria-label="Retry loading run snapshot"
          >
            Retry snapshot
          </button>
        )}
        {eventsError && (
          <button
            type="button"
            onClick={onRetryEvents}
            className="text-xs text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
            aria-label="Retry loading event timeline"
          >
            Retry timeline
          </button>
        )}
      </div>
    </div>
  );
}

/** Cancellation requested indicator (separate from lifecycle status). */
function RunCardCancellationIndicator({
  snapshot,
  status,
}: {
  snapshot?: MissionRunSnapshot;
  status: string;
}) {
  const cancelRequested =
    snapshot?.cancelRequestedAt !== null && snapshot?.cancelRequestedAt !== undefined;
  if (!cancelRequested || status === 'cancelled') {
    return null;
  }
  return (
    <p className="mb-3 text-xs text-warning" role="status">
      Cancellation requested
      {snapshot?.cancelRequestedBy ? ` by ${snapshot.cancelRequestedBy}` : ''}
    </p>
  );
}

/** Retry lineage link: shows when this run is a retry of another run
 * (VAL-CROSS-074, VAL-CROSS-096). The link navigates to the original run
 * so the user can trace the retry history as a distinct lineage. */
function RunCardRetryLineage({
  snapshot,
  companyId,
  projectId,
}: {
  snapshot?: MissionRunSnapshot;
  companyId: string;
  projectId: string;
}) {
  const retryOfRunId = snapshot?.retryOfRunId;
  if (!retryOfRunId) {
    return null;
  }
  // Use the canonical plural `/companies/.../work` path so the link is
  // routed by the app redirect (VAL-CROSS-101). The retry-of run is a
  // distinct run whose authoritative thread is not known here; per
  // VAL-CROSS-083 thread selection derives from the target run's
  // authoritative snapshot, so we do not fabricate a `thread` hint. The
  // closed-grammar parser requires `thread` to fire a deep-link highlight,
  // so this link navigates to the project Work tab without highlighting a
  // specific run; the retry-of run's own `links.ui` (carried in its
  // snapshot) is the canonical deep link for that run.
  const linkPath = `/companies/${companyId}/projects/${projectId}/work?mission=${retryOfRunId}`;
  return (
    <p className="mb-3 text-xs text-text-muted">
      <span>Retry of </span>
      <Link
        to={linkPath}
        className="text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
      >
        {retryOfRunId}
      </Link>
    </p>
  );
}

/** Generate a stable random idempotency key for a logical retry command.
 * Reused across recoverable retries so the server's exactly-one-outcome
 * guarantee holds after a lost network response (Normative Boundary 2 /
 * VAL-RUN-130). Matches MissionCancelDialog's key-retention pattern. */
function makeRetryIdempotencyKey(runId: string): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `retry-${runId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Retry control for terminal root runs (VAL-RUN-045, VAL-CROSS-073,
 * VAL-CROSS-074, VAL-CROSS-096, VAL-RUN-056, VAL-RUN-130).
 *
 * Shows a Retry Mission button for failed/cancelled terminal root runs.
 * Handles stale-version errors (412 RUN_VERSION_MISMATCH) by showing a
 * "Mission changed" message with a refresh control, and lost network
 * responses by showing a recovering state. The browser never advances
 * state optimistically; the authoritative snapshot/event refetch reveals
 * the new successor run.
 *
 * Idempotency key retention (Normative Boundary 2 / VAL-RUN-130): the
 * retry idempotency key is generated on the first activation and retained
 * in component state across recoverable retries (network failure / lost
 * response) until the server confirms the outcome. This mirrors
 * MissionCancelDialog's key-retention pattern so a second activation after
 * a lost response replays the identical logical command and the server
 * returns the original successor instead of creating a duplicate
 * (VAL-RUN-050). The key is cleared on success so a subsequent, distinct
 * retry attempt is a fresh logical command. */
function RunCardRetryControl({
  companyId,
  projectId,
  runId,
  canRetry,
  stateVersion,
  onRefreshSnapshot,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  canRetry: boolean;
  stateVersion?: number;
  onRefreshSnapshot: () => void;
}) {
  const retryMutation = useRetryMissionRun(companyId, projectId, runId);
  const [retryError, setRetryError] = useState<'stale' | 'network' | null>(null);
  // Stable idempotency key for the current logical retry. Generated on the
  // first activation and reused across recoverable retries; cleared on
  // success (Normative Boundary 2 / VAL-RUN-130).
  const [idempotencyKey, setIdempotencyKey] = useState('');

  async function handleRetry() {
    if (retryMutation.isPending) {
      return;
    }
    // Reuse the retained key across recoverable retries; generate a fresh
    // key only for a new logical retry (after a confirmed success cleared
    // the retained key).
    const key = idempotencyKey || makeRetryIdempotencyKey(runId);
    setIdempotencyKey(key);
    setRetryError(null);
    try {
      await retryMutation.mutateAsync({
        idempotencyKey: key,
        ifMatch: stateVersion,
      });
      // Success: the server confirmed the outcome. Clear the retained key
      // so a later, distinct retry attempt is a fresh logical command.
      setIdempotencyKey('');
    } catch (err) {
      const apiErr = err as { status?: number; body?: { code?: string } };
      if (apiErr?.status === 412 || apiErr?.body?.code === 'RUN_VERSION_MISMATCH') {
        // Recoverable stale-version error: retain the key so the user can
        // refresh and replay the identical command (VAL-RUN-056).
        setRetryError('stale');
      } else {
        // Network error or lost response — the server may have applied the
        // command but the response was lost. Retain the key so the next
        // activation replays the identical command (VAL-RUN-130). Show a
        // recovering state.
        setRetryError('network');
      }
    }
  }

  function handleRefreshAfterStale() {
    onRefreshSnapshot();
    setRetryError(null);
  }

  if (!canRetry) {
    return null;
  }

  return (
    <>
      {retryError === 'stale' && (
        <div className="mt-3 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
          <p className="text-xs text-warning mb-1.5" role="alert">
            Mission changed. Refresh to see the latest state.
          </p>
          <button
            type="button"
            onClick={handleRefreshAfterStale}
            aria-label="Refresh run snapshot"
            className="inline-flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-warning/40 focus-visible:outline-none motion-reduce:transition-none"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Refresh
          </button>
        </div>
      )}
      {retryError === 'network' && (
        <p className="mt-3 text-xs text-warning" role="status" aria-live="polite">
          Recovering — the retry may have been accepted. The run list will update shortly.
        </p>
      )}
      {retryError !== 'stale' && (
        <div className="mt-3">
          <button
            type="button"
            onClick={handleRetry}
            disabled={retryMutation.isPending}
            aria-label={`Retry Mission ${runId}`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none disabled:opacity-50 disabled:cursor-not-allowed motion-reduce:transition-none"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry Mission
          </button>
        </div>
      )}
    </>
  );
}

/** Budget status with nonnegative currency values (VAL-RUN-060). */
function RunCardBudget({ snapshot }: { snapshot?: MissionRunSnapshot }) {
  const ceiling = snapshot?.budget?.costCentsCeiling ?? 0;
  const settled = snapshot?.budget?.settledCents ?? 0;
  const actualCost = snapshot?.budget?.actualCostCents ?? 0;
  const displaySettled = Math.max(0, Math.min(settled, ceiling));
  if (ceiling <= 0) {
    return null;
  }
  return (
    <div
      data-testid="budget-status"
      className="mb-3 rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2 w-full"
    >
      <div className="flex items-center gap-1.5 mb-1">
        <DollarSign className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
        <p className="text-xs font-medium text-text-secondary">Budget</p>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span>
          Ceiling: <span className="tabular-nums text-text-primary">{formatCents(ceiling)}</span>
        </span>
        <span>
          Spent:{' '}
          <span className="tabular-nums text-text-primary">{formatCents(displaySettled)}</span>
        </span>
        {actualCost > 0 && actualCost !== displaySettled && (
          <span>
            Actual cost:{' '}
            <span className="tabular-nums text-text-primary">{formatCents(actualCost)}</span>
          </span>
        )}
        {snapshot && snapshot.budget.releasedCents > 0 && (
          <span>
            Released:{' '}
            <span className="tabular-nums text-text-secondary">
              {formatCents(snapshot.budget.releasedCents)}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

/** Failed card: safe error message without secrets (VAL-RUN-045).
 * Uses role=alert so assistive technologies announce failure information
 * assertively (VAL-RUN-089). Category and failure-code text use
 * high-contrast color to meet WCAG AA 4.5:1 (VAL-RUN-111). */
function RunCardFailure({ snapshot, status }: { snapshot?: MissionRunSnapshot; status: string }) {
  if (status !== 'failed' || !snapshot?.safeErrorMessage) {
    return null;
  }
  return (
    <div role="alert" className="mb-3 rounded-lg border border-error/20 bg-error/10 px-3 py-2">
      <p className="text-xs font-medium text-error mb-0.5">Failure</p>
      <p className="text-sm text-text-primary break-words">{snapshot.safeErrorMessage}</p>
      {snapshot.failureCategory && (
        <p className="mt-1 text-xs text-text-primary">Category: {snapshot.failureCategory}</p>
      )}
      {snapshot.failureCode && (
        <p className="mt-0.5 text-xs text-text-primary">Code: {snapshot.failureCode}</p>
      )}
    </div>
  );
}

/** Completed card: output links (VAL-RUN-044). */
function RunCardOutput({ snapshot, status }: { snapshot?: MissionRunSnapshot; status: string }) {
  if (
    status !== 'completed' ||
    !snapshot ||
    !snapshot.artifacts ||
    snapshot.artifacts.length === 0
  ) {
    return null;
  }
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-text-secondary mb-1">Output</p>
      <ul className="space-y-1">
        {snapshot.artifacts.map((a: unknown, i: number) => (
          <li key={i} className="text-sm text-accent break-words">
            {/* Artifacts are never[] in Phase 1; placeholder for future */}
            {String(a)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Cancelled card detail: explicit cancellation with when/by whom and no
 * false completion or failure (VAL-RUN-110). Active-work indicators (Cancel
 * control, stream status, output links) are already suppressed for terminal
 * runs; this section makes cancellation explicit and attributable. */
function RunCardCancelledDetail({
  snapshot,
  status,
}: {
  snapshot?: MissionRunSnapshot;
  status: string;
}) {
  if (status !== 'cancelled' || !snapshot) {
    return null;
  }
  const requestedAt = snapshot.cancelRequestedAt;
  const requestedBy = snapshot.cancelRequestedBy;
  return (
    <div className="mb-3 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
      <p className="text-xs font-medium text-warning mb-1">Cancellation</p>
      <p className="text-sm text-text-primary">
        This Mission was cancelled
        {requestedBy ? (
          <>
            {' '}
            by <span className="font-medium">{requestedBy}</span>
          </>
        ) : null}
        {requestedAt ? (
          <>
            {' '}
            on <time dateTime={requestedAt}>{formatTime(requestedAt)}</time>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

/** Chronological event timeline as a semantic ordered list (VAL-RUN-074, VAL-RUN-095). */
function RunCardTimeline({
  events,
  eventsError,
}: {
  events: MissionReplayEvent[];
  eventsError?: boolean;
}) {
  if (events.length === 0 && !eventsError) {
    return null;
  }
  return (
    <div className="mb-1">
      <p className="text-xs font-medium text-text-secondary mb-1">
        Timeline
        {eventsError && (
          <span className="ml-2 text-warning font-normal" aria-live="polite">
            (may be outdated)
          </span>
        )}
      </p>
      {events.length > 0 && (
        <ol aria-label="Event timeline" className="space-y-1">
          {events.map((event) => (
            <li key={event.sequence} className="flex items-baseline gap-2 text-xs text-text-muted">
              <span className="tabular-nums text-text-secondary w-6 shrink-0">
                {event.sequence}
              </span>
              <span className="text-text-primary break-words">{event.type}</span>
              <time dateTime={event.occurredAt} className="ml-auto text-text-muted shrink-0">
                {formatTime(event.occurredAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** Question-load failure: the run is awaiting input but the snapshot
 * failed to load (no currentQuestionSet). Shows an accessible Retry that
 * refetches the exact run snapshot. The run remains visibly awaiting input
 * — the user never sees an empty success or a disappeared question area
 * (VAL-MODEQ-143). */
function RunCardQuestionLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <section
      className="mt-3 rounded-xl border border-warning/20 bg-warning/[0.04] p-3 w-full max-w-full break-words"
      aria-labelledby="question-load-error-heading"
    >
      <h4 id="question-load-error-heading" className="text-sm font-semibold text-warning mb-1">
        Questions unavailable
      </h4>
      <p className="text-xs text-text-secondary mb-2" role="alert">
        Could not load questions for this Mission. Your input is still needed.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none motion-reduce:transition-none"
      >
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        Retry
      </button>
    </section>
  );
}

/** Return badge classes for a status variant. */
function badgeClass(variant: 'default' | 'success' | 'warning' | 'error' | 'info'): string {
  switch (variant) {
    case 'success':
      return 'bg-success/10 text-success border-success/20';
    case 'error':
      return 'bg-error/10 text-error border-error/20';
    case 'warning':
      return 'bg-warning/10 text-warning border-warning/20';
    case 'info':
      return 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20';
    default:
      return 'bg-white/[0.06] text-text-secondary border-white/[0.08]';
  }
}

/**
 * Resolve the stable DOM element id for a canonical `links.ui` target inside
 * a run card. Returns `null` for the default `run` target so the caller
 * focuses the card itself. In Phase 1 only the run-level surface is
 * rendered; the question/plan/child/source/artifact/citation element ids
 * are reserved for future milestones and fall back to the card heading.
 * (VAL-CROSS-076, VAL-CROSS-083, VAL-CROSS-101).
 */
export function targetElementId(runId: string, target: MissionLinkTarget): string | null {
  switch (target.kind) {
    case 'run':
      return null;
    case 'question':
      return `mission-question-${target.questionSetId}`;
    case 'planRevision':
      return `mission-plan-revision-${target.revisionId}`;
    case 'approval':
      return `mission-approval-${target.approvalId}`;
    case 'childThread':
      return `mission-child-thread-${target.childThreadId}`;
    case 'sourceRevision':
      return `mission-source-revision-${target.sourceRevisionId}`;
    case 'artifactVersion':
      return `mission-artifact-${target.artifactId}-version-${target.version}`;
    case 'citation':
      return `mission-citation-${target.citationId}`;
  }
}

/**
 * Scroll the highlighted run card into view and restore focus to the
 * target-specific anchor (or the card itself as the Phase 1 fallback).
 * Extracted from the highlight `useEffect` so the card's cyclomatic
 * complexity stays bounded (VAL-CROSS-076, VAL-CROSS-083).
 */
function restoreHighlightFocus(
  cardEl: HTMLElement,
  runId: string,
  target: MissionLinkTarget | undefined,
): void {
  if (typeof cardEl.scrollIntoView === 'function') {
    cardEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  // Resolve a target-specific anchor if present. Future milestones render
  // question/plan/child/source/artifact/citation elements with stable ids;
  // until then we fall back to focusing the card heading.
  const targetId = target ? targetElementId(runId, target) : null;
  const focusEl = (targetId && document.getElementById(targetId)) || cardEl;
  if (!focusEl || typeof focusEl.focus !== 'function') {
    return;
  }
  // Make the element focusable programmatically without losing its
  // semantics: focus then leave the tabindex for the lifetime of the
  // highlight so repeated reloads/Back-Forward can re-focus without
  // re-patching the DOM.
  const hadTabIndex = focusEl.hasAttribute('tabindex');
  if (!hadTabIndex) {
    focusEl.setAttribute('tabindex', '-1');
  }
  focusEl.focus({ preventScroll: false });
}

/**
 * Custom hook backing the deep-link highlight: owns the card ref and the
 * effect that scrolls the card into view and restores focus to the
 * target-specific anchor on reload/Back-Forward (VAL-CROSS-076,
 * VAL-CROSS-083). Extracted as a hook so `MissionRunCard`'s cyclomatic
 * complexity stays bounded.
 */
function useRunCardHighlight(
  highlighted: boolean | undefined,
  runId: string,
  target: MissionLinkTarget | undefined,
): React.Ref<HTMLElement> {
  const cardRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!highlighted) {
      return;
    }
    const cardEl = cardRef.current;
    if (cardEl) {
      restoreHighlightFocus(cardEl, runId, target);
    }
  }, [highlighted, target, runId]);
  return cardRef;
}

/**
 * Resolve the `data-target-kind` value for a highlighted card. Returns the
 * target kind discriminator, defaulting to `'run'` when no specific target
 * is present (VAL-CROSS-076, VAL-CROSS-083).
 */
function highlightTargetKind(target: MissionLinkTarget | undefined): string {
  return target?.kind ?? 'run';
}

/**
 * Whether a Retry control should be shown: only for terminal root runs that
 * failed or were cancelled (VAL-RUN-045). Extracted so `MissionRunCard`'s
 * cyclomatic complexity stays bounded.
 */
function isRetryEligible(status: string, isRootRun: boolean): boolean {
  return (status === 'failed' || status === 'cancelled') && isRootRun;
}
