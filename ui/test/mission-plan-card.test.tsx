import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionPlanCard } from '../src/components/projects/MissionPlanCard';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import type { MissionPlanRevision } from '../src/lib/api';

const mocks = vi.hoisted(() => ({
  useMissionCurrentPlanRevision: vi.fn(),
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
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
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

vi.mock('@/lib/auth', () => ({
  useSession: () => ({
    isPending: false,
    data: {
      user: {
        id: 'dev-user-000',
        name: 'Local Operator',
        email: 'local@eidolon.dev',
        image: '',
        role: 'admin',
      },
      session: {
        id: 'local-dev-session',
        userId: 'dev-user-000',
        activeOrganizationId: null,
        activeOrganizationRole: 'admin',
      },
    },
  }),
  isLocalTrustedAuth: () => false,
  CLERK_PUBLISHABLE_KEY: '',
}));

/** A complete PlanContentV1 with two ordered, dependent steps. */
function planRevision(overrides: Partial<MissionPlanRevision> = {}): MissionPlanRevision {
  return {
    id: 'plan-rev-1',
    revision: 1,
    status: 'proposed',
    contentHash: 'a'.repeat(64),
    parentRevisionId: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    content: {
      schemaVersion: 1,
      objective: 'Analyze the quarterly revenue report and produce a cited summary.',
      steps: [
        {
          stepKey: 'step-1',
          parentStepKey: null,
          childOrdinal: 0,
          nodeKind: 'root',
          title: 'Gather source data',
          description: 'Retrieve the quarterly revenue figures and supporting documents.',
          dependencies: [],
          inputBindings: [
            {
              name: 'report',
              source: { kind: 'requestContext', key: 'reportRef' },
            },
          ],
          routing: {
            kind: 'requirements',
            routingRequirements: {
              capabilities: ['research'],
              requiredTools: ['research.search', 'research.extract'],
              requiredDomains: ['example.com'],
              ephemeralAllowed: true,
            },
          },
          toolAllowlist: ['research.search', 'research.extract'],
          replayClass: 'read_only',
          sideEffecting: false,
          expectedOutputs: ['sourceSet'],
          evidenceRequirements: { citationsRequired: false },
          completionCriteria: 'At least three independent sources are retrieved and normalized.',
          budgetCents: 500,
          limits: {},
        },
        {
          stepKey: 'step-2',
          parentStepKey: null,
          childOrdinal: 1,
          nodeKind: 'child',
          title: 'Synthesize cited summary',
          description: 'Produce a cited summary from the gathered sources.',
          dependencies: ['step-1'],
          inputBindings: [
            {
              name: 'sources',
              source: { kind: 'stepOutput', stepKey: 'step-1', output: 'sourceSet' },
            },
          ],
          routing: {
            kind: 'concreteAgent',
            executingAgentId: 'agent-42',
          },
          toolAllowlist: ['artifact.create'],
          replayClass: 'idempotent_write',
          sideEffecting: true,
          expectedOutputs: ['summaryArtifact'],
          evidenceRequirements: { citationsRequired: true },
          completionCriteria:
            'Summary artifact is committed with inline citations for every claim.',
          budgetCents: 1000,
          limits: {},
        },
      ],
      synthesis: {
        instructions: 'Merge step outputs into one cited summary artifact.',
        declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-2', output: 'summaryArtifact' }],
        declaredOutput: 'finalSummary',
        evidenceRequirements: { citationsRequired: true },
        completionCriteria: 'Final summary cites every external factual claim.',
        budgetCents: 200,
      },
      planningBudgetCents: 50,
      partialResultPolicy: 'require_all',
      limits: {
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 48,
        totalTokens: 300000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 12,
      },
      presentationMetadata: {
        cardTitle: 'Quarterly revenue analysis',
        summary: 'A two-step research and synthesis plan.',
      },
    },
    ...overrides,
  };
}

function planQueryResult(revision: MissionPlanRevision | null = planRevision()) {
  return {
    data: revision,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
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

describe('MissionPlanCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMissionCurrentPlanRevision.mockReturnValue(planQueryResult());
  });

  // ── VAL-PLAN-011: Plan card identifies the objective ─────────────────
  it('renders the plan objective', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    expect(
      screen.getByText(/Analyze the quarterly revenue report and produce a cited summary/i),
    ).toBeInTheDocument();
  });

  // ── VAL-PLAN-012: Plan card shows ordered steps ──────────────────────
  it('renders steps in a semantic ordered list preserving plan order', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    const list = screen.getByRole('list', { name: /plan steps/i });
    expect(list.tagName).toBe('OL');
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // Order matches plan step order: step-1 first, step-2 second.
    expect(within(items[0]).getByText(/Gather source data/i)).toBeInTheDocument();
    expect(within(items[1]).getByText(/Synthesize cited summary/i)).toBeInTheDocument();
  });

  // ── VAL-PLAN-013: Plan card shows dependencies ───────────────────────
  it('renders each step\u2019s ordered dependencies', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    // step-2 depends on step-1; step-1 has no dependencies.
    expect(screen.getByText(/depends on step-1/i)).toBeInTheDocument();
    expect(screen.getByText(/no dependencies/i)).toBeInTheDocument();
  });

  // ── VAL-PLAN-014: Plan card distinguishes routing authority from
  //    execution assignment ─────────────────────────────────────────────
  it('distinguishes requirements routing from concrete agent assignment', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    // step-1: requirements routing (authority, not yet assigned).
    expect(screen.getByText(/pending routing/i)).toBeInTheDocument();
    expect(screen.getByText(/capabilities: research/i)).toBeInTheDocument();
    // step-2: concrete agent (execution assignment).
    expect(screen.getByText(/assigned to agent-42/i)).toBeInTheDocument();
  });

  // ── VAL-PLAN-015: Plan card shows exact tools ────────────────────────
  it('renders the exact tool allowlist for each step', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    expect(screen.getByText('research.search')).toBeInTheDocument();
    expect(screen.getByText('research.extract')).toBeInTheDocument();
    expect(screen.getByText('artifact.create')).toBeInTheDocument();
  });

  // ── VAL-PLAN-016: Plan card shows expected outputs ───────────────────
  it('renders each step\u2019s expected outputs', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    expect(screen.getByText('sourceSet')).toBeInTheDocument();
    expect(screen.getByText('summaryArtifact')).toBeInTheDocument();
  });

  // ── VAL-PLAN-017: Plan card shows completion criteria ────────────────
  it('renders each step\u2019s completion criteria', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    expect(
      screen.getByText(/At least three independent sources are retrieved and normalized/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Summary artifact is committed with inline citations for every claim/i),
    ).toBeInTheDocument();
  });

  // ── VAL-PLAN-008: Analyst always proposes an evidence plan ───────────
  it('renders evidence/citation requirements for an Analyst-mode plan', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="analyst"
      />,
      { wrapper },
    );
    // The Analyst plan requires citations on the synthesis and step-2.
    expect(screen.getAllByText(/citations required/i).length).toBeGreaterThan(0);
  });

  it('does not render a card when there is no current plan revision id', () => {
    const { container } = render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId={null}
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders an accessible heading and revision/hash identity', () => {
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
      />,
      { wrapper },
    );
    // The card has a heading identifying it as the proposed plan.
    const heading = screen.getByRole('heading', { name: /proposed plan/i });
    expect(heading).toBeInTheDocument();
    // Revision number and content hash prefix are shown.
    expect(screen.getByText(/revision 1/i)).toBeInTheDocument();
    expect(screen.getByText(/a{12}/i)).toBeInTheDocument();
  });
});

