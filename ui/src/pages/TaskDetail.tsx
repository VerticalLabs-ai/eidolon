import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  User,
  GitBranch,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTask, useUpdateTask } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { Task } from "@/lib/api";

const statusFlow: string[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
];

const statusLabels: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
};

const statusVariant: Record<string, "default" | "info" | "warning" | "success"> = {
  backlog: "default",
  todo: "info",
  in_progress: "warning",
  in_review: "info",
  done: "success",
};

const priorityGlow: Record<string, string> = {
  critical: "shadow-error/30",
  high: "shadow-warning/20",
  medium: "shadow-neon-cyan/15",
  low: "",
};

export function TaskDetail() {
  const { companyId, taskId } = useParams();
  const { data: task, isLoading } = useTask(companyId, taskId);
  const updateTask = useUpdateTask(companyId!);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-6 lg:p-8">
        <div className="h-64 animate-pulse rounded-xl glass" />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-text-secondary">
        Task not found
      </div>
    );
  }

  const currentIndex = statusFlow.indexOf(task.status);

  return (
    <div className="mx-auto max-w-3xl p-6 lg:p-8 space-y-8">
      <Link
        to={`/company/${companyId}/tasks`}
        className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-neon-cyan transition-colors duration-200"
      >
        <ArrowLeft className="h-4 w-4" />
        All Tasks
      </Link>

      {/* Header */}
      <div className={`glass rounded-xl p-6 ${priorityGlow[task.priority] ? `shadow-lg ${priorityGlow[task.priority]}` : ""}`}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Badge variant={statusVariant[task.status] ?? "default"}>
            {statusLabels[task.status] ?? task.status}
          </Badge>
          <Badge variant={task.priority as "critical" | "high" | "medium" | "low"}>
            {task.priority}
          </Badge>
          <Badge variant="default">{task.type}</Badge>
        </div>
        <h1 className="font-display text-2xl font-bold text-text-primary">{task.title}</h1>
        {task.description && (
          <p className="mt-3 text-sm text-text-secondary leading-relaxed">
            {task.description}
          </p>
        )}
      </div>

      {/* Status change buttons */}
      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Status
          </h3>
        </div>
        <div className="p-6 flex flex-wrap gap-3">
          {statusFlow.map((s, i) => (
            <button
              key={s}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 cursor-pointer ${
                s === task.status
                  ? "bg-accent text-surface shadow-lg shadow-accent/20"
                  : "glass-raised text-text-secondary hover:text-text-primary hover:border-neon-cyan/30"
              }`}
              onClick={() => {
                if (s !== task.status) {
                  updateTask.mutate({ taskId: task.id, data: { status: s } });
                }
              }}
              disabled={updateTask.isPending}
            >
              {statusLabels[s] ?? s}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Assignment */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Assignment
            </h3>
          </div>
          <div className="p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neon-cyan/10">
                <User className="h-5 w-5 text-neon-cyan" />
              </div>
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {task.assigneeAgentId ? `Agent ${task.assigneeAgentId.slice(0, 8)}...` : "Unassigned"}
                </p>
                <p className="text-xs text-text-secondary">
                  {task.assigneeAgentId ? "Assigned Agent" : "No assignee"}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Meta */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Details
            </h3>
          </div>
          <div className="p-6 space-y-4">
            <div className="flex items-center gap-3 text-sm">
              <Clock className="h-4 w-4 text-neon-cyan/60" />
              <span className="text-text-secondary">Created</span>
              <span className="ml-auto text-text-primary font-display tabular-nums">
                {formatDistanceToNow(new Date(task.createdAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Clock className="h-4 w-4 text-neon-purple/60" />
              <span className="text-text-secondary">Updated</span>
              <span className="ml-auto text-text-primary font-display tabular-nums">
                {formatDistanceToNow(new Date(task.updatedAt), {
                  addSuffix: true,
                })}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Dependencies */}
      {task.dependencies.length > 0 && (
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Dependencies
            </h3>
          </div>
          <div className="p-6 space-y-3">
            {task.dependencies.map((depId) => (
              <div
                key={depId}
                className="flex items-center gap-3 rounded-lg glass-raised p-3"
              >
                <GitBranch className="h-4 w-4 text-neon-purple" />
                <span className="text-sm text-text-secondary font-mono">
                  {depId}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Activity */}
      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Activity
          </h3>
        </div>
        <div className="p-6">
          <p className="py-4 text-center text-sm text-text-secondary">
            No activity yet
          </p>
        </div>
      </div>
    </div>
  );
}
