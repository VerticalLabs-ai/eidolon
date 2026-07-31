import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useArchiveProject,
  useCreateProject,
  useProject,
  useProjectActivity,
  useUpdateProject,
} from "../src/lib/hooks";

const apiMocks = vi.hoisted(() => ({
  archiveProject: vi.fn(),
  createProject: vi.fn(),
  getProject: vi.fn(),
  getProjectActivity: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock("../src/lib/api", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")),
  archiveProject: apiMocks.archiveProject,
  createProject: apiMocks.createProject,
  getProject: apiMocks.getProject,
  getProjectActivity: apiMocks.getProjectActivity,
  updateProject: apiMocks.updateProject,
}));

const createdProject = {
  id: "project-1",
  companyId: "company-1",
  name: "Runtime reliability",
  description: "Make agent execution durable.",
  status: "active" as const,
  repoUrl: "https://github.com/vertical-labs/eidolon",
  createdAt: "2026-07-30T22:00:00.000Z",
  updatedAt: "2026-07-30T22:00:00.000Z",
};

describe("useCreateProject", () => {
  let queryClient: QueryClient;
  let wrapper: ({ children }: { children: ReactNode }) => ReactNode;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(["projects", "company-1"], []);
    wrapper = ({ children }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  });

  it("stores the canonical project and invalidates the company project list", async () => {
    apiMocks.createProject.mockResolvedValue({ data: createdProject });
    const { result } = renderHook(() => useCreateProject("company-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        name: "Runtime reliability",
        description: "Make agent execution durable.",
        status: "active",
        repoUrl: "https://github.com/vertical-labs/eidolon",
      });
    });

    expect(apiMocks.createProject).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ name: "Runtime reliability", status: "active" }),
    );
    expect(queryClient.getQueryData(["projects", "company-1"]))
      .toEqual([createdProject]);
    expect(queryClient.getQueryState(["projects", "company-1"])?.isInvalidated).toBe(true);
  });

  it("loads one project into a canonical detail cache", async () => {
    apiMocks.getProject.mockResolvedValue({ data: createdProject });
    const { result } = renderHook(() => useProject("company-1", "project-1"), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(createdProject);
    expect(apiMocks.getProject).toHaveBeenCalledWith("company-1", "project-1");
  });

  it("loads a bounded page of persisted project activity", async () => {
    const activityPage = {
      data: [],
      meta: { total: 0, limit: 20, offset: 40 },
    };
    apiMocks.getProjectActivity.mockResolvedValue(activityPage);
    const { result } = renderHook(
      () => useProjectActivity("company-1", "project-1", 20, 40),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(activityPage);
    expect(apiMocks.getProjectActivity).toHaveBeenCalledWith(
      "company-1",
      "project-1",
      20,
      40,
    );
  });

  it("updates list and detail caches with the persisted project", async () => {
    const updatedProject = {
      ...createdProject,
      name: "Runtime reliability verified",
      status: "completed" as const,
    };
    queryClient.setQueryData(["projects", "company-1"], [createdProject]);
    queryClient.setQueryData(["projects", "company-1", "project-1"], createdProject);
    apiMocks.updateProject.mockResolvedValue({ data: updatedProject });
    const { result } = renderHook(() => useUpdateProject("company-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        projectId: "project-1",
        data: { name: "Runtime reliability verified", status: "completed" },
      });
    });

    expect(apiMocks.updateProject).toHaveBeenCalledWith(
      "company-1",
      "project-1",
      expect.objectContaining({ status: "completed" }),
    );
    expect(queryClient.getQueryData(["projects", "company-1", "project-1"]))
      .toEqual(updatedProject);
    expect(queryClient.getQueryData(["projects", "company-1"]))
      .toEqual([updatedProject]);
    expect(queryClient.getQueryState(["projects", "company-1"])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(["projects", "company-1", "project-1"])?.isInvalidated)
      .toBe(true);
  });

  it("marks the canonical project archived in both caches", async () => {
    const archivedProject = { ...createdProject, status: "archived" as const };
    queryClient.setQueryData(["projects", "company-1"], [createdProject]);
    queryClient.setQueryData(["projects", "company-1", "project-1"], createdProject);
    apiMocks.archiveProject.mockResolvedValue({ data: archivedProject });
    const { result } = renderHook(() => useArchiveProject("company-1"), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ projectId: "project-1" });
    });

    expect(apiMocks.archiveProject).toHaveBeenCalledWith("company-1", "project-1");
    expect(queryClient.getQueryData(["projects", "company-1", "project-1"]))
      .toEqual(archivedProject);
    expect(queryClient.getQueryData(["projects", "company-1"]))
      .toEqual([archivedProject]);
  });
});
