import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useArtifacts,
  useCreateArtifact,
  useProjects,
} from "@/lib/hooks";
import { useServerEvents } from "@/lib/ws";
import { useQueryClient } from "@tanstack/react-query";
import { ArtifactList, type ArtifactListFilters } from "@/components/artifacts/ArtifactList";
import { ArtifactTypePicker } from "@/components/artifacts/ArtifactTypePicker";
import { ArtifactEditor } from "@/components/artifacts/ArtifactEditor";
import type { Artifact, ArtifactType } from "@/lib/api";

const PAGE_SIZE = 20;

function defaultDocContent(): Record<string, unknown> {
  return { format: "markdown", body: "" };
}

function defaultSheetContent(): Record<string, unknown> {
  return {
    columns: [{ id: "col_1", key: "column1" }],
    rows: [{ id: "row_1", cells: { column1: { value: "" } } }],
  };
}

export function CompanyArtifacts() {
  const { companyId } = useParams();
  const [filters, setFilters] = useState<ArtifactListFilters>({
    type: "",
    status: "active",
    projectId: "",
  });
  const [offset, setOffset] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const qc = useQueryClient();

  // VAL-CROSS-020/028: Reset all Artifacts UI state when the company changes.
  // This prevents cross-company leakage (no stale C1 rows or selected artifact
  // lingering when the user switches to C2). If an editor was open with
  // unsaved content, warn the user that the draft was discarded.
  const prevCompanyId = useRef(companyId);
  useEffect(() => {
    if (prevCompanyId.current !== companyId) {
      if (selectedId) {
        toast.warning("Company changed — unsaved artifact draft discarded.");
      }
      setSelectedId(null);
      setPickerOpen(false);
      setFilters({ type: "", status: "active", projectId: "" });
      setOffset(0);
      prevCompanyId.current = companyId;
    }
  }, [companyId, selectedId]);

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
    status: filters.status,
    limit: PAGE_SIZE,
    offset,
  };

  const { data, isLoading, isError, refetch } = useArtifacts(
    companyId,
    queryParams,
  );

  // No need for client-side filtering anymore — the API now supports ?projectId=null
  const displayedArtifacts = useMemo(() => {
    return data?.rows ?? [];
  }, [data?.rows]);

  const displayedTotal = useMemo(() => {
    return data?.meta.total ?? 0;
  }, [data?.meta.total]);
  const createMutation = useCreateArtifact(companyId!);

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

  useEffect(() => {
    setOffset(0);
  }, [filters.type, filters.status, filters.projectId]);

  const handleCreate = useCallback(
    async (type: ArtifactType) => {
      setPickerOpen(false);
      try {
        const content =
          type === "document" ? defaultDocContent() : defaultSheetContent();
        // Create at company level (no project) unless a project filter is active
        const projectId = filters.projectId || null;
        const result = await createMutation.mutateAsync({
          type,
          title: `Untitled ${type === "document" ? "Document" : "Sheet"}`,
          content,
          projectId,
        });
        const created = (result as unknown as { data: Artifact }).data;
        toast.success(`${type === "document" ? "Document" : "Sheet"} created`);
        setSelectedId(created.id);
        qc.invalidateQueries({ queryKey: ["artifacts", companyId] });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Create failed";
        toast.error(msg);
      }
    },
    [createMutation, filters.projectId, companyId, qc],
  );

  if (selectedId) {
    return (
      <ArtifactEditor
        key={`${companyId}-${selectedId}`}
        companyId={companyId!}
        artifactId={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="p-5 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary font-display">
            Company Artifacts
          </h2>
        </div>
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
        />
      </div>
      <ArtifactTypePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleCreate}
      />
    </div>
  );
}
