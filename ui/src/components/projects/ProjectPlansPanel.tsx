import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Plus,
  ArrowUp,
  ArrowDown,
  Forward,
} from "lucide-react";
import {
  usePlansWithSteps,
  useCreateProjectPlan,
  useCreatePlanStep,
  useUpdatePlanStep,
  useAdvancePlanGate,
} from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
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

const stepTypeLabel: Record<ProjectPlanStep["stepType"], string> = {
  action: "Action",
  review_gate: "Review gate",
  permission_gate: "Permission gate",
};

function StatusBadge({ status }: { status: ProjectPlanStep["status"] }) {
  return (
    <span data-testid={`step-status-${status}`}>
      <Badge variant={statusVariant[status]}>{statusLabel[status]}</Badge>
    </span>
  );
}

function GateConfig({ config }: { config: Record<string, unknown> }) {
  const entries = Object.entries(config).filter(([, v]) => v !== null && v !== undefined && v !== "");
  if (entries.length === 0) return null;
  return (
    <dl className="mt-1 rounded-md bg-white/[0.03] px-2 py-1 text-[11px] text-text-secondary">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-1">
          <dt className="font-medium text-text-muted">{key}:</dt>
          <dd>{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function StepRow({
  step,
  isFirst,
  isLast,
  onReorder,
  onAdvance,
  advancePending,
}: {
  step: ProjectPlanStep;
  isFirst: boolean;
  isLast: boolean;
  onReorder: (stepId: string, stepOrder: number) => void;
  onAdvance: () => void;
  advancePending: boolean;
}) {
  const isGate = step.stepType === "review_gate" || step.stepType === "permission_gate";
  const canAdvance = step.status === "pending";

  return (
    <li className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
      <div className="flex items-center gap-2">
        <div className="flex shrink-0 flex-col gap-0.5">
          <button
            type="button"
            className="rounded p-0.5 text-text-muted hover:text-accent disabled:opacity-30 disabled:pointer-events-none"
            aria-label={`Move step up`}
            data-testid={`step-up-${step.id}`}
            disabled={isFirst}
            onClick={() => onReorder(step.id, step.stepOrder - 1)}
          >
            <ArrowUp className="h-3 w-3" />
          </button>
          <button
            type="button"
            className="rounded p-0.5 text-text-muted hover:text-accent disabled:opacity-30 disabled:pointer-events-none"
            aria-label={`Move step down`}
            data-testid={`step-down-${step.id}`}
            disabled={isLast}
            onClick={() => onReorder(step.id, step.stepOrder + 1)}
          >
            <ArrowDown className="h-3 w-3" />
          </button>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-text-primary">{step.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="default">{stepTypeLabel[step.stepType]}</Badge>
            <StatusBadge status={step.status} />
            {step.gateApprovalId && (
              <span className="text-[11px] text-text-muted" data-testid={`gate-approval-${step.id}`}>
                Approval: {step.gateApprovalId}
              </span>
            )}
          </div>
          {isGate && <GateConfig config={step.gateConfig} />}
        </div>
        {canAdvance && (
          <Button
            size="sm"
            variant="secondary"
            icon={<Forward className="h-3 w-3" />}
            loading={advancePending}
            onClick={onAdvance}
            aria-label="Advance gate"
          >
            Advance
          </Button>
        )}
      </div>
    </li>
  );
}

function PlanItem({
  plan,
  createPlanStep,
  updatePlanStep,
  advancePlanGate,
}: {
  plan: ProjectPlanDetail;
  createPlanStep: ReturnType<typeof useCreatePlanStep>;
  updatePlanStep: ReturnType<typeof useUpdatePlanStep>;
  advancePlanGate: ReturnType<typeof useAdvancePlanGate>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [stepTitle, setStepTitle] = useState("");

  const steps = [...plan.steps].sort((a, b) => a.stepOrder - b.stepOrder);
  const completed = steps.filter((s) => s.status === "completed").length;
  const total = steps.filter((s) => s.status !== "skipped").length;

  function addStep(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = stepTitle.trim();
    if (!trimmed || createPlanStep.isPending) return;
    createPlanStep.mutate({ planId: plan.id, data: { title: trimmed } });
    setStepTitle("");
  }

  return (
    <div
      className="rounded-xl border border-white/[0.06] bg-surface"
      data-testid={`plan-item-${plan.id}`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5">
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-text-secondary hover:text-accent"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${plan.title}`}
          onClick={() => setExpanded((c) => !c)}
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{plan.title}</p>
          <p className="text-xs text-text-muted">
            {completed}/{total} steps · {plan.status}
          </p>
        </div>
        <Badge variant={plan.status === "active" ? "success" : "default"}>{plan.status}</Badge>
      </div>
      {expanded && (
        <div className="border-t border-white/[0.06] px-3 py-3">
          {steps.length === 0 ? (
            <p className="py-2 text-xs text-text-muted">No steps yet</p>
          ) : (
            <ul className="space-y-2" data-testid={`plan-steps-${plan.id}`}>
              {steps.map((step, index) => (
                <StepRow
                  key={step.id}
                  step={step}
                  isFirst={index === 0}
                  isLast={index === steps.length - 1}
                  onReorder={(stepId, stepOrder) =>
                    updatePlanStep.mutate({ planId: plan.id, stepId, data: { stepOrder } })
                  }
                  onAdvance={() => advancePlanGate.mutate({ planId: plan.id, stepId: step.id })}
                  advancePending={advancePlanGate.isPending}
                />
              ))}
            </ul>
          )}
          <form onSubmit={addStep} className="mt-3 flex gap-2 border-t border-white/[0.06] pt-3">
            <label className="sr-only" htmlFor={`new-step-${plan.id}`}>
              Add a step
            </label>
            <input
              id={`new-step-${plan.id}`}
              aria-label="Add a step"
              value={stepTitle}
              onChange={(e) => setStepTitle(e.target.value)}
              placeholder="Add a step…"
              data-testid={`new-step-title-${plan.id}`}
              className="h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus:border-accent/60"
            />
            <Button
              type="submit"
              size="sm"
              icon={<Plus className="h-3 w-3" />}
              disabled={!stepTitle.trim() || createPlanStep.isPending}
              loading={createPlanStep.isPending}
              aria-label="Add step"
            >
              Add step
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

export function ProjectPlansPanel({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const { data: plans, isLoading, isError } = usePlansWithSteps(companyId, projectId);
  const createPlan = useCreateProjectPlan(companyId, projectId);
  const createPlanStep = useCreatePlanStep(companyId, projectId);
  const updatePlanStep = useUpdatePlanStep(companyId, projectId);
  const advancePlanGate = useAdvancePlanGate(companyId, projectId);

  const [newPlanTitle, setNewPlanTitle] = useState("");

  function submitPlan(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = newPlanTitle.trim();
    if (!trimmed || createPlan.isPending) return;
    createPlan.mutate({ title: trimmed });
    setNewPlanTitle("");
  }

  return (
    <section aria-label="Project plans" data-testid="project-plans-panel">
      <Card
        animated={false}
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              <ClipboardList className="h-4 w-4" />
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">Plans</h2>
          </div>
        }
      >
        <form onSubmit={submitPlan} className="mb-4 flex gap-2">
          <label className="sr-only" htmlFor="new-plan-title">
            New plan title
          </label>
          <input
            id="new-plan-title"
            aria-label="New plan title"
            value={newPlanTitle}
            onChange={(e) => setNewPlanTitle(e.target.value)}
            placeholder="Create a plan…"
            data-testid="new-plan-title"
            className="h-8 min-w-0 flex-1 rounded-md border border-white/10 bg-white/[0.03] px-3 text-sm text-text-primary outline-none focus:border-accent/60"
          />
          <Button
            type="submit"
            size="sm"
            icon={<Plus className="h-3 w-3" />}
            disabled={!newPlanTitle.trim() || createPlan.isPending}
            loading={createPlan.isPending}
            aria-label="Create plan"
          >
            Create plan
          </Button>
        </form>

        {isLoading ? (
          <div className="py-5 text-sm text-text-muted" role="status">
            Loading plans…
          </div>
        ) : isError ? (
          <div className="py-5 text-sm text-error">Plans could not be loaded.</div>
        ) : !plans || plans.length === 0 ? (
          <div className="py-5 text-sm text-text-muted" role="status">
            No plans yet
          </div>
        ) : (
          <div className="space-y-3">
            {plans.map((plan) => (
              <PlanItem
                key={plan.id}
                plan={plan}
                createPlanStep={createPlanStep}
                updatePlanStep={updatePlanStep}
                advancePlanGate={advancePlanGate}
              />
            ))}
          </div>
        )}
      </Card>
    </section>
  );
}
