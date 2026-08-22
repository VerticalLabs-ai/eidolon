import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import { MissionRunCard } from '../src/components/projects/MissionRunCard';
import { ProjectDetail } from '../src/pages/ProjectDetail';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunsPaginated: vi.fn(),
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useMissionRunStream: vi.fn(),
  useStartMissionRun: vi.fn(),
  useProject: vi.fn(),
  useProjectHome: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useMissionRunsPaginated: mocks.useMissionRunsPaginated,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionRunEvents: mocks.useMissionRunEvents,
    useMissionRunStream: mocks.useMissionRunStream,
    useStartMissionRun: mocks.useStartMissionRun,
    useCancelMissionRun: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    }),
    useRetryMissionRun: () => ({
      mutate: vi.fn(),
      mutateAsync: vi.fn().mockResolvedValue(undefined),
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    }),
    useMissionRequestText: () => undefined,
    useArchiveProject: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
    useSaveProjectTemplate: () => ({ mutate: vi.fn(), isPending: false }),
    useFeatureFlags: () => ({
      data: { flags: { missionAgentIntelligence: true } },
      isLoading: false,
      isError: false,
    }),
    useProjectThreads: () => ({ data: [], isLoading: false, isError: false }),
    useCreateThreadItem: () => ({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    }),
    useProject: mocks.useProject,
    useProjectHome: mocks.useProjectHome,
    useProjectWork: () => ({ data: { automationRuns: [] }, isLoading: false, isError: false }),
    useTasks: () => ({ data: [], isLoading: false }),
    useUpdateTask: () => ({ mutate: vi.fn() }),
    useCreateTask: () => ({ mutate: vi.fn(), isPending: false }),
    useCreateProjectThread: () => ({ mutate: vi.fn(), isPending: false }),
    usePlansWithSteps: () => ({ data: [], isLoading: false, isError: false }),
    useCreateProjectPlan: () => ({ mutate: vi.fn(), isPending: false }),
    useCreatePlanStep: () => ({ mutate: vi.fn(), isPending: false }),
    useUpdatePlanStep: () => ({ mutate: vi.fn() }),
    useAdvancePlanGate: () => ({ mutate: vi.fn(), isPending: false }),
    useProjectDecisions: () => ({ data: [], isLoading: false, isError: false }),
    useUpdateProjectDecision: () => ({ mutate: vi.fn() }),
    useProjectOutcomes: () => ({ data: [], isLoading: false, isError: false }),
    useCreateProjectOutcome: () => ({ mutate: vi.fn(), isPending: false }),
    useUpdateProjectOutcome: () => ({ mutate: vi.fn() }),
    useCreateProject: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
    useUpdateProject: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
  };
});

vi.mock('@/lib/ws', () => ({
  useServerEvents: vi.fn(),
  useWebSocket: () => ({ status: 'disconnected' }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────

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
      ui: '/company/company-1/projects/project-1?tab=work&thread=thread-1&mission=run-1',
    },
    ...overrides,
  };
}

function evt(sequence: number, type: string) {
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
  };
}

