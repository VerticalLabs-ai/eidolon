import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectThreadPanel } from "../src/components/projects/ProjectThreadPanel";
import { ProjectThreadComposer } from "../src/components/projects/ProjectThreadComposer";

const mocks = vi.hoisted(() => ({
  useProjectThreads: vi.fn(),
  useProjectThread: vi.fn(),
  useCreateProjectThread: vi.fn(),
  useCreateThreadItem: vi.fn(),
  useUpdateThreadItem: vi.fn(),
}));

vi.mock("@/lib/hooks", () => mocks);

const thread = {
  id: "thread-1",
  companyId: "company-1",
  projectId: "project-1",
  title: "Project conversation",
  type: "conversation" as const,
  status: "active" as const,
  createdByUserId: "user-1",
  createdByAgentId: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

const item = {
  id: "item-1",
  companyId: "company-1",
  taskId: null,
  projectThreadId: "thread-1",
  kind: "comment" as const,
  authorUserId: "user-1",
  authorAgentId: null,
  content: "A recent project update",
  payload: {},
  interactionType: null,
  status: "pending" as const,
  createdAt: "2026-08-01T11:00:00.000Z",
  updatedAt: "2026-08-01T11:00:00.000Z",
};

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

describe("Project threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectThreads.mockReturnValue({ data: [thread], isLoading: false, isError: false });
    mocks.useProjectThread.mockReturnValue({
      data: { ...thread, items: [item] },
      isLoading: false,
      isError: false,
    });
    mocks.useCreateProjectThread.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useCreateThreadItem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useUpdateThreadItem.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it("shows recent messages with author, timestamp, and kind", () => {
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText("A recent project update")).toBeInTheDocument();
    expect(screen.getByText("user-1")).toBeInTheDocument();
    expect(screen.getByText("comment")).toBeInTheDocument();
  });

  it("posts a non-empty comment and blocks empty content", () => {
    const mutate = vi.fn();
    mocks.useCreateThreadItem.mockReturnValue({ mutate, isPending: false });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    const input = screen.getByLabelText("Post a comment");
    const submit = screen.getByRole("button", { name: "Post comment" });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "New comment" } });
    fireEvent.click(submit);
    expect(mutate).toHaveBeenCalledWith({ kind: "comment", content: "New comment" });
  });

  it("shows and resolves pending interaction controls", () => {
    const interaction = { ...item, id: "interaction-1", kind: "interaction" as const, status: "pending" as const };
    const mutate = vi.fn();
    mocks.useProjectThread.mockReturnValue({ data: { ...thread, items: [interaction] }, isLoading: false, isError: false });
    mocks.useUpdateThreadItem.mockReturnValue({ mutate, isPending: false });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Accept interaction" }));
    expect(mutate).toHaveBeenCalledWith({ itemId: "interaction-1", data: { status: "accepted" } });
  });

  it("shows an empty state without threads", () => {
    mocks.useProjectThreads.mockReturnValue({ data: [], isLoading: false, isError: false });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText("No conversation yet")).toBeInTheDocument();
  });

  it("creates a thread from the Work composer and blocks an empty title", () => {
    const mutate = vi.fn();
    mocks.useCreateProjectThread.mockReturnValue({ mutate, isPending: false });
    render(<ProjectThreadComposer companyId="company-1" projectId="project-1" />, { wrapper });
    const submit = screen.getByRole("button", { name: "Create thread" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Thread title"), { target: { value: "Release planning" } });
    fireEvent.change(screen.getByLabelText("Thread type"), { target: { value: "plan_review" } });
    fireEvent.click(submit);
    expect(mutate).toHaveBeenCalledWith({ title: "Release planning", type: "plan_review" });
  });
});
