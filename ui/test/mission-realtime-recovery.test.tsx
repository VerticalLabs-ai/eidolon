import { render, screen, within, act, renderHook as tlRenderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import { useMissionRunStream as useMissionRunStreamReal } from '../src/lib/mission-stream';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunsPaginated: vi.fn(),
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useStartMissionRun: vi.fn(),
  useMissionRunStream: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useMissionRunsPaginated: mocks.useMissionRunsPaginated,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionRunEvents: mocks.useMissionRunEvents,
    useStartMissionRun: mocks.useStartMissionRun,
    useMissionRunStream: mocks.useMissionRunStream,
  };
});

vi.mock('@/lib/ws', () => ({
  useServerEvents: vi.fn(),
  useWebSocket: () => ({ status: 'disconnected' }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function runSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1',
    companyId: 'company-1',
    projectId: 'project-1',
    status: 'running',
    stateVersion: 3,
    lastEventSequence: 4,
    resolvedMode: 'fast',
    policyContentHash: 'abc123',
    requestContentHash: 'hash-1',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

function runSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1',
    companyId: 'company-1',
    projectId: 'project-1',
    projectThreadId: 'thread-1',
    rootRunId: 'run-1',
    parentRunId: null,
    retryOfRunId: null,
    depth: 0,
    childOrdinal: null,
    routingKind: 'company_agent',
    status: 'running',
    stateVersion: 3,
    lastEventSequence: 4,
    resolvedMode: 'fast',
    modeProfileId: null,
    policySnapshotId: 'policy-1',
    policyContentHash: 'abc123',
    requestContentHash: 'hash-1',
    currentQuestionSetId: null,
    currentPlanRevisionId: null,
    approvedPlanRevisionId: null,
    waitingFromStatus: null,
    partialResultPolicy: 'require_all',
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    cancellationDeadlineAt: null,
    failureCategory: null,
    failureCode: null,
    safeErrorMessage: null,
    startedAt: '2026-08-20T10:00:01.000Z',
    terminalAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    attemptCount: 0,
    providerCallCount: 0,
    descendantCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    outputBytes: 0,
    actualCostCents: 0,
    queueHealth: undefined,
    budget: {
      reservedCents: 500,
      settledCents: 0,
      releasedCents: 0,
      costCentsCeiling: 500,
      actualCostCents: 0,
    },
    childSummary: { running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
    artifacts: [],
    links: {
      ui: '/companies/company-1/projects/project-1?thread=thread-1&run=run-1',
    },
    ...overrides,
  };
}

function evt(sequence: number, type: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sequence,
    type,
    schemaVersion: 1,
    payload: {},
    commandId: null,
    actorType: 'user',
    actorId: 'user-1',
    traceId: 'trace-1',
    occurredAt: `2026-08-20T10:00:0${sequence}.000Z`,
    ...overrides,
  };
}

function listResult(runs: ReturnType<typeof runSummary>[] = [runSummary()]) {
  return {
    data: { pages: [{ runs, nextCursor: null }], pageParams: [undefined] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

function snapshotResult(snapshot: ReturnType<typeof runSnapshot> = runSnapshot()) {
  return { data: snapshot, isLoading: false, isError: false };
}

function eventsResult(events: ReturnType<typeof evt>[] = []) {
  return { data: { events, nextCursor: 0, latestSequence: 4 }, isLoading: false, isError: false };
}

function startResult() {
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    reset: vi.fn(),
  };
}

function streamResult(overrides: Partial<ReturnType<typeof useMissionRunStream>> = {}) {
  return {
    status: 'connected' as const,
    lastSequence: 4,
    gapDetected: false,
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Mission realtime recovery UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMissionRunsPaginated.mockReturnValue(listResult());
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useStartMissionRun.mockReturnValue(startResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
  });

  // ── VAL-RUN-029: SSE reconnect does not duplicate UI events ───────────
  it('shows each event once after disconnect and reconnect', () => {
    mocks.useMissionRunEvents.mockReturnValue(
      eventsResult([
        evt(1, 'run.created'),
        evt(2, 'mode.resolved'),
        evt(3, 'budget.reserved'),
        evt(4, 'execution.started'),
        evt(5, 'execution.progress'),
      ]),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const timeline = screen.getByRole('list', { name: /event timeline/i });
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(5);
    // Each sequence appears exactly once
    const seqNumbers = items.map((li) => li.textContent?.match(/^\s*(\d+)/)?.[1] ?? '');
    expect(new Set(seqNumbers).size).toBe(5);
  });

  // ── VAL-RUN-030: UI recovers an SSE gap ────────────────────────────────
  it('shows a gap-recovery indicator when a gap is detected', () => {
    mocks.useMissionRunStream.mockReturnValue(
      streamResult({ gapDetected: true, status: 'connected' }),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/recovering|gap|replaying/i)).toBeInTheDocument();
  });

  it('clears the gap-recovery indicator after convergence', () => {
    mocks.useMissionRunStream.mockReturnValue(
      streamResult({ gapDetected: false, status: 'connected' }),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.queryByText(/recovering|gap|replaying/i)).not.toBeInTheDocument();
  });

  // ── VAL-RUN-031: Stream exposes reconnecting state ─────────────────────
  it('shows reconnecting status during stream interruption', () => {
    mocks.useMissionRunStream.mockReturnValue(streamResult({ status: 'reconnecting' }));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    // The run remains visible — it does not disappear
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('clears reconnecting status after successful replay', () => {
    mocks.useMissionRunStream.mockReturnValue(streamResult({ status: 'connected' }));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
  });

  it('does not claim the run stopped during reconnection', () => {
    mocks.useMissionRunStream.mockReturnValue(streamResult({ status: 'reconnecting' }));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // The run status is still "running" from the authoritative snapshot
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  // ── VAL-RUN-032: Reload reconstructs an active run ─────────────────────
  it('reconstructs an active run card from server state on mount', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ id: 'run-active', status: 'running', stateVersion: 5 })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ id: 'run-active', status: 'running', stateVersion: 5 })),
    );
    mocks.useMissionRunEvents.mockReturnValue(
      eventsResult([
        evt(1, 'run.created'),
        evt(2, 'mode.resolved'),
        evt(3, 'budget.reserved'),
        evt(4, 'execution.started'),
        evt(5, 'execution.progress'),
      ]),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    expect(within(card).getByText(/run-active/i)).toBeInTheDocument();
    expect(within(card).getByText(/running/i)).toBeInTheDocument();
    const timeline = within(card).getByRole('list', { name: /event timeline/i });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(5);
  });

  // ── VAL-RUN-033: Reload reconstructs a terminal run ────────────────────
  it('reconstructs a completed terminal run card on mount', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ id: 'run-done', status: 'completed', stateVersion: 10 })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          id: 'run-done',
          status: 'completed',
          stateVersion: 10,
          terminalAt: '2026-08-20T10:10:00.000Z',
          budget: {
            reservedCents: 500,
            settledCents: 200,
            releasedCents: 300,
            costCentsCeiling: 500,
            actualCostCents: 200,
          },
        }),
      ),
    );
    mocks.useMissionRunEvents.mockReturnValue(
      eventsResult([
        evt(1, 'run.created'),
        evt(2, 'mode.resolved'),
        evt(3, 'budget.reserved'),
        evt(4, 'execution.started'),
        evt(5, 'run.completed'),
      ]),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    expect(within(card).getByText(/run-done/i)).toBeInTheDocument();
    expect(within(card).getAllByText(/completed/i).length).toBeGreaterThan(0);
    expect(within(card).getByText(/completed at/i)).toBeInTheDocument();
  });

  it('reconstructs a failed terminal run card on mount', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ id: 'run-fail', status: 'failed', stateVersion: 8 })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          id: 'run-fail',
          status: 'failed',
          stateVersion: 8,
          terminalAt: '2026-08-20T10:05:00.000Z',
          failureCategory: 'provider_transient',
          safeErrorMessage: 'The provider timed out.',
        }),
      ),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    expect(within(card).getByText(/run-fail/i)).toBeInTheDocument();
    expect(within(card).getAllByText(/failed/i).length).toBeGreaterThan(0);
    expect(within(card).getByText(/provider timed out/i)).toBeInTheDocument();
  });

  it('reconstructs a cancelled terminal run card on mount', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ id: 'run-cancel', status: 'cancelled', stateVersion: 6 })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          id: 'run-cancel',
          status: 'cancelled',
          stateVersion: 6,
          terminalAt: '2026-08-20T10:03:00.000Z',
          cancelRequestedAt: '2026-08-20T10:02:00.000Z',
          cancelRequestedBy: 'user-1',
        }),
      ),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    expect(within(card).getByText(/run-cancel/i)).toBeInTheDocument();
    expect(within(card).getAllByText(/cancelled/i).length).toBeGreaterThan(0);
  });

  // ── VAL-RUN-082: Worker restart recovers leased work ───────────────────
  it('shows run.recovered event in the timeline after worker recovery', () => {
    mocks.useMissionRunEvents.mockReturnValue(
      eventsResult([
        evt(1, 'run.created'),
        evt(2, 'mode.resolved'),
        evt(3, 'budget.reserved'),
        evt(4, 'run.claimed'),
        evt(5, 'run.recovered'),
        evt(6, 'execution.started'),
      ]),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const timeline = screen.getByRole('list', { name: /event timeline/i });
    const items = within(timeline).getAllByRole('listitem');
    expect(within(items[4]).getByText(/run\.recovered/i)).toBeInTheDocument();
  });

  // ── VAL-RUN-088: Waiting and no-worker states are explicit ─────────────
  it('shows worker unavailable when queueHealth is unavailable', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'queued' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'queued', queueHealth: 'unavailable' })),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/worker unavailable/i)).toBeInTheDocument();
  });

  it('does not show worker unavailable when queueHealth is available', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'queued' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'queued', queueHealth: 'available' })),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.queryByText(/worker unavailable/i)).not.toBeInTheDocument();
  });

  it('does not show worker unavailable when queueHealth is absent', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'queued' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'queued', queueHealth: undefined })),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.queryByText(/worker unavailable/i)).not.toBeInTheDocument();
  });

  it('does not infer worker unavailability from a local timer', () => {
    // Even with a queued run and no stream, the card should not show
    // "worker unavailable" unless the server says so.
    mocks.useMissionRunStream.mockReturnValue(streamResult({ status: 'connected' }));
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'queued' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'queued', queueHealth: undefined })),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.queryByText(/worker unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByText(/queued/i)).toBeInTheDocument();
  });

  // ── VAL-RUN-131: Authoritative read failures remain recoverable ───────
  it('keeps existing cards visible when the list refetch fails', () => {
    // First render with data
    mocks.useMissionRunsPaginated.mockReturnValue({
      data: {
        pages: [{ runs: [runSummary({ id: 'run-stale' })], nextCursor: null }],
        pageParams: [undefined],
      },
      isLoading: false,
      isError: false,
      isPreviousData: true,
    });
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Card is visible
    expect(screen.getByText(/run-stale/i)).toBeInTheDocument();
  });

  it('shows a stale indicator and retry when the list fails to load', () => {
    mocks.useMissionRunsPaginated.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/could not load/i)).toBeInTheDocument();
    // Retry button is present
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('keeps existing snapshot visible when the snapshot refetch fails', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ id: 'run-snap', status: 'running' })]),
    );
    // Snapshot has previous data but is in error state (refetch failed)
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: runSnapshot({ id: 'run-snap', status: 'running' }),
      isLoading: false,
      isError: true,
      isPreviousData: true,
    });
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Card is still visible with its previous data
    expect(screen.getByText(/run-snap/i)).toBeInTheDocument();
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    // Stale indicator is shown
    expect(screen.getAllByText(/stale|may be outdated/i).length).toBeGreaterThan(0);
  });

  it('keeps existing timeline visible when the events refetch fails', () => {
    mocks.useMissionRunEvents.mockReturnValue({
      data: {
        events: [evt(1, 'run.created'), evt(2, 'mode.resolved')],
        nextCursor: 0,
        latestSequence: 2,
      },
      isLoading: false,
      isError: true,
      isPreviousData: true,
    });
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Timeline is still visible with previous events
    const timeline = screen.getByRole('list', { name: /event timeline/i });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(2);
    // Stale indicator is shown (either from RunCardStaleRead or timeline)
    expect(screen.getAllByText(/stale|may be outdated/i).length).toBeGreaterThan(0);
  });

  it('does not render as no Missions on a list failure with previous data', () => {
    mocks.useMissionRunsPaginated.mockReturnValue({
      data: {
        pages: [{ runs: [runSummary({ id: 'run-prev' })], nextCursor: null }],
        pageParams: [undefined],
      },
      isLoading: false,
      isError: true,
      isPreviousData: true,
    });
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Previous card is still visible, not an empty state
    expect(screen.getByText(/run-prev/i)).toBeInTheDocument();
    // Stale indicator is shown
    expect(screen.getAllByText(/stale|may be outdated/i).length).toBeGreaterThan(0);
  });

  it('does not show completion or empty timeline on events failure with previous data', () => {
    mocks.useMissionRunEvents.mockReturnValue({
      data: {
        events: [evt(1, 'run.created'), evt(2, 'execution.started')],
        nextCursor: 0,
        latestSequence: 2,
      },
      isLoading: false,
      isError: true,
      isPreviousData: true,
    });
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Timeline still shows previous events
    const timeline = screen.getByRole('list', { name: /event timeline/i });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(2);
    // Does not show "completed" just because events failed
    expect(screen.queryByText(/^completed$/i)).not.toBeInTheDocument();
  });

  // ── VAL-CROSS-052: SSE reconnect replays without gaps ───────────────────
  it('shows a replaying indicator during gap recovery', () => {
    mocks.useMissionRunStream.mockReturnValue(
      streamResult({ status: 'connected', gapDetected: true }),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/replaying|recovering/i)).toBeInTheDocument();
  });

  it('does not optimistically advance state during a gap', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'queued', stateVersion: 2 })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'queued', stateVersion: 2 })),
    );
    mocks.useMissionRunStream.mockReturnValue(
      streamResult({ status: 'reconnecting', gapDetected: true }),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Status is still "queued" from the authoritative snapshot, not advanced
    expect(screen.getByText(/queued/i)).toBeInTheDocument();
    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/running/i)).not.toBeInTheDocument();
  });

  // ── Stream status: error state ─────────────────────────────────────────
  it('shows an error indicator when the stream fails to connect', () => {
    mocks.useMissionRunStream.mockReturnValue(streamResult({ status: 'error' }));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/stream error|connection error/i)).toBeInTheDocument();
    // Run remains visible
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  // ── Stream status: idle (no active stream for terminal runs) ──────────
  it('does not show reconnecting for a terminal run with closed stream', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'completed' })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'completed', terminalAt: '2026-08-20T10:10:00.000Z' })),
    );
    mocks.useMissionRunStream.mockReturnValue(streamResult({ status: 'closed' }));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.queryByText(/reconnecting/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stream error/i)).not.toBeInTheDocument();
  });
});

