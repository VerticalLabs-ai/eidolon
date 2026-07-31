import { useState } from "react";
import { useParams } from "react-router-dom";
import { ChevronDown, ChevronRight, Pencil, Plus, Target } from "lucide-react";
import { clsx } from "clsx";
import { GoalFormModal } from "@/components/goals/GoalFormModal";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { PageTransition } from "@/components/ui/PageTransition";
import { useAgents, useGoalTree } from "@/lib/hooks";
import type { Goal } from "@/lib/api";

const statusVariant: Record<string, "default" | "success" | "error" | "info"> = {
  draft: "default",
  active: "success",
  completed: "info",
  cancelled: "error",
};

const levelLabels: Record<string, string> = {
  company: "Company",
  department: "Department",
  team: "Team",
  individual: "Individual",
};

const levelTint: Record<string, string> = {
  company: "bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20",
  department: "bg-neon-purple/10 text-neon-purple border-neon-purple/20",
  team: "bg-success/10 text-success border-success/20",
  individual: "bg-warning/10 text-warning border-warning/20",
};

interface GoalTreeNode {
  goal: Goal;
  children: GoalTreeNode[];
}

interface GoalEditorState {
  defaultParentId?: string;
  goal?: Goal;
}

function buildTree(goals: Goal[]): GoalTreeNode[] {
  const map = new Map<string, GoalTreeNode>();
  const roots: GoalTreeNode[] = [];

  for (const goal of goals) {
    map.set(goal.id, { goal, children: [] });
  }

  for (const goal of goals) {
    const node = map.get(goal.id)!;
    if (goal.parentId && map.has(goal.parentId)) {
      map.get(goal.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function GoalNode({
  depth = 0,
  node,
  onAddChild,
  onEdit,
  ownerNames,
  ownersLoading,
  ownersUnavailable,
}: {
  depth?: number;
  node: GoalTreeNode;
  onAddChild: (goal: Goal) => void;
  onEdit: (goal: Goal) => void;
  ownerNames: Map<string, string>;
  ownersLoading: boolean;
  ownersUnavailable: boolean;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const goal = node.goal;
  const ownerName = goal.ownerAgentId ? ownerNames.get(goal.ownerAgentId) : null;
  const ownerLabel = goal.ownerAgentId
    ? ownerName
      ? `Owner: ${ownerName}`
      : ownersLoading
        ? "Owner loading…"
      : ownersUnavailable
        ? "Owner unavailable"
        : "Unknown owner"
    : "Unassigned";

  return (
    <div className={clsx(depth > 0 && "ml-4 border-l border-white/[0.06] pl-3 sm:ml-6 sm:pl-4")}>
      <div className="flex items-start gap-3 rounded-xl glass-raised p-4">
        {hasChildren ? (
          <button
            type="button"
            className="mt-0.5 shrink-0 rounded-lg p-1 text-text-secondary transition-all duration-200 hover:bg-neon-cyan/10 hover:text-neon-cyan cursor-pointer"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} child goals for ${goal.title}`}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          <span className="mt-0.5 w-6 shrink-0" />
        )}

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={clsx(
                    "inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                    levelTint[goal.level]
                      ?? "border-white/[0.06] bg-surface-overlay text-text-secondary",
                  )}
                >
                  {levelLabels[goal.level] ?? goal.level}
                </span>
                <Badge variant={statusVariant[goal.status] ?? "default"}>
                  {goal.status}
                </Badge>
              </div>
              <h3 className="font-display mt-2 text-sm font-semibold leading-snug text-text-primary">
                {goal.title}
              </h3>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1">
              {goal.level !== "individual" && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={() => onAddChild(goal)}
                >
                  Add child
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                icon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => onEdit(goal)}
              >
                Edit
              </Button>
            </div>
          </div>

          {goal.description && (
            <p className="mt-1 text-xs leading-relaxed text-text-secondary">
              {goal.description}
            </p>
          )}

          <div className="mt-3 max-w-xs">
            <div
              className="h-2 overflow-hidden rounded-full bg-surface-overlay"
              role="progressbar"
              aria-label={`${goal.title} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={goal.progress}
            >
              <div
                className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
                style={{ width: `${goal.progress}%` }}
              />
            </div>
            <div className="mt-1 flex items-center justify-between gap-3 text-[10px] text-text-secondary font-display">
              <span className="tabular-nums">{goal.progress}%</span>
              <span>{ownerLabel}</span>
            </div>
          </div>
        </div>
      </div>

      {expanded && hasChildren && (
        <div className="mt-2 space-y-2">
          {node.children.map((child) => (
            <GoalNode
              key={child.goal.id}
              node={child}
              depth={depth + 1}
              onAddChild={onAddChild}
              onEdit={onEdit}
              ownerNames={ownerNames}
              ownersLoading={ownersLoading}
              ownersUnavailable={ownersUnavailable}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree() {
  const { companyId } = useParams();
  const {
    data: goals,
    error: goalsError,
    isError: goalsFailed,
    isLoading,
  } = useGoalTree(companyId);
  const {
    data: agents,
    error: agentsError,
    isError: agentsFailed,
    isLoading: agentsLoading,
  } = useAgents(companyId);
  const [editor, setEditor] = useState<GoalEditorState | null>(null);
  const tree = buildTree(goals ?? []);
  const ownerNames = new Map((agents ?? []).map((agent) => [agent.id, agent.name]));

  return (
    <PageTransition>
      <div className="mx-auto max-w-5xl space-y-8 p-6 lg:p-8">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-2xl font-bold tracking-tight text-text-primary">
              Goals
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              Company objectives and key results
            </p>
          </div>
          <Button
            type="button"
            icon={<Plus className="h-4 w-4" />}
            onClick={() => setEditor({})}
          >
            New Goal
          </Button>
        </div>

        {agentsFailed && !goalsFailed && (
          <div role="alert" className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            Goal owners could not be loaded: {agentsError?.message ?? "Unknown error"}. Assigned owners are marked unavailable.
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((item) => (
              <div key={item} className="h-24 animate-pulse rounded-xl glass" />
            ))}
          </div>
        ) : goalsFailed ? (
          <div role="alert" className="rounded-xl border border-error/30 bg-error/10 px-4 py-3 text-sm text-error">
            Goals could not be loaded: {goalsError?.message ?? "Unknown error"}. Reload the page to try again.
          </div>
        ) : !goals?.length ? (
          <EmptyState
            icon={<Target className="h-6 w-6" />}
            title="No goals defined"
            description="Create a company goal, then add child goals to define ownership and progress."
            action={(
              <Button
                type="button"
                icon={<Plus className="h-4 w-4" />}
                onClick={() => setEditor({})}
              >
                Create Goal
              </Button>
            )}
          />
        ) : (
          <div className="space-y-3 rounded-xl glass p-4 grid-bg sm:p-6">
            {tree.map((node) => (
              <GoalNode
                key={node.goal.id}
                node={node}
                onAddChild={(goal) => setEditor({ defaultParentId: goal.id })}
                onEdit={(goal) => setEditor({ goal })}
                ownerNames={ownerNames}
                ownersLoading={agentsLoading}
                ownersUnavailable={agentsFailed}
              />
            ))}
          </div>
        )}
      </div>

      {editor && companyId && (
        <GoalFormModal
          key={editor.goal?.id ?? editor.defaultParentId ?? "create"}
          agents={agents ?? []}
          companyId={companyId}
          defaultParentId={editor.defaultParentId}
          goal={editor.goal}
          goals={goals ?? []}
          onClose={() => setEditor(null)}
          ownerDataState={agentsLoading ? "loading" : agentsFailed ? "error" : "ready"}
        />
      )}
    </PageTransition>
  );
}
