import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GoalFormModal } from "../src/components/goals/GoalFormModal";
import type { Agent, Goal } from "../src/lib/api";

const mocks = vi.hoisted(() => ({
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  createPending: false,
  updatePending: false,
}));

vi.mock("@/lib/hooks", () => ({
  useCreateGoal: () => ({ mutate: mocks.createGoal, isPending: mocks.createPending }),
  useUpdateGoal: () => ({ mutate: mocks.updateGoal, isPending: mocks.updatePending }),
}));

const rootGoal: Goal = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "company-1",
  title: "Ship the operator workflow",
  description: "Make goal management durable.",
  level: "company",
  status: "active",
  parentId: null,
  ownerAgentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  progress: 20,
  targetDate: null,
  metrics: {},
  createdAt: "2026-07-30T22:00:00.000Z",
  updatedAt: "2026-07-30T22:00:00.000Z",
};

const childGoal: Goal = {
  ...rootGoal,
  id: "22222222-2222-4222-8222-222222222222",
  title: "Verify progress updates",
  level: "team",
  status: "draft",
  parentId: rootGoal.id,
  progress: 0,
};

const descendantGoal: Goal = {
  ...rootGoal,
  id: "33333333-3333-4333-8333-333333333333",
  title: "Publish progress evidence",
  level: "individual",
  parentId: childGoal.id,
};

const owner: Agent = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  companyId: "company-1",
  name: "Goal Owner",
  role: "ceo",
  title: null,
  provider: "anthropic",
  model: "claude-opus-4-7",
  reportsTo: null,
  capabilities: [],
  systemPrompt: null,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  lastHeartbeatAt: null,
  status: "idle",
  config: {},
  metadata: {},
  createdAt: "2026-07-30T22:00:00.000Z",
  updatedAt: "2026-07-30T22:00:00.000Z",
};

describe("GoalFormModal", () => {
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPending = false;
    mocks.updatePending = false;
  });

  it("creates a nested goal with hierarchy, owner, status, and progress", async () => {
    const user = userEvent.setup();
    render(
      <GoalFormModal
        agents={[owner]}
        companyId="company-1"
        defaultParentId={rootGoal.id}
        goals={[rootGoal]}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Title"), "Verify durable progress updates");
    await user.type(screen.getByLabelText("Description"), "Persist the operator state.");
    await user.selectOptions(screen.getByLabelText("Status"), "active");
    await user.selectOptions(screen.getByLabelText("Owner"), owner.id);
    await user.clear(screen.getByLabelText("Progress (%)"));
    await user.type(screen.getByLabelText("Progress (%)"), "35");
    await user.click(screen.getByRole("button", { name: "Create Goal" }));

    expect(mocks.createGoal).toHaveBeenCalledWith(
      {
        title: "Verify durable progress updates",
        description: "Persist the operator state.",
        level: "department",
        status: "active",
        parentId: rootGoal.id,
        ownerAgentId: owner.id,
        progress: 35,
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("edits a goal and excludes itself and descendants from parent choices", async () => {
    const user = userEvent.setup();
    render(
      <GoalFormModal
        agents={[owner]}
        companyId="company-1"
        goal={childGoal}
        goals={[rootGoal, childGoal, descendantGoal]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("option", { name: rootGoal.title })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: childGoal.title })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: descendantGoal.title })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "Verified progress updates");
    await user.selectOptions(screen.getByLabelText("Status"), "completed");
    await user.clear(screen.getByLabelText("Progress (%)"));
    await user.type(screen.getByLabelText("Progress (%)"), "100");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(mocks.updateGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        goalId: childGoal.id,
        data: expect.objectContaining({
          title: "Verified progress updates",
          status: "completed",
          progress: 100,
        }),
      }),
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("announces invalid progress without submitting", async () => {
    const user = userEvent.setup();
    render(
      <GoalFormModal
        agents={[owner]}
        companyId="company-1"
        goals={[]}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Title"), "Invalid progress");
    await user.clear(screen.getByLabelText("Progress (%)"));
    await user.type(screen.getByLabelText("Progress (%)"), "101");
    await user.click(screen.getByRole("button", { name: "Create Goal" }));

    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent("100");
    expect(screen.getByLabelText("Progress (%)")).toHaveAttribute("aria-describedby", error.id);
    expect(mocks.createGoal).not.toHaveBeenCalled();
  });

  it("rejects blank progress instead of coercing it to zero", async () => {
    const user = userEvent.setup();
    render(
      <GoalFormModal
        agents={[owner]}
        companyId="company-1"
        goals={[]}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Title"), "Progress is required");
    await user.clear(screen.getByLabelText("Progress (%)"));
    await user.click(screen.getByRole("button", { name: "Create Goal" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Enter progress from 0 to 100");
    expect(mocks.createGoal).not.toHaveBeenCalled();
  });

  it("requires a parent above the selected goal level", async () => {
    const user = userEvent.setup();
    render(
      <GoalFormModal
        agents={[owner]}
        companyId="company-1"
        defaultParentId={rootGoal.id}
        goals={[rootGoal]}
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Title"), "Invalid hierarchy");
    await user.selectOptions(screen.getByLabelText("Level"), "company");
    expect(screen.queryByRole("option", { name: rootGoal.title })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create Goal" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Choose a parent above");
    expect(mocks.createGoal).not.toHaveBeenCalled();
  });

  it("preserves entries and shows a visible API failure", async () => {
    const user = userEvent.setup();
    render(
      <GoalFormModal
        agents={[owner]}
        companyId="company-1"
        goals={[]}
        onClose={vi.fn()}
      />,
    );

    const title = screen.getByLabelText("Title");
    await user.type(title, "Durable operator goal");
    await user.click(screen.getByRole("button", { name: "Create Goal" }));
    const callbacks = mocks.createGoal.mock.calls[0][1];
    callbacks.onError(new Error("Database unavailable"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(title).toHaveValue("Durable operator goal");
  });

  it("preserves the visible current owner when the directory is unavailable", () => {
    render(
      <GoalFormModal
        agents={[]}
        companyId="company-1"
        goal={rootGoal}
        goals={[rootGoal]}
        onClose={vi.fn()}
        ownerDataState="error"
      />,
    );

    expect(screen.getByLabelText("Owner")).toBeDisabled();
    expect(screen.getByLabelText("Owner")).toHaveValue(rootGoal.ownerAgentId);
    expect(screen.getByRole("option", { name: "Current owner (unavailable)" })).toBeInTheDocument();
    expect(screen.getByText(/Owner changes are unavailable/)).toBeInTheDocument();
  });
});
