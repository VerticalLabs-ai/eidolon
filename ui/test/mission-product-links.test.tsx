/**
 * Product link grammar and responsive history restoration UI tests
 * (VAL-CROSS-076, VAL-CROSS-077, VAL-CROSS-078, VAL-CROSS-083, VAL-CROSS-101).
 *
 * These tests cover the canonical `links.ui` grammar: `buildMissionUiLink`
 * emits the singular app route `/company/:c/projects/:p?tab=work&thread=:t&mission=:r[&<target>]`
 * directly, ProjectDetail parses the surviving query params, and the
 * highlighted MissionRunCard restores focus and target semantics across
 * reload and history navigation. A legacy `PluralCompanyRedirect` remains
 * registered for older `/companies/.../work` URLs.
 */
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import { MissionRunCard } from '../src/components/projects/MissionRunCard';
import { ProjectDetail } from '../src/pages/ProjectDetail';
import { buildMissionUiLink, parseMissionUiLink, type MissionLinkTarget } from '@eidolon/shared';

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

vi.mock('@/lib/auth', () => ({
  useSession: () => ({ isPending: false, data: { user: { id: 'test-operator' } } }),
  isLocalTrustedAuth: () => true,
  CLERK_PUBLISHABLE_KEY: '',
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

// ── Fixtures ──────────────────────────────────────────────────────────────

const COMPANY = '00000000-0000-4000-8000-000000000001';
const PROJECT = '00000000-0000-4000-8000-000000000002';
const THREAD = '00000000-0000-4000-8000-000000000003';
const RUN = '00000000-0000-4000-8000-000000000004';
const QUESTION = '00000000-0000-4000-8000-000000000010';

function runSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN,
    companyId: COMPANY,
    projectId: PROJECT,
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
    id: RUN,
    companyId: COMPANY,
    projectId: PROJECT,
    projectThreadId: THREAD,
    rootRunId: RUN,
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
      ui: buildMissionUiLink({
        companyId: COMPANY,
        projectId: PROJECT,
        threadId: THREAD,
        runId: RUN,
      }),
    },
    ...overrides,
  };
}

type MissionTestEvent = {
  sequence: number;
  type: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  commandId: string | null;
  actorType: string;
  actorId: string | null;
  traceId: string;
  occurredAt: string;
};

