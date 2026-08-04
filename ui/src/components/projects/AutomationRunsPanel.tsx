import { formatDistanceToNow } from "date-fns";
import { Activity, Cpu, GitBranch, Webhook } from "lucide-react";
import { clsx } from "clsx";
import { Card } from "@/components/ui/Card";
import { useProjectWork } from "@/lib/hooks";
import type { AutomationRun, AutomationRunStatus, AutomationType } from "@/lib/api";

// ---------------------------------------------------------------------------
// Type label + icon
// ---------------------------------------------------------------------------

const TYPE_META: Record<AutomationType, { label: string; icon: typeof Cpu }> = {
  routine: { label: "Routine", icon: Cpu },
  workflow: { label: "Workflow", icon: GitBranch },
  webhook: { label: "Webhook", icon: Webhook },
};

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<AutomationRunStatus, string> = {
  queued: "bg-white/[0.06] text-text-secondary border-white/[0.08]",
  running: "bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20",
  completed: "bg-success/10 text-success border-success/20",
  failed: "bg-error/10 text-error border-error/20",
  cancelled: "bg-white/[0.06] text-text-secondary border-white/[0.08]",
};

function RunStatusBadge({ status }: { status: AutomationRunStatus }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border",
        STATUS_STYLES[status] ?? STATUS_STYLES.queued,
      )}
      data-testid={`run-status-${status}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Run row
// ---------------------------------------------------------------------------

function RunRow({ run }: { run: AutomationRun }) {
  const meta = TYPE_META[run.automationType] ?? TYPE_META.routine;
  const Icon = meta.icon;

  return (
    <li
      className="flex items-center gap-3 border-b border-white/[0.04] py-2.5 last:border-b-0"
      data-testid={`automation-run-${run.id}`}
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-white/[0.05]">
        <Icon className="h-3.5 w-3.5 text-text-secondary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className="shrink-0 rounded bg-white/[0.05] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-text-secondary"
            data-testid={`run-type-${run.id}`}
          >
            {meta.label}
          </span>
          <span
            className="truncate text-sm text-text-primary"
            data-testid={`run-name-${run.id}`}
          >
            {run.automationName}
          </span>
        </div>
        <p className="text-[10px] text-text-muted">
          {formatDistanceToNow(new Date(run.createdAt), { addSuffix: true })}
        </p>
      </div>
      <RunStatusBadge status={run.status} />
      <span
        className="shrink-0 text-[10px] tabular-nums text-text-muted"
        data-testid={`run-timestamp-${run.id}`}
      >
        {new Date(run.createdAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AutomationRunsPanel({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { data: workSummary, isLoading, isError } = useProjectWork(companyId, projectId);
  const runs = workSummary?.automationRuns ?? [];

  return (
    <section data-testid="automation-runs-panel" aria-label="Automation Runs">
      <Card
        animated={false}
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <Activity className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">
              Automation Runs
            </h2>
          </div>
        }
      >
        {isLoading ? (
          <div className="space-y-2 py-3" role="status" aria-label="Loading automation runs">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-white/[0.04]" />
            ))}
          </div>
        ) : isError ? (
          <p className="py-4 text-center text-sm text-error">
            Automation runs could not be loaded.
          </p>
        ) : runs.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-6 text-center"
            role="status"
            data-testid="automation-runs-empty"
          >
            <Activity className="mb-2 h-5 w-5 text-text-muted" />
            <p className="text-sm text-text-muted">No automation runs yet</p>
            <p className="text-xs text-text-muted/60">
              Runs from routines, workflows, and webhooks will appear here.
            </p>
          </div>
        ) : (
          <ul>
            {runs.map((run) => (
              <RunRow key={run.id} run={run} />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
