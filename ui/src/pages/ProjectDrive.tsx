import { FileText, FolderOpen, HardDrive } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useFiles } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

export function ProjectDrive({ companyId, projectId }: { companyId: string; projectId: string }) {
  const { data: files, isLoading, isError, refetch } = useFiles(companyId, undefined, { projectId });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center" role="status" aria-label="Loading project files">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<HardDrive className="h-6 w-6" />}
          title="Files could not be loaded"
          description="Check your connection and try again."
          action={<Button variant="secondary" onClick={() => void refetch()}>Try again</Button>}
        />
      </div>
    );
  }

  const fileList = files ?? [];

  if (fileList.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={<FolderOpen className="h-6 w-6" />}
          title="No files in this project"
          description="Files associated with this project will appear here."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl p-5 sm:p-6" data-testid="project-drive">
      <div className="overflow-hidden rounded-xl border border-white/[0.06] bg-surface">
        <ul>
          {fileList.map((file, index) => (
            <li
              key={file.id}
              className={`flex items-center gap-3 p-4 ${index > 0 ? "border-t border-white/[0.06]" : ""}`}
            >
              {file.isDirectory ? (
                <FolderOpen className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
              ) : (
                <FileText className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{file.name}</p>
                <p className="text-xs text-text-muted">
                  {file.isDirectory ? "Folder" : file.mimeType} {" "} {" "} {formatDistanceToNow(new Date(file.createdAt), { addSuffix: true })}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
