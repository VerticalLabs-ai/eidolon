// ---------------------------------------------------------------------------
// Timeline artifact content helpers
// ---------------------------------------------------------------------------
//
// Pure parse/build/mutate helpers for the Timeline (Gantt) artifact
// (`type: "timeline"`). Kept separate from the editor component so the task
// manipulation and dependency rules live in one place.
//
// Server-side shape (packages/shared TimelineContentSchema):
//   { tasks: [{ id, title, start, end, dependsOn?: [], progress?: 0-100 }] }
// Task ids must be unique; end >= start; every dependsOn entry must match an
// existing task id; and the dependency graph must not contain a cycle — the
// API returns 400 otherwise.
// ---------------------------------------------------------------------------

export interface TimelineTask {
  id: string;
  title: string;
  start: string;
  end: string;
  dependsOn?: string[];
  progress?: number;
}

export interface TimelineContent {
  tasks: TimelineTask[];
}

export function parseTimeline(content: Record<string, unknown>): TimelineContent {
  const tasks = Array.isArray(content.tasks) ? (content.tasks as TimelineTask[]) : [];
  return { tasks };
}

export function genTaskId(): string {
  return `task_${Math.random().toString(36).slice(2, 10)}`;
}

/** Creates a new task with a fresh id, defaulting to a 7-day span from today. */
export function createTask(): TimelineTask {
  const today = new Date();
  const next = new Date(today);
  next.setDate(next.getDate() + 7);
  return {
    id: genTaskId(),
    title: "",
    start: today.toISOString().slice(0, 10),
    end: next.toISOString().slice(0, 10),
    progress: 0,
  };
}

/**
 * Stable string form of a timeline, used to compare local, baseline, and
 * remote states so cosmetic differences (dependsOn array ordering) do not
 * register as changes.
 */
export function serializeTimeline(content: TimelineContent): string {
  return JSON.stringify(content);
}

/** Returns the set of task ids that depend on `taskId`. */
export function dependentsOf(tasks: TimelineTask[], taskId: string): string[] {
  return tasks
    .filter((t) => (t.dependsOn ?? []).includes(taskId))
    .map((t) => t.id);
}

/**
 * Removes a task and cleans up any dependencies that reference it. After
 * deletion no dangling dependency ids remain — other tasks that depended on
 * the removed task have that reference stripped from their `dependsOn`.
 */
export function removeTask(tasks: TimelineTask[], taskId: string): TimelineTask[] {
  return tasks
    .filter((t) => t.id !== taskId)
    .map((t) => {
      const deps = (t.dependsOn ?? []).filter((d) => d !== taskId);
      return deps.length > 0 ? { ...t, dependsOn: deps } : { ...t, dependsOn: undefined };
    });
}

/** Adds a dependency from `taskId` to `depId` if not already present. */
export function addDependency(
  tasks: TimelineTask[],
  taskId: string,
  depId: string,
): TimelineTask[] {
  if (taskId === depId) return tasks; // self-dependency is a cycle
  return tasks.map((t) => {
    if (t.id !== taskId) return t;
    const deps = t.dependsOn ?? [];
    if (deps.includes(depId)) return t;
    return { ...t, dependsOn: [...deps, depId] };
  });
}

/** Removes a dependency from `taskId` to `depId`. */
export function removeDependency(
  tasks: TimelineTask[],
  taskId: string,
  depId: string,
): TimelineTask[] {
  return tasks.map((t) => {
    if (t.id !== taskId) return t;
    const deps = (t.dependsOn ?? []).filter((d) => d !== depId);
    return deps.length > 0 ? { ...t, dependsOn: deps } : { ...t, dependsOn: undefined };
  });
}

/**
 * Detects whether adding a dependency from `taskId` to `depId` would create a
 * cycle. Returns true if a cycle would be introduced.
 */
export function wouldCreateCycle(
  tasks: TimelineTask[],
  taskId: string,
  depId: string,
): boolean {
  // Adding taskId → depId creates a cycle if depId can already reach taskId.
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    adj.set(t.id, t.dependsOn ?? []);
  }
  // Temporarily add the edge
  const existing = adj.get(taskId) ?? [];
  adj.set(taskId, [...existing, depId]);

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const t of tasks) color.set(t.id, WHITE);

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const neighbor of adj.get(node) ?? []) {
      const c = color.get(neighbor);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(neighbor)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  return dfs(taskId);
}

// ── Date helpers ──────────────────────────────────────────────────────────

export function parseDate(str: string): Date {
  return new Date(str);
}

/** Returns the earliest start date among all tasks, or today if no tasks. */
export function minStartDate(tasks: TimelineTask[]): Date {
  if (tasks.length === 0) return new Date();
  let min = parseDate(tasks[0].start);
  for (const t of tasks) {
    const d = parseDate(t.start);
    if (d < min) min = d;
  }
  return min;
}

/** Returns the latest end date among all tasks, or today+30 if no tasks. */
export function maxEndDate(tasks: TimelineTask[]): Date {
  if (tasks.length === 0) {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d;
  }
  let max = parseDate(tasks[0].end);
  for (const t of tasks) {
    const d = parseDate(t.end);
    if (d > max) max = d;
  }
  return max;
}

/** Number of days between two dates (inclusive of start). */
export function daySpan(start: Date, end: Date): number {
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)));
}

/** Returns the day offset of a task's start from the timeline's min start. */
export function dayOffset(task: TimelineTask, min: Date): number {
  const start = parseDate(task.start);
  return Math.max(0, Math.round((start.getTime() - min.getTime()) / (1000 * 60 * 60 * 24)));
}
