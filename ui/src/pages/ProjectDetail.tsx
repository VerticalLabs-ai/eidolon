import { useState } from "react";
import { useParams, Link, useNavigate, useSearchParams } from "react-router-dom";
import { Archive, ArrowLeft, ExternalLink, FolderKanban, Pencil, FileEdit } from "lucide-react";
import { toast } from "sonner";
import { useArchiveProject, useProject, useProjectWork } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { Modal } from "@/components/ui/Modal";
import { ProjectFormModal } from "@/components/projects/ProjectFormModal";
import { ProjectActivity } from "@/components/projects/ProjectActivity";
import { isHttpUrl } from "@/lib/urls";
import { TaskBoard } from "@/pages/TaskBoard";
import { ProjectHome } from "@/pages/ProjectHome";
import { ProjectDrive } from "@/pages/ProjectDrive";
import { ProjectArtifacts } from "@/pages/ProjectArtifacts";
import { ProjectThreadComposer } from "@/components/projects/ProjectThreadComposer";
import { ProjectPlansPanel } from "@/components/projects/ProjectPlansPanel";
import { ProjectDecisionsPanel } from "@/components/projects/ProjectDecisionsPanel";
import { ProjectOutcomesPanel } from "@/components/projects/ProjectOutcomesPanel";
import { AutomationRunsPanel } from "@/components/projects/AutomationRunsPanel";
import type { Tab } from "@/components/ui/Tabs";
import { formatDistanceToNow } from "date-fns";

const VALID_TABS = ["home", "work", "drive", "artifacts", "activity"] as const;
type ValidTab = (typeof VALID_TABS)[number];

const tabs: Tab[] = [
  { id: "home", label: "Home" },
  { id: "work", label: "Work" },
  { id: "drive", label: "Drive" },
  { id: "artifacts", label: "Artifacts" },
  { id: "activity", label: "Activity" },
];

const statusVariant: Record<string, "default" | "success" | "warning" | "info" | "error"> = {
  active: "success",
  planning: "info",
  paused: "warning",
  completed: "success",
  archived: "default",
};

// ── Work view: Artifacts panel (VAL-ART-057) ─────────────────────────────

