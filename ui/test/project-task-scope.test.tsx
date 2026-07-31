import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskBoard } from "../src/pages/TaskBoard";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  modalProps: vi.fn(),
  useTasks: vi.fn(() => ({ data: [], isLoading: false })),
  updateTask: vi.fn(),
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
  });

  it("requests and creates tasks within the current project", () => {
    render(<TaskBoard />);

    expect(mocks.useTasks).toHaveBeenCalledWith("company-1", {
      projectId: "project-1",
    });
    expect(mocks.modalProps).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: "company-1", projectId: "project-1" }),
    );
  });
});
