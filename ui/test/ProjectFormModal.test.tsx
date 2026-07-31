import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectFormModal } from "../src/components/projects/ProjectFormModal";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  updateProject: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useCreateProject: () => ({
    mutate: mocks.createProject,
    reset: mocks.reset,
    isPending: false,
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

describe("ProjectFormModal", () => {
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

  it("keeps operator edits when the cached project is refetched", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ProjectFormModal
        open
        companyId="company-1"
        project={project}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    const name = screen.getByLabelText("Project name");
    await user.clear(name);
    await user.type(name, "Runtime durability");

    // A background refetch hands down an equal project with a new object identity.
    rerender(
      <ProjectFormModal
        open
        companyId="company-1"
        project={{ ...project }}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Project name")).toHaveValue("Runtime durability");
  });
});
