import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectThreadPanel } from "../src/components/projects/ProjectThreadPanel";
import { ProjectThreadComposer } from "../src/components/projects/ProjectThreadComposer";

const mocks = vi.hoisted(() => ({
  useProjectThreadItems: vi.fn(),
  useCreateThreadItem: vi.fn(),
  useResolveThreadItem: vi.fn(),
  useCreateProjectThread: vi.fn(),
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

const baseItem = {
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

const item = (overrides: Partial<typeof baseItem> = {}) => ({ ...baseItem, ...overrides });

function wrapper({ children }: { children: React.ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function panelResult(
  overrides: Partial<{
    data: typeof baseItem[];
    threads: typeof thread[];
    isLoading: boolean;
    isError: boolean;
  }> = {},
) {
  return {
    data: overrides.data ?? [baseItem],
    threads: overrides.threads ?? [thread],
    isLoading: overrides.isLoading ?? false,
    isError: overrides.isError ?? false,
    ...overrides,
  };
}

describe("Project threads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useProjectThreadItems.mockReturnValue(panelResult());
    mocks.useCreateThreadItem.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    mocks.useResolveThreadItem.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mocks.useCreateProjectThread.mockReturnValue({ mutate: vi.fn(), isPending: false });
  });

  it("shows recent messages with author, timestamp, and kind", () => {
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText("A recent project update")).toBeInTheDocument();
    expect(screen.getByText("user-1")).toBeInTheDocument();
    expect(screen.getByText("comment")).toBeInTheDocument();
  });

  it("renders a relative timestamp for each thread item", () => {
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    const timestamp = screen.getByTestId("thread-item-timestamp");
    expect(timestamp).toBeInTheDocument();
    expect(timestamp).toHaveAttribute("dateTime", baseItem.createdAt);
    // formatDistanceToNow produces text ending with "ago"
    expect(timestamp.textContent).toMatch(/ago$/);
  });

  it("aggregates recent items across all active project threads", () => {
    const threadA = { ...thread, id: "thread-a", title: "Conversation A" };
    const threadB = { ...thread, id: "thread-b", title: "Standup B", type: "standup" as const };
    const itemA = item({ id: "a-1", projectThreadId: "thread-a", content: "From thread A", createdAt: "2026-08-01T12:00:00.000Z" });
    const itemB = item({ id: "b-1", projectThreadId: "thread-b", content: "From thread B", createdAt: "2026-08-01T13:00:00.000Z" });
    mocks.useProjectThreadItems.mockReturnValue(
      panelResult({ data: [itemA, itemB], threads: [threadA, threadB] }),
    );
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText("From thread A")).toBeInTheDocument();
    expect(screen.getByText("From thread B")).toBeInTheDocument();
  });

  it("posts a non-empty comment and blocks empty content", () => {
    const mutate = vi.fn();
    mocks.useCreateThreadItem.mockReturnValue({ mutate, isPending: false, isSuccess: false, isError: false, reset: vi.fn() });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    const input = screen.getByLabelText("Post a comment");
    const submit = screen.getByRole("button", { name: "Post comment" });
    expect(submit).toBeDisabled();
    fireEvent.change(input, { target: { value: "New comment" } });
    fireEvent.click(submit);
    expect(mutate).toHaveBeenCalledWith({ kind: "comment", content: "New comment" });
  });

  it("clears the composer draft only after a successful mutation", () => {
    const reset = vi.fn();
    mocks.useCreateThreadItem.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: false,
      isError: false,
      reset,
    });
    const { rerender } = render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    const input = screen.getByLabelText("Post a comment") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft to clear" } });
    expect(input.value).toBe("Draft to clear");
    // Simulate the mutation resolving successfully (hook re-renders with isSuccess: true)
    mocks.useCreateThreadItem.mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
      isSuccess: true,
      isError: false,
      reset,
    });
    rerender(<ProjectThreadPanel companyId="company-1" projectId="project-1" />);
    expect(screen.getByLabelText("Post a comment")).toHaveValue("");
    expect(reset).toHaveBeenCalled();
  });

  it("preserves the draft and surfaces an error when the mutation fails", () => {
    mocks.useCreateThreadItem.mockReturnValue({ mutate: vi.fn(), isPending: false, isSuccess: false, isError: true, reset: vi.fn() });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    const input = screen.getByLabelText("Post a comment") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Draft that failed" } });
    expect(input.value).toBe("Draft that failed");
    expect(screen.getByRole("alert")).toHaveTextContent(/could not post your comment/i);
  });

  it("shows pending interaction accept, reject, and answer controls", () => {
    const interaction = item({ id: "interaction-1", kind: "interaction", status: "pending" });
    mocks.useProjectThreadItems.mockReturnValue(panelResult({ data: [interaction] }));
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByRole("button", { name: "Accept interaction" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject interaction" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Answer interaction" })).toBeInTheDocument();
  });

  it("accepts a pending interaction", () => {
    const interaction = item({ id: "interaction-1", projectThreadId: "thread-1", kind: "interaction", status: "pending" });
    const mutate = vi.fn();
    mocks.useProjectThreadItems.mockReturnValue(panelResult({ data: [interaction] }));
    mocks.useResolveThreadItem.mockReturnValue({ mutate, isPending: false });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Accept interaction" }));
    expect(mutate).toHaveBeenCalledWith({ threadId: "thread-1", itemId: "interaction-1", data: { status: "accepted" } });
  });

  it("rejects a pending interaction", () => {
    const interaction = item({ id: "interaction-2", projectThreadId: "thread-1", kind: "interaction", status: "pending" });
    const mutate = vi.fn();
    mocks.useProjectThreadItems.mockReturnValue(panelResult({ data: [interaction] }));
    mocks.useResolveThreadItem.mockReturnValue({ mutate, isPending: false });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Reject interaction" }));
    expect(mutate).toHaveBeenCalledWith({ threadId: "thread-1", itemId: "interaction-2", data: { status: "rejected" } });
  });

  it("answers a pending interaction", () => {
    const interaction = item({ id: "interaction-3", projectThreadId: "thread-1", kind: "interaction", status: "pending" });
    const mutate = vi.fn();
    mocks.useProjectThreadItems.mockReturnValue(panelResult({ data: [interaction] }));
    mocks.useResolveThreadItem.mockReturnValue({ mutate, isPending: false });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Answer interaction" }));
    expect(mutate).toHaveBeenCalledWith({ threadId: "thread-1", itemId: "interaction-3", data: { status: "answered" } });
  });

  it("hides interaction controls once the interaction is resolved", () => {
    const resolved = item({ id: "interaction-resolved", kind: "interaction", status: "accepted" });
    mocks.useProjectThreadItems.mockReturnValue(panelResult({ data: [resolved] }));
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole("button", { name: "Accept interaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject interaction" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Answer interaction" })).not.toBeInTheDocument();
    // final status is rendered as a badge instead
    expect(screen.getByText("accepted")).toBeInTheDocument();
  });

  it("resolves interactions aggregated from a different thread against that thread", () => {
    const threadB = { ...thread, id: "thread-b", type: "standup" as const };
    const interaction = item({ id: "ix-b", projectThreadId: "thread-b", kind: "interaction", status: "pending" });
    const mutate = vi.fn();
    mocks.useProjectThreadItems.mockReturnValue(panelResult({ data: [interaction], threads: [thread, threadB] }));
    mocks.useResolveThreadItem.mockReturnValue({ mutate, isPending: false });
    render(<ProjectThreadPanel companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole("button", { name: "Accept interaction" }));
    expect(mutate).toHaveBeenCalledWith({ threadId: "thread-b", itemId: "ix-b", data: { status: "accepted" } });
  });

  it("shows an empty state without threads", () => {
    mocks.useProjectThreadItems.mockReturnValue(panelResult({ data: [], threads: [] }));
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
