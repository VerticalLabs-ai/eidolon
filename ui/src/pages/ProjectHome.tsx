import { ExternalLink, FolderKanban, Activity, FileText, Target, AlertTriangle, Zap, TrendingUp, ChevronDown, ChevronRight } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useState } from "react";
import { clsx } from "clsx";
import { useProjectHome, useGoals } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card as UICard } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { isHttpUrl } from "@/lib/urls";
import type { ProjectHomeSummary, Task, Activity as ActivityType, AgentFile, Goal } from "@/lib/api";

const statusVariant: Record<string, "default" | "success" | "warning" | "info" | "error"> = {
  active: "success",
  planning: "info",
  paused: "warning",
  completed: "success",
  archived: "default",
};

// ── Card wrapper ─────────────────────────────────────────────────────────
// Thin composition of the design-system Card: adds the icon + heading row and
// the labelled landmark, without re-implementing the card surface itself.

function Card({
  title,
  icon,
  children,
  className = "",
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className} aria-label={title}>
      <UICard
        animated={false}
        className="h-full"
        header={
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
              {icon}
            </span>
            <h2 className="text-sm font-semibold text-text-primary font-display">{title}</h2>
          </div>
        }
      >
        {children}
      </UICard>
    </section>
  );
}

function CardEmpty({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-6 text-sm text-text-muted" role="status">
      {message}
    </div>
  );
}

// ── Individual cards ─────────────────────────────────────────────────────

