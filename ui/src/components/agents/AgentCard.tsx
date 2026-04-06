import { useNavigate } from "react-router-dom";
import { Bot } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import type { Agent } from "@/lib/api";

interface AgentCardProps {
  agent: Agent;
  companyId: string;
}

const roleColors: Record<string, string> = {
  ceo: "bg-warning/10 text-warning",
  cto: "bg-eidolon-500/10 text-eidolon-500",
  engineer: "bg-success/10 text-success",
  designer: "bg-purple-500/10 text-purple-400",
  marketer: "bg-error/10 text-error",
  analyst: "bg-blue-500/10 text-blue-400",
};

export function AgentCard({ agent, companyId }: AgentCardProps) {
  const navigate = useNavigate();
  const iconColor = roleColors[agent.role] || "bg-eidolon-500/10 text-eidolon-500";

  return (
    <div
      onClick={() => navigate(`/company/${companyId}/agents/${agent.id}`)}
      className="group flex flex-col gap-4 rounded-xl border border-border bg-surface-raised p-5 transition-all duration-200 hover:border-eidolon-500/30 hover:bg-surface-overlay hover:shadow-lg hover:shadow-black/20 cursor-pointer"
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div
            className={`flex h-10 w-10 items-center justify-center rounded-xl ${iconColor}`}
          >
            <Bot className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-text-primary group-hover:text-eidolon-200 transition-colors">
              {agent.name}
            </h3>
            <p className="text-xs text-text-secondary">{agent.title || agent.role}</p>
          </div>
        </div>
        <StatusIndicator status={agent.status === "working" ? "connected" : "disconnected"} />
      </div>

      <div className="flex items-center gap-2 rounded-lg bg-surface/50 px-3 py-2">
        <p className="text-xs text-text-secondary truncate">
          {agent.provider} / {agent.model}
        </p>
      </div>

      <div className="flex items-center justify-between border-t border-border/50 pt-3">
        <Badge variant="info">{agent.role}</Badge>
        <span className="text-xs text-accent tabular-nums">
          ${(agent.budgetMonthlyCents / 100).toLocaleString()}/mo
        </span>
      </div>
    </div>
  );
}
