import {
  FolderOpen,
  File,
  FileCode,
  FileText,
  FileJson,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { clsx } from "clsx";
import type { AgentFile } from "@/lib/api";

// ---------------------------------------------------------------------------
// Helpers (shared by FileManager and ProjectDrive)
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function formatFileDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getFileIcon(name: string, isDirectory: boolean) {
  if (isDirectory) return FolderOpen;
  const ext = name.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "sh"].includes(ext ?? ""))
    return FileCode;
  if (["json", "yaml", "yml", "toml"].includes(ext ?? "")) return FileJson;
  if (["md", "txt", "csv"].includes(ext ?? "")) return FileText;
  return File;
}

// ---------------------------------------------------------------------------
// Tree Node — reusable file/folder tree primitive
// ---------------------------------------------------------------------------

export interface TreeNodeProps {
  file: AgentFile;
  files: AgentFile[];
  depth: number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  expandedDirs: Set<string>;
  toggleDir: (id: string) => void;
}

export function TreeNode({
  file,
  files,
  depth,
  selectedId,
  onSelect,
  expandedDirs,
  toggleDir,
}: TreeNodeProps) {
  const isExpanded = expandedDirs.has(file.id);
  const children = files.filter((f) => f.parentId === file.id);
  const Icon = getFileIcon(file.name, file.isDirectory);

  return (
    <div>
      <button
        onClick={() => {
          if (file.isDirectory) toggleDir(file.id);
          onSelect(file.id);
        }}
        className={clsx(
          "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-all duration-200 cursor-pointer",
          selectedId === file.id
            ? "bg-amber-500/10 text-amber-400"
            : "text-text-secondary hover:text-text-primary hover:bg-white/[0.04]",
        )}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        aria-expanded={file.isDirectory ? isExpanded : undefined}
      >
        {file.isDirectory ? (
          isExpanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary" />
          )
        ) : (
          <span className="w-3" />
        )}
        <Icon
          className={clsx(
            "h-3.5 w-3.5 shrink-0",
            file.isDirectory ? "text-amber-400/70" : "text-text-secondary",
          )}
        />
        <span className="truncate">{file.name}</span>
      </button>

      {file.isDirectory && isExpanded && (
        <div>
          {children
            .sort((a, b) => {
              if (a.isDirectory && !b.isDirectory) return -1;
              if (!a.isDirectory && b.isDirectory) return 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <TreeNode
                key={child.id}
                file={child}
                files={files}
                depth={depth + 1}
                selectedId={selectedId}
                onSelect={onSelect}
                expandedDirs={expandedDirs}
                toggleDir={toggleDir}
              />
            ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root file sorting helper
// ---------------------------------------------------------------------------

export function sortRootFiles(files: AgentFile[]): AgentFile[] {
  return files
    .filter((f) => !f.parentId)
    .sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
}
