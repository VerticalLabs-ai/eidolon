import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/layout/AppShell";

vi.mock("@/components/layout/Sidebar", () => ({
  Sidebar: ({ open, onClose }: { open: boolean; onClose: () => void }) => (
    <aside id="app-sidebar" aria-label="Primary navigation" data-open={open}>
      <button type="button" onClick={onClose}>Close sidebar</button>
    </aside>
  ),
}));

vi.mock("@/components/projects/ProjectCreationProvider", () => ({
  ProjectCreationProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("@/lib/hooks", () => ({
  useCompany: () => ({ data: { name: "Eidolon QA Lab" } }),
  useSearch: () => ({ data: { results: [], total: 0, query: "" } }),
}));
vi.mock("@/lib/ws", () => ({ useWebSocket: () => ({ status: "disabled" }) }));
vi.mock("@/lib/toasts", () => ({ useEventToasts: () => undefined }));

describe("AppShell responsive navigation", () => {
  it("uses one drawer navigation without a mobile bottom dock", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/company/company-1"]}>
        <Routes>
          <Route path="/company/:companyId" element={<AppShell />}>
            <Route index element={<div>Workspace content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    const menuButton = screen.getByRole("button", { name: "Open sidebar" });
    const main = screen.getByRole("main");
    expect(menuButton).toHaveAttribute("aria-controls", "app-sidebar");
    expect(menuButton).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
    expect(main).not.toHaveClass("pb-20");

    await user.click(menuButton);
    expect(menuButton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Primary navigation" })).toHaveAttribute(
      "data-open",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Close sidebar" }));
    await waitFor(() => expect(menuButton).toHaveFocus());
  });
});
