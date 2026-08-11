/**
 * Pure co-editing operation logic — shared between server and UI.
 *
 * These functions have no side effects and no DB/server dependencies. They
 * apply operations to content objects immutably and compute diffs for
 * content → operation conversion.
 */

import type { CoEditOp, DocOp, SheetOp, BoardOp } from './types/coedit.js';

// ---------------------------------------------------------------------------
// Co-editable artifact types
// ---------------------------------------------------------------------------

/**
 * Artifact types that support server-authoritative, operation-based
 * co-editing (they have granular `applyOp`/`diffContent` handlers).
 *
 * M5 types (gallery, dashboard, app) and other non-listed types
 * (slide_deck, timeline, code) do NOT support op-based co-editing. They
 * save via the standard last-write-wins REST PATCH path. Creating a co-edit
 * session for them would cause `mergeExternalUpdate` to produce empty ops
 * (diffContent has no handler) and silently discard content changes while
 * the version still increments.
 */
export const COEDITABLE_TYPES = ['document', 'sheet', 'board'] as const;

/** Returns true if the artifact type supports op-based co-editing. */
export function isCoEditableType(artifactType: string): boolean {
  return (COEDITABLE_TYPES as readonly string[]).includes(artifactType);
}

// ---------------------------------------------------------------------------
// Apply a single operation
// ---------------------------------------------------------------------------

export function applyOp(
  artifactType: string,
  content: Record<string, unknown>,
  op: CoEditOp,
): Record<string, unknown> {
  switch (artifactType) {
    case 'document':
      return applyDocOp(content, op as DocOp);
    case 'sheet':
      return applySheetOp(content, op as SheetOp);
    case 'board':
      return applyBoardOp(content, op as BoardOp);
    default:
      return content;
  }
}

export function applyOps(
  artifactType: string,
  content: Record<string, unknown>,
  ops: CoEditOp[],
): Record<string, unknown> {
  let result = content;
  for (const op of ops) {
    result = applyOp(artifactType, result, op);
  }
  return result;
}

function applyDocOp(content: Record<string, unknown>, op: DocOp): Record<string, unknown> {
  const body = typeof content.body === 'string' ? content.body : '';
  const format = (content.format as string) ?? 'markdown';

  if (op.kind === 'doc.insert') {
    const pos = Math.max(0, Math.min(op.position, body.length));
    const newBody = body.slice(0, pos) + op.text + body.slice(pos);
    return { ...content, format, body: newBody };
  }

  if (op.kind === 'doc.delete') {
    const pos = Math.max(0, Math.min(op.position, body.length));
    const len = Math.max(0, Math.min(op.length, body.length - pos));
    const newBody = body.slice(0, pos) + body.slice(pos + len);
    return { ...content, format, body: newBody };
  }

  return content;
}

function applySheetOp(content: Record<string, unknown>, op: SheetOp): Record<string, unknown> {
  const columns = Array.isArray(content.columns) ? [...content.columns] : [];
  const rows = Array.isArray(content.rows) ? [...content.rows] : [];

  switch (op.kind) {
    case 'sheet.setCell': {
      const newRows = rows.map((row: any) => {
        if (row.id !== op.rowId) return row;
        const cells = { ...row.cells };
        cells[op.colKey] = { value: op.value, ...(op.formula !== undefined ? { formula: op.formula } : {}) };
        return { ...row, cells };
      });
      return { ...content, columns, rows: newRows };
    }
    case 'sheet.addRow': {
      if (rows.some((r: any) => r.id === op.row.id)) return content;
      return { ...content, columns, rows: [...rows, op.row] };
    }
    case 'sheet.deleteRow': {
      return { ...content, columns, rows: rows.filter((r: any) => r.id !== op.rowId) };
    }
    case 'sheet.addColumn': {
      if (columns.some((c: any) => c.id === op.column.id || c.key === op.column.key)) return content;
      return { ...content, columns: [...columns, op.column], rows };
    }
    case 'sheet.deleteColumn': {
      const newColumns = columns.filter((c: any) => c.key !== op.colKey);
      const newRows = rows.map((r: any) => {
        const cells = { ...r.cells };
        delete cells[op.colKey];
        return { ...r, cells };
      });
      return { ...content, columns: newColumns, rows: newRows };
    }
    default:
      return content;
  }
}

