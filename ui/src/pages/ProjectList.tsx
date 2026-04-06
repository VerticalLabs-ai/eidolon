import { useParams, Link } from "react-router-dom";
import { FolderKanban, Plus } from "lucide-react";
import { useProjects } from "@/lib/hooks";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

const statusVariant: Record<string, "default" | "success" | "warning" | "info" | "error"> = {
  active: "success",
  planning: "info",
  paused: "warning",
  completed: "success",
  archived: "default",
};

export function ProjectList() {
  const { companyId } = useParams();
  const { data: projects, isLoading } = useProjects(companyId);

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary font-display tracking-wide flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neon-cyan/15">
              <FolderKanban className="h-4.5 w-4.5 text-neon-cyan" />
            </div>
            Projects
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            {projects?.length ?? 0} project{(projects?.length ?? 0) !== 1 ? "s" : ""}
          </p>
        </div>
        <Button icon={<Plus className="h-3.5 w-3.5" />}>New Project</Button>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-xl glass" />
          ))}
        </div>
      ) : !projects?.length ? (
        <EmptyState
          icon={<FolderKanban className="h-6 w-6" />}
          title="No projects yet"
          description="Create your first project to organize tasks and goals."
          action={
            <Button icon={<Plus className="h-3.5 w-3.5" />}>New Project</Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {projects.map((project) => (
            <Link
              key={project.id}
              to={`/company/${companyId}/projects/${project.id}`}
              className="block"
            >
              <Card hoverable className="h-full">
                <div className="flex items-start justify-between mb-3">
                  <h3 className="text-sm font-semibold text-text-primary font-display truncate">
                    {project.name}
                  </h3>
                  <Badge variant={statusVariant[project.status] ?? "default"}>
                    {project.status}
                  </Badge>
                </div>
                {project.description && (
                  <p className="text-xs text-text-secondary line-clamp-2 leading-relaxed">
                    {project.description}
                  </p>
                )}
                <div className="mt-4 pt-3 border-t border-white/[0.06] flex items-center text-[10px] text-text-secondary font-display">
                  <span>
                    Created{" "}
                    {new Date(project.createdAt).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}
                  </span>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
