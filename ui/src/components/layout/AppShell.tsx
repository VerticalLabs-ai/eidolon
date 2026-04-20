import { useState } from "react";
import { Outlet, useParams, NavLink } from "react-router-dom";
import {
  Menu,
  LayoutDashboard,
  Bot,
  ListTodo,
  BarChart3,
  Settings,
} from "lucide-react";
import { clsx } from "clsx";
import { Toaster } from "sonner";
import { Sidebar } from "./Sidebar";
import { useCompany } from "@/lib/hooks";
import { useWebSocket } from "@/lib/ws";
import { useEventToasts } from "@/lib/toasts";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { CommandPalette } from "@/components/ui/CommandPalette";

const mobileNavItems = [
  { to: "", icon: LayoutDashboard, label: "Home", end: true },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/issues", icon: ListTodo, label: "Issues" },
  { to: "/analytics", icon: BarChart3, label: "Stats" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function AppShell() {
  const { companyId } = useParams();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { data: company } = useCompany(companyId);
  const { status } = useWebSocket(companyId);
  const base = `/company/${companyId}`;

  // Wire WebSocket events to toast notifications
  useEventToasts(companyId);

  return (
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
        onClose={() => setSidebarOpen(false)}
      />

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Minimal top bar */}
        <header className="flex h-12 items-center justify-between border-b border-white/[0.04] bg-surface/80 backdrop-blur-md px-4 lg:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              className="rounded-lg p-1.5 text-text-secondary hover:text-neon-cyan hover:bg-white/[0.05] transition-all duration-300 lg:hidden cursor-pointer"
              aria-label="Open sidebar"
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

        {/* Main content with grid background */}
        <main className="flex-1 overflow-y-auto pb-20 lg:pb-0 grid-bg">
          <Outlet />
        </main>

        {/* Mobile bottom nav - glass with neon active states */}
        <nav className="fixed bottom-0 left-0 right-0 z-30 flex h-16 items-center justify-around glass border-t border-white/[0.06] lg:hidden">
          {mobileNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={`${base}${item.to}`}
              end={item.end}
              className={({ isActive }) =>
                clsx(
                  "flex flex-col items-center gap-0.5 px-3 py-1.5 text-[10px] font-medium transition-all duration-300",
                  isActive
                    ? "text-neon-cyan drop-shadow-[0_0_8px_rgba(0,243,255,0.5)]"
                    : "text-text-secondary",
                )
              }
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
