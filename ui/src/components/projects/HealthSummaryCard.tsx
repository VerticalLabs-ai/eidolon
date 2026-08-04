import { Heart, CheckCircle2, AlertTriangle, XCircle, HelpCircle, PlayCircle, StopCircle } from "lucide-react";
import { clsx } from "clsx";
import { Card } from "@/components/ui/Card";
import { useProjectHome } from "@/lib/hooks";
import type { HealthStatus } from "@/lib/api";

// ---------------------------------------------------------------------------
// Health count chip
// ---------------------------------------------------------------------------

const HEALTH_CHIP: Record<
  string,
  { icon: typeof CheckCircle2; color: string; label: string }
> = {
  healthy: { icon: CheckCircle2, color: "text-success", label: "Healthy" },
  degraded: { icon: AlertTriangle, color: "text-warning", label: "Degraded" },
  error: { icon: XCircle, color: "text-error", label: "Error" },
  unknown: { icon: HelpCircle, color: "text-text-secondary", label: "Unknown" },
};

function HealthChip({
  status,
  count,
}: {
  status: HealthStatus;
  count: number;
}) {
  const meta = HEALTH_CHIP[status] ?? HEALTH_CHIP.unknown;
  const Icon = meta.icon;
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2"
      data-testid={`health-chip-${status}`}
    >
      <Icon className={clsx("h-4 w-4 shrink-0", meta.color)} />
      <div>
        <p className="text-[10px] text-text-muted">{meta.label}</p>
        <p className="text-lg font-bold tabular-nums text-text-primary font-display">
          {count}
        </p>
      </div>
    </div>
  );
}

function RunCountChip({
  label,
  count,
  icon,
  color,
  testId,
}: {
  label: string;
  count: number;
  icon: typeof PlayCircle;
  color: string;
  testId: string;
}) {
  const Icon = icon;
  return (
    <div
      className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-3 py-2"
      data-testid={testId}
    >
      <Icon className={clsx("h-4 w-4 shrink-0", color)} />
      <div>
        <p className="text-[10px] text-text-muted">{label}</p>
        <p className="text-lg font-bold tabular-nums text-text-primary font-display">
          {count}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HealthSummaryCard({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { data: summary, isLoading, isError } = useProjectHome(companyId, projectId);
  const health = summary?.healthSummary;

  return (
    <section data-testid="health-summary-card" aria-label="Health Summary">
      <Card
        animated={false}
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <Heart className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">
              Health Summary
            </h2>
          </div>
        }
      >
        {isLoading ? (
          <div className="space-y-2 py-3" role="status" aria-label="Loading health summary">
            <div className="h-16 animate-pulse rounded bg-white/[0.04]" />
            <div className="h-16 animate-pulse rounded bg-white/[0.04]" />
          </div>
        ) : isError ? (
          <p className="py-4 text-center text-sm text-error">
            Health summary could not be loaded.
          </p>
        ) : !health ? (
          <p className="py-4 text-center text-sm text-text-muted">
            No health data available.
          </p>
        ) : (
          <div className="space-y-4">
            {/* Integration health counts */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                Integrations
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <HealthChip status="healthy" count={health.integrations.healthy} />
                <HealthChip status="degraded" count={health.integrations.degraded} />
                <HealthChip status="error" count={health.integrations.error} />
                <HealthChip status="unknown" count={health.integrations.unknown} />
              </div>
            </div>

            {/* Automation run success/failure counts */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                Automation Runs
              </p>
              <div className="grid grid-cols-2 gap-2">
                <RunCountChip
                  label="Successful"
                  count={health.automationRuns.success}
                  icon={PlayCircle}
                  color="text-success"
                  testId="run-count-success"
                />
                <RunCountChip
                  label="Failed"
                  count={health.automationRuns.failure}
                  icon={StopCircle}
                  color="text-error"
                  testId="run-count-failure"
                />
              </div>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
