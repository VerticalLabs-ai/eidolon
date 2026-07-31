import { useCallback, useEffect, useRef, useState } from "react";
import { Outlet, useParams } from "react-router-dom";
import { Menu } from "lucide-react";
import { Toaster } from "sonner";
import { Sidebar } from "./Sidebar";
import { useCompany } from "@/lib/hooks";
import { useWebSocket } from "@/lib/ws";
import { useEventToasts } from "@/lib/toasts";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { CommandPalette } from "@/components/ui/CommandPalette";
import { ProjectCreationProvider } from "@/components/projects/ProjectCreationProvider";

export function AppShell() {
  const { companyId } = useParams();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const sidebarWasOpenRef = useRef(false);
  const { data: company } = useCompany(companyId);
  const { status } = useWebSocket(companyId);

  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useEffect(() => {
    const wasOpen = sidebarWasOpenRef.current;
    sidebarWasOpenRef.current = sidebarOpen;
    if (!wasOpen || sidebarOpen) return;

    const timeout = window.setTimeout(() => {
      const active = document.activeElement;
      const openDialog = document.querySelector("dialog[open]");
      if (active && openDialog?.contains(active)) return;
      if (
        !active
        || active === document.body
        || (active instanceof Element && active.closest("#app-sidebar"))
      ) {
        menuButtonRef.current?.focus({ preventScroll: true });
      }
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [sidebarOpen]);

  // Wire WebSocket events to toast notifications
  useEventToasts(companyId);

  return (
    <ProjectCreationProvider companyId={companyId!}>
      <div className="flex h-dvh bg-surface">
        <CommandPalette />
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: "#111111",
              border: "1px solid rgba(255,255,255,0.08)",
              color: "#e8eaed",
              fontSize: "13px",
            },
          }}
        />
        <Sidebar
          companyName={company?.name}
          open={sidebarOpen}
          onClose={closeSidebar}
        />

        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.04] bg-surface/80 px-4 backdrop-blur-md sm:px-6">
            <div className="flex items-center gap-3">
              <button
                ref={menuButtonRef}
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-white/[0.05] hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 lg:hidden"
                aria-label="Open sidebar"
                aria-controls="app-sidebar"
                aria-expanded={sidebarOpen}
                data-project-creation-focus-fallback
              >
                <Menu className="h-5 w-5" />
              </button>
              <h1 className="text-sm font-semibold text-text-primary font-display">
                {company?.name || "Loading..."}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              <StatusIndicator
                status={
                  status === "connected"
                    ? "connected"
                    : status === "disabled"
                      ? "idle"
                      : "disconnected"
                }
                label={status === "disabled" ? "polling" : status}
                size="sm"
              />
            </div>
          </header>

          <main
            className="grid-bg flex-1 overflow-y-auto"
            data-project-creation-focus-fallback
            tabIndex={-1}
          >
            <Outlet />
          </main>
        </div>
      </div>
    </ProjectCreationProvider>
  );
}
