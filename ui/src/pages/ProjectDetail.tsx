import { useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft, FolderKanban, Activity } from "lucide-react";
import { useProjects } from "@/lib/hooks";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/ui/Tabs";
import { EmptyState } from "@/components/ui/EmptyState";
import { TaskBoard } from "@/pages/TaskBoard";
import { GoalTree } from "@/pages/GoalTree";
import type { Tab } from "@/components/ui/Tabs";

const tabs: Tab[] = [
  { id: "issues", label: "Issues" },
  { id: "goals", label: "Goals" },
  { id: "activity", label: "Activity" },
];

const statusVariant: Record<string, "default" | "success" | "warning" | "info" | "error"> = {
  active: "success",
  planning: "info",
  paused: "warning",
  completed: "success",
  archived: "default",
};

export function ProjectDetail() {
  const { companyId, projectId } = useParams();
  const { data: projects, isLoading } = useProjects(companyId);
  const [activeTab, setActiveTab] = useState("issues");

  const project = projects?.find((p) => p.id === projectId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
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

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 bg-surface border-b border-white/[0.06] px-5 pt-4 pb-0">
        <div className="flex items-center gap-3 mb-3">
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
              <p className="text-xs text-text-secondary mt-0.5 truncate">
                {project.description}
              </p>
            )}
          </div>
        </div>
        <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} className="!px-0" />
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {activeTab === "issues" && <TaskBoard />}
        {activeTab === "goals" && <GoalTree />}
        {activeTab === "activity" && (
          <div className="flex h-full items-center justify-center p-6">
            <EmptyState
              icon={<Activity className="h-6 w-6" />}
              title="No activity yet"
              description="Project activity, updates, and events will appear here."
            />
          </div>
        )}
      </div>
    </div>
  );
}