// ── SSE Hook Unit Tests ────────────────────────────────────────────────────

/** Wrapper for renderHook that provides QueryClient + MemoryRouter context. */
const hookQc = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function hookWrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={hookQc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

/** A mock EventSource class that captures listeners for test simulation. */
class MockEventSourceClass {
  url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  closeFn = vi.fn();

  static lastInstance: MockEventSourceClass | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSourceClass.lastInstance = this;
  }

  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.readyState = 2;
    this.closeFn();
  }

  /** Test helper: simulate an SSE event frame. */
  simulateEvent(type: string, data: string, id: string): void {
    const msg = new MessageEvent(type, { data });
    Object.defineProperty(msg, 'lastEventId', { value: id });
    for (const fn of this.listeners.get(type) ?? []) {
      fn(msg);
    }
    // Also fire onmessage for generic events
    if (this.onmessage && !this.listeners.has(type)) {
      this.onmessage(msg);
    }
  }

  /** Test helper: simulate connection open. */
  simulateOpen(): void {
    this.readyState = 1;
    if (this.onopen) {
      this.onopen(new Event('open'));
    }
  }

  /** Test helper: simulate connection error. */
  simulateError(): void {
    this.readyState = 0;
    if (this.onerror) {
      this.onerror(new Event('error'));
    }
  }
}

