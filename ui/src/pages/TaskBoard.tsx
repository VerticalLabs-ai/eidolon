import { useState } from "react";
import { useParams } from "react-router-dom";
import { Plus, Filter } from "lucide-react";
import { useTasks, useUpdateTask } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { TaskCard } from "@/components/tasks/TaskCard";
import { CreateTaskModal } from "@/components/tasks/CreateTaskModal";
import { EmptyState } from "@/components/ui/EmptyState";
import { ListTodo } from "lucide-react";
import { clsx } from "clsx";
import type { Task } from "@/lib/api";
import { PageTransition } from "@/components/ui/PageTransition";

const columns: { id: string; label: string; dotColor: string }[] = [
  { id: "backlog", label: "Backlog", dotColor: "bg-text-secondary/40" },
  { id: "todo", label: "Todo", dotColor: "bg-neon-cyan" },
  { id: "in_progress", label: "In Progress", dotColor: "bg-warning" },
  { id: "review", label: "Review", dotColor: "bg-neon-purple" },
  { id: "done", label: "Done", dotColor: "bg-success" },
];

const priorityOptions = [
  { value: "", label: "All Priorities" },
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

export function TaskBoard() {
  const { companyId } = useParams();
  const { data: tasks, isLoading } = useTasks(companyId);
  const updateTask = useUpdateTask(companyId!);
  const [modalOpen, setModalOpen] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState("");

  const filtered = (tasks ?? []).filter((t) => {
    if (priorityFilter && t.priority !== priorityFilter) return false;
    return true;
  });

  const getColumnTasks = (status: string) =>
    filtered.filter((t) => t.status === status);

  const moveTask = (taskId: string, newStatus: string) => {
    updateTask.mutate({ taskId, data: { status: newStatus } });
  };

  const priorityBorderColor: Record<string, string> = {
    critical: "border-l-error shadow-error/10",
    high: "border-l-warning shadow-warning/10",
    medium: "border-l-neon-cyan shadow-neon-cyan/10",
    low: "border-l-text-secondary/30",
  };

  return (
    <PageTransition>
    <div className="p-6 lg:p-8 space-y-6 h-full flex flex-col">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between shrink-0">
        <div>
          <h2 className="font-display text-2xl font-bold text-text-primary tracking-tight">
            Tasks
          </h2>
          <p className="text-sm text-text-secondary mt-1">
            {filtered.length} task{filtered.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="glass rounded-lg px-3 py-2 flex items-center gap-3">
            <Filter className="h-4 w-4 text-neon-cyan" />
            <div className="w-40">
              <Select
                options={priorityOptions}
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
              />
            </div>
          </div>
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md h-8 px-3 text-xs font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97]"
          >
            <Plus className="h-4 w-4" />
            New Task
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex gap-6 overflow-x-auto flex-1 pb-4">
          {columns.map((col) => (
            <div
              key={col.id}
              className="w-72 shrink-0 animate-pulse rounded-xl glass h-96"
            />
          ))}
        </div>
      ) : !tasks?.length ? (
        <EmptyState
          icon={<ListTodo className="h-6 w-6" />}
          title="No tasks yet"
          description="Create your first task to get started."
          action={
            <button
              onClick={() => setModalOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md h-8 px-3 text-xs font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97]"
            >
              <Plus className="h-4 w-4" />
              New Task
            </button>
          }
        />
      ) : (
        <div className="flex gap-6 overflow-x-auto flex-1 pb-4">
          {columns.map((col) => {
            const columnTasks = getColumnTasks(col.id);
            return (
              <div
                key={col.id}
                className="w-72 shrink-0 flex flex-col rounded-xl glass"
              >
                {/* Column header */}
                <div className="flex items-center gap-2.5 px-4 py-3.5 border-b border-white/[0.06]">
                  <span
                    className={clsx(
                      "h-2.5 w-2.5 rounded-full",
                      col.dotColor,
                    )}
                    style={{
                      boxShadow:
                        col.id === "todo"
                          ? "0 0 8px rgba(0,243,255,0.4)"
                          : col.id === "in_progress"
                            ? "0 0 8px rgba(255,170,0,0.4)"
                            : col.id === "review"
                              ? "0 0 8px rgba(189,0,255,0.4)"
                              : col.id === "done"
                                ? "0 0 8px rgba(0,230,138,0.4)"
                                : "none",
                    }}
                  />
                  <span className="font-display text-sm font-medium text-text-primary">
                    {col.label}
                  </span>
                  <span className="ml-auto flex h-5 min-w-5 items-center justify-center rounded-full bg-surface-overlay px-1.5 text-xs tabular-nums text-text-secondary font-display">
                    {columnTasks.length}
                  </span>
                </div>

                {/* Task list */}
                <div className="flex-1 overflow-y-auto p-3 space-y-3">
                  {columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      companyId={companyId!}
                      compact
                    />
                  ))}
                  {columnTasks.length === 0 && (
                    <p className="py-8 text-center text-xs text-text-secondary/40">
                      No tasks
                    </p>
                  )}
                </div>

                {/* Quick move buttons at bottom for convenience */}
                {col.id !== "done" && columnTasks.length > 0 && (
                  <div className="border-t border-white/[0.06] p-2.5">
                    <p className="text-[10px] text-text-secondary/40 text-center">
                      Click a task to view details
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <CreateTaskModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        companyId={companyId!}
      />
    </div>
    </PageTransition>
  );
}
