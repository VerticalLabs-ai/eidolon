import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import { ArtifactToolService } from '../services/artifact-tools.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// Gallery artifact payloads
// ---------------------------------------------------------------------------

const GALLERY_EMPTY = { items: [] };

const GALLERY_TWO_ITEMS = {
  items: [
    { id: 'i1', type: 'image', url: 'https://example.test/a.png', caption: 'Alpha' },
    { id: 'i2', type: 'image', url: 'https://example.test/b.png' },
  ],
};

/** Reordered version of GALLERY_TWO_ITEMS (i2 before i1). */
const GALLERY_REORDERED = {
  items: [
    { id: 'i2', type: 'image', url: 'https://example.test/b.png' },
    { id: 'i1', type: 'image', url: 'https://example.test/a.png', caption: 'Alpha' },
  ],
};

/** One item remaining after a delete. */
const GALLERY_ONE_ITEM = {
  items: [{ id: 'i2', type: 'image', url: 'https://example.test/b.png' }],
};

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

// ---------------------------------------------------------------------------
// Suite — VAL-GALLERY-001..008 + M5 shared behaviors (scoping, realtime)
// ---------------------------------------------------------------------------

describe('Gallery artifact API — real-Postgres integration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let secondProjectId: string;
  let otherProjectId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Gallery Corp', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Gallery Other Corp', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Gallery Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const project2 = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Gallery Proj 2', status: 'active' })
      .expect(201);
    secondProjectId = project2.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Gallery Other Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Gallery Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  /** Create a gallery artifact, returning the chainable supertest Test. */
  function createGallery(
    overrides: {
      companyId?: string;
      projectId?: string | null;
      title?: string;
      content?: unknown;
    } = {},
  ) {
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send({
        type: 'gallery',
        title: overrides.title ?? '__mtest__ Gallery',
        content: overrides.content ?? GALLERY_EMPTY,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // VAL-GALLERY-001: create a gallery with a title and empty items
  // =========================================================================

  describe('VAL-GALLERY-001: create a gallery artifact with a title and empty items', () => {
    it('creates a gallery at version 1 scoped to the project with content echoed', async () => {
      const res = await createGallery({ title: '__mtest__ M5 gallery' }).expect(201);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.type).toBe('gallery');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.contentSchemaVersion).toBe(1);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.projectId).toBe(projectId);
      expect(res.body.data.content).toEqual(GALLERY_EMPTY);
    });

    it('lists the gallery under the type=gallery filter', async () => {
      const created = await createGallery().expect(201);

      const listed = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=gallery`)
        .expect(200);
      expect(listed.body.data.map((a: { id: string }) => a.id)).toContain(created.body.data.id);
    });

    it('does not list the gallery under a different type filter', async () => {
      await createGallery().expect(201);
      const docs = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=document`)
        .expect(200);
      expect(docs.body.data).toHaveLength(0);
    });
  });

  // =========================================================================
  // VAL-GALLERY-002: add media items with image url and optional caption
  // =========================================================================

  describe('VAL-GALLERY-002: add media items with image url and optional caption via PATCH', () => {
    it('patches two items (one captioned, one not) and preserves both', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_TWO_ITEMS, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.content.items).toHaveLength(2);
      expect(patched.body.data.content.items[0]).toEqual(GALLERY_TWO_ITEMS.items[0]);
      expect(patched.body.data.content.items[1]).toEqual(GALLERY_TWO_ITEMS.items[1]);
      // caption is optional and absent on i2
      expect(patched.body.data.content.items[1].caption).toBeUndefined();

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content).toEqual(GALLERY_TWO_ITEMS);
    });
  });

  // =========================================================================
  // VAL-GALLERY-004/005: reorder + delete via PATCH (API side)
  // =========================================================================

  describe('VAL-GALLERY-004/005: reorder and delete items via PATCH', () => {
    it('reorders items and the new order persists', async () => {
      const created = await createGallery({ content: GALLERY_TWO_ITEMS }).expect(201);
      const id = created.body.data.id;

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_REORDERED, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.content.items.map((i: { id: string }) => i.id)).toEqual(['i2', 'i1']);

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.items.map((i: { id: string }) => i.id)).toEqual(['i2', 'i1']);
    });

    it('deletes an item and only the remaining items persist', async () => {
      const created = await createGallery({ content: GALLERY_TWO_ITEMS }).expect(201);
      const id = created.body.data.id;

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_ONE_ITEM, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.content.items).toHaveLength(1);
      expect(patched.body.data.content.items[0].id).toBe('i2');

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.items.map((i: { id: string }) => i.id)).toEqual(['i2']);
    });
  });

  // =========================================================================
  // VAL-GALLERY-006: content schema rejects missing url or invalid type
  // =========================================================================

  describe('VAL-GALLERY-006: content schema rejects a gallery item missing url or with wrong type', () => {
    it('rejects a PATCH with an item missing url with 400', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { items: [{ id: 'i9', type: 'image' }] }, version: 1 })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');

      // content/version unchanged, no new revision
      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      expect(after.body.data.content).toEqual(GALLERY_EMPTY);
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(1);
    });

    it('rejects a PATCH with an item with an invalid type with 400', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { items: [{ id: 'i9', type: 'bogus', url: 'https://example.test/x' }] }, version: 1 })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a PATCH with a duplicate item id with 400', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            items: [
              { id: 'dup', type: 'image', url: 'https://example.test/a.png' },
              { id: 'dup', type: 'image', url: 'https://example.test/b.png' },
            ],
          },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a create with an item missing url with 400', async () => {
      const res = await createGallery({ content: { items: [{ id: 'i9', type: 'image' }] } }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a create with missing items field with 400', async () => {
      const res = await createGallery({ content: { notItems: [] } }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects document content under the gallery type with 400', async () => {
      const res = await createGallery({ content: { format: 'markdown', body: '# nope' } }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('accepts a video item (type enum allows image|video)', async () => {
      const res = await createGallery({
        content: { items: [{ id: 'v1', type: 'video', url: 'https://example.test/v.mp4' }] },
      }).expect(201);
      expect(res.body.data.content.items[0].type).toBe('video');
    });
  });

  // =========================================================================
  // VAL-GALLERY-007: versioning — restoring an earlier gallery revision
  // =========================================================================

  describe('VAL-GALLERY-007: restoring an earlier gallery revision recovers prior items', () => {
    it('restores v2 content as a new version (v5) without rewriting v2', async () => {
      // v1: empty
      const created = await createGallery().expect(201);
      const id = created.body.data.id;
      // v2: two items
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_TWO_ITEMS, version: 1 })
        .expect(200);
      // v3: reordered
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_REORDERED, version: 2 })
        .expect(200);
      // v4: one item (deleted)
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_ONE_ITEM, version: 3 })
        .expect(200);

      // restore v2 -> v5
      const restored = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/2/restore`)
        .expect(200);
      expect(restored.body.data.version).toBe(5);
      expect(restored.body.data.content).toEqual(GALLERY_TWO_ITEMS);

      // v2 revision row unchanged (append-only)
      const rev2 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/2`)
        .expect(200);
      expect(rev2.body.data.content).toEqual(GALLERY_TWO_ITEMS);

      // full revision list is [1,2,3,4,5]
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  // =========================================================================
  // VAL-M5-004: every content save increments version + appends a revision
  // =========================================================================

  describe('VAL-M5-004 (gallery): version + append-only revision per save', () => {
    it('create -> v1 + 1 revision; PATCH -> v2 + 1 revision (editSource=user)', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      const initialRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(initialRevs.body.data).toHaveLength(1);
      expect(initialRevs.body.data[0].version).toBe(1);
      expect(initialRevs.body.data[0].editSource).toBe('user');
      expect(initialRevs.body.data[0].content).toEqual(GALLERY_EMPTY);

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_TWO_ITEMS, version: 1 })
        .expect(200);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(2);
      expect(revs.body.data[1].version).toBe(2);
      expect(revs.body.data[1].editSource).toBe('user');
      expect(revs.body.data[1].content).toEqual(GALLERY_TWO_ITEMS);
    });

    it('does not increment version or add a revision on a failed validation', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: { items: [{ id: 'i9', type: 'image' }] }, version: 1 })
        .expect(400);

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(1);
    });

    it('rejects a stale optimistic version with 409', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_TWO_ITEMS, version: 1 })
        .expect(200);

      const stale = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_EMPTY, version: 1 })
        .expect(409);
      expect(stale.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
      expect(stale.body.details.current.version).toBe(2);
    });
  });

  // =========================================================================
  // VAL-M5-005: gallery is project-scoped and company-validated
  // =========================================================================

  describe('VAL-M5-005 (gallery): project + company isolation', () => {
    it('does not return a gallery from another company', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);

      const otherList = await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts?type=gallery`)
        .expect(200);
      expect(otherList.body.data).toHaveLength(0);
    });

    it('does not allow update/delete/archive of a gallery through another company', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${otherCompanyId}/artifacts/${id}`)
        .send({ content: GALLERY_TWO_ITEMS, version: 1 })
        .expect(404);
      await request(app).delete(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);
      await request(app).post(`/api/companies/${otherCompanyId}/artifacts/${id}/archive`).expect(404);

      const untouched = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(untouched.body.data.version).toBe(1);
      expect(untouched.body.data.status).toBe('active');
    });

    it('cannot create a gallery scoped to a project in another company', async () => {
      await createGallery({ projectId: otherProjectId }).expect(404);
    });

    it('a project-scoped list returns only that project galleries', async () => {
      const inProject = await createGallery({ title: '__mtest__ Gallery P1' }).expect(201);
      const inSecond = await createGallery({
        title: '__mtest__ Gallery P2',
        projectId: secondProjectId,
      }).expect(201);
      const unscoped = await createGallery({ title: '__mtest__ Gallery none', projectId: null }).expect(201);

      const p1 = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/artifacts`)
        .expect(200);
      const p1Ids = p1.body.data.map((a: { id: string }) => a.id);
      expect(p1Ids).toContain(inProject.body.data.id);
      expect(p1Ids).not.toContain(inSecond.body.data.id);
      expect(p1Ids).not.toContain(unscoped.body.data.id);
    });

    it('appears in the project home composed view', async () => {
      const created = await createGallery().expect(201);
      const home = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);
      const ids = home.body.data.artifacts.map((a: { id: string }) => a.id);
      expect(ids).toContain(created.body.data.id);
    });
  });

  // =========================================================================
  // VAL-GALLERY-008: agent authors a gallery via artifact.create/update tools
  // =========================================================================

  describe('VAL-GALLERY-008: agent authors a gallery artifact via artifact.create/update tools', () => {
    it('an agent tool call creates a project-scoped gallery attributed to the agent', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        { type: 'gallery', title: '__mtest__ agent gallery', content: GALLERY_TWO_ITEMS, projectId },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      const artifactId = result.data?.artifactId as string;
      expect(artifactId).toBeTruthy();

      const created = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);
      expect(created.body.data.type).toBe('gallery');
      expect(created.body.data.version).toBe(1);
      expect(created.body.data.projectId).toBe(projectId);
      expect(created.body.data.createdByAgentId).toBe(agentId);
      expect(created.body.data.createdByUserId).toBeNull();
      expect(created.body.data.content.items).toHaveLength(2);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
      expect(revs.body.data[0].editedByAgentId).toBe(agentId);
    });

    it('the agent tool rejects a gallery with an item missing url', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'gallery',
          title: '__mtest__ bad agent gallery',
          content: { items: [{ id: 'i9', type: 'image' }] },
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('400');
    });

    it('an agent update bumps the version and records editSource=agent', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.update',
        { artifactId: id, version: 1, content: GALLERY_TWO_ITEMS, message: 'agent added items' },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      expect(result.data?.version).toBe(2);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      const agentRev = revs.body.data[1];
      expect(agentRev.version).toBe(2);
      expect(agentRev.editSource).toBe('agent');
      expect(agentRev.editedByAgentId).toBe(agentId);
      expect(agentRev.editedByUserId).toBeNull();
      expect(agentRev.content).toEqual(GALLERY_TWO_ITEMS);
    });

    it('an agent-authored gallery via the X-Eidolon-Agent-Id header records agent source', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ type: 'gallery', title: '__mtest__ Header Gallery', content: GALLERY_TWO_ITEMS, projectId })
        .expect(201);
      expect(res.body.data.createdByAgentId).toBe(agentId);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${res.body.data.id}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
    });
  });

  // =========================================================================
  // VAL-M5-006: realtime artifact.* events fire for gallery create/update/delete
  // =========================================================================

  describe('VAL-M5-006 (gallery): realtime artifact.* events', () => {
    it('emits artifact.created + artifact.revision.created on gallery create', async () => {
      const events = await captureEvents(async () => {
        await createGallery().expect(201);
      });
      const created = events.filter((e) => e.type === 'artifact.created');
      expect(created).toHaveLength(1);
      expect(created[0].companyId).toBe(companyId);
      expect(
        (created[0].payload as { artifact: { type: string } }).artifact.type,
      ).toBe('gallery');
      expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
    });

    it('emits artifact.updated on gallery update and none on a rejected update', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;

      const okEvents = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: GALLERY_TWO_ITEMS, version: 1 })
          .expect(200);
      });
      expect(okEvents.filter((e) => e.type === 'artifact.updated')).toHaveLength(1);

      const badEvents = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: { items: [{ id: 'i9', type: 'image' }] }, version: 2 })
          .expect(400);
      });
      expect(badEvents.filter((e) => e.type.startsWith('artifact.'))).toHaveLength(0);
    });

    it('emits artifact.deleted on gallery delete', async () => {
      const created = await createGallery().expect(201);
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
  });

  // =========================================================================
  // VAL-M5-002: CRUD round-trip for gallery
  // =========================================================================

  describe('VAL-M5-002 (gallery): create/list/get/update/delete round-trip', () => {
    it('supports the full CRUD round-trip', async () => {
      const created = await createGallery().expect(201);
      const id = created.body.data.id;
      expect(created.body.data.version).toBe(1);

      const got = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(got.body.data.content).toEqual(GALLERY_EMPTY);

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: GALLERY_TWO_ITEMS, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.content).toEqual(GALLERY_TWO_ITEMS);

      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);

      // default list excludes deleted
      const active = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=gallery`)
        .expect(200);
      expect(active.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
    });
  });
});
