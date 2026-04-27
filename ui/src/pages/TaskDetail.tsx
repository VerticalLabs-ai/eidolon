import { useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  GitBranch,
  MessageSquare,
  ShieldCheck,
  Activity,
  Pause,
  RotateCcw,
  XCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import {
  useAddTaskComment,
  useDecideApproval,
  useRespondTaskInteraction,
  useTask,
  useTaskSubtreeControls,
  useTaskThread,
  useUpdateTask,
} from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import type { TaskThreadItem } from "@/lib/api";

const statusFlow = ["backlog", "todo", "in_progress", "review", "done"];

const statusLabels: Record<string, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
  timed_out: "Timed Out",
};

const statusVariant: Record<string, "default" | "info" | "warning" | "success" | "error"> = {
  backlog: "default",
  todo: "info",
  in_progress: "warning",
  review: "info",
  done: "success",
  cancelled: "error",
  timed_out: "error",
};

const priorityGlow: Record<string, string> = {
  critical: "shadow-error/30",
  high: "shadow-warning/20",
  medium: "shadow-neon-cyan/15",
  low: "",
};

function formatRelative(iso: string) {
  return formatDistanceToNow(new Date(iso), { addSuffix: true });
}

function itemIcon(item: TaskThreadItem) {
  if (item.kind === "approval_link") return <ShieldCheck className="h-4 w-4" />;
  if (item.kind === "execution_event") return <Activity className="h-4 w-4" />;
  return <MessageSquare className="h-4 w-4" />;
}

