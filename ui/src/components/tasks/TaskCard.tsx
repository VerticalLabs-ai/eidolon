import { useNavigate } from "react-router-dom";
import {
  Code,
  Bug,
  Search,
  Settings,
  MessageSquare,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import type { Task } from "@/lib/api";
import { clsx } from "clsx";
import type { ReactNode } from "react";

interface TaskCardProps {
  task: Task;
  companyId: string;
  compact?: boolean;
}

const typeIcons: Record<string, ReactNode> = {
  feature: <Code className="h-3.5 w-3.5" />,
  bug: <Bug className="h-3.5 w-3.5" />,
  chore: <Settings className="h-3.5 w-3.5" />,
  spike: <Search className="h-3.5 w-3.5" />,
  epic: <MessageSquare className="h-3.5 w-3.5" />,
};

const priorityIcons: Record<string, ReactNode> = {
  critical: <AlertTriangle className="h-3 w-3" />,
  high: <ArrowUp className="h-3 w-3" />,
  medium: <Minus className="h-3 w-3" />,
  low: <ArrowDown className="h-3 w-3" />,
};

const priorityVariant: Record<string, "critical" | "high" | "medium" | "low"> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
};

export function TaskCard({ task, companyId, compact }: TaskCardProps) {
  const navigate = useNavigate();

  return (
    <div
      onClick={() => navigate(`/company/${companyId}/tasks/${task.id}`)}
      className={clsx(
        "group rounded-lg border border-border bg-surface-raised transition-all duration-150 hover:border-eidolon-500/30 hover:bg-surface-overlay cursor-pointer",
        compact ? "p-3" : "p-4",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 text-text-secondary">{typeIcons[task.type] ?? <Code className="h-3.5 w-3.5" />}</span>
        <div className="min-w-0 flex-1">
          <p
            className={clsx(
              "font-medium text-text-primary group-hover:text-eidolon-200 transition-colors leading-snug",
              compact ? "text-xs" : "text-sm",
            )}
          >
            {task.title}
          </p>
          {!compact && task.description && (
            <p className="mt-1 text-xs text-text-secondary line-clamp-2">
              {task.description}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Badge variant={priorityVariant[task.priority] ?? "medium"}>
            {priorityIcons[task.priority] ?? <Minus className="h-3 w-3" />}
            {task.priority}
          </Badge>
        </div>
        {task.assigneeAgentId && (
          <div className="flex items-center gap-1.5">
            <div className="h-5 w-5 rounded-full bg-eidolon-500/20 flex items-center justify-center text-[10px] font-medium text-eidolon-200">
              A
            </div>
            <span className="text-xs text-text-secondary">{task.identifier ?? task.assigneeAgentId.slice(0, 8)}</span>
          </div>
        )}
      </div>
    </div>
  );
}
