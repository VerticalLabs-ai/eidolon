import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionPlanCard } from '../src/components/projects/MissionPlanCard';
import type { MissionPlanRevision } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useMissionCurrentPlanRevision: vi.fn(),
  useApproveMissionPlan: vi.fn(),
  useRejectMissionPlan: vi.fn(),
  useReviseMissionPlan: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
    useApproveMissionPlan: mocks.useApproveMissionPlan,
    useRejectMissionPlan: mocks.useRejectMissionPlan,
    useReviseMissionPlan: mocks.useReviseMissionPlan,
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

/** A complete proposed PlanContentV1 with one step. */
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

function planQueryResult(revision: MissionPlanRevision | null = proposedRevision()) {
  return {
    data: revision,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
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

function renderCard(
  overrides: Partial<Record<string, unknown>> & {
    revision?: MissionPlanRevision;
    role?: 'owner' | 'admin' | 'member' | 'viewer';
    runStatus?: string;
    stateVersion?: number;
    currentPlanRevisionId?: string;
    approveMock?: ReturnType<typeof mutationMock>;
    reviseMock?: ReturnType<typeof mutationMock>;
    rejectMock?: ReturnType<typeof mutationMock>;
    planRefetch?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const {
    revision = proposedRevision(),
    role = 'admin',
    runStatus = 'awaiting_approval',
    stateVersion = 3,
    currentPlanRevisionId = 'plan-rev-1',
    approveMock,
    reviseMock,
    rejectMock,
    planRefetch,
  } = overrides;
  mocks.useMissionCurrentPlanRevision.mockReturnValue({
    ...planQueryResult(revision),
    refetch: planRefetch ?? vi.fn(),
  });
  mocks.useApproveMissionPlan.mockReturnValue(approveMock ?? mutationMock());
  mocks.useRejectMissionPlan.mockReturnValue(rejectMock ?? mutationMock());
  mocks.useReviseMissionPlan.mockReturnValue(reviseMock ?? mutationMock());
  return render(
    <MissionPlanCard
      companyId="company-1"
      projectId="project-1"
      runId="run-1"
      currentPlanRevisionId={currentPlanRevisionId}
      resolvedMode="deep_work"
      runStatus={runStatus}
      stateVersion={stateVersion}
      role={role}
      principalId="dev-user-000"
      onRefreshSnapshot={vi.fn()}
    />,
    { wrapper },
  );
}

describe('Mission plan decision dialogs', () => {
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
  });

  // ── VAL-PLAN-042: Approve updates the visible decision state ─────────
  it('shows approve/revise/reject controls while awaiting approval', () => {
    renderCard();
    expect(screen.getByRole('button', { name: /approve plan revision 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revise plan revision 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reject plan revision 1/i })).toBeInTheDocument();
  });

  it('does not render decision controls when the run is not awaiting approval', () => {
    renderCard({ runStatus: 'queued' });
    expect(screen.queryByTestId('plan-decision-controls')).not.toBeInTheDocument();
  });

  it('does not render decision controls for an already-approved revision', () => {
    renderCard({ revision: proposedRevision({ status: 'approved' }) });
    expect(screen.queryByTestId('plan-decision-controls')).not.toBeInTheDocument();
  });

  it('approves via the canonical command with exact revision id, hash, and ifMatch', async () => {
    const approve = mutationMock();
    renderCard({ stateVersion: 7, approveMock: approve });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve plan revision 1/i }));
    });
    await waitFor(() => {
      expect(approve.mutateAsync).toHaveBeenCalledWith({
        planRevisionId: 'plan-rev-1',
        contentHash: 'a'.repeat(64),
        idempotencyKey: expect.any(String),
        ifMatch: 7,
      });
    });
  });

  it('does not optimistically advance decision state before the server applies the command', async () => {
    // Pending mutation: control shows pending label but no approved status.
    const approve = mutationMock({ isPending: true });
    renderCard({ approveMock: approve });
    const btn = screen.getByTestId('plan-approve-button');
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/approving…/i);
    // The card heading still says "Proposed plan" — no optimistic approval.
    expect(screen.getByRole('heading', { name: /proposed plan/i })).toBeInTheDocument();
  });

  // ── VAL-PLAN-050: Double-click cannot duplicate a decision ───────────
  it('disables approve while pending so rapid repeated activation fires one command', async () => {
    const approve = mutationMock({ isPending: true });
    renderCard({ approveMock: approve });
    const btn = screen.getByTestId('plan-approve-button');
    expect(btn).toBeDisabled();
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    // The disabled control prevents dispatch; the pending mock never
    // resolves, so no mutation is issued from these clicks.
    expect(approve.mutateAsync).toHaveBeenCalledTimes(0);
  });

  it('disables revise and reject controls while any decision is pending', () => {
    renderCard({ approveMock: mutationMock({ isPending: true }) });
    expect(screen.getByRole('button', { name: /revise plan revision 1/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject plan revision 1/i })).toBeDisabled();
  });

  // ── VAL-PLAN-038: Revise requires feedback ───────────────────────────
  it('blocks revision request with empty feedback and shows a field-level error', async () => {
    const revise = mutationMock();
    renderCard({ reviseMock: revise });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
    });
    const submit = screen.getByRole('button', { name: /request revision/i });
    await act(async () => {
      fireEvent.click(submit);
    });
    expect(revise.mutateAsync).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/feedback is required/i);
    });
  });

  it('submits a revision request with feedback through the canonical command', async () => {
    const revise = mutationMock();
    renderCard({ stateVersion: 5, reviseMock: revise });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
    });
    const textarea = screen.getByRole('textbox', { name: /feedback/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Add a citations step.' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
    });
    await waitFor(() => {
      expect(revise.mutateAsync).toHaveBeenCalledWith({
        planRevisionId: 'plan-rev-1',
        contentHash: 'a'.repeat(64),
        feedback: 'Add a citations step.',
        idempotencyKey: expect.any(String),
        ifMatch: 5,
      });
    });
  });

  // ── VAL-PLAN-037: Revise creates immutable successor ──────────────────
  it('marks the revision request as succeeded and surfaces a non-actionable status', async () => {
    const revise = mutationMock();
    renderCard({ reviseMock: revise });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: /feedback/i }), {
        target: { value: 'Add a citations step.' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
    });
    expect(
      screen.getByText(/revision requested. the mission is returning to planning./i),
    ).toBeInTheDocument();
  });

  // ── VAL-PLAN-040: Reject cancels by default ──────────────────────────
  it('requires confirmation before issuing a reject command', async () => {
    const reject = mutationMock();
    renderCard({ rejectMock: reject });
    // Opening the reject dialog does not issue a command.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject plan revision 1/i }));
    });
    expect(reject.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: /reject plan/i })).toBeInTheDocument();
  });

  it('rejects with default cancel disposition through the canonical command', async () => {
    const reject = mutationMock();
    renderCard({ stateVersion: 4, rejectMock: reject });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject plan revision 1/i }));
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: /reason/i }), {
        target: { value: 'Budget too high.' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm rejection/i }));
    });
    await waitFor(() => {
      expect(reject.mutateAsync).toHaveBeenCalledWith({
        planRevisionId: 'plan-rev-1',
        contentHash: 'a'.repeat(64),
        reason: 'Budget too high.',
        disposition: 'cancel',
        idempotencyKey: expect.any(String),
        ifMatch: 4,
      });
    });
  });

  it('backing out of reject sends no command and leaves controls actionable', async () => {
    const reject = mutationMock();
    renderCard({ rejectMock: reject });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject plan revision 1/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /keep plan/i }));
    });
    expect(reject.mutateAsync).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /reject plan revision 1/i })).toBeInTheDocument();
  });

  // ── VAL-PLAN-045: Stale revision cannot decide ───────────────────────
  it('renders a stale-revision refresh notice when the rendered revision is not current', () => {
    renderCard({ currentPlanRevisionId: 'plan-rev-2' });
    expect(screen.getByTestId('plan-stale-revision-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('plan-decision-controls')).not.toBeInTheDocument();
  });

  it('surfaces a refresh notice and no decision when the server returns PLAN_REVISION_NOT_CURRENT', async () => {
    const approve = mutationMock();
    approve.mutateAsync.mockRejectedValueOnce({
      status: 409,
      body: { code: 'PLAN_REVISION_NOT_CURRENT' },
    });
    mocks.useApproveMissionPlan.mockReturnValue(approve);
    mocks.useRejectMissionPlan.mockReturnValue(mutationMock());
    mocks.useReviseMissionPlan.mockReturnValue(mutationMock());
    const onRefresh = vi.fn();
    mocks.useMissionCurrentPlanRevision.mockReturnValue(planQueryResult());
    render(
      <MissionPlanCard
        companyId="company-1"
        projectId="project-1"
        runId="run-1"
        currentPlanRevisionId="plan-rev-1"
        resolvedMode="deep_work"
        runStatus="awaiting_approval"
        stateVersion={3}
        role="admin"
        principalId="dev-user-000"
        onRefreshSnapshot={onRefresh}
      />,
      { wrapper },
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve plan revision 1/i }));
    });
    await waitFor(() => {
      expect(screen.getByTestId('plan-stale-revision-notice')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('plan-decision-controls')).not.toBeInTheDocument();
  });

  // ── VAL-PLAN-055: Viewer can read but cannot decide ──────────────────
  it('disables approve and reject for a viewer and shows a read-only reason', () => {
    renderCard({ role: 'viewer' });
    expect(screen.getByRole('button', { name: /approve plan revision 1/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject plan revision 1/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /revise plan revision 1/i })).toBeDisabled();
    expect(
      screen.getByText(/you can read this plan but cannot make decisions/i),
    ).toBeInTheDocument();
  });

  it('disables approve/reject for a member but allows revise', () => {
    renderCard({ role: 'member' });
    expect(screen.getByRole('button', { name: /approve plan revision 1/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /reject plan revision 1/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /revise plan revision 1/i })).not.toBeDisabled();
  });

  // ── VAL-PLAN-092: Approval network failure preserves intent ──────────
  it('preserves typed feedback after a recoverable network failure on revise', async () => {
    const revise = mutationMock();
    revise.mutateAsync.mockRejectedValueOnce(new Error('network'));
    renderCard({ reviseMock: revise });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
    });
    const textarea = screen.getByRole('textbox', { name: /feedback/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Add a citations step.' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/connection failed/i);
    });
    // The typed feedback is preserved in the textarea.
    expect(textarea).toHaveValue('Add a citations step.');
  });

  it('preserves typed reason after a recoverable stale-version error on reject', async () => {
    const reject = mutationMock();
    reject.mutateAsync.mockRejectedValueOnce({
      status: 412,
      body: { code: 'RUN_VERSION_MISMATCH' },
    });
    renderCard({ rejectMock: reject });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject plan revision 1/i }));
    });
    const textarea = screen.getByRole('textbox', { name: /reason/i });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'Budget too high.' } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm rejection/i }));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /may have changed or the connection failed/i,
      );
    });
    expect(textarea).toHaveValue('Budget too high.');
  });

  // ── VAL-PLAN-093: Structured API errors map to safe UI messages ───────
  it.each([
    [{ status: 400, body: { code: 'VALIDATION_ERROR' } }, /invalid/i],
    [{ status: 403, body: { code: 'INSUFFICIENT_PERMISSION' } }, /permission/i],
    [{ status: 409, body: { code: 'INVALID_RUN_STATE' } }, /no longer be decided/i],
    [
      { status: 409, body: { code: 'IDEMPOTENCY_KEY_REUSED' } },
      /conflicts with an earlier submission/i,
    ],
    [{ status: 409, body: { code: 'BUDGET_UNAVAILABLE' } }, /budget/i],
    [{ status: 428, body: { code: 'PRECONDITION_REQUIRED' } }, /state could not be verified/i],
    [{ status: 500, body: { code: 'INTERNAL' } }, /could not be applied/i],
  ])('maps %s to a safe, actionable alert with no secrets', async (err, pattern) => {
    const approve = mutationMock();
    approve.mutateAsync.mockRejectedValueOnce(err);
    renderCard({ approveMock: approve });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve plan revision 1/i }));
    });
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(pattern);
    });
    // No raw provider body / stack trace / credential leaked.
    const alertText = screen.getByRole('alert').textContent ?? '';
    expect(alertText).not.toMatch(/secret|password|api[_-]?key|stack/i);
  });

  // ── VAL-PLAN-104: Every decision surface uses the canonical command ──
  it('all three controls submit canonical command types via the shared command endpoint hook', async () => {
    const approve = mutationMock();
    const revise = mutationMock();
    const reject = mutationMock();

    // Approve
    renderCard({ stateVersion: 9, approveMock: approve });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /approve plan revision 1/i }));
    });
    await waitFor(() => expect(approve.mutateAsync).toHaveBeenCalledTimes(1));
    cleanup();

    // Revise
    renderCard({ stateVersion: 9, reviseMock: revise });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: /feedback/i }), {
        target: { value: 'Tighten the budget.' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
    });
    await waitFor(() => expect(revise.mutateAsync).toHaveBeenCalledTimes(1));
    cleanup();

    // Reject
    renderCard({ stateVersion: 9, rejectMock: reject });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /reject plan revision 1/i }));
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: /reason/i }), {
        target: { value: 'Not aligned.' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm rejection/i }));
    });
    await waitFor(() => expect(reject.mutateAsync).toHaveBeenCalledTimes(1));
  });

  // ── VAL-PLAN-108: Approval-wait cancellation preserves decision meaning
  it('shows no actionable decision controls once the run is cancelled from awaiting approval', () => {
    // A cancelled run retains the proposal but is terminal: no decision
    // controls render, so cancellation records no plan rejection.
    renderCard({ runStatus: 'cancelled' });
    expect(screen.queryByTestId('plan-decision-controls')).not.toBeInTheDocument();
    // The proposal itself remains visible (history retained).
    expect(screen.getByRole('heading', { name: /proposed plan/i })).toBeInTheDocument();
  });

  // ── VAL-PLAN-120: Decision dialogs contain focus and announce errors ─
  it('moves focus to the feedback field when the revise dialog opens', async () => {
    renderCard();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revise plan revision 1/i }));
    });
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /feedback/i })).toHaveFocus();
    });
  });

  it('returns focus to the originating control when the revise dialog is dismissed', async () => {
    const user = userEvent.setup();
    renderCard();
    const trigger = screen.getByRole('button', { name: /revise plan revision 1/i });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: /keep current plan/i }));
    await waitFor(() => {
      expect(trigger).toHaveFocus();
    });
  });
});