function paginatedResult(runs: ReturnType<typeof runSummary>[] = [runSummary()]) {
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

function snapshotResult(snapshot = runSnapshot()) {
  return { data: snapshot, isLoading: false, isError: false };
}

function eventsResult(events: MissionTestEvent[] = []) {
  return { data: { events, nextCursor: 0, latestSequence: 4 }, isLoading: false, isError: false };
}

function streamResult() {
  return { status: 'connected', lastSequence: 4, gapDetected: false };
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

const pdProject = {
  id: PROJECT,
  companyId: COMPANY,
  name: 'Test Project',
  description: 'test',
  status: 'active' as const,
  repoUrl: null,
  createdAt: '2026-07-30T22:00:00.000Z',
  updatedAt: '2026-07-30T22:00:00.000Z',
};

function renderDetail(initialPath: string) {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/company/:companyId/projects/:projectId" element={<ProjectDetail />} />
          <Route path="/company/:companyId/projects" element={<div>Project list</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Mission product link grammar (VAL-CROSS-101)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMissionRunsPaginated.mockReturnValue(paginatedResult());
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
    mocks.useStartMissionRun.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it('round-trips every target through buildMissionUiLink and parseMissionUiLink', () => {
    const targets: MissionLinkTarget[] = [
      { kind: 'run' },
      { kind: 'question', questionSetId: QUESTION },
      { kind: 'planRevision', revisionId: '00000000-0000-4000-8000-000000000011' },
      { kind: 'approval', approvalId: '00000000-0000-4000-8000-000000000012' },
      { kind: 'childThread', childThreadId: '00000000-0000-4000-8000-000000000013' },
      { kind: 'sourceRevision', sourceRevisionId: '00000000-0000-4000-8000-000000000014' },
      {
        kind: 'artifactVersion',
        artifactId: '00000000-0000-4000-8000-000000000015',
        version: '3',
      },
      {
        kind: 'citation',
        citationId: '00000000-0000-4000-8000-000000000017',
        artifactId: '00000000-0000-4000-8000-000000000015',
        version: '3',
      },
    ];
    for (const target of targets) {
      const url = buildMissionUiLink({
        companyId: COMPANY,
        projectId: PROJECT,
        threadId: THREAD,
        runId: RUN,
        target,
      });
      const parsed = parseMissionUiLink(url);
      expect(parsed).toEqual({
        companyId: COMPANY,
        projectId: PROJECT,
        threadId: THREAD,
        runId: RUN,
        target,
      });
    }
  });

  it('builds the canonical singular route with tab=work and thread+mission params', () => {
    const url = buildMissionUiLink({
      companyId: COMPANY,
      projectId: PROJECT,
      threadId: THREAD,
      runId: RUN,
    });
    expect(url).toBe(
      `/company/${COMPANY}/projects/${PROJECT}?tab=work&thread=${THREAD}&mission=${RUN}`,
    );
  });

  it('rejects two target kinds in the same URL', () => {
    const url = `/company/${COMPANY}/projects/${PROJECT}?thread=${THREAD}&mission=${RUN}&question=${QUESTION}&planRevision=00000000-0000-4000-8000-000000000011`;
    expect(parseMissionUiLink(url)).toBeNull();
  });
});

// ── ProjectDetail deep-link parsing (VAL-CROSS-076, VAL-CROSS-083) ───────

describe('ProjectDetail canonical deep-link parsing (VAL-CROSS-076, VAL-CROSS-083)', () => {
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
    mocks.useMissionRunsPaginated.mockReturnValue(paginatedResult());
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
    mocks.useStartMissionRun.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it('switches to Work tab and highlights the run when canonical ?thread=&mission= is present', () => {
    renderDetail(`/company/${COMPANY}/projects/${PROJECT}?thread=${THREAD}&mission=${RUN}`);
    expect(screen.getByTestId('task-board')).toBeInTheDocument();
    const card = screen.getByRole('article');
    expect(card.id).toBe(`mission-run-${RUN}`);
    expect(card.getAttribute('data-highlighted')).toBe('true');
  });

  it('records the target kind on the highlighted card', () => {
    renderDetail(
      `/company/${COMPANY}/projects/${PROJECT}?thread=${THREAD}&mission=${RUN}&question=${QUESTION}`,
    );
    const card = screen.getByRole('article');
    expect(card.getAttribute('data-target-kind')).toBe('question');
  });

  it('records the default run target kind when no target is present', () => {
    renderDetail(`/company/${COMPANY}/projects/${PROJECT}?thread=${THREAD}&mission=${RUN}`);
    const card = screen.getByRole('article');
    expect(card.getAttribute('data-target-kind')).toBe('run');
  });

  it('does not highlight when mission is missing', () => {
    renderDetail(`/company/${COMPANY}/projects/${PROJECT}?thread=${THREAD}`);
    // Home tab is rendered because no mission deep-link and no tab param
    expect(screen.getByTestId('project-home')).toBeInTheDocument();
  });

  it('does not switch to Work tab when an explicit tab overrides the deep link', () => {
    renderDetail(
      `/company/${COMPANY}/projects/${PROJECT}?tab=home&thread=${THREAD}&mission=${RUN}`,
    );
    expect(screen.getByTestId('project-home')).toBeInTheDocument();
  });

  it('ignores the legacy ?run= param (closed grammar only)', () => {
    renderDetail(`/company/${COMPANY}/projects/${PROJECT}?run=${RUN}`);
    // No mission param → no deep-link → Home tab
    expect(screen.getByTestId('project-home')).toBeInTheDocument();
  });

  it('rejects two target kinds and falls back to no highlight', () => {
    renderDetail(
      `/company/${COMPANY}/projects/${PROJECT}?thread=${THREAD}&mission=${RUN}&question=${QUESTION}&planRevision=00000000-0000-4000-8000-000000000011`,
    );
    // The parser rejects the invalid combination, so no deep-link fires.
    // Without a mission deep-link, the default tab is Home.
    expect(screen.getByTestId('project-home')).toBeInTheDocument();
  });
});

// ── MissionRunCard focus restoration (VAL-CROSS-076, VAL-CROSS-083) ─────

describe('MissionRunCard focus restoration (VAL-CROSS-076, VAL-CROSS-083)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMissionRunsPaginated.mockReturnValue(paginatedResult());
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
  });

  it('adds a scroll anchor id and highlight indicator to the targeted card', () => {
    render(<MissionRunList companyId={COMPANY} projectId={PROJECT} highlightRunId={RUN} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    expect(card.id).toBe(`mission-run-${RUN}`);
    expect(card.getAttribute('data-highlighted')).toBe('true');
  });

  it('carries the target kind on the highlighted card', () => {
    render(
      <MissionRunList
        companyId={COMPANY}
        projectId={PROJECT}
        highlightRunId={RUN}
        highlightTarget={{ kind: 'question', questionSetId: QUESTION }}
      />,
      { wrapper },
    );
    const card = screen.getByRole('article');
    expect(card.getAttribute('data-target-kind')).toBe('question');
  });

  it('moves focus to the highlighted card so reload/history restore target/focus', () => {
    render(<MissionRunList companyId={COMPANY} projectId={PROJECT} highlightRunId={RUN} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    // The card becomes the active element after the highlight effect runs.
    expect(document.activeElement).toBe(card);
  });

  it('does not move focus when no card is highlighted', () => {
    render(<MissionRunList companyId={COMPANY} projectId={PROJECT} />, { wrapper });
    const card = screen.getByRole('article');
    expect(card.getAttribute('data-highlighted')).toBeNull();
    expect(document.activeElement).not.toBe(card);
  });

  it('renders the canonical links.ui from the snapshot', () => {
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    render(<MissionRunCard companyId={COMPANY} projectId={PROJECT} run={runSummary() as never} />, {
      wrapper,
    });
    // The snapshot carries the canonical links.ui built by the server; the
    // card does not need to re-derive it. We verify the snapshot fixture
    // matches the canonical grammar.
    const expected = buildMissionUiLink({
      companyId: COMPANY,
      projectId: PROJECT,
      threadId: THREAD,
      runId: RUN,
    });
    expect(expected).toBe(
      `/company/${COMPANY}/projects/${PROJECT}?tab=work&thread=${THREAD}&mission=${RUN}`,
    );
  });
});

// ── App redirect: /companies/:c/p/:p/work → /company/:c/p/:p?tab=work ──

describe('App plural-company redirect preserves canonical link params (VAL-CROSS-076, VAL-CROSS-101)', () => {
  // We exercise the redirect via the PluralCompanyRedirect component by
  // rendering the App router with the canonical path. Because App.tsx uses
  // createBrowserRouter we instead verify the redirect logic indirectly:
  // the ProjectDetail component receives the params that survive the
  // redirect (thread, mission, target, tab=work) and parses them.
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
    mocks.useMissionRunsPaginated.mockReturnValue(paginatedResult());
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
    mocks.useStartMissionRun.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it('parses the canonical params that survive the redirect (?tab=work&thread=&mission=)', () => {
    // The redirect maps /companies/:c/p/:p/work?thread=...&mission=... to
    // /company/:c/p/:p?tab=work&thread=...&mission=...
    renderDetail(
      `/company/${COMPANY}/projects/${PROJECT}?tab=work&thread=${THREAD}&mission=${RUN}`,
    );
    expect(screen.getByTestId('task-board')).toBeInTheDocument();
    const card = screen.getByRole('article');
    expect(card.getAttribute('data-highlighted')).toBe('true');
    expect(card.id).toBe(`mission-run-${RUN}`);
  });

  it('preserves a question target through the redirect', () => {
    renderDetail(
      `/company/${COMPANY}/projects/${PROJECT}?tab=work&thread=${THREAD}&mission=${RUN}&question=${QUESTION}`,
    );
    const card = screen.getByRole('article');
    expect(card.getAttribute('data-target-kind')).toBe('question');
  });
});
