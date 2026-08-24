import { useEffect, useRef, useState } from 'react';
import { useMissionCurrentPlanRevision } from '@/lib/hooks';
import type {
  MissionPlanRevision,
  MissionPlanStep,
  MissionRunSnapshot,
  MissionReplayEvent,
} from '@/lib/api';
import { CheckCircle2, XCircle, Clock, Activity, Ban } from 'lucide-react';

/**
 * MissionStepProgress — renders approved plan step progress and outcomes
 * consistently, derived from the authoritative run snapshot and ordered
 * event journal (VAL-PLAN-067, 068, 069, 070, 071, 072, 073, 074, 065).
 *
 * The browser never invents step status. Each step's displayed status is
 * derived from committed journal events (child.started, child.completed,
 * child.failed, child.cancel_requested, execution.progress) matched by
 * `stepKey`, plus the snapshot's aggregate `childSummary`, failure fields,
 * `partialResultPolicy`, and `resultCompleteness`. When no execution event
 * exists for a step, it renders `Pending` — the honest authoritative state
 * for an approved plan that has not yet started that step.
 *
 * The progress is governed by the immutable approved revision and content
 * hash; failure or retry cannot alter the approved scope
 * (VAL-PLAN-074). The revision number and hash prefix are always visible so
 * cross-surface navigation preserves the plan context (VAL-PLAN-065).
 *
 * Accessibility:
 * - A semantic ordered list (`<ol>`) preserves approved step order.
 * - Each status is conveyed with explicit text and an icon, never color
 *   alone (VAL-RUN-092, VAL-PLAN-083).
 * - A batched polite `aria-live` region announces meaningful status
 *   changes without per-event noise (VAL-PLAN-084, VAL-RUN-089).
 * - Animated indicators respect `prefers-reduced-motion` (VAL-RUN-093).
 * - The layout reflows at narrow mobile viewports (VAL-RUN-094,
 *   VAL-PLAN-089).
 */

/** Derived per-step execution status. */
type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Human-readable status text (never color alone). */
function statusText(status: StepStatus): string {
  switch (status) {
    case 'pending':
      return 'Pending';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Status icon paired with text (never color alone). */
function StepStatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-error" aria-hidden="true" />;
    case 'cancelled':
      return <Ban className="h-4 w-4 text-warning" aria-hidden="true" />;
    case 'running':
      return (
        <Activity
          className="h-4 w-4 text-neon-cyan animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        />
      );
    default:
      return <Clock className="h-4 w-4 text-text-muted" aria-hidden="true" />;
  }
}

/** Badge color class for a status (text always accompanies color). */
function statusBadgeClass(status: StepStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-success/10 text-success border-success/20';
    case 'failed':
      return 'bg-error/10 text-error border-error/20';
    case 'cancelled':
      return 'bg-warning/10 text-warning border-warning/20';
    case 'running':
      return 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20';
    default:
      return 'bg-white/[0.06] text-text-secondary border-white/[0.08]';
  }
}

/** Format integer cents as a currency string. */
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Per-step derived execution outcome from the event journal. */
interface StepOutcome {
  status: StepStatus;
  /** Producing agent ID from the child event payload or plan routing. */
  agentId: string | null;
  /** Actual cost in integer cents from child.completed payload. */
  costCents: number | null;
  /** Output summary from child.completed payload. */
  outputSummary: string | null;
  /** Safe failure message from child.failed payload. */
  safeErrorMessage: string | null;
  /** Failure category from child.failed payload. */
  failureCategory: string | null;
  /** Failure code from child.failed payload. */
  failureCode: string | null;
}

/**
 * Derive per-step execution outcomes from the ordered event journal.
 *
 * Scans committed events for child.started, child.completed, child.failed,
 * child.cancel_requested, and execution.progress, matched by `stepKey`. The
 * last event for a step wins (events are ordered by sequence). A step with
 * no matching event is `pending`.
 *
 * This is a pure projection of authoritative events — the browser never
 * advances status on its own (VAL-PLAN-067).
 */

