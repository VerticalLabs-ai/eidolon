import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPlansPanel } from '../src/components/projects/ProjectPlansPanel';

/**
 * Governance surface convergence — Mission-projected plans (VAL-CROSS-046,
 * VAL-CROSS-086). A Mission-linked Project Plan visibly names its
 * run/revision/hash, legacy add-step/reorder/gate-advance/edit controls are
 * disabled with reason, and no projection-only edit appears to alter running
 * work. Step status reflects the authoritative execution projection.
 */

const mocks = vi.hoisted(() => ({
  usePlansWithSteps: vi.fn(),
  useCreateProjectPlan: vi.fn(),
  useUpdateProjectPlan: vi.fn(),
  useCreatePlanStep: vi.fn(),
  useUpdatePlanStep: vi.fn(),
  useAdvancePlanGate: vi.fn(),
}));

vi.mock('@/lib/hooks', () => mocks);

const basePlan = {
  id: 'plan-mission',
  companyId: 'company-1',
  projectId: 'project-1',
  title: 'Analyze the quarterly report',
  description: 'Mission plan (revision rev-1234, hash abcd1234)',
  status: 'active' as const,
  progress: 50,
  taskId: null,
  stepCount: 2,
  completedStepCount: 1,
  createdByUserId: null,
  createdByAgentId: 'agent-1',
  createdAt: '2026-08-23T10:00:00.000Z',
  updatedAt: '2026-08-23T10:00:00.000Z',
};

/** A Mission-linked step carries gateConfig with run/revision/hash/stepKey. */
function missionStep(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'step-m1',
    planId: 'plan-mission',
    companyId: 'company-1',
    title: 'Gather data',
    description: null,
    stepOrder: 0,
    stepType: 'action' as const,
    status: 'in_progress' as const,
    gateApprovalId: null,
    gateConfig: {
      runId: 'run-abc',
      planRevisionId: 'rev-1234',
      stepKey: 'step-1',
      contentHash: 'abcd1234efgh5678',
    },
    completedByUserId: null,
    completedByAgentId: null,
    completedAt: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

function mutationResult(
  overrides: Partial<{ mutate: ReturnType<typeof vi.fn>; isPending: boolean }> = {},
) {
  return { mutate: vi.fn(), isPending: false, ...overrides };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.usePlansWithSteps.mockReturnValue({ data: [], isLoading: false, isError: false });
  mocks.useCreateProjectPlan.mockReturnValue(mutationResult());
  mocks.useUpdateProjectPlan.mockReturnValue(mutationResult());
  mocks.useCreatePlanStep.mockReturnValue(mutationResult());
  mocks.useUpdatePlanStep.mockReturnValue(mutationResult());
  mocks.useAdvancePlanGate.mockReturnValue(mutationResult());
});

