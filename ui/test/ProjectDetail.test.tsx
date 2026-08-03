import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDetail } from "../src/pages/ProjectDetail";

const mocks = vi.hoisted(() => ({
  archiveProject: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
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
  useCreateProject: () => ({
    mutate: mocks.createProject,
    reset: mocks.reset,
    isPending: false,
  }),
  useProject: () => ({
    data: project,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useUpdateProject: () => ({
    mutate: mocks.updateProject,
    reset: mocks.reset,
    isPending: false,
  }),
}));

vi.mock("@/pages/TaskBoard", () => ({ TaskBoard: () => <div>Issue board</div> }));
vi.mock("@/pages/ProjectHome", () => ({ ProjectHome: () => <div>Home content</div> }));
vi.mock("@/pages/ProjectDrive", () => ({ ProjectDrive: () => <div>Drive content</div> }));
vi.mock("@/pages/GoalTree", () => ({ GoalTree: () => <div>Goal tree</div> }));
vi.mock("@/components/projects/ProjectActivity", () => ({
  ProjectActivity: ({ companyId, projectId }: { companyId: string; projectId: string }) => (
    <div>Activity for {companyId}/{projectId}</div>
  ),
}));
vi.mock("sonner", () => ({ toast: { success: mocks.successToast } }));

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/company/company-1/projects/project-1"]}>
      <Routes>
        <Route path="/company/:companyId/projects/:projectId" element={<ProjectDetail />} />
        <Route path="/company/:companyId/projects" element={<div>Project list route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ProjectDetail lifecycle controls", () => {
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
    project.repoUrl = "https://github.com/vertical-labs/eidolon";
  });

  it("does not render a persisted unsafe repository URL as a link", () => {
    project.repoUrl = "javascript:alert(document.domain)";
    renderDetail();

    expect(screen.queryByRole("link", { name: /javascript:/ })).not.toBeInTheDocument();
  });

  it("opens the persisted activity view for this project", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("button", { name: "Activity" }));

    expect(screen.getByText("Activity for company-1/project-1")).toBeInTheDocument();
  });

  it("edits all operator fields through the shared form with keyboard submission", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("button", { name: "Edit Project" }));
    const name = screen.getByLabelText("Project name");
    expect(name).toHaveValue("Runtime reliability");
    expect(screen.getByLabelText("Repository URL"))
      .toHaveValue("https://github.com/vertical-labs/eidolon");

    await user.clear(name);
    await user.type(name, "Runtime reliability verified");
    await user.selectOptions(screen.getByLabelText("Status"), "completed");
    screen.getByRole("button", { name: "Save Changes" }).focus();
    await user.keyboard("{Enter}");

    expect(mocks.updateProject).toHaveBeenCalledWith(
      {
        projectId: "project-1",
        data: expect.objectContaining({
          name: "Runtime reliability verified",
          description: "Make agent execution durable.",
          status: "completed",
          repoUrl: "https://github.com/vertical-labs/eidolon",
        }),
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it("preserves edits and shows a visible update failure", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("button", { name: "Edit Project" }));
    const name = screen.getByLabelText("Project name");
    await user.clear(name);
    await user.type(name, "Keep this edit");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    const callbacks = mocks.updateProject.mock.calls[0][1];
    callbacks.onError(new Error("Database unavailable"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(name).toHaveValue("Keep this edit");
  });

  it("explains soft archive, reports failure, and returns to the project list after success", async () => {
    const user = userEvent.setup();
    renderDetail();

    await user.click(screen.getByRole("button", { name: "Archive Project" }));
    expect(screen.getByText(/Its data and history will be retained/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm Archive" }));
    let callbacks = mocks.archiveProject.mock.calls[0][1];
    callbacks.onError(new Error("Archive service unavailable"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Archive service unavailable");

    await user.click(screen.getByRole("button", { name: "Confirm Archive" }));
    callbacks = mocks.archiveProject.mock.calls[1][1];
    callbacks.onSuccess({ ...project, status: "archived" });

    expect(await screen.findByText("Project list route")).toBeInTheDocument();
    expect(mocks.successToast).toHaveBeenCalledWith("Project archived: Runtime reliability");
  });
});
