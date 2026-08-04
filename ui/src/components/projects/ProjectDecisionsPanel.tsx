import { useState } from "react";
import { Gavel } from "lucide-react";
import { useProjectDecisions } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import type { ProjectDecisionStatus } from "@/lib/api";

const statuses: Array<"all" | ProjectDecisionStatus> = ["all", "pending", "approved", "rejected", "superseded"];
const statusVariant: Record<ProjectDecisionStatus, "default" | "success" | "warning" | "info" | "error"> = {
  pending: "warning",
  approved: "success",
  rejected: "error",
  superseded: "default",
};

export function ProjectDecisionsPanel({ companyId, projectId }: { companyId: string; projectId: string }) {
  const [status, setStatus] = useState<"all" | ProjectDecisionStatus>("all");
  const { data: decisions, isLoading, isError } = useProjectDecisions(
    companyId,
    projectId,
    status === "all" ? undefined : { status },
  );

  return (
    <section aria-label="Project decisions" data-testid="project-decisions-panel">
      <Card
        animated={false}
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <Gavel className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">Decisions</h2>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Decision status filter">
          {statuses.map((value) => (
            <button
              key={value}
              type="button"
              className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
                status === value ? "bg-accent/20 text-accent" : "bg-white/[0.04] text-text-muted hover:text-text-primary"
              }`}
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
              data-testid={`decision-filter-${value}`}
            >
              {value === "all" ? "All" : value}
            </button>
          ))}
        </div>
        {isLoading ? (
          <div className="py-5 text-sm text-text-muted" role="status">Loading decisions…</div>
        ) : isError ? (
          <div className="py-5 text-sm text-error">Decisions could not be loaded.</div>
        ) : !decisions || decisions.length === 0 ? (
          <div className="py-5 text-sm text-text-muted" role="status">No decisions found</div>
        ) : (
          <ul className="space-y-2">
            {decisions.map((decision) => (
              <li key={decision.id} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-sm text-text-primary">{decision.title}</h3>
                    {decision.description && <p className="mt-1 text-xs text-text-secondary">{decision.description}</p>}
                    {decision.rationale && <p className="mt-2 text-xs italic text-text-muted">“{decision.rationale}”</p>}
                  </div>
                  <Badge variant={statusVariant[decision.status]}>{decision.status}</Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
