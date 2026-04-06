import { useState, useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  FolderOpen,
  File,
  FilePlus,
  FolderPlus,
  Trash2,
  Save,
  ChevronRight,
  ChevronDown,
  Bot,
  Clock,
  HardDrive,
  FileCode,
  FileText,
  FileJson,
  X,
} from "lucide-react";
import { clsx } from "clsx";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import {
  useFiles,
  useFile,
  useCreateFile,
  useUpdateFile,
  useDeleteFile,
  useAgents,
} from "@/lib/hooks";
import type { AgentFile } from "@/lib/api";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getFileIcon(name: string, isDirectory: boolean) {
  if (isDirectory) return FolderOpen;
  const ext = name.split(".").pop()?.toLowerCase();
  if (["ts", "tsx", "js", "jsx", "py", "rs", "go", "sh"].includes(ext ?? ""))
    return FileCode;
  if (["json", "yaml", "yml", "toml"].includes(ext ?? "")) return FileJson;
  if (["md", "txt", "csv"].includes(ext ?? "")) return FileText;
  return File;
}

function getLanguage(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    md: "markdown",
    html: "html",
    css: "css",
    py: "python",
    rs: "rust",
    go: "go",
    yaml: "yaml",
    yml: "yaml",
    sql: "sql",
    sh: "shell",
  };
  return langMap[ext ?? ""] ?? "text";
}

// Simple keyword highlighter for code
const KEYWORDS: Record<string, string[]> = {
  typescript: [
    "import",
    "export",
    "from",
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "class",
    "interface",
    "type",
    "async",
    "await",
    "new",
    "this",
    "extends",
    "implements",
    "default",
    "switch",
    "case",
    "break",
    "try",
    "catch",
    "throw",
    "typeof",
    "void",
    "null",
    "undefined",
    "true",
    "false",
  ],
  javascript: [
    "import",
    "export",
    "from",
    "const",
    "let",
    "var",
    "function",
    "return",
    "if",
    "else",
    "for",
    "while",
    "class",
    "async",
    "await",
    "new",
    "this",
    "extends",
    "default",
    "switch",
    "case",
    "break",
    "try",
    "catch",
    "throw",
    "typeof",
    "void",
    "null",
    "undefined",
    "true",
    "false",
  ],
  python: [
    "import",
    "from",
    "def",
    "class",
    "return",
    "if",
    "elif",
    "else",
    "for",
    "while",
    "try",
    "except",
    "with",
    "as",
    "in",
    "not",
    "and",
    "or",
    "is",
    "None",
    "True",
    "False",
    "self",
    "lambda",
    "yield",
    "async",
    "await",
  ],
  json: [],
  sql: [
    "SELECT",
    "FROM",
    "WHERE",
    "INSERT",
    "INTO",
    "UPDATE",
    "DELETE",
    "CREATE",
    "TABLE",
    "ALTER",
    "DROP",
    "INDEX",
    "JOIN",
    "ON",
    "AND",
    "OR",
    "NOT",
    "NULL",
    "DEFAULT",
    "PRIMARY",
    "KEY",
    "REFERENCES",
    "IF",
    "EXISTS",
    "INTEGER",
    "TEXT",
    "REAL",
  ],
};

// ---------------------------------------------------------------------------
// Tree Node
// ---------------------------------------------------------------------------

interface TreeNodeProps {
  file: AgentFile;
  files: AgentFile[];
  depth: number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  expandedDirs: Set<string>;
  toggleDir: (id: string) => void;
}

