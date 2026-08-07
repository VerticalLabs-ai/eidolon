import { useState, useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import {
  useArtifacts,
  useCreateArtifact,
} from "@/lib/hooks";
import { useServerEvents } from "@/lib/ws";
import { useQueryClient } from "@tanstack/react-query";
import { ArtifactList, type ArtifactListFilters } from "@/components/artifacts/ArtifactList";
import { ArtifactTypePicker } from "@/components/artifacts/ArtifactTypePicker";
import { ArtifactEditor } from "@/components/artifacts/ArtifactEditor";
import type { Artifact, ArtifactType } from "@/lib/api";

interface ProjectArtifactsProps {
  companyId: string;
  projectId: string;
}

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

export function ProjectArtifacts({ companyId, projectId }: ProjectArtifactsProps) {
  const [filters, setFilters] = useState<ArtifactListFilters>({
    type: "",
    status: "active",
    projectId: "",
  });
  const [offset, setOffset] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const qc = useQueryClient();

  // VAL-CROSS-020/028: Reset all Artifacts UI state when the company or project changes.
  // This prevents cross-company leakage (no stale C1 rows or selected artifact
  // lingering when the user switches to C2 or a different project).
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
  }, [companyId, projectId, selectedId]);

  const queryParams = {
    projectId,
    ...(filters.type ? { type: filters.type as ArtifactType } : {}),
    status: filters.status,
    limit: PAGE_SIZE,
    offset,
  };

  const { data, isLoading, isError, refetch } = useArtifacts(
    companyId,
    queryParams,
  );
  const createMutation = useCreateArtifact(companyId);

  // Realtime: refresh artifact list on any artifact.* event
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

  // Reset offset when filters change
  useEffect(() => {
    setOffset(0);
  }, [filters.type, filters.status, filters.projectId, projectId]);

  const handleCreate = useCallback(
    async (type: ArtifactType) => {
      setPickerOpen(false);
      try {
        const content =
          type === "document" ? defaultDocContent() : defaultSheetContent();
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
    [createMutation, projectId, companyId, qc],
  );

  if (selectedId) {
    return (
      <ArtifactEditor
        key={`${companyId}-${projectId}-${selectedId}`}
        companyId={companyId}
        artifactId={selectedId}
        projectId={projectId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="p-5 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-text-primary font-display">
            Artifacts
          </h2>
        </div>
        <ArtifactList
          artifacts={data?.rows ?? []}
          total={data?.meta.total ?? 0}
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
