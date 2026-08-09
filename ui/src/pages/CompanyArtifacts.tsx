import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useArtifacts,
  useCreateArtifact,
  useProjects,
  useFolders,
} from "@/lib/hooks";
import { useServerEvents } from "@/lib/ws";
import { useQueryClient } from "@tanstack/react-query";
import { ArtifactList, type ArtifactListFilters } from "@/components/artifacts/ArtifactList";
import { ArtifactTypePicker } from "@/components/artifacts/ArtifactTypePicker";
import { ArtifactTemplatePicker } from "@/components/artifacts/ArtifactTemplatePicker";
import { ArtifactEditor } from "@/components/artifacts/ArtifactEditor";
import { FolderTree, FolderBreadcrumbs } from "@/components/artifacts/FolderTree";
import {
  artifactTypeLabel,
  defaultArtifactContent,
} from "@/components/artifacts/artifact-defaults";
import { useCreateArtifactFromTemplate } from "@/lib/hooks";
import type { Artifact, ArtifactType } from "@/lib/api";

const PAGE_SIZE = 20;

export function CompanyArtifacts() {
  const { companyId } = useParams();
  // useBlocker in AppShell prevents navigation away from this company when the
  // editor is dirty, so the URL companyId stays stable and the editor remains
  // mounted with its draft intact. No effectiveCompanyId lag is needed.
  const [filters, setFilters] = useState<ArtifactListFilters>({
    type: "",
    status: "active",
    projectId: "",
    sort: "updatedAt",
    order: "desc",
  });
  const [offset, setOffset] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // ── Folder selection (M4) ──────────────────────────────────────────────
  // Company-level folders have projectId=null.
  const [selectionMode, setSelectionMode] = useState<"all" | "folder" | "unfiled">("all");
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const { data: folders = [] } = useFolders(companyId, null);

  // Move focus into the Artifacts content area on mount so keyboard users
  // can Tab through the filters and artifact list (VAL-ART-064/VAL-CROSS-017).
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Auto-select an artifact passed via the ?artifactId= query param (e.g. from
  // a ThreadArtifactCard link in a thread). On back, clear the param so the
  // list view is shown rather than re-opening the editor.
  useEffect(() => {
    const paramId = searchParams.get("artifactId");
    if (paramId && !selectedId) {
      setSelectedId(paramId);
    }
  }, [searchParams, selectedId]);

  const handleBack = useCallback(() => {
    setSelectedId(null);
    const next = new URLSearchParams(searchParams);
    if (next.has("artifactId")) {
      next.delete("artifactId");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Reset Artifacts UI state when the company changes.
  const prevCompanyId = useRef(companyId);
  useEffect(() => {
    if (prevCompanyId.current !== companyId) {
      setSelectedId(null);
      setPickerOpen(false);
      setFilters({ type: "", status: "active", projectId: "", sort: "updatedAt", order: "desc" });
      setOffset(0);
      prevCompanyId.current = companyId;
    }
  }, [companyId]);

  const { data: projects } = useProjects(companyId);
  const projectOptions = (projects ?? []).map((p) => ({
    value: p.id,
    label: p.name,
  }));

  // For company-level view: when "No project" is selected (projectId === ""),
  // use the server-side ?projectId=null filter to get only unscoped artifacts.
  // When a specific project is selected, use the API's projectId filter.
  const queryParams = {
    ...(filters.projectId ? { projectId: filters.projectId } : { projectId: "null" as const }),
    ...(filters.type ? { type: filters.type as ArtifactType } : {}),
    ...(selectionMode === "folder" && selectedFolderId ? { folderId: selectedFolderId } : {}),
    ...(selectionMode === "unfiled" ? { folderId: "null" as const } : {}),
    status: filters.status,
    limit: PAGE_SIZE,
    offset,
    sort: filters.sort,
    order: filters.order,
  };

  const { data, isLoading, isError, refetch } = useArtifacts(
    companyId,
    queryParams,
  );

  const displayedArtifacts = useMemo(() => {
    return data?.rows ?? [];
  }, [data?.rows]);

  const displayedTotal = useMemo(() => {
    return data?.meta.total ?? 0;
  }, [data?.meta.total]);
  const createMutation = useCreateArtifact(companyId!);
  const createFromTemplateMutation = useCreateArtifactFromTemplate(companyId!);

  useServerEvents(companyId, "artifact.created", () => {
    qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
  });
  useServerEvents(companyId, "artifact.updated", () => {
    qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
  });
  useServerEvents(companyId, "artifact.deleted", () => {
    qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
  });
  useServerEvents(companyId, "artifact.archived", () => {
    qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
  });
  // Realtime: refresh folder tree on folder.* events (VAL-FOLDER-013)
  useServerEvents(companyId, "folder.created", () => {
    qc.invalidateQueries({ queryKey: ["folders", companyId] });
  });
  useServerEvents(companyId, "folder.updated", () => {
    qc.invalidateQueries({ queryKey: ["folders", companyId] });
  });
  useServerEvents(companyId, "folder.deleted", () => {
    qc.invalidateQueries({ queryKey: ["folders", companyId] });
    qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
  });

  useEffect(() => {
    setOffset(0);
  }, [filters.type, filters.status, filters.projectId, filters.sort, filters.order, selectionMode, selectedFolderId]);

  const handleSelectFolder = useCallback((folderId: string) => {
    setSelectedFolderId(folderId);
    setSelectionMode("folder");
    setOffset(0);
  }, []);
  const handleSelectAll = useCallback(() => {
    setSelectedFolderId(null);
    setSelectionMode("all");
    setOffset(0);
  }, []);
  const handleSelectUnfiled = useCallback(() => {
    setSelectedFolderId(null);
    setSelectionMode("unfiled");
    setOffset(0);
  }, []);
  const handleBreadcrumbNavigate = useCallback(
    (folderId: string | null, mode: "all" | "folder" | "unfiled") => {
      setSelectedFolderId(folderId);
      setSelectionMode(mode);
      setOffset(0);
    },
    [],
  );

  const handleCreate = useCallback(
    async (type: ArtifactType) => {
      setPickerOpen(false);
      try {
        const label = artifactTypeLabel(type);
        // Create at company level (no project) unless a project filter is active
        const projectId = filters.projectId || null;
        const result = await createMutation.mutateAsync({
          type,
          title: `Untitled ${label}`,
          content: defaultArtifactContent(type),
          projectId,
        });
        const created = (result as unknown as { data: Artifact }).data;
        toast.success(`${label} created`);
        setSelectedId(created.id);
        qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Create failed";
        toast.error(msg);
      }
    },
    [createMutation, filters.projectId, companyId, qc],
  );

  const handleCreateFromTemplate = useCallback(
    async (templateId: string, templateName: string) => {
      setTemplatePickerOpen(false);
      try {
        const projectId = filters.projectId || null;
        const result = await createFromTemplateMutation.mutateAsync({
          templateId,
          data: { projectId, title: `${templateName} copy` },
        });
        const created = (result as unknown as { data: Artifact }).data;
        toast.success(`Artifact created from template`);
        setSelectedId(created.id);
        qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Create from template failed";
        toast.error(msg);
      }
    },
    [createFromTemplateMutation, filters.projectId, companyId, qc],
  );

  if (selectedId) {
    return (
      <ArtifactEditor
        key={`${companyId}-${selectedId}`}
        companyId={companyId!}
        artifactId={selectedId}
        onBack={handleBack}
      />
    );
  }

  return (
    <div className="p-5 sm:p-6">
      <div className="mx-auto flex max-w-6xl gap-4">
        {/* Folder tree sidebar (M4) */}
        <aside className="w-48 shrink-0">
          <div className="rounded-xl border border-white/[0.06] bg-surface/60">
            <FolderTree
              companyId={companyId!}
              projectId={null}
              folders={folders}
              selectedFolderId={selectedFolderId}
              selectionMode={selectionMode}
              onSelectAll={handleSelectAll}
              onSelectFolder={handleSelectFolder}
              onSelectUnfiled={handleSelectUnfiled}
            />
          </div>
        </aside>
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex items-center justify-between">
            <h2 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-text-primary font-display focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded">
              Company Artifacts
            </h2>
          </div>
          <FolderBreadcrumbs
            folders={folders}
            selectedFolderId={selectedFolderId}
            selectionMode={selectionMode}
            onNavigate={handleBreadcrumbNavigate}
          />
          <p className="text-xs text-text-secondary">
            Artifacts not tied to a specific project. Select a project filter to
            view project-scoped artifacts.
          </p>
          <ArtifactList
            artifacts={displayedArtifacts}
            total={displayedTotal}
            limit={PAGE_SIZE}
            offset={offset}
            filters={filters}
            onFiltersChange={setFilters}
            onPageChange={setOffset}
            onSelect={(a) => setSelectedId(a.id)}
            onCreate={() => setPickerOpen(true)}
            isLoading={isLoading}
            isError={isError}
            onRetry={() => void refetch()}
            projectOptions={projectOptions}
            folders={folders}
            companyId={companyId}
          />
        </div>
      </div>
      <ArtifactTypePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleCreate}
        onSelectFromTemplate={() => {
          setPickerOpen(false);
          setTemplatePickerOpen(true);
        }}
      />
      <ArtifactTemplatePicker
        open={templatePickerOpen}
        onClose={() => setTemplatePickerOpen(false)}
        companyId={companyId!}
        onSelect={handleCreateFromTemplate}
      />
    </div>
  );
}