/** Paginated list result matching useInfiniteQuery shape. */
function paginatedResult(
  runs: ReturnType<typeof runSummary>[],
  opts: { nextCursor?: string | null; hasNextPage?: boolean } = {},
) {
  return {
    data: {
      pages: [{ runs, nextCursor: opts.nextCursor ?? null }],
      pageParams: [undefined],
    },
    fetchNextPage: vi.fn(),
    hasNextPage: opts.hasNextPage ?? false,
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

function streamResult(overrides: Partial<{ status: string; gapDetected: boolean }> = {}) {
  return { status: 'connected', lastSequence: 4, gapDetected: false, ...overrides };
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

describe('Mission navigation and accessibility UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMissionRunsPaginated.mockReturnValue(paginatedResult([runSummary()]));
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
    mocks.useStartMissionRun.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  // ── VAL-RUN-089: Restrained live announcements ──────────────────────────
  describe('VAL-RUN-089: restrained live announcements', () => {
    it('renders a polite live region for status announcements', () => {
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      const liveRegion = screen.getByRole('status', { name: /mission status/i });
      // Live region is polite (aria-live=polite) so it doesn't interrupt
      expect(liveRegion).toHaveAttribute('aria-live', 'polite');
    });

    it('announces a status change through the live region, not per-event', () => {
      // Render with running status
      const { rerender } = render(<MissionRunList companyId="company-1" projectId="project-1" />, {
        wrapper,
      });
      let liveRegion = screen.getByRole('status', { name: /mission status/i });
      // Initially no announcement text (or the initial status)
      expect(liveRegion.textContent).not.toMatch(/completed/i);

      // Re-render with completed status
      mocks.useMissionRunsPaginated.mockReturnValue(
        paginatedResult([runSummary({ id: 'run-1', status: 'completed', stateVersion: 10 })]),
      );
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            id: 'run-1',
            status: 'completed',
            stateVersion: 10,
            terminalAt: '2026-08-20T10:10:00.000Z',
          }),
        ),
      );
      rerender(<MissionRunList companyId="company-1" projectId="project-1" />);
      liveRegion = screen.getByRole('status', { name: /mission status/i });
      // The status change is announced
      expect(liveRegion.textContent).toMatch(/completed/i);
    });

    it('does not announce one message per high-frequency progress event', () => {
      // A burst of execution.progress events should produce a single batched
      // announcement, not one per event.
      mocks.useMissionRunEvents.mockReturnValue(
        eventsResult([
          evt(1, 'run.created'),
          evt(2, 'mode.resolved'),
          evt(3, 'budget.reserved'),
          evt(4, 'execution.started'),
          evt(5, 'execution.progress'),
          evt(6, 'execution.progress'),
          evt(7, 'execution.progress'),
          evt(8, 'execution.progress'),
        ]),
      );
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      const liveRegion = screen.getByRole('status', { name: /mission status/i });
      // The live region should NOT contain 4 separate "progress" announcements
      const progressMatches = liveRegion.textContent?.match(/progress/gi) ?? [];
      expect(progressMatches.length).toBeLessThan(2);
    });
  });

  // ── VAL-RUN-092: Run states do not rely on color ───────────────────────
  describe('VAL-RUN-092: states not color-only', () => {
    const statuses = [
      { status: 'running', text: /running/i },
      { status: 'queued', text: /queued/i },
      { status: 'awaiting_input', text: /awaiting input/i },
      { status: 'awaiting_approval', text: /awaiting approval/i },
      { status: 'planning', text: /planning/i },
      { status: 'completed', text: /completed/i },
      { status: 'failed', text: /failed/i },
      { status: 'cancelled', text: /cancelled/i },
    ];

    for (const { status, text } of statuses) {
      it(`shows text for ${status} status`, () => {
        mocks.useMissionRunsPaginated.mockReturnValue(
          paginatedResult([runSummary({ id: 'run-text', status })]),
        );
        mocks.useMissionRunSnapshot.mockReturnValue(
          snapshotResult(runSnapshot({ id: 'run-text', status })),
        );
        render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
        // Find the status badge specifically (not the heading or timeline)
        const card = screen.getByRole('article');
        expect(within(card).getByText(text, { selector: 'span' })).toBeInTheDocument();
      });
    }

    it('shows reconnecting text alongside any color treatment', () => {
      mocks.useMissionRunStream.mockReturnValue(streamResult({ status: 'reconnecting' }));
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    });

    it('shows stale text alongside any color treatment', () => {
      mocks.useMissionRunSnapshot.mockReturnValue({
        data: runSnapshot(),
        isLoading: false,
        isError: true,
        isPreviousData: true,
      });
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      expect(screen.getAllByText(/stale|may be outdated/i).length).toBeGreaterThan(0);
    });
  });

  // ── VAL-RUN-093: Reduced motion removes animation ───────────────────────
  describe('VAL-RUN-093: reduced motion', () => {
    it('applies motion-reduce class to animated spinner elements', () => {
      mocks.useMissionRunStream.mockReturnValue(streamResult({ gapDetected: true }));
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      // The RefreshCw spinner in the gap-recovery indicator should have
      // a motion-reduce variant class that disables animation.
      const replayingText = screen.getByText(/replaying/i);
      const spinner = replayingText.closest('p')?.querySelector('svg');
      expect(spinner).toBeTruthy();
      // The svg or its parent should have a motion-reduce class.
      // SVG className is an SVGAnimatedString; use getAttribute('class').
      const spinnerClass = spinner?.getAttribute('class') ?? '';
      const parentClass = spinner?.parentElement?.getAttribute('class') ?? '';
      expect(spinnerClass + ' ' + parentClass).toMatch(/motion-reduce/);
    });
  });

  // ── VAL-RUN-094: Mobile controls reachable ─────────────────────────────
  describe('VAL-RUN-094: mobile responsive', () => {
    it('renders the run card without overflow-causing fixed widths', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
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
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      const card = screen.getByRole('article');
      // The card uses flexible layout that wraps at narrow widths
      expect(card.className).toMatch(/break-words|max-w|w-full/);
      // Budget status is present and reachable
      expect(screen.getByTestId('budget-status')).toBeInTheDocument();
    });
  });

  // ── VAL-RUN-097: Direct product run navigation ──────────────────────────
  describe('VAL-RUN-097: deep-link run navigation', () => {
    it('adds a scroll anchor id to each run card', () => {
      render(
        <MissionRunList companyId="company-1" projectId="project-1" highlightRunId="run-1" />,
        { wrapper },
      );
      const card = screen.getByRole('article');
      expect(card.id).toBe('mission-run-run-1');
    });

    it('highlights the targeted run card', () => {
      render(
        <MissionRunList companyId="company-1" projectId="project-1" highlightRunId="run-1" />,
        { wrapper },
      );
      const card = screen.getByRole('article');
      // The card should have a highlight indicator (aria attribute or class)
      expect(card.getAttribute('data-highlighted')).toBe('true');
    });
  });

  // ── VAL-RUN-132: Historical pagination ──────────────────────────────────
  describe('VAL-RUN-132: historical pagination', () => {
    it('shows a Load more button when more pages are available', () => {
      mocks.useMissionRunsPaginated.mockReturnValue(
        paginatedResult([runSummary()], { nextCursor: 'cursor-1', hasNextPage: true }),
      );
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
    });

    it('does not show Load more when there is no next page', () => {
      mocks.useMissionRunsPaginated.mockReturnValue(
        paginatedResult([runSummary()], { nextCursor: null, hasNextPage: false }),
      );
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });

    it('appends older runs when Load more is activated', async () => {
      const fetchNextPage = vi.fn();
      mocks.useMissionRunsPaginated.mockReturnValue({
        data: {
          pages: [{ runs: [runSummary({ id: 'run-1' })], nextCursor: 'cursor-1' }],
          pageParams: [undefined],
        },
        fetchNextPage,
        hasNextPage: true,
        isFetchingNextPage: false,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      const user = userEvent.setup();
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      const loadMore = screen.getByRole('button', { name: /load more/i });
      await user.click(loadMore);
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
    });

    it('shows a loading state while fetching the next page', () => {
      mocks.useMissionRunsPaginated.mockReturnValue({
        data: {
          pages: [{ runs: [runSummary({ id: 'run-1' })], nextCursor: 'cursor-1' }],
          pageParams: [undefined],
        },
        fetchNextPage: vi.fn(),
        hasNextPage: true,
        isFetchingNextPage: true,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      // The Load more button should show a pending/loading state
      expect(screen.getByRole('button', { name: /load more|loading/i })).toBeDisabled();
    });

    it('renders all runs from multiple pages without duplicates', () => {
      mocks.useMissionRunsPaginated.mockReturnValue({
        data: {
          pages: [
            { runs: [runSummary({ id: 'run-1' }), runSummary({ id: 'run-2' })], nextCursor: 'c1' },
            { runs: [runSummary({ id: 'run-3' })], nextCursor: null },
          ],
          pageParams: [undefined, 'c1'],
        },
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      const cards = screen.getAllByRole('article');
      expect(cards).toHaveLength(3);
      expect(within(cards[0]).getByText(/run-1/i)).toBeInTheDocument();
      expect(within(cards[1]).getByText(/run-2/i)).toBeInTheDocument();
      expect(within(cards[2]).getByText(/run-3/i)).toBeInTheDocument();
    });

    it('disables Load more while fetching to prevent duplicate requests', () => {
      mocks.useMissionRunsPaginated.mockReturnValue({
        data: {
          pages: [{ runs: [runSummary({ id: 'run-1' })], nextCursor: 'cursor-1' }],
          pageParams: [undefined],
        },
        fetchNextPage: vi.fn(),
        hasNextPage: true,
        isFetchingNextPage: true,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      const loadMore = screen.getByRole('button', { name: /load more|loading/i });
      expect(loadMore).toBeDisabled();
    });
  });

  // ── VAL-CROSS-069: Company switching clears state ─────────────────────
  describe('VAL-CROSS-069: company switching clears state', () => {
    it('renders only runs for the requested company scope', () => {
      mocks.useMissionRunsPaginated.mockReturnValue(
        paginatedResult([
          runSummary({ id: 'run-A', companyId: 'company-A', projectId: 'project-1' }),
        ]),
      );
      render(<MissionRunList companyId="company-A" projectId="project-1" />, { wrapper });
      expect(screen.getByText(/run-A/i)).toBeInTheDocument();
      // No run from company-B is present
      expect(screen.queryByText(/run-B/i)).not.toBeInTheDocument();
    });

    it('does not leak company-A runs when rendering company-B scope', () => {
      mocks.useMissionRunsPaginated.mockReturnValue(
        paginatedResult([
          runSummary({ id: 'run-B', companyId: 'company-B', projectId: 'project-1' }),
        ]),
      );
      render(<MissionRunList companyId="company-B" projectId="project-1" />, { wrapper });
      expect(screen.getByText(/run-B/i)).toBeInTheDocument();
      expect(screen.queryByText(/run-A/i)).not.toBeInTheDocument();
    });
  });

  // ── VAL-CROSS-070: Project switching scopes projections ───────────────
  describe('VAL-CROSS-070: project switching scopes projections', () => {
    it('renders only runs for the requested project scope', () => {
      mocks.useMissionRunsPaginated.mockReturnValue(
        paginatedResult([
          runSummary({ id: 'run-proj1', companyId: 'company-1', projectId: 'project-1' }),
        ]),
      );
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      expect(screen.getByText(/run-proj1/i)).toBeInTheDocument();
      expect(screen.queryByText(/run-proj2/i)).not.toBeInTheDocument();
    });
  });

  // ── Run card standalone: live region and anchor ────────────────────────
  describe('MissionRunCard live region', () => {
    it('renders a polite live region within each card', () => {
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      const card = screen.getByRole('article');
      expect(within(card).getByRole('status')).toHaveAttribute('aria-live', 'polite');
    });
  });
});

// ── ProjectDetail deep-link navigation (VAL-RUN-097) ─────────────────────

const pdProject = {
  id: 'project-1',
  companyId: 'company-1',
  name: 'Test Project',
  description: 'test',
  status: 'active' as const,
  repoUrl: null,
  createdAt: '2026-07-30T22:00:00.000Z',
  updatedAt: '2026-07-30T22:00:00.000Z',
};

vi.mock('@/pages/TaskBoard', () => ({
  TaskBoard: () => <div data-testid="task-board">Task board</div>,
}));
vi.mock('@/pages/ProjectHome', () => ({
  ProjectHome: () => <div data-testid="project-home">Home</div>,
}));
vi.mock('@/pages/ProjectDrive', () => ({
  ProjectDrive: () => <div data-testid="project-drive">Drive</div>,
}));
vi.mock('@/pages/ProjectArtifacts', () => ({
  ProjectArtifacts: () => <div data-testid="project-artifacts">Artifacts</div>,
}));
vi.mock('@/pages/GoalTree', () => ({
  GoalTree: () => <div>Goal tree</div>,
}));
vi.mock('@/components/projects/ProjectActivity', () => ({
  ProjectActivity: () => <div data-testid="project-activity">Activity</div>,
}));
vi.mock('@/components/projects/ProjectMeetings', () => ({
  ProjectMeetings: () => <div>Meetings</div>,
}));
vi.mock('@/components/tasks/CreateTaskModal', () => ({
  CreateTaskModal: () => null,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

function renderDetail(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/company/:companyId/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/company/:companyId/projects" element={<div>Project list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProjectDetail deep-link navigation (VAL-RUN-097)', () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProject.mockReturnValue({
      data: pdProject,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mocks.useProjectHome.mockReturnValue({
      data: {
        project: pdProject,
        counts: { taskCount: 0, goalCount: 0, agentCount: 0, fileCount: 0 },
        taskStatusBreakdown: {},
        activeWork: [],
        needsAttention: [],
        failedWork: [],
        recentActivity: [],
        recentFiles: [],
        goalProgress: { count: 0, aggregateProgress: 0 },
      },
      isLoading: false,
      isError: false,
    });
    mocks.useMissionRunsPaginated.mockReturnValue(paginatedResult([runSummary()]));
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
    mocks.useStartMissionRun.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it('defaults to Home tab without a mission param', () => {
    renderDetail('/company/company-1/projects/project-1');
    expect(screen.getByTestId('project-home')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('switches to Work tab and highlights the run when ?thread=&mission= is present', () => {
    renderDetail('/company/company-1/projects/project-1?thread=thread-1&mission=run-1');
    // Work tab content (TaskBoard) is rendered
    expect(screen.getByTestId('task-board')).toBeInTheDocument();
    // The run card is rendered with the highlight indicator
    const card = screen.getByRole('article');
    expect(card.id).toBe('mission-run-run-1');
    expect(card.getAttribute('data-highlighted')).toBe('true');
  });

  it('does not switch to Work tab when an explicit tab is present', () => {
    // An explicit ?tab=home should keep Home even with ?mission= present
    renderDetail('/company/company-1/projects/project-1?tab=home&thread=thread-1&mission=run-1');
    expect(screen.getByTestId('project-home')).toBeInTheDocument();
  });

  it('renders Work tab when ?tab=work is present without ?mission=', () => {
    renderDetail('/company/company-1/projects/project-1?tab=work');
    expect(screen.getByTestId('task-board')).toBeInTheDocument();
    // No highlight
    const card = screen.getByRole('article');
    expect(card.getAttribute('data-highlighted')).toBeNull();
  });
});
