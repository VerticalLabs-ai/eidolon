import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  GripVertical,
  Plus,
  Trash2,
} from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/Button";
import { cardsInColumn, type BoardCard, type BoardColumn as BoardColumnModel } from "./board-content";

interface BoardColumnProps {
  column: BoardColumnModel;
  index: number;
  columnCount: number;
  columns: BoardColumnModel[];
  cards: BoardCard[];
  onTitleChange: (title: string) => void;
  onMoveColumn: (delta: -1 | 1) => void;
  onDeleteColumn: () => void;
  onAddCard: () => void;
  onCardTitleChange: (cardId: string, title: string) => void;
  onCardNotesChange: (cardId: string, notes: string) => void;
  onShiftCard: (cardId: string, delta: -1 | 1) => void;
  onMoveCardToColumn: (cardId: string, columnId: string) => void;
  onDeleteCard: (cardId: string) => void;
  /** Column drag-and-drop */
  onColumnDragStart: () => void;
  onColumnDrop: () => void;
  /** Card drag-and-drop */
  onCardDragStart: (cardId: string) => void;
  onCardDropOnCard: (targetCardId: string) => void;
  onCardDropOnColumn: () => void;
}

export function BoardColumn({
  column,
  index,
  columnCount,
  columns,
  cards,
  onTitleChange,
  onMoveColumn,
  onDeleteColumn,
  onAddCard,
  onCardTitleChange,
  onCardNotesChange,
  onShiftCard,
  onMoveCardToColumn,
  onDeleteCard,
  onColumnDragStart,
  onColumnDrop,
  onCardDragStart,
  onCardDropOnCard,
  onCardDropOnColumn,
}: BoardColumnProps) {
  const [dropActive, setDropActive] = useState(false);
  const columnCards = cardsInColumn(cards, column.id);

  return (
    <section
      aria-label={`Column ${column.title || "Untitled"}`}
      data-board-column-id={column.id}
      onDragOver={(e) => {
        e.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDropActive(false);
        onColumnDrop();
        onCardDropOnColumn();
      }}
      className={clsx(
        "flex w-[280px] shrink-0 flex-col rounded-xl border bg-surface/60 transition-colors",
        dropActive ? "border-accent/40 bg-accent/[0.04]" : "border-white/[0.06]",
      )}
    >
      {/* Column header */}
      <header className="flex items-center gap-1 border-b border-white/[0.06] px-2 py-2">
        <span
          draggable
          onDragStart={onColumnDragStart}
          aria-hidden="true"
          className="cursor-grab text-text-secondary/60"
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <input
          value={column.title}
          onChange={(e) => onTitleChange(e.target.value)}
          placeholder="Untitled column"
          aria-label={`Column ${index + 1} title`}
          className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-text-primary font-display placeholder:text-text-secondary/40 rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
        />
        <span className="shrink-0 rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-text-secondary tabular-nums">
          {columnCards.length}
        </span>
        <button
          onClick={() => onMoveColumn(-1)}
          disabled={index === 0}
          aria-label={`Move column ${column.title || index + 1} left`}
          className="shrink-0 rounded text-text-secondary transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => onMoveColumn(1)}
          disabled={index === columnCount - 1}
          aria-label={`Move column ${column.title || index + 1} right`}
          className="shrink-0 rounded text-text-secondary transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onDeleteColumn}
          aria-label={`Delete column ${column.title || index + 1}`}
          className="shrink-0 rounded text-text-secondary transition-colors hover:text-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-error/40"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* Cards */}
      <ul className="flex-1 space-y-2 overflow-y-auto p-2" role="list">
        {columnCards.length === 0 && (
          <li className="rounded-lg border border-dashed border-white/[0.06] px-2 py-4 text-center text-[11px] text-text-secondary/70">
            No cards yet
          </li>
        )}
        {columnCards.map((card, cardIndex) => (
          <li
            key={card.id}
            draggable
            data-board-card-id={card.id}
            onDragStart={(e) => {
              e.stopPropagation();
              onCardDragStart(card.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onCardDropOnCard(card.id);
            }}
            onDragOver={(e) => e.preventDefault()}
            className="rounded-lg border border-white/[0.06] bg-surface px-2 py-2"
          >
            <div className="flex items-start gap-1">
              <span aria-hidden="true" className="mt-1 cursor-grab text-text-secondary/60">
                <GripVertical className="h-3 w-3" />
              </span>
              <input
                value={card.title}
                onChange={(e) => onCardTitleChange(card.id, e.target.value)}
                placeholder="Untitled card"
                aria-label={`Card title in ${column.title || `column ${index + 1}`}, position ${cardIndex + 1}`}
                className="min-w-0 flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-secondary/40 rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
              />
              <button
                onClick={() => onShiftCard(card.id, -1)}
                disabled={cardIndex === 0}
                aria-label={`Move card ${card.title || cardIndex + 1} up`}
                className="shrink-0 rounded text-text-secondary transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
              <button
                onClick={() => onShiftCard(card.id, 1)}
                disabled={cardIndex === columnCards.length - 1}
                aria-label={`Move card ${card.title || cardIndex + 1} down`}
                className="shrink-0 rounded text-text-secondary transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-text-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
              <button
                onClick={() => onDeleteCard(card.id)}
                aria-label={`Delete card ${card.title || cardIndex + 1}`}
                className="shrink-0 rounded text-text-secondary transition-colors hover:text-error focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-error/40"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>

            <textarea
              value={
                typeof card.payload?.description === "string"
                  ? card.payload.description
                  : ""
              }
              onChange={(e) => onCardNotesChange(card.id, e.target.value)}
              rows={2}
              placeholder="Notes (optional)"
              aria-label={`Card ${card.title || cardIndex + 1} notes`}
              className="mt-1.5 w-full resize-none rounded border border-white/[0.06] bg-black/20 px-1.5 py-1 text-[11px] text-text-secondary placeholder:text-text-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />

            {columns.length > 1 && (
              <label className="mt-1.5 flex items-center gap-1.5 text-[10px] text-text-secondary">
                <span className="shrink-0">Column</span>
                <select
                  value={card.columnId}
                  onChange={(e) => onMoveCardToColumn(card.id, e.target.value)}
                  aria-label={`Move card ${card.title || cardIndex + 1} to another column`}
                  className="min-w-0 flex-1 rounded border border-white/[0.06] bg-surface px-1 py-0.5 text-[10px] text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title || "Untitled column"}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </li>
        ))}
      </ul>

      <footer className="border-t border-white/[0.06] p-1.5">
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="h-3 w-3" />}
          onClick={onAddCard}
          aria-label={`Add card to ${column.title || `column ${index + 1}`}`}
          className="w-full justify-center"
        >
          Card
        </Button>
      </footer>
    </section>
  );
}
