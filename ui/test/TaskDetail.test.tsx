import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskDetail } from "../src/pages/TaskDetail";

const mocks = vi.hoisted(() => ({
  useTask: vi.fn(),
  useTasks: vi.fn(),
  useTaskThread: vi.fn(),
  updateTaskMutate: vi.fn(),
  addCommentMutate: vi.fn(),
  respondInteractionMutate: vi.fn(),
  subtreeMutate: vi.fn(),
  decideApprovalMutate: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useTask: mocks.useTask,
  useTasks: mocks.useTasks,
  useTaskThread: mocks.useTaskThread,
  useUpdateTask: () => ({
    mutate: mocks.updateTaskMutate,
    isPending: false,
  }),
  useAddTaskComment: () => ({
    mutate: mocks.addCommentMutate,
    isPending: false,
  }),
  useRespondTaskInteraction: () => ({
    mutate: mocks.respondInteractionMutate,
    isPending: false,
  }),
  useTaskSubtreeControls: () => ({
    mutate: mocks.subtreeMutate,
    isPending: false,
  }),
  useDecideApproval: () => ({
    mutate: mocks.decideApprovalMutate,
    isPending: false,
  }),
}));

const task = {
  id: "task-1",
  companyId: "company-1",
  projectId: null,
  goalId: null,
  parentId: null,
  title: "Investigate stalled workflow",
  description: "Agent stopped reporting progress.",
  type: "bug",
  status: "in_progress",
  priority: "high",
  assigneeAgentId: "agent-1",
  createdByAgentId: null,
  createdByUserId: null,
  taskNumber: 12,
  identifier: "TASK-12",
  dependencies: ["dependency-1"],
  estimatedTokens: null,
  actualTokens: null,
  tags: [],
  dueAt: null,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-04-27T12:00:00.000Z",
  updatedAt: "2026-04-27T12:05:00.000Z",
};

function renderTaskDetail() {
  return render(
    <MemoryRouter initialEntries={["/company/company-1/issues/task-1"]}>
      <Routes>
        <Route path="/company/:companyId/issues/:taskId" element={<TaskDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TaskDetail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useTask.mockReturnValue({ data: task, isLoading: false });
    mocks.useTasks.mockReturnValue({ data: [] });
    mocks.useTaskThread.mockReturnValue({ data: [] });
  });

  it("renders loading skeleton when task is loading", () => {
    mocks.useTask.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = renderTaskDetail();

    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
  });

  it("renders not found message when task is missing", () => {
    mocks.useTask.mockReturnValue({ data: null, isLoading: false });
    renderTaskDetail();

    expect(screen.getByText("Task not found")).toBeInTheDocument();
  });

  it("renders canonical statuses and sends status/subtree actions", async () => {
    const user = userEvent.setup();
    renderTaskDetail();

    expect(screen.getByRole("heading", { name: task.title })).toBeInTheDocument();
    expect(screen.getAllByText("In Progress").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("link", { name: /dependen/ })).toHaveAttribute(
      "href",
      "/company/company-1/issues/dependency-1",
    );

    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(mocks.updateTaskMutate).toHaveBeenCalledWith({
      taskId: "task-1",
      data: { status: "review" },
    });

	await user.click(screen.getByRole("button", { name: "Pause subtree" }));
	expect(mocks.subtreeMutate).toHaveBeenCalledWith(
		{
			taskId: "task-1",
			action: "pause",
			reason: "Paused from task detail",
		},
		expect.objectContaining({ onSuccess: expect.any(Function) }),
	);

	await user.click(screen.getByRole("button", { name: "Restore" }));
	expect(mocks.subtreeMutate).toHaveBeenCalledWith(
		{
			taskId: "task-1",
			action: "restore",
		},
		expect.objectContaining({ onSuccess: expect.any(Function) }),
	);

	await user.click(screen.getByRole("button", { name: "Cancel subtree" }));
	expect(mocks.subtreeMutate).toHaveBeenCalledWith(
		{
			taskId: "task-1",
			action: "cancel",
			reason: "Cancelled from task detail",
		},
		expect.objectContaining({ onSuccess: expect.any(Function) }),
	);
  });

  it("handles inline approval, interaction, execution, and comment flows", async () => {
    const user = userEvent.setup();
    mocks.useTaskThread.mockReturnValue({
      data: [
        {
          id: "approval-thread-1",
          companyId: "company-1",
          taskId: "task-1",
          kind: "approval_link",
          content: "Approve retry plan",
          payload: {},
          status: "pending",
          relatedApprovalId: "approval-1",
          createdAt: "2026-04-27T12:01:00.000Z",
          updatedAt: "2026-04-27T12:01:00.000Z",
        },
        {
          id: "execution:execution-1",
          companyId: "company-1",
          taskId: "task-1",
          kind: "execution_event",
          content: "Execution appears stalled",
          payload: { livenessStatus: "recovering", nextActionHint: "review_recovery_task" },
          status: "running",
          relatedExecutionId: "execution-1",
          createdAt: "2026-04-27T12:02:00.000Z",
          updatedAt: "2026-04-27T12:02:00.000Z",
        },
        {
          id: "interaction-1",
          companyId: "company-1",
          taskId: "task-1",
          kind: "interaction",
          interactionType: "confirmation",
          content: "Continue from checkpoint?",
          payload: {},
          status: "pending",
          createdAt: "2026-04-27T12:03:00.000Z",
          updatedAt: "2026-04-27T12:03:00.000Z",
        },
      ],
    });

    renderTaskDetail();

    expect(screen.getByText("Approve retry plan")).toBeInTheDocument();
    expect(screen.getByText("Execution appears stalled")).toBeInTheDocument();
    expect(screen.getByText(/Liveness: recovering/)).toBeInTheDocument();
    expect(screen.getByText("Continue from checkpoint?")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(mocks.decideApprovalMutate).toHaveBeenCalledWith({
      id: "approval-1",
      decision: "approved",
      resolutionNote: "Approved from task thread",
    });

    await user.click(screen.getByRole("button", { name: "Accept" }));
    expect(mocks.respondInteractionMutate).toHaveBeenCalledWith(
      {
        taskId: "task-1",
        interactionId: "interaction-1",
        action: "accept",
        note: "Accepted from task thread",
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );

    await user.type(screen.getByLabelText("Comment"), "Restart with smaller batch.");
    await user.click(screen.getByRole("button", { name: "Add comment" }));

    expect(mocks.addCommentMutate).toHaveBeenCalledWith(
      { taskId: "task-1", content: "Restart with smaller batch." },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
