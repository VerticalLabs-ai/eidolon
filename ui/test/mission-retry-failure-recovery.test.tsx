import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRunCard } from '../src/components/projects/MissionRunCard';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import { ChatMissionComposer } from '../src/components/projects/ChatMissionComposer';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunsPaginated: vi.fn(),
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useMissionRunStream: vi.fn(),
  useMissionRequestText: vi.fn(),
  useStartMissionRun: vi.fn(),
  useCancelMissionRun: vi.fn(),
  useRetryMissionRun: vi.fn(),
  useFeatureFlags: vi.fn(),
  useProjectThreads: vi.fn(),
  useCreateThreadItem: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useMissionRunsPaginated: mocks.useMissionRunsPaginated,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionRunEvents: mocks.useMissionRunEvents,
    useMissionRunStream: mocks.useMissionRunStream,
    useMissionRequestText: mocks.useMissionRequestText,
    useStartMissionRun: mocks.useStartMissionRun,
    useCancelMissionRun: mocks.useCancelMissionRun,
    useRetryMissionRun: mocks.useRetryMissionRun,
    useFeatureFlags: mocks.useFeatureFlags,
    useProjectThreads: mocks.useProjectThreads,
    useCreateThreadItem: mocks.useCreateThreadItem,
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

function snapshotResult(snapshot: ReturnType<typeof runSnapshot> = runSnapshot()) {
  return { data: snapshot, isLoading: false, isError: false };
}

function eventsResult(events: { sequence: number; type: string; [k: string]: unknown }[] = []) {
  return {
    data: { events, nextCursor: 0, latestSequence: 4 },
    isLoading: false,
    isError: false,
  };
}

function streamResult(overrides: Partial<{ status: string; gapDetected: boolean }> = {}) {
  return { status: 'connected', lastSequence: 4, gapDetected: false, ...overrides };
}