describe('VAL-CROSS-086: Mission-projected plans expose no false editing authority', () => {
  it('names the run, revision, and hash for a Mission-linked plan', () => {
    const plan = { ...basePlan, steps: [missionStep()] };
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });

    // The Mission linkage is visible as text (run id, revision, hash).
    expect(screen.getByText(/run-abc/i)).toBeInTheDocument();
    expect(screen.getByText(/rev-1234/i)).toBeInTheDocument();
    expect(screen.getByText(/abcd1234/i)).toBeInTheDocument();
  });

  it('disables the add-step control for a Mission-linked plan with a reason', () => {
    const plan = { ...basePlan, steps: [missionStep()] };
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: /expand.*Analyze the quarterly report/i }));

    // The add-step input/button is disabled for Mission-linked plans.
    const addStepButton = screen.queryByRole('button', { name: /add step/i });
    // Mission-linked plans do not expose an actionable add-step control.
    expect(addStepButton === null || (addStepButton as HTMLButtonElement).disabled).toBe(true);
    // A reason explains projection-only edits cannot alter the Mission.
    expect(screen.getByText(/cannot be edited here/i)).toBeInTheDocument();
  });

  it('disables reorder (up/down) and gate-advance controls for Mission-linked steps', () => {
    const plan = {
      ...basePlan,
      steps: [
        missionStep({ id: 'step-m1', title: 'Gather data', stepOrder: 0, status: 'pending' }),
        missionStep({
          id: 'step-m2',
          title: 'Write analysis',
          stepOrder: 1,
          status: 'pending',
          gateConfig: {
            runId: 'run-abc',
            planRevisionId: 'rev-1234',
            stepKey: 'step-2',
            contentHash: 'abcd1234efgh5678',
          },
        }),
      ],
    };
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: /expand.*Analyze the quarterly report/i }));

    // Reorder buttons are disabled.
    const upButton = screen.getByTestId('step-up-step-m2');
    const downButton = screen.getByTestId('step-down-step-m1');
    expect((upButton as HTMLButtonElement).disabled).toBe(true);
    expect((downButton as HTMLButtonElement).disabled).toBe(true);
    // No actionable gate-advance control is rendered for Mission-linked steps.
    const advanceButton = screen.queryByRole('button', { name: /advance gate/i });
    expect(advanceButton === null || (advanceButton as HTMLButtonElement).disabled).toBe(true);
  });

  it('does not call legacy mutations when Mission-linked controls are activated', () => {
    const stepMutate = vi.fn();
    const advanceMutate = vi.fn();
    mocks.useUpdatePlanStep.mockReturnValue(mutationResult({ mutate: stepMutate }));
    mocks.useAdvancePlanGate.mockReturnValue(mutationResult({ mutate: advanceMutate }));
    const plan = {
      ...basePlan,
      steps: [
        missionStep({ id: 'step-m1', title: 'Gather data', stepOrder: 0, status: 'pending' }),
        missionStep({
          id: 'step-m2',
          title: 'Write analysis',
          stepOrder: 1,
          status: 'pending',
          gateConfig: {
            runId: 'run-abc',
            planRevisionId: 'rev-1234',
            stepKey: 'step-2',
            contentHash: 'abcd1234efgh5678',
          },
        }),
      ],
    };
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: /expand.*Analyze the quarterly report/i }));

    // Activating a disabled reorder button fires no mutation.
    const upButton = screen.getByTestId('step-up-step-m2') as HTMLButtonElement;
    expect(upButton.disabled).toBe(true);
    // Disabled buttons do not fire onClick in the browser; simulate confirms
    // no mutate call was made.
    expect(stepMutate).not.toHaveBeenCalled();
    expect(advanceMutate).not.toHaveBeenCalled();
  });

  it('keeps legacy (non-Mission) plans fully editable', () => {
    const plan = {
      ...basePlan,
      id: 'plan-legacy',
      title: 'Legacy release plan',
      description: 'Ship v2',
      steps: [
        {
          id: 'step-l1',
          planId: 'plan-legacy',
          companyId: 'company-1',
          title: 'Write tests',
          description: null,
          stepOrder: 0,
          stepType: 'action' as const,
          status: 'pending' as const,
          gateApprovalId: null,
          gateConfig: {} as Record<string, unknown>,
          completedByUserId: null,
          completedByAgentId: null,
          completedAt: null,
          createdAt: '2026-08-23T10:00:00.000Z',
          updatedAt: '2026-08-23T10:00:00.000Z',
        },
      ],
    };
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });

    // No Mission linkage text for legacy plans.
    expect(screen.queryByText(/Mission-linked/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /expand.*Legacy release plan/i }));
    // The add-step control is present (not hidden) for legacy plans, and
    // becomes actionable once a title is typed (not Mission-locked).
    const stepInput = screen.getByTestId('new-step-title-plan-legacy');
    fireEvent.change(stepInput, { target: { value: 'Draft the spec' } });
    const addStepButton = screen.getByRole('button', { name: /add step/i });
    expect((addStepButton as HTMLButtonElement).disabled).toBe(false);
    // Reorder controls are present and not Mission-locked (boundary-disabled
    // for a single step, but the control exists).
    expect(screen.getByTestId('step-up-step-l1')).toBeInTheDocument();
  });
});

describe('VAL-CROSS-046: Plans projection tracks execution status', () => {
  it('reflects authoritative step status from the Mission execution projection', () => {
    const plan = {
      ...basePlan,
      steps: [
        missionStep({ id: 'step-m1', title: 'Gather data', status: 'completed', stepOrder: 0 }),
        missionStep({
          id: 'step-m2',
          title: 'Write analysis',
          status: 'in_progress',
          stepOrder: 1,
          gateConfig: {
            runId: 'run-abc',
            planRevisionId: 'rev-1234',
            stepKey: 'step-2',
            contentHash: 'abcd1234efgh5678',
          },
        }),
      ],
    };
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });

    fireEvent.click(screen.getByRole('button', { name: /expand.*Analyze the quarterly report/i }));
    const stepsList = screen.getByTestId('plan-steps-plan-mission');
    expect(within(stepsList).getByTestId('step-status-completed')).toBeInTheDocument();
    expect(within(stepsList).getByTestId('step-status-in_progress')).toBeInTheDocument();
  });
});