/** Default pending outcome for a step with no matching events. */
function pendingOutcome(): StepOutcome {
  return {
    status: 'pending' as StepStatus,
    agentId: null,
    costCents: null,
    outputSummary: null,
    safeErrorMessage: null,
    failureCategory: null,
    failureCode: null,
  };
}

/** Apply one journal event to a single step outcome, returning the new outcome. */
function applyEventToOutcome(prev: StepOutcome, event: MissionReplayEvent): StepOutcome {
  const payload = event.payload;
  if (event.type === 'child.completed') {
    return {
      ...prev,
      status: 'completed',
      agentId: (payload.agentId as string | undefined) ?? prev.agentId,
      costCents: (payload.costCents as number | undefined) ?? prev.costCents,
      outputSummary: (payload.outputSummary as string | undefined) ?? prev.outputSummary,
    };
  }
  if (event.type === 'child.failed') {
    return {
      ...prev,
      status: 'failed',
      agentId: (payload.agentId as string | undefined) ?? prev.agentId,
      safeErrorMessage: (payload.safeErrorMessage as string | undefined) ?? prev.safeErrorMessage,
      failureCategory: (payload.failureCategory as string | undefined) ?? prev.failureCategory,
      failureCode: (payload.failureCode as string | undefined) ?? prev.failureCode,
    };
  }
  if (event.type === 'child.cancel_requested') {
    if (prev.status === 'completed' || prev.status === 'failed') {
      return prev;
    }
    return { ...prev, status: 'cancelled' };
  }
  // child.started / execution.progress: advance to running only if not terminal.
  if (event.type === 'child.started' || event.type === 'execution.progress') {
    if (prev.status === 'completed' || prev.status === 'failed' || prev.status === 'cancelled') {
      return prev;
    }
    return {
      ...prev,
      status: 'running',
      agentId: (payload.agentId as string | undefined) ?? prev.agentId,
    };
  }
  return prev;
}

function deriveStepOutcomes(events: MissionReplayEvent[]): Map<string, StepOutcome> {
  const outcomes = new Map<string, StepOutcome>();
  for (const event of events) {
    const stepKey = (event.payload?.stepKey as string | undefined) ?? undefined;
    if (!stepKey) {
      continue;
    }
    const prev = outcomes.get(stepKey) ?? pendingOutcome();
    outcomes.set(stepKey, applyEventToOutcome(prev, event));
  }
  return outcomes;
}

/**
 * Batched status announcement for the polite live region. Announces only
 * meaningful aggregate state changes (running count, terminal outcomes),
 * not per-event progress noise (VAL-PLAN-084, VAL-RUN-089).
 */
function useBatchedStepAnnouncement(
  runId: string,
  runningCount: number,
  completedCount: number,
  failedCount: number,
): string {
  const [announcement, setAnnouncement] = useState('');
  const prevRef = useRef({ running: -1, completed: -1, failed: -1 });
  useEffect(() => {
    const prev = prevRef.current;
    if (
      prev.running === runningCount &&
      prev.completed === completedCount &&
      prev.failed === failedCount
    ) {
      return;
    }
    // Only announce meaningful changes, not the initial mount.
    if (prev.running !== -1) {
      const parts: string[] = [];
      if (runningCount !== prev.running) {
        parts.push(`${runningCount} step${runningCount === 1 ? '' : 's'} running`);
      }
      if (completedCount !== prev.completed) {
        parts.push(`${completedCount} completed`);
      }
      if (failedCount !== prev.failed) {
        parts.push(`${failedCount} failed`);
      }
      if (parts.length > 0) {
        setAnnouncement(`Mission ${runId}: ${parts.join(', ')}`);
      }
    }
    prevRef.current = { running: runningCount, completed: completedCount, failed: failedCount };
  }, [runId, runningCount, completedCount, failedCount]);
  return announcement;
}