// ── VAL-PLAN-125: Preapproval and postrouting agent labels cannot
//    mislead — composed integration through MissionRunCard. ──────────────
describe('MissionPlanCard routing labels (VAL-PLAN-125)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useMissionRunsPaginated.mockReturnValue({
      data: {
        pages: [
          {
            runs: [
              {
                id: 'run-1',
                companyId: 'company-1',
                projectId: 'project-1',
                status: 'awaiting_approval',
                stateVersion: 5,
                lastEventSequence: 7,
                resolvedMode: 'deep_work',
                policyContentHash: 'abc123',
                requestContentHash: 'hash-1',
                createdAt: '2026-08-23T10:00:00.000Z',
                updatedAt: '2026-08-23T10:00:00.000Z',
              },
            ],
            nextCursor: null,
          },
        ],
        pageParams: [undefined],
      },
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: {
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
        status: 'awaiting_approval',
        stateVersion: 5,
        lastEventSequence: 7,
        resolvedMode: 'deep_work',
        modeProfileId: null,
        policySnapshotId: 'policy-1',
        policyContentHash: 'abc123',
        requestContentHash: 'hash-1',
        currentQuestionSetId: null,
        currentPlanRevisionId: 'plan-rev-1',
        approvedPlanRevisionId: null,
        waitingFromStatus: 'planning',
        partialResultPolicy: 'require_all',
        cancelRequestedAt: null,
        cancelRequestedBy: null,
        cancellationDeadlineAt: null,
        failureCategory: null,
        failureCode: null,
        safeErrorMessage: null,
        startedAt: null,
        terminalAt: null,
        createdAt: '2026-08-23T10:00:00.000Z',
        updatedAt: '2026-08-23T10:00:00.000Z',
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
      },
      isLoading: false,
      isError: false,
    });
    mocks.useMissionRunEvents.mockReturnValue({
      data: { events: [], nextCursor: 0, latestSequence: 7 },
      isLoading: false,
      isError: false,
    });
    mocks.useStartMissionRun.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    mocks.useMissionRunStream.mockReturnValue({
      status: 'connected',
      lastSequence: 7,
      gapDetected: false,
    });
    mocks.useMissionCurrentPlanRevision.mockReturnValue(planQueryResult());
  });

  it('shows honest pre-routing and post-routing labels across assigned and unassigned steps', () => {
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Unassigned (requirements) step: pending routing, never implies an agent.
    expect(screen.getByText(/pending routing/i)).toBeInTheDocument();
    expect(screen.queryByText(/assigned to .*step-1/i)).not.toBeInTheDocument();
    // Assigned (concreteAgent) step: assigned to agent-42, never implies pending.
    expect(screen.getByText(/assigned to agent-42/i)).toBeInTheDocument();
  });
});
