import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderKanban, FileEdit, Loader2, ChevronRight, Trash2, Layers } from "lucide-react";
import {
  useCompanies,
  useProjectTemplates,
  useDeleteProjectTemplate,
  useCreateProjectFromTemplate,
} from "@/lib/hooks";
import { toast } from "sonner";

/**
 * Project template gallery section (VAL-TEMPLATE-003/011). Lists a company's
 * project templates and lets the user create a new project from one. The
 * new project's Artifacts tab opens populated with the cloned artifacts.
 *
 * Project templates are company-scoped, so the section includes a company
 * selector (the Templates page is a global gallery, not company-scoped).
 */
export function ProjectTemplateGallery() {
  const navigate = useNavigate();
  const { data: companies = [] } = useCompanies();
  const [selectedCompanyId, setSelectedCompanyId] = useState<string>(
    companies[0]?.id ?? "",
  );
  const companyId = selectedCompanyId || (companies[0]?.id ?? "");
  const { data: templates = [], isLoading } = useProjectTemplates(companyId || undefined);
  const deleteMutation = useDeleteProjectTemplate(companyId);
  const createFromTemplateMutation = useCreateProjectFromTemplate(companyId);

  const handleCreate = async (templateId: string, templateName: string) => {
    try {
      // Use a client-generated idempotency key per click so retries (e.g.
      // network blip + user clicks again) don't create duplicates. A fresh
      // click gets a fresh key (intentional new project).
      const idempotencyKey = `ui-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const result = await createFromTemplateMutation.mutateAsync({
        templateId,
        data: { name: `${templateName} Project`, idempotencyKey },
      });
      const newProject = (result as unknown as { data: { project: { id: string }; artifacts: unknown[] } }).data.project;
      toast.success(`Project created from template`);
      // Navigate to the new project's Artifacts tab (VAL-TEMPLATE-011).
      navigate(`/company/${companyId}/projects/${newProject.id}?tab=artifacts`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Create from template failed";
      toast.error(msg);
    }
  };

  const handleDelete = async (templateId: string, name: string) => {
    if (!window.confirm(`Delete project template "${name}"? This cannot be undone.`)) return;
    try {
      await deleteMutation.mutateAsync(templateId);
      toast.success(`Deleted ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Delete failed";
      toast.error(msg);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FolderKanban className="h-5 w-5 text-accent" />
          <h2 className="font-display text-lg font-semibold text-text-primary">
            Project Templates
          </h2>
          <span className="text-xs text-text-secondary">
            Save a project (artifacts + folders + settings) as a reusable template
          </span>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-secondary">
          Company
          <select
            value={selectedCompanyId}
            onChange={(e) => setSelectedCompanyId(e.target.value)}
            className="h-8 rounded-md bg-white/[0.04] border border-white/10 px-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent/50"
          >
            {!companies.length && <option value="">No companies</option>}
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!companyId ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FolderKanban className="h-10 w-10 text-text-secondary/40 mb-3" />
          <p className="text-sm text-text-secondary">
            Create a company first to save and reuse project templates.
          </p>
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
        </div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Layers className="h-10 w-10 text-text-secondary/40 mb-3" />
          <p className="text-sm text-text-secondary">No project templates yet</p>
          <p className="text-xs text-text-secondary/60 mt-1">
            Open a project and use "Save as Template" to create one.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="group flex flex-col rounded-xl border border-white/[0.06] bg-surface/60 p-5 transition-all duration-300 hover:border-accent/20"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  <FolderKanban className="h-5 w-5" />
                </div>
                <button
                  onClick={() => void handleDelete(tpl.id, tpl.name)}
                  title="Delete template"
                  className="rounded-md p-1 text-text-secondary hover:text-error hover:bg-error/10 transition-colors"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <h3 className="font-display text-sm font-semibold text-text-primary">
                {tpl.name}
              </h3>
              <p className="mt-1 text-xs text-text-secondary line-clamp-2 flex-1">
                {tpl.description ?? "No description"}
              </p>
              <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-text-secondary">
                <span className="inline-flex items-center gap-1">
                  <FileEdit className="h-3 w-3" />
                  <span className="tabular-nums font-display">{tpl.artifactCount} artifacts</span>
                </span>
                <span className="inline-flex items-center gap-1">
                  <Layers className="h-3 w-3" />
                  <span className="tabular-nums font-display">{tpl.folderCount} folders</span>
                </span>
              </div>
              <button
                onClick={() => void handleCreate(tpl.id, tpl.name)}
                disabled={createFromTemplateMutation.isPending}
                className="mt-4 inline-flex items-center justify-center gap-1 rounded-md h-8 px-3 text-xs font-medium text-surface bg-accent transition-all duration-200 hover:brightness-110 active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createFromTemplateMutation.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <>
                    Use Template
                    <ChevronRight className="h-3 w-3" />
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
