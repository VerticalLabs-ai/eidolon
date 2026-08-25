import { useEffect, useMemo, useRef, useState } from 'react';
import { useMissionRunSources } from '@/lib/hooks';
import type { MissionReplayEvent, MissionSourceSummary } from '@/lib/api';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Activity,
  Ban,
  FileSearch,
  Loader2,
  RefreshCw,
} from 'lucide-react';

/**
 * MissionResearchSources — provider-neutral research progress, source
 * states, warnings, errors, and inert rendering for a Mission run.
 *
 * (architecture.md: Research and Evidence-Bearing Artifacts; feature
 *  m5-f09-research-progress-source-ui; VAL-RES-001, VAL-RES-016,
 *  VAL-RES-017, VAL-RES-018, VAL-RES-041, VAL-RES-047, VAL-RES-076,
 *  VAL-RES-105, VAL-RES-117, VAL-CROSS-030.)
 *
 * The browser never invents source state, authority, citations, or
 * completion. Source cards derive from the authoritative
 * `GET /:runId/sources` summary; research lifecycle progress derives from
 * the ordered journal events (`research.*`). Provider names (Tavily,
 * Firecrawl) appear only as bounded provenance metadata, never as
 * provider-specific controls, credentials, or raw payloads.
 *
 * All source title/author/quote/URL/warning/risk-label text is untrusted
 * data and rendered inert — never concatenated into instructions, never
 * parsed as HTML, never auto-navigated. Genuine validated safe HTTPS links
 * remain operable (VAL-RES-117); citation navigation is owned by the
 * citation feature (m5-f14), so source URLs render as inert text here.
 *
 * Accessibility:
 * - Semantic ordered lists preserve causal/chronological order.
 * - Each source state is conveyed with explicit text + icon, never color
 *   alone (VAL-RES-018, VAL-RUN-092).
 * - High-risk warnings use `role="alert"`; meaningful progress changes use
 *   a polite `aria-live` region (VAL-RES-082, VAL-RUN-089).
 * - Animated indicators respect `prefers-reduced-motion` (VAL-RES-085).
 * - The layout reflows at narrow mobile viewports (VAL-RES-106).
 */

// ── Source state model ───────────────────────────────────────────────────

/** Terminal run statuses (a terminal run surfaces its own failure card). */
const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Externally reachable source states (VAL-RES-018). */
export type SourceState =
  'discovered' | 'retrieving' | 'retrieved' | 'excluded' | 'failed' | 'unavailable';

/** Human-readable text for a source state (never color alone). */
export function sourceStateText(state: SourceState): string {
  switch (state) {
    case 'discovered':
      return 'Discovered';
    case 'retrieving':
      return 'Retrieving';
    case 'retrieved':
      return 'Retrieved';
    case 'excluded':
      return 'Excluded';
    case 'failed':
      return 'Failed';
    case 'unavailable':
      return 'Unavailable';
  }
}

/** Whether a source revision carries retrieved content. */
function hasContent(s: MissionSourceSummary): boolean {
  return (!!s.contentHash && s.contentHash.length > 0) || s.byteCount > 0;
}

/** Classify a single authoritative source summary into a source state. */
function classifySource(
  s: MissionSourceSummary,
  discoveredIds: Set<string>,
  retrievedEventIds: Set<string>,
  failedIds: Set<string>,
): SourceState {
  if (s.excluded || s.status === 'excluded') {
    return 'excluded';
  }
  if (s.latestAvailabilityStatus === 'unavailable') {
    return 'unavailable';
  }
  if (failedIds.has(s.sourceRevisionId) && !hasContent(s)) {
    return 'failed';
  }
  if (hasContent(s)) {
    return 'retrieved';
  }
  if (discoveredIds.has(s.sourceRevisionId) && !retrievedEventIds.has(s.sourceRevisionId)) {
    return 'retrieving';
  }
  return 'discovered';
}

/** Collect discovery/retrieval/failure sourceRevisionIds from research events. */
function collectResearchSourceEventIds(events: MissionReplayEvent[]): {
  discoveredIds: Set<string>;
  retrievedEventIds: Set<string>;
  failedIds: Set<string>;
} {
  const discoveredIds = new Set<string>();
  const retrievedEventIds = new Set<string>();
  const failedIds = new Set<string>();
  for (const e of events) {
    if (
      e.type !== 'research.source_discovered' &&
      e.type !== 'research.source_retrieved' &&
      e.type !== 'research.failed'
    ) {
      continue;
    }
    const id = (e.payload?.sourceRevisionId as string | undefined) ?? undefined;
    if (!id) {
      continue;
    }
    if (e.type === 'research.source_discovered') {
      discoveredIds.add(id);
    } else if (e.type === 'research.source_retrieved') {
      retrievedEventIds.add(id);
    } else {
      failedIds.add(id);
    }
  }
  return { discoveredIds, retrievedEventIds, failedIds };
}

