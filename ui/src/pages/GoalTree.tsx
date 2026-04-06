import { useState } from "react";
import { useParams } from "react-router-dom";
import { Target, ChevronRight, ChevronDown } from "lucide-react";
import { useGoalTree } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card } from "@/components/ui/Card";
import { clsx } from "clsx";
import type { Goal } from "@/lib/api";

const statusColors: Record<string, string> = {
  on_track: "text-success",
  at_risk: "text-warning",
  behind: "text-error",
  completed: "text-neon-cyan",
};

const statusVariant: Record<string, "success" | "warning" | "error" | "info"> = {
  on_track: "success",
  at_risk: "warning",
  behind: "error",
  completed: "info",
};

const levelLabels: Record<string, string> = {
  mission: "Mission",
  objective: "Objective",
  key_result: "Key Result",
  initiative: "Initiative",
};

const levelTint: Record<string, string> = {
  mission: "bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20",
  objective: "bg-neon-purple/10 text-neon-purple border-neon-purple/20",
  key_result: "bg-success/10 text-success border-success/20",
  initiative: "bg-warning/10 text-warning border-warning/20",
};

interface GoalTreeNode {
  goal: Goal;
  children: GoalTreeNode[];
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

function GoalNode({ node, depth = 0 }: { node: GoalTreeNode; depth?: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const goal = node.goal;

  return (
    <div className={clsx(depth > 0 && "ml-6 border-l border-white/[0.06] pl-4")}>
      <div
        className={clsx(
          "group flex items-start gap-3 rounded-xl glass-raised p-4 transition-all duration-300 ease-out",
          hasChildren && "cursor-pointer hover:glass-hover hover:-translate-y-0.5",
        )}
        onClick={() => hasChildren && setExpanded(!expanded)}
      >
        {hasChildren ? (
          <button className="mt-0.5 shrink-0 rounded-lg p-1 text-text-secondary hover:text-neon-cyan hover:bg-neon-cyan/10 transition-all duration-200 cursor-pointer">
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
          <div className="flex items-center gap-2 flex-wrap">
            <span className={clsx(
              "inline-flex items-center rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
              levelTint[goal.level] ?? "bg-surface-overlay text-text-secondary border-white/[0.06]",
            )}>
              {levelLabels[goal.level] ?? goal.level}
            </span>
            <Badge variant={statusVariant[goal.status] ?? "default"}>
              {(goal.status ?? '').replace("_", " ")}
            </Badge>
          </div>
          <h3 className="font-display mt-2 text-sm font-semibold text-text-primary leading-snug">
            {goal.title}
          </h3>
          {goal.description && (
            <p className="mt-1 text-xs text-text-secondary line-clamp-2">
              {goal.description}
            </p>
          )}
          <div className="mt-3 max-w-xs">
            <div className="h-2 rounded-full bg-surface-overlay overflow-hidden">
              <div
                className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
                style={{ width: `${goal.progress ?? 0}%` }}
              />
            </div>
            <span className="text-[10px] text-text-secondary font-display tabular-nums mt-1 inline-block">
              {goal.progress ?? 0}%
            </span>
          </div>
        </div>
      </div>

      {expanded && hasChildren && (
        <div className="mt-2 space-y-2">
          {node.children.map((child) => (
            <GoalNode key={child.goal.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function GoalTree() {
  const { companyId } = useParams();
  const { data: goals, isLoading } = useGoalTree(companyId);

  const tree = buildTree(goals ?? []);

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8 space-y-8">
      <div>
        <h2 className="font-display text-2xl font-bold text-text-primary tracking-tight">
          Goals
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          Company objectives and key results
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl glass"
            />
          ))}
        </div>
      ) : !goals?.length ? (
        <EmptyState
          icon={<Target className="h-6 w-6" />}
          title="No goals defined"
          description="Goals will appear here once the company defines its objectives."
        />
      ) : (
        <div className="glass rounded-xl p-6 space-y-3 grid-bg">
          {tree.map((node) => (
            <GoalNode key={node.goal.id} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}
