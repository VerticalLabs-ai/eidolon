import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateTaskModal } from "../src/components/tasks/CreateTaskModal";

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useCreateTask: () => ({ mutate: mocks.createTask, isPending: false }),
}));

describe("CreateTaskModal", () => {
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
  });

  it("persists the project when submitting from a project", async () => {
    const user = userEvent.setup();
    render(
      <CreateTaskModal
        open
        companyId="company-1"
        projectId="project-1"
        onClose={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Title"), "Keep project scope");
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    expect(mocks.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Keep project scope",
        projectId: "project-1",
      }),
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("keeps company-wide task creation unscoped", async () => {
    const user = userEvent.setup();
    render(<CreateTaskModal open companyId="company-1" onClose={vi.fn()} />);

    await user.type(screen.getByLabelText("Title"), "Company task");
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    expect(mocks.createTask.mock.calls[0][0]).not.toHaveProperty("projectId");
  });
});