export function MissionStepProgress({
  companyId,
  projectId,
  runId,
  currentPlanRevisionId,
  snapshot,
  events,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  /** Current plan revision pointer (equals the approved revision during
   *  execution). When null, the run has no approved plan to track. */
  currentPlanRevisionId: string | null | undefined;
  /** Authoritative run snapshot. */
  snapshot: MissionRunSnapshot;
  /** Ordered journal events for the run. */
  events: MissionReplayEvent[];
}) {
  const planQuery = useMissionCurrentPlanRevision(
    companyId,
    projectId,
    runId,
    currentPlanRevisionId,
  );

  // Only render when an approved plan exists. During execution the current
  // revision equals the approved one; after a queued revision the run
  // returns to planning and there is no execution progress to show.
  if (!snapshot.approvedPlanRevisionId) {
    return null;
  }

  const revision = planQuery.data as MissionPlanRevision | null | undefined;
  if (!revision) {
    return null;
  }

  const outcomes = deriveStepOutcomes(events);
  const steps = revision.content.steps;
  const completedStepKeys = new Set(
    steps
      .filter((s) => (outcomes.get(s.stepKey)?.status ?? 'pending') === 'completed')
      .map((s) => s.stepKey),
  );

  const runningCount = steps.filter(
    (s) => (outcomes.get(s.stepKey)?.status ?? 'pending') === 'running',
  ).length;
  const completedCount = completedStepKeys.size;
  const failedCount = steps.filter(
    (s) => (outcomes.get(s.stepKey)?.status ?? 'pending') === 'failed',
  ).length;

  const fanOut = revision.content.limits.fanOut ?? 0;
  const announcement = useBatchedStepAnnouncement(runId, runningCount, completedCount, failedCount);

  const hashPrefix = revision.contentHash.slice(0, 12);
  const partialPolicy = revision.content.partialResultPolicy;
  const resultCompleteness = snapshot.resultCompleteness;

  return (
    <section
      id={`mission-step-progress-${runId}`}
      data-testid="mission-step-progress"
      aria-labelledby={`step-progress-heading-${runId}`}
      className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 w-full max-w-full break-words overflow-hidden"
    >
      <span
        role="status"
        aria-live="polite"
        data-testid="step-progress-live-region"
        className="sr-only"
      >
        {announcement}
      </span>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4
          id={`step-progress-heading-${runId}`}
          className="text-sm font-semibold text-text-primary font-display"
        >
          Step progress
        </h4>
        <span className="text-xs text-text-muted" data-testid="step-progress-revision">
          Revision {revision.revision}
        </span>
        <span
          className="text-xs text-text-muted font-mono break-all"
          data-testid="step-progress-hash"
        >
          {hashPrefix}
        </span>
      </div>

      {/* Bounded parallel progress indicator (VAL-PLAN-069). */}
      {runningCount > 0 && (
        <p className="mb-2 text-xs text-text-secondary" data-testid="step-parallel-progress">
          {runningCount} step{runningCount === 1 ? '' : 's'} running (fan-out limit: {fanOut})
        </p>
      )}

      <ol aria-label="Approved step progress" className="space-y-2">
        {steps.map((step, index) => (
          <StepProgressItem
            key={step.stepKey}
            step={step}
            ordinal={index + 1}
            outcome={
              outcomes.get(step.stepKey) ?? {
                status: 'pending' as StepStatus,
                agentId: null,
                costCents: null,
                outputSummary: null,
                safeErrorMessage: null,
                failureCategory: null,
                failureCode: null,
              }
            }
            completedStepKeys={completedStepKeys}
          />
        ))}
      </ol>

      {/* Partial-result labeling (VAL-PLAN-073). */}
      {resultCompleteness === 'partial' && (
        <p
          className="mt-3 text-xs text-warning"
          role="status"
          data-testid="step-progress-partial-result"
        >
          Result: partial — some steps did not complete successfully (policy:{' '}
          {partialPolicy === 'best_effort' ? 'best effort' : 'require all'}).
        </p>
      )}

      {/* Immutable scope notice (VAL-PLAN-074). */}
      <p className="mt-2 text-xs text-text-muted" data-testid="step-progress-scope-notice">
        Progress follows approved revision {revision.revision}. Failure or retry does not alter the
        approved scope.
      </p>
    </section>
  );
}

