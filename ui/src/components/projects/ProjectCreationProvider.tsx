import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { CreateProjectModal } from "./CreateProjectModal";

interface ProjectCreationContextValue {
  openProjectCreation: (trigger?: HTMLElement) => void;
}

const ProjectCreationContext = createContext<ProjectCreationContextValue | null>(null);

function isVisibleFocusTarget(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0
    && rect.height > 0
    && rect.right > 0
    && rect.bottom > 0
    && rect.left < window.innerWidth
    && rect.top < window.innerHeight
  );
}

export function ProjectCreationProvider({
  children,
  companyId,
}: {
  children: ReactNode;
  companyId: string;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const value = useMemo(
    () => ({
      openProjectCreation: (trigger?: HTMLElement) => {
        triggerRef.current = trigger ?? null;
        setOpen(true);
      },
    }),
    [],
  );

  function handleClose() {
    setOpen(false);
    window.setTimeout(() => {
      const trigger = triggerRef.current;
      const fallback = Array.from(
        document.querySelectorAll<HTMLElement>("[data-project-creation-focus-fallback]"),
      ).find(isVisibleFocusTarget);
      const target = trigger?.isConnected && isVisibleFocusTarget(trigger)
        ? trigger
        : fallback;
      target?.focus({ preventScroll: true });
    }, 0);
  }

  return (
    <ProjectCreationContext.Provider value={value}>
      {children}
      <CreateProjectModal
        open={open}
        companyId={companyId}
        onClose={handleClose}
        onCreated={(project) => navigate(`/company/${companyId}/projects/${project.id}`)}
      />
    </ProjectCreationContext.Provider>
  );
}

export function useProjectCreation() {
  const context = useContext(ProjectCreationContext);
  if (!context) {
    throw new Error("useProjectCreation must be used within ProjectCreationProvider");
  }
  return context;
}
