import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationRunsPanel } from "../src/components/projects/AutomationRunsPanel";

const mocks = vi.hoisted(() => ({
  useProjectWork: vi.fn(),
}));

vi.mock("@/lib/hooks", () => mocks);

function makeRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "run-1",
    companyId: "company-1",
    projectId: "project-1",
    automationType: "routine",
    automationId: "routine-1",
    automationName: "Daily Briefing",
    triggerType: "manual",
    triggerPayload: {},
    status: "completed",
    taskId: null,
    executionId: null,
    sessionId: null,
    messageId: null,
    outcome: "session_started",
    error: null,
    startedAt: "2026-08-01T10:00:00.000Z",
    completedAt: "2026-08-01T10:05:00.000Z",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:05:00.000Z",
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe("AutomationRunsPanel — VAL-UI-005, VAL-CROSS-001/002/007", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the panel with recent runs", () => {
    mocks.useProjectWork.mockReturnValue({
      data: { automationRuns: [makeRun()] },
      isLoading: false,
      isError: false,
    });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("automation-runs-panel")).toBeInTheDocument();
    expect(screen.getByTestId("automation-run-run-1")).toBeInTheDocument();
  });

  it("shows automation type label for each type", () => {
    mocks.useProjectWork.mockReturnValue({
      data: {
        automationRuns: [
          makeRun({ id: "r1", automationType: "routine", automationName: "Daily Briefing" }),
          makeRun({ id: "r2", automationType: "workflow", automationName: "Deploy Pipeline" }),
          makeRun({ id: "r3", automationType: "webhook", automationName: "GitHub Push Hook" }),
        ],
      },
      isLoading: false,
      isError: false,
    });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("run-type-r1")).toHaveTextContent("Routine");
    expect(screen.getByTestId("run-type-r2")).toHaveTextContent("Workflow");
    expect(screen.getByTestId("run-type-r3")).toHaveTextContent("Webhook");
  });

  it("shows name, status badge, and timestamp for each run", () => {
    mocks.useProjectWork.mockReturnValue({
      data: { automationRuns: [makeRun()] },
      isLoading: false,
      isError: false,
    });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("run-name-run-1")).toHaveTextContent("Daily Briefing");
    expect(screen.getByTestId("run-status-completed")).toBeInTheDocument();
    expect(screen.getByTestId("run-timestamp-run-1")).toBeInTheDocument();
  });

  it("shows different status badges for different statuses", () => {
    mocks.useProjectWork.mockReturnValue({
      data: {
        automationRuns: [
          makeRun({ id: "r-ok", status: "completed" }),
          makeRun({ id: "r-fail", status: "failed" }),
          makeRun({ id: "r-run", status: "running" }),
        ],
      },
      isLoading: false,
      isError: false,
    });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getAllByTestId("run-status-completed")).toHaveLength(1);
    expect(screen.getAllByTestId("run-status-failed")).toHaveLength(1);
    expect(screen.getAllByTestId("run-status-running")).toHaveLength(1);
  });

  // VAL-UI-005: Empty state when no runs
  it("shows empty state when there are no runs", () => {
    mocks.useProjectWork.mockReturnValue({
      data: { automationRuns: [] },
      isLoading: false,
      isError: false,
    });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("automation-runs-empty")).toBeInTheDocument();
    expect(screen.getByText(/no automation runs yet/i)).toBeInTheDocument();
  });

  it("shows empty state when automationRuns is undefined (no data)", () => {
    mocks.useProjectWork.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
    });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByTestId("automation-runs-empty")).toBeInTheDocument();
  });

  it("shows a loading state", () => {
    mocks.useProjectWork.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("shows an error state", () => {
    mocks.useProjectWork.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });

  // VAL-UI-007: Project-scoped — only project-owned runs shown
  it("renders only runs from the provided project work data", () => {
    mocks.useProjectWork.mockReturnValue({
      data: {
        automationRuns: [
          makeRun({ id: "r-proj", projectId: "project-1", automationName: "Project Run" }),
        ],
      },
      isLoading: false,
      isError: false,
    });
    render(<AutomationRunsPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText("Project Run")).toBeInTheDocument();
    // Verify the hook was called with the correct project scoping
    expect(mocks.useProjectWork).toHaveBeenCalledWith("company-1", "project-1");
  });
});
