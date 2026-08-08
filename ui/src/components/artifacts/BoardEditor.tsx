import { useCallback, useEffect, useRef, useState } from "react";
import { Save, Plus, AlertTriangle, CloudOff } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import type { Artifact } from "@/lib/api";
import type { CoEditOp } from "@eidolon/shared";
import { BoardColumn } from "./BoardColumn";
import {
  cardsInColumn,
  genBoardId,
  moveCard,
  moveColumn,
  normalizeBoard,
  parseBoard,
  reorderColumns,
  serializeBoard,
  shiftCard,
  type BoardCard,
  type BoardColumn as BoardColumnModel,
} from "./board-content";

interface BoardEditorProps {
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
  coeditSendOp?: (op: CoEditOp) => void;
  coeditSendCursor?: (position: number | { rowId: string; colKey: string } | { cardId: string } | null) => void;
  coeditSave?: () => void;
  applyRemoteOpRef?: React.MutableRefObject<((op: CoEditOp) => void) | null>;
}

export interface ConflictState {
  currentVersion: number;
  currentTitle: string;
  currentContent: Record<string, unknown>;
}

type DragState =
  | { kind: "column"; columnId: string }
  | { kind: "card"; cardId: string }
  | null;

export function BoardEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
  onRemoteUpdate,
  onStateChange,
  coeditSendOp: _coeditSendOp,
  coeditSendCursor: _coeditSendCursor,
  coeditSave,
  applyRemoteOpRef: _applyRemoteOpRef,
}: BoardEditorProps) {
  const parsed = parseBoard(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [columns, setColumns] = useState<BoardColumnModel[]>(parsed.columns);
  const [cards, setCards] = useState<BoardCard[]>(parsed.cards);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const [pendingColumnDelete, setPendingColumnDelete] = useState<string | null>(null);
  const drag = useRef<DragState>(null);

  // Dirtiness is measured against the last state this editor and the server
  // agreed on, NOT against the live artifact. Comparing to the live artifact
  // would make any incoming realtime update look like a local draft and block
  // the editor from adopting it.
  const baseline = useRef({
    id: artifact.id,
    title: artifact.title,
    content: serializeBoard(parsed),
  });

  const localSnapshot = serializeBoard({ columns, cards });
  const isDirty =
    title !== baseline.current.title || localSnapshot !== baseline.current.content;

  useEffect(() => {
    const next = parseBoard(artifact.content);
    const remoteSnapshot = serializeBoard(next);
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
    setColumns(next.columns);
    setCards(next.cards);
    setSaveError(null);
    setRemoteUpdate(false);
  }, [artifact.id, artifact.version, artifact.title, artifact.content, isDirty]);

  const discardDraft = useCallback(() => {
    const next = parseBoard(artifact.content);
    baseline.current = {
      id: artifact.id,
      title: artifact.title,
      content: serializeBoard(next),
    };
    setTitle(artifact.title);
    setColumns(next.columns);
    setCards(next.cards);
    setSaveError(null);
    setRemoteUpdate(false);
    onRemoteUpdate?.(artifact.content, artifact.title);
  }, [artifact, onRemoteUpdate]);

  const buildContent = useCallback(
    (): Record<string, unknown> =>
      normalizeBoard({ columns, cards }) as unknown as Record<string, unknown>,
    [columns, cards],
  );

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty || saving) return false;
    setSaveError(null);
    const content = buildContent();
    try {
      if (coeditSave) {
        coeditSave();
      } else {
        await onSave({ title, content });
      }
      // The saved state is the new agreed-on baseline, so the refetch that
      // follows this save is not mistaken for a competing remote edit.
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
  }, [isDirty, saving, title, buildContent, onSave, artifact.id, coeditSave]);

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

  // -- column mutations -----------------------------------------------------

  const addColumn = () => {
    setColumns((prev) => [
      ...prev,
      { id: genBoardId("col"), title: `Column ${prev.length + 1}` },
    ]);
  };

  const updateColumnTitle = (columnId: string, nextTitle: string) => {
    setColumns((prev) =>
      prev.map((c) => (c.id === columnId ? { ...c, title: nextTitle } : c)),
    );
  };

  const handleMoveColumn = (columnId: string, delta: -1 | 1) => {
    setColumns((prev) => moveColumn(prev, prev.findIndex((c) => c.id === columnId), delta));
  };

  const confirmDeleteColumn = () => {
    const columnId = pendingColumnDelete;
    setPendingColumnDelete(null);
    if (!columnId) return;
    // Cards are removed with their column so no orphan card (a card whose
    // columnId has no column) is ever sent to the API, which rejects those.
    setColumns((prev) => prev.filter((c) => c.id !== columnId));
    setCards((prev) => prev.filter((card) => card.columnId !== columnId));
  };

  // -- card mutations -------------------------------------------------------

  const addCard = (columnId: string) => {
    setCards((prev) => [
      ...prev,
      {
        id: genBoardId("card"),
        columnId,
        title: "",
        order: cardsInColumn(prev, columnId).length,
      },
    ]);
  };

  const updateCardTitle = (cardId: string, nextTitle: string) => {
    setCards((prev) =>
      prev.map((c) => (c.id === cardId ? { ...c, title: nextTitle } : c)),
    );
  };

  const updateCardNotes = (cardId: string, notes: string) => {
    setCards((prev) =>
      prev.map((c) => {
        if (c.id !== cardId) return c;
        const rest = { ...(c.payload ?? {}) };
        if (notes === "") {
          delete rest.description;
          return Object.keys(rest).length === 0
            ? { id: c.id, columnId: c.columnId, title: c.title, order: c.order }
            : { ...c, payload: rest };
        }
        return { ...c, payload: { ...rest, description: notes } };
      }),
    );
  };

  const handleShiftCard = (cardId: string, delta: -1 | 1) => {
    setCards((prev) => shiftCard(prev, columns, cardId, delta));
  };

  const handleMoveCardToColumn = (cardId: string, columnId: string) => {
    setCards((prev) => moveCard(prev, columns, cardId, columnId));
  };

  const deleteCard = (cardId: string) => {
    setCards((prev) => normalizeBoard({ columns, cards: prev.filter((c) => c.id !== cardId) }).cards);
  };

  // -- drag and drop --------------------------------------------------------

  const dropOnColumn = (columnId: string) => {
    const state = drag.current;
    drag.current = null;
    if (!state) return;
    if (state.kind === "column") {
      setColumns((prev) => reorderColumns(prev, state.columnId, columnId));
    } else {
      setCards((prev) => moveCard(prev, columns, state.cardId, columnId));
    }
  };

  const dropOnCard = (targetCardId: string) => {
    const state = drag.current;
    drag.current = null;
    if (!state || state.kind !== "card" || state.cardId === targetCardId) return;
    const target = cards.find((c) => c.id === targetCardId);
    if (!target) return;
    const targetIndex = cardsInColumn(cards, target.columnId).findIndex(
      (c) => c.id === targetCardId,
    );
    setCards((prev) => moveCard(prev, columns, state.cardId, target.columnId, targetIndex));
  };

  const isEmpty = columns.length === 0 && cards.length === 0 && !isDirty;
  const pendingColumn = columns.find((c) => c.id === pendingColumnDelete);
  const pendingCardCount = pendingColumnDelete
    ? cardsInColumn(cards, pendingColumnDelete).length
    : 0;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled board"
          aria-label="Board title"
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
          onClick={addColumn}
        >
          Column
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

      {/* Board surface */}
      <div className="flex-1 overflow-auto p-4">
        {isEmpty ? (
          <div
            className="flex h-full items-center justify-center text-text-secondary"
            data-testid="board-empty-state"
          >
            <div className="text-center">
              <p className="text-sm">This board is empty.</p>
              <p className="mt-1 text-xs text-text-secondary/60">
                Add a column to start organizing cards.
              </p>
              <div className="mt-3 flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="h-3 w-3" />}
                  onClick={addColumn}
                >
                  Add Column
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-start gap-3" data-testid="board-columns">
            {columns.map((column, index) => (
              <BoardColumn
                key={column.id}
                column={column}
                index={index}
                columnCount={columns.length}
                columns={columns}
                cards={cards}
                onTitleChange={(next) => updateColumnTitle(column.id, next)}
                onMoveColumn={(delta) => handleMoveColumn(column.id, delta)}
                onDeleteColumn={() => setPendingColumnDelete(column.id)}
                onAddCard={() => addCard(column.id)}
                onCardTitleChange={updateCardTitle}
                onCardNotesChange={updateCardNotes}
                onShiftCard={handleShiftCard}
                onMoveCardToColumn={handleMoveCardToColumn}
                onDeleteCard={deleteCard}
                onColumnDragStart={() => {
                  drag.current = { kind: "column", columnId: column.id };
                }}
                onColumnDrop={() => {
                  if (drag.current?.kind === "column") dropOnColumn(column.id);
                }}
                onCardDragStart={(cardId) => {
                  drag.current = { kind: "card", cardId };
                }}
                onCardDropOnCard={dropOnCard}
                onCardDropOnColumn={() => {
                  if (drag.current?.kind === "card") dropOnColumn(column.id);
                }}
              />
            ))}
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="h-3 w-3" />}
              onClick={addColumn}
              aria-label="Add column"
              className="shrink-0"
            >
              Column
            </Button>
          </div>
        )}
      </div>

      {isDirty && (
        <div className="shrink-0 border-t border-white/[0.04] px-4 py-1.5 text-xs text-text-secondary">
          Unsaved changes — press Ctrl/Cmd+S to save
        </div>
      )}

      {/* Column deletion needs an explicit confirmation because it removes the
          column's cards as well (the API rejects orphan cards). */}
      <Modal
        open={pendingColumnDelete !== null}
        onClose={() => setPendingColumnDelete(null)}
        title="Delete column"
      >
        <p className="text-sm text-text-secondary">
          {pendingCardCount > 0 ? (
            <>
              Deleting <strong className="text-text-primary">
                {pendingColumn?.title || "this column"}
              </strong>{" "}
              also deletes its {pendingCardCount}{" "}
              {pendingCardCount === 1 ? "card" : "cards"}. Cards cannot exist
              without a column.
            </>
          ) : (
            <>
              Delete{" "}
              <strong className="text-text-primary">
                {pendingColumn?.title || "this column"}
              </strong>
              ?
            </>
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setPendingColumnDelete(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={confirmDeleteColumn}
            aria-label="Confirm delete column and its cards"
          >
            Delete column
          </Button>
        </div>
      </Modal>
    </div>
  );
}
