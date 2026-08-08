import { useCallback, useEffect, useRef, useState } from "react";
import {
  Save,
  Plus,
  AlertTriangle,
  CloudOff,
  ChevronUp,
  ChevronDown,
  Trash2,
  Copy,
  GripVertical,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Input";
import type { Artifact } from "@/lib/api";
import {
  type Slide,
  type SlideBlock,
  type SlideLayout,
  SLIDE_LAYOUTS,
  LAYOUT_LABELS,
  parseDeck,
  genSlideId,
  serializeDeck,
  moveSlide,
  reorderSlides,
  createSlide,
  getBlockText,
} from "./slide-content";

interface SlideEditorProps {
  artifact: Artifact;
  version: number;
  onSave: (data: {
    title: string;
    content: Record<string, unknown>;
  }) => Promise<void>;
  saving?: boolean;
  conflictState?: ConflictState | null;
  wsConnected?: boolean;
  onRemoteUpdate?: (content: Record<string, unknown>, title: string) => void;
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

type DragState = { kind: "slide"; slideId: string } | null;

export function SlideEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
  onRemoteUpdate,
  onStateChange,
}: SlideEditorProps) {
  const parsed = parseDeck(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [slides, setSlides] = useState<Slide[]>(parsed.slides);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const drag = useRef<DragState>(null);

  // Dirtiness is measured against the last state this editor and the server
  // agreed on, NOT against the live artifact. Comparing to the live artifact
  // would make any incoming realtime update look like a local draft and block
  // the editor from adopting it.
  const baseline = useRef({
    id: artifact.id,
    title: artifact.title,
    content: serializeDeck(parsed),
  });

  const localSnapshot = serializeDeck({ slides });
  const isDirty =
    title !== baseline.current.title || localSnapshot !== baseline.current.content;

  useEffect(() => {
    const next = parseDeck(artifact.content);
    const remoteSnapshot = serializeDeck(next);
    const switchedArtifact = baseline.current.id !== artifact.id;
    const remoteChanged =
      artifact.title !== baseline.current.title ||
      remoteSnapshot !== baseline.current.content;
    if (!switchedArtifact && !remoteChanged) return;
    // A realtime refetch must not clobber an in-progress local draft.
    if (!switchedArtifact && isDirty) {
      setRemoteUpdate(true);
      return;
    }
    baseline.current = {
      id: artifact.id,
      title: artifact.title,
      content: remoteSnapshot,
    };
    setTitle(artifact.title);
    setSlides(next.slides);
    setSaveError(null);
    setRemoteUpdate(false);
    setSelectedIdx((prev) => Math.min(prev, Math.max(0, next.slides.length - 1)));
  }, [artifact.id, artifact.version, artifact.title, artifact.content, isDirty]);

  const discardDraft = useCallback(() => {
    const next = parseDeck(artifact.content);
    baseline.current = {
      id: artifact.id,
      title: artifact.title,
      content: serializeDeck(next),
    };
    setTitle(artifact.title);
    setSlides(next.slides);
    setSaveError(null);
    setRemoteUpdate(false);
    setSelectedIdx(0);
    onRemoteUpdate?.(artifact.content, artifact.title);
  }, [artifact, onRemoteUpdate]);

  const buildContent = useCallback(
    (): Record<string, unknown> =>
      ({ slides }) as unknown as Record<string, unknown>,
    [slides],
  );

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty || saving) return false;
    setSaveError(null);
    const content = buildContent();
    try {
      await onSave({ title, content });
      baseline.current = {
        id: artifact.id,
        title,
        content: JSON.stringify(content),
      };
      setRemoteUpdate(false);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      return false;
    }
  }, [isDirty, saving, title, buildContent, onSave, artifact.id]);

  useEffect(() => {
    onStateChange?.({ dirty: isDirty, save: handleSave, discard: discardDraft });
  }, [discardDraft, handleSave, isDirty, onStateChange]);

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

  // -- slide mutations ------------------------------------------------------

  const addSlide = () => {
    const newSlide = createSlide("content");
    setSlides((prev) => [...prev, newSlide]);
    setSelectedIdx(slides.length);
  };

  const updateSlideLayout = (index: number, layout: string) => {
    setSlides((prev) =>
      prev.map((s, i) => (i === index ? { ...s, layout } : s)),
    );
  };

  const handleMoveSlide = (index: number, delta: -1 | 1) => {
    setSlides((prev) => moveSlide(prev, index, delta));
    setSelectedIdx((prev) => {
      const target = index + delta;
      if (target < 0 || target >= slides.length) return prev;
      return target;
    });
  };

  const confirmDeleteSlide = () => {
    const idx = pendingDelete;
    setPendingDelete(null);
    if (idx === null) return;
    setSlides((prev) => prev.filter((_, i) => i !== idx));
    setSelectedIdx((prev) => Math.min(prev, Math.max(0, slides.length - 2)));
  };

  const duplicateSlide = (index: number) => {
    const orig = slides[index];
    if (!orig) return;
    const copy: Slide = {
      id: genSlideId(),
      layout: orig.layout,
      blocks: orig.blocks.map((b) => ({ ...b, content: { ...b.content } })),
    };
    setSlides((prev) => {
      const next = [...prev];
      next.splice(index + 1, 0, copy);
      return next;
    });
    setSelectedIdx(index + 1);
  };

  // -- block mutations ------------------------------------------------------

  const addBlock = (slideIdx: number) => {
    setSlides((prev) =>
      prev.map((s, i) =>
        i === slideIdx
          ? { ...s, blocks: [...s.blocks, { type: "text", content: { text: "" } }] }
          : s,
      ),
    );
  };

  const updateBlock = (slideIdx: number, blockIdx: number, block: SlideBlock) => {
    setSlides((prev) =>
      prev.map((s, i) =>
        i === slideIdx
          ? { ...s, blocks: s.blocks.map((b, bi) => (bi === blockIdx ? block : b)) }
          : s,
      ),
    );
  };

  const updateBlockContent = (
    slideIdx: number,
    blockIdx: number,
    key: string,
    value: unknown,
  ) => {
    setSlides((prev) =>
      prev.map((s, i) =>
        i === slideIdx
          ? {
              ...s,
              blocks: s.blocks.map((b, bi) =>
                bi === blockIdx
                  ? { ...b, content: { ...b.content, [key]: value } }
                  : b,
              ),
            }
          : s,
      ),
    );
  };

  const moveBlock = (slideIdx: number, blockIdx: number, delta: -1 | 1) => {
    setSlides((prev) =>
      prev.map((s, i) => {
        if (i !== slideIdx) return s;
        const target = blockIdx + delta;
        if (target < 0 || target >= s.blocks.length) return s;
        const next = [...s.blocks];
        [next[blockIdx], next[target]] = [next[target], next[blockIdx]];
        return { ...s, blocks: next };
      }),
    );
  };

  const deleteBlock = (slideIdx: number, blockIdx: number) => {
    setSlides((prev) =>
      prev.map((s, i) =>
        i === slideIdx
          ? { ...s, blocks: s.blocks.filter((_, bi) => bi !== blockIdx) }
          : s,
      ),
    );
  };

  // -- drag and drop for slide reorder --------------------------------------

  const dropOnSlide = (targetId: string) => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.kind !== "slide") return;
    setSlides((prev) => reorderSlides(prev, state.slideId, targetId));
  };

  const selected = slides[selectedIdx];
  const isEmpty = slides.length === 0 && !isDirty;
  const pendingSlide = pendingDelete !== null ? slides[pendingDelete] : null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled deck"
          aria-label="Deck title"
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
          onClick={addSlide}
        >
          Slide
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
          <span className="flex-1">
            Not saved: {saveError}. Your draft is preserved.
          </span>
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

      {/* Deck surface: slide navigator + slide editor */}
      <div className="flex flex-1 overflow-hidden">
        {/* Slide navigator (left rail) */}
        <div
          className="flex w-44 shrink-0 flex-col border-r border-white/[0.06] overflow-y-auto"
          data-testid="slide-navigator"
        >
          {slides.map((slide, index) => (
            <div
              key={slide.id}
              draggable
              onDragStart={() => {
                drag.current = { kind: "slide", slideId: slide.id };
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => dropOnSlide(slide.id)}
              className={`group flex items-center gap-1 border-b border-white/[0.04] px-2 py-2 cursor-pointer transition-colors ${
                index === selectedIdx
                  ? "bg-accent/10 border-l-2 border-l-accent"
                  : "hover:bg-white/[0.03] border-l-2 border-l-transparent"
              }`}
              onClick={() => setSelectedIdx(index)}
              role="button"
              tabIndex={0}
              aria-label={`Slide ${index + 1}: ${slide.layout}`}
              aria-selected={index === selectedIdx}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelectedIdx(index);
                }
              }}
            >
              <GripVertical className="h-3 w-3 shrink-0 text-text-secondary/40 opacity-0 group-hover:opacity-100" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-mono text-text-secondary tabular-nums">
                    {index + 1}
                  </span>
                  <span className="text-xs text-text-secondary truncate">
                    {LAYOUT_LABELS[slide.layout as SlideLayout] ?? slide.layout}
                  </span>
                </div>
                <p className="text-[10px] text-text-secondary/60 truncate">
                  {slide.blocks.length}{" "}
                  {slide.blocks.length === 1 ? "block" : "blocks"}
                </p>
              </div>
            </div>
          ))}
          <button
            onClick={addSlide}
            className="flex items-center justify-center gap-1 px-2 py-2 text-xs text-text-secondary hover:text-accent hover:bg-accent/5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label="Add slide"
          >
            <Plus className="h-3 w-3" />
            Add Slide
          </button>
        </div>

        {/* Slide editor (main area) */}
        <div className="flex-1 overflow-auto p-4" data-testid="slide-editor">
          {isEmpty ? (
            <div className="flex h-full items-center justify-center text-text-secondary">
              <div className="text-center">
                <p className="text-sm">This deck is empty.</p>
                <p className="mt-1 text-xs text-text-secondary/60">
                  Add a slide to start building your deck.
                </p>
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Plus className="h-3 w-3" />}
                    onClick={addSlide}
                  >
                    Add Slide
                  </Button>
                </div>
              </div>
            </div>
          ) : selected ? (
            <div className="mx-auto max-w-2xl space-y-4">
              {/* Slide header: layout selector + slide actions */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-secondary">
                  Slide {selectedIdx + 1} of {slides.length}
                </span>
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ChevronUp className="h-3 w-3" />}
                    onClick={() => handleMoveSlide(selectedIdx, -1)}
                    disabled={selectedIdx === 0}
                    aria-label={`Move slide ${selectedIdx + 1} up`}
                  >
                    Up
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<ChevronDown className="h-3 w-3" />}
                    onClick={() => handleMoveSlide(selectedIdx, 1)}
                    disabled={selectedIdx === slides.length - 1}
                    aria-label={`Move slide ${selectedIdx + 1} down`}
                  >
                    Down
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Copy className="h-3 w-3" />}
                    onClick={() => duplicateSlide(selectedIdx)}
                    aria-label={`Duplicate slide ${selectedIdx + 1}`}
                  >
                    Dup
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 className="h-3 w-3" />}
                    onClick={() => setPendingDelete(selectedIdx)}
                    aria-label={`Delete slide ${selectedIdx + 1}`}
                    className="text-error hover:text-error"
                  >
                    Del
                  </Button>
                </div>
              </div>

              {/* Layout selector */}
              <div className="flex items-center gap-2">
                <label
                  htmlFor="slide-layout"
                  className="text-xs text-text-secondary"
                >
                  Layout
                </label>
                <Select
                  id="slide-layout"
                  options={SLIDE_LAYOUTS.map((l) => ({
                    value: l,
                    label: LAYOUT_LABELS[l],
                  }))}
                  value={selected.layout}
                  onChange={(e) =>
                    updateSlideLayout(selectedIdx, e.target.value)
                  }
                  className="w-auto min-w-[120px]"
                  aria-label="Slide layout"
                />
              </div>

              {/* Slide preview area */}
              <div
                className="rounded-lg border border-white/[0.08] bg-surface/40 p-6 min-h-[200px]"
                data-testid="slide-preview"
              >
                {/* Render layout-specific preview */}
                {selected.layout === "title" && (
                  <div className="flex flex-col items-center justify-center gap-3 py-8">
                    {selected.blocks.map((block, blockIdx) => (
                      <SlideBlockEditor
                        key={blockIdx}
                        block={block}
                        onChange={(b) => updateBlock(selectedIdx, blockIdx, b)}
                        onContentChange={(key, val) =>
                          updateBlockContent(selectedIdx, blockIdx, key, val)
                        }
                        onMoveUp={() => moveBlock(selectedIdx, blockIdx, -1)}
                        onMoveDown={() => moveBlock(selectedIdx, blockIdx, 1)}
                        onDelete={() => deleteBlock(selectedIdx, blockIdx)}
                        canMoveUp={blockIdx > 0}
                        canMoveDown={blockIdx < selected.blocks.length - 1}
                        big
                      />
                    ))}
                  </div>
                )}
                {selected.layout === "split" && (
                  <div className="grid grid-cols-2 gap-4">
                    {selected.blocks.map((block, blockIdx) => (
                      <SlideBlockEditor
                        key={blockIdx}
                        block={block}
                        onChange={(b) => updateBlock(selectedIdx, blockIdx, b)}
                        onContentChange={(key, val) =>
                          updateBlockContent(selectedIdx, blockIdx, key, val)
                        }
                        onMoveUp={() => moveBlock(selectedIdx, blockIdx, -1)}
                        onMoveDown={() => moveBlock(selectedIdx, blockIdx, 1)}
                        onDelete={() => deleteBlock(selectedIdx, blockIdx)}
                        canMoveUp={blockIdx > 0}
                        canMoveDown={blockIdx < selected.blocks.length - 1}
                      />
                    ))}
                  </div>
                )}
                {(selected.layout === "content" || selected.layout === "blank") && (
                  <div className="space-y-3">
                    {selected.blocks.map((block, blockIdx) => (
                      <SlideBlockEditor
                        key={blockIdx}
                        block={block}
                        onChange={(b) => updateBlock(selectedIdx, blockIdx, b)}
                        onContentChange={(key, val) =>
                          updateBlockContent(selectedIdx, blockIdx, key, val)
                        }
                        onMoveUp={() => moveBlock(selectedIdx, blockIdx, -1)}
                        onMoveDown={() => moveBlock(selectedIdx, blockIdx, 1)}
                        onDelete={() => deleteBlock(selectedIdx, blockIdx)}
                        canMoveUp={blockIdx > 0}
                        canMoveDown={blockIdx < selected.blocks.length - 1}
                      />
                    ))}
                  </div>
                )}
                {selected.blocks.length === 0 && (
                  <div className="flex items-center justify-center text-xs text-text-secondary/60 py-8">
                    No blocks on this slide.
                  </div>
                )}
              </div>

              {/* Add block button */}
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus className="h-3 w-3" />}
                onClick={() => addBlock(selectedIdx)}
                aria-label="Add block to slide"
              >
                Add Block
              </Button>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-text-secondary">
              <div className="text-center">
                <p className="text-sm">No slide selected.</p>
                <div className="mt-3 flex justify-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Plus className="h-3 w-3" />}
                    onClick={addSlide}
                  >
                    Add Slide
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

      {/* Slide deletion confirmation */}
      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Delete slide"
      >
        <p className="text-sm text-text-secondary">
          Delete slide{" "}
          <strong className="text-text-primary">
            {pendingSlide ? selectedIdx + 1 : ""}
          </strong>
          ?
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
            onClick={confirmDeleteSlide}
            aria-label="Confirm delete slide"
          >
            Delete slide
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SlideBlockEditor — inline editor for a single block on a slide
// ---------------------------------------------------------------------------

