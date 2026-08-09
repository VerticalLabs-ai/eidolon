import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import { ArtifactToolService } from '../services/artifact-tools.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// App artifact payloads
// ---------------------------------------------------------------------------

const APP_ONE_FILE = {
  definition: { name: 'demo', entrypoint: 'index.html' },
  files: [{ path: 'index.html', content: '<h1>Hello</h1>' }],
};

const APP_TWO_FILES = {
  definition: { name: 'demo2', entrypoint: 'index.html' },
  files: [
    { path: 'index.html', content: '<h1>Updated</h1>' },
    { path: 'style.css', content: 'body{color:red}' },
  ],
};

const APP_EMPTY = { definition: {}, files: [] };

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
// Suite — VAL-APP-001..007 + M5 shared behaviors
// ---------------------------------------------------------------------------

describe('App artifact API — real-Postgres integration', () => {
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
      .send({ name: '__mtest__ App Corp', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ App Other Corp', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'App Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const project2 = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'App Proj 2', status: 'active' })
      .expect(201);
    secondProjectId = project2.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'App Other Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'App Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  function createApp(
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
        type: 'app',
        title: overrides.title ?? '__mtest__ M5 app',
        content: overrides.content ?? APP_ONE_FILE,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // VAL-APP-001: create an app artifact with a definition and one file
  // =========================================================================

  describe('VAL-APP-001: create an app artifact with a definition and one file', () => {
    it('creates an app at version 1 scoped to the project with content echoed', async () => {
      const res = await createApp({ title: '__mtest__ M5 app' }).expect(201);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.type).toBe('app');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.contentSchemaVersion).toBe(1);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.projectId).toBe(projectId);
      expect(res.body.data.content.definition).toEqual({ name: 'demo', entrypoint: 'index.html' });
      expect(res.body.data.content.files).toEqual([{ path: 'index.html', content: '<h1>Hello</h1>' }]);
    });

    it('lists the app under the type=app filter', async () => {
      const created = await createApp().expect(201);
      const listed = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=app`)
        .expect(200);
      expect(listed.body.data.map((a: { id: string }) => a.id)).toContain(created.body.data.id);
    });

    it('does not list the app under a different type filter', async () => {
      await createApp().expect(201);
      const docs = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=document`)
        .expect(200);
      expect(docs.body.data).toHaveLength(0);
    });
  });

  // =========================================================================
  // VAL-APP-002: app content schema validates required fields
  // =========================================================================

  describe('VAL-APP-002: app content schema validates required fields', () => {
    it('accepts an empty definition with empty files', async () => {
      const res = await createApp({ content: APP_EMPTY }).expect(201);
      expect(res.body.data.content).toEqual(APP_EMPTY);
    });

    it('rejects a file missing path with 400', async () => {
      const res = await createApp({
        content: { definition: {}, files: [{ content: 'x' }] },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a file missing content with 400', async () => {
      const res = await createApp({
        content: { definition: {}, files: [{ path: 'a' }] },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a file with an empty path with 400', async () => {
      const res = await createApp({
        content: { definition: {}, files: [{ path: '', content: 'x' }] },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects duplicate file paths with 400', async () => {
      const res = await createApp({
        content: {
          definition: {},
          files: [
            { path: 'index.html', content: 'a' },
            { path: 'index.html', content: 'b' },
          ],
        },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects content missing definition with 400', async () => {
      const res = await createApp({
        content: { files: [] },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects content missing files with 400', async () => {
      const res = await createApp({
        content: { definition: {} },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a PATCH with a file missing path with 400 and does not bump version', async () => {
      const created = await createApp().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: { definition: {}, files: [{ content: 'no path' }] },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');

      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      expect(after.body.data.content).toEqual(APP_ONE_FILE);
    });
  });

  // =========================================================================
  // VAL-APP-005: edit definition + file content; changes persist
  // =========================================================================

  describe('VAL-APP-005: edit definition and file content; changes persist', () => {
    it('patches definition name, file content, and adds a second file — version bumps to 2', async () => {
      const created = await createApp().expect(201);
      const id = created.body.data.id;

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: APP_TWO_FILES, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.content.definition.name).toBe('demo2');
      expect(patched.body.data.content.files).toHaveLength(2);
      expect(patched.body.data.content.files[0].content).toBe('<h1>Updated</h1>');
      expect(patched.body.data.content.files[1].path).toBe('style.css');

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.definition.name).toBe('demo2');
      expect(reopened.body.data.content.files).toHaveLength(2);
    });
  });

  // =========================================================================
  // VAL-APP-006: versioning — full snapshots; restore recovers prior state
  // =========================================================================

  describe('VAL-APP-006: versioning — app revisions snapshot definition + files; restore recovers prior state', () => {
    it('each revision is a full snapshot and restore recovers v1 state as a new version', async () => {
      // v1: one file
      const created = await createApp().expect(201);
      const id = created.body.data.id;
      // v2: two files + renamed definition
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: APP_TWO_FILES, version: 1 })
        .expect(200);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2]);
      // v1 revision is a full snapshot with one file
      expect(revs.body.data[0].content.files).toHaveLength(1);
      expect(revs.body.data[0].content.definition).toEqual({ name: 'demo', entrypoint: 'index.html' });
      // v2 revision has two files
      expect(revs.body.data[1].content.files).toHaveLength(2);

      // Restore v1 (one file) -> v3 with exactly the v1 files
      const restored = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      expect(restored.body.data.version).toBe(3);
      expect(restored.body.data.content.files).toHaveLength(1);
      expect(restored.body.data.content.files[0].path).toBe('index.html');
      expect(restored.body.data.content.definition).toEqual({ name: 'demo', entrypoint: 'index.html' });

      // v1 revision row unchanged (append-only)
      const rev1 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/1`)
        .expect(200);
      expect(rev1.body.data.content.files).toHaveLength(1);

      // full list is [1,2,3]
      const revsAfter = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revsAfter.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2, 3]);
    });
  });

  // =========================================================================
  // VAL-APP-007: agent authors a simple app
  // =========================================================================

  describe('VAL-APP-007: agent authors a simple app via artifact.create tool', () => {
    it('an agent tool call creates a project-scoped app attributed to the agent', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'app',
          title: '__mtest__ agent app',
          content: {
            definition: { name: 'agent-app', entrypoint: 'index.html' },
            files: [{ path: 'index.html', content: '<h2>Agent-built</h2>' }],
          },
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      const artifactId = result.data?.artifactId as string;
      expect(artifactId).toBeTruthy();

      const created = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);
      expect(created.body.data.type).toBe('app');
      expect(created.body.data.version).toBe(1);
      expect(created.body.data.projectId).toBe(projectId);
      expect(created.body.data.createdByAgentId).toBe(agentId);
      expect(created.body.data.createdByUserId).toBeNull();
      expect(created.body.data.content.definition).toEqual({ name: 'agent-app', entrypoint: 'index.html' });
      expect(created.body.data.content.files[0].content).toBe('<h2>Agent-built</h2>');

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
      expect(revs.body.data[0].editedByAgentId).toBe(agentId);
    });

    it('the agent tool rejects an app with a file missing path', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'app',
          title: '__mtest__ bad agent app',
          content: {
            definition: {},
            files: [{ content: 'no path' }],
          },
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('400');
    });

    it('an agent update bumps the version and records editSource=agent', async () => {
      const created = await createApp().expect(201);
      const id = created.body.data.id;

      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.update',
        { artifactId: id, version: 1, content: APP_TWO_FILES, message: 'agent added a file' },
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
      expect(agentRev.content.files).toHaveLength(2);
    });

    it('an agent-authored app via X-Eidolon-Agent-Id header records agent source', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ type: 'app', title: '__mtest__ Header App', content: APP_ONE_FILE, projectId })
        .expect(201);
      expect(res.body.data.createdByAgentId).toBe(agentId);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${res.body.data.id}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
    });
  });

  // =========================================================================
  // VAL-M5-002: CRUD round-trip for app
  // =========================================================================

  describe('VAL-M5-002 (app): create/list/get/update/delete round-trip', () => {
    it('supports the full CRUD round-trip', async () => {
      const created = await createApp().expect(201);
      const id = created.body.data.id;
      expect(created.body.data.version).toBe(1);

      const got = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(got.body.data.content).toEqual(APP_ONE_FILE);

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: APP_TWO_FILES, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);

      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);

      const active = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=app`)
        .expect(200);
      expect(active.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
    });
  });

  // =========================================================================
  // VAL-M5-004: version + append-only revision per save
  // =========================================================================

  describe('VAL-M5-004 (app): version + append-only revision per save', () => {
    it('create -> v1 + 1 revision; PATCH -> v2 + 1 revision (editSource=user)', async () => {
      const created = await createApp().expect(201);
      const id = created.body.data.id;

      const initialRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(initialRevs.body.data).toHaveLength(1);
      expect(initialRevs.body.data[0].version).toBe(1);
      expect(initialRevs.body.data[0].editSource).toBe('user');
      expect(initialRevs.body.data[0].content).toEqual(APP_ONE_FILE);

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: APP_TWO_FILES, version: 1 })
        .expect(200);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(2);
      expect(revs.body.data[1].version).toBe(2);
      expect(revs.body.data[1].editSource).toBe('user');
      expect(revs.body.data[1].content.files).toHaveLength(2);
    });

    it('rejects a stale optimistic version with 409', async () => {
      const created = await createApp().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: APP_TWO_FILES, version: 1 })
        .expect(200);

      const stale = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: APP_EMPTY, version: 1 })
        .expect(409);
      expect(stale.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
      expect(stale.body.details.current.version).toBe(2);
    });
  });

  // =========================================================================
  // VAL-M5-005: project + company isolation
  // =========================================================================

  describe('VAL-M5-005 (app): project + company isolation', () => {
    it('does not return an app from another company', async () => {
      const created = await createApp().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);
      const otherList = await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts?type=app`)
        .expect(200);
      expect(otherList.body.data).toHaveLength(0);
    });

    it('cannot create an app scoped to a project in another company', async () => {
      await createApp({ projectId: otherProjectId }).expect(404);
    });

    it('a project-scoped list returns only that project apps', async () => {
      const inProject = await createApp({ title: '__mtest__ App P1' }).expect(201);
      const inSecond = await createApp({
        title: '__mtest__ App P2',
        projectId: secondProjectId,
      }).expect(201);
      const unscoped = await createApp({ title: '__mtest__ App none', projectId: null }).expect(201);

      const p1 = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/artifacts`)
        .expect(200);
      const p1Ids = p1.body.data.map((a: { id: string }) => a.id);
      expect(p1Ids).toContain(inProject.body.data.id);
      expect(p1Ids).not.toContain(inSecond.body.data.id);
      expect(p1Ids).not.toContain(unscoped.body.data.id);
    });

    it('appears in the project home composed view', async () => {
      const created = await createApp().expect(201);
      const home = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);
      const ids = home.body.data.artifacts.map((a: { id: string }) => a.id);
      expect(ids).toContain(created.body.data.id);
    });
  });

  // =========================================================================
  // VAL-M5-006: realtime artifact.* events
  // =========================================================================

  describe('VAL-M5-006 (app): realtime artifact.* events', () => {
    it('emits artifact.created + artifact.revision.created on app create', async () => {
      const events = await captureEvents(async () => {
        await createApp().expect(201);
      });
      const created = events.filter((e) => e.type === 'artifact.created');
      expect(created).toHaveLength(1);
      expect(created[0].companyId).toBe(companyId);
      expect(
        (created[0].payload as { artifact: { type: string } }).artifact.type,
      ).toBe('app');
      expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
    });

    it('emits artifact.updated on app update', async () => {
      const created = await createApp().expect(201);
      const id = created.body.data.id;

      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: APP_TWO_FILES, version: 1 })
          .expect(200);
      });
      expect(events.filter((e) => e.type === 'artifact.updated')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
    });

    it('emits artifact.deleted on app delete', async () => {
      const created = await createApp().expect(201);
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
});
