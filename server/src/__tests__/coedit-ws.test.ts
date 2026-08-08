import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createTestServer, createTestDb } from '../test-utils.js';
import { setupWebSocketServer } from '../realtime/ws-server.js';
import { __resetCoEditSessions } from '../realtime/coedit-session.js';
import type { DbInstance } from '../types.js';
import type { CoEditOp } from '@eidolon/shared';

// ---------------------------------------------------------------------------
// Helpers (adapted from artifacts-ws.test.ts)
// ---------------------------------------------------------------------------

function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const onOpen = () => { ws.off('error', onError); resolve(ws); };
    const onError = (err: unknown) => { ws.off('open', onOpen); reject(err); };
    ws.once('open', onOpen);
    ws.once('error', onError);
  });
}

function subscribe(ws: WebSocket, companyId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subscribe ack timeout')), 3000);
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as { type: string; companyId?: string };
      if (msg.type === 'subscribed' && msg.companyId === companyId) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve();
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'subscribe', companyId }));
  });
}

function sendWs(ws: WebSocket, msg: Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

/** Collect messages until predicate returns true or timeout. */
function collectUntil(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeout = 3000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const out: Record<string, unknown>[] = [];
    const timer = setTimeout(() => { ws.off('message', onMessage); resolve(out); }, timeout);
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      out.push(msg);
      if (predicate(msg)) { clearTimeout(timer); ws.off('message', onMessage); resolve(out); }
    };
    ws.on('message', onMessage);
  });
}

/** Collect ALL messages for a duration (no early termination). */
function collectFor(ws: WebSocket, ms = 500): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const out: Record<string, unknown>[] = [];
    const onMessage = (raw: unknown) => { out.push(JSON.parse(String(raw))); };
    ws.on('message', onMessage);
    setTimeout(() => { ws.off('message', onMessage); resolve(out); }, ms);
  });
}

