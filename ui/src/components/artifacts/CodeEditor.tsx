// CodeEditor (M6) — syntax-highlighted code editor with a bounded sandboxed
// run + output panel + re-run. Mirrors the AppEditor file-list pattern and
// reuses useArtifactDraftSync for dirty/remote-update handling.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Save,
  Plus,
  AlertTriangle,
  CloudOff,
  Trash2,
  FileCode,
  Play,
  RotateCcw,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { Artifact, CodeRunResult } from "@/lib/api";
import { useRunCode } from "@/lib/hooks";
import { ApiError } from "@/lib/api";
import { useArtifactDraftSync } from "./useArtifactDraftSync";
import { CodeHighlight } from "./CodeHighlight";
import {
  type CodeFile,
  type CodeContent,
  CODE_LANGUAGES,
  parseCode,
  serializeCode,
  createCodeFile,
  insertCodeFile,
  deleteCodeFile,
  updateCodeFile,
  findCodeFile,
} from "./code-content";

interface CodeEditorProps {
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

export function CodeEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
  onStateChange,
}: CodeEditorProps) {
  const parsed = parseCode(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [language, setLanguage] = useState<string>(parsed.language);
  const [entrypoint, setEntrypoint] = useState<string | undefined>(parsed.entrypoint);
  const [files, setFiles] = useState<CodeFile[]>(parsed.files);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    parsed.files[0]?.path ?? null,
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CodeFile | null>(null);
  const [runResult, setRunResult] = useState<CodeRunResult | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const runMutation = useRunCode(artifact.companyId);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const localSnapshot = serializeCode({ language, entrypoint, files });

  const adoptRemote = useCallback(
    (content: Record<string, unknown>, remoteTitle: string) => {
      const next = parseCode(content);
      setTitle(remoteTitle);
      setLanguage(next.language);
      setEntrypoint(next.entrypoint);
      setFiles(next.files);
      setSelectedPath((prev) => {
        if (prev && findCodeFile(next.files, prev)) return prev;
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
    serializeArtifactContent: (c) => serializeCode(parseCode(c)),
    onAdoptRemote: adoptRemote,
  });

  const discardDraft = useCallback(() => {
    resetBaselineToArtifact();
    adoptRemote(artifact.content, artifact.title);
  }, [artifact.content, artifact.title, adoptRemote, resetBaselineToArtifact]);

  const buildContent = useCallback(
    (): Record<string, unknown> =>
      ({ language, entrypoint, files }) as unknown as Record<string, unknown>,
    [language, entrypoint, files],
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

  // ── Run / re-run ───────────────────────────────────────────────────────
  // Run executes the saved artifact content in the bounded sandbox. If the
  // buffer is dirty, we prompt the user to save first (the run reads the
  // persisted artifact). Re-run re-invokes the same run with the latest
  // saved content.
  const handleRun = useCallback(async () => {
    if (isDirty) {
      const saved = await handleSave();
      if (!saved) return;
    }
    setRunError(null);
    try {
      const res = await runMutation.mutateAsync(artifact.id);
      const body = res as unknown as { data: CodeRunResult };
      setRunResult(body.data);
    } catch (err) {
      if (err instanceof ApiError) {
        // 422 unsupported language is a graceful result, not a crash.
        setRunResult(null);
        const body = err.body as { message?: string } | undefined;
        setRunError(body?.message ?? err.message);
      } else {
        setRunError(err instanceof Error ? err.message : "Run failed");
      }
    }
  }, [isDirty, handleSave, runMutation, artifact.id]);

  // -- file mutations -------------------------------------------------------

  const handleAddFile = () => {
    const file = createCodeFile(files, language);
    setFiles((prev) => insertCodeFile(prev, prev.length, file));
    setSelectedPath(file.path);
  };

  const handleDeleteFile = (file: CodeFile) => setPendingDelete(file);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const pathToDelete = pendingDelete.path;
    setFiles((prev) => deleteCodeFile(prev, pathToDelete));
    if (selectedPath === pathToDelete) {
      setSelectedPath((prevSelected) => {
        const remaining = files.filter((f) => f.path !== pathToDelete);
        if (prevSelected && findCodeFile(remaining, prevSelected)) return prevSelected;
        return remaining[0]?.path ?? null;
      });
    }
    setPendingDelete(null);
  };

  const handlePathChange = (oldPath: string, newPath: string) => {
    const trimmed = newPath.trim();
    if (trimmed === "" || files.some((f) => f.path === trimmed && f.path !== oldPath)) {
      return;
    }
    setFiles((prev) => updateCodeFile(prev, oldPath, { path: trimmed }));
    if (selectedPath === oldPath) setSelectedPath(trimmed);
    if (entrypoint === oldPath) setEntrypoint(trimmed);
  };

  const handleContentChange = (path: string, content: string) => {
    setFiles((prev) => updateCodeFile(prev, path, { content }));
  };

  const handleLanguageChange = (lang: string) => {
    setLanguage(lang);
  };

  const handleEntrypointChange = (ep: string) => {
    setEntrypoint(ep.trim() === "" ? undefined : ep.trim());
  };

  const selectedFile = useMemo(
    () => (selectedPath ? findCodeFile(files, selectedPath) : undefined),
    [files, selectedPath],
  );

  // Sync the highlight overlay scroll with the textarea scroll.
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const onTextareaScroll = useCallback(() => {
    if (textareaRef.current && highlightRef.current) {
      highlightRef.current.scrollTop = textareaRef.current.scrollTop;
      highlightRef.current.scrollLeft = textareaRef.current.scrollLeft;
    }
  }, []);

  const exitCodeLabel = runResult
    ? runResult.timedOut
      ? "timeout"
      : runResult.exitCode === 0
        ? "exit 0"
        : `exit ${runResult.exitCode}`
    : null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled code"
          aria-label="Code artifact title"
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
          icon={<Play className="h-3 w-3" />}
          onClick={handleRun}
          loading={runMutation.isPending}
          aria-label="Run code"
        >
          Run
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

      {/* Language + entrypoint bar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2">
        <div className="flex items-center gap-2">
          <label
            htmlFor="code-language"
            className="text-[10px] font-medium uppercase tracking-wide text-text-secondary"
          >
            Language
          </label>
          <select
            id="code-language"
            value={language}
            onChange={(e) => handleLanguageChange(e.target.value)}
            aria-label="Code language"
            className="rounded border border-white/[0.08] bg-surface/60 px-2 py-1 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          >
            {CODE_LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {lang === "javascript" ? "JavaScript" : lang === "typescript" ? "TypeScript" : "Python"}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label
            htmlFor="code-entrypoint"
            className="text-[10px] font-medium uppercase tracking-wide text-text-secondary"
          >
            Entrypoint
          </label>
          <input
            id="code-entrypoint"
            value={entrypoint ?? ""}
            onChange={(e) => handleEntrypointChange(e.target.value)}
            placeholder="(first file)"
            aria-label="Entrypoint file path"
            className="w-40 rounded border border-white/[0.08] bg-surface/60 px-2 py-1 text-xs font-mono text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
        </div>
        <span className="ml-auto text-[10px] text-text-secondary/60">
          {files.length} file{files.length === 1 ? "" : "s"}
        </span>
      </div>

      {/* Main content: file list + editor / output */}
      <div className="flex flex-1 overflow-hidden">
        {/* File list sidebar */}
        <div
          className="flex w-48 shrink-0 flex-col border-r border-white/[0.06] bg-surface/40"
          role="list"
          aria-label="Code files"
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

        {/* Editor + output area */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {selectedFile ? (
            <div className="relative flex flex-1 flex-col overflow-hidden">
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
              {/* Code editor: highlight overlay + transparent textarea */}
              <div className="relative flex-1 overflow-hidden bg-surface/20">
                <div ref={highlightRef} className="absolute inset-0 overflow-auto">
                  <CodeHighlight code={selectedFile.content} language={language} />
                </div>
                <textarea
                  ref={textareaRef}
                  value={selectedFile.content}
                  onChange={(e) => handleContentChange(selectedFile.path, e.target.value)}
                  onScroll={onTextareaScroll}
                  aria-label={`Content for ${selectedFile.path}`}
                  spellCheck={false}
                  className="absolute inset-0 resize-none bg-transparent px-4 py-3 font-mono text-xs leading-5 text-transparent caret-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 overflow-auto"
                  placeholder="// code"
                />
              </div>
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

          {/* Output panel */}
          {(runResult || runError || runMutation.isPending) && (
            <div
              className="flex h-44 shrink-0 flex-col border-t border-white/[0.06] bg-surface/40"
              aria-label="Run output"
              role="region"
            >
              <div className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-1.5">
                <Terminal className="h-3.5 w-3.5 text-text-secondary" />
                <span className="text-[10px] font-medium uppercase tracking-wide text-text-secondary">
                  Output
                </span>
                {exitCodeLabel && (
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                      runResult?.timedOut || (runResult?.exitCode !== 0 && runResult?.exitCode !== null)
                        ? "bg-error/10 text-error"
                        : "bg-emerald-500/10 text-emerald-400"
                    }`}
                    aria-label={`Run exit code ${exitCodeLabel}`}
                  >
                    {exitCodeLabel}
                  </span>
                )}
                {runResult && (
                  <span className="text-[10px] text-text-secondary/60 tabular-nums">
                    {Math.round(runResult.durationMs)}ms
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleRun}
                  disabled={runMutation.isPending}
                  aria-label="Re-run code"
                  className="ml-auto flex h-5 w-5 items-center justify-center rounded text-text-secondary hover:text-accent hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50"
                  title="Re-run"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="flex-1 overflow-auto px-3 py-2 font-mono text-xs leading-5">
                {runMutation.isPending && (
                  <p className="text-text-secondary">Running…</p>
                )}
                {runError && !runMutation.isPending && (
                  <pre className="whitespace-pre-wrap text-error">{runError}</pre>
                )}
                {runResult && !runMutation.isPending && (
                  <>
                    {runResult.stdout && (
                      <pre className="whitespace-pre-wrap text-text-primary">{runResult.stdout}</pre>
                    )}
                    {runResult.stderr && (
                      <pre className="whitespace-pre-wrap text-error">{runResult.stderr}</pre>
                    )}
                    {runResult.truncated && (
                      <pre className="whitespace-pre-wrap text-warning">[output truncated]</pre>
                    )}
                    {!runResult.stdout && !runResult.stderr && !runResult.truncated && (
                      <pre className="text-text-secondary">(no output)</pre>
                    )}
                  </>
                )}
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
