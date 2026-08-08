/**
 * Co-editing operation types and WS message protocol (M3).
 *
 * The co-editing model is **server-authoritative operation-based**: clients
 * send granular operations (insert/delete for docs, setCell/addRow for
 * sheets, moveCard/addCard for boards) over the WebSocket bus. The server
 * applies them in arrival order to an in-memory canonical state per
 * artifact, broadcasts the applied op to all session clients, and flushes
 * the merged state to the DB as a single versioned revision on save.
 *
 * This supersedes the M1 last-write-wins 409 for live co-editors —
 * operations merge instead of rejecting. The 409 path remains for stale
 * single-client writes (no active session).
 */

// ---------------------------------------------------------------------------
// Document (markdown body string) operations
// ---------------------------------------------------------------------------

export interface DocInsertOp {
  kind: 'doc.insert';
  position: number;
  text: string;
  opId: string;
}

export interface DocDeleteOp {
  kind: 'doc.delete';
  position: number;
  length: number;
  opId: string;
}

export type DocOp = DocInsertOp | DocDeleteOp;

// ---------------------------------------------------------------------------
// Sheet operations
// ---------------------------------------------------------------------------

export interface SheetSetCellOp {
  kind: 'sheet.setCell';
  rowId: string;
  colKey: string;
  value: string | number | boolean | null;
  formula?: string;
  opId: string;
}

export interface SheetAddRowOp {
  kind: 'sheet.addRow';
  row: { id: string; cells: Record<string, { value: string | number | boolean | null; formula?: string }> };
  opId: string;
}

export interface SheetDeleteRowOp {
  kind: 'sheet.deleteRow';
  rowId: string;
  opId: string;
}

export interface SheetAddColumnOp {
  kind: 'sheet.addColumn';
  column: { id: string; key: string; width?: number };
  opId: string;
}

export interface SheetDeleteColumnOp {
  kind: 'sheet.deleteColumn';
  colKey: string;
  opId: string;
}

export type SheetOp =
  | SheetSetCellOp
  | SheetAddRowOp
  | SheetDeleteRowOp
  | SheetAddColumnOp
  | SheetDeleteColumnOp;

// ---------------------------------------------------------------------------
// Board operations
// ---------------------------------------------------------------------------

export interface BoardMoveCardOp {
  kind: 'board.moveCard';
  cardId: string;
  columnId: string;
  order: number;
  opId: string;
}

export interface BoardAddCardOp {
  kind: 'board.addCard';
  card: { id: string; columnId: string; title: string; order: number; payload?: Record<string, unknown> };
  opId: string;
}

export interface BoardEditCardOp {
  kind: 'board.editCard';
  cardId: string;
  title: string;
  opId: string;
}

export interface BoardDeleteCardOp {
  kind: 'board.deleteCard';
  cardId: string;
  opId: string;
}

export interface BoardAddColumnOp {
  kind: 'board.addColumn';
  column: { id: string; title: string };
  opId: string;
}

export interface BoardEditColumnOp {
  kind: 'board.editColumn';
  columnId: string;
  title: string;
  opId: string;
}

export interface BoardDeleteColumnOp {
  kind: 'board.deleteColumn';
  columnId: string;
  opId: string;
}

export type BoardOp =
  | BoardMoveCardOp
  | BoardAddCardOp
  | BoardEditCardOp
  | BoardDeleteCardOp
  | BoardAddColumnOp
  | BoardEditColumnOp
  | BoardDeleteColumnOp;

// ---------------------------------------------------------------------------
// Union of all operations
// ---------------------------------------------------------------------------

export type CoEditOp = DocOp | SheetOp | BoardOp;

// ---------------------------------------------------------------------------
// Cursor / selection
// ---------------------------------------------------------------------------

export interface CoEditCursor {
  artifactId: string;
  userId: string;
  name: string;
  color: string;
  /** Doc: character position. Sheet: {rowId, colKey}. Board: {cardId} | null. */
  position: number | { rowId: string; colKey: string } | { cardId: string } | null;
}

