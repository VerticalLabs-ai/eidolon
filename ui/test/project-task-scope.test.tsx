import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskBoard } from "../src/pages/TaskBoard";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  modalProps: vi.fn(),
  useTasks: vi.fn(() => ({ data: [], isLoading: false })),
  updateTask: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    useParams: () => ({ companyId: "company-1", projectId: "project-1" }),
  };
});

vi.mock("@/lib/hooks", () => ({
  useCreateTask: () => ({ mutate: mocks.createTask, isPending: false }),
  useTasks: mocks.useTasks,
  useUpdateTask: () => ({ mutate: mocks.updateTask }),
}));

vi.mock("@/components/tasks/CreateTaskModal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/tasks/CreateTaskModal")>();
  return {
    ...actual,
    CreateTaskModal: (props: Record<string, unknown>) => {
      mocks.modalProps(props);
      return null;
    },
  };
});

describe("project task scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useTasks.mockReturnValue({ data: [], isLoading: false });
  });

  it("requests and creates tasks within the current project", () => {
    render(<TaskBoard title="Work" />);

    expect(mocks.useTasks).toHaveBeenCalledWith("company-1", {
      projectId: "project-1",
    });
    expect(mocks.modalProps).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1", projectId: "project-1" }),
    );
  });

  // VAL-WORK-009: Work tab loading state
  it("shows a loading indicator when tasks are loading", () => {
    mocks.useTasks.mockReturnValue({ data: undefined, isLoading: true });
    render(<TaskBoard title="Work" />);
    // The loading state renders animated pulse columns
    const pulses = document.querySelectorAll(".animate-pulse");
    expect(pulses.length).toBeGreaterThan(0);
  });

  // VAL-WORK-009: Work tab error state
  it("shows an error message when tasks fail to load", () => {
    mocks.useTasks.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mocks.refetch,
    });
    render(<TaskBoard title="Work" />);
    expect(screen.getByText("Tasks could not be loaded")).toBeInTheDocument();
  });

  it("renders the caller-provided title for standalone Issues", () => {
    render(<TaskBoard title="Issues" />);

    expect(screen.getByRole("heading", { name: "Issues" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Work" })).not.toBeInTheDocument();
  });
});
