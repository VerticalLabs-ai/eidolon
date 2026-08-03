import { useState, useMemo } from "react";
import { FileText, FolderOpen, HardDrive, Clock, Bot } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useFiles } from "@/lib/hooks";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import {
  TreeNode,
  sortRootFiles,
  formatBytes,
  formatFileDate,
} from "@/components/files/FileTree";
import type { AgentFile } from "@/lib/api";

export function ProjectDrive({ companyId, projectId }: { companyId: string; projectId: string }) {
  const { data: files, isLoading, isError, refetch } = useFiles(companyId, undefined, { projectId });
  const [selectedFileId, setSelectedFileId] = useState<string | undefined>(undefined);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());

  const fileList = files ?? [];

  const rootFiles = useMemo(() => sortRootFiles(fileList), [fileList]);

  const selectedFile: AgentFile | undefined = useMemo(
    () => fileList.find((f) => f.id === selectedFileId),
    [fileList, selectedFileId],
  );

  const toggleDir = (id: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

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
    <div className="flex h-full flex-col sm:flex-row" data-testid="project-drive">
      {/* Sidebar: file tree */}
      <div className="w-full shrink-0 border-b border-white/[0.06] sm:w-72 sm:border-b-0 sm:border-r flex flex-col bg-surface/50 max-h-[40vh] sm:max-h-none">
        <div className="border-b border-white/[0.06] p-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary font-display">
            Project Files
          </h2>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {rootFiles.map((file) => (
            <TreeNode
              key={file.id}
              file={file}
              files={fileList}
              depth={0}
              selectedId={selectedFileId}
              onSelect={setSelectedFileId}
              expandedDirs={expandedDirs}
              toggleDir={toggleDir}
            />
          ))}
        </div>

        <div className="border-t border-white/[0.06] p-3">
          <div className="flex items-center gap-2 text-[10px] text-text-secondary">
            <HardDrive className="h-3 w-3" />
            <span>
              {fileList.filter((f) => !f.isDirectory).length} files,{" "}
              {formatBytes(fileList.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0))}
            </span>
          </div>
        </div>
      </div>

      {/* Detail panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile && !selectedFile.isDirectory ? (
          <div className="flex-1 overflow-auto p-5 sm:p-6" data-testid="file-detail">
            <div className="mx-auto max-w-2xl">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10">
                  <FileText className="h-5 w-5 text-accent" />
                </div>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-text-primary font-display">
                    {selectedFile.name}
                  </h3>
                  <p className="truncate text-xs text-text-muted">{selectedFile.path}</p>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">
                  <dt className="text-xs text-text-muted">Type</dt>
                  <dd className="mt-0.5 text-sm font-medium text-text-primary">
                    <Badge variant="default">{selectedFile.mimeType}</Badge>
                  </dd>
                </div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">
                  <dt className="text-xs text-text-muted">Size</dt>
                  <dd className="mt-0.5 text-sm font-medium tabular-nums text-text-primary">
                    {formatBytes(selectedFile.sizeBytes ?? 0)}
                  </dd>
                </div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">
                  <dt className="text-xs text-text-muted">Created</dt>
                  <dd className="mt-0.5 flex items-center gap-1 text-sm text-text-primary">
                    <Clock className="h-3 w-3 text-text-muted" />
                    {formatFileDate(selectedFile.createdAt)}
                  </dd>
                </div>
                {selectedFile.agentId && (
                  <div className="rounded-lg bg-white/[0.03] px-3 py-2">
                    <dt className="text-xs text-text-muted">Agent</dt>
                    <dd className="mt-0.5 flex items-center gap-1 text-sm text-text-primary">
                      <Bot className="h-3 w-3 text-text-muted" />
                      <span className="truncate">{selectedFile.agentId}</span>
                    </dd>
                  </div>
                )}
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">
                  <dt className="text-xs text-text-muted">Updated</dt>
                  <dd className="mt-0.5 text-sm tabular-nums text-text-secondary">
                    {formatDistanceToNow(new Date(selectedFile.updatedAt), { addSuffix: true })}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        ) : selectedFile && selectedFile.isDirectory ? (
          <div className="flex-1 overflow-auto p-5 sm:p-6" data-testid="folder-detail">
            <div className="mx-auto max-w-2xl">
              <div className="mb-4 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
                  <FolderOpen className="h-5 w-5 text-amber-400" />
                </div>
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold text-text-primary font-display">
                    {selectedFile.name}
                  </h3>
                  <p className="truncate text-xs text-text-muted">{selectedFile.path}</p>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-3">
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">
                  <dt className="text-xs text-text-muted">Contents</dt>
                  <dd className="mt-0.5 text-sm font-medium text-text-primary">
                    {fileList.filter((f) => f.parentId === selectedFile.id).length} items
                  </dd>
                </div>
                <div className="rounded-lg bg-white/[0.03] px-3 py-2">
                  <dt className="text-xs text-text-muted">Created</dt>
                  <dd className="mt-0.5 flex items-center gap-1 text-sm text-text-primary">
                    <Clock className="h-3 w-3 text-text-muted" />
                    {formatFileDate(selectedFile.createdAt)}
                  </dd>
                </div>
              </dl>
            </div>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <FolderOpen className="h-12 w-12 mx-auto mb-3 text-text-secondary/20" />
              <p className="text-sm text-text-secondary font-display">Select a file to view</p>
              <p className="text-xs text-text-secondary/60 mt-1">
                Project files are scoped to this project
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
