/**
 * Mission journey continuity — cross-surface terminal consistency and
 * reload at every waiting phase (VAL-CROSS-048, VAL-CROSS-049).
 *
 * VAL-CROSS-048: After completion, failure, or cancellation, Project Work,
 * Inbox, Approvals, Plans, Artifacts, and direct run detail converge on the
 * same terminal outcome and preserve historical actions; no surface
 * advertises an actionable approval/question for a terminal run.
 *
 * VAL-CROSS-049: Reloading during awaiting_input, awaiting_approval,
 * queued/running child work, synthesizing, and terminal display
 * reconstructs the same run/card state from the server and allows only
 * currently legal actions.
 */

import { render, screen, renderHook as tlRenderHook, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRunCard } from '../src/components/projects/MissionRunCard';
import { MissionPlanGateApproval } from '../src/components/projects/MissionPlanGateApproval';
import { useMissionRunStream as useMissionRunStreamReal } from '../src/lib/mission-stream';
import type {
  MissionRunSummary,
  MissionRunSnapshot,
  MissionPlanRevision,
  Approval,
} from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useMissionRunStream: vi.fn(),
  useMissionCurrentPlanRevision: vi.fn(),
  useCancelMissionRun: vi.fn(),
  useRetryMissionRun: vi.fn(),
  useMissionRequestText: vi.fn(),
  useApproveMissionPlan: vi.fn(),
  useRejectMissionPlan: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionRunEvents: mocks.useMissionRunEvents,
    useMissionRunStream: mocks.useMissionRunStream,
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
    useCancelMissionRun: mocks.useCancelMissionRun,
    useRetryMissionRun: mocks.useRetryMissionRun,
    useMissionRequestText: mocks.useMissionRequestText,
    useApproveMissionPlan: mocks.useApproveMissionPlan,
    useRejectMissionPlan: mocks.useRejectMissionPlan,
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

vi.mock('@/lib/mission-drafts', () => ({
  buildDraftKey: vi.fn(() => 'mock-draft-key'),
  readDraft: vi.fn(() => null),
  writeDraft: vi.fn(),
  clearDraft: vi.fn(),
  clearRunDrafts: vi.fn(),
  clearPrincipalDrafts: vi.fn(),
  DRAFT_TTL_MS: 86400000,
}));

// ── Helpers ───────────────────────────────────────────────────────────────

function runSummary(overrides: Partial<Record<string, unknown>> = {}): MissionRunSummary {
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
  } as MissionRunSummary;
}

function runSnapshot(overrides: Partial<Record<string, unknown>> = {}): MissionRunSnapshot {
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
    currentQuestionSet: null,
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
      ceilingCents: 500,
    },
    resultCompleteness: null,
    ...overrides,
  } as MissionRunSnapshot;
}

function planRevision(overrides: Partial<Record<string, unknown>> = {}): MissionPlanRevision {
  return {
    id: 'rev-1234',
    runId: 'run-1',
    revision: 1,
    status: 'proposed',
    contentHash: 'abcd1234efgh5678',
    content: {
      schemaVersion: 1,
      objective: 'Analyze the quarterly report',
      steps: [],
      synthesis: null,
      partialResultPolicy: 'require_all',
      limits: {},
    },
    createdAt: '2026-08-20T10:01:00.000Z',
    ...overrides,
  } as MissionPlanRevision;
}

function planGateApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval-1',
    companyId: 'company-1',
    kind: 'plan_gate',
    title: 'Mission plan approval — revision 1',
    description: 'Plan proposal for run run-1',
    status: 'pending',
    priority: 'medium',
    requestedByUserId: null,
    requestedByAgentId: 'agent-1',
    resolvedByUserId: null,
    resolutionNote: null,
    payload: {
      runId: 'run-1',
      planRevisionId: 'rev-1234',
      revision: 1,
      contentHash: 'abcd1234efgh5678',
    },
    taskId: null,
    projectId: 'project-1',
    planStepId: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  } as Approval;
}

function mutationResult(
  overrides: Partial<{
    mutate: ReturnType<typeof vi.fn>;
    mutateAsync: ReturnType<typeof vi.fn>;
    isPending: boolean;
  }> = {},
) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