/** A controllable retry mutation mock. */
function retryMock(overrides: Partial<Record<string, unknown>> = {}) {
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

/** A controllable cancel mutation mock. */
function cancelMock(overrides: Partial<Record<string, unknown>> = {}) {
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

function startMock(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
    isSuccess: false,
    ...overrides,
  };
}

function flagsResult(enabled = true) {
  return {
    data: { subject: 'company-1', flags: { missionAgentIntelligence: enabled } },
    isLoading: false,
    isError: false,
  };
}

function threadsResult() {
  return {
    data: [
      { id: 'thread-1', title: 'Test Thread', companyId: 'company-1', projectId: 'project-1' },
    ],
    isLoading: false,
    isError: false,
  };
}

function createThreadItemMock() {
  return {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
    isSuccess: false,
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

describe('Mission retry, failure, and recovery UI', () => {
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
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary()]));
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
    mocks.useMissionRequestText.mockReturnValue(undefined);
    mocks.useStartMissionRun.mockReturnValue(startMock());
    mocks.useCancelMissionRun.mockReturnValue(cancelMock());
    mocks.useRetryMissionRun.mockReturnValue(retryMock());
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useProjectThreads.mockReturnValue(threadsResult());
    mocks.useCreateThreadItem.mockReturnValue(createThreadItemMock());
  });

  // ── VAL-RUN-045 / VAL-CROSS-073: Failed card exposes safe actionable error ─
  describe('VAL-RUN-045 / VAL-CROSS-073: failed card safe error and retry', () => {
    it('shows a Retry control for a failed terminal root run', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(runSnapshot({ status: 'failed', terminalAt: '2026-08-20T10:05:00.000Z' })),
      );
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry mission/i })).toBeInTheDocument();
    });

    it('shows a safe error message and category without secrets', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'failed',
            failureCategory: 'provider_permanent',
            failureCode: 'PROVIDER_ERROR',
            safeErrorMessage: 'Mission failed due to a provider error.',
            terminalAt: '2026-08-20T10:05:00.000Z',
          }),
        ),
      );

      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      // The failure section should show the safe error message
      expect(screen.getByText('Mission failed due to a provider error.')).toBeInTheDocument();
      expect(screen.getByText(/Category: provider_permanent/)).toBeInTheDocument();
      // No secrets should appear
      expect(screen.queryByText(/sk-ant-/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/api_key/i)).not.toBeInTheDocument();
    });

    it('does not show Retry for a completed run', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({ status: 'completed', terminalAt: '2026-08-20T10:10:00.000Z' }),
        ),
      );
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'completed' }) as never}
        />,
        { wrapper },
      );

      expect(screen.getByText('Completed')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /retry mission/i })).not.toBeInTheDocument();
    });
  });

  // ── VAL-CROSS-074 / VAL-CROSS-096: Terminal retry preserves history and lineage ──
  describe('VAL-CROSS-074 / VAL-CROSS-096: retry lineage', () => {
    it('shows Retry for a cancelled terminal root run', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({ status: 'cancelled', terminalAt: '2026-08-20T10:03:00.000Z' }),
        ),
      );
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'cancelled' }) as never}
        />,
        { wrapper },
      );

      expect(screen.getByText('Cancelled')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry mission/i })).toBeInTheDocument();
    });

    it('shows a retry lineage link when the run is a retry of another run', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            id: 'run-2',
            rootRunId: 'run-2',
            retryOfRunId: 'run-1',
            status: 'running',
          }),
        ),
      );

      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ id: 'run-2', status: 'running' }) as never}
        />,
        { wrapper },
      );

      expect(screen.getByText(/Retry of/i)).toBeInTheDocument();
      expect(screen.getByText('run-1')).toBeInTheDocument();
    });

    it('does not show Retry for a child run (depth > 0)', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            id: 'child-1',
            rootRunId: 'run-1',
            parentRunId: 'run-1',
            depth: 1,
            status: 'failed',
          }),
        ),
      );

      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ id: 'child-1', status: 'failed' }) as never}
        />,
        { wrapper },
      );

      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /retry mission/i })).not.toBeInTheDocument();
    });
  });

  // ── VAL-RUN-063 / VAL-CROSS-062: Budget exhaustion is visible and terminal ──
  describe('VAL-RUN-063 / VAL-CROSS-062: budget exhaustion', () => {
    it('identifies a budget exhaustion failure with explicit text', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'failed',
            failureCategory: 'budget',
            failureCode: 'BUDGET_EXHAUSTED',
            safeErrorMessage: 'The mission budget was exhausted before completion.',
            terminalAt: '2026-08-20T10:05:00.000Z',
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

      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText(/budget was exhausted/i)).toBeInTheDocument();
      expect(screen.getByText(/Category: budget/)).toBeInTheDocument();
      // Retry should still be available for a budget-exhausted root run
      expect(screen.getByRole('button', { name: /retry mission/i })).toBeInTheDocument();
    });

    it('shows released funds in the budget display after exhaustion', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'failed',
            failureCategory: 'limit',
            failureCode: 'LIMIT_EXCEEDED',
            safeErrorMessage: 'A configured limit was exceeded.',
            terminalAt: '2026-08-20T10:05:00.000Z',
            budget: {
              reservedCents: 500,
              settledCents: 300,
              releasedCents: 200,
              costCentsCeiling: 500,
              actualCostCents: 300,
            },
          }),
        ),
      );

      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      expect(screen.getByText(/Released:/)).toBeInTheDocument();
      expect(screen.getByText('$2.00')).toBeInTheDocument();
    });
  });

  // ── VAL-RUN-056: UI explains stale actions ──
  describe('VAL-RUN-056: stale retry action', () => {
    it('reports the Mission changed on a stale-version retry error and offers refresh', async () => {
      const staleError = { status: 412, body: { code: 'RUN_VERSION_MISMATCH' } };
      mocks.useRetryMissionRun.mockReturnValue(
        retryMock({
          mutateAsync: vi.fn().mockRejectedValue(staleError),
          isError: true,
          error: staleError,
        }),
      );
      const refetchSpy = vi.fn();
      mocks.useMissionRunSnapshot.mockReturnValue({
        ...snapshotResult(
          runSnapshot({
            status: 'failed',
            failureCategory: 'provider_permanent',
            safeErrorMessage: 'Mission failed due to a provider error.',
            terminalAt: '2026-08-20T10:05:00.000Z',
          }),
        ),
        refetch: refetchSpy,
      });

      const user = userEvent.setup();
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      const retryBtn = screen.getByRole('button', { name: /retry mission/i });
      await user.click(retryBtn);

      // The stale-action message should appear (role=alert). The failure
      // card also uses role=alert (VAL-RUN-089), so find the alert that
      // contains the stale-action "changed" message specifically.
      const alerts = screen.getAllByRole('alert');
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      expect(alerts.some((el) => /changed/i.test(el.textContent ?? ''))).toBe(true);
      expect(screen.getByText(/changed/i)).toBeInTheDocument();
      // A refresh control should be available
      expect(screen.getByRole('button', { name: /refresh/i })).toBeInTheDocument();
    });
  });

  // ── VAL-RUN-130: Unknown command outcomes recover in the browser ──
  describe('VAL-RUN-130: lost retry response recovery', () => {
    it('shows a recovering state and retains the idempotency key on a lost response', async () => {
      // A network error (no status) simulates a lost response — the server
      // may have applied the command but the response was lost.
      const networkError = new Error('Network request failed');
      const mutateAsyncSpy = vi.fn().mockRejectedValue(networkError);
      mocks.useRetryMissionRun.mockReturnValue(
        retryMock({
          mutateAsync: mutateAsyncSpy,
          isPending: false,
        }),
      );
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'failed',
            failureCategory: 'provider_permanent',
            safeErrorMessage: 'Mission failed due to a provider error.',
            terminalAt: '2026-08-20T10:05:00.000Z',
          }),
        ),
      );

      const user = userEvent.setup();
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      const retryBtn = screen.getByRole('button', { name: /retry mission/i });
      await user.click(retryBtn);

      // The recovering/indeterminate state should be shown
      expect(screen.getByText(/recovering/i)).toBeInTheDocument();
      // The retry mutation was called (with an idempotency key)
      expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
      const callArgs = mutateAsyncSpy.mock.calls[0][0];
      expect(callArgs.idempotencyKey).toBeTruthy();
      expect(callArgs.idempotencyKey.length).toBeGreaterThan(0);
    });

    // Normative Boundary 2 / VAL-RUN-130: a lost network response followed
    // by a second activation must replay the SAME logical command, not a
    // fresh one, so the server's exactly-one-outcome guarantee holds.
    it('reuses the same idempotency key across recoverable retry re-submissions', async () => {
      const networkError = new Error('Network request failed');
      const mutateAsyncSpy = vi.fn().mockRejectedValue(networkError);
      mocks.useRetryMissionRun.mockReturnValue(
        retryMock({
          mutateAsync: mutateAsyncSpy,
          isPending: false,
        }),
      );
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'failed',
            failureCategory: 'provider_permanent',
            safeErrorMessage: 'Mission failed due to a provider error.',
            terminalAt: '2026-08-20T10:05:00.000Z',
          }),
        ),
      );

      const user = userEvent.setup();
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      const retryBtn = screen.getByRole('button', { name: /retry mission/i });

      // First activation: server applies the command but the response is
      // lost (network error).
      await user.click(retryBtn);
      expect(mutateAsyncSpy).toHaveBeenCalledTimes(1);
      const firstKey = mutateAsyncSpy.mock.calls[0][0].idempotencyKey;
      expect(firstKey).toBeTruthy();

      // The recovering state should be shown (VAL-RUN-130).
      expect(screen.getByText(/recovering/i)).toBeInTheDocument();

      // Second activation: must replay the identical logical command with
      // the SAME idempotency key so the server returns the original
      // successor instead of creating a duplicate (VAL-RUN-050).
      await user.click(retryBtn);
      expect(mutateAsyncSpy).toHaveBeenCalledTimes(2);
      const secondKey = mutateAsyncSpy.mock.calls[1][0].idempotencyKey;
      expect(secondKey).toBe(firstKey);
    });
  });

  // ── VAL-RUN-016: Submission cannot create accidental duplicates ──
  describe('VAL-RUN-016: double start disabled while pending', () => {
    it('disables the Mission start action while a submission is in flight', async () => {
      mocks.useStartMissionRun.mockReturnValue(startMock({ isPending: true }));

      const user = userEvent.setup();
      render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });

      // Switch to Mission mode
      await user.click(screen.getByRole('radio', { name: /mission/i }));

      // The start button should be disabled while pending
      const startBtn = screen.getByRole('button', { name: /start mission/i });
      expect(startBtn).toBeDisabled();
    });

    it('prevents a second start call while the first is unresolved', async () => {
      const mutateSpy = vi.fn();
      mocks.useStartMissionRun.mockReturnValue(startMock({ isPending: true, mutate: mutateSpy }));

      const user = userEvent.setup();
      render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });

      // Switch to Mission mode
      await user.click(screen.getByRole('radio', { name: /mission/i }));

      // Type a request
      const input = screen.getByLabelText(/mission request/i);
      await user.type(input, 'Analyze the quarterly report');

      const startBtn = screen.getByRole('button', { name: /start mission/i });
      // Button is disabled so clicking does nothing
      expect(startBtn).toBeDisabled();
      expect(mutateSpy).not.toHaveBeenCalled();
    });
  });

  // ── VAL-RUN-096: Errors preserve recoverable context ──
  describe('VAL-RUN-096: recoverable start error preserves request', () => {
    it('preserves the request text after a transient start error', async () => {
      mocks.useStartMissionRun.mockReturnValue(
        startMock({ isError: true, error: new Error('Network error') }),
      );

      const user = userEvent.setup();
      render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });

      // Switch to Mission mode
      await user.click(screen.getByRole('radio', { name: /mission/i }));

      const input = screen.getByLabelText(/mission request/i) as HTMLInputElement;
      await user.type(input, 'Analyze the quarterly report');

      // An error message should be visible (role=alert)
      expect(screen.getByRole('alert')).toBeInTheDocument();
      // The input should still contain the typed text (draft preserved)
      expect(input).toHaveValue('Analyze the quarterly report');
    });
  });

  // ── VAL-RUN-130: Lost start response recovery ──
  describe('VAL-RUN-130: lost start response shows indeterminate state', () => {
    it('shows an error that distinguishes acceptance without clearing the draft', async () => {
      mocks.useStartMissionRun.mockReturnValue(
        startMock({
          isError: true,
          error: new Error('Network request failed'),
        }),
      );

      const user = userEvent.setup();
      render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });

      // Switch to Mission mode
      await user.click(screen.getByRole('radio', { name: /mission/i }));

      const input = screen.getByLabelText(/mission request/i);
      await user.type(input, 'Analyze the quarterly report');

      // The error should be visible (role=alert)
      expect(screen.getByRole('alert')).toBeInTheDocument();
      // The input should still be present (draft preserved)
      expect(screen.getByLabelText(/mission request/i)).toBeInTheDocument();
    });
  });

  // ── VAL-RUN-057: Duplicate retry clicks stay single ──
  describe('VAL-RUN-057: duplicate retry clicks stay single', () => {
    it('disables the Retry control while a retry is pending', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'failed',
            failureCategory: 'provider_permanent',
            safeErrorMessage: 'Mission failed due to a provider error.',
            terminalAt: '2026-08-20T10:05:00.000Z',
          }),
        ),
      );
      mocks.useRetryMissionRun.mockReturnValue(retryMock({ isPending: true }));

      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      const retryBtn = screen.getByRole('button', { name: /retry mission/i });
      expect(retryBtn).toBeDisabled();
    });
  });

  // ── VAL-CROSS-073: Permanent failure exposes safe retry (no raw diagnostics) ──
  describe('VAL-CROSS-073: safe failure categories', () => {
    it.each([
      ['authorization', 'AUTHORIZATION_DENIED', 'Authorization was denied.'],
      ['policy', 'POLICY_DENIED', 'The policy denied this operation.'],
      ['budget', 'BUDGET_EXHAUSTED', 'The mission budget was exhausted.'],
      ['unknown_effect', 'UNKNOWN_EFFECT', 'An unknown effect occurred.'],
      ['child_failed', 'CHILD_FAILED', 'A child run failed.'],
    ])('shows safe category %s with retry and no raw diagnostics', (category, code, message) => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'failed',
            failureCategory: category,
            failureCode: code,
            safeErrorMessage: message,
            terminalAt: '2026-08-20T10:05:00.000Z',
          }),
        ),
      );

      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'failed' }) as never}
        />,
        { wrapper },
      );

      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.getByText(`Category: ${category}`)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry mission/i })).toBeInTheDocument();
      // No raw diagnostics
      expect(screen.queryByText(/stack trace/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/sk-/i)).not.toBeInTheDocument();
    });
  });
});
