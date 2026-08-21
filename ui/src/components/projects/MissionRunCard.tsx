import {
  useMissionRunSnapshot,
  useMissionRunEvents,
  useMissionRequestText,
  useMissionRunStream,
} from '@/lib/hooks';
import type { MissionRunSummary, MissionRunSnapshot, MissionReplayEvent } from '@/lib/api';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Activity,
  DollarSign,
  RefreshCw,
  WifiOff,
} from 'lucide-react';

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
 * Render an authoritative Mission run card with stable identity, textual
 * lifecycle status, chronological event timeline, budget state, and
 * terminal outcome details.
 *
 * The status comes from the authoritative run summary (server-provided). The
 * budget, terminal details, and cancellation indicator come from the full
 * snapshot. The event timeline comes from the journal replay. The browser
 * never infers or advances status; every visible field is server-authoritative.
 */
export function MissionRunCard({
  companyId,
  projectId,
  run,
  requestText,
}: {
  companyId: string;
  projectId: string;
  run: MissionRunSummary;
  requestText?: string;
}) {
  const snapshotQuery = useMissionRunSnapshot(companyId, projectId, run.id);
  const eventsQuery = useMissionRunEvents(companyId, projectId, run.id);
  // Request text from the start mutation cache (prop takes precedence).
  const cachedRequestText = useMissionRequestText(run.id);
  const displayRequestText = requestText ?? cachedRequestText;

  // SSE stream for real-time updates. Only connect for nonterminal runs.
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(run.status);
  const stream = useMissionRunStream(companyId, projectId, run.id, {
    enabled: !isTerminal,
  });

  const snapshot = snapshotQuery.data as MissionRunSnapshot | undefined;
  const events = (eventsQuery.data?.events ?? []) as MissionReplayEvent[];

  const statusText = statusToText(run.status);

  return (
    <article
      aria-labelledby={`run-heading-${run.id}`}
      className="rounded-xl border border-white/[0.06] bg-surface p-4"
    >
      <RunCardHeader run={run} statusText={statusText} />
      <RunCardRequest displayRequestText={displayRequestText} run={run} />
      <RunCardMeta run={run} snapshot={snapshot} />
      <RunCardStreamStatus stream={stream} isTerminal={isTerminal} />
      <RunCardQueueHealth snapshot={snapshot} status={run.status} />
      <RunCardStaleRead
        snapshotError={snapshotQuery.isError && !!snapshotQuery.data}
        eventsError={eventsQuery.isError && !!eventsQuery.data}
        onRetrySnapshot={() => snapshotQuery.refetch()}
        onRetryEvents={() => eventsQuery.refetch()}
      />
      <RunCardCancellationIndicator snapshot={snapshot} status={run.status} />
      <RunCardBudget snapshot={snapshot} />
      <RunCardFailure snapshot={snapshot} status={run.status} />
      <RunCardOutput snapshot={snapshot} status={run.status} />
      <RunCardTimeline events={events} eventsError={eventsQuery.isError && !!eventsQuery.data} />
    </article>
  );
}

/** Header with status icon, run ID heading, and textual status badge. */
function RunCardHeader({ run, statusText }: { run: MissionRunSummary; statusText: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <StatusIcon status={run.status} />
      <h3
        id={`run-heading-${run.id}`}
        className="text-sm font-semibold text-text-primary font-display"
      >
        {run.id}
      </h3>
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${badgeClass(statusBadgeVariant(run.status))}`}
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

/** Meta row: mode, creation time, and terminal timestamps. */
function RunCardMeta({ run, snapshot }: { run: MissionRunSummary; snapshot?: MissionRunSnapshot }) {
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(run.status);
  const terminalLabel =
    run.status === 'completed'
      ? 'Completed at: '
      : run.status === 'failed'
        ? 'Failed at: '
        : run.status === 'cancelled'
          ? 'Cancelled at: '
          : '';
  return (
    <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
      <span>
        Mode: <span className="text-text-secondary capitalize">{modeToText(run.resolvedMode)}</span>
      </span>
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

/** Stream status indicator: reconnecting, gap recovery, or stream error (VAL-RUN-031, VAL-RUN-030, VAL-CROSS-052). */
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
        <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
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
      <div className="flex gap-2">
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
      className="mb-3 rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 py-2"
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

/** Failed card: safe error message without secrets (VAL-RUN-045). */
function RunCardFailure({ snapshot, status }: { snapshot?: MissionRunSnapshot; status: string }) {
  if (status !== 'failed' || !snapshot?.safeErrorMessage) {
    return null;
  }
  return (
    <div className="mb-3 rounded-lg border border-error/20 bg-error/10 px-3 py-2">
      <p className="text-xs font-medium text-error mb-0.5">Failure</p>
      <p className="text-sm text-text-primary">{snapshot.safeErrorMessage}</p>
      {snapshot.failureCategory && (
        <p className="mt-1 text-xs text-text-muted">Category: {snapshot.failureCategory}</p>
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
          <li key={i} className="text-sm text-accent">
            {/* Artifacts are never[] in Phase 1; placeholder for future */}
            {String(a)}
          </li>
        ))}
      </ul>
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
              <span className="text-text-primary">{event.type}</span>
              <time dateTime={event.occurredAt} className="ml-auto text-text-muted">
                {formatTime(event.occurredAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </div>
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
