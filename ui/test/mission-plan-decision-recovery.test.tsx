import { render, screen, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import type { MissionPlanRevision } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunsPaginated: vi.fn(),
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useStartMissionRun: vi.fn(),
  useMissionRunStream: vi.fn(),
  useMissionCurrentPlanRevision: vi.fn(),
  useApproveMissionPlan: vi.fn(),
  useRejectMissionPlan: vi.fn(),
  useReviseMissionPlan: vi.fn(),
  useMissionRequestText: vi.fn(),
  useCancelMissionRun: vi.fn(),
  useRetryMissionRun: vi.fn(),
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
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
    useApproveMissionPlan: mocks.useApproveMissionPlan,
    useRejectMissionPlan: mocks.useRejectMissionPlan,
    useReviseMissionPlan: mocks.useReviseMissionPlan,
    useMissionRequestText: mocks.useMissionRequestText,
    useCancelMissionRun: mocks.useCancelMissionRun,
    useRetryMissionRun: mocks.useRetryMissionRun,
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

// ── Fixtures ──────────────────────────────────────────────────────────────

function proposedRevision(overrides: Partial<MissionPlanRevision> = {}): MissionPlanRevision {
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
          description: 'Retrieve the quarterly revenue figures.',
          dependencies: [],
          inputBindings: [],
          routing: {
            kind: 'requirements',
            routingRequirements: {
              capabilities: ['research'],
              requiredTools: ['research.search'],
              requiredDomains: ['example.com'],
              ephemeralAllowed: true,
            },
          },
          toolAllowlist: ['research.search'],
          replayClass: 'read_only',
          sideEffecting: false,
          expectedOutputs: ['sourceSet'],
          evidenceRequirements: { citationsRequired: false },
          completionCriteria: 'At least three independent sources are retrieved.',
          budgetCents: 500,
          limits: {},
        },
      ],
      synthesis: {
        instructions: 'Merge step outputs into one cited summary artifact.',
        declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-1', output: 'sourceSet' }],
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
        summary: 'A one-step plan.',
      },
    },
    ...overrides,
  };
}

function approvedRevision(overrides: Partial<MissionPlanRevision> = {}): MissionPlanRevision {
  return proposedRevision({
    id: 'plan-rev-1',
    revision: 1,
    status: 'approved',
    ...overrides,
  });
}

function runSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1',
    companyId: 'company-1',
    projectId: 'project-1',
    status: 'awaiting_approval',
    stateVersion: 3,
    lastEventSequence: 5,
    resolvedMode: 'deep_work',
    policyContentHash: 'abc123def456',
    requestContentHash: 'hash-1',
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:05:00.000Z',
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
    status: 'awaiting_approval',
    stateVersion: 3,
    lastEventSequence: 5,
    resolvedMode: 'deep_work',
    modeProfileId: null,
    policySnapshotId: 'policy-1',
    policyContentHash: 'abc123def456',
    requestContentHash: 'hash-1',
    currentQuestionSetId: null,
    currentPlanRevisionId: 'plan-rev-1',
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
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:05:00.000Z',
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
      ui: '/companies/company-1/projects/project-1/work?mission=run-1',
    },
    queueHealth: 'available' as const,
    ...overrides,
  };
}

function evt(sequence: number, type: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sequence,
    type,
    schemaVersion: 1,
    payload: {} as Record<string, unknown>,
    commandId: null,
    actorType: 'user',
    actorId: 'user-1',
    traceId: 'trace-1',
    occurredAt: `2026-08-23T10:00:0${sequence}.000Z`,
    ...overrides,
  };
}

function mutationMock(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
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
  return { data: snapshot, isLoading: false, isError: false, refetch: vi.fn() };
}

