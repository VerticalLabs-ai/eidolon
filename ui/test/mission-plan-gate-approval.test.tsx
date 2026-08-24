import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionPlanGateApproval } from '../src/components/projects/MissionPlanGateApproval';
import type { Approval, MissionPlanRevision, MissionRunSnapshot } from '../src/lib/api';

/**
 * Governance surface convergence — Mission plan_gate approval in Approvals
 * (VAL-CROSS-045). A proposed plan appears once in Approvals with matching
 * scope/run/revision/hash/objective/requester/status; decisions submit
 * through the Mission command transaction with the current run version,
 * revision ID, and hash; stale actions prompt refresh instead of
 * overwriting newer state; and the generic legacy decide controls are not
 * rendered for plan_gate approvals.
 */

const mocks = vi.hoisted(() => ({
  useMissionRunSnapshot: vi.fn(),
  useMissionCurrentPlanRevision: vi.fn(),
  useApproveMissionPlan: vi.fn(),
  useRejectMissionPlan: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
    useApproveMissionPlan: mocks.useApproveMissionPlan,
    useRejectMissionPlan: mocks.useRejectMissionPlan,
  };
});

vi.mock('@/lib/auth', () => ({
  useSession: mocks.useSession,
  isLocalTrustedAuth: () => false,
  CLERK_PUBLISHABLE_KEY: '',
}));

function planGateApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'approval-1',
    companyId: 'company-1',
    kind: 'plan_gate',
    title: 'Mission plan approval — revision 1',
    description: 'Plan proposal for run run-abc',
    status: 'pending',
    priority: 'medium',
    requestedByUserId: null,
    requestedByAgentId: 'agent-1',
    resolvedByUserId: null,
    resolutionNote: null,
    payload: {
      runId: 'run-abc',
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
  };
}

function runSnapshot(overrides: Partial<MissionRunSnapshot> = {}): MissionRunSnapshot {
  return {
    id: 'run-abc',
    companyId: 'company-1',
    projectId: 'project-1',
    projectThreadId: 'thread-1',
    rootRunId: 'run-abc',
    parentRunId: null,
    retryOfRunId: null,
    depth: 0,
    childOrdinal: null,
    initiatingUserId: 'user-1',
    initiatingAgentId: 'agent-1',
    executingAgentId: null,
    billingAgentId: 'agent-1',
    routingKind: 'company_agent',
    mode: 'deep_work',
    modeProfileId: 'deep_work',
    policySnapshotId: 'policy-1',
    status: 'awaiting_approval',
    stateVersion: 7,
    lastEventSequence: 5,
    requestContentHash: 'reqhash',
    requestSafeSummary: 'Analyze the quarterly report',
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
    currentPlanRevisionId: 'rev-1234',
    approvedPlanRevisionId: null,
    resultCompleteness: null,
    ...overrides,
  } as unknown as MissionRunSnapshot;
}

function planRevision(overrides: Partial<MissionPlanRevision> = {}): MissionPlanRevision {
  return {
    id: 'rev-1234',
    revision: 1,
    contentHash: 'abcd1234efgh5678',
    content: {
      schemaVersion: 1,
      objective: 'Analyze the quarterly report',
      steps: [],
      synthesis: {
        instructions: 'Synthesize',
        declaredInputs: [],
        declaredOutput: 'report',
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Done',
        budgetCents: 100,
      },
      planningBudgetCents: 100,
      partialResultPolicy: 'require_all',
      limits: {
        steps: 4,
        durationSeconds: 300,
        providerCalls: 6,
        totalTokens: 32000,
        outputBytes: 1048576,
        costCents: 500,
        depth: 0,
        fanOut: 0,
        descendants: 0,
      },
    },
    ...overrides,
  } as unknown as MissionPlanRevision;
}

function approveMutationMock(
  overrides: Partial<{ mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }> = {},
) {
  return { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false, ...overrides };
}

function rejectMutationMock(
  overrides: Partial<{ mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean }> = {},
) {
  return { mutateAsync: vi.fn().mockResolvedValue({}), isPending: false, ...overrides };
}

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useSession.mockReturnValue({
    isPending: false,
    data: { user: { id: 'user-1', name: 'Op', email: 'o@e.dev', image: '', role: 'admin' } },
  });
  mocks.useMissionRunSnapshot.mockReturnValue({ data: runSnapshot(), isLoading: false });
  mocks.useMissionCurrentPlanRevision.mockReturnValue({ data: planRevision() });
  mocks.useApproveMissionPlan.mockReturnValue(approveMutationMock());
  mocks.useRejectMissionPlan.mockReturnValue(rejectMutationMock());
});

