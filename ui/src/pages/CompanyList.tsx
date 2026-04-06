import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  Building2,
  Bot,
  Zap,
  Users,
  ListChecks,
  DollarSign,
  Package,
  Archive,
  Trash2,
} from "lucide-react";
import { useCompanies, useDeleteCompany } from "@/lib/hooks";
import type { Company, DashboardData } from "@/lib/api";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { CreateCompanyModal } from "@/components/companies/CreateCompanyModal";

interface CompanyWithStats extends Company {
  agentCount?: number;
  taskCount?: number;
}

export function CompanyList() {
  const [modalOpen, setModalOpen] = useState(false);
  const navigate = useNavigate();

  // Direct fetch as fallback since React Query may have caching issues in dev
  const [companies, setCompanies] = useState<CompanyWithStats[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const deleteCompany = useDeleteCompany();

  useEffect(() => {
    async function fetchData() {
      try {
        const res = await fetch("/api/companies");
        const json = await res.json();
        const list: Company[] = Array.isArray(json) ? json : json.data ?? [];

        // Fetch dashboard data for each company to get agent/task counts
        const enriched: CompanyWithStats[] = await Promise.all(
          list.map(async (company) => {
            try {
              const dashRes = await fetch(
                `/api/companies/${company.id}/dashboard`,
              );
              const dashJson = await dashRes.json();
              const dash: DashboardData =
                dashJson && typeof dashJson === "object" && "data" in dashJson
                  ? dashJson.data
                  : dashJson;
              return {
                ...company,
                agentCount: dash?.agents?.total ?? 0,
                taskCount: dash?.tasks?.total ?? 0,
              };
            } catch {
              return { ...company, agentCount: 0, taskCount: 0 };
            }
          }),
        );

        setCompanies(enriched);
        setIsLoading(false);
      } catch {
        setIsLoading(false);
      }
    }
    fetchData();
  }, [modalOpen, refreshKey]); // refetch when modal closes or after delete

  const totalAgents = companies.reduce(
    (sum, c) => sum + (c.agentCount ?? 0),
    0,
  );
  const totalTasks = companies.reduce(
    (sum, c) => sum + (c.taskCount ?? 0),
    0,
  );

  return (
    <div className="min-h-dvh bg-surface">
      {/* Hero header */}
      <div className="relative border-b border-border bg-surface overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-40" />
        <div className="absolute inset-0 scan-lines pointer-events-none" />
        <div className="relative mx-auto max-w-5xl px-4 py-20 sm:px-6 text-center">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent/10 glow-accent">
            <Zap className="h-8 w-8 text-accent" />
          </div>
          <h1 className="font-display text-3xl font-bold tracking-[0.2em] text-text-primary uppercase">
            EIDOLON
          </h1>
          <p className="mt-3 text-base text-text-secondary">
            The AI Company Runtime
          </p>
          <button
            onClick={() => navigate("/templates")}
            className="mt-5 inline-flex items-center gap-2 rounded-lg h-9 px-4 text-sm font-medium text-amber-500 bg-amber-500/10 border border-amber-500/20 transition-all duration-200 hover:bg-amber-500/20 hover:border-amber-500/30 active:scale-[0.97]"
          >
            <Package className="h-4 w-4" />
            Browse Templates
          </button>
        </div>
      </div>

      {/* Agency dashboard bar */}
      {companies.length > 0 && (
        <div className="border-b border-border">
          <div className="mx-auto max-w-5xl px-4 py-4 sm:px-6">
            <div className="glass rounded-xl px-6 py-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-text-primary tracking-wide uppercase">
                  Agency Dashboard
                </h2>
                <div className="flex items-center gap-6 text-sm">
                  <span className="flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-accent" />
                    <span className="font-display tabular-nums text-accent">
                      {companies.length}
                    </span>
                    <span className="text-text-secondary">
                      {companies.length === 1 ? "company" : "companies"}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <Users className="h-4 w-4 text-neon-purple" />
                    <span className="font-display tabular-nums text-neon-purple">
                      {totalAgents}
                    </span>
                    <span className="text-text-secondary">agents</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <ListChecks className="h-4 w-4 text-success" />
                    <span className="font-display tabular-nums text-success">
                      {totalTasks}
                    </span>
                    <span className="text-text-secondary">tasks</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <div className="mb-8 flex items-center justify-between">
          <h2 className="font-display text-xl font-semibold text-text-primary">
            Your Companies
          </h2>
          <button
            onClick={() => setModalOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md h-8 px-3 text-xs font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97]"
          >
            <Plus className="h-4 w-4" />
            Create Company
          </button>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-56 animate-pulse rounded-xl glass"
              />
            ))}
          </div>
        ) : !companies?.length ? (
          <EmptyState
            icon={<Building2 className="h-6 w-6" />}
            title="No companies yet"
            description="Create your first AI-powered company to get started."
            action={
              <button
                onClick={() => setModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md h-8 px-3 text-xs font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97]"
              >
                <Plus className="h-4 w-4" />
                Create Company
              </button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {companies.map((company) => (
              <div
                key={company.id}
                onClick={() => navigate(`/company/${company.id}`)}
                className="group relative flex flex-col justify-between rounded-xl glass-raised p-6 transition-all duration-300 ease-out hover:glass-hover cursor-pointer hover:-translate-y-1 hover:shadow-lg hover:shadow-accent/10"
              >
                {/* Neon border on hover */}
                <div className="absolute inset-0 rounded-xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 neon-border pointer-events-none" />

                {/* Brand color accent bar */}
                <div
                  className="absolute top-0 left-6 right-6 h-0.5 rounded-b-full opacity-60"
                  style={{
                    backgroundColor: company.brandColor ?? "#00f3ff",
                  }}
                />

                <div className="relative">
                  <div className="flex items-start justify-between mb-4">
                    <div
                      className="flex h-11 w-11 items-center justify-center rounded-xl"
                      style={{
                        backgroundColor: company.brandColor
                          ? `${company.brandColor}15`
                          : "rgba(0,243,255,0.1)",
                      }}
                    >
                      <Building2
                        className="h-5 w-5"
                        style={{
                          color: company.brandColor ?? "#00f3ff",
                        }}
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Badge
                        variant={
                          company.status === "active"
                            ? "success"
                            : company.status === "paused"
                              ? "warning"
                              : "default"
                        }
                      >
                        {company.status}
                      </Badge>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Archive "${company.name}"? This can be undone.`)) {
                            deleteCompany.mutate({ id: company.id }, {
                              onSuccess: () => setRefreshKey((k) => k + 1),
                            });
                          }
                        }}
                        title="Archive company"
                        className="rounded-md p-1 text-text-secondary opacity-0 group-hover:opacity-100 hover:text-warning hover:bg-warning/10 transition-all duration-200 cursor-pointer"
                      >
                        <Archive className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Permanently delete "${company.name}" and ALL its data? This cannot be undone.`)) {
                            deleteCompany.mutate({ id: company.id, hard: true }, {
                              onSuccess: () => setRefreshKey((k) => k + 1),
                            });
                          }
                        }}
                        title="Permanently delete company"
                        className="rounded-md p-1 text-text-secondary opacity-0 group-hover:opacity-100 hover:text-error hover:bg-error/10 transition-all duration-200 cursor-pointer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <h3 className="font-display text-base font-semibold text-text-primary group-hover:text-accent transition-colors duration-200">
                    {company.name}
                  </h3>
                  <p className="mt-1.5 text-sm text-text-secondary line-clamp-2">
                    {company.mission || company.description || "No description"}
                  </p>
                </div>

                {/* Stats row */}
                <div className="relative mt-5 grid grid-cols-3 gap-3 border-t border-white/[0.06] pt-4">
                  <div className="flex items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5 text-neon-cyan/60" />
                    <span className="text-xs text-text-secondary tabular-nums font-display">
                      {company.agentCount ?? 0} agents
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ListChecks className="h-3.5 w-3.5 text-neon-purple/60" />
                    <span className="text-xs text-text-secondary tabular-nums font-display">
                      {company.taskCount ?? 0} tasks
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 justify-end">
                    <DollarSign className="h-3.5 w-3.5 text-success/60" />
                    <span className="text-xs text-text-secondary tabular-nums font-display">
                      {(company.spentMonthlyCents / 100).toLocaleString(
                        undefined,
                        { maximumFractionDigits: 0 },
                      )}
                      /
                      {(company.budgetMonthlyCents / 100).toLocaleString(
                        undefined,
                        { maximumFractionDigits: 0 },
                      )}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <CreateCompanyModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
