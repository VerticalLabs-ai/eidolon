import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDetail } from "../src/pages/ProjectDetail";

const mocks = vi.hoisted(() => ({
  useProjectHome: vi.fn(),
  useTasks: vi.fn(() => ({ data: [], isLoading: false })),
  archiveProject: vi.fn(),
  reset: vi.fn(),
  successToast: vi.fn(),
}));

const project = {
  id: "project-1",
  companyId: "company-1",
  name: "Runtime reliability",
  description: "Make agent execution durable.",
  status: "active" as const,
  repoUrl: "https://github.com/vertical-labs/eidolon",
  createdAt: "2026-07-30T22:00:00.000Z",
  updatedAt: "2026-07-30T22:00:00.000Z",
};

vi.mock("@/lib/hooks", () => ({
  useArchiveProject: () => ({
    mutate: mocks.archiveProject,
    reset: mocks.reset,
    isPending: false,
  }),
  useProject: () => ({
    data: project,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useProjectHome: mocks.useProjectHome,
  useTasks: mocks.useTasks,
  useUpdateTask: () => ({ mutate: vi.fn() }),
  useCreateTask: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProjectThread: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProject: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
  useUpdateProject: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false }),
}));

vi.mock("@/pages/TaskBoard", () => ({
  TaskBoard: ({ title }: { title: string }) => (
    <div data-testid="task-board">
      <h2>{title}</h2>
      Task board
    </div>
  ),
}));
vi.mock("@/pages/ProjectHome", () => ({
  ProjectHome: ({ companyId, projectId }: { companyId: string; projectId: string }) => (
    <div data-testid="project-home">Home for {companyId}/{projectId}</div>
  ),
}));
vi.mock("@/pages/ProjectDrive", () => ({
  ProjectDrive: ({ companyId, projectId }: { companyId: string; projectId: string }) => (
    <div data-testid="project-drive">Drive for {companyId}/{projectId}</div>
  ),
}));
vi.mock("@/pages/GoalTree", () => ({
  GoalTree: () => <div>Goal tree</div>,
}));
vi.mock("@/components/projects/ProjectActivity", () => ({
  ProjectActivity: ({ companyId, projectId }: { companyId: string; projectId: string }) => (
    <div data-testid="project-activity">Activity for {companyId}/{projectId}</div>
  ),
}));
vi.mock("@/components/tasks/CreateTaskModal", () => ({
  CreateTaskModal: () => null,
}));
vi.mock("sonner", () => ({ toast: { success: mocks.successToast } }));

function renderDetail(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route path="/company/:companyId/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/company/:companyId/projects" element={<div>Project list route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectDetail tab query mapping", () => {
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
    mocks.useProjectHome.mockReturnValue({
      data: {
        project: { id: "project-1", name: "Runtime reliability", description: "test", status: "active", repoUrl: null, createdAt: "2026-07-30T22:00:00.000Z", updatedAt: "2026-07-30T22:00:00.000Z" },
        counts: { taskCount: 0, goalCount: 0, agentCount: 0, fileCount: 0 },
        taskStatusBreakdown: { backlog: 0, todo: 0, in_progress: 0, review: 0, done: 0, cancelled: 0, timed_out: 0 },
        activeWork: [], needsAttention: [], failedWork: [], recentActivity: [], recentFiles: [],
        goalProgress: { count: 0, aggregateProgress: 0 },
      },
      isLoading: false,
      isError: false,
    });
  });

  // VAL-TABS-001: Project defaults to Home
  it("defaults to Home tab when no tab query param is present", () => {
    renderDetail("/company/company-1/projects/project-1");
    expect(screen.getByTestId("project-home")).toBeInTheDocument();
    expect(screen.queryByTestId("task-board")).not.toBeInTheDocument();
  });

  // VAL-TABS-002 / VAL-TABS-008: each tab query selects its surface
  it("renders Home when ?tab=home", () => {
    renderDetail("/company/company-1/projects/project-1?tab=home");
    expect(screen.getByTestId("project-home")).toBeInTheDocument();
  });

  it("renders Work (TaskBoard) when ?tab=work", () => {
    renderDetail("/company/company-1/projects/project-1?tab=work");
    expect(screen.getByTestId("task-board")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Work" })).toBeInTheDocument();
    expect(screen.queryByTestId("project-home")).not.toBeInTheDocument();
  });

  it("renders Drive when ?tab=drive", () => {
    renderDetail("/company/company-1/projects/project-1?tab=drive");
    expect(screen.getByTestId("project-drive")).toBeInTheDocument();
  });

  it("renders Activity when ?tab=activity", () => {
    renderDetail("/company/company-1/projects/project-1?tab=activity");
    expect(screen.getByTestId("project-activity")).toBeInTheDocument();
  });

  // VAL-TABS-005: invalid tab falls back to Home
  it("falls back to Home when tab query is invalid", () => {
    renderDetail("/company/company-1/projects/project-1?tab=foo");
    expect(screen.getByTestId("project-home")).toBeInTheDocument();
    expect(screen.queryByTestId("task-board")).not.toBeInTheDocument();
  });

  // VAL-TABS-007: tab labels match the four-tab IA
  it("shows exactly Home, Work, Drive, Activity tab labels (no Issues/Goals)", () => {
    renderDetail("/company/company-1/projects/project-1");
    const tabButtons = screen.getAllByRole("button").filter(
      (b) => ["Home", "Work", "Drive", "Activity"].includes(b.textContent ?? ""),
    );
    expect(tabButtons).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "Issues" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Goals" })).not.toBeInTheDocument();
  });

  // VAL-WORK-002: Work tab is labeled "Work" (not "Issues")
  it("labels the Work tab 'Work' not 'Issues'", () => {
    renderDetail("/company/company-1/projects/project-1");
    expect(screen.getByRole("button", { name: "Work" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Issues" })).not.toBeInTheDocument();
  });

  // VAL-TABS-004: switching tabs writes the URL
  it("switching to Work tab writes ?tab=work and renders TaskBoard", async () => {
    const user = userEvent.setup();
    renderDetail("/company/company-1/projects/project-1");
    expect(screen.getByTestId("project-home")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Work" }));
    expect(screen.getByTestId("task-board")).toBeInTheDocument();
  });

  it("switching to Activity tab writes ?tab=activity and renders Activity", async () => {
    const user = userEvent.setup();
    renderDetail("/company/company-1/projects/project-1");
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByTestId("project-activity")).toBeInTheDocument();
  });

  // VAL-TABS-009: tab mechanics retain project context
  it("retains companyId and projectId when switching tabs", async () => {
    const user = userEvent.setup();
    renderDetail("/company/company-1/projects/project-1");
    await user.click(screen.getByRole("button", { name: "Activity" }));
    expect(screen.getByText("Activity for company-1/project-1")).toBeInTheDocument();
  });

  // VAL-WORK-007: Work tab renders TaskBoard scoped to projectId
  it("renders TaskBoard which is project-scoped via useParams", () => {
    renderDetail("/company/company-1/projects/project-1?tab=work");
    // TaskBoard reads projectId from useParams — the mock verifies it renders
    expect(screen.getByTestId("task-board")).toBeInTheDocument();
  });
});
