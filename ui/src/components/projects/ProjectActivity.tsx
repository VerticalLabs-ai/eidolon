import { useState } from "react";
import { format, formatDistanceToNow } from "date-fns";
import { Activity, Archive, CheckCircle2, FolderPlus, ListTodo, Pencil } from "lucide-react";
import { useProjectActivity } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

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

export function ProjectActivity({ companyId, projectId }: { companyId: string; projectId: string }) {
  const [offset, setOffset] = useState(0);
  const query = useProjectActivity(companyId, projectId, PAGE_SIZE, offset);
  const entries = query.data?.data ?? [];
  const total = query.data?.meta.total ?? 0;

  if (query.isLoading) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-label="Loading activity">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<Activity className="h-6 w-6" />}
          title="Activity could not be loaded"
          description="The persisted history is still safe. Check your connection and try again."
          action={<Button variant="secondary" onClick={() => void query.refetch()}>Try again</Button>}
        />
      </div>
    );
  }

  if (entries.length === 0 && offset === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<Activity className="h-6 w-6" />}
          title="No activity yet"
          description="Durable project and associated task events will appear here."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-5 sm:p-6">
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