/** Set of research lifecycle event types rendered in the progress list. */
const RESEARCH_EVENT_TYPES = new Set([
  'research.started',
  'research.provider_attempted',
  'research.source_discovered',
  'research.source_retrieved',
  'research.provider_fallback',
  'research.completed',
  'research.failed',
]);

/** A derived source state entry, merged from authoritative summaries + events. */
export interface DerivedSourceState {
  sourceRevisionId: string;
  state: SourceState;
  /** Whether this entry comes from an event placeholder (no persisted summary). */
  fromEvent: boolean;
}

/**
 * Derive per-source states from authoritative source summaries overlaid
 * with research lifecycle events. Pure projection — the browser never
 * advances authority on its own (VAL-RES-018, VAL-RES-041).
 *
 * Priority per source revision: excluded > unavailable > failed >
 * retrieved > retrieving > discovered. Event placeholders render
 * in-flight (`retrieving`) or `failed` discoveries not yet persisted so
 * those states are visible without fabricating content (VAL-RES-041,
 * VAL-RES-105).
 */
export function deriveSourceStates(
  sources: MissionSourceSummary[],
  events: MissionReplayEvent[],
): DerivedSourceState[] {
  const { discoveredIds, retrievedEventIds, failedIds } = collectResearchSourceEventIds(events);
  const out: DerivedSourceState[] = [];

  // Authoritative summaries first (stable rank order).
  for (const s of sources) {
    out.push({
      sourceRevisionId: s.sourceRevisionId,
      state: classifySource(s, discoveredIds, retrievedEventIds, failedIds),
      fromEvent: false,
    });
  }

  // Event placeholders for in-flight / failed discoveries not yet persisted.
  const seen = new Set(sources.map((s) => s.sourceRevisionId));
  for (const id of discoveredIds) {
    if (seen.has(id)) {
      continue;
    }
    out.push({
      sourceRevisionId: id,
      state: failedIds.has(id) ? 'failed' : 'retrieving',
      fromEvent: true,
    });
  }
  for (const id of failedIds) {
    if (seen.has(id) || discoveredIds.has(id)) {
      continue;
    }
    out.push({ sourceRevisionId: id, state: 'failed', fromEvent: true });
  }

  return out;
}

// ── Research progress events ─────────────────────────────────────────────

interface ResearchProgressItem {
  sequence: number;
  type: string;
  label: string;
  /** Bounded provider metadata text, if any (provider-neutral display). */
  metadata?: string;
}

/** Human-readable, provider-neutral label for a research lifecycle event. */
function researchEventLabel(type: string): string {
  switch (type) {
    case 'research.started':
      return 'Research started';
    case 'research.provider_attempted':
      return 'Provider attempt';
    case 'research.source_discovered':
      return 'Source discovered';
    case 'research.source_retrieved':
      return 'Source retrieved';
    case 'research.provider_fallback':
      return 'Provider fallback';
    case 'research.completed':
      return 'Research completed';
    case 'research.failed':
      return 'Research failed';
    default:
      return type;
  }
}

/** Build the bounded provider metadata string for an event (metadata only). */
function researchEventMetadata(event: MissionReplayEvent): string | undefined {
  const p = event.payload ?? {};
  if (event.type === 'research.provider_attempted') {
    const provider = (p.provider as string | undefined) ?? undefined;
    const operation = (p.operation as string | undefined) ?? undefined;
    if (provider && operation) {
      return `${provider} · ${operation}`;
    }
    return provider ?? operation;
  }
  if (event.type === 'research.provider_fallback') {
    const from = (p.fromProvider as string | undefined) ?? undefined;
    const to = (p.toProvider as string | undefined) ?? undefined;
    const reason = (p.reason as string | undefined) ?? undefined;
    const parts = [from && to ? `${from} → ${to}` : (to ?? from), reason].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    return parts.length > 0 ? parts.join(' · ') : undefined;
  }
  if (event.type === 'research.completed') {
    const count = (p.sourceCount as number | undefined) ?? undefined;
    if (typeof count === 'number') {
      return `${count} source${count === 1 ? '' : 's'}`;
    }
    return undefined;
  }
  return undefined;
}