function WorkArtifactsPanel({
  companyId,
  projectId,
  onNavigateToArtifacts,
}: {
  companyId: string;
  projectId: string;
  onNavigateToArtifacts: () => void;
}) {
  const { data: workSummary } = useProjectWork(companyId, projectId);
  const artifacts = workSummary?.artifacts ?? [];

  return (
    <div className="mx-auto max-w-6xl rounded-xl border border-white/[0.06] bg-surface p-4" aria-label="Artifacts">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent">
          <FileEdit className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-semibold text-text-primary font-display">Artifacts</h2>
      </div>
      {artifacts.length === 0 ? (
        <p className="py-4 text-center text-sm text-text-muted" role="status">
          No artifacts yet
        </p>
      ) : (
        <ul>
          {artifacts.slice(0, 5).map((artifact) => (
            <li
              key={artifact.id}
              className="flex items-center gap-2 border-b border-white/[0.04] py-2 last:border-b-0"
            >
              <FileEdit className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{artifact.title}</p>
                <p className="text-xs text-text-muted capitalize">
                  {artifact.type} · v{artifact.version} ·{" "}
                  {formatDistanceToNow(new Date(artifact.updatedAt), { addSuffix: true })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={onNavigateToArtifacts}
        className="mt-3 w-full rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent/[0.06] cursor-pointer"
      >
        View all artifacts →
      </button>
    </div>
  );
}

export function ProjectDetail() {
  const { companyId, projectId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { data: project, isLoading, isError, refetch } = useProject(companyId, projectId);
  const archiveMutation = useArchiveProject(companyId ?? "");
  const [editOpen, setEditOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const rawTab = searchParams.get("tab");
  const activeTab: ValidTab = VALID_TABS.includes(rawTab as ValidTab)
    ? (rawTab as ValidTab)
    : "home";

  const handleTabChange = (id: string) => {
    // Update only the `tab` query param, preserving any other query params.
    const next = new URLSearchParams(searchParams);
    if (id === "home") {
      next.delete("tab");
    } else {
      next.set("tab", id);
    }
    setSearchParams(next, { replace: true });
  };

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<FolderKanban className="h-6 w-6" />}
          title="Project could not be loaded"
          description="Check your connection and try again."
          action={<Button variant="secondary" onClick={() => void refetch()}>Try again</Button>}
        />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<FolderKanban className="h-6 w-6" />}
          title="Project not found"
          description="This project may have been deleted or does not exist."
          action={
            <Link to={`/company/${companyId}/projects`}>
              <Button variant="secondary" icon={<ArrowLeft className="h-3.5 w-3.5" />}>
                Back to Projects
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  const repoUrl = project.repoUrl && isHttpUrl(project.repoUrl) ? project.repoUrl : null;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 bg-surface border-b border-white/[0.06] px-5 pt-4 pb-0">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Link
            to={`/company/${companyId}/projects`}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:text-accent hover:bg-accent/10 transition-all duration-200"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neon-cyan/15">
            <FolderKanban className="h-4 w-4 text-neon-cyan" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-text-primary font-display tracking-wide truncate">
                {project.name}
              </h1>
              <Badge variant={statusVariant[project.status] ?? "default"}>
                {project.status}
              </Badge>
            </div>
            {project.description && (
              <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">
                {project.description}
              </p>
            )}
            {repoUrl && (
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-accent hover:underline"
              >
                <span className="truncate">{repoUrl}</span>
                <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
              </a>
            )}
          </div>
          {project.status !== "archived" && (
            <div className="flex w-full gap-2 sm:w-auto">
              <Button
                variant="secondary"
                className="flex-1 sm:flex-none"
                icon={<Pencil className="h-3.5 w-3.5" />}
                onClick={() => setEditOpen(true)}
              >
                Edit Project
              </Button>
              <Button
                variant="danger"
                className="flex-1 sm:flex-none"
                icon={<Archive className="h-3.5 w-3.5" />}
                onClick={() => {
                  setArchiveError(null);
                  setArchiveOpen(true);
                }}
              >
                Archive Project
              </Button>
            </div>
          )}
        </div>
        <Tabs tabs={tabs} activeTab={activeTab} onTabChange={handleTabChange} className="!px-0" />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "home" && (
          <ProjectHome companyId={companyId ?? ""} projectId={project.id} />
        )}
        {activeTab === "work" && (
          <div className="space-y-4 p-5 sm:p-6">
            <TaskBoard title="Work" />
            <WorkArtifactsPanel
              companyId={companyId ?? ""}
              projectId={project.id}
              onNavigateToArtifacts={() => handleTabChange("artifacts")}
            />
            <div className="mx-auto max-w-6xl">
              <ProjectPlansPanel companyId={companyId ?? ""} projectId={project.id} />
            </div>
            <div className="mx-auto max-w-6xl">
              <ProjectDecisionsPanel companyId={companyId ?? ""} projectId={project.id} />
            </div>
            <div className="mx-auto max-w-6xl">
              <ProjectOutcomesPanel companyId={companyId ?? ""} projectId={project.id} />
            </div>
            <div className="mx-auto max-w-6xl">
              <AutomationRunsPanel companyId={companyId ?? ""} projectId={project.id} />
            </div>
            <div className="mx-auto max-w-6xl rounded-xl border border-white/[0.06] bg-surface p-4">
              <ProjectThreadComposer companyId={companyId ?? ""} projectId={project.id} />
            </div>
          </div>
        )}
        {activeTab === "drive" && (
          <ProjectDrive companyId={companyId ?? ""} projectId={project.id} />
        )}
        {activeTab === "artifacts" && (
          <ProjectArtifacts companyId={companyId ?? ""} projectId={project.id} />
        )}
        {activeTab === "activity" && (
          <ProjectActivity key={project.id} companyId={companyId ?? ""} projectId={project.id} />
        )}
      </div>

      <ProjectFormModal
        open={editOpen}
        companyId={companyId ?? ""}
        project={project}
        onClose={() => setEditOpen(false)}
        onSaved={(savedProject) => toast.success(`Project updated: ${savedProject.name}`)}
      />

      <Modal
        open={archiveOpen}
        onClose={() => {
          setArchiveError(null);
          archiveMutation.reset();
          setArchiveOpen(false);
        }}
        title="Archive Project"
        dismissible={!archiveMutation.isPending}
      >
        <div className="space-y-4">
          <p className="text-sm leading-relaxed text-text-secondary">
            Archive <strong className="text-text-primary">{project.name}</strong>? Its data and history will be retained, and the project will remain identifiable as archived.
          </p>
          {archiveError && (
            <div
              role="alert"
              aria-live="polite"
              className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-sm text-error"
            >
              Project was not archived: {archiveError} Try again when the connection is available.
            </div>
          )}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              disabled={archiveMutation.isPending}
              onClick={() => setArchiveOpen(false)}
            >
              Keep Project
            </Button>
            <Button
              type="button"
              variant="danger"
              loading={archiveMutation.isPending}
              onClick={() => {
                setArchiveError(null);
                archiveMutation.mutate(
                  { projectId: project.id },
                  {
                    onSuccess: () => {
                      toast.success(`Project archived: ${project.name}`);
                      navigate(`/company/${companyId}/projects`, { replace: true });
                    },
                    onError: (error) => {
                      setArchiveError(error instanceof Error ? error.message : "Archive failed.");
                    },
                  },
                );
              }}
            >
              Confirm Archive
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