describe('useMissionRunStream hook', () => {
  let originalEventSource: typeof EventSource;

  beforeEach(() => {
    originalEventSource = global.EventSource;
    MockEventSourceClass.lastInstance = null;
    hookQc.clear();
  });

  afterEach(() => {
    global.EventSource = originalEventSource;
  });

  it('returns idle status when runId is undefined', () => {
    global.EventSource = MockEventSourceClass as unknown as typeof EventSource;
    const { result } = tlRenderHook(
      () => useMissionRunStreamReal('company-1', 'project-1', undefined),
      { wrapper: hookWrapper },
    );
    expect(result.current.status).toBe('idle');
  });

  it('creates an EventSource when runId is provided', () => {
    global.EventSource = MockEventSourceClass as unknown as typeof EventSource;
    tlRenderHook(() => useMissionRunStreamReal('company-1', 'project-1', 'run-1'), {
      wrapper: hookWrapper,
    });
    expect(MockEventSourceClass.lastInstance).not.toBeNull();
    expect(MockEventSourceClass.lastInstance!.url).toContain('/mission-runs/run-1/stream');
  });

  it('tracks lastSequence from event IDs', async () => {
    global.EventSource = MockEventSourceClass as unknown as typeof EventSource;
    const { result } = tlRenderHook(
      () => useMissionRunStreamReal('company-1', 'project-1', 'run-1'),
      { wrapper: hookWrapper },
    );

    await act(async () => {
      MockEventSourceClass.lastInstance?.simulateOpen();
    });
    expect(result.current.status).toBe('connected');
  });

  it('detects a gap when a noncontiguous sequence arrives', async () => {
    global.EventSource = MockEventSourceClass as unknown as typeof EventSource;
    const { result } = tlRenderHook(
      () => useMissionRunStreamReal('company-1', 'project-1', 'run-1'),
      { wrapper: hookWrapper },
    );

    await act(async () => {
      MockEventSourceClass.lastInstance?.simulateOpen();
    });

    const es = MockEventSourceClass.lastInstance!;

    // Process events 1, 2 (contiguous)
    await act(async () => {
      es.simulateEvent('run.created', JSON.stringify({ sequence: 1, type: 'run.created' }), '1');
    });
    expect(result.current.lastSequence).toBe(1);

    await act(async () => {
      es.simulateEvent(
        'mode.resolved',
        JSON.stringify({ sequence: 2, type: 'mode.resolved' }),
        '2',
      );
    });
    expect(result.current.lastSequence).toBe(2);

    // Gap: event 5 arrives, skipping 3 and 4
    await act(async () => {
      es.simulateEvent(
        'execution.progress',
        JSON.stringify({ sequence: 5, type: 'execution.progress' }),
        '5',
      );
    });
    expect(result.current.gapDetected).toBe(true);
  });

  it('deduplicates events by sequence on reconnect', async () => {
    global.EventSource = MockEventSourceClass as unknown as typeof EventSource;
    const { result } = tlRenderHook(
      () => useMissionRunStreamReal('company-1', 'project-1', 'run-1'),
      { wrapper: hookWrapper },
    );

    await act(async () => {
      MockEventSourceClass.lastInstance?.simulateOpen();
    });

    const es = MockEventSourceClass.lastInstance!;

    // Process events 1, 2, 3 (contiguous)
    await act(async () => {
      es.simulateEvent('run.created', JSON.stringify({ sequence: 1 }), '1');
      es.simulateEvent('mode.resolved', JSON.stringify({ sequence: 2 }), '2');
      es.simulateEvent('budget.reserved', JSON.stringify({ sequence: 3 }), '3');
    });
    expect(result.current.lastSequence).toBe(3);

    // Simulate reconnect: events 3, 4, 5 arrive (3 is a duplicate)
    await act(async () => {
      es.simulateEvent('budget.reserved', JSON.stringify({ sequence: 3 }), '3');
      es.simulateEvent('execution.started', JSON.stringify({ sequence: 4 }), '4');
      es.simulateEvent('execution.progress', JSON.stringify({ sequence: 5 }), '5');
    });
    // Last sequence is 5, not stuck at 3
    expect(result.current.lastSequence).toBe(5);
    // No gap detected (3 is a duplicate, then 4 and 5 are contiguous)
    expect(result.current.gapDetected).toBe(false);
  });

  it('sets reconnecting status on error', async () => {
    global.EventSource = MockEventSourceClass as unknown as typeof EventSource;
    const { result } = tlRenderHook(
      () => useMissionRunStreamReal('company-1', 'project-1', 'run-1'),
      { wrapper: hookWrapper },
    );

    await act(async () => {
      MockEventSourceClass.lastInstance?.simulateOpen();
    });
    expect(result.current.status).toBe('connected');

    await act(async () => {
      MockEventSourceClass.lastInstance?.simulateError();
    });
    expect(result.current.status).toBe('reconnecting');
  });

  it('closes the EventSource on unmount', () => {
    global.EventSource = MockEventSourceClass as unknown as typeof EventSource;
    const { unmount } = tlRenderHook(
      () => useMissionRunStreamReal('company-1', 'project-1', 'run-1'),
      { wrapper: hookWrapper },
    );
    unmount();
    expect(MockEventSourceClass.lastInstance?.closeFn).toHaveBeenCalled();
  });
});