/** Filter and order research lifecycle events by sequence (causal order). */
function buildResearchProgress(events: MissionReplayEvent[]): ResearchProgressItem[] {
  return events
    .filter((e) => RESEARCH_EVENT_TYPES.has(e.type))
    .sort((a, b) => a.sequence - b.sequence)
    .map((e) => ({
      sequence: e.sequence,
      type: e.type,
      label: researchEventLabel(e.type),
      metadata: researchEventMetadata(e),
    }));
}

// ── Research progress section ────────────────────────────────────────────

/**
 * Render research lifecycle progress as a semantic ordered list in causal
 * order. Provider-neutral labels; provider names appear only as bounded
 * metadata (VAL-RES-016, VAL-CROSS-030, VAL-RES-001).
 */
export function MissionResearchProgress({
  events,
  runId,
}: {
  events: MissionReplayEvent[];
  runId: string;
}) {
  const items = useMemo(() => buildResearchProgress(events), [events]);
  if (items.length === 0) {
    return null;
  }
  return (
    <section
      className="mb-3 w-full max-w-full break-words"
      aria-labelledby={`research-progress-heading-${runId}`}
      data-testid="mission-research-progress"
    >
      <h4
        id={`research-progress-heading-${runId}`}
        className="text-xs font-medium text-text-secondary mb-1"
      >
        Research progress
      </h4>
      <ol aria-label="Research progress" className="space-y-1">
        {items.map((item) => (
          <li
            key={`${item.sequence}-${item.type}`}
            className="flex items-baseline gap-2 text-xs text-text-muted"
          >
            <span className="tabular-nums text-text-secondary w-6 shrink-0">{item.sequence}</span>
            <span className="text-text-primary break-words">{item.label}</span>
            {item.metadata && (
              <span
                className="text-text-muted break-words"
                data-testid="research-progress-metadata"
              >
                {item.metadata}
              </span>
            )}
            <time
              dateTime={events.find((e) => e.sequence === item.sequence)?.occurredAt ?? ''}
              className="ml-auto text-text-muted shrink-0"
            >
              {formatTime(events.find((e) => e.sequence === item.sequence)?.occurredAt ?? '')}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ── Source list section ──────────────────────────────────────────────────

/** Status icon paired with text (never color alone). */
function SourceStateIcon({ state }: { state: SourceState }) {
  switch (state) {
    case 'retrieved':
      return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-error" aria-hidden="true" />;
    case 'excluded':
      return <Ban className="h-4 w-4 text-warning" aria-hidden="true" />;
    case 'unavailable':
      return <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />;
    case 'retrieving':
      return (
        <Loader2
          className="h-4 w-4 text-neon-cyan animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      );
    case 'discovered':
      return <FileSearch className="h-4 w-4 text-neon-cyan" aria-hidden="true" />;
  }
}

/** Badge color class for a state (text always accompanies color). */
function stateBadgeClass(state: SourceState): string {
  switch (state) {
    case 'retrieved':
      return 'bg-success/10 text-success border-success/20';
    case 'failed':
      return 'bg-error/10 text-error border-error/20';
    case 'excluded':
    case 'unavailable':
      return 'bg-warning/10 text-warning border-warning/20';
    case 'retrieving':
    case 'discovered':
      return 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20';
  }
}

/** Format an ISO timestamp as a readable date-time string. */
function formatTime(iso: string): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A failed research entry derived from a `research.failed` event. */
interface FailedResearchEntry {
  sequence: number;
  failureCategory?: string;
  failureCode?: string;
  safeErrorMessage?: string;
}

/** Extract failed research entries from events (distinct error states). */
function deriveFailedResearch(events: MissionReplayEvent[]): FailedResearchEntry[] {
  return events
    .filter((e) => e.type === 'research.failed')
    .sort((a, b) => a.sequence - b.sequence)
    .map((e) => ({
      sequence: e.sequence,
      failureCategory: (e.payload?.failureCategory as string | undefined) ?? undefined,
      failureCode: (e.payload?.failureCode as string | undefined) ?? undefined,
      safeErrorMessage: (e.payload?.safeErrorMessage as string | undefined) ?? undefined,
    }));
}

/** Whether any source summary carries a high-risk label or warning. */
function hasHighRisk(s: MissionSourceSummary): boolean {
  return s.injectionRiskLabels.length > 0 || s.warnings.length > 0;
}

/** Recovery guidance text for a research failure category (VAL-RES-105). */
function recoveryGuidance(category?: string): string {
  switch (category) {
    case 'provider_transient':
    case 'tool_failed':
      return 'The run may retry automatically within its bounds; reload to see updated progress.';
    case 'budget':
      return 'Research budget was exhausted; no further paid research will start.';
    case 'policy':
      return 'Research was denied by policy; adjust the request or contact an owner.';
    case 'authorization':
      return 'Research credentials are unavailable; contact an owner to configure provider access.';
    case 'limit':
      return 'A research limit was reached; no further research will start.';
    case 'cancellation':
      return 'Research was cancelled; no further work will start.';
    default:
      return 'Retry may be available from the run controls; reload to see updated progress.';
  }
}

/**
 * Render provider-neutral research source cards with distinct, non-color
 * states, high-risk warnings, distinct actionable error states, and inert
 * untrusted-content rendering.
 */
export function MissionSourceList({
  companyId,
  projectId,
  runId,
  events,
  partialResultPolicy,
  runStatus,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  /** Ordered journal events for the run (research.* drive progress/states). */
  events: MissionReplayEvent[];
  /** Authoritative partial-result policy from the run snapshot. */
  partialResultPolicy: string;
  /** Authoritative run status from the snapshot. */
  runStatus: string;
}) {
  const sourcesQuery = useMissionRunSources(companyId, projectId, runId);
  const sources = (sourcesQuery.data?.sources ?? []) as MissionSourceSummary[];

  const derived = useMemo(() => deriveSourceStates(sources, events), [sources, events]);
  const failedEntries = useMemo(() => deriveFailedResearch(events), [events]);

  // Batched polite announcement for meaningful source-count changes only
  // (VAL-RES-082, VAL-RUN-089). No per-event noise.
  const announcement = useBatchedSourceAnnouncement(runId, derived);

  const isLoading = sourcesQuery.isLoading && !sourcesQuery.data;
  const staleError = sourcesQuery.isError && !!sourcesQuery.data;

  // Partial-evidence warning under best_effort when at least one source is
  // unavailable/failed and at least one is retrieved, and only while the run
  // is still nonterminal (a terminal failed run surfaces its own failure
  // card) (VAL-RES-041, VAL-RES-043). Never claim partial success under
  // require_all.
  const showPartialWarning = useMemo(() => {
    if (partialResultPolicy !== 'best_effort') {
      return false;
    }
    if (TERMINAL_RUN_STATUSES.has(runStatus)) {
      return false;
    }
    const hasGood = derived.some((d) => d.state === 'retrieved');
    const hasGap = derived.some((d) => d.state === 'unavailable' || d.state === 'failed');
    return hasGood && hasGap;
  }, [derived, partialResultPolicy, runStatus]);

  if (isLoading) {
    return (
      <section
        className="mb-3 w-full max-w-full break-words"
        aria-labelledby={`research-sources-heading-${runId}`}
        data-testid="mission-sources-loading"
      >
        <h4
          id={`research-sources-heading-${runId}`}
          className="text-xs font-medium text-text-secondary mb-1"
        >
          Research sources
        </h4>
        <p className="text-xs text-text-secondary flex items-center gap-1.5" aria-live="polite">
          <Activity
            className="h-3.5 w-3.5 animate-pulse motion-reduce:animate-none"
            aria-hidden="true"
          />
          Loading sources…
        </p>
      </section>
    );
  }

  const hasContent = derived.length > 0 || failedEntries.length > 0;

  return (
    <section
      id={`mission-sources-${runId}`}
      className="mb-3 w-full max-w-full break-words"
      aria-labelledby={`research-sources-heading-${runId}`}
      data-testid="mission-sources"
    >
      <span className="sr-only" aria-live="polite">
        {announcement}
      </span>
      <div className="flex items-center gap-1.5 mb-1">
        <h4
          id={`research-sources-heading-${runId}`}
          className="text-xs font-medium text-text-secondary"
        >
          Research sources
        </h4>
        {derived.length > 0 && (
          <span className="text-xs text-text-muted tabular-nums">({derived.length})</span>
        )}
      </div>

      {staleError && (
        <div className="mb-2 rounded-lg border border-warning/20 bg-warning/5 px-3 py-2">
          <p className="text-xs text-warning mb-1.5" aria-live="polite">
            Some source data may be outdated due to a connection issue.
          </p>
          <button
            type="button"
            onClick={() => sourcesQuery.refetch()}
            aria-label="Retry loading sources"
            className="inline-flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/20 focus-visible:ring-2 focus-visible:ring-warning/40 focus-visible:outline-none motion-reduce:transition-none"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Retry sources
          </button>
        </div>
      )}

      {showPartialWarning && (
        <div
          className="mb-2 rounded-lg border border-warning/20 bg-warning/[0.04] px-3 py-2"
          aria-live="polite"
          data-testid="sources-partial-warning"
        >
          <p className="text-xs text-warning">
            Partial evidence — some sources are unavailable or failed. Synthesis may proceed only
            with the successful sources under best-effort policy.
          </p>
        </div>
      )}

      {hasContent && (
        <ol aria-label="Research sources" className="space-y-2">
          {derived.map((d) => {
            const s = byIdMap(sources).get(d.sourceRevisionId);
            return <SourceCard key={d.sourceRevisionId} derived={d} source={s} />;
          })}
          {failedEntries.map((f) => (
            <FailedResearchCard key={`failed-${f.sequence}`} entry={f} />
          ))}
        </ol>
      )}

      {!hasContent && !staleError && (
        <p className="text-xs text-text-muted">No research sources yet.</p>
      )}
    </section>
  );
}

/** Build a sourceRevisionId → summary map (memoized helper). */
function byIdMap(sources: MissionSourceSummary[]): Map<string, MissionSourceSummary> {
  const m = new Map<string, MissionSourceSummary>();
  for (const s of sources) {
    m.set(s.sourceRevisionId, s);
  }
  return m;
}

/** One provider-neutral source card with inert text rendering. */
function SourceCard({
  derived,
  source,
}: {
  derived: DerivedSourceState;
  source: MissionSourceSummary | undefined;
}) {
  const state = derived.state;
  const id = `mission-source-revision-${derived.sourceRevisionId}`;
  const highRisk = source ? hasHighRisk(source) : false;

  return (
    <li
      id={id}
      className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 w-full max-w-full break-words"
      aria-label={`Research source ${derived.sourceRevisionId}, ${sourceStateText(state)}`}
    >
      <SourceCardHeader state={state} source={source} />
      <SourceCardDetails source={source} />
      {highRisk && source && <SourceHighRiskWarning source={source} />}
    </li>
  );
}

/** Header: state icon/badge, provider metadata, rank. */
function SourceCardHeader({
  state,
  source,
}: {
  state: SourceState;
  source: MissionSourceSummary | undefined;
}) {
  const providerLabel = source?.provider;
  const operationLabel = source?.operation;
  const rank = source?.rank;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-1">
      <SourceStateIcon state={state} />
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${stateBadgeClass(state)}`}
      >
        {sourceStateText(state)}
      </span>
      {/* Provider name as bounded provenance metadata only (VAL-RES-001,
          VAL-CROSS-030, VAL-RES-076). Never a control or credential. */}
      {providerLabel && (
        <span
          className="text-xs text-text-muted break-words"
          data-testid="source-provider-metadata"
        >
          Provider: <span className="text-text-secondary">{providerLabel}</span>
          {operationLabel && <span className="text-text-muted"> · {operationLabel}</span>}
        </span>
      )}
      {typeof rank === 'number' && (
        <span className="text-xs text-text-muted tabular-nums">Rank {rank}</span>
      )}
    </div>
  );
}

/** Details: inert canonical URL, byte count, timestamps, exclusion reason. */
function SourceCardDetails({ source }: { source: MissionSourceSummary | undefined }) {
  const canonicalUrl = source?.canonicalUrl ?? '';
  const byteCount = source?.byteCount;
  const retrievedAt = source?.retrievedAt ?? '';
  const exclusionReason = source?.exclusionReason;
  const availabilityCheckedAt = source?.latestAvailabilityCheckedAt ?? null;
  return (
    <>
      {/* Canonical URL rendered as inert text (VAL-RES-117). Never parsed as
          HTML, never auto-navigated; dir=ltr defends against bidi spoofing. */}
      {canonicalUrl && (
        <p
          dir="ltr"
          className="text-xs text-text-secondary break-all font-mono"
          data-testid="source-canonical-url"
        >
          {canonicalUrl}
        </p>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-muted mt-1">
        {typeof byteCount === 'number' && byteCount > 0 && (
          <span>{byteCount.toLocaleString()} bytes</span>
        )}
        {retrievedAt && (
          <span>
            Retrieved: <time dateTime={retrievedAt}>{formatTime(retrievedAt)}</time>
          </span>
        )}
        {availabilityCheckedAt && (
          <span>
            Last availability check:{' '}
            <time dateTime={availabilityCheckedAt}>{formatTime(availabilityCheckedAt)}</time>
          </span>
        )}
      </div>
      {/* Exclusion reason rendered as inert text (VAL-RES-018, VAL-RES-047). */}
      {exclusionReason && (
        <p
          className="text-xs text-text-muted mt-1 break-words"
          data-testid="source-exclusion-reason"
        >
          Excluded: {exclusionReason}
        </p>
      )}
    </>
  );
}

/** High-risk content warning: explicit, accessible, never silent (VAL-RES-047). */
function SourceHighRiskWarning({ source }: { source: MissionSourceSummary }) {
  const riskLabels = source.injectionRiskLabels;
  const warnings = source.warnings;
  return (
    <div
      role="alert"
      className="mt-2 rounded-lg border border-error/20 bg-error/[0.06] px-3 py-2"
      data-testid="source-high-risk-warning"
    >
      <p className="text-xs font-medium text-error mb-0.5">High-risk content</p>
      {riskLabels.length > 0 && (
        <p className="text-xs text-error break-words" data-testid="source-risk-labels">
          Risk labels: {riskLabels.join(', ')}
        </p>
      )}
      {warnings.length > 0 && (
        <div className="text-xs text-text-primary break-words">
          {warnings.map((w, i) => (
            <p key={i} className="break-words">
              {w}
            </p>
          ))}
        </div>
      )}
      <p className="text-xs text-text-muted mt-1">
        This content is treated as untrusted data and cannot change run policy, approval, or tool
        authority.
      </p>
    </div>
  );
}

/** A distinct, actionable research failure card (VAL-RES-105). */
function FailedResearchCard({ entry }: { entry: FailedResearchEntry }) {
  return (
    <li
      className="rounded-lg border border-error/20 bg-error/[0.04] px-3 py-2 w-full max-w-full break-words"
      aria-label={`Research failure at sequence ${entry.sequence}`}
      data-testid="research-failed-card"
    >
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <XCircle className="h-4 w-4 text-error" aria-hidden="true" />
        <span className="inline-flex items-center gap-1 rounded-full border border-error/20 bg-error/10 px-2 py-0.5 text-xs font-medium text-error">
          {sourceStateText('failed')}
        </span>
        {entry.failureCategory && (
          <span className="text-xs text-text-primary break-words">
            Category: {entry.failureCategory}
          </span>
        )}
        {entry.failureCode && (
          <span className="text-xs text-text-primary break-words">Code: {entry.failureCode}</span>
        )}
      </div>
      {entry.safeErrorMessage && (
        <p className="text-sm text-text-primary break-words">{entry.safeErrorMessage}</p>
      )}
      <p className="text-xs text-text-muted mt-1 break-words">
        {recoveryGuidance(entry.failureCategory)}
      </p>
    </li>
  );
}

/**
 * Batched polite announcement for meaningful source-state count changes
 * only (VAL-RES-082, VAL-RUN-089). Announces retrieved/unavailable/failed
 * counts when they change; never announces per-event progress noise.
 */
function useBatchedSourceAnnouncement(runId: string, derived: DerivedSourceState[]): string {
  const [announcement, setAnnouncement] = useState('');
  const prevRef = useRef({ retrieved: -1, unavailable: 0, failed: 0 });
  useEffect(() => {
    const retrieved = derived.filter((d) => d.state === 'retrieved').length;
    const unavailable = derived.filter((d) => d.state === 'unavailable').length;
    const failed = derived.filter((d) => d.state === 'failed').length;
    const prev = prevRef.current;
    if (
      prev.retrieved === retrieved &&
      prev.unavailable === unavailable &&
      prev.failed === failed
    ) {
      return;
    }
    if (prev.retrieved !== -1) {
      const parts: string[] = [];
      if (retrieved !== prev.retrieved) {
        parts.push(`${retrieved} source${retrieved === 1 ? '' : 's'} retrieved`);
      }
      if (unavailable !== prev.unavailable) {
        parts.push(`${unavailable} unavailable`);
      }
      if (failed !== prev.failed) {
        parts.push(`${failed} failed`);
      }
      if (parts.length > 0) {
        setAnnouncement(`Mission ${runId}: ${parts.join(', ')}`);
      }
    }
    prevRef.current = { retrieved, unavailable, failed };
  }, [runId, derived]);
  return announcement;
}
