import { useEffect, useRef, useState, useCallback } from "react";
import { Save, AlertTriangle, CloudOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import type { Artifact } from "@/lib/api";

interface DocEditorProps {
  artifact: Artifact;
  version: number;
  onSave: (data: {
    title: string;
    content: Record<string, unknown>;
  }) => Promise<void>;
  onTitleChange?: (title: string) => void;
  saving?: boolean;
  conflictState?: ConflictState | null;
  wsConnected?: boolean;
  onRemoteUpdate?: (content: Record<string, unknown>, title: string) => void;
  onStateChange?: (state: { dirty: boolean; save: () => Promise<boolean>; discard: () => void }) => void;
}

export interface ConflictState {
  currentVersion: number;
  currentTitle: string;
  currentContent: Record<string, unknown>;
}

interface DocumentContent {
  format: "markdown" | "delta";
  body: string;
}

function parseDocContent(content: Record<string, unknown>): DocumentContent {
  const format = (content.format as string) === "delta" ? "delta" : "markdown";
  const body =
    typeof content.body === "string"
      ? content.body
      : Array.isArray(content.body)
        ? ""
        : "";
  return { format, body };
}

export function DocEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
  onRemoteUpdate,
  onStateChange,
}: DocEditorProps) {
  const parsed = parseDocContent(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [body, setBody] = useState(parsed.body);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Sync local state when artifact changes (e.g. from realtime or revision restore)
  const isDirty =
    title !== artifact.title || body !== parseDocContent(artifact.content).body;

  // Never overwrite a draft when a realtime refetch supplies a newer artifact.
  useEffect(() => {
    const next = parseDocContent(artifact.content);
    const incomingChanged =
      artifact.title !== title || next.body !== body;
    if (incomingChanged && isDirty) {
      setRemoteUpdate(true);
      return;
    }
    setTitle(artifact.title);
    setBody(next.body);
    setSaveError(null);
    setRemoteUpdate(false);
  }, [artifact.id, artifact.version, artifact.title, artifact.content]);

  const discardDraft = useCallback(() => {
    const next = parseDocContent(artifact.content);
    setTitle(artifact.title);
    setBody(next.body);
    setSaveError(null);
    setRemoteUpdate(false);
    onRemoteUpdate?.(artifact.content, artifact.title);
  }, [artifact]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty || saving) return false;
    setSaveError(null);
    try {
      await onSave({
        title,
        content: { format: "markdown", body },
      });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      return false;
    }
  }, [isDirty, saving, title, body, onSave]);

  useEffect(() => {
    onStateChange?.({ dirty: isDirty, save: handleSave, discard: discardDraft });
  }, [discardDraft, handleSave, isDirty, onStateChange]);

  // Keyboard shortcut: Ctrl/Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !saving) {
          void handleSave();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, isDirty, saving]);

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled document"
          aria-label="Document title"
          className="flex-1 bg-transparent text-sm font-semibold text-text-primary font-display outline-none placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-accent/30 rounded px-1 py-0.5"
        />
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          v{version}
        </span>
        {wsConnected === false && (
          <span
            className="flex items-center gap-1 text-xs text-warning"
            title="Realtime connection lost — your draft is preserved"
          >
            <CloudOff className="h-3.5 w-3.5" />
            Disconnected
          </span>
        )}
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

      {/* Conflict banner */}
      {remoteUpdate && !conflictState && (
        <div role="alert" className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">This artifact changed elsewhere. Your draft is preserved.</span>
          <Button variant="ghost" size="sm" onClick={discardDraft}>Reload remote</Button>
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
            Your draft is preserved. Save again to overwrite, or discard to load
            the latest version.
          </span>
        </div>
      )}

      {/* Save error banner */}
      {saveError && !conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-error/20 bg-error/10 px-4 py-2 text-xs text-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Not saved: {saveError}. Your draft is preserved.</span>
        </div>
      )}

      {/* Editor body */}
      <div className="flex-1 overflow-auto p-4">
        {body === "" && !isDirty ? (
          <div
            className="flex h-full items-center justify-center text-text-secondary"
            data-testid="doc-empty-state"
          >
            <div className="text-center">
              <p className="text-sm">This document is empty.</p>
              <p className="text-xs mt-1 text-text-secondary/60">
                Start typing below to add content.
              </p>
            </div>
          </div>
        ) : null}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Start writing in markdown…"
          aria-label="Document body"
          className="min-h-[400px] flex-1 resize-none font-mono text-sm leading-relaxed"
        />
      </div>

      {/* Dirty indicator */}
      {isDirty && (
        <div className="shrink-0 border-t border-white/[0.04] px-4 py-1.5 text-xs text-text-secondary">
          Unsaved changes — press Ctrl/Cmd+S to save
        </div>
      )}
    </div>
  );
}
