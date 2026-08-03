import { ListChecks } from "lucide-react";
import { usePlansWithSteps } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { ProjectPlanDetail, ProjectPlanStep } from "@/lib/api";

const statusVariant: Record<
  ProjectPlanStep["status"],
  "default" | "success" | "warning" | "info" | "error"
> = {
  pending: "default",
  in_progress: "info",
  completed: "success",
  blocked: "error",
  skipped: "warning",
};

const statusLabel: Record<ProjectPlanStep["status"], string> = {
  pending: "Pending",
  in_progress: "In progress",
  completed: "Completed",
  blocked: "Blocked",
  skipped: "Skipped",
};

function StatusDot({ status }: { status: ProjectPlanStep["status"] }) {
  return (
    <span data-testid={`step-status-${status}`} className="shrink-0">
      <Badge variant={statusVariant[status]}>{statusLabel[status]}</Badge>
    </span>
  );
}

function PlanRow({ plan }: { plan: ProjectPlanDetail }) {
  const steps = plan.steps;
  const completed = steps.filter((s) => s.status === "completed").length;
  const total = steps.filter((s) => s.status !== "skipped").length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div
      className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
      data-testid={`plan-progress-${plan.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-text-primary">{plan.title}</p>
        <span className="shrink-0 text-xs tabular-nums text-text-secondary">
          {completed}/{total} · {percentage}%
        </span>
      </div>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]"
        role="progressbar"
        aria-valuenow={percentage}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${percentage}%` }}
        />
      </div>
      {steps.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2">
              <StatusDot status={step.status} />
              <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
                {step.title}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PlanProgressCard({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { data: plans, isLoading, isError } = usePlansWithSteps(
    companyId,
    projectId,
    { status: "active" },
  );

  return (
    <section aria-label="Plan progress" data-testid="plan-progress-card">
      <Card
        animated={false}
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <ListChecks className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">Plan Progress</h2>
          </div>
        }
      >
        {isLoading ? (
          <div className="py-5 text-sm text-text-muted" role="status">
            Loading plan progress…
          </div>
        ) : isError ? (
          <div className="py-5 text-sm text-error">Plan progress could not be loaded.</div>
        ) : !plans || plans.length === 0 ? (
          <div className="py-5 text-sm text-text-muted" role="status">
            No active plans yet
          </div>
        ) : (
          <div className="space-y-3">
            {plans.map((plan) => (
              <PlanRow key={plan.id} plan={plan} />
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}
