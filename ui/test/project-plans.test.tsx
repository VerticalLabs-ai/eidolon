import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanProgressCard } from "../src/components/projects/PlanProgressCard";
import { ProjectPlansPanel } from "../src/components/projects/ProjectPlansPanel";

const mocks = vi.hoisted(() => ({
  usePlansWithSteps: vi.fn(),
  useCreateProjectPlan: vi.fn(),
  useUpdateProjectPlan: vi.fn(),
  useCreatePlanStep: vi.fn(),
  useUpdatePlanStep: vi.fn(),
  useAdvancePlanGate: vi.fn(),
}));

vi.mock("@/lib/hooks", () => mocks);

const basePlan = {
  id: "plan-1",
  companyId: "company-1",
  projectId: "project-1",
  title: "Release plan",
  description: "Ship v2",
  status: "active" as const,
  progress: 50,
  taskId: null,
  stepCount: 4,
  completedStepCount: 2,
  createdByUserId: "user-1",
  createdByAgentId: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

const baseStep = {
  id: "step-1",
  planId: "plan-1",
  companyId: "company-1",
  title: "Write tests",
  description: null,
  stepOrder: 0,
  stepType: "action" as const,
  status: "completed" as const,
  gateApprovalId: null,
  gateConfig: {} as Record<string, unknown>,
  completedByUserId: "user-1",
  completedByAgentId: null,
  completedAt: "2026-08-01T11:00:00.000Z",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T11:00:00.000Z",
};

function planWithSteps(overrides: Partial<typeof basePlan> = {}, steps: typeof baseStep[] = [baseStep]) {
  return { ...basePlan, ...overrides, steps };
}

function step(overrides: Partial<typeof baseStep> = {}) {
  return { ...baseStep, ...overrides };
}

function mutationResult(overrides: Partial<{ mutate: ReturnType<typeof vi.fn>; isPending: boolean }> = {}) {
  return { mutate: vi.fn(), isPending: false, ...overrides };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe("PlanProgressCard — VAL-PLAN-013, VAL-PLAN-012", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usePlansWithSteps.mockReturnValue({ data: [], isLoading: false, isError: false });
  });

  it("renders active plans with a progress bar and percentage", () => {
    const plan = planWithSteps(
      { progress: 50, completedStepCount: 2, stepCount: 4 },
      [
        step({ id: "s-1", status: "completed", stepOrder: 0 }),
        step({ id: "s-2", status: "completed", stepOrder: 1 }),
        step({ id: "s-3", status: "in_progress", stepOrder: 2, title: "Implement feature" }),
        step({ id: "s-4", status: "pending", stepOrder: 3, title: "Ship it" }),
      ],
    );
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<PlanProgressCard companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText("Release plan")).toBeInTheDocument();
    expect(screen.getByText(/2\/4/)).toBeInTheDocument();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
  });

  it("shows step status indicators for each step", () => {
    const plan = planWithSteps(
      { progress: 40, completedStepCount: 2, stepCount: 5 },
      [
        step({ id: "s-1", status: "completed", title: "Done step", stepOrder: 0 }),
        step({ id: "s-2", status: "in_progress", title: "Active step", stepOrder: 1 }),
        step({ id: "s-3", status: "pending", title: "Queued step", stepOrder: 2 }),
        step({ id: "s-4", status: "blocked", title: "Stuck step", stepOrder: 3 }),
        step({ id: "s-5", status: "skipped", title: "Skipped step", stepOrder: 4 }),
      ],
    );
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<PlanProgressCard companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("step-status-completed")).toBeInTheDocument();
    expect(screen.getByTestId("step-status-in_progress")).toBeInTheDocument();
    expect(screen.getByTestId("step-status-pending")).toBeInTheDocument();
    expect(screen.getByTestId("step-status-blocked")).toBeInTheDocument();
    expect(screen.getByTestId("step-status-skipped")).toBeInTheDocument();
  });

  it("shows an empty state when there are no active plans", () => {
    mocks.usePlansWithSteps.mockReturnValue({ data: [], isLoading: false, isError: false });
    render(<PlanProgressCard companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/no active plans/i)).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    mocks.usePlansWithSteps.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<PlanProgressCard companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an error state", () => {
    mocks.usePlansWithSteps.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<PlanProgressCard companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });
});