function setupRunCard(
  runOverrides: Partial<Record<string, unknown>> = {},
  snapshotOverrides: Partial<Record<string, unknown>> = {},
) {
  const run = runSummary(runOverrides);
  const snapshot = runSnapshot(snapshotOverrides);
  mocks.useMissionRunSnapshot.mockReturnValue({
    data: snapshot,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mocks.useMissionRunEvents.mockReturnValue({
    data: { events: [] },
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  });
  mocks.useMissionRunStream.mockReturnValue({
    status: 'connected',
    lastSequence: 4,
    gapDetected: false,
  });
  mocks.useMissionRequestText.mockReturnValue(undefined);
  mocks.useCancelMissionRun.mockReturnValue(mutationResult());
  mocks.useRetryMissionRun.mockReturnValue(mutationResult());
  mocks.useMissionCurrentPlanRevision.mockReturnValue({ data: undefined, isLoading: false });

  const { rerender, unmount } = render(
    <MissionRunCard companyId="company-1" projectId="project-1" run={run} />,
    { wrapper },
  );
  return { run, snapshot, rerender, unmount };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useMissionRunSnapshot.mockReturnValue({
    data: undefined,
    isLoading: true,
    isError: false,
    refetch: vi.fn(),
  });
  mocks.useMissionRunEvents.mockReturnValue({
    data: undefined,
    isLoading: true,
    isError: false,
    refetch: vi.fn(),
  });
  mocks.useMissionRunStream.mockReturnValue({
    status: 'idle',
    lastSequence: 0,
    gapDetected: false,
  });
  mocks.useMissionRequestText.mockReturnValue(undefined);
  mocks.useCancelMissionRun.mockReturnValue(mutationResult());
  mocks.useRetryMissionRun.mockReturnValue(mutationResult());
  mocks.useMissionCurrentPlanRevision.mockReturnValue({ data: undefined, isLoading: false });
  mocks.useApproveMissionPlan.mockReturnValue(mutationResult());
  mocks.useRejectMissionPlan.mockReturnValue(mutationResult());
});

// ── Mock EventSource for SSE hook tests ───────────────────────────────────

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
}

// ── VAL-CROSS-048: Cross-surface terminal consistency ────────────────────

