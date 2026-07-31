import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "../src/components/layout/Sidebar";
import { ProjectList } from "../src/pages/ProjectList";

const mocks = vi.hoisted(() => ({
  openProjectCreation: vi.fn(),
}));

vi.mock("@/components/projects/ProjectCreationProvider", () => ({
  useProjectCreation: () => ({ openProjectCreation: mocks.openProjectCreation }),
}));

vi.mock("@/lib/hooks", () => ({
  useCompanies: () => ({ data: [] }),
  useInbox: () => ({ data: { meta: { unread: 0 } } }),
  useProjects: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/lib/ws", () => ({
  useWebSocket: () => ({ status: "disabled" }),
}));

describe("project creation controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
  });

  it("opens the shared workflow from the sidebar", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/company/company-1/projects"]}>
        <Routes>
          <Route
            path="/company/:companyId/projects"
            element={<Sidebar companyName="Test Company" open onClose={vi.fn()} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "New" }));
    expect(mocks.openProjectCreation).toHaveBeenCalledOnce();
  });

  it("opens the same workflow from header and empty-state controls", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/company/company-1/projects"]}>
        <Routes>
          <Route path="/company/:companyId/projects" element={<ProjectList />} />
        </Routes>
      </MemoryRouter>,
    );

    const buttons = screen.getAllByRole("button", { name: "New Project" });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[0]);
    await user.click(buttons[1]);
    expect(mocks.openProjectCreation).toHaveBeenCalledTimes(2);
  });

  it("closes the mobile drawer with Escape and restores page scrolling", () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <MemoryRouter initialEntries={["/company/company-1/goals"]}>
        <Routes>
          <Route
            path="/company/:companyId/goals"
            element={<Sidebar companyName="Test Company" open onClose={onClose} />}
          />
        </Routes>
      </MemoryRouter>,
    );

    expect(document.body.style.overflow).toBe("hidden");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    expect(document.body.style.overflow).toBe("");
  });
});
