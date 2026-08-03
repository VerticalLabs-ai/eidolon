import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectHome } from "../src/pages/ProjectHome";

const mocks = vi.hoisted(() => ({
  useProjectHome: vi.fn(),
  useGoals: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useProjectHome: mocks.useProjectHome,
  useGoals: mocks.useGoals,
}));

const baseSummary = {
  project: {
    id: "project-1",
    name: "Runtime Reliability",
    description: "Make agent execution durable.",
    status: "active",
    repoUrl: "https://github.com/example/repo",
    createdAt: "2026-07-30T22:00:00.000Z",
    updatedAt: "2026-07-30T22:00:00.000Z",
  },
  counts: { taskCount: 12, goalCount: 3, agentCount: 2, fileCount: 5 },
  taskStatusBreakdown: {
    backlog: 3, todo: 4, in_progress: 2, review: 1, done: 1, cancelled: 0, timed_out: 1,
  },
  activeWork: [
    { id: "task-1", title: "Fix race condition", status: "in_progress", identifier: "EID-1", projectId: "project-1" },
  ],
  needsAttention: [
    { id: "task-2", title: "Review timeout handler", status: "review", identifier: "EID-2", projectId: "project-1" },
  ],
  failedWork: [
    { id: "exec-1", companyId: "company-1", agentId: "agent-1", taskId: "task-1", status: "failed", summary: "Crashed", error: "OOM", startedAt: "2026-07-31T00:00:00.000Z", completedAt: "2026-07-31T01:00:00.000Z", createdAt: "2026-07-31T00:00:00.000Z", updatedAt: "2026-07-31T01:00:00.000Z" },
  ],
  recentActivity: [
    { id: "act-1", companyId: "company-1", actorType: "system", actorId: null, action: "task.created", entityType: "task", entityId: "task-1", description: "Task created: Fix race condition", metadata: {}, createdAt: "2026-07-31T12:00:00.000Z" },
  ],
  recentFiles: [
    { id: "file-1", companyId: "company-1", agentId: null, name: "report.md", path: "/report.md", mimeType: "text/markdown", sizeBytes: 1024, content: null, storageType: "db", parentId: null, isDirectory: false, taskId: null, executionId: null, projectId: "project-1", createdAt: "2026-07-31T10:00:00.000Z", updatedAt: "2026-07-31T10:00:00.00.000Z" },
  ],
  goalProgress: { count: 3, aggregateProgress: 65 },
};

function renderHome() {
  return render(
    <MemoryRouter>
      <ProjectHome companyId="company-1" projectId="project-1" />
    </MemoryRouter>,
  );
}

describe("ProjectHome", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default mock for useGoals — returns a small project-scoped goal set
    mocks.useGoals.mockReturnValue({
      data: [
        { id: "goal-1", title: "Reliability OKR", level: "company", status: "active", parentId: null, progress: 50, projectId: "project-1" },
        { id: "goal-2", title: "Sub-goal", level: "department", status: "active", parentId: "goal-1", progress: 80, projectId: "project-1" },
      ],
      isLoading: false,
      isError: false,
    });
  });

  // VAL-HOMEUI-023: renders cards from a mock home summary
  it("renders all cards with populated data", () => {
    mocks.useProjectHome.mockReturnValue({
      data: baseSummary,
      isLoading: false,
      isError: false,
    });
    renderHome();

    // Header card
    expect(screen.getByText("Runtime Reliability")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("Make agent execution durable.")).toBeInTheDocument();

    // Repo link present (VAL-HOMEUI-026: non-null repoUrl)
    const repoLink = screen.getByTestId("repo-link");
    expect(repoLink).toHaveAttribute("href", "https://github.com/example/repo");
    expect(repoLink).toHaveAttribute("target", "_blank");

    // Counts card — verify within the Counts section
    const countsSection = screen.getByLabelText("Counts");
    expect(countsSection).toBeInTheDocument();
    expect(countsSection).toHaveTextContent("12"); // taskCount
    expect(countsSection).toHaveTextContent("5");  // fileCount

    // Active work card
    expect(screen.getByText("Fix race condition")).toBeInTheDocument();

    // Needs attention card
    expect(screen.getByText("Review timeout handler")).toBeInTheDocument();

    // Goals summary card
    expect(screen.getByText("65%")).toBeInTheDocument();
    expect(screen.getByTestId("compact-goal-tree")).toBeInTheDocument();

    // Recent activity card
    expect(screen.getByText("Task created: Fix race condition")).toBeInTheDocument();

    // Recent files card
    expect(screen.getByText("report.md")).toBeInTheDocument();
  });

  // VAL-HOMEUI-026: repo link absent when repoUrl is null
  it("does not render a repo link when repoUrl is null", () => {
    mocks.useProjectHome.mockReturnValue({
      data: { ...baseSummary, project: { ...baseSummary.project, repoUrl: null } },
      isLoading: false,
      isError: false,
    });
    renderHome();

    expect(screen.queryByTestId("repo-link")).not.toBeInTheDocument();
  });

  // VAL-HOMEUI-026: repo link present when repoUrl is non-null
  it("renders a repo link when repoUrl is a valid HTTP URL", () => {
    mocks.useProjectHome.mockReturnValue({
      data: baseSummary,
      isLoading: false,
      isError: false,
    });
    renderHome();

    const link = screen.getByTestId("repo-link");
    expect(link).toHaveAttribute("href", "https://github.com/example/repo");
  });

  // VAL-HOMEUI-024: renders empty states from a zeroed summary
  it("renders empty states for all list cards when data is empty", () => {
    const emptySummary = {
      ...baseSummary,
      activeWork: [],
      needsAttention: [],
      failedWork: [],
      recentActivity: [],
      recentFiles: [],
      goalProgress: { count: 0, aggregateProgress: 0 },
      counts: { taskCount: 0, goalCount: 0, agentCount: 0, fileCount: 0 },
    };
    mocks.useProjectHome.mockReturnValue({
      data: emptySummary,
      isLoading: false,
      isError: false,
    });
    renderHome();

    expect(screen.getByText("No active work")).toBeInTheDocument();
    expect(screen.getByText("Nothing needs attention")).toBeInTheDocument();
    expect(screen.getByText("No goals yet")).toBeInTheDocument();
    expect(screen.getByText("No recent activity")).toBeInTheDocument();
    expect(screen.getByText("No recent files")).toBeInTheDocument();
    expect(screen.queryByTestId("compact-goal-tree")).not.toBeInTheDocument();
  });

  // VAL-HOMEUI-019: loading state shows indicators
  it("shows a loading indicator while data fetches", () => {
    mocks.useProjectHome.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    renderHome();

    expect(screen.getByRole("status", { name: "Loading project home" })).toBeInTheDocument();
  });

  // VAL-HOMEUI-025: error state shows message on fetch failure
  it("renders an error message when the home fetch fails", () => {
    mocks.useProjectHome.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mocks.refetch,
    });
    renderHome();

    expect(screen.getByText("Home could not be loaded")).toBeInTheDocument();
  });
});