/** Wait for a specific coedit message type. */
function waitForCoEdit(
  ws: WebSocket,
  type: string,
  timeout = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timeout waiting for ${type}`));
    }, timeout);
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      if (msg.type === type) { clearTimeout(timer); ws.off('message', onMessage); resolve(msg); }
    };
    ws.on('message', onMessage);
  });
}

function closeWs(ws: WebSocket | null): Promise<void> {
  if (!ws) return Promise.resolve();
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

function genOpId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Co-editing WebSocket — real WS clients', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let port: number;
  let companyId: string;
  let projectId: string;
  let wss: ReturnType<typeof setupWebSocketServer> | null = null;
  let wsA: WebSocket | null = null;
  let wsB: WebSocket | null = null;
  let wsC: WebSocket | null = null;

  beforeEach(async () => {
    __resetCoEditSessions();
    db = await createTestDb();
    app = await createTestServer(db);
    port = (app.address() as { port: number }).port;
    wss = setupWebSocketServer(app, { db });

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ CoEdit Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'CoEdit Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;
  });

  afterEach(async () => {
    await closeWs(wsA); await closeWs(wsB); await closeWs(wsC);
    wsA = null; wsB = null; wsC = null;
    wss?.close(); wss = null;
  });

  // ── Helpers ──────────────────────────────────────────────────────────

  async function createDoc(body = '# Hello'): Promise<{ id: string; version: number }> {
    const res = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({ type: 'document', title: '__mtest__ CoEdit Doc', content: { format: 'markdown', body }, projectId })
      .expect(201);
    return res.body.data;
  }

  async function createSheet(content?: Record<string, unknown>): Promise<{ id: string; version: number }> {
    const c = content ?? {
      columns: [{ id: 'c1', key: 'name' }, { id: 'c2', key: 'role' }],
      rows: [{ id: 'r1', cells: { name: { value: 'Alice' }, role: { value: 'Engineer' } } }],
    };
    const res = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({ type: 'sheet', title: '__mtest__ CoEdit Sheet', content: c, projectId })
      .expect(201);
    return res.body.data;
  }

  async function createBoard(): Promise<{ id: string; version: number }> {
    const content = {
      columns: [
        { id: 'col_todo', title: 'Todo' },
        { id: 'col_progress', title: 'In Progress' },
        { id: 'col_done', title: 'Done' },
      ],
      cards: [
        { id: 'card_a', columnId: 'col_todo', title: 'Card A', order: 0 },
        { id: 'card_b', columnId: 'col_todo', title: 'Card B', order: 1 },
      ],
    };
    const res = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({ type: 'board', title: '__mtest__ CoEdit Board', content, projectId })
      .expect(201);
    return res.body.data;
  }

  async function joinSession(ws: WebSocket, artifactId: string, userId: string, name: string): Promise<Record<string, unknown>> {
    sendWs(ws, { type: 'coedit.join', artifactId, companyId, userId, name });
    return waitForCoEdit(ws, 'coedit.joined');
  }

  // =========================================================================
  // A. VAL-COEDIT-001: Concurrent Doc edits merge live with no data loss
  // =========================================================================

  it('VAL-COEDIT-001: two clients append text — both edits present in merged state', async () => {
    const doc = await createDoc('# Hello');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    const joinedA = await joinSession(wsA, doc.id, 'user-a', 'Alice');
    const joinedB = await joinSession(wsB, doc.id, 'user-b', 'Bob');
    expect((joinedA as any).content.body).toBe('# Hello');
    expect((joinedB as any).content.body).toBe('# Hello');

    // Client A appends "AAA"
    const opA: CoEditOp = { kind: 'doc.insert', position: '# Hello'.length, text: '\n\nAAA', opId: genOpId() };
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: opA });

    // Wait for B to receive the broadcast
    const recvB = await waitForCoEdit(wsB, 'coedit.op.broadcast');
    expect((recvB as any).op.kind).toBe('doc.insert');
    expect((recvB as any).op.text).toBe('\n\nAAA');

    // Client B appends "BBB" after "AAA"
    const opB: CoEditOp = { kind: 'doc.insert', position: '# Hello\n\nAAA'.length, text: '\n\nBBB', opId: genOpId() };
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: opB });

    // Wait for A to receive the broadcast
    const recvA = await waitForCoEdit(wsA, 'coedit.op.broadcast');
    expect((recvA as any).op.text).toBe('\n\nBBB');

    // Trigger save and verify persisted content has both
    sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    expect(getRes.body.data.content.body).toBe('# Hello\n\nAAA\n\nBBB');
    expect(getRes.body.data.version).toBe(2);
  });

  // =========================================================================
  // B. VAL-COEDIT-002: Same region edits converge deterministically
  // =========================================================================

  it('VAL-COEDIT-002: both clients insert at same position — deterministic merge, no lost chars', async () => {
    const doc = await createDoc('Hello');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');

    // Both insert at position 2 (between 'He' and 'llo')
    const opA: CoEditOp = { kind: 'doc.insert', position: 2, text: 'X', opId: 'op-a-001' };
    const opB: CoEditOp = { kind: 'doc.insert', position: 2, text: 'Y', opId: 'op-b-001' };

    // A sends first, then B sends after receiving A's broadcast
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: opA });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');

    // B sends its op (B's local position is still 2, but the server will
    // apply it at position 2 in the current canonical state which now has X)
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: opB });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    const body = getRes.body.data.content.body as string;
    // Both X and Y are present (deterministic order based on server arrival)
    expect(body).toContain('X');
    expect(body).toContain('Y');
    expect(body.length).toBe(7); // 'He' + 'X' + 'Y' + 'llo' or 'He' + 'Y' + 'X' + 'llo'
    // The order is deterministic: A arrived first (X at pos 2 → "HeXllo"),
    // then B inserts Y at pos 2 → "HeYXllo" (Y goes before X). Both present.
    expect(body).toBe('HeYXllo');
  });

  // =========================================================================
  // C. VAL-COEDIT-003: No 409 on concurrent Doc edit
  // =========================================================================

  it('VAL-COEDIT-003: concurrent PATCHes through active session do not 409', async () => {
    const doc = await createDoc('# Hello');
    wsA = await openWs(port);
    await subscribe(wsA, companyId);
    await joinSession(wsA, doc.id, 'user-a', 'Alice');

    // Agent PATCH while session is active (simulates concurrent edit)
    const patchRes = await request(app)
      .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
      .send({ content: { format: 'markdown', body: '# Hello\n\nAgent edit' }, version: doc.version })
      .expect(200); // NOT 409 — merges through session

    expect(patchRes.body.data.content.body).toContain('Agent edit');

    // User also sends an op
    const opA: CoEditOp = { kind: 'doc.insert', position: '# Hello'.length, text: '\n\nUser edit', opId: genOpId() };
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: opA });
    await waitForCoEdit(wsA, 'coedit.op.ack');

    sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    const body = getRes.body.data.content.body as string;
    expect(body).toContain('Agent edit');
    expect(body).toContain('User edit');
  });

  // =========================================================================
  // D. VAL-COEDIT-004: Deleting/moving content concurrently merges without loss
  // =========================================================================

  it('VAL-COEDIT-004: concurrent delete + edit at different positions — both preserved', async () => {
    const doc = await createDoc('Para1\n\nPara2\n\nPara3');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');

    // A deletes "Para2\n\n" (from position 7, length 7)
    const delOp: CoEditOp = { kind: 'doc.delete', position: 7, length: 7, opId: genOpId() };
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: delOp });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');

    // B edits Para3 (now at position 7 after deletion): replace "Para3" with "Para3 edited"
    // First delete "Para3" then insert "Para3 edited"
    const delP3: CoEditOp = { kind: 'doc.delete', position: 7, length: 5, opId: genOpId() };
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: delP3 });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    const insP3: CoEditOp = { kind: 'doc.insert', position: 7, text: 'Para3 edited', opId: genOpId() };
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: insP3 });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    const body = getRes.body.data.content.body as string;
    expect(body).toBe('Para1\n\nPara3 edited');
    expect(body).not.toContain('Para2');
    expect(body).toContain('Para3 edited');
  });

  // =========================================================================
  // E. VAL-COEDIT-005: Concurrent edits to different Sheet cells merge live
  // =========================================================================

  it('VAL-COEDIT-005: different sheet cells — both edits present', async () => {
    const sheet = await createSheet();
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, sheet.id, 'user-a', 'Alice');
    await joinSession(wsB, sheet.id, 'user-b', 'Bob');

    // A sets cell (r1, name) to "A1"
    const opA: CoEditOp = { kind: 'sheet.setCell', rowId: 'r1', colKey: 'name', value: 'A1', opId: genOpId() };
    sendWs(wsA, { type: 'coedit.op', artifactId: sheet.id, companyId, userId: 'user-a', op: opA });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');

    // B sets cell (r1, role) to "B2"
    const opB: CoEditOp = { kind: 'sheet.setCell', rowId: 'r1', colKey: 'role', value: 'B2', opId: genOpId() };
    sendWs(wsB, { type: 'coedit.op', artifactId: sheet.id, companyId, userId: 'user-b', op: opB });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: sheet.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${sheet.id}`);
    const rows = getRes.body.data.content.rows;
    expect(rows[0].cells.name.value).toBe('A1');
    expect(rows[0].cells.role.value).toBe('B2');
  });

  // =========================================================================
  // F. VAL-COEDIT-006: Same Sheet cell merge deterministically
  // =========================================================================

  it('VAL-COEDIT-006: same cell — deterministic last-arrival-wins', async () => {
    const sheet = await createSheet();
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, sheet.id, 'user-a', 'Alice');
    await joinSession(wsB, sheet.id, 'user-b', 'Bob');

    // Both set cell (r1, name) to different values
    const opA: CoEditOp = { kind: 'sheet.setCell', rowId: 'r1', colKey: 'name', value: 'AAA', opId: genOpId() };
    const opB: CoEditOp = { kind: 'sheet.setCell', rowId: 'r1', colKey: 'name', value: 'BBB', opId: genOpId() };

    // A first, then B — B wins (last-arrival)
    sendWs(wsA, { type: 'coedit.op', artifactId: sheet.id, companyId, userId: 'user-a', op: opA });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');
    sendWs(wsB, { type: 'coedit.op', artifactId: sheet.id, companyId, userId: 'user-b', op: opB });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: sheet.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${sheet.id}`);
    expect(getRes.body.data.content.rows[0].cells.name.value).toBe('BBB');
  });

  // =========================================================================
  // G. VAL-COEDIT-007: Sheet structural edits merge with cell edits
  // =========================================================================

  it('VAL-COEDIT-007: add row + edit cell — both preserved', async () => {
    const sheet = await createSheet();
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, sheet.id, 'user-a', 'Alice');
    await joinSession(wsB, sheet.id, 'user-b', 'Bob');

    // A adds a new row
    const opA: CoEditOp = {
      kind: 'sheet.addRow',
      row: { id: 'r2', cells: { name: { value: 'Bob' }, role: { value: 'Designer' } } },
      opId: genOpId(),
    };
    sendWs(wsA, { type: 'coedit.op', artifactId: sheet.id, companyId, userId: 'user-a', op: opA });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');

    // B edits cell (r1, name)
    const opB: CoEditOp = { kind: 'sheet.setCell', rowId: 'r1', colKey: 'name', value: 'Alicia', opId: genOpId() };
    sendWs(wsB, { type: 'coedit.op', artifactId: sheet.id, companyId, userId: 'user-b', op: opB });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: sheet.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${sheet.id}`);
    const rows = getRes.body.data.content.rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].cells.name.value).toBe('Alicia');
    expect(rows[1].id).toBe('r2');
    expect(rows[1].cells.name.value).toBe('Bob');
  });

  // =========================================================================
  // H. VAL-COEDIT-008: Concurrent card moves merge live on a Board
  // =========================================================================

  it('VAL-COEDIT-008: concurrent card moves — both cards in new columns', async () => {
    const board = await createBoard();
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, board.id, 'user-a', 'Alice');
    await joinSession(wsB, board.id, 'user-b', 'Bob');

    // A moves card_a to "In Progress"
    const opA: CoEditOp = { kind: 'board.moveCard', cardId: 'card_a', columnId: 'col_progress', order: 0, opId: genOpId() };
    sendWs(wsA, { type: 'coedit.op', artifactId: board.id, companyId, userId: 'user-a', op: opA });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');

    // B moves card_b to "Done"
    const opB: CoEditOp = { kind: 'board.moveCard', cardId: 'card_b', columnId: 'col_done', order: 0, opId: genOpId() };
    sendWs(wsB, { type: 'coedit.op', artifactId: board.id, companyId, userId: 'user-b', op: opB });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: board.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${board.id}`);
    const cards = getRes.body.data.content.cards;
    const cardA = cards.find((c: any) => c.id === 'card_a');
    const cardB = cards.find((c: any) => c.id === 'card_b');
    expect(cardA.columnId).toBe('col_progress');
    expect(cardB.columnId).toBe('col_done');
  });

  // =========================================================================
  // I. VAL-COEDIT-009: Concurrent card edits and column adds merge
  // =========================================================================

  it('VAL-COEDIT-009: add column + edit card title — both preserved', async () => {
    const board = await createBoard();
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, board.id, 'user-a', 'Alice');
    await joinSession(wsB, board.id, 'user-b', 'Bob');

    // A adds a new column
    const opA: CoEditOp = { kind: 'board.addColumn', column: { id: 'col_review', title: 'Review' }, opId: genOpId() };
    sendWs(wsA, { type: 'coedit.op', artifactId: board.id, companyId, userId: 'user-a', op: opA });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');

    // B edits card_a title
    const opB: CoEditOp = { kind: 'board.editCard', cardId: 'card_a', title: 'Card A (edited)', opId: genOpId() };
    sendWs(wsB, { type: 'coedit.op', artifactId: board.id, companyId, userId: 'user-b', op: opB });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: board.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${board.id}`);
    const cols = getRes.body.data.content.columns;
    const cards = getRes.body.data.content.cards;
    expect(cols.some((c: any) => c.id === 'col_review')).toBe(true);
    expect(cards.find((c: any) => c.id === 'card_a').title).toBe('Card A (edited)');
  });

  // =========================================================================
  // J. VAL-COEDIT-010/011/012/013: Live cursors / selections
  // =========================================================================

  it('VAL-COEDIT-010: cursor broadcast to other participants', async () => {
    const doc = await createDoc('# Hello');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');

    // B sends cursor position
    sendWs(wsB, { type: 'coedit.cursor', artifactId: doc.id, companyId, userId: 'user-b', name: 'Bob', position: 3 });

    const cursorMsg = await waitForCoEdit(wsA, 'coedit.cursor.broadcast');
    expect(cursorMsg.userId).toBe('user-b');
    expect(cursorMsg.position).toBe(3);
    expect(cursorMsg.name).toBe('Bob');
  });

  it('VAL-COEDIT-011: selection range broadcast to other participants', async () => {
    const doc = await createDoc('# Hello World');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');

    sendWs(wsB, { type: 'coedit.selection', artifactId: doc.id, companyId, userId: 'user-b', name: 'Bob', range: { start: 2, end: 7 } });

    const selMsg = await waitForCoEdit(wsA, 'coedit.selection.broadcast');
    expect(selMsg.userId).toBe('user-b');
    expect(selMsg.range).toEqual({ start: 2, end: 7 });
  });

  it('VAL-COEDIT-013: cursor clears on leave', async () => {
    const doc = await createDoc('# Hello');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');

    // B leaves
    sendWs(wsB, { type: 'coedit.leave', artifactId: doc.id, companyId, userId: 'user-b' });

    const leftMsg = await waitForCoEdit(wsA, 'coedit.user.left');
    expect(leftMsg.userId).toBe('user-b');
  });

  // =========================================================================
  // K. VAL-COEDIT-014/015: Single versioned revision on save
  // =========================================================================

  it('VAL-COEDIT-014: save produces exactly one new revision row with merged content', async () => {
    const doc = await createDoc('# Hello');
    const revsBefore = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}/revisions`);
    const countBefore = revsBefore.body.data.length;

    wsA = await openWs(port);
    await subscribe(wsA, companyId);
    await joinSession(wsA, doc.id, 'user-a', 'Alice');

    // Apply two ops
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: { kind: 'doc.insert', position: 7, text: ' World', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsA, 'coedit.op.ack');
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: { kind: 'doc.insert', position: 13, text: '!', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsA, 'coedit.op.ack');

    // Save (one flush)
    sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const revsAfter = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}/revisions`);
    expect(revsAfter.body.data.length).toBe(countBefore + 1); // exactly one new revision
    const latestRev = revsAfter.body.data[revsAfter.body.data.length - 1];
    expect(latestRev.content.body).toBe('# Hello World!');
    expect(latestRev.editSource).toBe('user');
  });

  it('VAL-COEDIT-015: both clients agree on versioned state after save', async () => {
    const doc = await createDoc('# Hello');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');

    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: { kind: 'doc.insert', position: 7, text: ' A', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: { kind: 'doc.insert', position: 9, text: ' B', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    // Set up both saved listeners BEFORE sending save to avoid timing issue
    const savedPromiseA = waitForCoEdit(wsA, 'coedit.saved');
    const savedPromiseB = waitForCoEdit(wsB, 'coedit.saved');
    sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
    const savedMsg = await savedPromiseA;
    await savedPromiseB;

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    expect(getRes.body.data.version).toBe(savedMsg.version);
    expect(getRes.body.data.content.body).toBe('# Hello A B');
  });

  // =========================================================================
  // L. VAL-COEDIT-016: Reconnect reconciles without clobbering
  // =========================================================================

  it('VAL-COEDIT-016: reconnect — client re-joins and gets current merged state', async () => {
    const doc = await createDoc('# Hello');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');

    // B edits
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: { kind: 'doc.insert', position: 6, text: ' B-edit', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    // B disconnects
    await closeWs(wsB);
    wsB = null;
    await waitForCoEdit(wsA, 'coedit.user.left');

    // A edits while B is disconnected
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: { kind: 'doc.insert', position: 6, text: ' A-edit', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsA, 'coedit.op.ack');

    // B reconnects and re-joins — should get current merged state
    wsB = await openWs(port);
    await subscribe(wsB, companyId);
    const rejoinMsg = await joinSession(wsB, doc.id, 'user-b', 'Bob');
    expect((rejoinMsg as any).content.body).toContain('A-edit');
    expect((rejoinMsg as any).content.body).toContain('B-edit');

    // No 409 — just the current state
    sendWs(wsB, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-b' });
    await waitForCoEdit(wsB, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    const body = getRes.body.data.content.body as string;
    expect(body).toContain('A-edit');
    expect(body).toContain('B-edit');
  });

  // =========================================================================
  // M. VAL-COEDIT-017: Late-arriving stale single-client edit does not silently overwrite
  // =========================================================================

  it('VAL-COEDIT-017: stale PATCH without active session returns 409 (not silent overwrite)', async () => {
    const doc = await createDoc('# Hello');

    // No active co-edit session — standard optimistic 409 applies
    // First update succeeds
    await request(app)
      .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
      .send({ content: { format: 'markdown', body: '# Hello v2' }, version: 1 })
      .expect(200);

    // Stale PATCH with old version → 409
    const staleRes = await request(app)
      .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
      .send({ content: { format: 'markdown', body: '# Hello stale' }, version: 1 })
      .expect(409);

    expect(staleRes.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
    // Verify the newer content is preserved
    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    expect(getRes.body.data.content.body).toBe('# Hello v2');
  });

  // =========================================================================
  // N. VAL-COEDIT-018: Revision history is append-only through co-editing
  // =========================================================================

  it('VAL-COEDIT-018: revision history is append-only through co-editing', async () => {
    const doc = await createDoc('# Hello');
    const revsBefore = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}/revisions`);
    const versionsBefore = revsBefore.body.data.map((r: any) => r.version);

    wsA = await openWs(port);
    await subscribe(wsA, companyId);
    await joinSession(wsA, doc.id, 'user-a', 'Alice');

    // Multiple save cycles
    for (let i = 0; i < 3; i++) {
      sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: { kind: 'doc.insert', position: 100, text: ` edit${i}`, opId: genOpId() } as CoEditOp });
      await waitForCoEdit(wsA, 'coedit.op.ack');
      sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
      await waitForCoEdit(wsA, 'coedit.saved');
    }

    const revsAfter = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}/revisions`);
    const versionsAfter = revsAfter.body.data.map((r: any) => r.version);

    // All original versions still present (append-only)
    for (const v of versionsBefore) {
      expect(versionsAfter).toContain(v);
    }
    // New versions are higher and monotonic
    expect(versionsAfter.length).toBeGreaterThan(versionsBefore.length);
    for (let i = 1; i < versionsAfter.length; i++) {
      expect(versionsAfter[i]).toBeGreaterThan(versionsAfter[i - 1]);
    }
  });

  // =========================================================================
  // O. VAL-COEDIT-019/020: Agent + user concurrent merge
  // =========================================================================

  it('VAL-COEDIT-019/020: agent PATCH merges with user edits — no 409', async () => {
    // Create an agent in the company first
    const agentRes = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'CoEdit Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    const agentId = agentRes.body.data.id;

    const doc = await createDoc('# Hello');
    wsA = await openWs(port);
    await subscribe(wsA, companyId);
    await joinSession(wsA, doc.id, 'user-a', 'Alice');

    // User sends an op (unsaved)
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: { kind: 'doc.insert', position: 7, text: '\n\nUser edit', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsA, 'coedit.op.ack');

    // Set up listener BEFORE the PATCH so we catch the broadcast
    const broadcastPromise = waitForCoEdit(wsA, 'coedit.op.broadcast');

    // Agent PATCHes the same doc (via REST with agent header)
    const agentPatchRes = await request(app)
      .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
      .set('X-Eidolon-Agent-Id', agentId)
      .send({ content: { format: 'markdown', body: '# Hello\n\nAgent added this' }, version: doc.version })
      .expect(200); // NOT 409 — merges through session

    // The user should receive the agent's ops as broadcasts
    await broadcastPromise;

    // Verify the merged content has both edits
    const body = agentPatchRes.body.data.content.body as string;
    expect(body).toContain('User edit');
    expect(body).toContain('Agent added this');

    // Verify revision has editSource=agent for the agent contribution
    const revsRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}/revisions`);
    const latestRev = revsRes.body.data[revsRes.body.data.length - 1];
    expect(latestRev.editSource).toBe('agent');
  });

  // =========================================================================
  // P. VAL-COEDIT-021: Three simultaneous editors converge
  // =========================================================================

  it('VAL-COEDIT-021: three editors each append text — all three present, identical state', async () => {
    const doc = await createDoc('Base');
    wsA = await openWs(port);
    wsB = await openWs(port);
    wsC = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);
    await subscribe(wsC, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');
    await joinSession(wsC, doc.id, 'user-c', 'Carol');

    // Each appends a distinct marker at the end
    // A appends "AAA"
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: { kind: 'doc.insert', position: 4, text: 'AAA', opId: 'op-aaa' } as CoEditOp });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');
    // B's local state still has 'Base' at position 4, but it receives A's op
    // B appends "BBB" after "AAA" (position 4 + 3 = 7 in canonical)
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: { kind: 'doc.insert', position: 7, text: 'BBB', opId: 'op-bbb' } as CoEditOp });
    await waitForCoEdit(wsC, 'coedit.op.broadcast');
    // C appends "CCC" after "BBB" (position 7 + 3 = 10 in canonical)
    sendWs(wsC, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-c', op: { kind: 'doc.insert', position: 10, text: 'CCC', opId: 'op-ccc' } as CoEditOp });
    // Let all broadcasts propagate
    await collectFor(wsA, 300);
    await collectFor(wsB, 300);

    sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    const body = getRes.body.data.content.body as string;
    expect(body).toContain('AAA');
    expect(body).toContain('BBB');
    expect(body).toContain('CCC');
    expect(body.length).toBe(13); // 'Base' + 'AAA' + 'BBB' + 'CCC' = 4 + 3 + 3 + 3
  });

  // =========================================================================
  // Q. VAL-COEDIT-022: Sheet with formulas merges without formula loss
  // =========================================================================

  it('VAL-COEDIT-022: formula preserved when another cell is edited concurrently', async () => {
    const sheet = await createSheet({
      columns: [
        { id: 'c1', key: 'a' }, { id: 'c2', key: 'b' }, { id: 'c3', key: 'sum' },
      ],
      rows: [
        { id: 'r1', cells: { a: { value: 10 }, b: { value: 20 }, sum: { value: 30, formula: '=SUM(r1a:r1b)' } } },
      ],
    });
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, sheet.id, 'user-a', 'Alice');
    await joinSession(wsB, sheet.id, 'user-b', 'Bob');

    // A sets cell (r1, a) to 100
    const opA: CoEditOp = { kind: 'sheet.setCell', rowId: 'r1', colKey: 'a', value: 100, opId: genOpId() };
    sendWs(wsA, { type: 'coedit.op', artifactId: sheet.id, companyId, userId: 'user-a', op: opA });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');

    // B sets cell (r1, sum) formula to a new formula
    const opB: CoEditOp = { kind: 'sheet.setCell', rowId: 'r1', colKey: 'sum', value: 120, formula: '=SUM(r1a:r1b)', opId: genOpId() };
    sendWs(wsB, { type: 'coedit.op', artifactId: sheet.id, companyId, userId: 'user-b', op: opB });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: sheet.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${sheet.id}`);
    const cells = getRes.body.data.content.rows[0].cells;
    expect(cells.a.value).toBe(100);
    expect(cells.sum.formula).toBe('=SUM(r1a:r1b)');
    expect(cells.sum.value).toBe(120);
  });

  // =========================================================================
  // R. VAL-COEDIT-024: Survives transient WS drop
  // =========================================================================

  it('VAL-COEDIT-024: WS drop + reconnect — client resyncs to current state', async () => {
    const doc = await createDoc('# Hello');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    await joinSession(wsA, doc.id, 'user-a', 'Alice');
    await joinSession(wsB, doc.id, 'user-b', 'Bob');

    // B edits while A is connected
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: { kind: 'doc.insert', position: 7, text: ' World', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsA, 'coedit.op.broadcast');

    // A drops connection
    await closeWs(wsA);
    wsA = null;
    await waitForCoEdit(wsB, 'coedit.user.left');

    // B continues editing
    sendWs(wsB, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-b', op: { kind: 'doc.insert', position: 13, text: '!', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsB, 'coedit.op.ack');

    // A reconnects
    wsA = await openWs(port);
    await subscribe(wsA, companyId);
    const rejoinMsg = await joinSession(wsA, doc.id, 'user-a', 'Alice');
    expect((rejoinMsg as any).content.body).toBe('# Hello World!');

    // A can continue editing (subsequent edits work)
    sendWs(wsA, { type: 'coedit.op', artifactId: doc.id, companyId, userId: 'user-a', op: { kind: 'doc.insert', position: 14, text: ' Yay', opId: genOpId() } as CoEditOp });
    await waitForCoEdit(wsB, 'coedit.op.broadcast');

    sendWs(wsA, { type: 'coedit.save', artifactId: doc.id, companyId, userId: 'user-a' });
    await waitForCoEdit(wsA, 'coedit.saved');

    const getRes = await request(app).get(`/api/companies/${companyId}/artifacts/${doc.id}`);
    expect(getRes.body.data.content.body).toBe('# Hello World! Yay');
  });

  // =========================================================================
  // S. VAL-COEDIT-012: Cursor is per-artifact
  // =========================================================================

  it('VAL-COEDIT-012: cursor only appears on the artifact being edited', async () => {
    const doc1 = await createDoc('# Doc1');
    const doc2 = await createDoc('# Doc2');
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, companyId);

    // A joins doc1, B joins doc1 AND doc2
    await joinSession(wsA, doc1.id, 'user-a', 'Alice');
    await joinSession(wsB, doc1.id, 'user-b', 'Bob');
    await joinSession(wsB, doc2.id, 'user-b', 'Bob');

    // B sends cursor on doc1
    sendWs(wsB, { type: 'coedit.cursor', artifactId: doc1.id, companyId, userId: 'user-b', name: 'Bob', position: 3 });

    // A (on doc1) should receive it
    const cursorMsg = await waitForCoEdit(wsA, 'coedit.cursor.broadcast');
    expect(cursorMsg.artifactId).toBe(doc1.id);

    // B sends cursor on doc2 — A should NOT receive it (A is not on doc2)
    sendWs(wsB, { type: 'coedit.cursor', artifactId: doc2.id, companyId, userId: 'user-b', name: 'Bob', position: 1 });

    // Collect for a short time — A should not receive doc2 cursor
    const msgs = await collectFor(wsA, 400);
    const doc2Cursors = msgs.filter(m => m.type === 'coedit.cursor.broadcast' && m.artifactId === doc2.id);
    expect(doc2Cursors).toHaveLength(0);
  });
});
