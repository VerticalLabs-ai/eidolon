import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PendingDecisionsCard } from "../src/components/projects/PendingDecisionsCard";
import { ProjectDecisionsPanel } from "../src/components/projects/ProjectDecisionsPanel";

const mocks = vi.hoisted(() => ({
  useProjectDecisions: vi.fn(),
  useUpdateProjectDecision: vi.fn(),
}));

vi.mock("@/lib/hooks", () => mocks);

const decision = {
  id: "decision-1",
  companyId: "company-1",
  projectId: "project-1",
  title: "Use the new API",
  description: "Adopt the new API for this release.",
  status: "pending" as const,
  decidedByUserId: null,
  decidedAt: null,
  rationale: null,
  planId: null,
  planStepId: null,
  supersededById: null,
  createdByUserId: null,
  createdByAgentId: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

describe("Project decisions UI — VAL-DEC-005, VAL-DEC-007, VAL-DEC-009", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectDecisions.mockReturnValue({ data: [], isLoading: false, isError: false });
    mocks.useUpdateProjectDecision.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it("renders pending decisions and approve/reject actions", () => {
    mocks.useProjectDecisions.mockReturnValue({ data: [decision], isLoading: false, isError: false });
    render(<PendingDecisionsCard companyId="company-1" projectId="project-1" />);
    expect(screen.getByText("Use the new API")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("approves with optional rationale", () => {
    const mutate = vi.fn();
    mocks.useProjectDecisions.mockReturnValue({ data: [decision], isLoading: false, isError: false });
    mocks.useUpdateProjectDecision.mockReturnValue({ mutate, isPending: false });
    render(<PendingDecisionsCard companyId="company-1" projectId="project-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.change(screen.getByLabelText("Optional rationale"), { target: { value: "Good tradeoff" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));
    expect(mutate).toHaveBeenCalledWith({
      decisionId: "decision-1",
      data: { status: "approved", rationale: "Good tradeoff" },
    });
  });

  it("shows empty states and supports status filtering in Work", () => {
    render(<PendingDecisionsCard companyId="company-1" projectId="project-1" />);
    expect(screen.getByText("No pending decisions")).toBeInTheDocument();
    render(<ProjectDecisionsPanel companyId="company-1" projectId="project-1" />);
    fireEvent.click(screen.getByTestId("decision-filter-approved"));
    expect(mocks.useProjectDecisions).toHaveBeenLastCalledWith("company-1", "project-1", { status: "approved" });
  });
});
