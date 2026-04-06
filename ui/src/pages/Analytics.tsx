import { useState } from "react";
import { useParams } from "react-router-dom";
import { BarChart3, DollarSign } from "lucide-react";
import { Tabs } from "@/components/ui/Tabs";
import { Card } from "@/components/ui/Card";
import { AnalyticsDashboard } from "@/pages/AnalyticsDashboard";
import { AgentPerformance } from "@/pages/AgentPerformance";
import { useAgents } from "@/lib/hooks";
import type { Tab } from "@/components/ui/Tabs";

const tabs: Tab[] = [
  { id: "overview", label: "Overview" },
  { id: "performance", label: "Agent Performance" },
  { id: "costs", label: "Costs" },
];

function CostsTab() {
  const { companyId } = useParams();
  const { data: agents, isLoading } = useAgents(companyId);

  const allAgents = agents ?? [];
  const totalBudgetCents = allAgents.reduce(
    (s, a) => s + (a.budgetMonthlyCents ?? 0),
    0,
  );
  const totalSpentCents = allAgents.reduce(
    (s, a) => s + (a.spentMonthlyCents ?? 0),
    0,
  );
  const remaining = totalBudgetCents - totalSpentCents;
  const utilizationPct =
    totalBudgetCents > 0
      ? Math.round((totalSpentCents / totalBudgetCents) * 100)
      : 0;

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl glass" />
        ))}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-6 lg:p-8 space-y-8">
      {/* Summary row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning/10">
              <DollarSign className="h-5 w-5 text-warning" />
            </div>
            <div>
              <p className="text-xs text-text-secondary uppercase tracking-wider font-display">
                Total Spent
              </p>
              <p className="text-2xl font-bold text-text-primary font-display tabular-nums">
                ${(totalSpentCents / 100).toLocaleString()}
              </p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-success/10">
              <DollarSign className="h-5 w-5 text-success" />
            </div>
            <div>
              <p className="text-xs text-text-secondary uppercase tracking-wider font-display">
                Remaining Budget
              </p>
              <p className="text-2xl font-bold text-text-primary font-display tabular-nums">
                ${(remaining / 100).toLocaleString()}
              </p>
            </div>
          </div>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-neon-purple/10">
              <BarChart3 className="h-5 w-5 text-neon-purple" />
            </div>
            <div>
              <p className="text-xs text-text-secondary uppercase tracking-wider font-display">
                Utilization
              </p>
              <p className="text-2xl font-bold text-text-primary font-display tabular-nums">
                {utilizationPct}%
              </p>
            </div>
          </div>
        </Card>
      </div>

      {/* Per-agent breakdown */}
      <Card
        header={
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4 text-accent" />
            Budget Breakdown by Agent
          </div>
        }
      >
        {allAgents.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-secondary">
            No agents with budget data
          </p>
        ) : (
          <div className="space-y-5">
            {allAgents.map((agent) => {
              const budget = agent.budgetMonthlyCents ?? 0;
              const spent = agent.spentMonthlyCents ?? 0;
              const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
              const isOverBudget = spent > budget && budget > 0;

              return (
                <div key={agent.id}>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-text-primary font-display">
                      {agent.name}
                    </span>
                    <span className="text-xs text-text-secondary tabular-nums font-display">
                      <span className={isOverBudget ? "text-error" : ""}>
                        ${(spent / 100).toLocaleString()}
                      </span>{" "}
                      / ${(budget / 100).toLocaleString()}
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full bg-surface-overlay overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ease-out ${
                        isOverBudget ? "bg-error" : "bg-accent"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

export function Analytics() {
  const [activeTab, setActiveTab] = useState("overview");

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      <div className="shrink-0 bg-surface">
        <div className="flex items-center gap-3 px-5 pt-4 pb-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/15">
            <BarChart3 className="h-4 w-4 text-accent" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-text-primary font-display tracking-wide">
              Analytics
            </h1>
          </div>
        </div>
        <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "overview" && <AnalyticsDashboard />}
        {activeTab === "performance" && <AgentPerformance />}
        {activeTab === "costs" && <CostsTab />}
      </div>
    </div>
  );
}
