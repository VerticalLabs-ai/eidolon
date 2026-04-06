import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Command } from "cmdk";
import {
  LayoutDashboard,
  Bot,
  ListTodo,
  Target,
  BarChart3,
  Settings,
  Search,
  Network,
  Globe,
  BookOpen,
  FileText,
  Plug,
  Inbox,
  FolderOpen,
} from "lucide-react";
import { useAgents, useTasks } from "@/lib/hooks";

const navCommands = [
  { label: "Dashboard", icon: LayoutDashboard, path: "" },
  { label: "Inbox", icon: Inbox, path: "/inbox" },
  { label: "Issues", icon: ListTodo, path: "/issues" },
  { label: "Goals", icon: Target, path: "/goals" },
  { label: "Agent Directory", icon: Bot, path: "/agents" },
  { label: "Org Chart", icon: Network, path: "/org-chart" },
  { label: "Workspace", icon: Globe, path: "/workspace" },
  { label: "Documents", icon: BookOpen, path: "/documents" },
  { label: "Prompt Studio", icon: FileText, path: "/prompts" },
  { label: "Projects", icon: FolderOpen, path: "/projects" },
  { label: "Analytics", icon: BarChart3, path: "/analytics" },
  { label: "Integrations", icon: Plug, path: "/integrations" },
  { label: "Settings", icon: Settings, path: "/settings" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { companyId } = useParams();
  const navigate = useNavigate();
  const { data: agents } = useAgents(companyId);
  const { data: tasks } = useTasks(companyId);
  const base = `/company/${companyId}`;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100]">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
      />
      <div className="relative mx-auto mt-[15vh] w-full max-w-lg">
        <Command
          className="rounded-xl border border-white/[0.08] bg-surface-overlay shadow-2xl overflow-hidden"
          label="Command palette"
        >
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4">
            <Search className="h-4 w-4 text-text-secondary shrink-0" />
            <Command.Input
              placeholder="Search pages, agents, issues..."
              className="h-12 w-full bg-transparent text-sm text-text-primary placeholder:text-text-secondary outline-none"
            />
            <kbd className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
              ESC
            </kbd>
          </div>

          <Command.List className="max-h-80 overflow-y-auto p-2">
            <Command.Empty className="py-8 text-center text-sm text-text-secondary">
              No results found.
            </Command.Empty>

            <Command.Group
              heading="Pages"
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-text-secondary"
            >
              {navCommands.map((cmd) => (
                <Command.Item
                  key={cmd.path}
                  value={cmd.label}
                  onSelect={() => {
                    navigate(`${base}${cmd.path}`);
                    setOpen(false);
                  }}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-secondary cursor-pointer data-[selected=true]:bg-accent/[0.08] data-[selected=true]:text-accent transition-colors"
                >
                  <cmd.icon className="h-4 w-4 shrink-0" />
                  {cmd.label}
                </Command.Item>
              ))}
            </Command.Group>

            {agents && agents.length > 0 && (
              <Command.Group
                heading="Agents"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-text-secondary"
              >
                {agents.slice(0, 8).map((agent) => (
                  <Command.Item
                    key={agent.id}
                    value={`${agent.name} ${agent.role} ${agent.title ?? ""}`}
                    onSelect={() => {
                      navigate(`${base}/agents/${agent.id}`);
                      setOpen(false);
                    }}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-secondary cursor-pointer data-[selected=true]:bg-accent/[0.08] data-[selected=true]:text-accent transition-colors"
                  >
                    <Bot className="h-4 w-4 shrink-0" />
                    <span>{agent.name}</span>
                    <span className="text-text-muted text-xs ml-auto">
                      {agent.role}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {tasks && tasks.length > 0 && (
              <Command.Group
                heading="Issues"
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-text-secondary"
              >
                {tasks.slice(0, 8).map((task) => (
                  <Command.Item
                    key={task.id}
                    value={`${task.identifier ?? ""} ${task.title}`}
                    onSelect={() => {
                      navigate(`${base}/tasks/${task.id}`);
                      setOpen(false);
                    }}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-text-secondary cursor-pointer data-[selected=true]:bg-accent/[0.08] data-[selected=true]:text-accent transition-colors"
                  >
                    <ListTodo className="h-4 w-4 shrink-0" />
                    <span className="truncate">{task.title}</span>
                    <span className="text-text-muted text-xs ml-auto shrink-0">
                      {task.identifier}
                    </span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
