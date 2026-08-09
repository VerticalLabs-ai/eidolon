import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Save,
  Plus,
  AlertTriangle,
  CloudOff,
  Trash2,
  FileCode,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { Artifact } from "@/lib/api";
import { useArtifactDraftSync } from "./useArtifactDraftSync";
import {
  type AppFile,
  type AppDefinition,
  parseApp,
  serializeApp,
  createFile,
  insertFile,
  deleteFile,
  updateFile,
  findFile,
  buildPreviewDoc,
} from "./app-content";

interface AppEditorProps {
  artifact: Artifact;
  version: number;
  onSave: (data: {
    title: string;
    content: Record<string, unknown>;
  }) => Promise<void>;
  saving?: boolean;
  conflictState?: ConflictState | null;
  wsConnected?: boolean;
  onStateChange?: (state: {
    dirty: boolean;
    save: () => Promise<boolean>;
    discard: () => void;
  }) => void;
}

export interface ConflictState {
  currentVersion: number;
  currentTitle: string;
  currentContent: Record<string, unknown>;
}

export function AppEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
  onStateChange,
}: AppEditorProps) {
  const parsed = parseApp(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [definition, setDefinition] = useState<AppDefinition>(parsed.definition);
  const [files, setFiles] = useState<AppFile[]>(parsed.files);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    parsed.files[0]?.path ?? null,
  );
  const [showPreview, setShowPreview] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AppFile | null>(null);

  const localSnapshot = serializeApp({ definition, files });

  const adoptRemote = useCallback(
    (content: Record<string, unknown>, remoteTitle: string) => {
      const next = parseApp(content);
      setTitle(remoteTitle);
      setDefinition(next.definition);
      setFiles(next.files);
      setSelectedPath((prev) => {
        if (prev && findFile(next.files, prev)) return prev;
        return next.files[0]?.path ?? null;
      });
      setSaveError(null);
    },
    [],
  );

  const {
    isDirty,
    remoteUpdate,
    clearRemoteUpdate,
    resetBaselineToArtifact,
    markSaved,
  } = useArtifactDraftSync({
    artifact,
    localTitle: title,
    serializedLocalContent: localSnapshot,
    serializeArtifactContent: (c) => serializeApp(parseApp(c)),
    onAdoptRemote: adoptRemote,
  });

  const discardDraft = useCallback(() => {
    resetBaselineToArtifact();
    adoptRemote(artifact.content, artifact.title);
  }, [artifact.content, artifact.title, adoptRemote, resetBaselineToArtifact]);

  const buildContent = useCallback(
    (): Record<string, unknown> =>
      ({ definition, files }) as unknown as Record<string, unknown>,
    [definition, files],
  );

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty || saving) return false;
    setSaveError(null);
    const content = buildContent();
    try {
      await onSave({ title, content });
      markSaved(title, content);
      clearRemoteUpdate();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      return false;
    }
  }, [isDirty, saving, title, buildContent, onSave, markSaved, clearRemoteUpdate]);

  useEffect(() => {
    onStateChange?.({ dirty: isDirty, save: handleSave, discard: discardDraft });
  }, [discardDraft, handleSave, isDirty, onStateChange]);

  // Ctrl/Cmd+S to save.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !saving) void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, isDirty, saving]);

  // -- file mutations -------------------------------------------------------

  const handleAddFile = () => {
    const file = createFile(files);
    setFiles((prev) => insertFile(prev, prev.length, file));
    setSelectedPath(file.path);
  };

  const handleDeleteFile = (file: AppFile) => setPendingDelete(file);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const pathToDelete = pendingDelete.path;
    setFiles((prev) => deleteFile(prev, pathToDelete));
    if (selectedPath === pathToDelete) {
      setSelectedPath((prevSelected) => {
        const remaining = files.filter((f) => f.path !== pathToDelete);
        if (prevSelected && findFile(remaining, prevSelected)) return prevSelected;
        return remaining[0]?.path ?? null;
      });
    }
    setPendingDelete(null);
  };

  const handlePathChange = (oldPath: string, newPath: string) => {
    const trimmed = newPath.trim();
    if (trimmed === "" || files.some((f) => f.path === trimmed && f.path !== oldPath)) {
      return; // reject empty or duplicate paths
    }
    setFiles((prev) => updateFile(prev, oldPath, { path: trimmed }));
    if (selectedPath === oldPath) setSelectedPath(trimmed);
  };

  const handleContentChange = (path: string, content: string) => {
    setFiles((prev) => updateFile(prev, path, { content }));
  };

  const handleDefNameChange = (name: string) => {
    setDefinition((prev) => ({ ...prev, name }));
  };

  const handleDefEntrypointChange = (entrypoint: string) => {
    setDefinition((prev) => ({ ...prev, entrypoint }));
  };

  const selectedFile = useMemo(
    () => (selectedPath ? findFile(files, selectedPath) : undefined),
    [files, selectedPath],
  );

  // Build the preview document from current (possibly unsaved) state
  const previewDoc = useMemo(
    () => buildPreviewDoc({ definition, files }),
    [definition, files],
  );

  const refreshPreview = () => setPreviewKey((k) => k + 1);

  const togglePreview = () => {
    setShowPreview((prev) => {
      const next = !prev;
      if (next) refreshPreview();
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled app"
          aria-label="App title"
          className="flex-1 bg-transparent text-sm font-semibold text-text-primary font-display placeholder:text-text-secondary/40 rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        />
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          v{version}
        </span>
        {wsConnected === false && (
          <span
            className="flex items-center gap-1 text-xs text-warning"
            title="Realtime connection lost — your draft is preserved"
            role="status"
            aria-label="Realtime disconnected"
          >
            <CloudOff className="h-3.5 w-3.5" />
            Disconnected
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={showPreview ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
          onClick={togglePreview}
          aria-label={showPreview ? "Hide preview" : "Show preview"}
        >
          {showPreview ? "Hide Preview" : "Preview"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="h-3 w-3" />}
          onClick={handleAddFile}
          aria-label="Add file"
        >
          File
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Save className="h-3 w-3" />}
          onClick={handleSave}
          disabled={!isDirty || saving}
          loading={saving}
        >
          Save
        </Button>
      </div>

      {wsConnected === false && (
        <div
          role="status"
          aria-label="Realtime connection disconnected"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>
            Realtime connection lost. Your draft is preserved — you can still save.
          </span>
        </div>
      )}

      {remoteUpdate && !conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            This artifact changed elsewhere. Your draft is preserved.
          </span>
          <Button variant="ghost" size="sm" onClick={discardDraft}>
            Reload remote
          </Button>
        </div>
      )}
      {conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Version conflict — another client saved v{conflictState.currentVersion}.
            Your draft is preserved. Save again to overwrite, or discard to load latest.
          </span>
        </div>
      )}

      {saveError && !conflictState && (
        <div
          role="alert"
          aria-label="Save failed"
          className="flex items-center gap-2 border-b border-error/20 bg-error/10 px-4 py-2 text-xs text-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">Not saved: {saveError}. Your draft is preserved.</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saving}
          >
            Retry save
          </Button>
        </div>
      )}

      {/* Definition bar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2">
        <div className="flex items-center gap-2">
          <label
            htmlFor="app-def-name"
            className="text-[10px] font-medium uppercase tracking-wide text-text-secondary"
          >
            Name
          </label>
          <input
            id="app-def-name"
            value={definition.name ?? ""}
            onChange={(e) => handleDefNameChange(e.target.value)}
            placeholder="my-app"
            aria-label="App name"
            className="w-32 rounded border border-white/[0.08] bg-surface/60 px-2 py-1 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor="app-def-entrypoint"
            className="text-[10px] font-medium uppercase tracking-wide text-text-secondary"
          >
            Entrypoint
          </label>
          <input
            id="app-def-entrypoint"
            value={definition.entrypoint ?? ""}
            onChange={(e) => handleDefEntrypointChange(e.target.value)}
            placeholder="index.html"
            aria-label="App entrypoint file path"
            className="w-40 rounded border border-white/[0.08] bg-surface/60 px-2 py-1 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </div>
        <span className="ml-auto text-[10px] text-text-secondary/60">
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Main content: file list + editor / preview */}
      <div className="flex flex-1 overflow-hidden">
        {/* File list sidebar */}
        <div
          className="flex w-48 shrink-0 flex-col border-r border-white/[0.06] bg-surface/40"
          role="list"
          aria-label="App files"
        >
          <div className="flex items-center justify-between px-3 py-2 border-b border-white/[0.04]">
            <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">
              Files
            </span>
            <button
              type="button"
              onClick={handleAddFile}
              aria-label="Add file"
              className="flex h-5 w-5 items-center justify-center rounded text-text-secondary hover:text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-auto py-1">
            {files.length === 0 ? (
              <p className="px-3 py-4 text-xs text-text-secondary/60">
                No files. Click + to add one.
              </p>
            ) : (
              files.map((file) => (
                <div
                  key={file.path}
                  role="listitem"
                  className={`group flex items-center gap-1.5 px-2 py-1.5 text-xs cursor-pointer transition-colors ${
                    selectedPath === file.path
                      ? "bg-accent/10 text-accent"
                      : "text-text-secondary hover:bg-white/[0.03] hover:text-text-primary"
                  }`}
                  onClick={() => setSelectedPath(file.path)}
                  aria-label={`File ${file.path}`}
                  aria-current={selectedPath === file.path}
                >
                  <FileCode className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate flex-1">{file.path}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteFile(file);
                    }}
                    aria-label={`Delete file ${file.path}`}
                    className="hidden h-4 w-4 items-center justify-center rounded text-text-secondary hover:text-error group-hover:flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Editor + preview area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {showPreview ? (
            <div className="flex flex-1 flex-col overflow-hidden">
              <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-1.5">
                <span className="text-xs font-medium text-text-secondary">
                  Preview
                  {definition.entrypoint ? ` (${definition.entrypoint})` : ""}
                </span>
                <button
                  type="button"
                  onClick={refreshPreview}
                  aria-label="Refresh preview"
                  className="flex h-5 w-5 items-center justify-center rounded text-text-secondary hover:text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <iframe
                key={previewKey}
                srcDoc={previewDoc}
                title="App preview"
                sandbox="allow-scripts"
                className="flex-1 border-0 bg-white"
                aria-label="App preview render surface"
              />
            </div>
          ) : selectedFile ? (
            <div className="flex flex-1 flex-col overflow-hidden">
              {/* File path editor */}
              <div className="flex items-center gap-2 border-b border-white/[0.06] px-3 py-1.5">
                <FileCode className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
                <input
                  value={selectedFile.path}
                  onChange={(e) => handlePathChange(selectedFile.path, e.target.value)}
                  aria-label="File path"
                  className="flex-1 rounded border border-white/[0.08] bg-surface/60 px-2 py-1 text-xs font-mono text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                />
              </div>
              {/* File content editor */}
              <textarea
                value={selectedFile.content}
                onChange={(e) => handleContentChange(selectedFile.path, e.target.value)}
                aria-label={`Content for ${selectedFile.path}`}
                spellCheck={false}
                className="flex-1 resize-none bg-surface/20 px-4 py-3 font-mono text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 overflow-auto"
                placeholder="// file content"
              />
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-text-secondary">
              <div className="text-center">
                <FileCode className="mx-auto h-8 w-8 text-text-secondary/40" />
                <p className="mt-2 text-sm">No file selected.</p>
                <p className="mt-1 text-xs text-text-secondary/60">
                  Select a file from the list or add a new one.
                </p>
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Plus className="h-3 w-3" />}
                    onClick={handleAddFile}
                  >
                    Add File
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {isDirty && (
        <div className="shrink-0 border-t border-white/[0.04] px-4 py-1.5 text-xs text-text-secondary">
          Unsaved changes — press Ctrl/Cmd+S to save
        </div>
      )}

      {/* Delete confirmation */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete file"
      >
        <p className="text-sm text-text-secondary">
          Delete file{" "}
          <strong className="text-text-primary font-mono">
            {pendingDelete?.path}
          </strong>
          ?
        </p>
        <p className="mt-2 text-xs text-text-secondary/70">
          This change applies on save.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPendingDelete(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={confirmDelete}
            aria-label="Confirm delete file"
          >
            Delete file
          </Button>
        </div>
      </Modal>
    </div>
  );
}
