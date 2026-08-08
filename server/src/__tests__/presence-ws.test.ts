import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createTestServer, createTestDb } from '../test-utils.js';
import { setupWebSocketServer } from '../realtime/ws-server.js';
import { __resetPresenceStore } from '../realtime/presence-store.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers (mirrors artifacts-ws.test.ts reusable two-client pattern)
// ---------------------------------------------------------------------------

function openWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const onOpen = () => {
      ws.off('error', onError);
      resolve(ws);
    };
    const onError = (err: unknown) => {
      ws.off('open', onOpen);
      reject(err);
    };
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

function collectUntil(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeout = 3000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve) => {
    const out: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(out);
    }, timeout);
    const onMessage = (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>;
      out.push(msg);
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(out);
      }
    };
    ws.on('message', onMessage);
  });
}

function filterPresenceEvents(msgs: Record<string, unknown>[]): Record<string, unknown>[] {
  return msgs.filter((m) => typeof m.type === 'string' && (m.type as string).startsWith('presence.'));
}

function closeWs(ws: WebSocket | null): Promise<void> {
  if (!ws) return Promise.resolve();
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// Test suite — per-artifact presence over real WS (M3)
// Covers VAL-PRESENCE-011..014, VAL-PRESENCE-006, VAL-CROSS-014.
// Multi-client fan-out is proven with real `ws` clients (the browser is a
// single client whose "other actor" is a curl/ws call per the M2 constraint).
// ---------------------------------------------------------------------------

describe('Presence WebSocket delivery — real WS client', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let port: number;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let wss: ReturnType<typeof setupWebSocketServer> | null = null;
  let wsA: WebSocket | null = null;
  let wsB: WebSocket | null = null;

  beforeEach(async () => {
    __resetPresenceStore();
    db = await createTestDb();
    app = await createTestServer(db);
    port = (app.address() as { port: number }).port;
    wss = setupWebSocketServer(app);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Presence Corp A' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Presence Corp B' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Presence Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;
  });

  afterEach(async () => {
    await closeWs(wsA);
    await closeWs(wsB);
    wsA = null;
    wsB = null;
    wss?.close();
    wss = null;
    __resetPresenceStore();
  });

  /** Create a document artifact in the primary company/project. */
  async function createDoc(opts: { companyId?: string; projectId?: string | null } = {}) {
    const res = await request(app)
      .post(`/api/companies/${opts.companyId ?? companyId}/artifacts`)
      .send({
        type: 'document',
        title: '__mtest__ Presence Doc',
        content: { format: 'markdown', body: '# Hello' },
        ...(opts.projectId === undefined ? { projectId } : { projectId: opts.projectId }),
      })
      .expect(201);
    return res.body.data as { id: string; version: number };
  }

  /** Create a second test user in the primary company (local_trusted). */
  async function createSecondUser(name: string, email: string) {
    const res = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ name, email, companyId })
      .expect(201);
    return res.body.data as { id: string; name: string };
  }

  // =========================================================================
  // A. VAL-PRESENCE-011: presence.join fires on the company WS channel
  // =========================================================================

  it('VAL-PRESENCE-011: presence.join is delivered to a subscribed WS client on join', async () => {
    const doc = await createDoc();
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    const collectPromise = collectUntil(wsA, (m) => m.type === 'presence.join');
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({})
      .expect(200);
    const msgs = await collectPromise;
    const join = filterPresenceEvents(msgs).find((m) => m.type === 'presence.join');
    expect(join).toBeDefined();
    expect(join!.companyId).toBe(companyId);
    const payload = join!.payload as { artifactId: string; userId: string; name: string };
    expect(payload.artifactId).toBe(doc.id);
    expect(payload.userId).toBeDefined();
    expect(payload.name).toBeDefined();
  });

  // =========================================================================
  // B. VAL-PRESENCE-012: presence.leave fires when a viewer leaves
  // =========================================================================

  it('VAL-PRESENCE-012: presence.leave is delivered after join then leave for the same artifact+user', async () => {
    const doc = await createDoc();
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    // Join first (no collection — just trigger it)
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);

    // Now collect until we see presence.leave
    const collectPromise = collectUntil(wsA, (m) => m.type === 'presence.leave');
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/leave`)
      .send({ userId: 'dev-user-000' })
      .expect(200);
    const msgs = await collectPromise;
    const leave = filterPresenceEvents(msgs).find((m) => m.type === 'presence.leave');
    expect(leave).toBeDefined();
    expect(leave!.companyId).toBe(companyId);
    const payload = leave!.payload as { artifactId: string; userId: string };
    expect(payload.artifactId).toBe(doc.id);
    expect(payload.userId).toBe('dev-user-000');
  });

  // =========================================================================
  // C. VAL-PRESENCE-013: presence.typing fires and is scoped to an artifact
  // =========================================================================

  it('VAL-PRESENCE-013: presence.typing set and cleared for the same artifact', async () => {
    const doc = await createDoc();
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    // Join so the user is present (typing only applies to present viewers).
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);

    // Collect typing started
    const collectStart = collectUntil(wsA, (m) => m.type === 'presence.typing');
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/typing`)
      .send({ typing: true, userId: 'dev-user-000' })
      .expect(200);
    const startMsgs = await collectStart;
    const started = filterPresenceEvents(startMsgs).find(
      (m) => (m.payload as { typing?: boolean }).typing === true,
    );
    expect(started).toBeDefined();
    expect((started!.payload as { artifactId: string }).artifactId).toBe(doc.id);

    // Collect typing cleared
    const collectStop = collectUntil(
      wsA,
      (m) => m.type === 'presence.typing' && (m.payload as { typing?: boolean }).typing === false,
    );
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/typing`)
      .send({ typing: false, userId: 'dev-user-000' })
      .expect(200);
    const stopMsgs = await collectStop;
    const stopped = filterPresenceEvents(stopMsgs).find(
      (m) => (m.payload as { typing?: boolean }).typing === false,
    );
    expect(stopped).toBeDefined();
    expect((stopped!.payload as { artifactId: string }).artifactId).toBe(doc.id);
  });

  it('VAL-PRESENCE-008: typing auto-clears after inactivity (server-side timeout)', async () => {
    const doc = await createDoc();
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);

    // Start typing — expect an auto-clear event within a bounded window.
    const collectAutoClear = collectUntil(
      wsA,
      (m) => m.type === 'presence.typing' && (m.payload as { typing?: boolean }).typing === false,
      8000,
    );
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/typing`)
      .send({ typing: true, userId: 'dev-user-000' })
      .expect(200);
    const autoMsgs = await collectAutoClear;
    const autoCleared = filterPresenceEvents(autoMsgs).find(
      (m) => (m.payload as { typing?: boolean }).typing === false,
    );
    expect(autoCleared).toBeDefined();
    // The presence GET should reflect typing=false after auto-clear.
    const getRes = await request(app)
      .get(`/api/companies/${companyId}/artifacts/${doc.id}/presence`)
      .expect(200);
    const presence = getRes.body.data.presence as { typing: boolean }[];
    expect(presence.some((p) => p.typing)).toBe(false);
  });

  // =========================================================================
  // D. VAL-PRESENCE-006: self is not double-counted
  // =========================================================================

  it('VAL-PRESENCE-006: joining twice does not double-count a user', async () => {
    const doc = await createDoc();
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    // First join emits presence.join; second join (heartbeat) does NOT.
    const collectFirst = collectUntil(wsA, (m) => m.type === 'presence.join');
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    await collectFirst;

    // Second join — collect for a short window; no second presence.join.
    const collectSecond = collectUntil(wsA, () => false, 600);
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    const secondMsgs = await collectSecond;
    const secondJoins = filterPresenceEvents(secondMsgs).filter((m) => m.type === 'presence.join');
    expect(secondJoins).toHaveLength(0);

    // GET presence reflects exactly one entry for the user.
    const getRes = await request(app)
      .get(`/api/companies/${companyId}/artifacts/${doc.id}/presence`)
      .expect(200);
    const presence = getRes.body.data.presence as { userId: string }[];
    const devEntries = presence.filter((p) => p.userId === 'dev-user-000');
    expect(devEntries).toHaveLength(1);
  });

  it('VAL-PRESENCE-001/002: two distinct users appear in presence; per-artifact scoping', async () => {
    const docA = await createDoc();
    const docB = await createDoc();
    const secondUser = await createSecondUser('Viewer Two', 'viewer2@mtest.local');

    // User 1 joins docA
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${docA.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    // User 2 joins docA only
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${docA.id}/presence/join`)
      .send({ userId: secondUser.id, name: secondUser.name })
      .expect(200);
    // User 2 joins docB
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${docB.id}/presence/join`)
      .send({ userId: secondUser.id, name: secondUser.name })
      .expect(200);

    // docA presence has two users; docB presence has only user 2.
    const resA = await request(app)
      .get(`/api/companies/${companyId}/artifacts/${docA.id}/presence`)
      .expect(200);
    const presenceA = resA.body.data.presence as { userId: string }[];
    expect(presenceA).toHaveLength(2);
    expect(presenceA.map((p) => p.userId).sort()).toEqual(
      ['dev-user-000', secondUser.id].sort(),
    );

    const resB = await request(app)
      .get(`/api/companies/${companyId}/artifacts/${docB.id}/presence`)
      .expect(200);
    const presenceB = resB.body.data.presence as { userId: string }[];
    expect(presenceB).toHaveLength(1);
    expect(presenceB[0].userId).toBe(secondUser.id);
  });

  // =========================================================================
  // E. VAL-PRESENCE-014: company-scoped — no cross-company leakage
  // =========================================================================

  it('VAL-PRESENCE-014: subscriber to company A receives no presence events for company B activity', async () => {
    const docA = await createDoc({ companyId });
    const docB = await createDoc({ companyId: otherCompanyId, projectId: null });

    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, otherCompanyId);

    // Collect on company A for a short idle window while company B has presence activity.
    const collectA = collectUntil(wsA, () => false, 1000);
    // Company B presence activity: join, typing, leave
    await request(app)
      .post(`/api/companies/${otherCompanyId}/artifacts/${docB.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    await request(app)
      .post(`/api/companies/${otherCompanyId}/artifacts/${docB.id}/presence/typing`)
      .send({ typing: true, userId: 'dev-user-000' })
      .expect(200);
    await request(app)
      .post(`/api/companies/${otherCompanyId}/artifacts/${docB.id}/presence/leave`)
      .send({ userId: 'dev-user-000' })
      .expect(200);

    const msgsA = await collectA;
    // Company A subscriber received NO presence.* events from company B.
    expect(filterPresenceEvents(msgsA)).toHaveLength(0);

    // Sanity: company A activity DOES deliver to company A subscriber.
    const collectAJoin = collectUntil(wsA, (m) => m.type === 'presence.join');
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${docA.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    const aJoinMsgs = await collectAJoin;
    expect(filterPresenceEvents(aJoinMsgs).some((m) => m.type === 'presence.join')).toBe(true);
  });

  // =========================================================================
  // F. VAL-PRESENCE-005: presence covers Sheets and Boards (not just Docs)
  // =========================================================================

  it('VAL-PRESENCE-005: presence.join fires for a Sheet and a Board artifact', async () => {
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    const sheet = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'sheet',
        title: '__mtest__ Presence Sheet',
        content: { columns: [{ id: 'c1', key: 'name' }], rows: [{ id: 'r1', cells: { name: { value: 'A' } } }] },
        projectId,
      })
      .expect(201);

    const board = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'board',
        title: '__mtest__ Presence Board',
        content: { columns: [{ id: 'col_todo', title: 'Todo' }], cards: [] },
        projectId,
      })
      .expect(201);

    // Sheet join
    const collectSheet = collectUntil(wsA, (m) => m.type === 'presence.join');
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${sheet.body.data.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    const sheetMsgs = await collectSheet;
    const sheetJoin = filterPresenceEvents(sheetMsgs).find((m) => m.type === 'presence.join');
    expect(sheetJoin).toBeDefined();
    expect((sheetJoin!.payload as { artifactId: string }).artifactId).toBe(sheet.body.data.id);

    // Board join
    const collectBoard = collectUntil(wsA, (m) => m.type === 'presence.join');
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${board.body.data.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    const boardMsgs = await collectBoard;
    const boardJoin = filterPresenceEvents(boardMsgs).find((m) => m.type === 'presence.join');
    expect(boardJoin).toBeDefined();
    expect((boardJoin!.payload as { artifactId: string }).artifactId).toBe(board.body.data.id);
  });

  // =========================================================================
  // G. VAL-CROSS-014: project-level presence aggregates across artifact types
  // =========================================================================

  it('VAL-CROSS-014: project presence aggregates across a Doc and a Board in the same project', async () => {
    const doc = await createDoc(); // projectId set
    const board = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'board',
        title: '__mtest__ Agg Board',
        content: { columns: [{ id: 'col_todo', title: 'Todo' }], cards: [] },
        projectId,
      })
      .expect(201);
    const secondUser = await createSecondUser('Agg Viewer', 'aggviewer@mtest.local');

    // User 1 views the doc; user 2 views the board — both in the same project.
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${board.body.data.id}/presence/join`)
      .send({ userId: secondUser.id, name: secondUser.name })
      .expect(200);

    const res = await request(app)
      .get(`/api/companies/${companyId}/presence?projectId=${projectId}`)
      .expect(200);
    const aggregated = res.body.data.presence as {
      userId: string;
      name: string;
      artifactIds: string[];
    }[];
    expect(aggregated).toHaveLength(2);
    const userIds = aggregated.map((p) => p.userId).sort();
    expect(userIds).toEqual(['dev-user-000', secondUser.id].sort());
    // Each user is viewing at least one artifact in the project.
    expect(aggregated.every((p) => p.artifactIds.length >= 1)).toBe(true);
  });

  // =========================================================================
  // H. VAL-PRESENCE-004: leaving removes presence (GET reflects removal)
  // =========================================================================

  it('VAL-PRESENCE-004: leave removes the user from the artifact presence list', async () => {
    const doc = await createDoc();
    const secondUser = await createSecondUser('Leaver', 'leaver@mtest.local');

    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({ userId: 'dev-user-000', name: 'Dev User' })
      .expect(200);
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/join`)
      .send({ userId: secondUser.id, name: secondUser.name })
      .expect(200);

    let getRes = await request(app)
      .get(`/api/companies/${companyId}/artifacts/${doc.id}/presence`)
      .expect(200);
    expect((getRes.body.data.presence as unknown[])).toHaveLength(2);

    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/presence/leave`)
      .send({ userId: secondUser.id })
      .expect(200);

    getRes = await request(app)
      .get(`/api/companies/${companyId}/artifacts/${doc.id}/presence`)
      .expect(200);
    const presence = getRes.body.data.presence as { userId: string }[];
    expect(presence).toHaveLength(1);
    expect(presence[0].userId).toBe('dev-user-000');
  });

  // =========================================================================
  // I. Cross-company artifact scope rejection
  // =========================================================================

  it('rejects presence join on an artifact of another company with 404', async () => {
    const docB = await createDoc({ companyId: otherCompanyId, projectId: null });
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${docB.id}/presence/join`)
      .send({})
      .expect(404);
  });
});
