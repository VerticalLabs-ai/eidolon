import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  Activity,
  Archive,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  ListTodo,
  Pencil,
  XCircle,
  Zap,
} from "lucide-react";
import { useProjectActivity, useProjectHome } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import type { ProjectHomeSummary, Task } from "@/lib/api";

const PAGE_SIZE = 20;

const actionDetails: Record<string, { label: string; icon: typeof Activity }> = {
  "project.created": { label: "Project created", icon: FolderPlus },
  "project.updated": { label: "Project updated", icon: Pencil },
  "project.deleted": { label: "Project archived", icon: Archive },
  "task.created": { label: "Task created", icon: ListTodo },
  "task.updated": { label: "Task updated", icon: CheckCircle2 },
  "task.cancelled": { label: "Task cancelled", icon: Archive },
};

function actorLabel(actorType: string, actorId: string | null) {
  if (actorType === "system") return "System";
  if (!actorId) return actorType === "agent" ? "Agent" : "User";
  return `${actorType === "agent" ? "Agent" : "User"} ${actorId}`;
}

// ── Work-state header ────────────────────────────────────────────────────

interface WorkStateSectionProps {
  label: string;
  count: number;
  icon: React.ReactNode;
  variant: "active" | "needs-input" | "failed";
  children?: React.ReactNode;
}

