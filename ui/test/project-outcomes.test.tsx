import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectOutcomesPanel } from "../src/components/projects/ProjectOutcomesPanel";

const mocks = vi.hoisted(() => ({
  useProjectOutcomes: vi.fn(),
  useCreateProjectOutcome: vi.fn(),
  useUpdateProjectOutcome: vi.fn(),
}));

vi.mock("@/lib/hooks", () => mocks);

const outcome = {
  id: "outcome-1",
  companyId: "company-1",
  projectId: "project-1",
  type: "pull_request" as const,
  title: "Merge feature branch",
  description: "PR that adds the new outcomes panel.",
  status: "pending" as const,
  referenceUrl: "https://github.com/example/repo/pull/42",
  referenceId: null,
  taskId: null,
  planId: "plan-1",
  planStepId: null,
  metadata: {} as Record<string, unknown>,
  createdByUserId: "user-1",
  createdByAgentId: null,
  completedAt: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

function mutationResult(
  overrides: Partial<{ mutate: ReturnType<typeof vi.fn>; isPending: boolean }> = {},
) {
  return { mutate: vi.fn(), isPending: false, ...overrides };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe("ProjectOutcomesPanel — VAL-OUT-004, VAL-OUT-005, VAL-OUT-008, VAL-OUT-009", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    }) as unknown as typeof HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    }) as unknown as typeof HTMLDialogElement.prototype.close;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectOutcomes.mockReturnValue({ data: [], isLoading: false, isError: false });
    mocks.useCreateProjectOutcome.mockReturnValue(mutationResult());
    mocks.useUpdateProjectOutcome.mockReturnValue(mutationResult());
  });

  // VAL-OUT-009: Work tab renders ProjectOutcomesPanel with type filtering
  it("renders the outcomes panel with type filter controls for all 5 types + all", () => {
    mocks.useProjectOutcomes.mockReturnValue({ data: [outcome], isLoading: false, isError: false });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("project-outcomes-panel")).toBeInTheDocument();
    // Type filter controls: all + 5 types
    expect(screen.getByTestId("outcome-filter-all")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-filter-document")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-filter-pull_request")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-filter-audit")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-filter-review")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-filter-delivery_summary")).toBeInTheDocument();
  });

  it("applies type filter when a filter button is clicked", () => {
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByTestId("outcome-filter-document"));
    expect(mocks.useProjectOutcomes).toHaveBeenLastCalledWith(
      "company-1",
      "project-1",
      { type: "document" },
    );
  });

  it("clears the type filter when 'all' is clicked", () => {
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByTestId("outcome-filter-audit"));
    fireEvent.click(screen.getByTestId("outcome-filter-all"));
    expect(mocks.useProjectOutcomes).toHaveBeenLastCalledWith(
      "company-1",
      "project-1",
      undefined,
    );
  });

  // VAL-OUT-009: Each outcome shows type-specific icon, title, status badge, reference link
  it("renders each outcome with title, status badge, and reference link", () => {
    mocks.useProjectOutcomes.mockReturnValue({ data: [outcome], isLoading: false, isError: false });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText("Merge feature branch")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-status-pending")).toBeInTheDocument();
    const link = screen.getByTestId("outcome-reference-outcome-1");
    expect(link).toHaveAttribute("href", "https://github.com/example/repo/pull/42");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("does not render a reference link when referenceUrl is null", () => {
    mocks.useProjectOutcomes.mockReturnValue({
      data: [{ ...outcome, referenceUrl: null }],
      isLoading: false,
      isError: false,
    });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByTestId("outcome-reference-outcome-1")).not.toBeInTheDocument();
  });

  // VAL-OUT-005: Outcomes linked to task/plan show context
  it("shows context for outcomes linked to a plan", () => {
    mocks.useProjectOutcomes.mockReturnValue({ data: [outcome], isLoading: false, isError: false });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("outcome-context-outcome-1")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-context-outcome-1")).toHaveTextContent(/plan-1/i);
  });

  it("shows context for outcomes linked to a task", () => {
    mocks.useProjectOutcomes.mockReturnValue({
      data: [{ ...outcome, planId: null, taskId: "task-9" }],
      isLoading: false,
      isError: false,
    });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("outcome-context-outcome-1")).toHaveTextContent(/task-9/i);
  });

  // VAL-OUT-009: Creating an outcome via UI sends POST /outcomes
  it("creates an outcome via the modal form", () => {
    const mutate = vi.fn();
    mocks.useCreateProjectOutcome.mockReturnValue(mutationResult({ mutate }));
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /create outcome/i }));
    // Modal opens
    const titleInput = screen.getByTestId("outcome-title-input");
    fireEvent.change(titleInput, { target: { value: "Design doc" } });
    // Select type (default is document, but let's pick audit)
    fireEvent.change(screen.getByTestId("outcome-type-select"), { target: { value: "audit" } });
    fireEvent.change(screen.getByTestId("outcome-reference-url-input"), {
      target: { value: "https://docs.example.com/audit" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save outcome/i }));
    expect(mutate).toHaveBeenCalledWith(
      {
        type: "audit",
        title: "Design doc",
        referenceUrl: "https://docs.example.com/audit",
      },
      { onSuccess: expect.any(Function) },
    );
  });

  it("closes and resets the create modal only after a successful mutation", async () => {
    const mutate = vi.fn((_data, options: { onSuccess: () => void }) => options.onSuccess());
    mocks.useCreateProjectOutcome.mockReturnValue(mutationResult({ mutate }));
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /create outcome/i }));
    fireEvent.change(screen.getByTestId("outcome-title-input"), { target: { value: "Design doc" } });
    fireEvent.click(screen.getByRole("button", { name: /save outcome/i }));
    await waitFor(() => expect(screen.queryByTestId("outcome-title-input")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /create outcome/i }));
    expect(screen.getByTestId("outcome-title-input")).toHaveValue("");
  });

  it("preserves create form state when the mutation fails", () => {
    const mutate = vi.fn();
    mocks.useCreateProjectOutcome.mockReturnValue(mutationResult({ mutate }));
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /create outcome/i }));
    fireEvent.change(screen.getByTestId("outcome-title-input"), { target: { value: "Keep this" } });
    fireEvent.click(screen.getByRole("button", { name: /save outcome/i }));
    expect(screen.getByTestId("outcome-title-input")).toHaveValue("Keep this");
  });

  it("blocks creating an outcome with an empty title", () => {
    const mutate = vi.fn();
    mocks.useCreateProjectOutcome.mockReturnValue(mutationResult({ mutate }));
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: /create outcome/i }));
    const submit = screen.getByRole("button", { name: /save outcome/i });
    expect(submit).toBeDisabled();
  });

  // VAL-OUT-009 / VAL-OUT-004: Updating outcome status via UI sends PATCH
  it("updates outcome status to completed via the UI", () => {
    const mutate = vi.fn();
    mocks.useProjectOutcomes.mockReturnValue({ data: [outcome], isLoading: false, isError: false });
    mocks.useUpdateProjectOutcome.mockReturnValue(mutationResult({ mutate }));
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    // Open the status menu and select completed
    fireEvent.click(screen.getByTestId("outcome-status-action-outcome-1"));
    fireEvent.click(screen.getByTestId("outcome-status-completed-outcome-1"));
    expect(mutate).toHaveBeenCalledWith({
      outcomeId: "outcome-1",
      data: { status: "completed" },
    });
  });

  it("updates outcome status to failed via the UI", () => {
    const mutate = vi.fn();
    mocks.useProjectOutcomes.mockReturnValue({ data: [outcome], isLoading: false, isError: false });
    mocks.useUpdateProjectOutcome.mockReturnValue(mutationResult({ mutate }));
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByTestId("outcome-status-action-outcome-1"));
    fireEvent.click(screen.getByTestId("outcome-status-failed-outcome-1"));
    expect(mutate).toHaveBeenCalledWith({
      outcomeId: "outcome-1",
      data: { status: "failed" },
    });
  });

  // VAL-OUT-008: Empty state for project with no outcomes
  it("shows an empty state when there are no outcomes", () => {
    mocks.useProjectOutcomes.mockReturnValue({ data: [], isLoading: false, isError: false });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/no outcomes yet/i)).toBeInTheDocument();
  });

  it("shows an empty state for an empty API response envelope", () => {
    mocks.useProjectOutcomes.mockReturnValue({
      data: { data: [] },
      isLoading: false,
      isError: false,
    });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/no outcomes yet/i)).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    mocks.useProjectOutcomes.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an error state", () => {
    mocks.useProjectOutcomes.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });

  // Type-specific icons render for each type
  it("renders a type-specific icon for each outcome type", () => {
    const outcomes = [
      { ...outcome, id: "o-doc", type: "document" as const },
      { ...outcome, id: "o-pr", type: "pull_request" as const },
      { ...outcome, id: "o-audit", type: "audit" as const },
      { ...outcome, id: "o-review", type: "review" as const },
      { ...outcome, id: "o-deliv", type: "delivery_summary" as const },
    ];
    mocks.useProjectOutcomes.mockReturnValue({ data: outcomes, isLoading: false, isError: false });
    render(<ProjectOutcomesPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("outcome-type-icon-document")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-type-icon-pull_request")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-type-icon-audit")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-type-icon-review")).toBeInTheDocument();
    expect(screen.getByTestId("outcome-type-icon-delivery_summary")).toBeInTheDocument();
  });
});
