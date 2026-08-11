import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { WebSocket } from 'ws';
import { createTestServer, createTestDb } from '../test-utils.js';
import { setupWebSocketServer } from '../realtime/ws-server.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// M5 cross-type shared behaviors — VAL-M5-002..006
//
// This suite exercises ALL THREE M5 artifact types (gallery, dashboard, app)
// in a single company/project context to prove the cross-type shared
// assertions hold holistically: CRUD round-trips, schema validation, version
// + append-only revisions, project/company scoping, and realtime events.
// VAL-M5-001 (type picker lists all three + opens each editor) is a UI
// assertion verified via agent-browser, not here.
// ---------------------------------------------------------------------------

// --- Valid minimal content per type ----------------------------------------

const GALLERY_EMPTY = { items: [] };
const GALLERY_TWO = {
  items: [
    { id: 'i1', type: 'image', url: 'https://example.test/a.png', caption: 'Alpha' },
    { id: 'i2', type: 'image', url: 'https://example.test/b.png' },
  ],
};

const DASH_EMPTY = { dataSources: [], widgets: [] };
const DASH_ONE_SOURCE_ONE_WIDGET = {
  dataSources: [
    { id: 'ds1', type: 'manual_json', config: { data: { rows: [{ label: 'A', value: 10 }] } } },
  ],
  widgets: [
    { id: 'w1', type: 'table', dataSourceId: 'ds1', config: { columns: ['label', 'value'] } },
  ],
};

const APP_EMPTY = { definition: {}, files: [] };
const APP_ONE_FILE = {
  definition: { name: 'demo', entrypoint: 'index.html' },
  files: [{ path: 'index.html', content: '<h1>Hello</h1>' }],
};

/** The three M5 types and their valid create/update payloads. */
const M5_TYPES: Array<{
  type: 'gallery' | 'dashboard' | 'app';
  label: string;
  create: unknown;
  update: unknown;
  invalidCreate: unknown;
  invalidPatch: unknown;
}> = [
  {
    type: 'gallery',
    label: 'Gallery',
    create: GALLERY_EMPTY,
    update: GALLERY_TWO,
    invalidCreate: { items: [{ id: 'i9', type: 'image' }] }, // missing url
    invalidPatch: { items: [{ id: 'i9', type: 'image' }] }, // missing url
  },
  {
    type: 'dashboard',
    label: 'Dashboard',
    create: DASH_EMPTY,
    update: DASH_ONE_SOURCE_ONE_WIDGET,
    invalidCreate: {
      dataSources: [],
      widgets: [{ id: 'wX', type: 'chart', dataSourceId: 'dsMissing', config: {} }],
    }, // dangling dataSourceId
    invalidPatch: {
      dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: {} } }],
      widgets: [{ id: 'wX', type: 'chart', dataSourceId: 'nope', config: {} }],
    }, // dangling dataSourceId
  },
  {
    type: 'app',
    label: 'App',
    create: APP_EMPTY,
    update: APP_ONE_FILE,
    invalidCreate: { definition: {}, files: [{ content: 'x' }] }, // file missing path
    invalidPatch: { definition: {}, files: [{ path: 'a' }] }, // file missing content
  },
];

// --- Helpers ----------------------------------------------------------------

/** Collect EventBus events emitted during an async operation. */
async function captureEvents(fn: () => Promise<void>): Promise<EidolonEvent[]> {
  const events: EidolonEvent[] = [];
  const handler = (event: EidolonEvent) => events.push(event);
  eventBus.onEvent(handler);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    eventBus.off('event', handler);
  }
  return events;
}

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
  timeout = 4000,
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

