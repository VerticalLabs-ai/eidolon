import { useParams } from "react-router-dom";
import { BarChart3, TrendingUp, Cpu, DollarSign } from "lucide-react";
import { useAnalyticsOverview, useAnalyticsCosts, useAgents, useTasks } from "@/lib/hooks";
import { Card } from "@/components/ui/Card";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { EmptyState } from "@/components/ui/EmptyState";

// Simple SVG bar chart component with amber accent
function BarChart({
  data,
  height = 200,
}: {
  data: { label: string; value: number }[];
  height?: number;
}) {
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.value), 1);
  const barWidth = Math.min(40, (100 / data.length) * 0.6);
  const gap = (100 - barWidth * data.length) / (data.length + 1);

  return (
    <svg
      viewBox={`0 0 100 ${height / 3}`}
      className="w-full"
      preserveAspectRatio="xMidYMax meet"
      style={{ height }}
    >
      <defs>
        <linearGradient id="bar-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#F0B429" />
          <stop offset="100%" stopColor="#C4911F" />
        </linearGradient>
      </defs>
      {data.map((d, i) => {
        const barH = (d.value / max) * (height / 3 - 16);
        const x = gap + i * (barWidth + gap);
        const y = height / 3 - barH - 10;
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barH}
              rx={2}
              fill="url(#bar-gradient)"
              className="transition-all duration-500"
              opacity={0.7 + (i / data.length) * 0.3}
            >
              <title>
                {d.label}: {d.value.toLocaleString()}
              </title>
            </rect>
            <text
              x={x + barWidth / 2}
              y={height / 3 - 2}
              textAnchor="middle"
              className="fill-text-secondary"
              fontSize={3}
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function AnalyticsDashboard() {
  const { companyId } = useParams();
  const { data: overview, isLoading: overviewLoading } = useAnalyticsOverview(companyId);
  const { data: costs, isLoading: costsLoading } = useAnalyticsCosts(companyId);
  const { data: agents } = useAgents(companyId);
  const { data: tasks } = useTasks(companyId);

  const isLoading = overviewLoading || costsLoading;

  if (isLoading) {
    return (
      <div className="mx-auto max-w-7xl p-6 lg:p-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-64 animate-pulse rounded-xl glass"
            />
          ))}
        </div>
      </div>
    );
  }

  // Derive analytics from available data
  const allAgents = agents ?? [];
  const allTasks = tasks ?? [];

  const totalBudgetCents = allAgents.reduce((s, a) => s + (a.budgetMonthlyCents ?? 0), 0);
  const totalSpentCents = allAgents.reduce((s, a) => s + (a.spentMonthlyCents ?? 0), 0);
  const completedTasks = allTasks.filter((t) => t.status === "done").length;
  const totalTasks = allTasks.length;

  // Try to extract overview/costs data if the API returned rich data
  const overviewData = (overview ?? {}) as Record<string, any>;
  const costsData = (costs ?? {}) as Record<string, any>;

  // Cost trend from API or fallback
  const costTrend: { label: string; value: number }[] =
    Array.isArray(overviewData.costTrend)
      ? overviewData.costTrend.map((d: any) => ({
          label: new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          value: d.cost ?? 0,
        }))
      : [];

  // Token usage from API or fallback
  const tokenUsage: { model: string; tokens: number; cost: number }[] =
    Array.isArray(costsData.tokenUsage)
      ? costsData.tokenUsage
      : Array.isArray(overviewData.tokenUsage)
        ? overviewData.tokenUsage
        : [];

  const metricCards = [
    { icon: DollarSign, iconColor: "text-warning", label: "Total Spent", value: `$${(totalSpentCents / 100).toLocaleString()}`, accent: "bg-warning" },
    { icon: DollarSign, iconColor: "text-success", label: "Total Budget", value: `$${(totalBudgetCents / 100).toLocaleString()}`, accent: "bg-success" },
    { icon: TrendingUp, iconColor: "text-neon-cyan", label: "Tasks Completed", value: String(completedTasks), accent: "bg-neon-cyan" },
    { icon: BarChart3, iconColor: "text-neon-purple", label: "Completion Rate", value: `${totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0}%`, accent: "bg-neon-purple" },
  ];

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8 space-y-8">
      <div>
        <h2 className="font-display text-2xl font-bold text-text-primary tracking-tight">
          Analytics
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          Performance metrics and cost analysis
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
        {metricCards.map((card) => (
          <div key={card.label} className="glass rounded-xl p-6 relative overflow-hidden transition-all duration-200 hover:shadow-lg">
            <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-xl ${card.accent}`} />
            <card.icon className={`h-6 w-6 ${card.iconColor} mb-3`} />
            <p className="font-display text-2xl font-bold text-text-primary tabular-nums">
              {card.value}
            </p>
            <p className="text-xs text-text-secondary mt-1">{card.label}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost Trend */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Cost Trend
            </h3>
          </div>
          <div className="p-6">
            {costTrend.length > 0 ? (
              <BarChart data={costTrend} />
            ) : (
              <p className="py-8 text-center text-sm text-text-secondary">
                No cost trend data available yet
              </p>
            )}
          </div>
        </div>

        {/* Agent Efficiency */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Agent Efficiency
            </h3>
          </div>
          <div className="p-6 space-y-4">
            {allAgents.length > 0 ? (
              allAgents.map((agent, i) => {
                const agentTasks = allTasks.filter((t) => t.assigneeAgentId === agent.id);
                const agentCompleted = agentTasks.filter((t) => t.status === "done").length;
                const efficiency = agentTasks.length > 0
                  ? Math.round((agentCompleted / agentTasks.length) * 100)
                  : 0;
                return (
                  <div key={agent.id} className="flex items-center gap-4">
                    <span className="flex h-7 w-7 items-center justify-center rounded-lg glass-raised text-xs font-semibold text-text-secondary tabular-nums font-display">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-text-primary truncate">
                        {agent.name}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {agentCompleted} / {agentTasks.length} tasks
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <TrendingUp className="h-3.5 w-3.5 text-success" />
                      <span className="text-sm font-semibold text-success tabular-nums font-display">
                        {efficiency}%
                      </span>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="py-4 text-center text-sm text-text-secondary">
                No agent data yet
              </p>
            )}
          </div>
        </div>

        {/* Budget by Agent */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Budget by Agent
            </h3>
          </div>
          <div className="p-6 space-y-5">
            {allAgents.length > 0 ? (
              allAgents.map((agent) => (
                <div key={agent.id}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-text-primary font-display">{agent.name}</span>
                    <span className="text-xs text-text-secondary tabular-nums font-display">
                      ${((agent.spentMonthlyCents ?? 0) / 100).toLocaleString()} / ${((agent.budgetMonthlyCents ?? 0) / 100).toLocaleString()}
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full bg-surface-overlay overflow-hidden">
                    <div
                      className="h-full rounded-full bg-accent transition-all duration-500 ease-out"
                      style={{
                        width: `${Math.min(100, agent.budgetMonthlyCents ? ((agent.spentMonthlyCents ?? 0) / agent.budgetMonthlyCents) * 100 : 0)}%`,
                      }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <p className="py-4 text-center text-sm text-text-secondary">
                No budget data yet
              </p>
            )}
          </div>
        </div>

        {/* Token Usage */}
        <div className="glass rounded-xl overflow-hidden">
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <h3 className="font-display text-sm font-semibold text-text-primary tracking-wide">
              Token Usage Breakdown
            </h3>
          </div>
          <div className="p-6">
            {tokenUsage.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.06] text-left">
                      <th className="pb-3 font-display font-medium text-text-secondary text-xs uppercase tracking-wider">Model</th>
                      <th className="pb-3 text-right font-display font-medium text-text-secondary text-xs uppercase tracking-wider">Tokens</th>
                      <th className="pb-3 text-right font-display font-medium text-text-secondary text-xs uppercase tracking-wider">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {tokenUsage.map((usage: any) => (
                      <tr key={usage.model}>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <Cpu className="h-4 w-4 text-neon-cyan" />
                            <span className="text-text-primary font-mono text-xs">
                              {usage.model}
                            </span>
                          </div>
                        </td>
                        <td className="py-3 text-right tabular-nums text-text-secondary font-display">
                          {((usage.tokens ?? 0) / 1000).toFixed(1)}k
                        </td>
                        <td className="py-3 text-right tabular-nums text-text-primary font-display">
                          ${(usage.cost ?? 0).toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-text-secondary">
                No token usage data yet
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
