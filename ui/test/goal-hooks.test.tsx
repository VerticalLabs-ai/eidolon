import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateGoal, useGoalTree, useUpdateGoal } from "../src/lib/hooks";

const apiMocks = vi.hoisted(() => ({
  createGoal: vi.fn(),
  updateGoal: vi.fn(),
  getGoals: vi.fn(),
}));

vi.mock("../src/lib/api", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")),
  createGoal: apiMocks.createGoal,
  updateGoal: apiMocks.updateGoal,
  getGoals: apiMocks.getGoals,
}));

const rootGoal = {
  id: "goal-1",
  companyId: "company-1",
  title: "Ship the operator workflow",
  description: null,
  level: "company" as const,
  status: "active" as const,
  parentId: null,
  ownerAgentId: null,
  progress: 20,
  targetDate: null,
  metrics: {},
  projectId: null,
  createdAt: "2026-07-30T22:00:00.000Z",
  updatedAt: "2026-07-30T22:00:00.000Z",
};

describe("goal mutations", () => {
  let queryClient: QueryClient;
  let wrapper: ({ children }: { children: ReactNode }) => ReactNode;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(["goals", "company-1", undefined], []);
    wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  });

  it("adds the canonical created goal and invalidates the tree", async () => {
    apiMocks.createGoal.mockResolvedValue({ data: rootGoal });
    const { result } = renderHook(() => useCreateGoal("company-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        title: rootGoal.title,
        level: rootGoal.level,
        status: rootGoal.status,
        parentId: null,
        ownerAgentId: null,
        progress: rootGoal.progress,
      });
    });

    expect(queryClient.getQueryState(["goals", "company-1", undefined])?.isInvalidated).toBe(true);
  });

  it("replaces the updated goal and invalidates the tree", async () => {
    const updatedGoal = { ...rootGoal, status: "completed" as const, progress: 100 };
    queryClient.setQueryData(["goals", "company-1", undefined], [rootGoal]);
    apiMocks.updateGoal.mockResolvedValue({ data: updatedGoal });
    const { result } = renderHook(() => useUpdateGoal("company-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        goalId: rootGoal.id,
        data: { status: "completed", progress: 100 },
      });
    });

    expect(queryClient.getQueryState(["goals", "company-1", undefined])?.isInvalidated).toBe(true);
  });

  it("separates project query keys and forwards filters", async () => {
    apiMocks.getGoals.mockResolvedValue({ data: [rootGoal] });
    const { result } = renderHook(
      () => useGoalTree("company-1", { projectId: "project-a" }),
      { wrapper },
    );

    await act(async () => {
      await result.current.refetch();
    });

    expect(apiMocks.getGoals).toHaveBeenCalledWith("company-1", { projectId: "project-a" });
    expect(queryClient.getQueryData(["goals", "company-1", { projectId: "project-a" }])).toEqual([rootGoal]);
    expect(queryClient.getQueryData(["goals", "company-1", undefined])).toEqual([]);
  });

  it("invalidates every scope under the company prefix", async () => {
    const projectGoal = { ...rootGoal, projectId: "project-a" };
    queryClient.setQueryData(["goals", "company-1", undefined], [rootGoal]);
    queryClient.setQueryData(["goals", "company-1", { projectId: "project-a" }], [projectGoal]);
    queryClient.setQueryData(["goals", "company-1", { projectId: "project-b" }], []);
    apiMocks.updateGoal.mockResolvedValue({ data: projectGoal });
    const { result } = renderHook(() => useUpdateGoal("company-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ goalId: rootGoal.id, data: { projectId: "project-a" } });
    });

    expect(queryClient.getQueryState(["goals", "company-1", undefined])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["goals", "company-1", { projectId: "project-a" }])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["goals", "company-1", { projectId: "project-b" }])?.isInvalidated).toBe(true);
  });
});
