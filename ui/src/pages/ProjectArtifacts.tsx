import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  useArtifacts,
  useCreateArtifact,
  useProjectPresence,
} from "@/lib/hooks";
import { useServerEvents } from "@/lib/ws";
import { useQueryClient } from "@tanstack/react-query";
import { ArtifactList, type ArtifactListFilters } from "@/components/artifacts/ArtifactList";
import { ArtifactTypePicker } from "@/components/artifacts/ArtifactTypePicker";
import { ArtifactEditor } from "@/components/artifacts/ArtifactEditor";
import { ProjectPresenceBadge } from "@/components/artifacts/PresenceIndicator";
import {
  artifactTypeLabel,
  defaultArtifactContent,
} from "@/components/artifacts/artifact-defaults";
import type { Artifact, ArtifactType } from "@/lib/api";

interface ProjectArtifactsProps {
  companyId: string;
  projectId: string;
}

const PAGE_SIZE = 20;

export function ProjectArtifacts({ companyId, projectId }: ProjectArtifactsProps) {
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const qc = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);

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
  }, [companyId, projectId]);

  const queryParams = {
    projectId,
    ...(filters.type ? { type: filters.type as ArtifactType } : {}),
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
  const createMutation = useCreateArtifact(companyId);

  // Project-aggregated presence (VAL-CROSS-014): users viewing any artifact
  // in this project, live-updated via WS presence.* events.
  const { data: projectPresence } = useProjectPresence(companyId, projectId);

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
  }, [filters.type, filters.status, filters.projectId, filters.sort, filters.order, projectId]);

  const handleCreate = useCallback(
    async (type: ArtifactType) => {
      setPickerOpen(false);
      try {
        const label = artifactTypeLabel(type);
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
    [createMutation, projectId, companyId, qc],
  );

  if (selectedId) {
    return (
      <ArtifactEditor
        key={`${companyId}-${projectId}-${selectedId}`}
        companyId={companyId}
        artifactId={selectedId}
        projectId={projectId}
        onBack={handleBack}
      />
    );
  }

  return (
    <div className="p-5 sm:p-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <div className="flex items-center justify-between">
          <h2 ref={headingRef} tabIndex={-1} className="text-sm font-semibold text-text-primary font-display focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface rounded">
            Artifacts
          </h2>
          {projectPresence && projectPresence.length > 0 && (
            <ProjectPresenceBadge presence={projectPresence} />
          )}
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
