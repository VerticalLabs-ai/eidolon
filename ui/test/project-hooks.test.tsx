import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCreateProject } from "../src/lib/hooks";

const apiMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
}));

vi.mock("../src/lib/api", async () => ({
  ...(await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api")),
  createProject: apiMocks.createProject,
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
});
