import { useEffect, useRef, useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { MissionReplayEvent } from './api';

/**
 * Mission SSE stream hook.
 *
 * Opens an authenticated EventSource to the Mission run stream endpoint,
 * applies only contiguous events, and invalidates/refetches on gaps.
 *
 * Architecture rules:
 * - `after` and `Last-Event-ID` are run-local sequence numbers; explicit
 *   `after` wins. Default is 0 for a complete initial replay.
 * - Each frame is `id: <sequence>`, `event: <type>`, and
 *   `data: <sanitized event envelope>`.
 * - The client deduplicates by sequence and treats a gap as a reason to
 *   call the JSON replay endpoint (invalidate the events query).
 * - Reconnect uses the last completely processed ID.
 * - A terminal event is followed by graceful close.
 *
 * Postgres is authoritative. The SSE stream is a low-latency projection;
 * it never advances authoritative state in the browser. On any event, the
 * snapshot query is invalidated so TanStack Query refetches the latest
 * server state. On a gap, the events query is invalidated so the JSON
 * replay endpoint supplies the missing events.
 */

export type StreamStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed';

export interface UseMissionRunStreamResult {
  /** Current connection status for UI display. */
  status: StreamStatus;
  /** The last fully processed event sequence. */
  lastSequence: number;
  /** True when a noncontiguous sequence was detected and recovery is in progress. */
  gapDetected: boolean;
}

/** Terminal event types that close the stream. */
const TERMINAL_EVENT_TYPES = new Set(['run.completed', 'run.failed', 'run.cancelled']);

/** Terminal run statuses (for checking snapshot status). */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * Connect to the Mission run SSE stream and apply contiguous events.
 *
 * On gap detection, invalidates the events query (JSON replay refetch)
 * and the snapshot query. On any event, invalidates the snapshot query
 * so the authoritative state is refetched. The browser never advances
 * state optimistically; it only refetches from the server.
 */
export function useMissionRunStream(
  companyId: string,
  projectId: string,
  runId: string | undefined,
  options?: { enabled?: boolean },
): UseMissionRunStreamResult {
  const enabled = options?.enabled ?? true;
  const qc = useQueryClient();

  const [status, setStatus] = useState<StreamStatus>('idle');
  const [lastSequence, setLastSequence] = useState(0);
  const [gapDetected, setGapDetected] = useState(false);

  // Refs to avoid stale closures in EventSource callbacks.
  const lastSeqRef = useRef(0);
  const gapDetectedRef = useRef(false);
  const esRef = useRef<EventSource | null>(null);
  const closedRef = useRef(false);
  const identityRef = useRef<string | null>(null);

  const handleEvent = useCallback(
    (eventType: string, data: string, eventId: string) => {
      if (closedRef.current) {
        return;
      }

      const seq = Number(eventId);
      if (!Number.isFinite(seq) || seq <= 0) {
        return;
      }

      // Deduplicate: skip events we've already processed.
      if (seq <= lastSeqRef.current) {
        return;
      }

      // Gap detection: if the sequence is not contiguous, invalidate
      // the events query for a JSON replay refetch.
      const isGap = seq > lastSeqRef.current + 1;
      if (isGap) {
        gapDetectedRef.current = true;
        setGapDetected(true);
        qc.invalidateQueries({
          queryKey: ['mission-run-events', companyId, projectId, runId],
        });
      } else if (gapDetectedRef.current) {
        // Contiguous event after a gap was detected: clear the gap
        // indicator. The JSON replay refetch has filled in the
        // missing events.
        gapDetectedRef.current = false;
        setGapDetected(false);
      }

      // Update the last processed sequence.
      lastSeqRef.current = seq;
      setLastSequence(seq);

      // Invalidate the snapshot query so the authoritative state is
      // refetched from the server. The SSE stream is a projection; the
      // server snapshot is authoritative.
      qc.invalidateQueries({
        queryKey: ['mission-run-snapshot', companyId, projectId, runId],
      });

      // Also invalidate the events query to keep the timeline fresh.
      // This ensures the JSON replay endpoint is the source of truth
      // for the timeline, while SSE provides low-latency wake-up.
      qc.invalidateQueries({
        queryKey: ['mission-run-events', companyId, projectId, runId],
      });

      // Invalidate the paginated mission-runs list query so the list row
      // (including its status badge and derived action availability)
      // refreshes from authoritative server state on every SSE event.
      // The list row's `status` is a projection that can lag the
      // authoritative snapshot during live lifecycle transitions; without
      // this invalidation the row (and any consumer that reads
      // `run.status`) stays stale until the next polling/refetch window.
      // Both `useMissionRuns` (`['mission-runs', company, project]`) and
      // `useMissionRunsPaginated` (`['mission-runs', company, project,
      // 'paginated']`) share this prefix, so a prefix invalidation covers
      // both. (Normative Boundary 1 / VAL-RUN-017.)
      qc.invalidateQueries({
        queryKey: ['mission-runs', companyId, projectId],
      });

      // Invalidate the provider-neutral research sources query so source
      // cards refresh from the authoritative `GET /:runId/sources` summary
      // on every SSE event (VAL-RES-016, VAL-RES-017, VAL-RES-018,
      // Normative Boundary 1). Research lifecycle events (research.*)
      // change source states and progress; without this invalidation the
      // source list stays stale until the next polling/refetch window.
      qc.invalidateQueries({
        queryKey: ['mission-run-sources', companyId, projectId, runId],
      });

      // Cross-surface consistency for non-terminal state changes
      // (VAL-CROSS-048): invalidate the Inbox when question lifecycle
      // events occur so mission_question items converge (new question
      // appears, answered question is removed/marked). Invalidate
      // Approvals and Plans when plan lifecycle events occur so
      // plan_gate approvals and projected plan steps converge.
      if (
        eventType === 'questions.requested' ||
        eventType === 'questions.answered' ||
        eventType === 'questions.invalidated'
      ) {
        qc.invalidateQueries({ queryKey: ['inbox', companyId] });
      }
      if (
        eventType === 'plan.proposed' ||
        eventType === 'plan.approved' ||
        eventType === 'plan.rejected' ||
        eventType === 'plan.revision_requested' ||
        eventType === 'plan.projected'
      ) {
        qc.invalidateQueries({ queryKey: ['approvals', companyId] });
        qc.invalidateQueries({ queryKey: ['project-plans', companyId, projectId] });
      }

      // Invalidate the child tree query on child.* events so the
      // /children endpoint tree stays fresh (VAL-M1-027, VAL-M1-028).
      // Also invalidate the snapshot query so the childSummary in the
      // snapshot stays in sync with the /children tree data
      // (VAL-M1-029).
      if (
        eventType === 'child.created' ||
        eventType === 'child.routed' ||
        eventType === 'child.started' ||
        eventType === 'child.completed' ||
        eventType === 'child.failed' ||
        eventType === 'child.cancel_requested' ||
        eventType === 'descendant.progressed'
      ) {
        qc.invalidateQueries({
          queryKey: ['mission-run-children', companyId, projectId, runId],
        });
        qc.invalidateQueries({
          queryKey: ['mission-run-snapshot', companyId, projectId, runId],
        });
      }

      // Close the stream on terminal events.
      if (TERMINAL_EVENT_TYPES.has(eventType)) {
        // Cross-surface terminal consistency (VAL-CROSS-048): invalidate
        // the Inbox, Approvals, and Plans query caches so every product
        // surface converges on the same terminal outcome. Without this,
        // a Mission question or plan approval item in the Inbox/Approvals
        // surface can remain visibly actionable after the run has already
        // reached a terminal state, because those surfaces are not
        // invalidated by the per-run snapshot/events/list invalidations
        // above. The server projection will mark items as non-actionable
        // for terminal runs; this invalidation ensures the browser
        // refetches and reflects that promptly.
        qc.invalidateQueries({ queryKey: ['inbox', companyId] });
        qc.invalidateQueries({ queryKey: ['approvals', companyId] });
        qc.invalidateQueries({ queryKey: ['project-plans', companyId, projectId] });

        closedRef.current = true;
        setStatus('closed');
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
      }
    },
    [companyId, projectId, runId, qc],
  );

  useEffect(() => {
    const identity = JSON.stringify([companyId, projectId, runId]);
    if (identityRef.current !== identity) {
      identityRef.current = identity;
      lastSeqRef.current = 0;
      gapDetectedRef.current = false;
      setLastSequence(0);
      setGapDetected(false);
    }
    if (!enabled || !companyId || !projectId || !runId) {
      setStatus('idle');
      return;
    }

    // Check if the run is already terminal from the cached snapshot.
    const snapshot = qc.getQueryData<MissionReplayEvent & { status?: string }>([
      'mission-run-snapshot',
      companyId,
      projectId,
      runId,
    ]);
    if (snapshot && TERMINAL_STATUSES.has(snapshot.status ?? '')) {
      setStatus('closed');
      return;
    }

    closedRef.current = false;
    setStatus('connecting');

    // Omit explicit `after`: its protocol precedence would mask the browser's
    // updated Last-Event-ID on automatic reconnect. Initial requests default
    // to zero; native reconnects resume from their latest received event ID.
    const url = `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/stream`;

    let eventSource: EventSource;
    try {
      eventSource = new EventSource(url, { withCredentials: true });
    } catch {
      setStatus('error');
      return;
    }
    esRef.current = eventSource;

    eventSource.onopen = () => {
      if (!closedRef.current) {
        setStatus('connected');
      }
    };

    eventSource.onerror = () => {
      if (closedRef.current) {
        return;
      }
      // EventSource auto-reconnects on transient errors. We set
      // 'reconnecting' so the UI can display the status. If the
      // readyState is CLOSED (2), the connection failed permanently.
      if (eventSource.readyState === EventSource.CLOSED) {
        setStatus('error');
      } else {
        setStatus('reconnecting');
      }
    };

    // Overflow is control metadata, not a journal event. Refetch the
    // authoritative replay immediately; EventSource reconnects with its
    // last received id after the server closes this connection.
    eventSource.addEventListener('buffer_overflow', () => {
      if (closedRef.current) {
        return;
      }
      setStatus('reconnecting');
      qc.invalidateQueries({ queryKey: ['mission-run-events', companyId, projectId, runId] });
      qc.invalidateQueries({ queryKey: ['mission-run-snapshot', companyId, projectId, runId] });
    });

    // Listen for all event types. The SSE stream sends typed events
    // with `event: <type>` and `id: <sequence>`.
    const messageHandler = (ev: MessageEvent) => {
      // The event type is in the `event` field; for generic messages,
      // we parse the data to get the type.
      let eventType = 'message';
      let eventId = ev.lastEventId;
      let eventData = ev.data;

      // Try to parse the data as JSON to extract the event type.
      try {
        const parsed = JSON.parse(ev.data);
        if (parsed.type) {
          eventType = parsed.type;
        }
        if (parsed.sequence) {
          eventId = String(parsed.sequence);
        }
        eventData = ev.data;
      } catch {
        // If not JSON, use the raw data.
      }

      handleEvent(eventType, eventData, eventId);
    };

    // EventSource fires `message` for untyped events and named events
    // for typed ones. We listen on `message` as a catch-all since the
    // server sends typed events with `event: <type>`.
    eventSource.addEventListener('message', messageHandler);

    // Also listen for common named event types to ensure we catch them.
    const namedTypes = [
      'run.created',
      'run.status_changed',
      'run.claimed',
      'run.lease_renewed',
      'run.recovered',
      'run.cancel_requested',
      'run.completed',
      'run.failed',
      'run.cancelled',
      'mode.resolved',
      'policy.snapshotted',
      'execution.started',
      'execution.progress',
      'budget.reserved',
      'budget.settled',
      'budget.released',
      'budget.exhausted',
      'limit.approaching',
      'limit.exceeded',
      'projection.failed',
      'projection.repaired',
      // Question lifecycle events (VAL-MODEQ-086: reconnect must not
      // duplicate question events). Without these named listeners, SSE
      // frames for question events are silently dropped and only recovered
      // via gap-detection refetch, which can cause duplicate cards during
      // reconnect.
      'questions.requested',
      'questions.answered',
      'questions.invalidated',
      // Research lifecycle events (VAL-RES-016, VAL-RES-017, VAL-RES-018,
      // VAL-CROSS-030). Without these named listeners, SSE frames for
      // research progress/source events are silently dropped and only
      // recovered via gap-detection refetch, which can cause duplicate
      // source cards or lost progress during reconnect.
      'research.started',
      'research.provider_attempted',
      'research.source_discovered',
      'research.source_retrieved',
      'research.provider_fallback',
      'research.completed',
      'research.failed',
      // Plan lifecycle events (VAL-CROSS-048). Without these named
      // listeners, SSE frames for plan lifecycle events are silently
      // dropped because EventSource dispatches typed events to named
      // listeners, not the generic `message` catch-all. The handleEvent
      // callback checks these types to invalidate Approvals and Plans
      // query caches, but without registered named listeners the
      // callback never fires, making that invalidation dead code.
      'plan.proposed',
      'plan.approved',
      'plan.rejected',
      'plan.revision_requested',
      'plan.projected',
      // Child lifecycle events (VAL-M1-027, VAL-M1-028). Without these
      // named listeners, SSE frames for child events are silently dropped
      // and the /children tree and snapshot childSummary stay stale until
      // the next polling/refetch window.
      'child.created',
      'child.routed',
      'child.started',
      'child.completed',
      'child.failed',
      'child.cancel_requested',
      'descendant.progressed',
    ];
    for (const type of namedTypes) {
      eventSource.addEventListener(type, messageHandler);
    }

    return () => {
      closedRef.current = true;
      eventSource.removeEventListener('message', messageHandler);
      for (const type of namedTypes) {
        eventSource.removeEventListener(type, messageHandler);
      }
      eventSource.close();
      esRef.current = null;
    };
  }, [companyId, projectId, runId, enabled, handleEvent, qc]);

  return { status, lastSequence, gapDetected };
}
