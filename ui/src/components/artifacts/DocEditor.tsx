import { useEffect, useRef, useState, useCallback } from "react";
import { Save, AlertTriangle, CloudOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import type { Artifact } from "@/lib/api";
import { diffDocText } from "@eidolon/shared";
import type { CoEditOp } from "@eidolon/shared";

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
  /** Co-editing: send an operation via WS. When provided, text changes emit ops. */
  coeditSendOp?: (op: CoEditOp) => void;
  /** Co-editing: send cursor position via WS. */
  coeditSendCursor?: (position: number | { rowId: string; colKey: string } | { cardId: string } | null) => void;
  /** Co-editing: trigger a co-edit save flush (replaces REST PATCH when active). */
  coeditSave?: (title?: string) => void;
  /** Co-editing: ref for the editor to register a remote op handler. */
  applyRemoteOpRef?: React.MutableRefObject<((op: CoEditOp) => void) | null>;
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
  coeditSendOp,
  coeditSendCursor,
  coeditSave,
  applyRemoteOpRef,
}: DocEditorProps) {
  const parsed = parseDocContent(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [body, setBody] = useState(parsed.body);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const prevBodyRef = useRef(parsed.body);
  const opCounterRef = useRef(0);
  const coeditSendOpRef = useRef(coeditSendOp);
  const coeditSendCursorRef = useRef(coeditSendCursor);
  coeditSendOpRef.current = coeditSendOp;
  coeditSendCursorRef.current = coeditSendCursor;

  // Sync local state when artifact changes (e.g. from realtime or revision restore)
  const isDirty =
    title !== artifact.title || body !== parseDocContent(artifact.content).body;

  // Co-editing mode: register a handler that applies remote ops to local state.
  // This avoids the prop-sync conflict where remote ops would be mistaken for
  // competing edits (the DocEditor draft-sync bug).
  useEffect(() => {
    if (!applyRemoteOpRef) return;
    applyRemoteOpRef.current = (op: CoEditOp) => {
      if (op.kind === 'doc.insert') {
        setBody(prev => {
          const pos = Math.max(0, Math.min(op.position, prev.length));
          const newBody = prev.slice(0, pos) + op.text + prev.slice(pos);
          prevBodyRef.current = newBody;
          return newBody;
        });
      } else if (op.kind === 'doc.delete') {
        setBody(prev => {
          const pos = Math.max(0, Math.min(op.position, prev.length));
          const len = Math.max(0, Math.min(op.length, prev.length - pos));
          const newBody = prev.slice(0, pos) + prev.slice(pos + len);
          prevBodyRef.current = newBody;
          return newBody;
        });
      }
    };
    return () => { applyRemoteOpRef.current = null; };
  }, [applyRemoteOpRef]);

  // Never overwrite a draft when a realtime refetch supplies a newer artifact.
  // In co-editing mode, skip prop sync — remote ops are applied via the ref
  // callback, and saves update the prop to match the local state.
  useEffect(() => {
    if (coeditSendOp) {
      // Co-editing mode: only sync on initial load or version change from save
      // (detected by the joined state sync). Don't sync on every prop change
      // because remote ops are handled by the ref callback.
      return;
    }
    const next = parseDocContent(artifact.content);
    const incomingChanged =
      artifact.title !== title || next.body !== body;
    if (incomingChanged && isDirty) {
      setRemoteUpdate(true);
      return;
    }
    setTitle(artifact.title);
    setBody(next.body);
    prevBodyRef.current = next.body;
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
      if (coeditSave) {
        // Co-editing mode: flush the session to DB (ops already sent via WS).
        // Pass the title so it is persisted alongside the content.
        coeditSave(title);
      } else {
        await onSave({
          title,
          content: { format: "markdown", body },
        });
      }
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      return false;
    }
  }, [isDirty, saving, title, body, onSave, coeditSave]);

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

  // Co-editing: send cursor position on selection change
  useEffect(() => {
    if (!coeditSendCursor) return;
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Document body"]');
    if (!textarea) return;
    const handleSelection = () => {
      const pos = textarea.selectionStart;
      coeditSendCursorRef.current?.(pos);
    };
    textarea.addEventListener("keyup", handleSelection);
    textarea.addEventListener("click", handleSelection);
    textarea.addEventListener("focus", handleSelection);
    return () => {
      textarea.removeEventListener("keyup", handleSelection);
      textarea.removeEventListener("click", handleSelection);
      textarea.removeEventListener("focus", handleSelection);
    };
  }, [coeditSendCursor]);

  // Co-editing: detect text changes and send operations
  const handleBodyChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newBody = e.target.value;
    const oldBody = prevBodyRef.current;
    if (coeditSendOp && oldBody !== newBody) {
      const opId = `ui_${Date.now()}_${++opCounterRef.current}`;
      const ops = diffDocText(oldBody, newBody, opId);
      for (const op of ops) {
        coeditSendOpRef.current?.(op);
      }
    }
    prevBodyRef.current = newBody;
    setBody(newBody);
  }, [coeditSendOp]);

  // Update prevBodyRef when body is synced from prop (remote update)
  useEffect(() => {
    prevBodyRef.current = body;
  }, [body]);

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

      {/* WS disconnect banner — visible indicator when realtime is down */}
      {wsConnected === false && (
        <div
          role="status"
          aria-label="Realtime connection disconnected"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>Realtime connection lost. Your draft is preserved — you can still save.</span>
        </div>
      )}

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
          aria-label="Save failed"
          className="flex items-center gap-2 border-b border-error/20 bg-error/10 px-4 py-2 text-xs text-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">Not saved: {saveError}. Your draft is preserved.</span>
          <Button variant="ghost" size="sm" onClick={handleSave} disabled={!isDirty || saving}>
            Retry save
          </Button>
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
          onChange={handleBodyChange}
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