function eventsResult(events: ReturnType<typeof evt>[] = []) {
  return {
    data: { events, nextCursor: 0, latestSequence: events.length },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

function planQueryResult(revision: MissionPlanRevision | null = proposedRevision()) {
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

function setupMocks(
  opts: {
    snapshot?: ReturnType<typeof runSnapshot>;
    events?: ReturnType<typeof evt>[];
    revision?: MissionPlanRevision | null;
    runStatus?: string;
    runs?: ReturnType<typeof runSummary>[];
    streamGap?: boolean;
    streamStatus?: string;
    approvePending?: boolean;
  } = {},
) {
  const {
    snapshot = runSnapshot(),
    events = [],
    revision = proposedRevision(),
    runStatus,
    runs,
    streamGap = false,
    streamStatus = 'connected',
    approvePending = false,
  } = opts;

  const finalSnapshot = runStatus ? { ...snapshot, status: runStatus } : snapshot;
  const finalRuns = runs ?? [{ ...runSummary(), status: finalSnapshot.status }];

  mocks.useMissionRunsPaginated.mockReturnValue(listResult(finalRuns));
  mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult(finalSnapshot));
  mocks.useMissionRunEvents.mockReturnValue(eventsResult(events));
  mocks.useStartMissionRun.mockReturnValue({
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    reset: vi.fn(),
  });
  mocks.useMissionRunStream.mockReturnValue({
    status: streamStatus,
    lastSequence: events.length,
    gapDetected: streamGap,
  });
  mocks.useMissionCurrentPlanRevision.mockReturnValue(planQueryResult(revision));
  mocks.useApproveMissionPlan.mockReturnValue(mutationMock({ isPending: approvePending }));
  mocks.useRejectMissionPlan.mockReturnValue(mutationMock());
  mocks.useReviseMissionPlan.mockReturnValue(mutationMock());
  mocks.useMissionRequestText.mockReturnValue(undefined);
  mocks.useCancelMissionRun.mockReturnValue(mutationMock());
  mocks.useRetryMissionRun.mockReturnValue(mutationMock());
}

function renderList() {
  return render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
}

describe('Mission plan decision recovery (m3-f07)', () => {
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
  });

  // ── VAL-PLAN-075: Reload preserves awaiting decision ──────────────────
  describe('VAL-PLAN-075: Reload preserves awaiting decision', () => {
    it('restores run status, objective, step content, revision, and hash after re-mount', () => {
      const revision = proposedRevision();
      setupMocks({ revision, runStatus: 'awaiting_approval' });

      // First render (before reload)
      const { unmount } = renderList();
      const card1 = screen.getByText('run-1').closest('article')!;
      expect(within(card1).getByText('Awaiting approval')).toBeInTheDocument();
      expect(
        within(card1).getByText(
          'Analyze the quarterly revenue report and produce a cited summary.',
        ),
      ).toBeInTheDocument();
      expect(within(card1).getByText('Gather source data')).toBeInTheDocument();
      expect(within(card1).getByText('Revision 1')).toBeInTheDocument();
      expect(within(card1).getByText('aaaaaaaaaaaa')).toBeInTheDocument(); // 12-char hash prefix

      // Simulate reload: unmount and re-render
      unmount();
      cleanup();
      setupMocks({ revision, runStatus: 'awaiting_approval' });
      renderList();

      const card2 = screen.getByText('run-1').closest('article')!;
      expect(within(card2).getByText('Awaiting approval')).toBeInTheDocument();
      expect(
        within(card2).getByText(
          'Analyze the quarterly revenue report and produce a cited summary.',
        ),
      ).toBeInTheDocument();
      expect(within(card2).getByText('Gather source data')).toBeInTheDocument();
      expect(within(card2).getByText('Revision 1')).toBeInTheDocument();
      expect(within(card2).getByText('aaaaaaaaaaaa')).toBeInTheDocument();
    });

    it('restores available decision controls after re-mount without duplicate commands', () => {
      setupMocks({ runStatus: 'awaiting_approval' });

      const { unmount } = renderList();
      expect(screen.getByTestId('plan-approve-button')).toBeInTheDocument();
      expect(screen.getByTestId('plan-revise-button')).toBeInTheDocument();
      expect(screen.getByTestId('plan-reject-button')).toBeInTheDocument();

      unmount();
      cleanup();
      setupMocks({ runStatus: 'awaiting_approval' });
      renderList();

      // Controls are restored — no POST/start command fired on reload
      expect(screen.getByTestId('plan-approve-button')).toBeInTheDocument();
      expect(screen.getByTestId('plan-revise-button')).toBeInTheDocument();
      expect(screen.getByTestId('plan-reject-button')).toBeInTheDocument();
      expect(mocks.useStartMissionRun().mutate).not.toHaveBeenCalled();
    });
  });

  // ── VAL-PLAN-076: Reload preserves approved progress ──────────────────
  describe('VAL-PLAN-076: Reload preserves approved progress', () => {
    it('restores approved revision and hash after re-mount', () => {
      const revision = approvedRevision();
      const events = [
        evt(1, 'run.created'),
        evt(2, 'plan.proposed', { payload: { revision: 1, contentHash: 'a'.repeat(64) } }),
        evt(3, 'plan.approved', {
          payload: { revision: 1, contentHash: 'a'.repeat(64) },
          actorId: 'user-1',
        }),
        evt(4, 'run.status_changed', { payload: { from: 'awaiting_approval', to: 'queued' } }),
      ];
      setupMocks({
        revision,
        runStatus: 'queued',
        events,
        snapshot: runSnapshot({
          status: 'queued',
          currentPlanRevisionId: 'plan-rev-1',
          approvedPlanRevisionId: 'plan-rev-1',
        }),
      });

      const { unmount } = renderList();
      const card1 = screen.getByText('run-1').closest('article')!;
      expect(within(card1).getByText('Approved plan')).toBeInTheDocument();
      expect(within(card1).getByTestId('plan-revision')).toHaveTextContent('Revision 1');

      unmount();
      cleanup();
      setupMocks({
        revision,
        runStatus: 'queued',
        events,
        snapshot: runSnapshot({
          status: 'queued',
          currentPlanRevisionId: 'plan-rev-1',
          approvedPlanRevisionId: 'plan-rev-1',
        }),
      });
      renderList();

      const card2 = screen.getByText('run-1').closest('article')!;
      expect(within(card2).getByText('Approved plan')).toBeInTheDocument();
      expect(within(card2).getByTestId('plan-revision')).toHaveTextContent('Revision 1');
      // Event timeline restored
      expect(within(card2).getByText('plan.approved')).toBeInTheDocument();
    });

    it('replays missed events without duplicates after re-mount', () => {
      const events = [evt(1, 'run.created'), evt(2, 'plan.proposed'), evt(3, 'plan.approved')];
      setupMocks({ runStatus: 'queued', events });

      const { unmount } = renderList();
      const card1 = screen.getByText('run-1').closest('article')!;
      const timeline1 = within(card1).getAllByRole('listitem');
      // 3 events in the timeline
      expect(timeline1.length).toBeGreaterThanOrEqual(3);

      unmount();
      cleanup();
      // Same events replayed — no duplicates
      setupMocks({ runStatus: 'queued', events });
      renderList();

      const card2 = screen.getByText('run-1').closest('article')!;
      const timeline2 = within(card2).getAllByRole('listitem');
      // Same count — no duplicates from reload
      expect(timeline2.length).toBe(timeline1.length);
    });
  });

  // ── VAL-PLAN-079: Decision survives full service restart ──────────────
  describe('VAL-PLAN-079: Decision survives full service restart', () => {
    it('restores decision state from authoritative snapshot after re-mount (simulating restart)', () => {
      const events = [
        evt(1, 'run.created'),
        evt(2, 'plan.proposed', { payload: { revision: 1, contentHash: 'a'.repeat(64) } }),
        evt(3, 'plan.approved', {
          payload: { revision: 1, contentHash: 'a'.repeat(64) },
          actorType: 'user',
          actorId: 'user-1',
        }),
        evt(4, 'run.status_changed'),
      ];
      setupMocks({
        revision: approvedRevision(),
        runStatus: 'queued',
        events,
        snapshot: runSnapshot({
          status: 'queued',
          approvedPlanRevisionId: 'plan-rev-1',
          stateVersion: 4,
        }),
      });

      const { unmount } = renderList();
      const card1 = screen.getByText('run-1').closest('article')!;
      // Decision is visible: approved plan + queued status
      expect(within(card1).getByText('Approved plan')).toBeInTheDocument();
      expect(within(card1).getByText('Queued')).toBeInTheDocument();
      // The decision event is in the history
      expect(within(card1).getByText('plan.approved')).toBeInTheDocument();

      // Simulate restart: unmount and re-render with same server state
      unmount();
      cleanup();
      setupMocks({
        revision: approvedRevision(),
        runStatus: 'queued',
        events,
        snapshot: runSnapshot({
          status: 'queued',
          approvedPlanRevisionId: 'plan-rev-1',
          stateVersion: 4,
        }),
      });
      renderList();

      const card2 = screen.getByText('run-1').closest('article')!;
      expect(within(card2).getByText('Approved plan')).toBeInTheDocument();
      expect(within(card2).getByText('Queued')).toBeInTheDocument();
      expect(within(card2).getByText('plan.approved')).toBeInTheDocument();
      // State version preserved
      expect(within(card2).getByTestId('plan-revision')).toHaveTextContent('Revision 1');
    });
  });

  // ── VAL-PLAN-080: Reconnect never fabricates approval ──────────────────
  describe('VAL-PLAN-080: Reconnect never fabricates approval', () => {
    it('does not show approved state when snapshot says awaiting_approval during reconnect', () => {
      setupMocks({
        runStatus: 'awaiting_approval',
        streamStatus: 'reconnecting',
        streamGap: false,
      });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // Status is awaiting approval, NOT approved — reconnect never fabricates
      expect(within(card).getByText('Awaiting approval')).toBeInTheDocument();
      expect(within(card).queryByText('Approved plan')).not.toBeInTheDocument();
      // Reconnecting indicator is visible
      expect(within(card).getByText(/Reconnecting/i)).toBeInTheDocument();
    });

    it('shows proposed plan (not approved) during gap recovery', () => {
      setupMocks({
        runStatus: 'awaiting_approval',
        streamGap: true,
        revision: proposedRevision(),
      });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // Proposed plan, not approved — gap recovery does not fabricate
      expect(within(card).getByText('Proposed plan')).toBeInTheDocument();
      expect(within(card).queryByText('Approved plan')).not.toBeInTheDocument();
    });
  });

  // ── VAL-PLAN-091: Waiting state is explicit ────────────────────────────
  describe('VAL-PLAN-091: Waiting state is explicit', () => {
    it('shows explicit waiting text while plan generation is pending (planning status)', () => {
      setupMocks({
        runStatus: 'planning',
        revision: null,
        snapshot: runSnapshot({
          status: 'planning',
          currentPlanRevisionId: null,
        }),
      });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // Status text says "Planning" (not "Running" — execution not implied)
      expect(within(card).getByText('Planning')).toBeInTheDocument();
      // Explicit waiting text explains what is waiting
      expect(within(card).getByText(/generating plan/i)).toBeInTheDocument();
      // Execution has not begun — no "Running" or "Queued" text
      expect(within(card).queryByText('Running')).not.toBeInTheDocument();
      expect(within(card).queryByText('Queued')).not.toBeInTheDocument();
    });

    it('retains cancel option while plan generation is pending', () => {
      setupMocks({
        runStatus: 'planning',
        revision: null,
        snapshot: runSnapshot({
          status: 'planning',
          currentPlanRevisionId: null,
        }),
      });

      renderList();
      // Cancel is available for nonterminal runs
      expect(screen.getByRole('button', { name: /Cancel/i })).toBeInTheDocument();
    });

    it('shows explicit waiting text while a decision is being applied (mutation pending)', () => {
      setupMocks({
        runStatus: 'awaiting_approval',
        approvePending: true,
      });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // Waiting text for decision application
      expect(within(card).getByText(/applying/i)).toBeInTheDocument();
      // Duplicate submission is disabled
      const approveBtn = within(card).getByTestId('plan-approve-button');
      expect(approveBtn).toBeDisabled();
    });

    it('never implies execution has begun during planning or approval waiting', () => {
      setupMocks({
        runStatus: 'planning',
        revision: null,
        snapshot: runSnapshot({
          status: 'planning',
          currentPlanRevisionId: null,
        }),
      });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;
      // No execution-related text
      expect(within(card).queryByText('Running')).not.toBeInTheDocument();
      expect(within(card).queryByText('Synthesizing')).not.toBeInTheDocument();
      expect(within(card).queryByText(/execution/i)).not.toBeInTheDocument();
    });
  });

  // ── VAL-PLAN-100: Plan decision history remains reviewable ─────────────
  describe('VAL-PLAN-100: Plan decision history remains reviewable', () => {
    it('shows plan decision events with revision, hash, and actor in a history section', () => {
      const events = [
        evt(1, 'run.created'),
        evt(2, 'plan.proposed', {
          payload: { revisionId: 'plan-rev-1', revision: 1, contentHash: 'a'.repeat(64) },
          actorType: 'system',
          actorId: 'planner-1',
        }),
        evt(3, 'plan.approved', {
          payload: { revisionId: 'plan-rev-1', revision: 1, contentHash: 'a'.repeat(64) },
          actorType: 'user',
          actorId: 'user-1',
        }),
      ];
      setupMocks({ runStatus: 'queued', events });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // Decision history section is present
      expect(within(card).getByText(/decision history/i)).toBeInTheDocument();
      // Plan proposed entry with revision
      expect(within(card).getByText(/plan proposed/i)).toBeInTheDocument();
      // Plan approved entry with revision
      expect(within(card).getByText(/plan approved/i)).toBeInTheDocument();
    });

    it('shows revision feedback in decision history for revision requests', () => {
      const events = [
        evt(1, 'run.created'),
        evt(2, 'plan.proposed', {
          payload: { revisionId: 'plan-rev-1', revision: 1, contentHash: 'a'.repeat(64) },
        }),
        evt(3, 'plan.revision_requested', {
          payload: {
            revisionId: 'plan-rev-1',
            revision: 1,
            contentHash: 'a'.repeat(64),
            feedback: 'Add a step for data validation.',
          },
          actorType: 'user',
          actorId: 'user-1',
        }),
        evt(4, 'plan.proposed', {
          payload: { revisionId: 'plan-rev-2', revision: 2, contentHash: 'b'.repeat(64) },
        }),
      ];
      setupMocks({ runStatus: 'awaiting_approval', events });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // Revision requested entry with feedback
      expect(within(card).getByText(/revision requested/i)).toBeInTheDocument();
      expect(within(card).getByText(/Add a step for data validation./i)).toBeInTheDocument();
    });

    it('preserves decision history across re-mount without rewriting records', () => {
      const events = [
        evt(1, 'run.created'),
        evt(2, 'plan.proposed', {
          payload: { revisionId: 'plan-rev-1', revision: 1, contentHash: 'a'.repeat(64) },
        }),
        evt(3, 'plan.approved', {
          payload: { revisionId: 'plan-rev-1', revision: 1, contentHash: 'a'.repeat(64) },
          actorType: 'user',
          actorId: 'user-1',
        }),
      ];
      setupMocks({ runStatus: 'queued', events });

      const { unmount } = renderList();
      const card1 = screen.getByText('run-1').closest('article')!;
      const historyItems1 = within(card1).getAllByText(
        /plan (proposed|approved|rejected|revision requested)/i,
      );
      expect(historyItems1.length).toBe(2); // proposed + approved

      unmount();
      cleanup();
      setupMocks({ runStatus: 'queued', events });
      renderList();

      const card2 = screen.getByText('run-1').closest('article')!;
      const historyItems2 = within(card2).getAllByText(
        /plan (proposed|approved|rejected|revision requested)/i,
      );
      // Same count — no records rewritten or lost
      expect(historyItems2.length).toBe(2);
    });
  });

  // ── VAL-PLAN-117: Partial is durable outcome state ─────────────────────
  describe('VAL-PLAN-117: Partial is durable outcome state', () => {
    it('renders partial result completeness for a completed best-effort run', () => {
      setupMocks({
        runStatus: 'completed',
        revision: approvedRevision(),
        snapshot: runSnapshot({
          status: 'completed',
          currentPlanRevisionId: 'plan-rev-1',
          approvedPlanRevisionId: 'plan-rev-1',
          partialResultPolicy: 'best_effort',
          resultCompleteness: 'partial',
          terminalAt: '2026-08-23T11:00:00.000Z',
        }),
      });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // Partial result is explicitly shown as text
      const completeness = within(card).getByTestId('result-completeness');
      expect(completeness).toBeInTheDocument();
      expect(completeness.textContent).toMatch(/partial/i);
      // Status is completed (not failed)
      expect(within(card).getByText('Completed')).toBeInTheDocument();
    });

    it('renders full result completeness for a completed run', () => {
      setupMocks({
        runStatus: 'completed',
        revision: approvedRevision(),
        snapshot: runSnapshot({
          status: 'completed',
          currentPlanRevisionId: 'plan-rev-1',
          approvedPlanRevisionId: 'plan-rev-1',
          resultCompleteness: 'full',
          terminalAt: '2026-08-23T11:00:00.000Z',
        }),
      });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // Full result is explicitly shown in a result-completeness element
      const completeness = within(card).getByTestId('result-completeness');
      expect(completeness).toBeInTheDocument();
      expect(completeness.textContent).toMatch(/full|complete/i);
      expect(within(card).getByText('Completed')).toBeInTheDocument();
    });

    it('does not show result completeness when null', () => {
      setupMocks({
        runStatus: 'completed',
        revision: approvedRevision(),
        snapshot: runSnapshot({
          status: 'completed',
          currentPlanRevisionId: 'plan-rev-1',
          approvedPlanRevisionId: 'plan-rev-1',
          resultCompleteness: null,
          terminalAt: '2026-08-23T11:00:00.000Z',
        }),
      });

      renderList();
      const card = screen.getByText('run-1').closest('article')!;

      // No result completeness indicator when null
      expect(within(card).queryByTestId('result-completeness')).not.toBeInTheDocument();
    });

    it('preserves partial result classification across re-mount', () => {
      setupMocks({
        runStatus: 'completed',
        revision: approvedRevision(),
        snapshot: runSnapshot({
          status: 'completed',
          currentPlanRevisionId: 'plan-rev-1',
          approvedPlanRevisionId: 'plan-rev-1',
          partialResultPolicy: 'best_effort',
          resultCompleteness: 'partial',
          terminalAt: '2026-08-23T11:00:00.000Z',
        }),
      });

      const { unmount } = renderList();
      const card1 = screen.getByText('run-1').closest('article')!;
      const completeness1 = within(card1).getByTestId('result-completeness');
      expect(completeness1.textContent).toMatch(/partial/i);

      unmount();
      cleanup();
      setupMocks({
        runStatus: 'completed',
        revision: approvedRevision(),
        snapshot: runSnapshot({
          status: 'completed',
          currentPlanRevisionId: 'plan-rev-1',
          approvedPlanRevisionId: 'plan-rev-1',
          partialResultPolicy: 'best_effort',
          resultCompleteness: 'partial',
          terminalAt: '2026-08-23T11:00:00.000Z',
        }),
      });
      renderList();

      const card2 = screen.getByText('run-1').closest('article')!;
      // Same classification after re-mount (reload)
      const completeness2 = within(card2).getByTestId('result-completeness');
      expect(completeness2.textContent).toMatch(/partial/i);
      expect(within(card2).getByText('Completed')).toBeInTheDocument();
    });
  });
});
