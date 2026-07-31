import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoalTree } from "../src/pages/GoalTree";

const mocks = vi.hoisted(() => ({
  goals: [
    {
      id: "goal-root",
      companyId: "company-1",
      title: "Root goal",
      description: "Root description",
      level: "company" as const,
      status: "active" as const,
      parentId: null,
      ownerAgentId: null,
      progress: 20,
      targetDate: null,
      metrics: {},
      createdAt: "2026-07-30T22:00:00.000Z",
      updatedAt: "2026-07-30T22:00:00.000Z",
    },
  ],
  goalResult: { data: [] as unknown[], isLoading: false, isError: false, error: null as Error | null },
  agentResult: { data: [] as unknown[], isError: false, isLoading: false, error: null as Error | null },
}));

vi.mock("@/lib/hooks", () => ({
  useGoalTree: () => mocks.goalResult,
  useAgents: () => mocks.agentResult,
}));

vi.mock("@/components/goals/GoalFormModal", () => ({
  GoalFormModal: ({
    defaultParentId,
    goal,
    onClose,
  }: {
    defaultParentId?: string;
    goal?: { id: string };
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Goal editor">
      {goal ? `edit:${goal.id}` : defaultParentId ? `child:${defaultParentId}` : "create:root"}
      <button onClick={onClose}>Close editor</button>
    </div>
  ),
}));

describe("GoalTree controls", () => {
  beforeEach(() => {
    mocks.goalResult.data = mocks.goals;
    mocks.goalResult.isLoading = false;
    mocks.goalResult.isError = false;
    mocks.goalResult.error = null;
    mocks.agentResult.data = [];
    mocks.agentResult.isError = false;
    mocks.agentResult.isLoading = false;
    mocks.agentResult.error = null;
  });

  it("opens the shared editor for root, child, and edit workflows", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/company/company-1/goals"]}>
        <Routes>
          <Route path="/company/:companyId/goals" element={<GoalTree />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "New Goal" }));
    expect(screen.getByRole("dialog", { name: "Goal editor" })).toHaveTextContent("create:root");
    await user.click(screen.getByRole("button", { name: "Close editor" }));

    await user.click(screen.getByRole("button", { name: "Add child" }));
    expect(screen.getByRole("dialog", { name: "Goal editor" })).toHaveTextContent("child:goal-root");
    await user.click(screen.getByRole("button", { name: "Close editor" }));

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("dialog", { name: "Goal editor" })).toHaveTextContent("edit:goal-root");
  });

  it("shows goal query failures instead of an empty state", () => {
    mocks.goalResult.data = [];
    mocks.goalResult.isError = true;
    mocks.goalResult.error = new Error("Database unavailable");

    render(
      <MemoryRouter initialEntries={["/company/company-1/goals"]}>
        <Routes>
          <Route path="/company/:companyId/goals" element={<GoalTree />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Database unavailable");
    expect(screen.queryByText("No goals defined")).not.toBeInTheDocument();
  });

  it("does not mislabel assigned goals when owners fail to load", () => {
    mocks.goalResult.data = [{ ...mocks.goals[0], ownerAgentId: "agent-1" }];
    mocks.agentResult.isError = true;
    mocks.agentResult.error = new Error("Agent service unavailable");

    render(
      <MemoryRouter initialEntries={["/company/company-1/goals"]}>
        <Routes>
          <Route path="/company/:companyId/goals" element={<GoalTree />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Agent service unavailable");
    expect(screen.getByText("Owner unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Unassigned")).not.toBeInTheDocument();
  });

  it("labels assigned owners as loading while the directory loads", () => {
    mocks.goalResult.data = [{ ...mocks.goals[0], ownerAgentId: "agent-1" }];
    mocks.agentResult.isLoading = true;

    render(
      <MemoryRouter initialEntries={["/company/company-1/goals"]}>
        <Routes>
          <Route path="/company/:companyId/goals" element={<GoalTree />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Owner loading…")).toBeInTheDocument();
    expect(screen.queryByText("Unknown owner")).not.toBeInTheDocument();
  });
});
