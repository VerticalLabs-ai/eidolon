import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAddTaskComment } from "../src/lib/hooks";

const apiMocks = vi.hoisted(() => ({
  addTaskComment: vi.fn(),
  getTaskThread: vi.fn(),
}));

vi.mock("../src/lib/api", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")),
  addTaskComment: apiMocks.addTaskComment,
  getTaskThread: apiMocks.getTaskThread,
}));

const createdComment = {
  id: "comment-1",
  companyId: "company-1",
  taskId: "task-1",
  kind: "comment" as const,
  content: "Confirmed comment",
  payload: {},
  status: "answered" as const,
  createdAt: "2026-07-30T22:00:00.000Z",
  updatedAt: "2026-07-30T22:00:00.000Z",
};

describe("useAddTaskComment", () => {
  let queryClient: QueryClient;
  let wrapper: ({ children }: { children: ReactNode }) => ReactNode;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  });

  it("confirms the canonical comment exactly once before updating the thread cache", async () => {
    apiMocks.addTaskComment.mockResolvedValue({ data: createdComment });
    apiMocks.getTaskThread.mockResolvedValue({ data: [createdComment] });
    const { result } = renderHook(() => useAddTaskComment("company-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        taskId: "task-1",
        content: "Confirmed comment",
        idempotencyKey: "comment-attempt-1",
      });
    });

    expect(apiMocks.addTaskComment).toHaveBeenCalledWith(
      "company-1",
      "task-1",
      "Confirmed comment",
      "comment-attempt-1",
    );
    expect(apiMocks.getTaskThread).toHaveBeenCalledWith("company-1", "task-1");
    expect(queryClient.getQueryData(["tasks", "company-1", "task-1", "thread"]))
      .toEqual([createdComment]);
  });

  it("rejects the mutation when the comment cannot be confirmed", async () => {
    apiMocks.addTaskComment.mockResolvedValue({ data: createdComment });
    apiMocks.getTaskThread.mockResolvedValue({ data: [] });
    const { result } = renderHook(() => useAddTaskComment("company-1"), { wrapper });

    await expect(result.current.mutateAsync({
      taskId: "task-1",
      content: "Confirmed comment",
      idempotencyKey: "comment-attempt-1",
    })).rejects.toThrow("could not be confirmed");
  });
});
