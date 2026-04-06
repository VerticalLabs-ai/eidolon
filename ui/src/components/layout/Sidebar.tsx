import { NavLink, useParams } from "react-router-dom";
import { clsx } from "clsx";
import {
  LayoutDashboard,
  Bot,
  ListTodo,
  Target,
  Network,
  MessageCircle,
  MessageSquare,
  BarChart3,
  Settings,
  Zap,
  X,
  Globe,
  BookOpen,
  FolderOpen,
  Plug,
  FileText,
  Trophy,
} from "lucide-react";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { useWebSocket } from "@/lib/ws";

interface SidebarProps {
  companyName?: string;
  open: boolean;
  onClose: () => void;
}

const navItems = [
  { to: "", icon: LayoutDashboard, label: "Dashboard", end: true },
  { to: "/chat", icon: MessageCircle, label: "Board Chat" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/tasks", icon: ListTodo, label: "Tasks" },
  { to: "/goals", icon: Target, label: "Goals" },
  { to: "/org-chart", icon: Network, label: "Org Chart" },
  { to: "/messages", icon: MessageSquare, label: "Messages" },
  { to: "/knowledge", icon: BookOpen, label: "Knowledge" },
  { to: "/files", icon: FolderOpen, label: "Files" },
  { to: "/integrations", icon: Plug, label: "Integrations" },
  { to: "/prompts", icon: FileText, label: "Prompt Studio" },
  { to: "/performance", icon: Trophy, label: "Performance" },
  { to: "/workspace", icon: Globe, label: "Workspace" },
  { to: "/analytics", icon: BarChart3, label: "Analytics" },
  { to: "/settings", icon: Settings, label: "Settings" },
];

export function Sidebar({ companyName, open, onClose }: SidebarProps) {
  const { companyId } = useParams();
  const base = `/company/${companyId}`;
  const { status } = useWebSocket(companyId);

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-50 flex w-60 flex-col glass border-r border-white/[0.06] transition-transform duration-300 lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Logo / Header */}
        <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/15">
              <Zap className="h-4 w-4 text-accent" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-text-primary font-display tracking-wide">
                {companyName || "EIDOLON"}
              </p>
              <p className="text-[10px] text-text-secondary">AI Company Runtime</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-text-secondary hover:text-accent hover:bg-white/[0.05] transition-all duration-200 lg:hidden cursor-pointer"
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={`${base}${item.to}`}
              end={item.end}
              onClick={onClose}
              className={({ isActive }) =>
                clsx(
                  "group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-300",
                  isActive
                    ? "text-accent bg-accent/[0.08]"
                    : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[2px] rounded-r-full bg-accent" />
                  )}
                  <item.icon
                    className={clsx(
                      "h-4 w-4 shrink-0 transition-colors duration-200",
                      isActive && "text-accent",
                    )}
                  />
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Footer with connection status */}
        <div className="border-t border-white/[0.06] p-3">
          <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2.5">
            <p className="text-[10px] font-medium uppercase tracking-wider text-text-secondary font-display">
              Eidolon v0.1.0
            </p>
            <StatusIndicator
              status={status === "connected" ? "connected" : "disconnected"}
              size="sm"
            />
          </div>
        </div>
      </aside>
    </>
  );
}