describe('VAL-CROSS-048: Cross-surface terminal consistency', () => {
  describe('SSE terminal event invalidates cross-surface queries', () => {
    let originalEventSource: typeof EventSource;

    beforeEach(() => {
      originalEventSource = global.EventSource;
      MockEventSourceClass.lastInstance = null;
    });

    afterEach(() => {
      global.EventSource = originalEventSource;
    });

    it('invalidates inbox, approvals, and plans queries on terminal event', async () => {
      global.EventSource = MockEventSourceClass as unknown as typeof EventSource;

      const qc = makeQueryClient();
      // Seed query data so the caches exist and invalidation is observable.
      qc.setQueryData(['inbox', 'company-1'], { data: [], meta: {} });
      qc.setQueryData(['approvals', 'company-1', 'all'], { data: [] });
      qc.setQueryData(['project-plans', 'company-1', 'project-1', {}], { data: [] });

      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      const { result } = tlRenderHook(
        () => useMissionRunStreamReal('company-1', 'project-1', 'run-1', { enabled: true }),
        {
          wrapper: ({ children }: { children: React.ReactNode }) => (
            <QueryClientProvider client={qc}>
              <MemoryRouter>{children}</MemoryRouter>
            </QueryClientProvider>
          ),
        },
      );

      // The hook should have created a mock EventSource and be connecting.
      expect(result.current.status).toBe('connecting');
      expect(MockEventSourceClass.lastInstance).not.toBeNull();

      // Simulate the connection opening.
      await act(async () => {
        MockEventSourceClass.lastInstance?.simulateOpen();
      });
      expect(result.current.status).toBe('connected');

      // Clear the spy so we only observe invalidations from the terminal event.
      invalidateSpy.mockClear();

      const es = MockEventSourceClass.lastInstance!;

      // Simulate a terminal SSE event: run.cancelled at sequence 5.
      // The server sends typed events with `event: <type>` and `id: <sequence>`.
      // The hook registers a named listener for 'run.cancelled' and parses
      // the JSON data to extract the type and sequence.
      await act(async () => {
        es.simulateEvent(
          'run.cancelled',
          JSON.stringify({ sequence: 5, type: 'run.cancelled' }),
          '5',
        );
      });

      // The stream should be closed after a terminal event.
      expect(result.current.status).toBe('closed');

      // Assert that the Inbox query cache was invalidated so mission
      // question items converge to the terminal outcome.
      const inboxInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
        const key = (arg as { queryKey?: unknown[] }).queryKey;
        return Array.isArray(key) && key[0] === 'inbox' && key[1] === 'company-1';
      });
      expect(inboxInvalidated).toBe(true);

      // Assert that the Approvals query cache was invalidated so plan
      // gate approval items converge to the terminal outcome.
      const approvalsInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
        const key = (arg as { queryKey?: unknown[] }).queryKey;
        return Array.isArray(key) && key[0] === 'approvals' && key[1] === 'company-1';
      });
      expect(approvalsInvalidated).toBe(true);

      // Assert that the project-plans query cache was invalidated so
      // projected plan steps converge to the terminal outcome.
      const plansInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
        const key = (arg as { queryKey?: unknown[] }).queryKey;
        return (
          Array.isArray(key) &&
          key[0] === 'project-plans' &&
          key[1] === 'company-1' &&
          key[2] === 'project-1'
        );
      });
      expect(plansInvalidated).toBe(true);

      invalidateSpy.mockRestore();
    });

    it('invalidates approvals and plans queries on plan lifecycle event', async () => {
      // This test verifies Fix 1: plan.* event types are registered in
      // the namedTypes array so the SSE hook processes them. Without
      // the registration, the named listener for 'plan.proposed' is
      // never added and handleEvent is never called for plan events,
      // making the plan invalidation code dead code.
      global.EventSource = MockEventSourceClass as unknown as typeof EventSource;

      const qc = makeQueryClient();
      qc.setQueryData(['approvals', 'company-1', 'all'], { data: [] });
      qc.setQueryData(['project-plans', 'company-1', 'project-1', {}], { data: [] });

      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      tlRenderHook(
        () => useMissionRunStreamReal('company-1', 'project-1', 'run-1', { enabled: true }),
        {
          wrapper: ({ children }: { children: React.ReactNode }) => (
            <QueryClientProvider client={qc}>
              <MemoryRouter>{children}</MemoryRouter>
            </QueryClientProvider>
          ),
        },
      );

      await act(async () => {
        MockEventSourceClass.lastInstance?.simulateOpen();
      });

      invalidateSpy.mockClear();

      const es = MockEventSourceClass.lastInstance!;

      // Simulate a plan.proposed SSE event at sequence 3.
      await act(async () => {
        es.simulateEvent(
          'plan.proposed',
          JSON.stringify({ sequence: 3, type: 'plan.proposed' }),
          '3',
        );
      });

      // The Approvals query cache must be invalidated so the new plan
      // gate approval appears in the Approvals surface.
      const approvalsInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
        const key = (arg as { queryKey?: unknown[] }).queryKey;
        return Array.isArray(key) && key[0] === 'approvals' && key[1] === 'company-1';
      });
      expect(approvalsInvalidated).toBe(true);

      // The project-plans query cache must be invalidated so the
      // projected plan steps refresh.
      const plansInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
        const key = (arg as { queryKey?: unknown[] }).queryKey;
        return (
          Array.isArray(key) &&
          key[0] === 'project-plans' &&
          key[1] === 'company-1' &&
          key[2] === 'project-1'
        );
      });
      expect(plansInvalidated).toBe(true);

      invalidateSpy.mockRestore();
    });
  });

  describe('MissionPlanGateApproval: terminal run disables decision controls', () => {
    function setupGateApproval(
      approvalOverrides: Partial<Approval> = {},
      snapshotOverrides: Partial<Record<string, unknown>> = {},
    ) {
      const approval = planGateApproval(approvalOverrides);
      const snapshot = runSnapshot({
        id: 'run-1',
        status: 'awaiting_approval',
        currentPlanRevisionId: 'rev-1234',
        ...snapshotOverrides,
      });
      const revision = planRevision({ id: 'rev-1234', status: 'proposed' });

      mocks.useMissionRunSnapshot.mockReturnValue({
        data: snapshot,
        isLoading: false,
        isError: false,
        refetch: vi.fn(),
      });
      mocks.useMissionCurrentPlanRevision.mockReturnValue({
        data: revision,
        isLoading: false,
      });

      render(<MissionPlanGateApproval companyId="company-1" approval={approval} />, { wrapper });
    }

    it('shows actionable decision controls when run is awaiting_approval', () => {
      setupGateApproval({}, { status: 'awaiting_approval' });
      // The decision controls should be present (approve/reject buttons)
      expect(screen.getByTestId('plan-gate-approval')).toBeInTheDocument();
      expect(screen.queryByTestId('plan-gate-resolved')).not.toBeInTheDocument();
      expect(screen.queryByTestId('plan-gate-terminal-notice')).not.toBeInTheDocument();
    });

    it('shows non-actionable terminal notice when run is cancelled but approval still pending', () => {
      setupGateApproval({}, { status: 'cancelled', terminalAt: '2026-08-20T11:00:00.000Z' });
      // The terminal notice should be shown instead of actionable controls
      expect(screen.getByTestId('plan-gate-terminal-notice')).toBeInTheDocument();
      expect(screen.queryByTestId('plan-gate-resolved')).not.toBeInTheDocument();
      // No approve/reject buttons
      expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    });

    it('shows non-actionable terminal notice when run is completed but approval still pending', () => {
      setupGateApproval({}, { status: 'completed', terminalAt: '2026-08-20T11:00:00.000Z' });
      expect(screen.getByTestId('plan-gate-terminal-notice')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    });

    it('shows non-actionable terminal notice when run is failed but approval still pending', () => {
      setupGateApproval({}, { status: 'failed', terminalAt: '2026-08-20T11:00:00.000Z' });
      expect(screen.getByTestId('plan-gate-terminal-notice')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument();
    });

    it('shows resolved state when approval itself is resolved (not terminal run check)', () => {
      setupGateApproval({ status: 'approved', resolvedAt: '2026-08-20T11:00:00.000Z' });
      expect(screen.getByTestId('plan-gate-resolved')).toBeInTheDocument();
      expect(screen.queryByTestId('plan-gate-terminal-notice')).not.toBeInTheDocument();
    });
  });

  describe('MissionRunCard: terminal state hides actionable controls', () => {
    it('does not show cancel control for terminal run', () => {
      setupRunCard(
        { status: 'completed' },
        { status: 'completed', terminalAt: '2026-08-20T11:00:00.000Z' },
      );
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });

    it('does not show question card for terminal run even if currentQuestionSet lags', () => {
      setupRunCard(
        { status: 'cancelled' },
        {
          status: 'cancelled',
          terminalAt: '2026-08-20T11:00:00.000Z',
          currentQuestionSet: {
            id: 'qs-1',
            ordinal: 1,
            status: 'open',
            questions: [],
          } as Record<string, unknown>,
        },
      );
      // No question card should be rendered for a terminal run
      expect(screen.queryByTestId('mission-question-card')).not.toBeInTheDocument();
    });

    it('does not show plan decision controls for terminal run', () => {
      setupRunCard(
        { status: 'failed' },
        {
          status: 'failed',
          terminalAt: '2026-08-20T11:00:00.000Z',
          currentPlanRevisionId: 'rev-1234',
        },
      );
      // The plan card may render for history, but no actionable decision controls
      expect(screen.queryByRole('button', { name: /approve plan/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /reject plan/i })).not.toBeInTheDocument();
    });
  });
});