function HeaderCard({ project }: { project: ProjectHomeSummary["project"] }) {
  const repoUrl = project.repoUrl && isHttpUrl(project.repoUrl) ? project.repoUrl : null;

  return (
    <Card title="Project" icon={<FolderKanban className="h-4 w-4" />} className="md:col-span-2 lg:col-span-3">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-bold text-text-primary font-display">{project.name}</h3>
          <Badge variant={statusVariant[project.status] ?? "default"}>{project.status}</Badge>
        </div>
        {project.description ? (
          <p className="text-sm text-text-secondary">{project.description}</p>
        ) : (
          <p className="text-sm text-text-muted italic">No description provided.</p>
        )}
        {repoUrl && (
          <a
            href={repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm text-accent hover:underline"
            data-testid="repo-link"
          >
            <span className="truncate max-w-xs">{repoUrl}</span>
            <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
          </a>
        )}
      </div>
    </Card>
  );
}

function CountsCard({ counts }: { counts: ProjectHomeSummary["counts"] }) {
  const items = [
    { label: "Tasks", value: counts.taskCount },
    { label: "Goals", value: counts.goalCount },
    { label: "Agents", value: counts.agentCount },
    { label: "Files", value: counts.fileCount },
  ];

  return (
    <Card title="Counts" icon={<TrendingUp className="h-4 w-4" />}>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((item) => (
          <div key={item.label} className="rounded-lg bg-white/[0.03] px-3 py-2 text-center">
            <dt className="text-xs text-text-muted">{item.label}</dt>
            <dd className="mt-0.5 text-xl font-bold tabular-nums text-text-primary font-display">
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function TaskListItem({ task }: { task: Task }) {
  return (
    <li className="flex items-center justify-between gap-2 border-b border-white/[0.04] py-2 last:border-b-0">
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

function ActiveWorkCard({ tasks }: { tasks: Task[] }) {
  return (
    <Card title="Active Work" icon={<Zap className="h-4 w-4" />}>
      {tasks.length === 0 ? (
        <CardEmpty message="No active work" />
      ) : (
        <ul>
          {tasks.map((task) => (
            <TaskListItem key={task.id} task={task} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function NeedsAttentionCard({ tasks }: { tasks: Task[] }) {
  return (
    <Card title="Needs Attention" icon={<AlertTriangle className="h-4 w-4" />}>
      {tasks.length === 0 ? (
        <CardEmpty message="Nothing needs attention" />
      ) : (
        <ul>
          {tasks.map((task) => (
            <TaskListItem key={task.id} task={task} />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Compact project-scoped goal tree (card-safe, no page chrome) ─────────

interface CompactGoalNode {
  goal: Goal;
  children: CompactGoalNode[];
}

function buildCompactTree(goals: Goal[]): CompactGoalNode[] {
  const map = new Map<string, CompactGoalNode>();
  const roots: CompactGoalNode[] = [];

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

const levelBadgeTint: Record<string, string> = {
  company: "bg-neon-cyan/10 text-neon-cyan",
  department: "bg-neon-purple/10 text-neon-purple",
  team: "bg-success/10 text-success",
  individual: "bg-warning/10 text-warning",
};

function CompactGoalNodeRow({
  depth,
  node,
}: {
  depth: number;
  node: CompactGoalNode;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const goal = node.goal;

  return (
    <div className={clsx(depth > 0 && "ml-3 border-l border-white/[0.06] pl-2")}>
      <div className="flex items-center gap-2 py-1">
        {hasChildren ? (
          <button
            type="button"
            className="shrink-0 rounded p-0.5 text-text-secondary hover:text-accent"
            onClick={() => setExpanded((c) => !c)}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${goal.title}`}
          >
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <span
          className={clsx(
            "shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
            levelBadgeTint[goal.level] ?? "bg-surface-overlay text-text-secondary",
          )}
        >
          {goal.level.slice(0, 3)}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-primary">{goal.title}</span>
        <span className="shrink-0 text-[10px] tabular-nums text-text-secondary">{goal.progress}%</span>
      </div>
      {expanded && hasChildren && (
        <div>
          {node.children.map((child) => (
            <CompactGoalNodeRow key={child.goal.id} depth={depth + 1} node={child} />
          ))}
        </div>
      )}
    </div>
  );
}

function CompactGoalTree({ companyId, projectId }: { companyId: string; projectId: string }) {
  const { data: goals, isLoading, isError } = useGoals(companyId, { projectId });

  if (isLoading) {
    return (
      <div className="space-y-2 py-2" role="status" aria-label="Loading goals">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-5 animate-pulse rounded bg-white/[0.04]" />
        ))}
      </div>
    );
  }

  if (isError) {
    return <p className="py-2 text-xs text-error">Goals could not be loaded.</p>;
  }

  if (!goals?.length) {
    return <CardEmpty message="No goals yet" />;
  }

  const tree = buildCompactTree(goals);

  return (
    <div className="max-h-64 overflow-auto" data-testid="compact-goal-tree">
      {tree.map((node) => (
        <CompactGoalNodeRow key={node.goal.id} depth={0} node={node} />
      ))}
    </div>
  );
}

function GoalsSummaryCard({
  goalProgress,
  companyId,
  projectId,
}: {
  goalProgress: ProjectHomeSummary["goalProgress"];
  companyId: string;
  projectId: string;
}) {
  return (
    <Card title="Goals" icon={<Target className="h-4 w-4" />}>
      <div className="mb-3 flex items-center gap-3">
        <div className="rounded-lg bg-white/[0.03] px-3 py-1.5 text-center">
          <p className="text-xs text-text-muted">Count</p>
          <p className="text-lg font-bold tabular-nums text-text-primary font-display">
            {goalProgress.count}
          </p>
        </div>
        <div className="rounded-lg bg-white/[0.03] px-3 py-1.5 text-center">
          <p className="text-xs text-text-muted">Progress</p>
          <p className="text-lg font-bold tabular-nums text-text-primary font-display">
            {goalProgress.aggregateProgress}%
          </p>
        </div>
      </div>
      {goalProgress.count === 0 ? (
        <CardEmpty message="No goals yet" />
      ) : (
        <CompactGoalTree companyId={companyId} projectId={projectId} />
      )}
    </Card>
  );
}

function RecentActivityCard({ activities }: { activities: ActivityType[] }) {
  return (
    <Card title="Recent Activity" icon={<Activity className="h-4 w-4" />}>
      {activities.length === 0 ? (
        <CardEmpty message="No recent activity" />
      ) : (
        <ul>
          {activities.map((entry) => (
            <li key={entry.id} className="border-b border-white/[0.04] py-2 last:border-b-0">
              <p className="text-sm text-text-primary">{entry.description ?? entry.action.replaceAll(".", " ")}</p>
              <p className="text-xs text-text-muted">
                {formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true })}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentFilesCard({ files }: { files: AgentFile[] }) {
  return (
    <Card title="Recent Files" icon={<FileText className="h-4 w-4" />}>
      {files.length === 0 ? (
        <CardEmpty message="No recent files" />
      ) : (
        <ul>
          {files.map((file) => (
            <li key={file.id} className="flex items-center gap-2 border-b border-white/[0.04] py-2 last:border-b-0">
              <FileText className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{file.name}</p>
                <p className="text-xs text-text-muted">
                  {formatDistanceToNow(new Date(file.createdAt), { addSuffix: true })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ── Main component ───────────────────────────────────────────────────────

export function ProjectHome({ companyId, projectId }: { companyId: string; projectId: string }) {
  const { data: summary, isLoading, isError, refetch } = useProjectHome(companyId, projectId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-label="Loading project home">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<FolderKanban className="h-6 w-6" />}
          title="Home could not be loaded"
          description="Check your connection and try again."
          action={<Button variant="secondary" onClick={() => void refetch()}>Try again</Button>}
        />
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<FolderKanban className="h-6 w-6" />}
          title="Home could not be loaded"
          description="No project home data available."
        />
      </div>
    );
  }

  return (
    <div
      className="mx-auto max-w-6xl p-5 sm:p-6"
      data-testid="project-home"
    >
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        <HeaderCard project={summary.project} />
        <CountsCard counts={summary.counts} />
        <ActiveWorkCard tasks={summary.activeWork} />
        <NeedsAttentionCard tasks={summary.needsAttention} />
        <GoalsSummaryCard goalProgress={summary.goalProgress} companyId={companyId} projectId={projectId} />
        <RecentActivityCard activities={summary.recentActivity} />
        <RecentFilesCard files={summary.recentFiles} />
      </div>
    </div>
  );
}