function closeWs(ws: WebSocket | null): Promise<void> {
  if (!ws) return Promise.resolve();
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.once('close', () => resolve());
    ws.close();
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('M5 cross-type shared behaviors — gallery + dashboard + app', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let port: number;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let wss: ReturnType<typeof setupWebSocketServer> | null = null;
  let ws: WebSocket | null = null;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    port = (app.address() as { port: number }).port;
    wss = setupWebSocketServer(app);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ M5 Shared Corp', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ M5 Shared Other', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'M5 Shared Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'M5 Other Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;
  });

  afterEach(async () => {
    await closeWs(ws);
    ws = null;
    wss?.close();
    wss = null;
  });

  /** Create an artifact of the given type. */
  function createArtifact(
    type: string,
    content: unknown,
    overrides: { companyId?: string; projectId?: string | null; title?: string } = {},
  ) {
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send({
        type,
        title: overrides.title ?? `__mtest__ ${type}`,
        content,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // VAL-M5-002: Create/list/get/update/delete round-trips for each M5 type
  // =========================================================================

  describe('VAL-M5-002: CRUD round-trips for all three M5 types', () => {
    for (const spec of M5_TYPES) {
      it(`${spec.label}: create -> get -> patch -> delete round-trip succeeds`, async () => {
        // POST
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;
        expect(created.body.data.type).toBe(spec.type);
        expect(created.body.data.version).toBe(1);
        expect(created.body.data.projectId).toBe(projectId);
        expect(created.body.data.content).toEqual(spec.create);

        // GET single
        const got = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}`)
          .expect(200);
        expect(got.body.data.content).toEqual(spec.create);

        // List filtered by type includes the artifact
        const listed = await request(app)
          .get(`/api/companies/${companyId}/artifacts?type=${spec.type}`)
          .expect(200);
        expect(listed.body.data.map((a: { id: string }) => a.id)).toContain(id);

        // PATCH with new content -> version 2
        const patched = await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: spec.update, version: 1 })
          .expect(200);
        expect(patched.body.data.version).toBe(2);
        expect(patched.body.data.content).toEqual(spec.update);

        // GET reflects updated content
        const got2 = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}`)
          .expect(200);
        expect(got2.body.data.version).toBe(2);
        expect(got2.body.data.content).toEqual(spec.update);

        // DELETE soft-deletes
        await request(app)
          .delete(`/api/companies/${companyId}/artifacts/${id}`)
          .expect(200);

        // default active list excludes it
        const active = await request(app)
          .get(`/api/companies/${companyId}/artifacts?type=${spec.type}`)
          .expect(200);
        expect(active.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
      });
    }

    it('all three M5 types coexist in the same company list', async () => {
      const g = await createArtifact('gallery', GALLERY_EMPTY).expect(201);
      const d = await createArtifact('dashboard', DASH_EMPTY).expect(201);
      const a = await createArtifact('app', APP_EMPTY).expect(201);

      const all = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .expect(200);
      const ids = all.body.data.map((x: { id: string }) => x.id);
      expect(ids).toContain(g.body.data.id);
      expect(ids).toContain(d.body.data.id);
      expect(ids).toContain(a.body.data.id);

      // type filter returns only the matching type
      const onlyGallery = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=gallery`)
        .expect(200);
      expect(onlyGallery.body.data).toHaveLength(1);
      expect(onlyGallery.body.data[0].type).toBe('gallery');
    });
  });

  // =========================================================================
  // VAL-M5-003: Server validates type-specific content schema (400 on invalid)
  // =========================================================================

  describe('VAL-M5-003: schema validation rejects invalid content for all three types', () => {
    for (const spec of M5_TYPES) {
      it(`${spec.label}: POST with invalid content -> 400, no artifact created`, async () => {
        const before = await request(app)
          .get(`/api/companies/${companyId}/artifacts?type=${spec.type}`)
          .expect(200);

        const res = await createArtifact(spec.type, spec.invalidCreate, {
          title: `__mtest__ bad ${spec.type}`,
        }).expect(400);
        expect(res.body.error || res.body.message || res.body).toBeTruthy();

        const after = await request(app)
          .get(`/api/companies/${companyId}/artifacts?type=${spec.type}`)
          .expect(200);
        expect(after.body.data).toHaveLength(before.body.data.length);
      });

      it(`${spec.label}: PATCH with invalid content -> 400, version unchanged`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        const res = await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: spec.invalidPatch, version: 1 })
          .expect(400);
        expect(res.body.error || res.body.message || res.body).toBeTruthy();

        // version + content unchanged
        const got = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}`)
          .expect(200);
        expect(got.body.data.version).toBe(1);
        expect(got.body.data.content).toEqual(spec.create);
      });

      it(`${spec.label}: valid content accepted on both POST and PATCH`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: spec.update, version: 1 })
          .expect(200);
      });
    }

    it('cross-type content mismatch is rejected (document content under gallery type)', async () => {
      await createArtifact('gallery', { format: 'markdown', body: '# nope' }).expect(400);
    });
  });

  // =========================================================================
  // VAL-M5-004: Every content save increments version + append-only revision
  // =========================================================================

  describe('VAL-M5-004: version + append-only revision per save (incl. restore)', () => {
    for (const spec of M5_TYPES) {
      it(`${spec.label}: create v1 + 1 revision; patch v2 + 1 revision; restore v1 -> v3`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        // v1 revisions
        let revs = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
          .expect(200);
        expect(revs.body.data).toHaveLength(1);
        expect(revs.body.data[0].version).toBe(1);
        expect(revs.body.data[0].editSource).toBe('user');
        expect(revs.body.data[0].content).toEqual(spec.create);

        // PATCH -> v2
        const patched = await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: spec.update, version: 1 })
          .expect(200);
        expect(patched.body.data.version).toBe(2);

        revs = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
          .expect(200);
        expect(revs.body.data).toHaveLength(2);
        expect(revs.body.data[1].version).toBe(2);
        expect(revs.body.data[1].editSource).toBe('user');
        expect(revs.body.data[1].content).toEqual(spec.update);

        // versions ascending, no gaps/duplicates
        const versions = revs.body.data.map((r: { version: number }) => r.version);
        expect(versions).toEqual([1, 2]);

        // restore v1 -> v3 (new version, does NOT rewrite v1)
        const restored = await request(app)
          .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
          .expect(200);
        expect(restored.body.data.version).toBe(3);
        expect(restored.body.data.content).toEqual(spec.create);

        revs = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
          .expect(200);
        expect(revs.body.data).toHaveLength(3);
        const allVersions = revs.body.data.map((r: { version: number }) => r.version);
        expect(allVersions).toEqual([1, 2, 3]);
        // v1 revision unchanged (append-only)
        expect(revs.body.data[0].version).toBe(1);
        expect(revs.body.data[0].content).toEqual(spec.create);
        // v3 content == v1 content
        expect(revs.body.data[2].version).toBe(3);
        expect(revs.body.data[2].content).toEqual(spec.create);
      });

      it(`${spec.label}: failed validation does not increment version or add a revision`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: spec.invalidPatch, version: 1 })
          .expect(400);

        const got = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}`)
          .expect(200);
        expect(got.body.data.version).toBe(1);

        const revs = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
          .expect(200);
        expect(revs.body.data).toHaveLength(1);
      });

      it(`${spec.label}: stale optimistic version -> 409 with current state`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        // first PATCH succeeds (v1 -> v2)
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: spec.update, version: 1 })
          .expect(200);

        // stale PATCH with version=1 -> 409
        const res = await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: spec.create, version: 1 })
          .expect(409);
        // 409 body includes current state
        const body = res.body;
        const current = body.details?.current ?? body.current;
        expect(current).toBeTruthy();
        expect(current.version).toBe(2);
      });
    }
  });

  // =========================================================================
  // VAL-M5-005: Project-scoped + company-validated
  // =========================================================================

  describe('VAL-M5-005: project scoping + company isolation for all three types', () => {
    for (const spec of M5_TYPES) {
      it(`${spec.label}: project-scoped list returns only that project's artifacts`, async () => {
        // Create in the main project
        const inProj = await createArtifact(spec.type, spec.create).expect(201);
        // Create a second project + artifact of the same type there
        const proj2 = await request(app)
          .post(`/api/companies/${companyId}/projects`)
          .send({ name: 'M5 Second Proj', status: 'active' })
          .expect(201);
        const inProj2 = await createArtifact(spec.type, spec.create, {
          projectId: proj2.body.data.id,
          title: `__mtest__ ${spec.type} proj2`,
        }).expect(201);

        // project-scoped list for main project
        const scoped = await request(app)
          .get(`/api/companies/${companyId}/projects/${projectId}/artifacts?type=${spec.type}`)
          .expect(200);
        const scopedIds = scoped.body.data.map((a: { id: string }) => a.id);
        expect(scopedIds).toContain(inProj.body.data.id);
        expect(scopedIds).not.toContain(inProj2.body.data.id);

        // project-scoped list for second project
        const scoped2 = await request(app)
          .get(`/api/companies/${companyId}/projects/${proj2.body.data.id}/artifacts?type=${spec.type}`)
          .expect(200);
        const scoped2Ids = scoped2.body.data.map((a: { id: string }) => a.id);
        expect(scoped2Ids).toContain(inProj2.body.data.id);
        expect(scoped2Ids).not.toContain(inProj.body.data.id);
      });

      it(`${spec.label}: cross-company GET -> 404`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        await request(app)
          .get(`/api/companies/${otherCompanyId}/artifacts/${id}`)
          .expect(404);
      });

      it(`${spec.label}: cross-company PATCH -> 404, no mutation`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        await request(app)
          .patch(`/api/companies/${otherCompanyId}/artifacts/${id}`)
          .send({ content: spec.update, version: 1 })
          .expect(404);

        // original unchanged
        const got = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}`)
          .expect(200);
        expect(got.body.data.version).toBe(1);
        expect(got.body.data.content).toEqual(spec.create);
      });

      it(`${spec.label}: cross-company DELETE -> 404, artifact survives`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        await request(app)
          .delete(`/api/companies/${otherCompanyId}/artifacts/${id}`)
          .expect(404);

        const got = await request(app)
          .get(`/api/companies/${companyId}/artifacts/${id}`)
          .expect(200);
        expect(got.body.data.status).toBe('active');
      });

      it(`${spec.label}: cannot create with a projectId from another company`, async () => {
        // The contract allows 400/403/404 — the server returns 404 because
        // the project does not exist within the path company.
        const res = await createArtifact(spec.type, spec.create, {
          companyId,
          projectId: otherProjectId,
        });
        expect([400, 403, 404]).toContain(res.status);
      });

      it(`${spec.label}: appears in the project home composed view`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);

        const home = await request(app)
          .get(`/api/companies/${companyId}/projects/${projectId}/home`)
          .expect(200);
        const artifacts = home.body.data.artifacts ?? [];
        const ids = artifacts.map((a: { id: string }) => a.id);
        expect(ids).toContain(created.body.data.id);
      });
    }
  });

  // =========================================================================
  // VAL-M5-006: Realtime artifact.* events fire for M5 create/update/delete
  // =========================================================================

  describe('VAL-M5-006: realtime artifact.* events for all three types (EventBus)', () => {
    for (const spec of M5_TYPES) {
      it(`${spec.label}: create emits artifact.created + artifact.revision.created`, async () => {
        const events = await captureEvents(async () => {
          await createArtifact(spec.type, spec.create).expect(201);
        });
        const created = events.filter((e) => e.type === 'artifact.created');
        expect(created).toHaveLength(1);
        expect(created[0].companyId).toBe(companyId);
        expect(
          (created[0].payload as { artifact: { type: string } }).artifact.type,
        ).toBe(spec.type);
        expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
      });

      it(`${spec.label}: update emits artifact.updated + artifact.revision.created`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        const events = await captureEvents(async () => {
          await request(app)
            .patch(`/api/companies/${companyId}/artifacts/${id}`)
            .send({ content: spec.update, version: 1 })
            .expect(200);
        });
        expect(events.filter((e) => e.type === 'artifact.updated')).toHaveLength(1);
        expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
        const updated = events.find((e) => e.type === 'artifact.updated')!;
        expect(updated.companyId).toBe(companyId);
      });

      it(`${spec.label}: delete emits artifact.deleted`, async () => {
        const created = await createArtifact(spec.type, spec.create).expect(201);
        const id = created.body.data.id;

        const events = await captureEvents(async () => {
          await request(app).delete(`/api/companies/${companyId}/artifacts/${id}`).expect(200);
        });
        const deleted = events.filter((e) => e.type === 'artifact.deleted');
        expect(deleted).toHaveLength(1);
        expect(
          (deleted[0].payload as { artifact: { id: string } }).artifact.id,
        ).toBe(id);
      });
    }
  });

  // =========================================================================
  // VAL-M5-006 (WS delivery): real WebSocket client receives artifact.* events
  // for all three M5 types
  // =========================================================================

  describe('VAL-M5-006 (WS): real WS client receives events for all three M5 types', () => {
    for (const spec of M5_TYPES) {
      it(`${spec.label}: WS client receives artifact.created on create`, async () => {
        ws = await openWs(port);
        await subscribe(ws, companyId);

        // Start collecting BEFORE firing the request so the event isn't missed.
        const collectPromise = collectUntil(
          ws!,
          (m) => m.type === 'artifact.created',
        );
        await createArtifact(spec.type, spec.create).expect(201);
        const msgs = await collectPromise;

        const created = msgs.filter((m) => m.type === 'artifact.created');
        expect(created).toHaveLength(1);
        expect(created[0].companyId).toBe(companyId);
        const payload = created[0].payload as { artifact: { type: string } };
        expect(payload.artifact.type).toBe(spec.type);

        await closeWs(ws);
        ws = null;
      });
    }

    it('WS client receives artifact.created for all three types created in sequence', async () => {
      ws = await openWs(port);
      await subscribe(ws, companyId);

      // Create all three in sequence, collecting 3 artifact.created events
      const doneTypes = new Set<string>();
      const allCreated = collectUntil(
        ws!,
        (m) => {
          if (m.type === 'artifact.created') {
            const p = m.payload as { artifact: { type: string } };
            doneTypes.add(p.artifact.type);
          }
          return doneTypes.size === 3;
        },
        6000,
      );

      await createArtifact('gallery', GALLERY_EMPTY);
      await createArtifact('dashboard', DASH_EMPTY);
      await createArtifact('app', APP_EMPTY);

      const msgs = await allCreated;
      const created = msgs.filter((m) => m.type === 'artifact.created');
      expect(created).toHaveLength(3);
      const types = created.map(
        (m) => (m.payload as { artifact: { type: string } }).artifact.type,
      );
      expect(types.sort()).toEqual(['app', 'dashboard', 'gallery']);

      await closeWs(ws);
      ws = null;
    });

    it('cross-company isolation: no M5 events leak to another company WS', async () => {
      ws = await openWs(port);
      await subscribe(ws, otherCompanyId);

      // Create artifacts in the MAIN company (not otherCompanyId)
      const leakCheck = collectUntil(
        ws!,
        () => false, // never resolve on event; rely on timeout
        1500,
      );
      await createArtifact('gallery', GALLERY_EMPTY).expect(201);
      await createArtifact('dashboard', DASH_EMPTY).expect(201);
      await createArtifact('app', APP_EMPTY).expect(201);

      const msgs = await leakCheck;
      const artifactEvents = msgs.filter((m) => typeof m.type === 'string' && (m.type as string).startsWith('artifact.'));
      expect(artifactEvents).toHaveLength(0);

      await closeWs(ws);
      ws = null;
    });
  });
});
