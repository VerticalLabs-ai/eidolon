import { useParams, useNavigate } from "react-router-dom";
import { Bot, Network } from "lucide-react";
import { useOrgChart } from "@/lib/hooks";
import { StatusIndicator } from "@/components/ui/StatusIndicator";
import { EmptyState } from "@/components/ui/EmptyState";
import { clsx } from "clsx";
import type { OrgChartNode } from "@/lib/api";

const roleAccent: Record<string, { bg: string; text: string; glow: string }> = {
  engineering: { bg: "bg-neon-cyan/10", text: "text-neon-cyan", glow: "0 0 12px rgba(0,243,255,0.15)" },
  design: { bg: "bg-neon-purple/10", text: "text-neon-purple", glow: "0 0 12px rgba(189,0,255,0.15)" },
  marketing: { bg: "bg-warning/10", text: "text-warning", glow: "0 0 12px rgba(255,170,0,0.15)" },
  sales: { bg: "bg-success/10", text: "text-success", glow: "0 0 12px rgba(0,230,138,0.15)" },
  operations: { bg: "bg-neon-cyan/10", text: "text-neon-cyan", glow: "0 0 12px rgba(0,243,255,0.15)" },
  research: { bg: "bg-neon-purple/10", text: "text-neon-purple", glow: "0 0 12px rgba(189,0,255,0.15)" },
};

const defaultAccent = { bg: "bg-neon-cyan/10", text: "text-neon-cyan", glow: "0 0 12px rgba(0,243,255,0.15)" };

function OrgNodeCard({
  node,
  companyId,
}: {
  node: OrgChartNode;
  companyId: string;
}) {
  const navigate = useNavigate();
  const agent = node;
  const accent = roleAccent[agent.role?.toLowerCase()] ?? defaultAccent;

  return (
    <div className="flex flex-col items-center">
      {/* Node card */}
      <div
        onClick={() => navigate(`/company/${companyId}/agents/${agent.id}`)}
        className="group relative flex w-52 flex-col items-center rounded-xl glass-raised p-5 transition-all duration-300 ease-out hover:glass-hover hover:-translate-y-1 cursor-pointer"
        style={{ boxShadow: "none" }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLElement).style.boxShadow = accent.glow;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLElement).style.boxShadow = "none";
        }}
      >
        {/* Role color accent bar */}
        <div
          className={clsx("absolute top-0 left-4 right-4 h-0.5 rounded-b-full", accent.bg)}
          style={{ backgroundColor: accent.text.includes("cyan") ? "#00f3ff" : accent.text.includes("purple") ? "#bd00ff" : accent.text.includes("warning") ? "#ffaa00" : accent.text.includes("success") ? "#00e68a" : "#00f3ff", opacity: 0.5 }}
        />

        <div className={clsx("flex h-12 w-12 items-center justify-center rounded-xl mb-3", accent.bg)}>
          <Bot className={clsx("h-6 w-6", accent.text)} />
        </div>
        <p className="font-display text-sm font-semibold text-text-primary text-center group-hover:text-neon-cyan transition-colors duration-200">
          {agent.name}
        </p>
        <p className="text-xs text-text-secondary text-center mt-1">
          {agent.title ?? agent.role}
        </p>
        <div className="mt-3">
          <StatusIndicator status={agent.status === "working" ? "connected" : "disconnected"} label={agent.status} size="sm" />
        </div>
      </div>

      {/* Children */}
      {node.children.length > 0 && (
        <>
          {/* Vertical connector with neon glow */}
          <div
            className="h-8 w-px"
            style={{
              background: "rgba(240,180,41,0.3)",
            }}
          />

          {/* Horizontal connector + children */}
          <div className="relative flex gap-8">
            {/* Horizontal line across top of children */}
            {node.children.length > 1 && (
              <div
                className="absolute top-0 h-px"
                style={{
                  left: "calc(50% - 50% + 104px)",
                  right: "calc(50% - 50% + 104px)",
                  background: "rgba(240,180,41,0.2)",
                }}
              />
            )}

            {node.children.map((child) => (
              <div key={child.id} className="flex flex-col items-center">
                <div
                  className="h-8 w-px"
                  style={{
                    background: "rgba(240,180,41,0.3)",
                  }}
                />
                <OrgNodeCard node={child} companyId={companyId} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function OrgChart() {
  const { companyId } = useParams();
  const { data, isLoading } = useOrgChart(companyId);
  const tree = data ?? [];

  return (
    <div className="p-6 lg:p-8 space-y-8">
      <div>
        <h2 className="font-display text-2xl font-bold text-text-primary tracking-tight">
          Organization Chart
        </h2>
        <p className="text-sm text-text-secondary mt-1">
          Agent hierarchy and reporting structure
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="h-48 w-48 animate-pulse rounded-xl glass" />
        </div>
      ) : !tree.length ? (
        <EmptyState
          icon={<Network className="h-6 w-6" />}
          title="No org chart available"
          description="The organization chart will appear once agents are set up with reporting relationships."
        />
      ) : (
        <div className="overflow-x-auto pb-8 grid-bg rounded-xl">
          <div className="flex justify-center min-w-max py-8 gap-10">
            {tree.map((root) => (
              <OrgNodeCard key={root.id} node={root} companyId={companyId!} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