export interface CoEditSelection {
  artifactId: string;
  userId: string;
  name: string;
  color: string;
  /** Doc: {start, end} character positions. Sheet/Board: null (not used). */
  range: { start: number; end: number } | null;
}

// ---------------------------------------------------------------------------
// WS message protocol (client → server)
// ---------------------------------------------------------------------------

export interface CoEditJoinMsg {
  type: 'coedit.join';
  artifactId: string;
  companyId: string;
  userId: string;
  name: string;
  color?: string;
}

export interface CoEditOpMsg {
  type: 'coedit.op';
  artifactId: string;
  companyId: string;
  userId: string;
  op: CoEditOp;
}

export interface CoEditCursorMsg {
  type: 'coedit.cursor';
  artifactId: string;
  companyId: string;
  userId: string;
  name: string;
  color?: string;
  position: CoEditCursor['position'];
}

export interface CoEditSelectionMsg {
  type: 'coedit.selection';
  artifactId: string;
  companyId: string;
  userId: string;
  name: string;
  color?: string;
  range: CoEditSelection['range'];
}

export interface CoEditSaveMsg {
  type: 'coedit.save';
  artifactId: string;
  companyId: string;
  userId: string;
}

export interface CoEditLeaveMsg {
  type: 'coedit.leave';
  artifactId: string;
  companyId: string;
  userId: string;
}

export type CoEditClientMsg =
  | CoEditJoinMsg
  | CoEditOpMsg
  | CoEditCursorMsg
  | CoEditSelectionMsg
  | CoEditSaveMsg
  | CoEditLeaveMsg;

// ---------------------------------------------------------------------------
// WS message protocol (server → client)
// ---------------------------------------------------------------------------

export interface CoEditJoinedMsg {
  type: 'coedit.joined';
  artifactId: string;
  content: Record<string, unknown>;
  version: number;
  /** Current participants (excluding self). */
  participants: { userId: string; name: string; color: string }[];
}

export interface CoEditOpBroadcastMsg {
  type: 'coedit.op.broadcast';
  artifactId: string;
  op: CoEditOp;
  userId: string;
}

export interface CoEditOpAckMsg {
  type: 'coedit.op.ack';
  artifactId: string;
  opId: string;
  version: number;
}

export interface CoEditCursorBroadcastMsg {
  type: 'coedit.cursor.broadcast';
  artifactId: string;
  userId: string;
  name: string;
  color: string;
  position: CoEditCursor['position'];
}

export interface CoEditSelectionBroadcastMsg {
  type: 'coedit.selection.broadcast';
  artifactId: string;
  userId: string;
  name: string;
  color: string;
  range: CoEditSelection['range'];
}

export interface CoEditSavedMsg {
  type: 'coedit.saved';
  artifactId: string;
  version: number;
  content: Record<string, unknown>;
}

export interface CoEditUserLeftMsg {
  type: 'coedit.user.left';
  artifactId: string;
  userId: string;
}

export interface CoEditStateMsg {
  type: 'coedit.state';
  artifactId: string;
  content: Record<string, unknown>;
  version: number;
}

export interface CoEditErrorMsg {
  type: 'coedit.error';
  artifactId?: string;
  message: string;
}

export type CoEditServerMsg =
  | CoEditJoinedMsg
  | CoEditOpBroadcastMsg
  | CoEditOpAckMsg
  | CoEditCursorBroadcastMsg
  | CoEditSelectionBroadcastMsg
  | CoEditSavedMsg
  | CoEditUserLeftMsg
  | CoEditStateMsg
  | CoEditErrorMsg;

// ---------------------------------------------------------------------------
// Color palette for per-user cursors
// ---------------------------------------------------------------------------

export const CURSOR_COLORS = [
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#ef4444', // red
  '#14b8a6', // teal
  '#f97316', // orange
];

export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}
