// ---------------------------------------------------------------------------
// Board artifact content helpers
// ---------------------------------------------------------------------------
//
// Pure parse/build/mutate helpers for the freeform Kanban board artifact
// (`type: "board"`). Kept separate from the editor component so the ordering
// and orphan-prevention rules live in one place.
//
// Server-side shape (packages/shared BoardContentSchema):
//   { columns: [{ id, title }], cards: [{ id, columnId, title, order, payload? }] }
// Card ids and column ids must be unique, and every card.columnId must match
// an existing column id — the API returns 400 otherwise.
// ---------------------------------------------------------------------------

export interface BoardColumn {
  id: string;
  title: string;
}

export interface BoardCard {
  id: string;
  columnId: string;
  title: string;
  order: number;
  payload?: Record<string, unknown>;
}

export interface BoardContent {
  columns: BoardColumn[];
  cards: BoardCard[];
}

export function parseBoard(content: Record<string, unknown>): BoardContent {
  const columns = Array.isArray(content.columns)
    ? (content.columns as BoardColumn[])
    : [];
  const cards = Array.isArray(content.cards)
    ? (content.cards as BoardCard[])
    : [];
  return { columns, cards };
}

export function genBoardId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Cards belonging to a column, sorted by their persisted order. */
export function cardsInColumn(cards: BoardCard[], columnId: string): BoardCard[] {
  return cards
    .filter((card) => card.columnId === columnId)
    .sort((a, b) => a.order - b.order);
}

/**
 * Rewrites every card's `order` to its 0-based index within its column so the
 * saved order reproduces the on-screen order exactly after a reload. Because it
 * only emits cards found under a surviving column, a card whose column was
 * removed is dropped rather than saved as an orphan (which the API rejects).
 */
export function normalizeBoard(content: BoardContent): BoardContent {
  const cards: BoardCard[] = [];
  for (const column of content.columns) {
    cardsInColumn(content.cards, column.id).forEach((card, index) => {
      cards.push({
        id: card.id,
        columnId: column.id,
        title: card.title,
        order: index,
        ...(card.payload !== undefined ? { payload: card.payload } : {}),
      });
    });
  }
  return { columns: content.columns.map((c) => ({ id: c.id, title: c.title })), cards };
}

/**
 * Stable string form of a board, used to compare local, baseline, and remote
 * states. Normalizing first means cosmetic differences (card `order` gaps,
 * card array ordering) do not register as changes.
 */
export function serializeBoard(content: BoardContent): string {
  return JSON.stringify(normalizeBoard(content));
}

/** Moves the column at `index` one slot left (-1) or right (+1). */
export function moveColumn(
  columns: BoardColumn[],
  index: number,
  delta: -1 | 1,
): BoardColumn[] {
  const target = index + delta;
  if (index < 0 || index >= columns.length || target < 0 || target >= columns.length) {
    return columns;
  }
  const next = [...columns];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Reorders `columns` so the dragged column lands at the target column's slot. */
export function reorderColumns(
  columns: BoardColumn[],
  draggedId: string,
  targetId: string,
): BoardColumn[] {
  const from = columns.findIndex((c) => c.id === draggedId);
  const to = columns.findIndex((c) => c.id === targetId);
  if (from === -1 || to === -1 || from === to) return columns;
  const next = [...columns];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Places `cardId` into `toColumnId` at `toIndex` (append when `toIndex` is
 * undefined or out of range), renumbering the affected columns.
 */
export function moveCard(
  cards: BoardCard[],
  columns: BoardColumn[],
  cardId: string,
  toColumnId: string,
  toIndex?: number,
): BoardCard[] {
  const card = cards.find((c) => c.id === cardId);
  if (!card || !columns.some((column) => column.id === toColumnId)) return cards;

  const remaining = cards.filter((c) => c.id !== cardId);
  const destination = cardsInColumn(remaining, toColumnId);
  const insertAt =
    toIndex === undefined || toIndex < 0 || toIndex > destination.length
      ? destination.length
      : toIndex;
  destination.splice(insertAt, 0, { ...card, columnId: toColumnId });

  const others = remaining.filter((c) => c.columnId !== toColumnId);
  return normalizeBoard({
    columns,
    cards: [...others, ...destination.map((c, i) => ({ ...c, order: i }))],
  }).cards;
}

/** Shifts a card up (-1) or down (+1) within its own column. */
export function shiftCard(
  cards: BoardCard[],
  columns: BoardColumn[],
  cardId: string,
  delta: -1 | 1,
): BoardCard[] {
  const card = cards.find((c) => c.id === cardId);
  if (!card) return cards;
  const siblings = cardsInColumn(cards, card.columnId);
  const index = siblings.findIndex((c) => c.id === cardId);
  const target = index + delta;
  if (target < 0 || target >= siblings.length) return cards;
  return moveCard(cards, columns, cardId, card.columnId, target);
}
