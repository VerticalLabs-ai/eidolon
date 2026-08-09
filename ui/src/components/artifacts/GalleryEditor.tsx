import { useCallback, useEffect, useState } from "react";
import {
  Save,
  Plus,
  AlertTriangle,
  CloudOff,
  Trash2,
  ChevronUp,
  ChevronDown,
  Images,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Input";
import type { Artifact } from "@/lib/api";
import { useArtifactDraftSync } from "./useArtifactDraftSync";
import {
  type GalleryItem,
  type GalleryContent,
  parseGallery,
  serializeGallery,
  createItem,
  insertItem,
  deleteItem,
  moveUp,
  moveDown,
  updateItem,
} from "./gallery-content";

interface GalleryEditorProps {
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

export function GalleryEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
  onStateChange,
}: GalleryEditorProps) {
  const parsed = parseGallery(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [items, setItems] = useState<GalleryItem[]>(parsed.items);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<GalleryItem | null>(null);

  // Local-content -> JSON string used for baseline dirty tracking.
  const localSnapshot = serializeGallery({ items });

  const adoptRemote = useCallback((content: Record<string, unknown>, remoteTitle: string) => {
    const next = parseGallery(content);
    setTitle(remoteTitle);
    setItems(next.items);
    setSaveError(null);
  }, []);

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
    serializeArtifactContent: (c) => serializeGallery(parseGallery(c)),
    onAdoptRemote: adoptRemote,
  });

  const discardDraft = useCallback(() => {
    resetBaselineToArtifact();
    adoptRemote(artifact.content, artifact.title);
  }, [artifact.content, artifact.title, adoptRemote, resetBaselineToArtifact]);

  const buildContent = useCallback(
    (): Record<string, unknown> => ({ items }) as unknown as Record<string, unknown>,
    [items],
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

  // -- item mutations -------------------------------------------------------

  const addItem = () => {
    const item = createItem(items);
    setItems((prev) => insertItem(prev, prev.length, item));
  };

  const handleDelete = (item: GalleryItem) => setPendingDelete(item);

  const confirmDelete = () => {
    if (!pendingDelete) return;
    setItems((prev) => deleteItem(prev, pendingDelete.id));
    setPendingDelete(null);
  };

  const handleMoveUp = (id: string) => setItems((prev) => moveUp(prev, id));
  const handleMoveDown = (id: string) => setItems((prev) => moveDown(prev, id));

  const handleUrlChange = (id: string, url: string) =>
    setItems((prev) => updateItem(prev, id, { url }));
  const handleCaptionChange = (id: string, caption: string) =>
    setItems((prev) =>
      updateItem(prev, id, { caption: caption.trim() === "" ? undefined : caption }),
    );
  const handleTypeChange = (id: string, type: GalleryItem["type"]) =>
    setItems((prev) => updateItem(prev, id, { type }));

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled gallery"
          aria-label="Gallery title"
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
          icon={<Plus className="h-3 w-3" />}
          onClick={addItem}
          aria-label="Add media item"
        >
          Item
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

      {/* Gallery grid */}
      <div className="flex-1 overflow-auto p-4" data-testid="gallery-grid">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <div className="text-center">
              <Images className="mx-auto h-8 w-8 text-text-secondary/40" />
              <p className="mt-2 text-sm">This gallery is empty.</p>
              <p className="mt-1 text-xs text-text-secondary/60">
                Add a media item to start building your gallery.
              </p>
              <div className="mt-3 flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="h-3 w-3" />}
                  onClick={addItem}
                >
                  Add Item
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div
            className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
            role="list"
            aria-label="Gallery items"
          >
            {items.map((item, index) => (
              <div
                key={item.id}
                role="listitem"
                className="group relative flex flex-col overflow-hidden rounded-lg border border-white/[0.08] bg-surface/60"
                aria-label={`Gallery item ${index + 1}: ${item.caption || item.url || "Untitled"}`}
              >
                {/* Image preview / placeholder */}
                <div className="relative aspect-video w-full bg-surface/40">
                  {item.url ? (
                    item.type === "image" ? (
                      <img
                        src={item.url}
                        alt={item.caption || ""}
                        className="absolute inset-0 h-full w-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <video
                        src={item.url}
                        className="absolute inset-0 h-full w-full object-cover"
                        controls
                        preload="metadata"
                      />
                    )
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-text-secondary/40">
                      <Images className="h-6 w-6" />
                    </div>
                  )}
                  {/* Caption overlay (only when a caption is present) */}
                  {item.caption && item.caption.trim() !== "" && (
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
                      <p className="truncate text-xs text-white">{item.caption}</p>
                    </div>
                  )}
                  {/* Reorder + delete controls (keyboard-accessible) */}
                  <div className="absolute right-1 top-1 flex gap-1 opacity-80">
                    <button
                      type="button"
                      onClick={() => handleMoveUp(item.id)}
                      disabled={index === 0}
                      aria-label={`Move item ${index + 1} up`}
                      className="flex h-6 w-6 items-center justify-center rounded bg-black/50 text-white hover:bg-black/70 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleMoveDown(item.id)}
                      disabled={index === items.length - 1}
                      aria-label={`Move item ${index + 1} down`}
                      className="flex h-6 w-6 items-center justify-center rounded bg-black/50 text-white hover:bg-black/70 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(item)}
                      aria-label={`Delete item ${index + 1}`}
                      className="flex h-6 w-6 items-center justify-center rounded bg-black/50 text-white hover:bg-red-600/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {/* Item fields */}
                <div className="flex flex-col gap-2 p-2">
                  <Select
                    label="Type"
                    aria-label={`Item ${index + 1} type`}
                    value={item.type}
                    onChange={(e) =>
                      handleTypeChange(item.id, e.target.value as GalleryItem["type"])
                    }
                    options={[
                      { value: "image", label: "Image" },
                      { value: "video", label: "Video" },
                    ]}
                    className="w-full"
                  />
                  <div>
                    <label
                      htmlFor={`gallery-url-${item.id}`}
                      className="mb-1 block text-[10px] text-text-secondary"
                    >
                      URL
                    </label>
                    <input
                      id={`gallery-url-${item.id}`}
                      value={item.url}
                      onChange={(e) => handleUrlChange(item.id, e.target.value)}
                      placeholder="https://example.com/image.png"
                      aria-label={`Item ${index + 1} URL`}
                      className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`gallery-caption-${item.id}`}
                      className="mb-1 block text-[10px] text-text-secondary"
                    >
                      Caption (optional)
                    </label>
                    <input
                      id={`gallery-caption-${item.id}`}
                      value={item.caption ?? ""}
                      onChange={(e) => handleCaptionChange(item.id, e.target.value)}
                      placeholder="Caption"
                      aria-label={`Item ${index + 1} caption`}
                      className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    />
                  </div>
                </div>
              </div>
            ))}
            {/* Add card */}
            <button
              type="button"
              onClick={addItem}
              className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-white/[0.12] text-text-secondary hover:border-accent/40 hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              aria-label="Add media item"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>
        )}
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
        title="Delete gallery item"
      >
        <p className="text-sm text-text-secondary">
          Delete this gallery item
          {pendingDelete?.caption ? (
            <>
              {" "}
              <strong className="text-text-primary">{pendingDelete.caption}</strong>
            </>
          ) : null}
          ?
        </p>
        <p className="mt-2 text-xs text-text-secondary/70">
          The remaining items will be preserved. This change applies on save.
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
            aria-label="Confirm delete gallery item"
          >
            Delete item
          </Button>
        </div>
      </Modal>
    </div>
  );
}
