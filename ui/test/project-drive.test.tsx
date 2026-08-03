import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDrive } from "../src/pages/ProjectDrive";

const mocks = vi.hoisted(() => ({
  useFiles: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock("@/lib/hooks", () => ({
  useFiles: mocks.useFiles,
}));

function renderDrive() {
  return render(<ProjectDrive companyId="company-1" projectId="project-1" />);
}

const folder = {
  id: "folder-1",
  companyId: "company-1",
  agentId: null,
  name: "src",
  path: "/src",
  mimeType: "application/x-directory",
  sizeBytes: 0,
  content: null,
  storageType: "db",
  parentId: null,
  isDirectory: true,
  taskId: null,
  executionId: null,
  projectId: "project-1",
  createdAt: "2026-07-31T10:00:00.000Z",
  updatedAt: "2026-07-31T10:00:00.000Z",
};

const childFile = {
  id: "file-child",
  companyId: "company-1",
  agentId: null,
  name: "index.ts",
  path: "/src/index.ts",
  mimeType: "text/typescript",
  sizeBytes: 2048,
  content: "export {}",
  storageType: "db",
  parentId: "folder-1",
  isDirectory: false,
  taskId: null,
  executionId: null,
  projectId: "project-1",
  createdAt: "2026-07-31T11:00:00.000Z",
  updatedAt: "2026-07-31T11:00:00.000Z",
};

const rootFile = {
  id: "file-root",
  companyId: "company-1",
  agentId: null,
  name: "README.md",
  path: "/README.md",
  mimeType: "text/markdown",
  sizeBytes: 512,
  content: "# Project",
  storageType: "db",
  parentId: null,
  isDirectory: false,
  taskId: null,
  executionId: null,
  projectId: "project-1",
  createdAt: "2026-07-31T09:00:00.000Z",
  updatedAt: "2026-07-31T09:00:00.000Z",
};

describe("ProjectDrive", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // VAL-DRIVE-009: renders supplied project files with project-scoped hook inputs
  it("renders project files and calls useFiles with project-scoped filters", () => {
    mocks.useFiles.mockReturnValue({
      data: [folder, rootFile],
      isLoading: false,
      isError: false,
    });
    renderDrive();

    // Hook called with companyId, undefined agentId, and { projectId }
    expect(mocks.useFiles).toHaveBeenCalledWith("company-1", undefined, { projectId: "project-1" });

    // Both root-level entries are rendered as tree buttons
    expect(screen.getByRole("button", { name: "src" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "README.md" })).toBeInTheDocument();
  });

  // VAL-DRIVE-003: folder tree expands and collapses
  it("expands a folder to reveal children and collapses on re-click", async () => {
    const user = userEvent.setup();
    mocks.useFiles.mockReturnValue({
      data: [folder, childFile, rootFile],
      isLoading: false,
      isError: false,
    });
    renderDrive();

    // Child file is not visible before expanding
    expect(screen.queryByRole("button", { name: "index.ts" })).not.toBeInTheDocument();

    // Expand the folder
    await user.click(screen.getByRole("button", { name: "src" }));
    expect(screen.getByRole("button", { name: "index.ts" })).toBeInTheDocument();

    // Collapse the folder
    await user.click(screen.getByRole("button", { name: "src" }));
    expect(screen.queryByRole("button", { name: "index.ts" })).not.toBeInTheDocument();
  });

  // VAL-DRIVE-004: displays file metadata (name, type/size, createdAt)
  it("displays file metadata in the detail panel when a file is selected", async () => {
    const user = userEvent.setup();
    mocks.useFiles.mockReturnValue({
      data: [rootFile],
      isLoading: false,
      isError: false,
    });
    renderDrive();

    await user.click(screen.getByRole("button", { name: "README.md" }));

    // Detail panel shows metadata
    const detail = screen.getByTestId("file-detail");
    expect(within(detail).getByText("README.md")).toBeInTheDocument();
    expect(within(detail).getByText(/text\/markdown/)).toBeInTheDocument();
    expect(within(detail).getByText(/512/)).toBeInTheDocument();
  });

  // VAL-DRIVE-012: file selection
  it("marks a file as selected and updates when selecting a different file", async () => {
    const user = userEvent.setup();
    const fileA = { ...rootFile, id: "file-a", name: "alpha.ts", mimeType: "text/typescript" };
    const fileB = { ...rootFile, id: "file-b", name: "beta.ts", mimeType: "text/typescript" };
    mocks.useFiles.mockReturnValue({
      data: [fileA, fileB],
      isLoading: false,
      isError: false,
    });
    renderDrive();

    // Select first file — detail panel shows its name
    await user.click(screen.getByRole("button", { name: "alpha.ts" }));
    let detail = screen.getByTestId("file-detail");
    expect(within(detail).getByText("alpha.ts")).toBeInTheDocument();

    // Select second file — selection updates
    await user.click(screen.getByRole("button", { name: "beta.ts" }));
    detail = screen.getByTestId("file-detail");
    expect(within(detail).getByText("beta.ts")).toBeInTheDocument();
  });

  // VAL-DRIVE-010: renders empty state
  it("renders an empty state when the project has no files", () => {
    mocks.useFiles.mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    });
    renderDrive();

    expect(screen.getByText("No files in this project")).toBeInTheDocument();
  });

  // VAL-DRIVE-006/VAL-DRIVE-010: renders loading state
  it("renders a loading indicator while files are being fetched", () => {
    mocks.useFiles.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    renderDrive();

    expect(screen.getByRole("status", { name: "Loading project files" })).toBeInTheDocument();
  });

  // VAL-DRIVE-007/VAL-DRIVE-010: renders error state
  it("renders an error state with retry when the files request fails", async () => {
    mocks.useFiles.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mocks.refetch,
    });
    renderDrive();

    expect(screen.getByText("Files could not be loaded")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  // VAL-DRIVE-011: files query cache key includes project ID
  it("produces distinct query keys for different project IDs and unscoped files", async () => {
    // Use the real hooks (bypass the component-level mock) with a mocked api
    const realHooks = await vi.importActual<typeof import("../src/lib/hooks")>(
      "../src/lib/hooks",
    );
    const realApi = await vi.importActual<typeof import("../src/lib/api")>(
      "../src/lib/api",
    );
    const getFilesSpy = vi.spyOn(realApi, "getFiles").mockResolvedValue([]);

    function makeWrapper() {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      );
      return { queryClient, wrapper };
    }

    // Project A
    let { queryClient, wrapper } = makeWrapper();
    renderHook(() => realHooks.useFiles("company-1", undefined, { projectId: "project-a" }), { wrapper });
    await waitFor(() => {
      expect(queryClient.getQueryState(["files", "company-1", null, { projectId: "project-a" }]))
        .toBeDefined();
    });

    // Project B
    ({ queryClient, wrapper } = makeWrapper());
    renderHook(() => realHooks.useFiles("company-1", undefined, { projectId: "project-b" }), { wrapper });
    await waitFor(() => {
      expect(queryClient.getQueryState(["files", "company-1", null, { projectId: "project-b" }]))
        .toBeDefined();
    });

    // Unscoped
    ({ queryClient, wrapper } = makeWrapper());
    renderHook(() => realHooks.useFiles("company-1", undefined), { wrapper });
    await waitFor(() => {
      expect(queryClient.getQueryState(["files", "company-1", null, null]))
        .toBeDefined();
    });

    // The three keys are distinct
    const keyA = ["files", "company-1", null, { projectId: "project-a" }];
    const keyB = ["files", "company-1", null, { projectId: "project-b" }];
    const keyUnscoped = ["files", "company-1", null, null];
    expect(JSON.stringify(keyA)).not.toBe(JSON.stringify(keyB));
    expect(JSON.stringify(keyA)).not.toBe(JSON.stringify(keyUnscoped));
    expect(JSON.stringify(keyB)).not.toBe(JSON.stringify(keyUnscoped));

    getFilesSpy.mockRestore();
  });
});
