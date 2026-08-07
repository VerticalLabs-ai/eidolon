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
import { useEffectiveCompanyId } from "@/lib/useCompanySwitchGuard";
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
  // effectiveCompanyId lags behind the URL companyId while a dirty-editor
  // switch is pending confirmation. Using it for the ArtifactEditor key
  // keeps the editor mounted (and the draft preserved) during the guard.
  const effectiveCompanyId = useEffectiveCompanyId() ?? companyId;
  const editorCompanyId = effectiveCompanyId ?? companyId;
  const [filters, setFilters] = useState<ArtifactListFilters>({
    type: "",
    status: "active",
    projectId: "",
  });
  const [offset, setOffset] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const qc = useQueryClient();

  // Reset Artifacts UI state when the effective company changes (confirmed).
  // Using editorCompanyId (from context) ensures this only fires after the
  // AppShell guard confirms the switch, not during the guard check.
  const prevEditorCompanyId = useRef(editorCompanyId);
  useEffect(() => {
    if (prevEditorCompanyId.current !== editorCompanyId) {
      setSelectedId(null);
      setPickerOpen(false);
      setFilters({ type: "", status: "active", projectId: "" });
      setOffset(0);
      prevEditorCompanyId.current = editorCompanyId;
    }
  }, [editorCompanyId, projectId]);

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
        key={`${editorCompanyId}-${projectId}-${selectedId}`}
        companyId={editorCompanyId}
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