export function TaskDetail() {
  const { companyId, taskId } = useParams();
  const { data: task, isLoading } = useTask(companyId, taskId);
  const { data: thread = [] } = useTaskThread(companyId, taskId);
  const updateTask = useUpdateTask(companyId!);
  const addComment = useAddTaskComment(companyId!);
  const respondInteraction = useRespondTaskInteraction(companyId!);
  const subtreeControls = useTaskSubtreeControls(companyId!);
  const decideApproval = useDecideApproval(companyId!);
  const [comment, setComment] = useState("");

  const sortedThread = useMemo(
    () =>
      [...thread].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [thread],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl p-6 lg:p-8">
        <div className="h-64 animate-pulse rounded-xl glass" />
      </div>
    );
  }

  if (!task || !companyId || !taskId) {
    return (
      <div className="flex items-center justify-center py-20 text-sm text-text-secondary">
        Task not found
      </div>
    );
  }

  const submitComment = () => {
    const content = comment.trim();
    if (!content) return;
    addComment.mutate(
      { taskId: task.id, content },
      { onSuccess: () => setComment("") },
    );
  };

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8 space-y-6">
      <Link
        to={`/company/${companyId}/issues`}
        className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-neon-cyan transition-colors duration-200"
      >
        <ArrowLeft className="h-4 w-4" />
        All Tasks
      </Link>

      <div className={`glass rounded-xl p-6 ${priorityGlow[task.priority] ? `shadow-lg ${priorityGlow[task.priority]}` : ""}`}>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Badge variant={statusVariant[task.status] ?? "default"}>
            {statusLabels[task.status] ?? task.status}
          </Badge>
          <Badge variant={task.priority as "critical" | "high" | "medium" | "low"}>
            {task.priority}
          </Badge>
          <Badge variant="default">{task.type}</Badge>
          {task.identifier && <Badge variant="info">{task.identifier}</Badge>}
        </div>
        <h1 className="font-display text-2xl font-bold text-text-primary">{task.title}</h1>
        {task.description && (
          <p className="mt-3 whitespace-pre-wrap text-sm text-text-secondary leading-relaxed">
            {task.description}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <div className="glass rounded-xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-6 py-4">
              <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
                Status
              </h3>
              <div className="flex gap-2">
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-text-secondary hover:bg-white/[0.05]"
                  onClick={() =>
                    subtreeControls.mutate({
                      taskId: task.id,
                      action: "pause",
                      reason: "Paused from task detail",
                    })
                  }
                >
                  <Pause className="h-3.5 w-3.5" />
                  Pause subtree
                </button>
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-text-secondary hover:bg-white/[0.05]"
                  onClick={() => subtreeControls.mutate({ taskId: task.id, action: "restore" })}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Restore
                </button>
                <button
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-error hover:bg-error/[0.08]"
                  onClick={() =>
                    subtreeControls.mutate({
                      taskId: task.id,
                      action: "cancel",
                      reason: "Cancelled from task detail",
                    })
                  }
                >
                  <XCircle className="h-3.5 w-3.5" />
                  Cancel subtree
                </button>
              </div>
            </div>
            <div className="p-6 flex flex-wrap gap-3">
              {statusFlow.map((status) => (
                <button
                  key={status}
                  className={`rounded-lg px-4 py-2 text-sm font-medium transition-all duration-200 cursor-pointer ${
                    status === task.status
                      ? "bg-accent text-surface shadow-lg shadow-accent/20"
                      : "glass-raised text-text-secondary hover:text-text-primary hover:border-neon-cyan/30"
                  }`}
                  onClick={() => {
                    if (status !== task.status) {
                      updateTask.mutate({ taskId: task.id, data: { status } });
                    }
                  }}
                  disabled={updateTask.isPending}
                >
                  {statusLabels[status]}
                </button>
              ))}
            </div>
          </div>

          <div className="glass rounded-xl overflow-hidden">
            <div className="border-b border-white/[0.06] px-6 py-4">
              <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
                Thread
              </h3>
            </div>
            <div className="divide-y divide-white/[0.06]">
              {sortedThread.length === 0 ? (
                <p className="p-6 text-center text-sm text-text-secondary">
                  No comments, approvals, or execution events yet.
                </p>
              ) : (
                sortedThread.map((item) => (
                  <div key={item.id} className="p-5">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-lg bg-white/[0.04] text-neon-cyan">
                        {itemIcon(item)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap items-center gap-2">
                          <Badge variant={item.kind === "approval_link" ? "warning" : item.kind === "execution_event" ? "info" : "default"}>
                            {item.kind.replace(/_/g, " ")}
                          </Badge>
                          <span className="text-xs text-text-secondary">
                            {formatRelative(item.createdAt)}
                          </span>
                          <span className="text-xs text-text-secondary">status: {item.status}</span>
                        </div>
                        {item.content && (
                          <p className="whitespace-pre-wrap text-sm leading-relaxed text-text-primary">
                            {item.content}
                          </p>
                        )}
                        {item.kind === "execution_event" && (
                          <p className="mt-2 text-xs text-text-secondary">
                            Liveness: {(item.payload as any).livenessStatus ?? "unknown"}
                            {(item.payload as any).nextActionHint
                              ? ` · ${(item.payload as any).nextActionHint}`
                              : ""}
                          </p>
                        )}
                        {item.kind === "approval_link" && item.status === "pending" && item.relatedApprovalId && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() =>
                                decideApproval.mutate({
                                  id: item.relatedApprovalId!,
                                  decision: "approved",
                                  resolutionNote: "Approved from task thread",
                                })
                              }
                            >
                              Approve
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                decideApproval.mutate({
                                  id: item.relatedApprovalId!,
                                  decision: "rejected",
                                  resolutionNote: "Rejected from task thread",
                                })
                              }
                            >
                              Reject
                            </Button>
                          </div>
                        )}
                        {item.kind === "interaction" && item.status === "pending" && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() =>
                                respondInteraction.mutate({
                                  taskId: task.id,
                                  interactionId: item.id,
                                  action: item.interactionType === "form" ? "answer" : "accept",
                                  note: "Accepted from task thread",
                                })
                              }
                            >
                              {item.interactionType === "form" ? "Submit" : "Accept"}
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() =>
                                respondInteraction.mutate({
                                  taskId: task.id,
                                  interactionId: item.id,
                                  action: "reject",
                                  note: "Rejected from task thread",
                                })
                              }
                            >
                              Reject
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="border-t border-white/[0.06] p-5">
              <Textarea
                label="Comment"
                rows={3}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Add an operator note..."
              />
              <div className="mt-3 flex justify-end">
                <Button onClick={submitComment} disabled={addComment.isPending || !comment.trim()}>
                  Add comment
                </Button>
              </div>
            </div>
          </div>
        </div>

        <aside className="space-y-6">
          <div className="glass rounded-xl overflow-hidden">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
                Details
              </h3>
            </div>
            <div className="space-y-4 p-5">
              <div className="flex items-center gap-3 text-sm">
                <Clock className="h-4 w-4 text-neon-cyan/60" />
                <span className="text-text-secondary">Created</span>
                <span className="ml-auto text-text-primary font-display tabular-nums">
                  {formatRelative(task.createdAt)}
                </span>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Clock className="h-4 w-4 text-neon-purple/60" />
                <span className="text-text-secondary">Updated</span>
                <span className="ml-auto text-text-primary font-display tabular-nums">
                  {formatRelative(task.updatedAt)}
                </span>
              </div>
              <div className="text-sm">
                <p className="text-text-secondary">Assignee</p>
                <p className="mt-1 font-mono text-xs text-text-primary">
                  {task.assigneeAgentId ?? "Unassigned"}
                </p>
              </div>
            </div>
          </div>

          <div className="glass rounded-xl overflow-hidden">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
                Dependencies
              </h3>
            </div>
            <div className="p-5">
              {task.dependencies.length === 0 ? (
                <p className="text-sm text-text-secondary">No blockers.</p>
              ) : (
                <div className="space-y-3">
                  {task.dependencies.map((depId) => (
                    <div
                      key={depId}
                      className="flex items-center gap-3 rounded-lg glass-raised p-3"
                    >
                      <GitBranch className="h-4 w-4 text-neon-purple" />
                      <span className="min-w-0 truncate text-xs text-text-secondary font-mono">
                        {depId}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
