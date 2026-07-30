import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  ProjectCreationProvider,
  useProjectCreation,
} from "../src/components/projects/ProjectCreationProvider";

vi.mock("@/components/projects/CreateProjectModal", () => ({
  CreateProjectModal: ({
    open,
    onClose,
    onCreated,
  }: {
    open: boolean;
    onClose: () => void;
    onCreated: (project: { id: string }) => void;
  }) => open ? (
    <>
      <button onClick={onClose}>Cancel project creation</button>
      <button onClick={() => onCreated({ id: "project-1" })}>Finish project creation</button>
    </>
  ) : null,
}));

function ProjectCreationHarness() {
  const { openProjectCreation } = useProjectCreation();
  const location = useLocation();
  return (
    <>
      <button onClick={(event) => openProjectCreation(event.currentTarget)}>
        Open project creation
      </button>
      <button data-project-creation-focus-fallback>Visible fallback</button>
      <output aria-label="Current route">{location.pathname}</output>
    </>
  );
}

describe("ProjectCreationProvider", () => {
  it("owns one shared flow and navigates to the canonical project after success", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/company/company-1/projects"]}>
        <ProjectCreationProvider companyId="company-1">
          <ProjectCreationHarness />
        </ProjectCreationProvider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Open project creation" }));
    await user.click(screen.getByRole("button", { name: "Finish project creation" }));

    expect(screen.getByLabelText("Current route"))
      .toHaveTextContent("/company/company-1/projects/project-1");
  });

  it("restores focus to the visible trigger after cancellation", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/company/company-1/projects"]}>
        <ProjectCreationProvider companyId="company-1">
          <ProjectCreationHarness />
        </ProjectCreationProvider>
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", { name: "Open project creation" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 32,
      top: 20,
      right: 140,
      bottom: 52,
      left: 20,
    } as DOMRect);
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel project creation" }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("uses a visible fallback when the trigger moves off screen", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/company/company-1/projects"]}>
        <ProjectCreationProvider companyId="company-1">
          <ProjectCreationHarness />
        </ProjectCreationProvider>
      </MemoryRouter>,
    );

    const trigger = screen.getByRole("button", { name: "Open project creation" });
    const fallback = screen.getByRole("button", { name: "Visible fallback" });
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 32,
      top: 20,
      right: 0,
      bottom: 52,
      left: -120,
    } as DOMRect);
    vi.spyOn(fallback, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 32,
      top: 20,
      right: 140,
      bottom: 52,
      left: 20,
    } as DOMRect);

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Cancel project creation" }));

    await waitFor(() => expect(fallback).toHaveFocus());
  });
});
