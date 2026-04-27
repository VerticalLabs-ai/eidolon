import { Link, useParams } from "react-router-dom";
import {
  Bot,
  ListTodo,
  DollarSign,
  CheckCircle2,
} from "lucide-react";
import { useAgents, useTasks, useDashboard, useActivity } from "@/lib/hooks";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { BudgetGauge } from "@/components/dashboard/BudgetGauge";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { Badge } from "@/components/ui/Badge";
import { PageTransition } from "@/components/ui/PageTransition";

export function CompanyDashboard() {
  const { companyId } = useParams();
  const { data: dashboard } = useDashboard(companyId);
  const { data: agents } = useAgents(companyId);
  const { data: tasks } = useTasks(companyId);
  const { data: activities } = useActivity(companyId);

  const activeAgents = agents?.filter((a: any) => a.status === "working").length ?? 0;
  const totalAgents = agents?.length ?? 0;
  const openTasks = tasks?.filter((t: any) => t.status !== "done" && t.status !== "cancelled").length ?? 0;
  const doneTasks = tasks?.filter((t: any) => t.status === "done").length ?? 0;

  const budgetCents = dashboard?.costs?.budgetCents ?? 0;
  const spentCents = dashboard?.costs?.spentCents ?? 0;

  const recentActivity = (activities ?? []).slice(0, 8).map((a: any) => ({
    id: a.id,
    type: a.action as any,
    title: a.action?.replace(/\./g, " "),
    description: a.description,
    timestamp: a.createdAt,
  }));

  return (
    <PageTransition>
    <div className="mx-auto max-w-7xl p-6 lg:p-8 space-y-8">
      {/* Stats row */}
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        {/* Active Agents */}
        <div className="glass rounded-xl p-6 relative overflow-hidden transition-all duration-200 hover:shadow-lg hover:shadow-neon-cyan/5">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-neon-cyan rounded-l-xl" />
          <div className="flex items-center gap-3 mb-3">
            <Bot className="h-5 w-5 text-neon-cyan" />
            <span className="text-sm text-text-secondary">Active Agents</span>
          </div>
          <p className="font-display text-3xl font-bold text-text-primary tabular-nums">
            {activeAgents}<span className="text-lg text-text-secondary">/{totalAgents}</span>
          </p>
        </div>

        {/* Open Tasks */}
        <div className="glass rounded-xl p-6 relative overflow-hidden transition-all duration-200 hover:shadow-lg hover:shadow-neon-purple/5">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-neon-purple rounded-l-xl" />
          <div className="flex items-center gap-3 mb-3">
            <ListTodo className="h-5 w-5 text-neon-purple" />
            <span className="text-sm text-text-secondary">Open Tasks</span>
          </div>
          <p className="font-display text-3xl font-bold text-text-primary tabular-nums">
            {openTasks}
          </p>
        </div>

        {/* Budget Used */}
        <div className="glass rounded-xl p-6 relative overflow-hidden transition-all duration-200 hover:shadow-lg hover:shadow-success/5">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-success rounded-l-xl" />
          <div className="flex items-center gap-3 mb-3">
            <DollarSign className="h-5 w-5 text-success" />
            <span className="text-sm text-text-secondary">Budget Used</span>
          </div>
          <p className="font-display text-3xl font-bold text-text-primary tabular-nums">
            <span className="text-lg">$</span>{(spentCents / 100).toLocaleString()}
            <span className="text-lg text-text-secondary"> / ${(budgetCents / 100).toLocaleString()}</span>
          </p>
        </div>

        {/* Completed */}
        <div className="glass rounded-xl p-6 relative overflow-hidden transition-all duration-200 hover:shadow-lg hover:shadow-warning/5">
          <div className="absolute left-0 top-0 bottom-0 w-1 bg-warning rounded-l-xl" />
          <div className="flex items-center gap-3 mb-3">
            <CheckCircle2 className="h-5 w-5 text-warning" />
            <span className="text-sm text-text-secondary">Completed</span>
          </div>
          <p className="font-display text-3xl font-bold text-text-primary tabular-nums">
            {doneTasks}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Activity Feed */}
        <div className="lg:col-span-2 glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Recent Activity
            </h3>
          </div>
          <div className="p-6">
            <ActivityFeed items={recentActivity} />
          </div>
        </div>

        {/* Budget */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Budget Overview
            </h3>
          </div>
          <div className="flex justify-center p-6">
            <BudgetGauge
              used={spentCents / 100}
              total={budgetCents / 100 || 1}
            />
          </div>
        </div>
      </div>

      {/* Agent Status Grid */}
      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Agent Status
          </h3>
        </div>
        <div className="p-6">
          {!agents?.length ? (
            <p className="py-4 text-center text-sm text-text-secondary">
              No agents hired yet
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent: any) => (
                <Link
                  key={agent.id}
                  to={`/company/${companyId}/agents/${agent.id}`}
                  className="flex items-center gap-3 rounded-xl glass-raised p-4 transition-all duration-200 hover:glass-hover focus:outline-none focus:ring-2 focus:ring-neon-cyan/40"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-neon-cyan/10">
                    <Bot className="h-5 w-5 text-neon-cyan" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-text-primary truncate">
                        {agent.name}
                      </p>
                      <StatusIndicator status={agent.status === "working" ? "connected" : "disconnected"} size="sm" />
                    </div>
                    <p className="text-xs text-text-secondary truncate">
                      {agent.title || agent.role}
                    </p>
                  </div>
                  <Badge variant="info">{agent.role}</Badge>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Task Distribution */}
      <div className="glass rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-white/[0.06]">
          <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
            Task Distribution
          </h3>
        </div>
        <div className="p-6 space-y-4">
          {(["backlog", "todo", "in_progress", "review", "done", "cancelled", "timed_out"] as const).map(
            (status) => {
              const count = tasks?.filter((t: any) => t.status === status).length ?? 0;
              const total = tasks?.length || 1;
              const pct = Math.round((count / total) * 100);
              const label = status.replace(/_/g, " ");
              return (
                <div key={status} className="flex items-center gap-4">
                  <span className="w-28 text-xs capitalize text-text-secondary font-display">
                    {label}
                  </span>
                  <div className="flex-1 h-2.5 rounded-full bg-surface-overlay overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-10 text-right text-xs tabular-nums text-text-secondary font-display">
                    {count}
                  </span>
                </div>
              );
            },
          )}
        </div>
      </div>
    </div>
    </PageTransition>
  );
}
