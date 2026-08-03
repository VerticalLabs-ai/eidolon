import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectActivity } from "../src/components/projects/ProjectActivity";

const mocks = vi.hoisted(() => ({
  useProjectActivity: vi.fn(),
  useProjectHome: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useProjectActivity: mocks.useProjectActivity,
  useProjectHome: mocks.useProjectHome,
}));

const emptyHome = {
  project: {
    id: "project-1",
    name: "Test Project",
    description: null,
    status: "active",
    repoUrl: null,
    createdAt: "2026-07-30T22:00:00.000Z",
    updatedAt: "2026-07-30T22:00:00.000Z",
  },
  counts: { taskCount: 0, goalCount: 0, agentCount: 0, fileCount: 0 },
  taskStatusBreakdown: {
    backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0, cancelled: 0, timed_out: 0,
  },
  activeWork: [],
  needsAttention: [],
  failedWork: [],
  recentActivity: [],
  recentFiles: [],
  goalProgress: { count: 0, aggregateProgress: 0 },
};

const populatedHome = {
  ...emptyHome,
  counts: { taskCount: 5, goalCount: 0, agentCount: 1, fileCount: 0 },
  taskStatusBreakdown: {
    backlog: 0, todo: 0, in_progress: 2, review: 1, done: 0, cancelled: 0, timed_out: 1,
  },
  activeWork: [
    { id: "task-a", title: "Build API", status: "in_progress", identifier: "EID-1", projectId: "project-1" },
    { id: "task-b", title: "Review PR", status: "review", identifier: "EID-2", projectId: "project-1" },
  ],
  needsAttention: [
    { id: "task-b", title: "Review PR", status: "review", identifier: "EID-2", projectId: "project-1" },
    { id: "task-c", title: "Timed out task", status: "timed_out", identifier: "EID-3", projectId: "project-1" },
  ],
  failedWork: [
    { id: "exec-1", companyId: "company-1", agentId: "agent-1", taskId: "task-a", status: "failed", summary: "Crashed", error: "OOM", startedAt: "2026-07-31T00:00:00.000Z", completedAt: "2026-07-31T01:00:00.000Z", createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T01:00:00.000Z" },
  ],
};

function renderActivity() {
  return render(<ProjectActivity companyId="company-1" projectId="project-1" />);
}

describe("ProjectActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: home summary loaded with empty data
    mocks.useProjectHome.mockReturnValue({
      data: emptyHome,
      isLoading: false,
      isError: false,
    });
  });

  // ── Work-state header (VAL-ACTIVITY-001 through VAL-ACTIVITY-004) ──────

  // VAL-ACTIVITY-001: Activity shows work-state counts
  it("renders work-state header with active, needs-input, and failed counts", () => {
    mocks.useProjectHome.mockReturnValue({
      data: populatedHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: [], meta: { total: 0, limit: 20, offset: 0 } },
    });
    renderActivity();

    // Active count = activeWork.length = 2
    expect(screen.getByTestId("active-count")).toHaveTextContent("2");
    // Needs-input count = needsAttention.length = 2
    expect(screen.getByTestId("needs-input-count")).toHaveTextContent("2");
    // Failed count = failedWork.length = 1
    expect(screen.getByTestId("failed-count")).toHaveTextContent("1");
  });

  // VAL-ACTIVITY-008: work-state counts reflect scoped statuses with dedup
  it("deduplicates needs-input counts (task appearing in both review and pending)", () => {
    // Simulate a task that appears once in needsAttention (deduped server-side)
    const dedupedHome = {
      ...populatedHome,
      needsAttention: [
        { id: "task-b", title: "Review PR", status: "review", identifier: "EID-2", projectId: "project-1" },
      ],
    };
    mocks.useProjectHome.mockReturnValue({
      data: dedupedHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: [], meta: { total: 0, limit: 20, offset: 0 } },
    });
    renderActivity();

    // needs-input count reflects the deduped list (1 entry, not 2)
    expect(screen.getByTestId("needs-input-count")).toHaveTextContent("1");
  });

  // VAL-ACTIVITY-002: active work list expands
  it("expands the active work list and collapses on re-click", async () => {
    const user = userEvent.setup();
    mocks.useProjectHome.mockReturnValue({
      data: populatedHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: [], meta: { total: 0, limit: 20, offset: 0 } },
    });
    renderActivity();

    // Active work items not visible before expanding
    expect(screen.queryByText("Build API")).not.toBeInTheDocument();

    // Expand active work
    await user.click(screen.getByRole("button", { name: /active/i }));
    expect(screen.getByText("Build API")).toBeInTheDocument();
    expect(screen.getByText("Review PR")).toBeInTheDocument();

    // Collapse
    await user.click(screen.getByRole("button", { name: /active/i }));
    expect(screen.queryByText("Build API")).not.toBeInTheDocument();
  });

  // VAL-ACTIVITY-003: needs-input list expands
  it("expands the needs-input list", async () => {
    const user = userEvent.setup();
    mocks.useProjectHome.mockReturnValue({
      data: populatedHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: [], meta: { total: 0, limit: 20, offset: 0 } },
    });
    renderActivity();

    expect(screen.queryByText("Timed out task")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /needs.input/i }));
    expect(screen.getByText("Timed out task")).toBeInTheDocument();
  });

  // VAL-ACTIVITY-004: failed list expands
  it("expands the failed work list", async () => {
    const user = userEvent.setup();
    mocks.useProjectHome.mockReturnValue({
      data: populatedHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: [], meta: { total: 0, limit: 20, offset: 0 } },
    });
    renderActivity();

    expect(screen.queryByText("Crashed")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /failed/i }));
    expect(screen.getByText("Crashed")).toBeInTheDocument();
  });

  // VAL-ACTIVITY-012: work-state header renders independently of activity query
  it("renders work-state header counts even while activity is loading", () => {
    mocks.useProjectHome.mockReturnValue({
      data: populatedHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: true,
      isError: false,
    });
    renderActivity();

    // Work-state header is present with counts
    expect(screen.getByTestId("active-count")).toHaveTextContent("2");
    expect(screen.getByTestId("needs-input-count")).toHaveTextContent("2");
    expect(screen.getByTestId("failed-count")).toHaveTextContent("1");

    // Timeline loading indicator is also present
    expect(screen.getByRole("status", { name: "Loading activity" })).toBeInTheDocument();
  });

  // ── Event timeline (existing behavior preserved) ──────────────────────

  it("shows a loading state and a retryable error for the timeline", async () => {
    mocks.useProjectHome.mockReturnValue({
      data: emptyHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({ isLoading: true });
    const { rerender } = renderActivity();
    expect(screen.getByRole("status", { name: "Loading activity" })).toBeInTheDocument();

    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: true,
      refetch: mocks.refetch,
    });
    rerender(<ProjectActivity companyId="company-1" projectId="project-1" />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("shows the durable empty state for the timeline while header shows zero counts", () => {
    mocks.useProjectHome.mockReturnValue({
      data: emptyHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: [], meta: { total: 0, limit: 20, offset: 0 } },
    });
    renderActivity();

    // Empty timeline state
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    // Work-state header still shows zero counts
    expect(screen.getByTestId("active-count")).toHaveTextContent("0");
    expect(screen.getByTestId("needs-input-count")).toHaveTextContent("0");
    expect(screen.getByTestId("failed-count")).toHaveTextContent("0");
  });

  // VAL-ACTIVITY-009: renders summary and paginated events, page transition
  it("renders events and paginates with Next/Previous", async () => {
    mocks.useProjectHome.mockReturnValue({
      data: emptyHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        data: [{
          id: "activity-1",
          companyId: "company-1",
          actorType: "system",
          actorId: "system",
          action: "project.updated",
          entityType: "project",
          entityId: "project-1",
          description: "Project updated: Runtime reliability",
          metadata: { changes: ["name", "status"] },
          createdAt: "2026-07-31T18:00:00.000Z",
        }],
        meta: { total: 25, limit: 20, offset: 0 },
      },
    });
    renderActivity();

    expect(screen.getByText("Project updated")).toBeInTheDocument();
    expect(screen.getByText("Project updated: Runtime reliability")).toBeInTheDocument();
    expect(screen.getByText("1–20 of 25")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(mocks.useProjectActivity).toHaveBeenLastCalledWith("company-1", "project-1", 20, 20);
  });

  // VAL-ACTIVITY-005: event timeline remains below header
  it("renders the work-state header before the timeline", () => {
    mocks.useProjectHome.mockReturnValue({
      data: populatedHome,
      isLoading: false,
      isError: false,
    });
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        data: [{
          id: "activity-1",
          companyId: "company-1",
          actorType: "system",
          actorId: "system",
          action: "task.created",
          entityType: "task",
          entityId: "task-1",
          description: "Task created: Build API",
          metadata: {},
          createdAt: "2026-07-31T18:00:00.000Z",
        }],
        meta: { total: 1, limit: 20, offset: 0 },
      },
    });
    renderActivity();

    // Both header and timeline are present
    expect(screen.getByTestId("active-count")).toBeInTheDocument();
    expect(screen.getByText("Task created: Build API")).toBeInTheDocument();

    // Header appears before timeline in DOM order
    const header = screen.getByTestId("work-state-header");
    const timeline = screen.getByText("Task created: Build API");
    expect(header.compareDocumentPosition(timeline)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});
