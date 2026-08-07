import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createTestServer, createTestDb } from '../test-utils.js';
import { setupWebSocketServer } from '../realtime/ws-server.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Shared test payloads
// ---------------------------------------------------------------------------

const DOC_CONTENT = { format: 'markdown' as const, body: '# Hello' };
const DOC_CONTENT_V2 = { format: 'markdown' as const, body: '# Updated' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Open a WebSocket connection to the test server's /ws endpoint and wait
 * for the server's `connected` ack. Resolves with the open socket.
 */
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

/**
 * Send a subscribe message and wait for the `subscribed` ack from the server.
 */
function subscribe(ws: WebSocket, companyId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('subscribe ack timeout')),
      3000,
    );
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

/** Collect every inbound WS message until `predicate` returns true or timeout reached. */
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

function filterArtifactEvents(
  msgs: Record<string, unknown>[],
): Record<string, unknown>[] {
  return msgs.filter((m) => typeof m.type === 'string' && (m.type as string).startsWith('artifact.'));
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
// Test suite — real-Postgres + real-WebSocket delivery for artifact.* events
// Covers VAL-ART-061 (revision.created on WS), VAL-ART-063 (company-scoped
// WS delivery, no cross-company leakage), and the WS-delivery requirement in
// the m1-artifact-crud-api feature (EventBus/WS delivery).
// ---------------------------------------------------------------------------

describe('Artifact WebSocket delivery — real WS client', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let port: number;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  // Track WS clients + the wss for cleanup.
  let wss: ReturnType<typeof setupWebSocketServer> | null = null;
  let wsA: WebSocket | null = null;
  let wsB: WebSocket | null = null;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    port = (app.address() as { port: number }).port;
    // Attach the WebSocket server to the persistent test HTTP server so the
    // EventBus→WS bridge is active during this test. afterEach removes all
    // eventBus listeners, so the bridge is re-registered fresh each test.
    wss = setupWebSocketServer(app);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ WS Corp A' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ WS Corp B' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'WS Proj', status: 'active' })
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
  });

  /** Create a document artifact via HTTP. */
  async function createDoc(overrides: { companyId?: string; projectId?: string | null } = {}) {
    const res = await request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send({
        type: 'document',
        title: '__mtest__ WS Doc',
        content: DOC_CONTENT,
        ...(overrides.projectId === undefined ? { projectId } : { projectId: overrides.projectId }),
      })
      .expect(201);
    return res.body.data as { id: string; version: number };
  }

  // =========================================================================
  // A. artifact.created + artifact.revision.created delivered over WS
  // =========================================================================

  it('delivers artifact.created and artifact.revision.created to a subscribed WS client on create', async () => {
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    // Drain the `subscribed` ack already consumed by subscribe(); now collect.
    // Perform a create and collect events until revision.created arrives.
    const collectPromise = collectUntil(
      wsA,
      (m) => m.type === 'artifact.revision.created',
    );
    await createDoc();
    const msgs = await collectPromise;
    const artifactEvents = filterArtifactEvents(msgs);

    const created = artifactEvents.find((m) => m.type === 'artifact.created');
    const revision = artifactEvents.find((m) => m.type === 'artifact.revision.created');
    expect(created).toBeDefined();
    expect(revision).toBeDefined();
    expect(created!.companyId).toBe(companyId);
    expect(revision!.companyId).toBe(companyId);
    // revision.created payload carries the version
    const revPayload = revision!.payload as { artifact?: { version?: number } };
    expect(revPayload.artifact?.version).toBe(1);
  });

  // =========================================================================
  // B. artifact.updated + artifact.revision.created delivered on PATCH
  // =========================================================================

  it('delivers artifact.updated and artifact.revision.created on PATCH', async () => {
    const doc = await createDoc();
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    const collectPromise = collectUntil(
      wsA,
      (m) => m.type === 'artifact.revision.created',
    );
    await request(app)
      .patch(`/api/companies/${companyId}/artifacts/${doc.id}`)
      .send({ content: DOC_CONTENT_V2, version: 1 })
      .expect(200);
    const msgs = await collectPromise;
    const artifactEvents = filterArtifactEvents(msgs);

    const updated = artifactEvents.find((m) => m.type === 'artifact.updated');
    const revision = artifactEvents.find((m) => m.type === 'artifact.revision.created');
    expect(updated).toBeDefined();
    expect(revision).toBeDefined();
    expect(updated!.companyId).toBe(companyId);
    const revPayload = revision!.payload as { artifact?: { version?: number } };
    expect(revPayload.artifact?.version).toBe(2);
  });

  // =========================================================================
  // C. artifact.deleted + artifact.archived delivered on DELETE / archive
  // =========================================================================

  it('delivers artifact.deleted on DELETE', async () => {
    const doc = await createDoc();
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    const collectPromise = collectUntil(wsA, (m) => m.type === 'artifact.deleted');
    await request(app)
      .delete(`/api/companies/${companyId}/artifacts/${doc.id}`)
      .expect(200);
    const msgs = await collectPromise;
    const deleted = filterArtifactEvents(msgs).find((m) => m.type === 'artifact.deleted');
    expect(deleted).toBeDefined();
    expect(deleted!.companyId).toBe(companyId);
  });

  it('delivers artifact.archived on archive', async () => {
    const doc = await createDoc();
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    const collectPromise = collectUntil(wsA, (m) => m.type === 'artifact.archived');
    await request(app)
      .post(`/api/companies/${companyId}/artifacts/${doc.id}/archive`)
      .expect(200);
    const msgs = await collectPromise;
    const archived = filterArtifactEvents(msgs).find((m) => m.type === 'artifact.archived');
    expect(archived).toBeDefined();
    expect(archived!.companyId).toBe(companyId);
  });

  // =========================================================================
  // D. VAL-ART-063: events are company-scoped — no cross-company leakage
  // =========================================================================

  it('VAL-ART-063: subscriber to company A receives company A events; subscriber to company B does NOT', async () => {
    wsA = await openWs(port);
    wsB = await openWs(port);
    await subscribe(wsA, companyId);
    await subscribe(wsB, otherCompanyId);

    // Collect on both clients; resolve A after revision.created, B after a
    // short idle window (no event expected).
    const collectA = collectUntil(wsA, (m) => m.type === 'artifact.revision.created');
    const collectB = collectUntil(wsB, () => false, 800); // 800ms idle window
    await createDoc({ companyId });
    const msgsA = await collectA;
    const msgsB = await collectB;

    // Company A subscriber got the artifact events
    const aArtifact = filterArtifactEvents(msgsA);
    expect(aArtifact.some((m) => m.type === 'artifact.created')).toBe(true);
    expect(aArtifact.every((m) => m.companyId === companyId)).toBe(true);

    // Company B subscriber received NO artifact.* events
    const bArtifact = filterArtifactEvents(msgsB);
    expect(bArtifact).toHaveLength(0);
  });

  it('VAL-ART-063: creating an artifact in company B does not deliver to company A subscriber', async () => {
    wsA = await openWs(port);
    await subscribe(wsA, companyId);

    const collectA = collectUntil(wsA, () => false, 800);
    // Create in company B (no project — company-level)
    await createDoc({ companyId: otherCompanyId, projectId: null });
    const msgsA = await collectA;
    const aArtifact = filterArtifactEvents(msgsA);
    expect(aArtifact).toHaveLength(0);
  });
});
