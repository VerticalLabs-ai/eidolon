import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { useCompanies, useInbox, useProjects } from "@/lib/hooks";
import { useWebSocket } from "@/lib/ws";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  BookOpen,
  Bot,
  FileText,
  Globe,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Network,
  Plug,
  Plus,
  Settings,
  ShieldCheck,
  Target,
  X,
  Zap,
} from "lucide-react";
import { NavLink, useNavigate, useParams } from "react-router-dom";

// ── Types ───────────────────────────────────────────────────────────────

interface SidebarProps {
  companyName?: string;
  open: boolean;
  onClose: () => void;
}

interface NavItem {
  to: string;
  icon: LucideIcon;
  label: string;
  end?: boolean;
  /** Optional key that lets an ambient badge count attach to this item. */
  badgeKey?: "inbox";
}

interface NavSection {
  label: string;
  items: NavItem[];
}

// ── Navigation structure ────────────────────────────────────────────────

const navSections: NavSection[] = [
  {
    label: "Main",
    items: [
      { to: "", icon: LayoutDashboard, label: "Dashboard", end: true },
      { to: "/inbox", icon: Inbox, label: "Inbox", badgeKey: "inbox" },
    ],
  },
  {
    label: "Work",
    items: [
      { to: "/issues", icon: ListTodo, label: "Issues" },
      { to: "/goals", icon: Target, label: "Goals" },
    ],
  },
  {
    label: "Agents",
    items: [
      { to: "/agents", icon: Bot, label: "Agent Directory" },
      { to: "/org-chart", icon: Network, label: "Org Chart" },
      { to: "/workspace", icon: Globe, label: "Workspace" },
    ],
  },
  {
    label: "Knowledge",
    items: [
      { to: "/documents", icon: BookOpen, label: "Documents" },
      { to: "/prompts", icon: FileText, label: "Prompt Studio" },
    ],
  },
  {
    label: "Operations",
    items: [
      { to: "/analytics", icon: BarChart3, label: "Analytics" },
      { to: "/approvals", icon: ShieldCheck, label: "Approvals" },
      { to: "/integrations", icon: Plug, label: "Integrations" },
      { to: "/settings", icon: Settings, label: "Settings" },
    ],
  },
];

// ── Company Icon Rail ───────────────────────────────────────────────────

function CompanyIconRail() {
  const { companyId } = useParams();
  const navigate = useNavigate();
  const { data: companies } = useCompanies();

  const defaultColors = [
    "#F0B429",
    "#4C51BF",
    "#38B2AC",
    "#ED64A6",
    "#ED8936",
    "#48BB78",
    "#667EEA",
    "#FC8181",
  ];

  function getColor(company: { brandColor: string | null }, index: number) {
    return company.brandColor || defaultColors[index % defaultColors.length];
  }

  return (
    <div className="flex h-full w-12 shrink-0 flex-col items-center border-r border-white/[0.06] bg-surface/60 py-3 gap-2">
      {/* Eidolon logo at top */}
      <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-accent/15">
        <Zap className="h-4 w-4 text-accent" />
      </div>

      {/* Company icons */}
      <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto scrollbar-none">
        {companies?.map((company, index) => {
          const color = getColor(company, index);
          const isActive = company.id === companyId;
          const initial = company.name.charAt(0).toUpperCase();

          return (
            <button
              key={company.id}
              onClick={() => navigate(`/company/${company.id}`)}
              title={company.name}
              className={clsx(
                "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold transition-all duration-300 cursor-pointer",
                isActive
                  ? "ring-2 ring-accent ring-offset-2 ring-offset-surface scale-105"
                  : "hover:scale-105 hover:brightness-125",
              )}
              style={{
                backgroundColor: `${color}20`,
                color: color,
              }}
            >
              {initial}
            </button>
          );
        })}
      </div>

      {/* Add company button */}
      <button
        onClick={() => navigate("/")}
        title="Add new company"
        className="mt-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-dashed border-white/[0.12] text-text-secondary hover:text-accent hover:border-accent/40 hover:bg-accent/[0.05] transition-all duration-300 cursor-pointer"
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

// ── Projects Section ────────────────────────────────────────────────────

function ProjectsSection({ base, onClose }: { base: string; onClose: () => void }) {
  const { companyId } = useParams();
  const { data: projects } = useProjects(companyId);

  return (
    <div>
      <div className="flex items-center justify-between px-3 mb-1">
        <p className="text-[10px] font-medium uppercase tracking-wider text-text-secondary font-display">
          Projects
        </p>
        <button
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-text-secondary hover:text-accent hover:bg-accent/[0.05] transition-all duration-200 cursor-pointer"
          title="New project"
        >
          <Plus className="h-3 w-3" />
          <span>New</span>
        </button>
      </div>
      <div className="space-y-0.5">
        {projects?.map((project) => (
          <NavLink
            key={project.id}
            to={`${base}/projects/${project.id}`}
            onClick={onClose}
            className={({ isActive }) =>
              clsx(
                "group relative flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-all duration-300",
                isActive
                  ? "text-accent bg-accent/[0.08]"
                  : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-r-full bg-accent" />
                )}
                <span className="h-1.5 w-1.5 rounded-full bg-current opacity-50 shrink-0" />
                <span className="truncate">{project.name}</span>
              </>
            )}
          </NavLink>
        ))}
        {(!projects || projects.length === 0) && (
          <p className="px-3 py-1.5 text-[11px] text-text-secondary/60 italic">
            No projects yet
          </p>
        )}
      </div>
    </div>
  );
}

