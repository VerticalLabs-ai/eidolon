import { useMemo } from "react";
import { FileText, Grid3x3, LayoutGrid, Presentation, GanttChartSquare, Images, BarChart3, AppWindow, Code2, ChevronLeft, ChevronRight, Plus, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { Select } from "@/components/ui/Input";
import { MoveArtifactMenu } from "./FolderTree";
import type { Artifact, ArtifactType, ArtifactStatus, ArtifactFolder } from "@/lib/api";

const TYPE_ICONS: Record<ArtifactType, React.ReactNode> = {
  document: <FileText className="h-4 w-4" />,
  sheet: <Grid3x3 className="h-4 w-4" />,
  board: <LayoutGrid className="h-4 w-4" />,
  slide_deck: <Presentation className="h-4 w-4" />,
  timeline: <GanttChartSquare className="h-4 w-4" />,
  gallery: <Images className="h-4 w-4" />,
  dashboard: <BarChart3 className="h-4 w-4" />,
  app: <AppWindow className="h-4 w-4" />,
  code: <Code2 className="h-4 w-4" />,
};

const TYPE_LABELS: Record<ArtifactType, string> = {
  document: "Document",
  sheet: "Sheet",
  board: "Board",
  slide_deck: "Slides",
  timeline: "Timeline",
  gallery: "Gallery",
  dashboard: "Dashboard",
  app: "App",
  code: "Code",
};

export interface ArtifactListFilters {
  type: ArtifactType | "";
  status: ArtifactStatus;
  projectId: string | "";
  sort: "updatedAt" | "title" | "type" | "createdAt";
  order: "asc" | "desc";
}

interface ArtifactListProps {
  artifacts: Artifact[];
  total: number;
  limit: number;
  offset: number;
  filters: ArtifactListFilters;
  onFiltersChange: (filters: ArtifactListFilters) => void;
  onPageChange: (offset: number) => void;
  onSelect: (artifact: Artifact) => void;
  onCreate: () => void;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
  /** Optional project filter options for company-level view */
  projectOptions?: { value: string; label: string }[];
  /** Folders for the move-to-folder menu (M4). Omitted in contexts without folders. */
  folders?: ArtifactFolder[];
  /** Company id for the move-to-folder mutation. Required when folders is provided. */
  companyId?: string;
}

export function ArtifactList({
  artifacts,
  total,
  limit,
  offset,
  filters,
  onFiltersChange,
  onPageChange,
  onSelect,
  onCreate,
  isLoading,
  isError,
  onRetry,
  projectOptions,
  folders,
  companyId,
}: ArtifactListProps) {
  const hasArtifacts = artifacts.length > 0;
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit) || 1;
  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  const typeOptions = useMemo(
    () => [
      { value: "", label: "All types" },
      { value: "document", label: "Document" },
      { value: "sheet", label: "Sheet" },
      { value: "board", label: "Board" },
      { value: "slide_deck", label: "Slides" },
      { value: "timeline", label: "Timeline" },
      { value: "gallery", label: "Gallery" },
    ],
    [],
  );

  const statusOptions = useMemo(
    () => [
      { value: "active", label: "Active" },
      { value: "archived", label: "Archived" },
      { value: "deleted", label: "Deleted" },
    ],
    [],
  );

  const sortOptions = useMemo(
    () => [
      { value: "updatedAt", label: "Last updated" },
      { value: "createdAt", label: "Created" },
      { value: "title", label: "Title" },
      { value: "type", label: "Type" },
    ],
    [],
  );

  if (isError) {
    return (
      <EmptyState
        icon={<AlertCircle className="h-6 w-6" />}
        title="Could not load artifacts"
        description="Check your connection and try again."
        action={
          onRetry && (
            <Button variant="secondary" onClick={onRetry}>
              Try again
            </Button>
          )
        }
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-end gap-3">
        <Select
          label="Type"
          options={typeOptions}
          value={filters.type}
          onChange={(e) =>
            onFiltersChange({
              ...filters,
              type: e.target.value as ArtifactType | "",
            })
          }
          className="w-auto min-w-[120px]"
        />
        <Select
          label="Status"
          options={statusOptions}
          value={filters.status}
          onChange={(e) =>
            onFiltersChange({
              ...filters,
              status: e.target.value as ArtifactStatus,
            })
          }
          className="w-auto min-w-[120px]"
        />
        {projectOptions && projectOptions.length > 0 && (
          <Select
            label="Project"
            options={[
              { value: "", label: "No project" },
              ...projectOptions,
            ]}
            value={filters.projectId}
            onChange={(e) =>
              onFiltersChange({ ...filters, projectId: e.target.value })
            }
            className="w-auto min-w-[160px]"
          />
        )}
        <Select
          label="Sort by"
          options={sortOptions}
          value={filters.sort}
          onChange={(e) =>
            onFiltersChange({
              ...filters,
              sort: e.target.value as ArtifactListFilters["sort"],
            })
          }
          className="w-auto min-w-[130px]"
        />
        <Select
          label="Order"
          options={[
            { value: "desc", label: "Descending" },
            { value: "asc", label: "Ascending" },
          ]}
          value={filters.order}
          onChange={(e) =>
            onFiltersChange({
              ...filters,
              order: e.target.value as ArtifactListFilters["order"],
            })
          }
          className="w-auto min-w-[120px]"
        />
        <div className="ml-auto pb-1.5">
          <Button
            variant="primary"
            size="md"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={onCreate}
          >
            Create
          </Button>
        </div>
      </div>

      {/* List */}
      {!hasArtifacts ? (
        <EmptyState
          icon={<FileText className="h-6 w-6" />}
          title="No artifacts yet"
          description="Create a document, sheet, or board to get started."
          action={
            <Button
              variant="primary"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={onCreate}
            >
              Create Artifact
            </Button>
          }
        />
      ) : (
        <>
          <ul
            className="divide-y divide-white/[0.04] rounded-xl border border-white/[0.06] bg-surface/60"
            role="list"
          >
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <button
                  onClick={() => onSelect(artifact)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-white/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset cursor-pointer"
                  aria-label={`Open ${TYPE_LABELS[artifact.type]}: ${artifact.title}`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    {TYPE_ICONS[artifact.type]}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text-primary">
                      {artifact.title}
                    </p>
                    <p className="text-xs text-text-secondary mt-0.5">
                      {TYPE_LABELS[artifact.type]} · v{artifact.version} ·{" "}
                      {formatDistanceToNow(new Date(artifact.updatedAt), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                  {artifact.createdByAgentId && (
                    <Badge variant="info">Agent</Badge>
                  )}
                  {artifact.status === "archived" && (
                    <Badge variant="default">Archived</Badge>
                  )}
                  {folders && companyId && (
                    <div onClick={(e) => e.stopPropagation()}>
                      <MoveArtifactMenu
                        companyId={companyId}
                        artifactId={artifact.id}
                        currentFolderId={artifact.folderId}
                        folders={folders}
                      />
                    </div>
                  )}
                </button>
              </li>
            ))}
          </ul>

          {/* Pagination */}
          {total > limit && (
            <div className="flex items-center justify-between">
              <p className="text-xs text-text-secondary">
                {offset + 1}–{Math.min(offset + limit, total)} of {total}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!canPrev}
                  onClick={() => onPageChange(Math.max(0, offset - limit))}
                  icon={<ChevronLeft className="h-3.5 w-3.5" />}
                >
                  Prev
                </Button>
                <span className="text-xs text-text-secondary tabular-nums">
                  {currentPage} / {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={!canNext}
                  onClick={() => onPageChange(offset + limit)}
                >
                  Next
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
