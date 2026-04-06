import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Download,
  Users,
  Package,
  Code,
  Megaphone,
  ShoppingCart,
  Briefcase,
  PenTool,
  Layers,
  Sparkles,
  Tag,
  ChevronRight,
  Loader2,
  Check,
} from "lucide-react";
import { useTemplates, useImportTemplate, useSeedTemplates } from "@/lib/hooks";
import type { CompanyTemplate } from "@/lib/api";

const CATEGORIES = [
  { id: "all", label: "All Templates", icon: Layers },
  { id: "software", label: "Software", icon: Code },
  { id: "marketing", label: "Marketing", icon: Megaphone },
  { id: "ecommerce", label: "E-commerce", icon: ShoppingCart },
  { id: "consulting", label: "Consulting", icon: Briefcase },
  { id: "content", label: "Content", icon: PenTool },
];

const CATEGORY_COLORS: Record<string, string> = {
  software: "#f59e0b",
  marketing: "#8b5cf6",
  ecommerce: "#10b981",
  consulting: "#3b82f6",
  content: "#ec4899",
  general: "#6b7280",
};

export function Templates() {
  const navigate = useNavigate();
  const [activeCategory, setActiveCategory] = useState("all");
  const [selectedTemplate, setSelectedTemplate] = useState<CompanyTemplate | null>(null);
  const [importName, setImportName] = useState("");
  const [showImportModal, setShowImportModal] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);

  const { data: templates, isLoading } = useTemplates(activeCategory);
  const importMutation = useImportTemplate();
  const seedMutation = useSeedTemplates();

  // Auto-seed templates if none exist
  useEffect(() => {
    if (!isLoading && templates && templates.length === 0) {
      seedMutation.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, templates]);

  const handleImport = async () => {
    if (!selectedTemplate) return;
    try {
      const result = await importMutation.mutateAsync({
        templateId: selectedTemplate.id,
        overrides: importName ? { companyName: importName } : undefined,
      });
      const companyId = (result as any)?.data?.companyId ?? (result as any)?.companyId;
      setShowImportModal(false);
      setImportSuccess(companyId);
      setTimeout(() => {
        if (companyId) {
          navigate(`/company/${companyId}`);
        } else {
          navigate("/");
        }
      }, 1500);
    } catch (err) {
      console.error("Import failed:", err);
    }
  };

  const getConfig = (template: CompanyTemplate) => {
    try {
      return typeof template.config === "string"
        ? JSON.parse(template.config as any)
        : template.config;
    } catch {
      return { agents: [], goals: [], prompts: [] };
    }
  };

  return (
    <div className="min-h-dvh bg-surface">
      {/* Hero header */}
      <div className="relative border-b border-border bg-surface overflow-hidden">
        <div className="absolute inset-0 grid-bg opacity-40" />
        <div className="absolute inset-0 scan-lines pointer-events-none" />
        <div className="relative mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <button
            onClick={() => navigate("/")}
            className="mb-8 inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-accent transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Companies
          </button>

          <div className="flex items-center gap-4 mb-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 glow-accent">
              <Package className="h-7 w-7 text-amber-500" />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold tracking-wide text-text-primary">
                Template Gallery
              </h1>
              <p className="text-sm text-text-secondary">
                Pre-built AI company configurations ready to deploy
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Category tabs */}
      <div className="border-b border-border">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex items-center gap-1 -mb-px overflow-x-auto py-0">
            {CATEGORIES.map((cat) => {
              const Icon = cat.icon;
              const isActive = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  onClick={() => setActiveCategory(cat.id)}
                  className={`
                    flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-all whitespace-nowrap
                    ${
                      isActive
                        ? "border-amber-500 text-amber-500"
                        : "border-transparent text-text-secondary hover:text-text-primary hover:border-white/10"
                    }
                  `}
                >
                  <Icon className="h-4 w-4" />
                  {cat.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Template grid */}
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        {isLoading || seedMutation.isPending ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 text-amber-500 animate-spin" />
            <span className="ml-3 text-text-secondary">
              {seedMutation.isPending ? "Seeding templates..." : "Loading templates..."}
            </span>
          </div>
        ) : importSuccess ? (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/10 mb-4">
              <Check className="h-8 w-8 text-emerald-500" />
            </div>
            <h3 className="font-display text-lg font-semibold text-text-primary">
              Company Created Successfully
            </h3>
            <p className="text-sm text-text-secondary mt-1">
              Redirecting to your new company...
            </p>
          </div>
        ) : !templates?.length ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Package className="h-12 w-12 text-text-secondary/40 mb-4" />
            <h3 className="font-display text-lg font-semibold text-text-primary">
              No templates found
            </h3>
            <p className="text-sm text-text-secondary mt-1">
              No templates available in this category
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {templates.map((template) => {
              const config = getConfig(template);
              const agents = config.agents ?? [];
              const catColor = CATEGORY_COLORS[template.category] ?? CATEGORY_COLORS.general;

              return (
                <div
                  key={template.id}
                  className="group relative flex flex-col rounded-xl glass-raised p-6 transition-all duration-300 ease-out hover:glass-hover hover:-translate-y-1 hover:shadow-lg"
                  style={{ ["--cat-color" as any]: catColor }}
                >
                  {/* Category accent bar */}
                  <div
                    className="absolute top-0 left-6 right-6 h-0.5 rounded-b-full opacity-60"
                    style={{ backgroundColor: catColor }}
                  />

                  <div className="flex items-start justify-between mb-4">
                    <div
                      className="flex h-11 w-11 items-center justify-center rounded-xl"
                      style={{ backgroundColor: `${catColor}15` }}
                    >
                      <Sparkles className="h-5 w-5" style={{ color: catColor }} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                        style={{
                          backgroundColor: `${catColor}15`,
                          color: catColor,
                        }}
                      >
                        {template.category}
                      </span>
                    </div>
                  </div>

                  <h3 className="font-display text-base font-semibold text-text-primary group-hover:text-amber-500 transition-colors">
                    {template.name}
                  </h3>
                  <p className="mt-1.5 text-sm text-text-secondary line-clamp-2 flex-1">
                    {template.description ?? "No description"}
                  </p>

                  {/* Agent preview */}
                  {agents.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {agents.slice(0, 4).map((agent: any, i: number) => (
                        <span
                          key={i}
                          className="inline-flex items-center rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-text-secondary border border-white/5"
                        >
                          {agent.title || agent.role}
                        </span>
                      ))}
                      {agents.length > 4 && (
                        <span className="inline-flex items-center rounded-md bg-white/5 px-2 py-0.5 text-[11px] text-text-secondary border border-white/5">
                          +{agents.length - 4} more
                        </span>
                      )}
                    </div>
                  )}

                  {/* Stats and action */}
                  <div className="mt-5 flex items-center justify-between border-t border-white/[0.06] pt-4">
                    <div className="flex items-center gap-4 text-xs text-text-secondary">
                      <span className="flex items-center gap-1">
                        <Users className="h-3.5 w-3.5 text-amber-500/60" />
                        <span className="tabular-nums font-display">
                          {template.agentCount} agents
                        </span>
                      </span>
                      <span className="flex items-center gap-1">
                        <Download className="h-3.5 w-3.5 text-text-secondary/40" />
                        <span className="tabular-nums font-display">
                          {template.downloadCount}
                        </span>
                      </span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedTemplate(template);
                        setImportName("");
                        setShowImportModal(true);
                      }}
                      className="inline-flex items-center gap-1 rounded-md h-7 px-3 text-xs font-medium text-surface bg-amber-500 transition-all duration-200 hover:brightness-110 active:scale-[0.97]"
                    >
                      Use Template
                      <ChevronRight className="h-3 w-3" />
                    </button>
                  </div>

                  {/* Tags */}
                  {template.tags && template.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
                      {(template.tags as string[]).map((tag, i) => (
                        <span
                          key={i}
                          className="inline-flex items-center gap-0.5 rounded-full bg-white/[0.03] px-2 py-0.5 text-[10px] text-text-secondary/60"
                        >
                          <Tag className="h-2.5 w-2.5" />
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Import modal */}
      {showImportModal && selectedTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="glass-raised rounded-2xl w-full max-w-lg mx-4 p-6 shadow-2xl border border-white/10">
            <h2 className="font-display text-lg font-semibold text-text-primary mb-1">
              Create from Template
            </h2>
            <p className="text-sm text-text-secondary mb-6">
              Create a new AI company based on "{selectedTemplate.name}"
            </p>

            {/* Template preview */}
            <div className="glass rounded-xl p-4 mb-6">
              <div className="flex items-center gap-3 mb-3">
                <Sparkles className="h-5 w-5 text-amber-500" />
                <span className="font-display text-sm font-medium text-text-primary">
                  {selectedTemplate.name}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs text-text-secondary">
                <div>
                  <span className="text-text-secondary/60">Agents:</span>{" "}
                  <span className="text-text-primary font-display tabular-nums">
                    {selectedTemplate.agentCount}
                  </span>
                </div>
                <div>
                  <span className="text-text-secondary/60">Category:</span>{" "}
                  <span className="text-text-primary capitalize">{selectedTemplate.category}</span>
                </div>
              </div>

              {/* Agent role list */}
              {(() => {
                const config = getConfig(selectedTemplate);
                const agents = config.agents ?? [];
                if (agents.length === 0) return null;
                return (
                  <div className="mt-3 pt-3 border-t border-white/[0.06]">
                    <p className="text-[11px] text-text-secondary/60 uppercase tracking-wider mb-2">
                      Team Members
                    </p>
                    <div className="space-y-1">
                      {agents.map((agent: any, i: number) => (
                        <div key={i} className="flex items-center justify-between text-xs">
                          <span className="text-text-primary">{agent.name}</span>
                          <span className="text-text-secondary">{agent.title || agent.role}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* Company name override */}
            <label className="block mb-4">
              <span className="text-xs font-medium text-text-secondary mb-1 block">
                Company Name (optional override)
              </span>
              <input
                type="text"
                value={importName}
                onChange={(e) => setImportName(e.target.value)}
                placeholder={(() => {
                  const config = getConfig(selectedTemplate);
                  return config.name ?? "My New Company";
                })()}
                className="w-full h-9 rounded-md bg-white/[0.04] border border-white/10 px-3 text-sm text-text-primary placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-amber-500/50 focus:border-amber-500/50"
              />
            </label>

            {/* Actions */}
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowImportModal(false)}
                className="h-9 px-4 rounded-md text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImport}
                disabled={importMutation.isPending}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-md text-sm font-medium text-surface bg-amber-500 transition-all duration-200 hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importMutation.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  <>
                    <Download className="h-4 w-4" />
                    Create Company
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