/** One step's progress row with status, dependencies, agent, tools, cost, and output. */
function StepProgressItem({
  step,
  ordinal,
  outcome,
  completedStepKeys,
}: {
  step: MissionPlanStep;
  ordinal: number;
  outcome: StepOutcome;
  completedStepKeys: Set<string>;
}) {
  const unmetDeps = step.dependencies.filter((d) => !completedStepKeys.has(d));
  const isWaiting = outcome.status === 'pending' && unmetDeps.length > 0;
  const agentId =
    outcome.agentId ??
    (step.routing.kind === 'concreteAgent' ? step.routing.executingAgentId : null);

  return (
    <li
      className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 w-full max-w-full min-w-0 break-words overflow-hidden"
      aria-label={`Step ${ordinal}: ${step.title}`}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1 min-w-0">
        <StepStatusIcon status={outcome.status} />
        <span className="text-xs tabular-nums text-text-muted shrink-0">{ordinal}.</span>
        <h5 className="text-sm font-medium text-text-primary break-words min-w-0">{step.title}</h5>
        <span
          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(outcome.status)}`}
          data-testid={`step-status-${outcome.status}`}
        >
          {statusText(outcome.status)}
        </span>
        <code className="text-xs text-text-muted font-mono break-all">{step.stepKey}</code>
      </div>

      {/* Dependency gating (VAL-PLAN-068). */}
      {isWaiting && (
        <p
          className="text-xs text-text-secondary mb-1.5 break-words"
          data-testid="dependency-gating"
        >
          Waiting on: {unmetDeps.join(', ')}
        </p>
      )}

      {/* Producing agent (VAL-PLAN-070). */}
      {agentId && (
        <p className="text-xs text-text-secondary mb-1 break-words">
          Agent: <span className="text-text-primary">{agentId}</span>
        </p>
      )}

      {/* Tools from the approved plan allowlist (VAL-PLAN-070). */}
      {step.toolAllowlist.length > 0 && (
        <p className="text-xs text-text-secondary mb-1 break-words">
          Tools:{' '}
          {step.toolAllowlist.map((tool, i) => (
            <span key={tool}>
              <span className="text-text-primary font-mono break-all">{tool}</span>
              {i < step.toolAllowlist.length - 1 ? (
                <span className="text-text-muted">, </span>
              ) : null}
            </span>
          ))}
        </p>
      )}

      {/* Actual cost from the child.completed event (VAL-PLAN-070). */}
      {outcome.costCents !== null && outcome.costCents > 0 && (
        <p className="text-xs text-text-secondary mb-1 break-words" data-testid="step-cost">
          Cost:{' '}
          <span className="tabular-nums text-text-primary">{formatCents(outcome.costCents)}</span>
        </p>
      )}

      {/* Output summary from child.completed (VAL-PLAN-070). */}
      {outcome.outputSummary && (
        <p className="text-xs text-text-secondary mb-1 break-words" data-testid="step-output">
          Output: <span className="text-text-primary">{outcome.outputSummary}</span>
        </p>
      )}

      {/* Explicit step failure (VAL-PLAN-071). */}
      {outcome.status === 'failed' && outcome.safeErrorMessage && (
        <div
          role="alert"
          className="mt-1 rounded-md border border-error/20 bg-error/10 px-2 py-1.5"
        >
          <p className="text-xs text-error font-medium mb-0.5">Step failed</p>
          <p className="text-sm text-text-primary break-words">{outcome.safeErrorMessage}</p>
          {outcome.failureCategory && (
            <p className="mt-0.5 text-xs text-text-primary">Category: {outcome.failureCategory}</p>
          )}
          {outcome.failureCode && (
            <p className="mt-0.5 text-xs text-text-primary">Code: {outcome.failureCode}</p>
          )}
        </div>
      )}
    </li>
  );
}
