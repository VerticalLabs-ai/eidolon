import { useState, useCallback, useEffect, useMemo } from "react";
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

  const { data: projects } = useProjects(companyId);
  const projectOptions = (projects ?? []).map((p) => ({
    value: p.id,
    label: p.name,
  }));

  // For company-level view: when "No project" is selected (projectId === ""),
  // fetch all artifacts and filter client-side for projectId === null.
  // When a specific project is selected, use the API's projectId filter.
  const queryParams = {
    ...(filters.projectId ? { projectId: filters.projectId } : {}),
    ...(filters.type ? { type: filters.type as ArtifactType } : {}),
    status: filters.status,
    limit: PAGE_SIZE,
    offset,
  };

  const { data, isLoading, isError, refetch } = useArtifacts(
    companyId,
    queryParams,
  );

  // When "No project" is selected, filter to only unscoped artifacts
  const displayedArtifacts = useMemo(() => {
    const rows = data?.rows ?? [];
    if (!filters.projectId) {
      return rows.filter((a) => a.projectId === null);
    }
    return rows;
  }, [data?.rows, filters.projectId]);

  const displayedTotal = useMemo(() => {
    if (!filters.projectId) {
      return displayedArtifacts.length;
    }
    return data?.meta.total ?? 0;
  }, [displayedArtifacts.length, data?.meta.total, filters.projectId]);
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