function applyBoardOp(content: Record<string, unknown>, op: BoardOp): Record<string, unknown> {
  const columns = Array.isArray(content.columns) ? [...content.columns] : [];
  const cards = Array.isArray(content.cards) ? [...content.cards] : [];

  switch (op.kind) {
    case 'board.moveCard': {
      const newCards = cards.map((c: any) =>
        c.id === op.cardId ? { ...c, columnId: op.columnId, order: op.order } : c,
      );
      return { ...content, columns, cards: newCards };
    }
    case 'board.addCard': {
      if (cards.some((c: any) => c.id === op.card.id)) return content;
      return { ...content, columns, cards: [...cards, op.card] };
    }
    case 'board.editCard': {
      const newCards = cards.map((c: any) =>
        c.id === op.cardId ? { ...c, title: op.title } : c,
      );
      return { ...content, columns, cards: newCards };
    }
    case 'board.deleteCard': {
      return { ...content, columns, cards: cards.filter((c: any) => c.id !== op.cardId) };
    }
    case 'board.addColumn': {
      if (columns.some((c: any) => c.id === op.column.id)) return content;
      return { ...content, columns: [...columns, op.column], cards };
    }
    case 'board.editColumn': {
      const newColumns = columns.map((c: any) =>
        c.id === op.columnId ? { ...c, title: op.title } : c,
      );
      return { ...content, columns: newColumns, cards };
    }
    case 'board.deleteColumn': {
      const newColumns = columns.filter((c: any) => c.id !== op.columnId);
      const newCards = cards.filter((c: any) => c.columnId !== op.columnId);
      return { ...content, columns: newColumns, cards: newCards };
    }
    default:
      return content;
  }
}

// ---------------------------------------------------------------------------
// Diff: compute ops that transform base → target
// ---------------------------------------------------------------------------

export function diffContent(
  artifactType: string,
  base: Record<string, unknown>,
  target: Record<string, unknown>,
): CoEditOp[] {
  switch (artifactType) {
    case 'document':
      return diffDoc(base, target);
    case 'sheet':
      return diffSheet(base, target);
    case 'board':
      return diffBoard(base, target);
    default:
      return [];
  }
}

let diffCounter = 0;
function diffOpId(): string {
  return `diff_${Date.now()}_${++diffCounter}`;
}