describe("ProjectPlansPanel — VAL-PLAN-014, VAL-PLAN-012, VAL-PLAN-015", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.usePlansWithSteps.mockReturnValue({ data: [], isLoading: false, isError: false });
    mocks.useCreateProjectPlan.mockReturnValue(mutationResult());
    mocks.useUpdateProjectPlan.mockReturnValue(mutationResult());
    mocks.useCreatePlanStep.mockReturnValue(mutationResult());
    mocks.useUpdatePlanStep.mockReturnValue(mutationResult());
    mocks.useAdvancePlanGate.mockReturnValue(mutationResult());
  });

  it("renders all plans with expandable step lists", () => {
    const planA = planWithSteps({ id: "plan-a", title: "Plan A" }, [
      step({ id: "sa-1", planId: "plan-a", title: "Step A1", stepOrder: 0, status: "pending" }),
    ]);
    const planB = planWithSteps({ id: "plan-b", title: "Plan B" }, [
      step({ id: "sb-1", planId: "plan-b", title: "Step B1", stepOrder: 0, status: "completed" }),
    ]);
    mocks.usePlansWithSteps.mockReturnValue({ data: [planA, planB], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText("Plan A")).toBeInTheDocument();
    expect(screen.getByText("Plan B")).toBeInTheDocument();
    // Steps are collapsed by default
    expect(screen.queryByText("Step A1")).not.toBeInTheDocument();
    // Expand plan A
    fireEvent.click(screen.getByRole("button", { name: /expand.*Plan A/i }));
    expect(screen.getByText("Step A1")).toBeInTheDocument();
  });

  it("creates a plan via the UI", () => {
    const mutate = vi.fn();
    mocks.useCreateProjectPlan.mockReturnValue(mutationResult({ mutate }));
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    const titleInput = screen.getByTestId("new-plan-title");
    fireEvent.change(titleInput, { target: { value: "New launch plan" } });
    fireEvent.click(screen.getByRole("button", { name: /create plan/i }));
    expect(mutate).toHaveBeenCalledWith({ title: "New launch plan" });
  });

  it("blocks creating a plan with an empty title", () => {
    const mutate = vi.fn();
    mocks.useCreateProjectPlan.mockReturnValue(mutationResult({ mutate }));
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    const submit = screen.getByRole("button", { name: /create plan/i });
    expect(submit).toBeDisabled();
  });

  it("adds a step to an expanded plan via the UI", () => {
    const mutate = vi.fn();
    mocks.useCreatePlanStep.mockReturnValue(mutationResult({ mutate }));
    const plan = planWithSteps({ id: "plan-a", title: "Plan A" }, []);
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /expand.*Plan A/i }));
    const stepInput = screen.getByTestId("new-step-title-plan-a");
    fireEvent.change(stepInput, { target: { value: "Draft the spec" } });
    fireEvent.click(screen.getByRole("button", { name: /add step/i }));
    expect(mutate).toHaveBeenCalledWith({ planId: "plan-a", data: { title: "Draft the spec" } });
  });

  it("step status indicators show all statuses", () => {
    const plan = planWithSteps({ id: "plan-all", title: "Statuses plan" }, [
      step({ id: "s1", title: "Pending", status: "pending", stepOrder: 0 }),
      step({ id: "s2", title: "Active", status: "in_progress", stepOrder: 1 }),
      step({ id: "s3", title: "Done", status: "completed", stepOrder: 2 }),
      step({ id: "s4", title: "Stuck", status: "blocked", stepOrder: 3 }),
      step({ id: "s5", title: "Skip", status: "skipped", stepOrder: 4 }),
    ]);
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /expand.*Statuses plan/i }));
    const stepsList = screen.getByTestId("plan-steps-plan-all");
    expect(within(stepsList).getByTestId("step-status-pending")).toBeInTheDocument();
    expect(within(stepsList).getByTestId("step-status-in_progress")).toBeInTheDocument();
    expect(within(stepsList).getByTestId("step-status-completed")).toBeInTheDocument();
    expect(within(stepsList).getByTestId("step-status-blocked")).toBeInTheDocument();
    expect(within(stepsList).getByTestId("step-status-skipped")).toBeInTheDocument();
  });

  it("advancing a gate step calls advancePlanGate", () => {
    const mutate = vi.fn();
    mocks.useAdvancePlanGate.mockReturnValue(mutationResult({ mutate }));
    const plan = planWithSteps({ id: "plan-g", title: "Gate plan" }, [
      step({
        id: "gate-1",
        planId: "plan-g",
        title: "Review gate",
        stepType: "review_gate",
        status: "pending",
        stepOrder: 0,
      }),
    ]);
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /expand.*Gate plan/i }));
    fireEvent.click(screen.getByRole("button", { name: /advance gate/i }));
    expect(mutate).toHaveBeenCalledWith({ planId: "plan-g", stepId: "gate-1" });
  });

  it("gate steps show approval status after advancement", () => {
    const plan = planWithSteps({ id: "plan-g2", title: "Advanced plan" }, [
      step({
        id: "gate-2",
        planId: "plan-g2",
        title: "Permission gate",
        stepType: "permission_gate",
        status: "in_progress",
        gateApprovalId: "approval-9",
        gateConfig: { requiredRole: "admin" },
        stepOrder: 0,
      }),
    ]);
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /expand.*Advanced plan/i }));
    expect(screen.getByText(/approval-9/)).toBeInTheDocument();
    expect(screen.getByText(/in progress/i)).toBeInTheDocument();
  });

  it("gate config is displayed on gate steps", () => {
    const plan = planWithSteps({ id: "plan-gc", title: "Config plan" }, [
      step({
        id: "gate-c",
        planId: "plan-gc",
        title: "Review gate",
        stepType: "review_gate",
        status: "pending",
        gateConfig: { requiredRole: "reviewer", description: "Needs senior review" },
        stepOrder: 0,
      }),
    ]);
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /expand.*Config plan/i }));
    expect(screen.getByText(/reviewer/i)).toBeInTheDocument();
    expect(screen.getByText(/Needs senior review/i)).toBeInTheDocument();
  });

  it("steps can be reordered via up/down buttons", () => {
    const mutate = vi.fn();
    mocks.useUpdatePlanStep.mockReturnValue(mutationResult({ mutate }));
    const plan = planWithSteps({ id: "plan-r", title: "Reorder plan" }, [
      step({ id: "r-1", planId: "plan-r", title: "First", stepOrder: 0, status: "pending" }),
      step({ id: "r-2", planId: "plan-r", title: "Second", stepOrder: 1, status: "pending" }),
    ]);
    mocks.usePlansWithSteps.mockReturnValue({ data: [plan], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /expand.*Reorder plan/i }));
    // Move the second step up
    fireEvent.click(screen.getByTestId("step-up-r-2"));
    expect(mutate).toHaveBeenCalledWith({ planId: "plan-r", stepId: "r-2", data: { stepOrder: 0 } });
    // Move the first step down
    fireEvent.click(screen.getByTestId("step-down-r-1"));
    expect(mutate).toHaveBeenCalledWith({ planId: "plan-r", stepId: "r-1", data: { stepOrder: 1 } });
  });

  it("shows an empty state when there are no plans", () => {
    mocks.usePlansWithSteps.mockReturnValue({ data: [], isLoading: false, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/no plans yet/i)).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    mocks.usePlansWithSteps.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an error state", () => {
    mocks.usePlansWithSteps.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<ProjectPlansPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });
});