function TreeNode({
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
// Markdown preview (basic)
// ---------------------------------------------------------------------------

function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => {
    let result = content
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    // Headers
    result = result.replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold text-text-primary mt-4 mb-2 font-display">$1</h3>');
    result = result.replace(/^## (.+)$/gm, '<h2 class="text-lg font-semibold text-text-primary mt-5 mb-2 font-display">$1</h2>');
    result = result.replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold text-text-primary mt-6 mb-3 font-display">$1</h1>');

    // Bold and italic
    result = result.replace(/\*\*(.+?)\*\*/g, '<strong class="font-semibold text-text-primary">$1</strong>');
    result = result.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    result = result.replace(/`([^`]+)`/g, '<code class="px-1.5 py-0.5 rounded bg-white/[0.06] text-amber-400 text-xs font-mono">$1</code>');

    // Code blocks
    result = result.replace(
      /```[\s\S]*?```/g,
      (match) => {
        const code = match.slice(3, -3).replace(/^\w+\n/, "");
        return `<pre class="rounded-lg bg-white/[0.04] border border-white/[0.06] p-4 my-3 overflow-x-auto"><code class="text-xs font-mono text-text-secondary">${code}</code></pre>`;
      },
    );

    // Lists
    result = result.replace(/^- (.+)$/gm, '<li class="text-text-secondary text-sm ml-4 list-disc">$1</li>');

    // Paragraphs
    result = result.replace(/\n\n/g, '</p><p class="text-text-secondary text-sm mb-3">');

    return `<p class="text-text-secondary text-sm mb-3">${result}</p>`;
  }, [content]);

  return (
    <div
      className="prose prose-invert max-w-none p-6"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ---------------------------------------------------------------------------
// Code viewer
// ---------------------------------------------------------------------------

function CodeViewer({ content, language }: { content: string; language: string }) {
  const keywords = KEYWORDS[language] ?? [];
  const lines = content.split("\n");

  return (
    <div className="overflow-auto">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => {
            let highlighted = line
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;");

            // String highlights
            highlighted = highlighted.replace(
              /(["'`])(?:(?!\1|\\).|\\.)*?\1/g,
              '<span class="text-emerald-400">$&</span>',
            );

            // Comment highlights
            highlighted = highlighted.replace(
              /(\/\/.*)$/,
              '<span class="text-text-secondary/50 italic">$1</span>',
            );

            // Keyword highlights
            if (keywords.length > 0) {
              const pattern = new RegExp(
                `\\b(${keywords.join("|")})\\b`,
                "g",
              );
              highlighted = highlighted.replace(
                pattern,
                '<span class="text-violet-400">$&</span>',
              );
            }

            // Number highlights
            highlighted = highlighted.replace(
              /\b(\d+)\b/g,
              '<span class="text-amber-400">$&</span>',
            );

            return (
              <tr key={i} className="hover:bg-white/[0.02]">
                <td className="select-none border-r border-white/[0.06] px-3 py-0 text-right text-[11px] text-text-secondary/40 font-mono w-12">
                  {i + 1}
                </td>
                <td
                  className="px-4 py-0 text-xs font-mono text-text-secondary whitespace-pre"
                  dangerouslySetInnerHTML={{ __html: highlighted || " " }}
                />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create file/folder modal
// ---------------------------------------------------------------------------

function CreateModal({
  onClose,
  onCreate,
  isFolder,
}: {
  onClose: () => void;
  onCreate: (name: string, content?: string) => void;
  isFolder: boolean;
}) {
  const [name, setName] = useState("");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-xl border border-white/[0.08] p-6 w-full max-w-md mx-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text-primary font-display">
            New {isFolder ? "Folder" : "File"}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-white/[0.05] transition-colors cursor-pointer"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onCreate(name.trim());
          }}
        >
          <Input
            label={isFolder ? "Folder name" : "File name"}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={isFolder ? "src" : "index.ts"}
            autoFocus
          />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="ghost" size="sm" onClick={onClose} type="button">
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={!name.trim()}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FileManager() {
  const { companyId } = useParams();
  const [agentFilter, setAgentFilter] = useState<string>("");
  const [selectedFileId, setSelectedFileId] = useState<string>();
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [showCreateFile, setShowCreateFile] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);

  const { data: files = [] } = useFiles(companyId, agentFilter || undefined);
  const { data: selectedFile } = useFile(companyId, selectedFileId);
  const { data: agents = [] } = useAgents(companyId);
  const createFile = useCreateFile(companyId!);
  const updateFile = useUpdateFile(companyId!);
  const deleteFile = useDeleteFile(companyId!);

  // Root-level files (no parentId)
  const rootFiles = useMemo(
    () =>
      files
        .filter((f) => !f.parentId)
        .sort((a, b) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        }),
    [files],
  );

  const toggleDir = (id: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCreate = (name: string, isDirectory: boolean) => {
    const parentId =
      selectedFileId && files.find((f) => f.id === selectedFileId)?.isDirectory
        ? selectedFileId
        : undefined;

    createFile.mutate(
      {
        name,
        isDirectory,
        agentId: agentFilter || undefined,
        parentId,
        content: isDirectory ? undefined : "",
      },
      {
        onSuccess: () => {
          setShowCreateFile(false);
          setShowCreateFolder(false);
        },
      },
    );
  };

  const handleSave = () => {
    if (!selectedFileId) return;
    updateFile.mutate(
      { fileId: selectedFileId, data: { content: editContent } },
      { onSuccess: () => setIsEditing(false) },
    );
  };

  const handleDelete = () => {
    if (!selectedFileId) return;
    if (!window.confirm("Delete this file?")) return;
    deleteFile.mutate(selectedFileId, {
      onSuccess: () => setSelectedFileId(undefined),
    });
  };

  const startEditing = () => {
    if (selectedFile?.content !== undefined) {
      setEditContent(selectedFile.content ?? "");
      setIsEditing(true);
    }
  };

  const language = selectedFile ? getLanguage(selectedFile.name) : "text";
  const isMarkdown = language === "markdown";
  const agentForFile = selectedFile?.agentId
    ? agents.find((a) => a.id === selectedFile.agentId)
    : null;

  return (
    <div className="flex h-full">
      {/* Sidebar: File tree */}
      <div className="w-72 shrink-0 border-r border-white/[0.06] flex flex-col bg-surface/50">
        {/* Header */}
        <div className="border-b border-white/[0.06] p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-text-secondary font-display">
              Files
            </h2>
            <div className="flex gap-1">
              <button
                onClick={() => setShowCreateFile(true)}
                className="p-1 rounded-md text-text-secondary hover:text-amber-400 hover:bg-amber-500/10 transition-colors cursor-pointer"
                title="New file"
              >
                <FilePlus className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={() => setShowCreateFolder(true)}
                className="p-1 rounded-md text-text-secondary hover:text-amber-400 hover:bg-amber-500/10 transition-colors cursor-pointer"
                title="New folder"
              >
                <FolderPlus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <select
            value={agentFilter}
            onChange={(e) => {
              setAgentFilter(e.target.value);
              setSelectedFileId(undefined);
            }}
            className="w-full rounded-lg border border-white/[0.08] bg-surface/80 backdrop-blur-sm px-3 py-1.5 text-xs text-text-primary outline-none transition-all duration-300 focus:border-amber-500/40 appearance-none cursor-pointer"
          >
            <option value="">All agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {rootFiles.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-secondary">
              <FolderOpen className="h-8 w-8 mb-2 opacity-30" />
              <p className="text-xs">No files yet</p>
              <p className="text-[10px] opacity-60 mt-1">
                Create a file or folder to get started
              </p>
            </div>
          ) : (
            rootFiles.map((file) => (
              <TreeNode
                key={file.id}
                file={file}
                files={files}
                depth={0}
                selectedId={selectedFileId}
                onSelect={setSelectedFileId}
                expandedDirs={expandedDirs}
                toggleDir={toggleDir}
              />
            ))
          )}
        </div>

        {/* Stats */}
        <div className="border-t border-white/[0.06] p-3">
          <div className="flex items-center gap-2 text-[10px] text-text-secondary">
            <HardDrive className="h-3 w-3" />
            <span>
              {files.filter((f) => !f.isDirectory).length} files,{" "}
              {formatBytes(
                files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0),
              )}
            </span>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedFile && !selectedFile.isDirectory ? (
          <>
            {/* File header */}
            <div className="border-b border-white/[0.06] px-5 py-3 flex items-center justify-between bg-surface/50">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-text-primary truncate font-display">
                    {selectedFile.name}
                  </span>
                  <Badge variant="default">{selectedFile.mimeType}</Badge>
                </div>
                <span className="text-[10px] text-text-secondary">
                  {formatBytes(selectedFile.sizeBytes ?? 0)}
                </span>
                {agentForFile && (
                  <div className="flex items-center gap-1 text-[10px] text-text-secondary">
                    <Bot className="h-3 w-3" />
                    {agentForFile.name}
                  </div>
                )}
                <div className="flex items-center gap-1 text-[10px] text-text-secondary">
                  <Clock className="h-3 w-3" />
                  {formatDate(selectedFile.updatedAt)}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isEditing ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setIsEditing(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={handleSave}
                      icon={<Save className="h-3 w-3" />}
                      loading={updateFile.isPending}
                    >
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="secondary" size="sm" onClick={startEditing}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={handleDelete}
                      icon={<Trash2 className="h-3 w-3" />}
                      loading={deleteFile.isPending}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </div>
            </div>

            {/* File content */}
            <div className="flex-1 overflow-auto bg-surface/30">
              {isEditing ? (
                <textarea
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  className="w-full h-full p-4 bg-transparent text-xs font-mono text-text-secondary resize-none outline-none"
                  spellCheck={false}
                />
              ) : isMarkdown ? (
                <MarkdownPreview content={selectedFile.content ?? ""} />
              ) : (
                <CodeViewer
                  content={selectedFile.content ?? ""}
                  language={language}
                />
              )}
            </div>
          </>
        ) : selectedFile && selectedFile.isDirectory ? (
          <div className="flex-1 p-6">
            <Card>
              <div className="flex items-center gap-3 mb-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-500/10">
                  <FolderOpen className="h-5 w-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-text-primary font-display">
                    {selectedFile.name}
                  </h3>
                  <p className="text-xs text-text-secondary">
                    {selectedFile.path}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="glass rounded-lg p-3">
                  <p className="text-text-secondary mb-1">Contents</p>
                  <p className="text-text-primary font-medium">
                    {files.filter((f) => f.parentId === selectedFile.id).length}{" "}
                    items
                  </p>
                </div>
                <div className="glass rounded-lg p-3">
                  <p className="text-text-secondary mb-1">Created</p>
                  <p className="text-text-primary font-medium">
                    {formatDate(selectedFile.createdAt)}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  variant="danger"
                  size="sm"
                  onClick={handleDelete}
                  icon={<Trash2 className="h-3 w-3" />}
                  loading={deleteFile.isPending}
                >
                  Delete folder
                </Button>
              </div>
            </Card>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <FolderOpen className="h-12 w-12 mx-auto mb-3 text-text-secondary/20" />
              <p className="text-sm text-text-secondary font-display">
                Select a file to view
              </p>
              <p className="text-xs text-text-secondary/60 mt-1">
                Or create a new file using the buttons above
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {showCreateFile && (
        <CreateModal
          onClose={() => setShowCreateFile(false)}
          onCreate={(name) => handleCreate(name, false)}
          isFolder={false}
        />
      )}
      {showCreateFolder && (
        <CreateModal
          onClose={() => setShowCreateFolder(false)}
          onCreate={(name) => handleCreate(name, true)}
          isFolder={true}
        />
      )}
    </div>
  );
}
