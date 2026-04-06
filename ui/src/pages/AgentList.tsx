import { useState } from "react";
import { useParams } from "react-router-dom";
import { Plus, Bot, Filter } from "lucide-react";
import { useAgents } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/EmptyState";
import { AgentCard } from "@/components/agents/AgentCard";
import { CreateAgentModal } from "@/components/agents/CreateAgentModal";
import { PageTransition } from "@/components/ui/PageTransition";

const roleOptions = [
  { value: "", label: "All Roles" },
  { value: "engineering", label: "Engineering" },
  { value: "marketing", label: "Marketing" },
  { value: "sales", label: "Sales" },
  { value: "operations", label: "Operations" },
  { value: "design", label: "Design" },
  { value: "research", label: "Research" },
];

const statusOptions = [
  { value: "", label: "All Status" },
  { value: "working", label: "Working" },
  { value: "idle", label: "Idle" },
  { value: "error", label: "Error" },
  { value: "offline", label: "Offline" },
];

export function AgentList() {
  const { companyId } = useParams();
  const { data: agents, isLoading } = useAgents(companyId);
  const [modalOpen, setModalOpen] = useState(false);
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const filtered = (agents ?? []).filter((a) => {
    if (roleFilter && a.role.toLowerCase() !== roleFilter) return false;
    if (statusFilter && a.status !== statusFilter) return false;
    return true;
  });

  return (
    <PageTransition>
    <div className="mx-auto max-w-7xl p-6 lg:p-8 space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold text-text-primary tracking-tight">
            Agents
          </h2>
          <p className="text-sm text-text-secondary mt-1">
            Manage your AI workforce
          </p>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md h-8 px-3 text-xs font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97]"
        >
          <Plus className="h-4 w-4" />
          Hire Agent
        </button>
      </div>

      {/* Filters */}
      <div className="glass rounded-xl px-5 py-4 flex flex-wrap items-center gap-4">
        <Filter className="h-4 w-4 text-neon-cyan" />
        <div className="w-44">
          <Select
            options={roleOptions}
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          />
        </div>
        <div className="w-44">
          <Select
            options={statusOptions}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          />
        </div>
        {(roleFilter || statusFilter) && (
          <button
            onClick={() => { setRoleFilter(""); setStatusFilter(""); }}
            className="text-xs text-neon-cyan hover:text-neon-cyan/80 transition-colors duration-200 cursor-pointer"
          >
            Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-xl glass"
            />
          ))}
        </div>
      ) : !filtered.length ? (
        <EmptyState
          icon={<Bot className="h-6 w-6" />}
          title="No agents found"
          description={
            roleFilter || statusFilter
              ? "Try adjusting your filters."
              : "Hire your first AI agent to get started."
          }
          action={
            !roleFilter && !statusFilter ? (
              <button
                onClick={() => setModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md h-8 px-3 text-xs font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97]"
              >
                <Plus className="h-4 w-4" />
                Hire Agent
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((agent) => (
            <AgentCard key={agent.id} agent={agent} companyId={companyId!} />
          ))}
        </div>
      )}

      <CreateAgentModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        companyId={companyId!}
      />
    </div>
    </PageTransition>
  );
}
