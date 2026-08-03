import { Check, Gavel, X } from "lucide-react";
import { useState } from "react";
import { useProjectDecisions, useUpdateProjectDecision } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { ProjectDecision, ProjectDecisionStatus } from "@/lib/api";

const statusVariant: Record<ProjectDecisionStatus, "default" | "success" | "warning" | "info" | "error"> = {
  pending: "warning",
  approved: "success",
  rejected: "error",
  superseded: "default",
};

function DecisionItem({
  decision,
  onResolve,
  pending,
}: {
  decision: ProjectDecision;
  onResolve: (status: "approved" | "rejected", rationale: string) => void;
  pending: boolean;
}) {
  const [rationale, setRationale] = useState("");
  const [action, setAction] = useState<"approved" | "rejected" | null>(null);

  return (
    <li className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3" data-testid={`decision-${decision.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-text-primary">{decision.title}</h3>
          {decision.description && <p className="mt-1 text-xs leading-relaxed text-text-secondary">{decision.description}</p>}
        </div>
        <Badge variant={statusVariant[decision.status]}>{decision.status}</Badge>
      </div>
      {decision.status === "pending" && (
        <>
          {action && (
            <textarea
              aria-label="Optional rationale"
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              placeholder="Optional rationale…"
              rows={2}
              className="mt-3 w-full resize-none rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs text-text-primary outline-none focus:border-accent/60"
              data-testid={`decision-rationale-${decision.id}`}
            />
          )}
          <div className="mt-3 flex gap-2">
            {!action ? (
              <>
                <Button size="sm" icon={<Check className="h-3 w-3" />} onClick={() => setAction("approved")}>
                  Approve
                </Button>
                <Button size="sm" variant="danger" icon={<X className="h-3 w-3" />} onClick={() => setAction("rejected")}>
                  Reject
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  loading={pending}
                  onClick={() => onResolve(action, rationale.trim())}
                  data-testid={`decision-confirm-${decision.id}`}
                >
                  Confirm {action === "approved" ? "approval" : "rejection"}
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAction(null)}>
                  Cancel
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </li>
  );
}

export function PendingDecisionsCard({ companyId, projectId }: { companyId: string; projectId: string }) {
  const { data: decisions, isLoading, isError } = useProjectDecisions(companyId, projectId, { status: "pending" });
  const updateDecision = useUpdateProjectDecision(companyId, projectId);
  const pendingDecisions = (decisions ?? []).filter((decision) => decision.status === "pending").slice(0, 5);

  return (
    <section aria-label="Pending decisions" data-testid="pending-decisions-card">
      <Card
        animated={false}
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <Gavel className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">Pending Decisions</h2>
          </div>
        }
      >
        {isLoading ? (
          <div className="py-5 text-sm text-text-muted" role="status">Loading decisions…</div>
        ) : isError ? (
          <div className="py-5 text-sm text-error">Decisions could not be loaded.</div>
        ) : pendingDecisions.length === 0 ? (
          <div className="py-5 text-sm text-text-muted" role="status">No pending decisions</div>
        ) : (
          <ul className="space-y-3">
            {pendingDecisions.map((decision) => (
              <DecisionItem
                key={decision.id}
                decision={decision}
                pending={updateDecision.isPending}
                onResolve={(status, rationale) =>
                  updateDecision.mutate({
                    decisionId: decision.id,
                    data: { status, ...(rationale ? { rationale } : {}) },
                  })
                }
              />
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
