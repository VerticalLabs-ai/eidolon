import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CreateProjectModal } from "../src/components/projects/CreateProjectModal";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  updateProject: vi.fn(),
  reset: vi.fn(),
  isPending: false,
}));

vi.mock("@/lib/hooks", () => ({
  useCreateProject: () => ({
    mutate: mocks.createProject,
    reset: mocks.reset,
    isPending: mocks.isPending,
  }),
  useUpdateProject: () => ({
    mutate: mocks.updateProject,
    reset: mocks.reset,
    isPending: false,
  }),
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

describe("CreateProjectModal", () => {
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
    mocks.isPending = false;
  });

  it("validates repository URLs before submitting", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        open
        companyId="company-1"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText("Project name"), "Runtime reliability");
    await user.type(screen.getByLabelText("Repository URL"), "not-a-url");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    const repositoryUrl = screen.getByLabelText("Repository URL");
    const error = screen.getByRole("alert");
    expect(error).toHaveTextContent(
      "Enter a complete repository URL, such as https://github.com/org/repo.",
    );
    expect(repositoryUrl).toHaveAttribute("aria-describedby", error.id);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("locks dismissal and fields while creation is pending", () => {
    mocks.isPending = true;
    const onClose = vi.fn();
    render(
      <CreateProjectModal
        open
        companyId="company-1"
        onClose={onClose}
        onCreated={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Project name")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    const cancelEvent = new Event("cancel", { bubbles: false, cancelable: true });
    fireEvent(screen.getByRole("dialog"), cancelEvent);
    expect(cancelEvent.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("submits typed project fields and reports the canonical project", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(
      <CreateProjectModal
        open
        companyId="company-1"
        onClose={onClose}
        onCreated={onCreated}
      />,
    );

    await user.type(screen.getByLabelText("Project name"), "Runtime reliability");
    await user.type(screen.getByLabelText("Description"), "Make agent execution durable.");
    await user.selectOptions(screen.getByLabelText("Status"), "active");
    await user.type(
      screen.getByLabelText("Repository URL"),
      "https://github.com/vertical-labs/eidolon",
    );
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(mocks.createProject).toHaveBeenCalledWith(
      {
        name: "Runtime reliability",
        description: "Make agent execution durable.",
        status: "active",
        repoUrl: "https://github.com/vertical-labs/eidolon",
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );

    const callbacks = mocks.createProject.mock.calls[0][1];
    callbacks.onSuccess(project);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCreated).toHaveBeenCalledWith(project);
  });

  it("keeps entries visible when the API rejects the write", async () => {
    const user = userEvent.setup();
    render(
      <CreateProjectModal
        open
        companyId="company-1"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />,
    );

    const name = screen.getByLabelText("Project name");
    await user.type(name, "Runtime reliability");
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    const callbacks = mocks.createProject.mock.calls[0][1];
    callbacks.onError(new Error("Database unavailable"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(name).toHaveValue("Runtime reliability");
  });
});