interface SlideBlockEditorProps {
  block: SlideBlock;
  onChange: (block: SlideBlock) => void;
  onContentChange: (key: string, value: unknown) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  big?: boolean;
}

function SlideBlockEditor({
  block,
  onChange,
  onContentChange,
  onMoveUp,
  onMoveDown,
  onDelete,
  canMoveUp,
  canMoveDown,
  big,
}: SlideBlockEditorProps) {
  const text = getBlockText(block);
  const isHeading = block.type === "heading";
  const isImage = block.type === "image";

  return (
    <div className="group relative rounded-md border border-white/[0.04] p-2 transition-colors hover:border-white/[0.08]">
      {/* Block controls (visible on hover) */}
      <div className="absolute -top-2 right-1 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-surface rounded px-1">
        <button
          onClick={onMoveUp}
          disabled={!canMoveUp}
          className="flex h-5 w-5 items-center justify-center rounded text-text-secondary hover:text-accent disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Move block up"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          onClick={onMoveDown}
          disabled={!canMoveDown}
          className="flex h-5 w-5 items-center justify-center rounded text-text-secondary hover:text-accent disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Move block down"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        <button
          onClick={onDelete}
          className="flex h-5 w-5 items-center justify-center rounded text-text-secondary hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          aria-label="Delete block"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      {/* Block type selector */}
      <select
        value={block.type}
        onChange={(e) => onChange({ ...block, type: e.target.value })}
        className="mb-1 text-[10px] bg-transparent text-text-secondary border-none outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
        aria-label="Block type"
      >
        <option value="text">text</option>
        <option value="heading">heading</option>
        <option value="image">image</option>
        <option value="list">list</option>
      </select>

      {isImage ? (
        <div className="space-y-1">
          <input
            value={typeof block.content.url === "string" ? block.content.url : ""}
            onChange={(e) => onContentChange("url", e.target.value)}
            placeholder="https://example.com/image.png"
            aria-label="Image URL"
            className="w-full bg-transparent text-xs text-text-primary rounded px-1 py-0.5 border border-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
          />
          {typeof block.content.caption === "string" && (
            <input
              value={block.content.caption}
              onChange={(e) => onContentChange("caption", e.target.value)}
              placeholder="Caption (optional)"
              aria-label="Image caption"
              className="w-full bg-transparent text-xs text-text-secondary rounded px-1 py-0.5 border border-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          )}
        </div>
      ) : (
        <textarea
          value={text}
          onChange={(e) => onContentChange("text", e.target.value)}
          placeholder={isHeading ? "Heading text…" : "Enter text…"}
          aria-label={isHeading ? "Heading text" : "Block text"}
          rows={isHeading ? 1 : 3}
          className={`w-full bg-transparent text-text-primary rounded px-1 py-0.5 resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
            isHeading
              ? "text-lg font-semibold font-display"
              : big
                ? "text-base"
                : "text-sm"
          }`}
        />
      )}
    </div>
  );
}