// ── Main Sidebar ────────────────────────────────────────────────────────

// ── Hook: unread-count lookup per badgeKey ──────────────────────────────
//
// Reads the inbox feed plus the same localStorage read-state key Inbox.tsx
// writes to, so the sidebar dot updates without any shared state service.

function useInboxUnreadCount(companyId: string | undefined): number {
  const { data } = useInbox(companyId);
  const [readSet, setReadSet] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!companyId) return;
    // Match the key layout in Inbox.tsx — anon user is a fallback since
    // better-auth session may not be resolved yet on first render.
    const load = () => {
      try {
        const keys = Object.keys(localStorage).filter(
          (k) =>
            k.startsWith("eidolon:inbox:read:") &&
            k.endsWith(`:${companyId}`),
        );
        const merged = new Set<string>();
        for (const k of keys) {
          const raw = localStorage.getItem(k);
          if (!raw) continue;
          try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
              for (const id of parsed) {
                if (typeof id === "string") merged.add(id);
              }
            }
          } catch {
            // skip
          }
        }
        setReadSet(merged);
      } catch {
        // skip
      }
    };

    load();
    const handler = (e: StorageEvent) => {
      if (e.key?.startsWith("eidolon:inbox:read:")) load();
    };
    window.addEventListener("storage", handler);
    // Also poll occasionally — localStorage "storage" only fires cross-tab.
    const interval = window.setInterval(load, 5000);
    return () => {
      window.removeEventListener("storage", handler);
      window.clearInterval(interval);
    };
  }, [companyId]);

  if (!data?.data) return 0;
  return data.data.filter((item) => !readSet.has(item.id)).length;
}

export function Sidebar({ companyName, open, onClose }: SidebarProps) {
  const { companyId } = useParams();
  const base = `/company/${companyId}`;
  const { status } = useWebSocket(companyId);
  const inboxUnread = useInboxUnreadCount(companyId);
  const badges: Record<NonNullable<NavItem["badgeKey"]>, number> = {
    inbox: inboxUnread,
  };

  return (
    <>
      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar shell: icon rail + nav panel */}
      <div
        className={clsx(
          "fixed inset-y-0 left-0 z-50 flex transition-transform duration-300 lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Company icon rail */}
        <CompanyIconRail />

        {/* Main navigation panel */}
        <aside className="flex w-[212px] flex-col glass border-r border-white/[0.06]">
          {/* Header */}
          <div className="flex h-14 items-center justify-between border-b border-white/[0.06] px-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold text-text-primary font-display tracking-wide">
                {companyName || "EIDOLON"}
              </p>
              <p className="text-[10px] text-text-secondary">AI Company Runtime</p>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1 text-text-secondary hover:text-accent hover:bg-white/[0.05] transition-all duration-200 lg:hidden cursor-pointer"
              aria-label="Close sidebar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Scrollable navigation */}
          <nav className="flex-1 overflow-y-auto p-3 space-y-4">
            {/* Main + Inbox section */}
            {navSections.slice(0, 1).map((section) => (
              <NavSectionGroup
                key={section.label}
                section={section}
                base={base}
                onClose={onClose}
                badges={badges}
              />
            ))}

            {/* Projects section (dynamic) */}
            <ProjectsSection base={base} onClose={onClose} />

            {/* Remaining sections */}
            {navSections.slice(1).map((section) => (
              <NavSectionGroup
                key={section.label}
                section={section}
                base={base}
                onClose={onClose}
                badges={badges}
              />
            ))}
          </nav>

          {/* Footer */}
          <div className="border-t border-white/[0.06] p-3">
            <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2.5">
              <p className="text-[10px] font-medium uppercase tracking-wider text-text-secondary font-display">
                Eidolon v{import.meta.env.VITE_APP_VERSION}
              </p>
              <StatusIndicator
                status={status === "connected" ? "connected" : "disconnected"}
                size="sm"
              />
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}

// ── Section Group Component ─────────────────────────────────────────────

const navContainerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.03 },
  },
};

const navItemVariants = {
  hidden: { opacity: 0, x: -8 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.2, ease: "easeOut" as const },
  },
};

function NavSectionGroup({
  section,
  base,
  onClose,
  badges,
}: {
  section: NavSection;
  base: string;
  onClose: () => void;
  badges?: Record<NonNullable<NavItem["badgeKey"]>, number>;
}) {
  return (
    <div>
      <p className="px-3 mb-1 text-[10px] font-medium uppercase tracking-wider text-text-secondary font-display">
        {section.label}
      </p>
      <motion.div
        className="space-y-0.5"
        variants={navContainerVariants}
        initial="hidden"
        animate="visible"
      >
        {section.items.map((item) => {
          const count = item.badgeKey ? badges?.[item.badgeKey] ?? 0 : 0;
          return (
            <motion.div key={item.to} variants={navItemVariants}>
              <NavLink
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
                    <span className="flex-1">{item.label}</span>
                    {count > 0 && (
                      <span
                        className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-accent/90 px-1 text-[10px] font-semibold text-surface"
                        aria-label={`${count} unread`}
                      >
                        {count > 99 ? "99+" : count}
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            </motion.div>
          );
        })}
      </motion.div>
    </div>
  );
}
