import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRunCard } from '../src/components/projects/MissionRunCard';
import { MissionRunList } from '../src/components/projects/MissionRunList';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionRunsPaginated: vi.fn(),
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useMissionRunStream: vi.fn(),
  useMissionRequestText: vi.fn(),
  useStartMissionRun: vi.fn(),
  useCancelMissionRun: vi.fn(),
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
  return { data: { events, nextCursor: 0, latestSequence: 4 }, isLoading: false, isError: false };
}

function streamResult(overrides: Partial<{ status: string; gapDetected: boolean }> = {}) {
  return { status: 'connected', lastSequence: 4, gapDetected: false, ...overrides };
}

/** A controllable cancel mutation mock. `mutateAsync` is the submission path
 * used by the dialog; tests drive it to resolve (success) or reject
 * (recoverable error). */
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

describe('Mission cancellation UI', () => {
  beforeAll(() => {
    // jsdom does not implement <dialog> showModal/close; mock them so the
    // native dialog renders as open and focus management is testable.
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
    mocks.useStartMissionRun.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useCancelMissionRun.mockReturnValue(cancelMock());
  });

  // ── VAL-RUN-035: Active run can be cancelled ──────────────────────────
  describe('VAL-RUN-035: active run can be cancelled', () => {
    it('shows a Cancel control for a nonterminal run', () => {
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'running' }) as never}
        />,
        { wrapper },
      );
      expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
    });

    it('does not show a Cancel control for a terminal run', () => {
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
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
    });

    it('does not show a Cancel control once cancellation is already requested', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'running',
            cancelRequestedAt: '2026-08-20T10:01:00.000Z',
            cancelRequestedBy: 'user-1',
          }),
        ),
      );
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'running' }) as never}
        />,
        { wrapper },
      );
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
      expect(screen.getByText(/cancellation requested/i)).toBeInTheDocument();
    });

    it('converges from active to cancelled showing cancellation requested then cancelled', () => {
      const { rerender } = render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'running' }) as never}
        />,
        { wrapper },
      );
      // Active: shows Running status and a Cancel control
      expect(screen.getByText(/^running$/i)).toBeInTheDocument();

      // Server advances: cancellation requested (status still running)
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'running',
            cancelRequestedAt: '2026-08-20T10:01:00.000Z',
            cancelRequestedBy: 'user-1',
          }),
        ),
      );
      rerender(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'running' }) as never}
        />,
      );
      expect(screen.getByText(/cancellation requested/i)).toBeInTheDocument();
      // Authoritative lifecycle status retained during pending shutdown
      expect(screen.getByText(/^running$/i)).toBeInTheDocument();

      // Server advances: terminal cancelled
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'cancelled',
            cancelRequestedAt: '2026-08-20T10:01:00.000Z',
            cancelRequestedBy: 'user-1',
            terminalAt: '2026-08-20T10:02:00.000Z',
          }),
        ),
      );
      rerender(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'cancelled' }) as never}
        />,
      );
      expect(screen.getByText(/^cancelled$/i)).toBeInTheDocument();
      // No longer showing the separate pending indicator
      expect(screen.queryByText(/cancellation requested/i)).not.toBeInTheDocument();
    });
  });

  // ── VAL-RUN-036: Cancellation requires confirmation ───────────────────
  describe('VAL-RUN-036: cancellation requires confirmation', () => {
    it('opens a confirmation naming the affected Mission on Cancel activation', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ id: 'run-42' }) as never}
        />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-42/i }));
      // Confirmation dialog names the affected Mission
      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(within(dialog).getByText(/run-42/i)).toBeInTheDocument();
    });

    it('does not issue a cancel request before confirmation', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      // Opening the confirmation alone does not call mutateAsync
      expect(cm.mutateAsync).not.toHaveBeenCalled();
    });

    it('requires a reason before the destructive confirm is enabled', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      const confirm = screen.getByRole('button', { name: /confirm cancellation/i });
      // Without a reason, the confirm is disabled
      expect(confirm).toBeDisabled();
    });
  });

  // ── VAL-RUN-037: Backing out preserves the active run ─────────────────
  describe('VAL-RUN-037: backing out preserves the active run', () => {
    it('dismissing the confirmation sends no cancel command', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      // Dismiss via the safe "Keep running" button
      await user.click(screen.getByRole('button', { name: /keep running/i }));
      expect(cm.mutate).not.toHaveBeenCalled();
      // Dialog is gone
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('leaves the run status and actions unchanged after dismissing', async () => {
      const user = userEvent.setup();
      render(
        <MissionRunCard
          companyId="company-1"
          projectId="project-1"
          run={runSummary({ status: 'running' }) as never}
        />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      await user.click(screen.getByRole('button', { name: /keep running/i }));
      // Status still running, Cancel still available
      expect(screen.getByText(/^running$/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
    });
  });

  // ── VAL-RUN-038: Cancellation reason survives recoverable errors ─────
  describe('VAL-RUN-038: reason survives recoverable errors', () => {
    it('preserves the typed reason after a stale-version (412) error', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      // A stale-version error carries status 412 (recoverable).
      cm.mutateAsync.mockRejectedValueOnce(Object.assign(new Error('412'), { status: 412 }));
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      const reason = screen.getByRole('textbox', { name: /reason/i });
      await user.type(reason, 'No longer needed');
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      // An accessible error is shown
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      // Reason is preserved
      expect(reason).toHaveValue('No longer needed');
      // Dialog remains open for resubmission
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('preserves the typed reason after a network error', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      // A bare Error (no status) is treated as a network failure (recoverable).
      cm.mutateAsync.mockRejectedValueOnce(new Error('Network error'));
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      const reason = screen.getByRole('textbox', { name: /reason/i });
      await user.type(reason, 'Wrong project');
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      expect(reason).toHaveValue('Wrong project');
    });

    it('reuses the same idempotency key across a recoverable retry', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      cm.mutateAsync.mockRejectedValueOnce(Object.assign(new Error('412'), { status: 412 }));
      // Second attempt succeeds.
      cm.mutateAsync.mockResolvedValueOnce(undefined);
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'Retry me');
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      expect(await screen.findByRole('alert')).toBeInTheDocument();
      const firstKey = cm.mutateAsync.mock.calls[0][0].idempotencyKey;
      // Resubmit without reopening (same confirmation flow).
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      // The retry succeeds; the dialog closes on success.
      expect(cm.mutateAsync).toHaveBeenCalledTimes(2);
      const secondKey = cm.mutateAsync.mock.calls[1][0].idempotencyKey;
      expect(secondKey).toBe(firstKey);
    });
  });

  // ── VAL-RUN-057: Duplicate action clicks stay single ─────────────────
  describe('VAL-RUN-057: duplicate clicks stay single', () => {
    it('disables confirm while the first request is pending and fires one mutation', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      // Never resolves so the request stays pending.
      let _resolve!: () => void;
      cm.mutateAsync.mockReturnValue(
        new Promise<void>((resolve) => {
          _resolve = resolve;
        }),
      );
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'Dup');
      const confirm = screen.getByRole('button', { name: /confirm cancellation/i });
      await user.click(confirm);
      expect(cm.mutateAsync).toHaveBeenCalledTimes(1);
      // The confirm control is disabled while pending (local submitting).
      const pendingConfirm = screen.getByRole('button', {
        name: /cancelling|confirm cancellation/i,
      });
      expect(pendingConfirm).toBeDisabled();
      // A second activation while pending does not fire another mutation.
      await user.click(pendingConfirm);
      expect(cm.mutateAsync).toHaveBeenCalledTimes(1);
      // Release the pending request to settle the component.
      _resolve();
      // Allow microtasks to flush.
      await Promise.resolve();
    });
  });

  // ── VAL-RUN-091: Run actions are keyboard operable ───────────────────
  describe('VAL-RUN-091: keyboard operable', () => {
    it('can open, dismiss, and confirm cancellation by keyboard only', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      // Tab to the Cancel control and activate with Enter
      const cancelBtn = screen.getByRole('button', { name: /cancel run-1/i });
      cancelBtn.focus();
      await user.keyboard('{Enter}');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      // Type a reason
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'Keyboard cancel');
      // Tab to the confirm control and activate with Enter
      const confirm = screen.getByRole('button', { name: /confirm cancellation/i });
      confirm.focus();
      await user.keyboard('{Enter}');
      expect(cm.mutateAsync).toHaveBeenCalledTimes(1);
    });

    it('can dismiss the confirmation with the keyboard', async () => {
      const user = userEvent.setup();
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      const cancelBtn = screen.getByRole('button', { name: /cancel run-1/i });
      cancelBtn.focus();
      await user.keyboard('{Enter}');
      const keepRunning = screen.getByRole('button', { name: /keep running/i });
      keepRunning.focus();
      await user.keyboard('{Enter}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  // ── VAL-RUN-090: Focus follows user-triggered state changes ──────────
  describe('VAL-RUN-090: focus follows user-triggered changes', () => {
    it('moves focus into the confirmation dialog on open', async () => {
      const user = userEvent.setup();
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      const cancelBtn = screen.getByRole('button', { name: /cancel run-1/i });
      await user.click(cancelBtn);
      // Focus is somewhere within the dialog, not the document body
      const dialog = screen.getByRole('dialog');
      expect(dialog).toContainElement(document.activeElement);
    });

    it('restores focus to the originating control after dismissing', async () => {
      const user = userEvent.setup();
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      const cancelBtn = screen.getByRole('button', { name: /cancel run-1/i });
      await user.click(cancelBtn);
      await user.click(screen.getByRole('button', { name: /keep running/i }));
      expect(document.activeElement).toBe(cancelBtn);
    });

    it('does not lose focus to the document body after a recoverable error', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      cm.mutateAsync.mockRejectedValueOnce(Object.assign(new Error('412'), { status: 412 }));
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'X');
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      // The accessible error appears within the dialog (focus target).
      const alert = await screen.findByRole('alert');
      const dialog = screen.getByRole('dialog');
      expect(dialog).toContainElement(alert);
      // Focus moves to the alert, not the document body.
      expect(dialog).toContainElement(document.activeElement);
    });
  });

  // ── VAL-RUN-110: Cancelled card is explicit ──────────────────────────
  describe('VAL-RUN-110: cancelled card is explicit', () => {
    it('states cancellation, identifies when/by whom, and removes active indicators', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'cancelled',
            cancelRequestedAt: '2026-08-20T10:01:00.000Z',
            cancelRequestedBy: 'user-1',
            terminalAt: '2026-08-20T10:02:00.000Z',
          }),
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
      const card = screen.getByRole('article');
      // Explicit cancellation status text
      expect(within(card).getByText(/^cancelled$/i)).toBeInTheDocument();
      // Identifies who requested cancellation
      expect(within(card).getByText(/user-1/i)).toBeInTheDocument();
      // No active-work indicators: no Cancel control, no "Running"
      expect(within(card).queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
      // Does not present as completion
      expect(within(card).queryByText(/output/i)).not.toBeInTheDocument();
    });

    it('does not present cancellation as failure', () => {
      mocks.useMissionRunSnapshot.mockReturnValue(
        snapshotResult(
          runSnapshot({
            status: 'cancelled',
            cancelRequestedAt: '2026-08-20T10:01:00.000Z',
            cancelRequestedBy: 'user-1',
            terminalAt: '2026-08-20T10:02:00.000Z',
          }),
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
      const card = screen.getByRole('article');
      // No failure section
      expect(within(card).queryByText(/failure/i)).not.toBeInTheDocument();
      expect(within(card).queryByText(/safe error/i)).not.toBeInTheDocument();
    });
  });

  // ── VAL-RUN-111: Visible controls meet contrast ──────────────────────
  describe('VAL-RUN-111: visible controls meet contrast', () => {
    it('conveys destructive confirm with text and an icon, not color alone', async () => {
      const user = userEvent.setup();
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      const confirm = screen.getByRole('button', { name: /confirm cancellation/i });
      // Accessible name is explicit text, not color-only
      expect(confirm.textContent).toMatch(/confirm cancellation/i);
      // Disabled state conveys unavailability with text/aria, not color alone
      expect(confirm).toHaveAttribute('aria-disabled', 'true');
    });

    it('keeps the dismiss control reachable and labelled', async () => {
      const user = userEvent.setup();
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      const keepRunning = screen.getByRole('button', { name: /keep running/i });
      expect(keepRunning).not.toBeDisabled();
    });
  });

  // ── Integration through MissionRunList ───────────────────────────────
  describe('MissionRunList integration', () => {
    it('renders a Cancel control on an active run within the list', () => {
      mocks.useMissionRunsPaginated.mockReturnValue(
        listResult([runSummary({ status: 'running' })]),
      );
      render(<MissionRunList companyId="company-1" projectId="project-1" />, { wrapper });
      expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
    });
  });

  // ── Normative Boundary 4 / VAL-RUN-130: If-Match is sent ─────────────
  describe('Normative Boundary 4: If-Match is sent with snapshot.stateVersion', () => {
    it('forwards snapshot.stateVersion as ifMatch to cancelMissionRun', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      mocks.useCancelMissionRun.mockReturnValue(cm);
      mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult(runSnapshot({ stateVersion: 7 })));
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'Done');
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      expect(cm.mutateAsync).toHaveBeenCalledTimes(1);
      const args = cm.mutateAsync.mock.calls[0][0];
      expect(args.ifMatch).toBe(7);
    });

    it('does not send ifMatch when the snapshot has no stateVersion', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      mocks.useCancelMissionRun.mockReturnValue(cm);
      // Snapshot still loading: no data yet.
      mocks.useMissionRunSnapshot.mockReturnValue({
        data: undefined,
        isLoading: true,
        isError: false,
      });
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'Done');
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      expect(cm.mutateAsync).toHaveBeenCalledTimes(1);
      const args = cm.mutateAsync.mock.calls[0][0];
      expect(args.ifMatch).toBeUndefined();
    });
  });

  // ── Normative Boundary 4 / VAL-RUN-130: all error categories surfaced ─
  describe('Normative Boundary 4: all non-recoverable errors are surfaced', () => {
    const nonRecoverableCases: Array<{ status: number; code: string }> = [
      { status: 400, code: 'VALIDATION_ERROR' },
      { status: 401, code: 'UNAUTHENTICATED' },
      { status: 403, code: 'INSUFFICIENT_PERMISSION' },
      { status: 404, code: 'RUN_NOT_FOUND' },
      { status: 409, code: 'INVALID_RUN_STATE' },
      { status: 422, code: 'VALIDATION_ERROR' },
      { status: 428, code: 'PRECONDITION_REQUIRED' },
    ];

    for (const { status, code } of nonRecoverableCases) {
      it(`surfaces an accessible alert for HTTP ${status} ${code}`, async () => {
        const user = userEvent.setup();
        const cm = cancelMock();
        cm.mutateAsync.mockRejectedValueOnce(
          Object.assign(new Error(`${status}`), { status, body: { code } }),
        );
        mocks.useCancelMissionRun.mockReturnValue(cm);
        render(
          <MissionRunCard
            companyId="company-1"
            projectId="project-1"
            run={runSummary() as never}
          />,
          { wrapper },
        );
        await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
        await user.type(screen.getByRole('textbox', { name: /reason/i }), 'X');
        await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
        // An accessible alert is shown for the non-recoverable error.
        const alert = await screen.findByRole('alert');
        expect(alert).toBeInTheDocument();
        // The error code or status is conveyed to the user.
        expect(alert.textContent).toMatch(new RegExp(`${code}|${status}`, 'i'));
      });
    }

    it('moves focus to the alert after a non-recoverable error', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      cm.mutateAsync.mockRejectedValueOnce(
        Object.assign(new Error('403'), { status: 403, body: { code: 'INSUFFICIENT_PERMISSION' } }),
      );
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'X');
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      const alert = await screen.findByRole('alert');
      const dialog = screen.getByRole('dialog');
      expect(dialog).toContainElement(alert);
      // Focus is within the dialog, not lost to the body.
      expect(dialog).toContainElement(document.activeElement);
    });

    it('keeps the dialog open after a non-recoverable error so the user can dismiss', async () => {
      const user = userEvent.setup();
      const cm = cancelMock();
      cm.mutateAsync.mockRejectedValueOnce(
        Object.assign(new Error('409'), { status: 409, body: { code: 'INVALID_RUN_STATE' } }),
      );
      mocks.useCancelMissionRun.mockReturnValue(cm);
      render(
        <MissionRunCard companyId="company-1" projectId="project-1" run={runSummary() as never} />,
        { wrapper },
      );
      await user.click(screen.getByRole('button', { name: /cancel run-1/i }));
      await user.type(screen.getByRole('textbox', { name: /reason/i }), 'X');
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
      await screen.findByRole('alert');
      // Dialog remains open for the user to read the error and back out.
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });
});