function diffDoc(base: Record<string, unknown>, target: Record<string, unknown>): DocOp[] {
  const oldBody = typeof base.body === 'string' ? base.body : '';
  const newBody = typeof target.body === 'string' ? target.body : '';
  if (oldBody === newBody) return [];

  const ops: DocOp[] = [];
  let prefix = 0;
  while (prefix < oldBody.length && prefix < newBody.length && oldBody[prefix] === newBody[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldBody.length - prefix &&
    suffix < newBody.length - prefix &&
    oldBody[oldBody.length - 1 - suffix] === newBody[newBody.length - 1 - suffix]
  ) {
    suffix++;
  }

  const deleteLen = oldBody.length - prefix - suffix;
  if (deleteLen > 0) {
    ops.push({ kind: 'doc.delete', position: prefix, length: deleteLen, opId: diffOpId() });
  }
  const insertText = newBody.slice(prefix, newBody.length - suffix);
  if (insertText.length > 0) {
    ops.push({ kind: 'doc.insert', position: prefix, text: insertText, opId: diffOpId() });
  }
  return ops;
}

function diffSheet(base: Record<string, unknown>, target: Record<string, unknown>): SheetOp[] {
  const oldCols = Array.isArray(base.columns) ? base.columns : [];
  const newCols = Array.isArray(target.columns) ? target.columns : [];
  const oldRows = Array.isArray(base.rows) ? base.rows : [];
  const newRows = Array.isArray(target.rows) ? target.rows : [];
  const ops: SheetOp[] = [];

  const oldColKeys = new Set(oldCols.map((c: any) => c.key));
  const newColKeys = new Set(newCols.map((c: any) => c.key));
  const oldRowIds = new Set(oldRows.map((r: any) => r.id));
  const newRowIds = new Set(newRows.map((r: any) => r.id));

  for (const col of newCols) {
    if (!oldColKeys.has((col as any).key)) {
      ops.push({ kind: 'sheet.addColumn', column: col as any, opId: diffOpId() });
    }
  }
  for (const key of oldColKeys) {
    if (!newColKeys.has(key)) {
      ops.push({ kind: 'sheet.deleteColumn', colKey: key, opId: diffOpId() });
    }
  }
  for (const row of newRows) {
    if (!oldRowIds.has((row as any).id)) {
      ops.push({ kind: 'sheet.addRow', row: row as any, opId: diffOpId() });
    }
  }
  for (const row of oldRows) {
    if (!newRowIds.has((row as any).id)) {
      ops.push({ kind: 'sheet.deleteRow', rowId: (row as any).id, opId: diffOpId() });
    }
  }

  const newRowsMap = new Map(newRows.map((r: any) => [r.id, r]));
  for (const oldRow of oldRows) {
    const newRow = newRowsMap.get((oldRow as any).id);
    if (!newRow) continue;
    const oldCells = (oldRow as any).cells ?? {};
    const newCells = (newRow as any).cells ?? {};
    for (const key of newColKeys) {
      if (!newColKeys.has(key)) continue;
      const oldCell = oldCells[key];
      const newCell = newCells[key];
      if (!oldCell && !newCell) continue;
      if (oldCell?.value !== newCell?.value || oldCell?.formula !== newCell?.formula) {
        ops.push({
          kind: 'sheet.setCell',
          rowId: (oldRow as any).id,
          colKey: key,
          value: newCell?.value ?? null,
          ...(newCell?.formula !== undefined ? { formula: newCell.formula } : {}),
          opId: diffOpId(),
        });
      }
    }
  }
  return ops;
}

function diffBoard(base: Record<string, unknown>, target: Record<string, unknown>): BoardOp[] {
  const oldCols = Array.isArray(base.columns) ? base.columns : [];
  const newCols = Array.isArray(target.columns) ? target.columns : [];
  const oldCards = Array.isArray(base.cards) ? base.cards : [];
  const newCards = Array.isArray(target.cards) ? target.cards : [];
  const ops: BoardOp[] = [];

  const oldColIds = new Set(oldCols.map((c: any) => c.id));
  const newColIds = new Set(newCols.map((c: any) => c.id));
  const oldCardIds = new Set(oldCards.map((c: any) => c.id));
  const newCardIds = new Set(newCards.map((c: any) => c.id));

  for (const col of newCols) {
    if (!oldColIds.has((col as any).id)) {
      ops.push({ kind: 'board.addColumn', column: col as any, opId: diffOpId() });
    }
  }
  const newColsMap = new Map(newCols.map((c: any) => [c.id, c]));
  for (const oldCol of oldCols) {
    const newCol = newColsMap.get((oldCol as any).id);
    if (newCol && (oldCol as any).title !== newCol.title) {
      ops.push({ kind: 'board.editColumn', columnId: (oldCol as any).id, title: newCol.title, opId: diffOpId() });
    }
  }
  for (const col of oldCols) {
    if (!newColIds.has((col as any).id)) {
      ops.push({ kind: 'board.deleteColumn', columnId: (col as any).id, opId: diffOpId() });
    }
  }
  for (const card of newCards) {
    if (!oldCardIds.has((card as any).id)) {
      ops.push({ kind: 'board.addCard', card: card as any, opId: diffOpId() });
    }
  }
  const newCardsMap = new Map(newCards.map((c: any) => [c.id, c]));
  for (const oldCard of oldCards) {
    const newCard = newCardsMap.get((oldCard as any).id);
    if (!newCard) continue;
    if ((oldCard as any).title !== newCard.title) {
      ops.push({ kind: 'board.editCard', cardId: (oldCard as any).id, title: newCard.title, opId: diffOpId() });
    }
    if ((oldCard as any).columnId !== newCard.columnId || (oldCard as any).order !== newCard.order) {
      ops.push({ kind: 'board.moveCard', cardId: (oldCard as any).id, columnId: newCard.columnId, order: newCard.order, opId: diffOpId() });
    }
  }
  for (const card of oldCards) {
    if (!newCardIds.has((card as any).id)) {
      ops.push({ kind: 'board.deleteCard', cardId: (card as any).id, opId: diffOpId() });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Doc text diff: compute insert/delete ops from old → new string
// ---------------------------------------------------------------------------

export function diffDocText(oldText: string, newText: string, opIdPrefix: string): DocOp[] {
  if (oldText === newText) return [];
  const ops: DocOp[] = [];
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const deleteLen = oldText.length - prefix - suffix;
  if (deleteLen > 0) {
    ops.push({ kind: 'doc.delete', position: prefix, length: deleteLen, opId: `${opIdPrefix}_d` });
  }
  const insertText = newText.slice(prefix, newText.length - suffix);
  if (insertText.length > 0) {
    ops.push({ kind: 'doc.insert', position: prefix, text: insertText, opId: `${opIdPrefix}_i` });
  }
  return ops;
}
