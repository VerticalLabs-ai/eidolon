import { useCallback, useEffect, useState } from "react";
import {
  Save,
  Plus,
  AlertTriangle,
  CloudOff,
  Trash2,
  Link2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { Artifact } from "@/lib/api";
import {
  type TimelineTask,
  parseTimeline,
  serializeTimeline,
  createTask,
  removeTask,
  wouldCreateCycle,
  addDependency,
  removeDependency,
  minStartDate,
  maxEndDate,
  dayOffset,
  daySpan,
  parseDate,
} from "./timeline-content";
import { useArtifactDraftSync } from "./useArtifactDraftSync";

interface TimelineEditorProps {
  artifact: Artifact;
  version: number;
  onSave: (data: {
    title: string;
    content: Record<string, unknown>;
  }) => Promise<void>;
  saving?: boolean;
  conflictState?: ConflictState | null;
  wsConnected?: boolean;
  onRemoteUpdate?: (content: Record<string, unknown>, title: string) => void;
  onStateChange?: (state: {
    dirty: boolean;
    save: () => Promise<boolean>;
    discard: () => void;
  }) => void;
}

export interface ConflictState {
  currentVersion: number;
  currentTitle: string;
  currentContent: Record<string, unknown>;
}

export function TimelineEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
  onRemoteUpdate,
  onStateChange,
}: TimelineEditorProps) {
  const parsed = parseTimeline(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [tasks, setTasks] = useState<TimelineTask[]>(parsed.tasks);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [depPickerFor, setDepPickerFor] = useState<string | null>(null);

  const serializeArtifactContent = useCallback(
    (content: Record<string, unknown>) => serializeTimeline(parseTimeline(content)),
    [],
  );

  const onAdoptRemote = useCallback(
    (content: Record<string, unknown>, title: string) => {
      const next = parseTimeline(content);
      setTitle(title);
      setTasks(next.tasks);
      setSaveError(null);
      setSelectedId(null);
    },
    [],
  );

  const localSnapshot = serializeTimeline({ tasks });

  const {
    isDirty,
    remoteUpdate,
    resetBaselineToArtifact,
    markSaved,
  } = useArtifactDraftSync({
    artifact,
    localTitle: title,
    serializedLocalContent: localSnapshot,
    serializeArtifactContent,
    onAdoptRemote,
  });

  const discardDraft = useCallback(() => {
    const next = parseTimeline(artifact.content);
    resetBaselineToArtifact();
    setTitle(artifact.title);
    setTasks(next.tasks);
    setSaveError(null);
    setSelectedId(null);
    onRemoteUpdate?.(artifact.content, artifact.title);
  }, [artifact, onRemoteUpdate, resetBaselineToArtifact]);

  const buildContent = useCallback(
    (): Record<string, unknown> => ({ tasks }) as unknown as Record<string, unknown>,
    [tasks],
  );

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty || saving) return false;
    setSaveError(null);
    const content = buildContent();
    try {
      await onSave({ title, content });
      markSaved(title, content);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      return false;
    }
  }, [isDirty, saving, title, buildContent, onSave, markSaved]);

  useEffect(() => {
    onStateChange?.({ dirty: isDirty, save: handleSave, discard: discardDraft });
  }, [discardDraft, handleSave, isDirty, onStateChange]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !saving) void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, isDirty, saving]);

  // -- task mutations -------------------------------------------------------

  const addTask = () => {
    const newTask = createTask();
    setTasks((prev) => [...prev, newTask]);
    setSelectedId(newTask.id);
  };

  const updateTask = (id: string, patch: Partial<TimelineTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const confirmDeleteTask = () => {
    if (!pendingDelete) return;
    setTasks((prev) => removeTask(prev, pendingDelete));
    if (selectedId === pendingDelete) setSelectedId(null);
    setPendingDelete(null);
  };

  const handleAddDep = (taskId: string, depId: string) => {
    if (wouldCreateCycle(tasks, taskId, depId)) return;
    setTasks((prev) => addDependency(prev, taskId, depId));
  };

  const handleRemoveDep = (taskId: string, depId: string) => {
    setTasks((prev) => removeDependency(prev, taskId, depId));
  };

  // -- gantt rendering helpers ----------------------------------------------

  const timelineMin = minStartDate(tasks);
  const timelineMax = maxEndDate(tasks);
  const totalDays = daySpan(timelineMin, timelineMax);

  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const pendingTask = pendingDelete ? tasks.find((t) => t.id === pendingDelete) : null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled timeline"
          aria-label="Timeline title"
          className="flex-1 bg-transparent text-sm font-semibold text-text-primary font-display placeholder:text-text-secondary/40 rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        />
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          v{version}
        </span>
        {wsConnected === false && (
          <span
            className="flex items-center gap-1 text-xs text-warning"
            title="Realtime connection lost — your draft is preserved"
            role="status"
            aria-label="Realtime disconnected"
          >
            <CloudOff className="h-3.5 w-3.5" />
            Disconnected
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="h-3 w-3" />}
          onClick={addTask}
          aria-label="Add task"
        >
          Task
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Save className="h-3 w-3" />}
          onClick={handleSave}
          disabled={!isDirty || saving}
          loading={saving}
        >
          Save
        </Button>
      </div>

      {wsConnected === false && (
        <div
          role="status"
          aria-label="Realtime connection disconnected"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>
            Realtime connection lost. Your draft is preserved — you can still save.
          </span>
        </div>
      )}

      {remoteUpdate && !conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            This artifact changed elsewhere. Your draft is preserved.
          </span>
          <Button variant="ghost" size="sm" onClick={discardDraft}>
            Reload remote
          </Button>
        </div>
      )}
      {conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Version conflict — another client saved v{conflictState.currentVersion}.
            Your draft is preserved. Save again to overwrite, or discard to load latest.
          </span>
        </div>
      )}

      {saveError && !conflictState && (
        <div
          role="alert"
          aria-label="Save failed"
          className="flex items-center gap-2 border-b border-error/20 bg-error/10 px-4 py-2 text-xs text-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">Not saved: {saveError}. Your draft is preserved.</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saving}
          >
            Retry save
          </Button>
        </div>
      )}

      {/* Timeline surface: Gantt chart + task detail */}
      <div className="flex flex-1 overflow-hidden">
        {/* Gantt chart area */}
        <div className="flex-1 overflow-auto" data-testid="timeline-gantt">
          {tasks.length === 0 ? (
            <div className="flex h-full items-center justify-center text-text-secondary">
              <div className="text-center">
                <p className="text-sm">This timeline is empty.</p>
                <p className="mt-1 text-xs text-text-secondary/60">
                  Add a task to start planning your project.
                </p>
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Plus className="h-3 w-3" />}
                    onClick={addTask}
                  >
                    Add Task
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="min-w-[600px] p-4">
              {/* Date header */}
              <div className="mb-2 flex items-center gap-2 pl-44">
                <span className="text-xs text-text-secondary tabular-nums">
                  {timelineMin.toISOString().slice(0, 10)}
                </span>
                <div className="flex-1 border-t border-white/[0.06]" />
                <span className="text-xs text-text-secondary tabular-nums">
                  {timelineMax.toISOString().slice(0, 10)}
                </span>
              </div>

              {/* Task rows */}
              <div className="space-y-1" role="list" aria-label="Timeline tasks">
                {tasks.map((task) => {
                  const offset = dayOffset(task, timelineMin);
                  const span = daySpan(parseDate(task.start), parseDate(task.end));
                  const leftPct = (offset / totalDays) * 100;
                  const widthPct = Math.max(2, (span / totalDays) * 100);
                  const progress = task.progress ?? 0;
                  const isSelected = task.id === selectedId;

                  return (
                    <div
                      key={task.id}
                      className="group flex items-center gap-2"
                      role="listitem"
                    >
                      {/* Task label */}
                      <div className="w-44 shrink-0">
                        <button
                          onClick={() =>
                            setSelectedId(isSelected ? null : task.id)
                          }
                          className={`w-full truncate rounded px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                            isSelected
                              ? "bg-accent/10 text-accent font-semibold"
                              : "text-text-primary hover:bg-white/[0.03]"
                          }`}
                          aria-label={`Task: ${task.title || "Untitled"}`}
                        >
                          {task.title || (
                            <span className="text-text-secondary italic">Untitled</span>
                          )}
                        </button>
                      </div>

                      {/* Gantt bar area */}
                      <div className="relative flex-1 h-8">
                        {/* Grid line */}
                        <div className="absolute inset-0 border-b border-white/[0.03]" />
                        {/* Dependency arrows */}
                        {(task.dependsOn ?? []).map((depId) => {
                          const dep = tasks.find((t) => t.id === depId);
                          if (!dep) return null;
                          const depEnd = dayOffset(dep, timelineMin) + daySpan(parseDate(dep.start), parseDate(dep.end));
                          const depEndPct = (depEnd / totalDays) * 100;
                          return (
                            <div
                              key={depId}
                              className="absolute top-1/2 h-px bg-accent/30"
                              style={{
                                left: `${Math.min(depEndPct, leftPct)}%`,
                                width: `${Math.abs(leftPct - depEndPct)}%`,
                              }}
                              title={`depends on ${dep.title || dep.id}`}
                            />
                          );
                        })}
                        {/* Task bar */}
                        <div
                          className={`absolute top-1/2 -translate-y-1/2 rounded transition-all cursor-pointer ${
                            isSelected
                              ? "ring-2 ring-accent/50 ring-offset-1 ring-offset-surface"
                              : ""
                          }`}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            height: "20px",
                          }}
                          onClick={() =>
                            setSelectedId(isSelected ? null : task.id)
                          }
                          role="button"
                          tabIndex={0}
                          aria-label={`Task bar: ${task.title || "Untitled"}, ${progress}% complete`}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelectedId(isSelected ? null : task.id);
                            }
                          }}
                        >
                          {/* Background bar */}
                          <div className="absolute inset-0 rounded bg-accent/20 border border-accent/30" />
                          {/* Progress fill */}
                          <div
                            className="absolute inset-y-0 left-0 rounded bg-accent/60"
                            style={{ width: `${progress}%` }}
                          />
                          {/* Progress label */}
                          <span className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-text-primary mix-blend-difference">
                            {progress}%
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                onClick={addTask}
                className="mt-3 flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-accent hover:bg-accent/5 rounded transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label="Add task"
              >
                <Plus className="h-3 w-3" />
                Add Task
              </button>
            </div>
          )}
        </div>

        {/* Task detail panel */}
        {selected && (
          <div className="w-72 shrink-0 border-l border-white/[0.06] overflow-y-auto p-4 space-y-3" data-testid="task-detail">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold font-display text-text-primary">Task Details</h3>
              <button
                onClick={() => setSelectedId(null)}
                className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:text-text-primary hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label="Close task details"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* Title */}
            <div>
              <label htmlFor="task-title" className="mb-1 block text-xs text-text-secondary">
                Title
              </label>
              <input
                id="task-title"
                value={selected.title}
                onChange={(e) => updateTask(selected.id, { title: e.target.value })}
                placeholder="Task title"
                aria-label="Task title"
                className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>

            {/* Start date */}
            <div>
              <label htmlFor="task-start" className="mb-1 block text-xs text-text-secondary">
                Start date
              </label>
              <input
                id="task-start"
                type="date"
                value={selected.start}
                onChange={(e) => updateTask(selected.id, { start: e.target.value })}
                aria-label="Task start date"
                className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>

            {/* End date */}
            <div>
              <label htmlFor="task-end" className="mb-1 block text-xs text-text-secondary">
                End date
              </label>
              <input
                id="task-end"
                type="date"
                value={selected.end}
                onChange={(e) => updateTask(selected.id, { end: e.target.value })}
                aria-label="Task end date"
                className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>

            {/* Progress */}
            <div>
              <label htmlFor="task-progress" className="mb-1 block text-xs text-text-secondary">
                Progress: {selected.progress ?? 0}%
              </label>
              <input
                id="task-progress"
                type="range"
                min={0}
                max={100}
                value={selected.progress ?? 0}
                onChange={(e) => updateTask(selected.id, { progress: Number(e.target.value) })}
                aria-label="Task progress"
                className="w-full accent-accent"
              />
            </div>

            {/* Dependencies */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs text-text-secondary">Dependencies</label>
                <button
                  onClick={() => setDepPickerFor(selected.id)}
                  className="flex items-center gap-1 text-xs text-accent hover:text-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded"
                  aria-label="Add dependency"
                >
                  <Link2 className="h-3 w-3" />
                  Add
                </button>
              </div>
              {(selected.dependsOn ?? []).length === 0 ? (
                <p className="text-xs text-text-secondary/60 italic">No dependencies</p>
              ) : (
                <div className="space-y-1">
                  {(selected.dependsOn ?? []).map((depId) => {
                    const dep = tasks.find((t) => t.id === depId);
                    return (
                      <div
                        key={depId}
                        className="flex items-center gap-1 rounded border border-white/[0.06] bg-surface/40 px-2 py-1 text-xs"
                      >
                        <span className="flex-1 truncate text-text-primary">
                          {dep?.title || depId}
                        </span>
                        <button
                          onClick={() => handleRemoveDep(selected.id, depId)}
                          className="flex h-4 w-4 items-center justify-center rounded text-text-secondary hover:text-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
                          aria-label={`Remove dependency on ${dep?.title || depId}`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Delete task */}
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-3 w-3" />}
              onClick={() => setPendingDelete(selected.id)}
              className="w-full"
              aria-label="Delete task"
            >
              Delete Task
            </Button>
          </div>
        )}
      </div>

      {isDirty && (
        <div className="shrink-0 border-t border-white/[0.04] px-4 py-1.5 text-xs text-text-secondary">
          Unsaved changes — press Ctrl/Cmd+S to save
        </div>
      )}

      {/* Task deletion confirmation */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete task"
      >
        <p className="text-sm text-text-secondary">
          Delete task{" "}
          <strong className="text-text-primary">
            {pendingTask?.title || "Untitled"}
          </strong>
          ?
        </p>
        <p className="mt-2 text-xs text-text-secondary/70">
          Any tasks depending on this task will have the dependency removed.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPendingDelete(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={confirmDeleteTask}
            aria-label="Confirm delete task"
          >
            Delete task
          </Button>
        </div>
      </Modal>

      {/* Dependency picker modal */}
      <Modal
        open={depPickerFor !== null}
        onClose={() => setDepPickerFor(null)}
        title="Add dependency"
      >
        <p className="mb-3 text-sm text-text-secondary">
          Select a task that this task depends on.
        </p>
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {tasks
            .filter((t) => t.id !== depPickerFor)
            .map((t) => {
              const wouldCycle = depPickerFor
                ? wouldCreateCycle(tasks, depPickerFor, t.id)
                : false;
              const alreadyDep = depPickerFor
                ? (tasks.find((x) => x.id === depPickerFor)?.dependsOn ?? []).includes(t.id)
                : false;
              return (
                <button
                  key={t.id}
                  disabled={wouldCycle || alreadyDep}
                  onClick={() => {
                    if (depPickerFor) handleAddDep(depPickerFor, t.id);
                    setDepPickerFor(null);
                  }}
                  className="flex w-full items-center gap-2 rounded border border-white/[0.06] px-3 py-2 text-left text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed hover:border-accent/30 hover:bg-accent/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  aria-label={`Depend on ${t.title || "Untitled task"}`}
                >
                  <span className="flex-1 truncate text-text-primary">
                    {t.title || <span className="text-text-secondary italic">Untitled</span>}
                  </span>
                  {alreadyDep && (
                    <span className="text-[10px] text-text-secondary">already added</span>
                  )}
                  {wouldCycle && !alreadyDep && (
                    <span className="text-[10px] text-warning">would cycle</span>
                  )}
                </button>
              );
            })}
          {tasks.filter((t) => t.id !== depPickerFor).length === 0 && (
            <p className="text-xs text-text-secondary/60 italic py-2">
              No other tasks available.
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}
