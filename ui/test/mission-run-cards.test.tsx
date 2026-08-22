import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRunList } from '../src/components/projects/MissionRunList';

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

/** Build a minimal RunSummary for the list. */
function runSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1',
    companyId: 'company-1',
    projectId: 'project-1',
    status: 'queued',
    stateVersion: 1,
    lastEventSequence: 4,
    resolvedMode: 'fast',
    policyContentHash: 'abc123',
    requestContentHash: 'hash-1',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

/** Build a complete RunSnapshot for the detail query. */
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
    status: 'queued',
    stateVersion: 1,
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
    startedAt: null,
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
      ui: '/companies/company-1/projects/project-1/work?thread=thread-1&mission=run-1',
    },
    ...overrides,
  };
}

/** Build a ReplayEvent. */
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

describe('MissionRunList and MissionRunCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMissionRunsPaginated.mockReturnValue(listResult());
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useStartMissionRun.mockReturnValue(startResult());
    mocks.useMissionRunStream.mockReturnValue({
      status: 'connected',
      lastSequence: 4,
      gapDetected: false,
    });
  });

  // ── VAL-RUN-014: Successful start creates one run card ───────────────
  it('renders exactly one run card when the list has one run', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary()]));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(1);
  });

  it('renders no run cards when the list is empty', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([]));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  // ── VAL-RUN-015: Run card identifies the request and run ─────────────
  it('shows the run ID, mode, creation time, and request text', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ id: 'run-abc', resolvedMode: 'deep_work' })]),
    );
    render(
      <MissionRunList
        companyId="company-1"
        projectId="project-1"
        requestTexts={{ 'run-abc': 'Analyze the quarterly report' }}
      />,
      { wrapper },
    );
    const card = screen.getByRole('article');
    // Run ID is visible as a heading
    expect(within(card).getByText(/run-abc/i)).toBeInTheDocument();
    // Mode is visible
    expect(within(card).getByText(/deep work/i)).toBeInTheDocument();
    // Request text is visible
    expect(within(card).getByText(/Analyze the quarterly report/i)).toBeInTheDocument();
    // Creation time is visible
    expect(within(card).getByText(/2026/i)).toBeInTheDocument();
  });

  it('shows the request content hash when request text is unavailable', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary()]));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/hash-1/i)).toBeInTheDocument();
  });

  // ── VAL-RUN-017: Run status is textual and authoritative ─────────────
  it('displays the textual status from the authoritative snapshot', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'running' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult(runSnapshot({ status: 'running' })));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  // ── VAL-RUN-017 (Normative Boundary 1): badge/flags derive from the
  //    authoritative snapshot, not the stale list row.
  it('derives the status badge from snapshot.status when it diverges from run.status', () => {
    // Stale list row says queued, authoritative snapshot says running.
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'queued' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult(runSnapshot({ status: 'running' })));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Badge must show the authoritative snapshot status, not the stale row.
    expect(screen.getByText(/^running$/i)).toBeInTheDocument();
    expect(screen.queryByText(/^queued$/i)).not.toBeInTheDocument();
  });

  it('hides the Cancel control when the snapshot is terminal even if the list row is not', () => {
    // Stale list row says running, authoritative snapshot says completed.
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'running' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'completed', terminalAt: '2026-08-20T10:05:00.000Z' })),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // isTerminal derived from snapshot suppresses the Cancel control.
    expect(screen.queryByRole('button', { name: /cancel mission/i })).not.toBeInTheDocument();
    // Badge reflects the authoritative terminal status.
    expect(screen.getAllByText(/^completed$/i).length).toBeGreaterThan(0);
  });

  it('hides the Retry control when the snapshot is nonterminal even if the list row is terminal', () => {
    // Stale list row says failed, authoritative snapshot says running.
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'failed' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult(runSnapshot({ status: 'running' })));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // canRetry derived from snapshot is false; no Retry button.
    expect(screen.queryByRole('button', { name: /retry mission/i })).not.toBeInTheDocument();
    // Badge reflects the authoritative nonterminal status.
    expect(screen.getByText(/^running$/i)).toBeInTheDocument();
  });

  it('does not advance status without a newer server state version', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'queued', stateVersion: 2 })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'queued', stateVersion: 2 })),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/queued/i)).toBeInTheDocument();
    expect(screen.queryByText(/completed/i)).not.toBeInTheDocument();
  });

  // ── VAL-RUN-018: Every lifecycle status renders as explicit text ─────
  const statuses: [string, RegExp][] = [
    ['planning', /planning/i],
    ['awaiting_input', /awaiting input/i],
    ['awaiting_approval', /awaiting approval/i],
    ['queued', /queued/i],
    ['running', /running/i],
    ['synthesizing', /synthesizing/i],
    ['completed', /completed/i],
    ['failed', /failed/i],
    ['cancelled', /cancelled/i],
  ];
  for (const [status, pattern] of statuses) {
    it(`renders "${status}" as explicit text`, () => {
      mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status })]));
      mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult(runSnapshot({ status })));
      render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
        wrapper,
      });
      // The status badge is a <span>; the cancelled card also adds an
      // explicit cancellation detail, so target the badge element.
      expect(screen.getByText(pattern, { selector: 'span' })).toBeInTheDocument();
    });
  }

  it('shows cancellation requested as a separate indicator, not an invented status', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'running', stateVersion: 3 })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          status: 'running',
          stateVersion: 3,
          cancelRequestedAt: '2026-08-20T10:01:00.000Z',
          cancelRequestedBy: 'user-1',
        }),
      ),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    expect(screen.getByText(/cancellation requested/i)).toBeInTheDocument();
  });

  // ── VAL-RUN-044: Completed card exposes the outcome ──────────────────
  it('shows completion, output links, completion time, and budget on a completed card', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'completed', stateVersion: 5 })]),
    );
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          status: 'completed',
          stateVersion: 5,
          terminalAt: '2026-08-20T10:05:00.000Z',
          budget: {
            reservedCents: 500,
            settledCents: 150,
            releasedCents: 350,
            costCentsCeiling: 500,
            actualCostCents: 150,
          },
          artifacts: [],
        }),
      ),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    // Status badge shows completed
    expect(within(card).getAllByText(/completed/i).length).toBeGreaterThan(0);
    // Completion time is visible
    expect(within(card).getByText(/completed at/i)).toBeInTheDocument();
    // Budget: settled cost and ceiling (distinct amounts so no collision)
    expect(within(card).getByText(/\$1\.50/)).toBeInTheDocument();
    expect(within(card).getByText(/\$5\.00/)).toBeInTheDocument();
  });

  // ── VAL-RUN-060: Active card shows budget status ──────────────────────
  it('exposes reserved/ceiling and settled cost as nonnegative currency', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'running' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          status: 'running',
          budget: {
            reservedCents: 5000,
            settledCents: 1200,
            releasedCents: 0,
            costCentsCeiling: 5000,
            actualCostCents: 1200,
          },
        }),
      ),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Ceiling
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
    // Settled cost
    expect(screen.getByText(/\$12\.00/)).toBeInTheDocument();
  });

  it('never shows spending above the run ceiling', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary()]));
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          budget: {
            reservedCents: 500,
            settledCents: 500,
            releasedCents: 0,
            costCentsCeiling: 500,
            actualCostCents: 500,
          },
        }),
      ),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const budgetSection = screen.getByTestId('budget-status');
    expect(budgetSection).toBeInTheDocument();
    // Both ceiling and spent show $5.00 (settled == ceiling, not above)
    const amounts = within(budgetSection).getAllByText(/\$5\.00/);
    expect(amounts).toHaveLength(2);
  });

  // ── VAL-RUN-074: Auditable lifecycle outcomes are visible ─────────────
  it('shows event journal entries in the timeline with type and timestamp', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ lastEventSequence: 4 })]),
    );
    mocks.useMissionRunEvents.mockReturnValue(
      eventsResult([
        evt(1, 'run.created', { payload: { runId: 'run-1', status: 'draft' } }),
        evt(2, 'mode.resolved', { payload: { resolvedMode: 'fast' } }),
        evt(3, 'policy.snapshotted', { payload: { contentHash: 'abc123' } }),
        evt(4, 'budget.reserved', { payload: { reservedCents: 500 } }),
      ]),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const timeline = screen.getByRole('list', { name: /event timeline/i });
    expect(timeline).toBeInTheDocument();
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    // Events in chronological order
    expect(within(items[0]).getByText(/run\.created/i)).toBeInTheDocument();
    expect(within(items[3]).getByText(/budget\.reserved/i)).toBeInTheDocument();
  });

  // ── VAL-RUN-095: Run landmarks and chronology are semantic ───────────
  it('has a meaningful heading/landmark for the Mission runs area', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult());
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByRole('region', { name: /mission runs/i })).toBeInTheDocument();
  });

  it('each run card has a discernible heading', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ id: 'run-xyz' })]));
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const heading = screen.getByRole('heading', { name: /run-xyz/i });
    expect(heading).toBeInTheDocument();
  });

  it('exposes event history in chronological semantic order matching event sequence', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ lastEventSequence: 3 })]),
    );
    mocks.useMissionRunEvents.mockReturnValue(
      eventsResult([evt(1, 'run.created'), evt(2, 'mode.resolved'), evt(3, 'budget.reserved')]),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const list = screen.getByRole('list', { name: /event timeline/i });
    const items = within(list).getAllByRole('listitem');
    // Ordered list, items in sequence order — use exact text match for seq
    expect(within(items[0]).getByText(/^1$/)).toBeInTheDocument();
    expect(within(items[1]).getByText(/^2$/)).toBeInTheDocument();
    expect(within(items[2]).getByText(/^3$/)).toBeInTheDocument();
  });

  // ── VAL-RUN-098: Multiple runs remain distinguishable ────────────────
  it('renders multiple run cards, each with its own ID, status, and budget', () => {
    const run1 = runSummary({
      id: 'run-aaa',
      status: 'running',
      requestContentHash: 'hash-aaa',
      createdAt: '2026-08-20T09:00:00.000Z',
    });
    const run2 = runSummary({
      id: 'run-bbb',
      status: 'completed',
      requestContentHash: 'hash-bbb',
      createdAt: '2026-08-20T10:00:00.000Z',
    });
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([run1, run2]));
    // The badge derives from the authoritative snapshot, so mock a
    // per-run snapshot whose status matches each list row.
    mocks.useMissionRunSnapshot.mockImplementation((_c: string, _p: string, runId: string) =>
      snapshotResult(
        runSnapshot({
          id: runId,
          status: runId === 'run-aaa' ? 'running' : 'completed',
          terminalAt: runId === 'run-bbb' ? '2026-08-20T10:10:00.000Z' : null,
        }),
      ),
    );
    render(
      <MissionRunList
        companyId="company-1"
        projectId="project-1"
        requestTexts={{
          'run-aaa': 'First mission request',
          'run-bbb': 'Second mission request',
        }}
      />,
      { wrapper },
    );
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    // Each has its own heading
    expect(within(cards[0]).getByText(/run-aaa/i)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/run-bbb/i)).toBeInTheDocument();
    // Each has its own request text
    expect(within(cards[0]).getByText(/First mission request/i)).toBeInTheDocument();
    expect(within(cards[1]).getByText(/Second mission request/i)).toBeInTheDocument();
    // Each has its own status
    expect(within(cards[0]).getByText(/running/i)).toBeInTheDocument();
    expect(within(cards[1]).getAllByText(/completed/i).length).toBeGreaterThan(0);
  });

  it('acting on one card does not affect another card display', () => {
    const run1 = runSummary({
      id: 'run-aaa',
      status: 'queued',
      requestContentHash: 'hash-aaa',
    });
    const run2 = runSummary({
      id: 'run-bbb',
      status: 'completed',
      requestContentHash: 'hash-bbb',
    });
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([run1, run2]));
    // Badge derives from the authoritative snapshot; mock per-run snapshots.
    mocks.useMissionRunSnapshot.mockImplementation((_c: string, _p: string, runId: string) =>
      snapshotResult(
        runSnapshot({
          id: runId,
          status: runId === 'run-aaa' ? 'queued' : 'completed',
          terminalAt: runId === 'run-bbb' ? '2026-08-20T10:10:00.000Z' : null,
        }),
      ),
    );
    render(
      <MissionRunList
        companyId="company-1"
        projectId="project-1"
        requestTexts={{ 'run-aaa': 'Queued run', 'run-bbb': 'Done run' }}
      />,
      { wrapper },
    );
    const cards = screen.getAllByRole('article');
    // Card 0 has status queued
    expect(within(cards[0]).getByText(/^queued$/i)).toBeInTheDocument();
    // Card 1 has status completed
    expect(within(cards[1]).getAllByText(/^completed$/i).length).toBeGreaterThan(0);
    // Card 0 does not show completed status
    expect(within(cards[0]).queryByText(/^completed$/i)).not.toBeInTheDocument();
  });

  // ── Failed card ──────────────────────────────────────────────────────
  it('shows a safe error message on a failed card without exposing secrets', () => {
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'failed' })]));
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          status: 'failed',
          terminalAt: '2026-08-20T10:03:00.000Z',
          failureCategory: 'provider_transient',
          failureCode: 'PROVIDER_TIMEOUT',
          safeErrorMessage: 'The provider timed out. Please retry.',
        }),
      ),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    // Status badge shows failed
    expect(within(card).getAllByText(/failed/i).length).toBeGreaterThan(0);
    // Safe error message is visible
    expect(within(card).getByText(/provider timed out/i)).toBeInTheDocument();
    // No secrets or stack traces
    expect(screen.queryByText(/api[_-]key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/stack trace/i)).not.toBeInTheDocument();
  });

  // ── Loading and error states ─────────────────────────────────────────
  it('shows a loading indicator while runs are loading', () => {
    mocks.useMissionRunsPaginated.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/loading runs/i)).toBeInTheDocument();
  });

  it('shows an error state with retry option when the list fails to load', () => {
    mocks.useMissionRunsPaginated.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    expect(screen.getByText(/could not load/i)).toBeInTheDocument();
  });
});