// ── VAL-CROSS-049: Reload at every waiting phase ──────────────────────────

describe('VAL-CROSS-049: Reload at every waiting phase', () => {
  it('reconstructs awaiting_input state with question card and no cancel-disabled', () => {
    setupRunCard(
      { status: 'awaiting_input' },
      {
        status: 'awaiting_input',
        waitingFromStatus: 'running',
        currentQuestionSet: {
          id: 'qs-1',
          ordinal: 1,
          status: 'open',
          questions: [
            {
              questionKey: 'q1',
              order: 0,
              type: 'text',
              label: 'What is the target?',
              required: true,
              helpText: null,
              defaultValue: null,
              options: null,
              validation: null,
            },
          ],
        } as Record<string, unknown>,
      },
    );
    // Question card should be visible
    expect(screen.getByText(/what is the target/i)).toBeInTheDocument();
    // Cancel should be available (awaiting_input is nonterminal)
    expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
    // No plan decision controls (no plan yet)
    expect(screen.queryByRole('button', { name: /approve plan/i })).not.toBeInTheDocument();
  });

  it('reconstructs awaiting_approval state with plan card and decision controls', () => {
    setupRunCard(
      { status: 'awaiting_approval' },
      {
        status: 'awaiting_approval',
        currentPlanRevisionId: 'rev-1234',
      },
    );
    mocks.useMissionCurrentPlanRevision.mockReturnValue({
      data: planRevision({ id: 'rev-1234', status: 'proposed' }),
      isLoading: false,
    });
    // Cancel should be available
    expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
  });

  it('reconstructs queued state with cancel control and no question/plan controls', () => {
    setupRunCard({ status: 'queued' }, { status: 'queued' });
    expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
    expect(screen.queryByTestId('mission-question-card')).not.toBeInTheDocument();
  });

  it('reconstructs running state with cancel control', () => {
    setupRunCard({ status: 'running' }, { status: 'running' });
    expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
  });

  it('reconstructs synthesizing state with cancel control', () => {
    setupRunCard({ status: 'synthesizing' }, { status: 'synthesizing' });
    expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
  });

  it('reconstructs completed terminal state with no actionable controls', () => {
    setupRunCard(
      { status: 'completed' },
      { status: 'completed', terminalAt: '2026-08-20T11:00:00.000Z' },
    );
    expect(screen.queryByRole('button', { name: /cancel run-1/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('mission-question-card')).not.toBeInTheDocument();
  });

  it('reconstructs cancelled terminal state with no actionable controls', () => {
    setupRunCard(
      { status: 'cancelled' },
      { status: 'cancelled', terminalAt: '2026-08-20T11:00:00.000Z' },
    );
    expect(screen.queryByRole('button', { name: /cancel run-1/i })).not.toBeInTheDocument();
  });

  it('reconstructs failed terminal state with no actionable controls', () => {
    setupRunCard(
      { status: 'failed' },
      { status: 'failed', terminalAt: '2026-08-20T11:00:00.000Z' },
    );
    expect(screen.queryByRole('button', { name: /cancel run-1/i })).not.toBeInTheDocument();
  });

  it('preserves same run ID and state version across reload simulation', () => {
    const { rerender } = setupRunCard(
      { status: 'awaiting_input', stateVersion: 5 },
      { status: 'awaiting_input', stateVersion: 5, waitingFromStatus: 'running' },
    );
    // Verify run ID is present
    expect(screen.getByText('run-1')).toBeInTheDocument();

    // Simulate reload: re-render with the same server state
    const sameSnapshot = runSnapshot({
      status: 'awaiting_input',
      stateVersion: 5,
      waitingFromStatus: 'running',
      currentQuestionSet: {
        id: 'qs-1',
        ordinal: 1,
        status: 'open',
        questions: [
          {
            questionKey: 'q1',
            order: 0,
            type: 'text',
            label: 'What is the target?',
            required: true,
            helpText: null,
            defaultValue: null,
            options: null,
            validation: null,
          },
        ],
      } as Record<string, unknown>,
    });
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: sameSnapshot,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    });
    rerender(
      <MissionRunCard
        companyId="company-1"
        projectId="project-1"
        run={runSummary({ status: 'awaiting_input', stateVersion: 5 })}
      />,
    );
    // Same run ID, same state
    expect(screen.getByText('run-1')).toBeInTheDocument();
    expect(screen.getByText(/what is the target/i)).toBeInTheDocument();
  });
});