function WorkStateSection({ label, count, icon, variant, children }: WorkStateSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const countId = `${variant}-count`;
  const hasContent = count > 0;

  // When there is no expandable content (count === 0), render a static,
  // non-interactive header row so screen readers do not announce a toggle
  // that expands nothing.
  if (!hasContent) {
    return (
      <div className="rounded-lg border border-white/[0.06] bg-surface/50">
        <div
          className="flex w-full items-center justify-between gap-2 px-3 py-2.5"
          aria-label={label}
        >
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded text-accent">
              {icon}
            </span>
            <span className="text-sm font-medium text-text-primary">{label}</span>
          </div>
          <div className="flex items-center gap-2">
            <span
              className="text-lg font-bold tabular-nums text-text-primary font-display"
              data-testid={countId}
            >
              {count}
            </span>
            <span className="w-3.5" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-white/[0.06] bg-surface/50">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left cursor-pointer"
        aria-expanded={expanded}
        aria-label={label}
      >
        <div className="flex items-center gap-2">
          <span className="flex h-5 w-5 items-center justify-center rounded text-accent">
            {icon}
          </span>
          <span className="text-sm font-medium text-text-primary">{label}</span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-lg font-bold tabular-nums text-text-primary font-display"
            data-testid={countId}
          >
            {count}
          </span>
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
          )}
        </div>
      </button>
      {expanded && children && (
        <div className="border-t border-white/[0.06] px-3 py-2">
          {children}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  return (
    <li className="flex items-center justify-between gap-2 border-b border-white/[0.04] py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-primary">{task.title}</p>
        <p className="text-xs text-text-muted">{task.status.replaceAll("_", " ")}</p>
      </div>
      {task.identifier && (
        <span className="shrink-0 rounded-full bg-white/[0.05] px-2 py-0.5 text-[10px] font-medium tabular-nums text-text-muted">
          {task.identifier}
        </span>
      )}
    </li>
  );
}

function WorkStateHeader({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { data: summary, isLoading, isError, refetch } = useProjectHome(companyId, projectId);

  if (isLoading) {
    return (
      <div
        className="rounded-lg border border-white/[0.06] bg-surface/50 px-4 py-3"
        data-testid="work-state-header"
        role="status"
        aria-label="Loading work state"
      >
        <div className="h-5 w-32 animate-pulse rounded bg-white/[0.06]" />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="rounded-lg border border-error/20 bg-error/5 px-4 py-3"
        data-testid="work-state-header"
      >
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-error">Work state could not be loaded.</p>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>Try again</Button>
        </div>
      </div>
    );
  }

  const home: ProjectHomeSummary | undefined = summary;
  const activeWork = home?.activeWork ?? [];
  const needsAttention = home?.needsAttention ?? [];
  const failedWork = home?.failedWork ?? [];

  return (
    <div className="space-y-2" data-testid="work-state-header">
      <WorkStateSection
        label="Active"
        count={activeWork.length}
        icon={<Zap className="h-4 w-4" />}
        variant="active"
      >
        <ul>
          {activeWork.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      </WorkStateSection>

      <WorkStateSection
        label="Needs Input"
        count={needsAttention.length}
        icon={<AlertTriangle className="h-4 w-4" />}
        variant="needs-input"
      >
        <ul>
          {needsAttention.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </ul>
      </WorkStateSection>

      <WorkStateSection
        label="Failed"
        count={failedWork.length}
        icon={<XCircle className="h-4 w-4" />}
        variant="failed"
      >
        <ul>
          {failedWork.map((exec) => (
            <li
              key={exec.id}
              className="flex items-center justify-between gap-2 border-b border-white/[0.04] py-1.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">
                  {exec.summary ?? exec.error ?? "Failed execution"}
                </p>
                <p className="text-xs text-text-muted">
                  {formatDistanceToNow(new Date(exec.startedAt), { addSuffix: true })}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-error/10 px-2 py-0.5 text-[10px] font-medium text-error">
                failed
              </span>
            </li>
          ))}
        </ul>
      </WorkStateSection>
    </div>
  );
}

// ── Activity timeline ────────────────────────────────────────────────────

function ActivityTimeline({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const [offset, setOffset] = useState(0);
  const query = useProjectActivity(companyId, projectId, PAGE_SIZE, offset);
  const entries = query.data?.data ?? [];
  const total = query.data?.meta.total ?? 0;

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-12" role="status" aria-label="Loading activity">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <EmptyState
        icon={<Activity className="h-6 w-6" />}
        title="Activity could not be loaded"
        description="The persisted history is still safe. Check your connection and try again."
        action={<Button variant="secondary" onClick={() => void query.refetch()}>Try again</Button>}
      />
    );
  }

  if (entries.length === 0 && offset === 0) {
    return (
      <EmptyState
        icon={<Activity className="h-6 w-6" />}
        title="No activity yet"
        description="Durable project and associated task events will appear here."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-white/[0.06] bg-surface-raised/40 px-4 py-3 text-xs text-text-secondary">
        System records server-observed changes. User attribution is not available for these events yet.
      </div>
      <ol className="overflow-hidden rounded-xl border border-white/[0.06] bg-surface">
        {entries.map((entry, index) => {
          const detail = actionDetails[entry.action] ?? { label: entry.action.replaceAll(".", " "), icon: Activity };
          const Icon = detail.icon;
          const changes = Array.isArray(entry.metadata.changes)
            ? entry.metadata.changes.filter((value): value is string => typeof value === "string")
            : [];
          return (
            <li key={entry.id} className={`flex gap-3 p-4 ${index > 0 ? "border-t border-white/[0.06]" : ""}`}>
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Icon className="h-4 w-4" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <p className="text-sm font-medium text-text-primary">{detail.label}</p>
                  <time
                    dateTime={entry.createdAt}
                    title={format(new Date(entry.createdAt), "PPpp")}
                    className="text-xs tabular-nums text-text-muted"
                  >
                    {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
                  </time>
                </div>
                {entry.description && <p className="mt-1 text-sm text-text-secondary">{entry.description}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
                  <span>{actorLabel(entry.actorType, entry.actorId)}</span>
                  {changes.map((change) => (
                    <span key={change} className="rounded-full bg-white/[0.05] px-2 py-0.5">{change}</span>
                  ))}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-text-muted">
          {total === 0 ? "No events" : `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}`}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
            Previous
          </Button>
          <Button variant="secondary" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function ProjectActivity({ companyId, projectId }: { companyId: string; projectId: string }) {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5 sm:p-6">
      <WorkStateHeader companyId={companyId} projectId={projectId} />
      <ActivityTimeline companyId={companyId} projectId={projectId} />
    </div>
  );
}