describe('VAL-CROSS-045: Approvals projection is consistent', () => {
  it('renders matching scope/run/revision/hash/objective/requester/status for a pending plan_gate', () => {
    renderWithProviders(
      <MissionPlanGateApproval companyId="company-1" approval={planGateApproval()} />,
    );

    expect(screen.getByText(/run-abc/i)).toBeInTheDocument();
    expect(screen.getByText(/rev-1234/i)).toBeInTheDocument();
    expect(screen.getByText(/abcd1234/i)).toBeInTheDocument();
    expect(screen.getByText(/Analyze the quarterly report/i)).toBeInTheDocument();
    expect(screen.getByText(/awaiting_approval/i)).toBeInTheDocument();
    // Requester agent identity is surfaced.
    expect(screen.getByText(/agent-1/i)).toBeInTheDocument();
  });

  it('submits approve through the Mission command with revisionId, contentHash, and current run version', async () => {
    const approve = approveMutationMock();
    mocks.useApproveMissionPlan.mockReturnValue(approve);
    const user = userEvent.setup();
    renderWithProviders(
      <MissionPlanGateApproval companyId="company-1" approval={planGateApproval()} />,
    );

    const approveButton = screen.getByTestId('plan-approve-button');
    await user.click(approveButton);

    await waitFor(() => expect(approve.mutateAsync).toHaveBeenCalledTimes(1));
    expect(approve.mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        planRevisionId: 'rev-1234',
        contentHash: 'abcd1234efgh5678',
        ifMatch: 7,
      }),
    );
  });

  it('does not render generic legacy decide/cancel controls for a plan_gate approval', () => {
    renderWithProviders(
      <MissionPlanGateApproval companyId="company-1" approval={planGateApproval()} />,
    );
    // The legacy generic decision controls are not surfaced.
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel request/i })).not.toBeInTheDocument();
    // The Mission-bound approve control is present instead.
    expect(screen.getByTestId('plan-approve-button')).toBeInTheDocument();
  });

  it('shows a stale-state refresh message when the run version no longer matches (412)', async () => {
    const approve = approveMutationMock({
      mutateAsync: vi.fn().mockRejectedValue({
        status: 412,
        body: { code: 'RUN_VERSION_MISMATCH' },
      }),
    });
    mocks.useApproveMissionPlan.mockReturnValue(approve);
    const user = userEvent.setup();
    renderWithProviders(
      <MissionPlanGateApproval companyId="company-1" approval={planGateApproval()} />,
    );

    await user.click(screen.getByTestId('plan-approve-button'));

    // The stale-state refresh alert is shown (not an optimistic approval).
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
      expect(alert.textContent).toMatch(/could not be applied/i);
    });
  });

  it('renders resolved history without actionable decision controls once decided', () => {
    renderWithProviders(
      <MissionPlanGateApproval
        companyId="company-1"
        approval={planGateApproval({
          status: 'approved',
          resolvedByUserId: 'user-1',
          resolvedAt: '2026-08-23T11:00:00.000Z',
        })}
      />,
    );

    // Resolved status is shown; no actionable Mission approve control.
    expect(screen.getByText(/approved/i)).toBeInTheDocument();
    expect(screen.queryByTestId('plan-approve-button')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plan-reject-button')).not.toBeInTheDocument();
  });

  it('shows a stale-revision refresh notice when the approval revision is no longer current', () => {
    // The run advanced to a newer revision; the approval is for the old one.
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: runSnapshot({ currentPlanRevisionId: 'rev-5678', status: 'awaiting_approval' }),
      isLoading: false,
    });
    mocks.useMissionCurrentPlanRevision.mockReturnValue({
      data: planRevision({ id: 'rev-5678', revision: 2, contentHash: 'ffff0000' }),
    });

    renderWithProviders(
      <MissionPlanGateApproval companyId="company-1" approval={planGateApproval()} />,
    );

    // The stale-revision notice replaces actionable controls.
    expect(screen.getByTestId('plan-stale-revision-notice')).toBeInTheDocument();
    expect(screen.queryByTestId('plan-approve-button')).not.toBeInTheDocument();
  });
});
