import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectActivity } from "../src/components/projects/ProjectActivity";

const mocks = vi.hoisted(() => ({
  useProjectActivity: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useProjectActivity: mocks.useProjectActivity,
}));

function renderActivity() {
  return render(<ProjectActivity companyId="company-1" projectId="project-1" />);
}

describe("ProjectActivity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a loading state and a retryable error", async () => {
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

  it("shows the durable empty state", () => {
    mocks.useProjectActivity.mockReturnValue({
      isLoading: false,
      isError: false,
      data: { data: [], meta: { total: 0, limit: 20, offset: 0 } },
    });
    renderActivity();
    expect(screen.getByText("No activity yet")).toBeInTheDocument();
    expect(screen.getByText(/Durable project and associated task events/)).toBeInTheDocument();
  });

  it("renders actor, context, changes, and bounded pagination", async () => {
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
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("1–20 of 25")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(mocks.useProjectActivity).toHaveBeenLastCalledWith("company-1", "project-1", 20, 20);
  });
});
