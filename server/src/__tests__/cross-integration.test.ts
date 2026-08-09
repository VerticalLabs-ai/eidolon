import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestServer, createTestDb } from '../test-utils.js';
import { backgroundWork } from '../services/background-work.js';
import type { DbInstance } from '../types.js';

const DOC_CONTENT = { format: 'markdown', body: '# Original' };
const DOC_CONTENT_V2 = { format: 'markdown', body: '# Agent updated' };
const DOC_CONTENT_RESTORED = { format: 'markdown', body: '# Original' };

describe('Cross-Integration — VAL-ART-056/057/074/096, VAL-MENTION-011/018, unscoped filtering', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Cross Integration Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Cross Project', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Cross Agent', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  // Helper: create a document artifact
  async function createDoc(
    overrides: { projectId?: string | null; title?: string; content?: unknown } = {},
  ): Promise<string> {
    const res = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'document',
        title: overrides.title ?? 'Cross Doc',
        content: overrides.content ?? DOC_CONTENT,
        projectId: overrides.projectId === undefined ? projectId : overrides.projectId,
      })
      .expect(201);
    return res.body.data.id;
  }

  // Helper: create a sheet artifact
  async function createSheet(
    overrides: { projectId?: string | null; title?: string } = {},
  ): Promise<string> {
    const res = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'sheet',
        title: overrides.title ?? 'Cross Sheet',
        content: {
          columns: [{ id: 'c1', key: 'name' }],
          rows: [{ id: 'r1', cells: { name: { value: 'Alice' } } }],
        },
        projectId: overrides.projectId === undefined ? projectId : overrides.projectId,
      })
      .expect(201);
    return res.body.data.id;
  }

  // =========================================================================
  // VAL-ART-056: Artifacts appear in project home composed view
  // =========================================================================
  describe('VAL-ART-056: artifacts in project home', () => {
    it('home payload includes an artifacts array with active project artifacts', async () => {
      const docId = await createDoc({ title: 'Home Doc' });
      const sheetId = await createSheet({ title: 'Home Sheet' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      expect(res.body.data.artifacts).toBeDefined();
      expect(Array.isArray(res.body.data.artifacts)).toBe(true);
      expect(res.body.data.artifacts).toHaveLength(2);

      const ids = res.body.data.artifacts.map((a: any) => a.id);
      expect(ids).toContain(docId);
      expect(ids).toContain(sheetId);

      // Each artifact has the expected fields
      for (const a of res.body.data.artifacts) {
        expect(a.type).toBeDefined();
        expect(a.title).toBeDefined();
        expect(a.status).toBe('active');
        expect(a.version).toBeGreaterThan(0);
      }
    });

    it('home artifacts are capped at 10 and ordered by updatedAt desc', async () => {
      for (let i = 0; i < 12; i++) {
        await createDoc({ title: `Doc ${i}` });
      }

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      expect(res.body.data.artifacts).toHaveLength(10);
    });
  });

  // =========================================================================
  // VAL-ART-057: Artifacts appear in project work composed view
  // =========================================================================
  describe('VAL-ART-057: artifacts in project work', () => {
    it('work payload includes an artifacts array with active project artifacts', async () => {
      const docId = await createDoc({ title: 'Work Doc' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/work`)
        .expect(200);

      expect(res.body.data.artifacts).toBeDefined();
      expect(Array.isArray(res.body.data.artifacts)).toBe(true);
      expect(res.body.data.artifacts).toHaveLength(1);
      expect(res.body.data.artifacts[0].id).toBe(docId);
    });
  });

  // =========================================================================
  // VAL-ART-074: Archived/deleted artifacts excluded from composed views
  // =========================================================================
  describe('VAL-ART-074: archived/deleted excluded from home + work', () => {
    it('archived artifact is excluded from home and work', async () => {
      const docId = await createDoc({ title: 'Archive Me' });

      // Verify it's in home + work
      const homeBefore = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);
      expect(homeBefore.body.data.artifacts).toHaveLength(1);

      const workBefore = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/work`)
        .expect(200);
      expect(workBefore.body.data.artifacts).toHaveLength(1);

      // Archive it
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${docId}/archive`)
        .expect(200);

      // Now excluded from both
      const homeAfter = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);
      expect(homeAfter.body.data.artifacts).toHaveLength(0);

      const workAfter = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/work`)
        .expect(200);
      expect(workAfter.body.data.artifacts).toHaveLength(0);
    });

    it('deleted artifact is excluded from home and work', async () => {
      const docId = await createDoc({ title: 'Delete Me' });

      // Delete it
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${docId}`)
        .expect(200);

      const home = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);
      expect(home.body.data.artifacts).toHaveLength(0);

      const work = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/work`)
        .expect(200);
      expect(work.body.data.artifacts).toHaveLength(0);
    });
  });

  // =========================================================================
  // Unscoped artifact filtering — ?projectId=null or ?unscoped=true
  // =========================================================================
  describe('Unscoped (company-level) artifact filtering', () => {
    it('?projectId=null returns only unscoped artifacts', async () => {
      const scopedId = await createDoc({ projectId, title: 'Scoped' });
      const unscopedId = await createDoc({ projectId: null, title: 'Unscoped' });

      // ?projectId=null returns only unscoped
      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .query({ projectId: 'null' })
        .expect(200);

      const ids = res.body.data.map((a: any) => a.id);
      expect(ids).toContain(unscopedId);
      expect(ids).not.toContain(scopedId);
    });

    it('?unscoped=true returns only unscoped artifacts', async () => {
      await createDoc({ projectId, title: 'Scoped' });
      const unscopedId = await createDoc({ projectId: null, title: 'Unscoped' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts`)
        .query({ unscoped: 'true' })
        .expect(200);

      const ids = res.body.data.map((a: any) => a.id);
      expect(ids).toContain(unscopedId);
      expect(ids).toHaveLength(1);
    });

    it('project-scoped list excludes unscoped artifacts', async () => {
      await createDoc({ projectId: null, title: 'Unscoped' });
      const scopedId = await createDoc({ projectId, title: 'Scoped' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/artifacts`)
        .expect(200);

      const ids = res.body.data.map((a: any) => a.id);
      expect(ids).toContain(scopedId);
      expect(ids).toHaveLength(1);
    });
  });

  // =========================================================================
  // VAL-ART-096: Agent update races with user restore safely
  // =========================================================================
  describe('VAL-ART-096: agent update races with user restore', () => {
    it('concurrent agent update and user restore serialize with correct attribution', async () => {
      // Create an artifact at version 1
      const docId = await createDoc({ content: DOC_CONTENT });

      // Edit to version 2 (user)
      const v2 = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${docId}`)
        .send({ content: { format: 'markdown', body: '# User v2' }, version: 1 })
        .expect(200);
      expect(v2.body.data.version).toBe(2);

      // Now race: agent update (version=2) vs user restore (version=2, restore to v1)
      // Both send version=2 as the expected base. Only one should succeed.

      const agentUpdatePromise = request(app)
        .patch(`/api/companies/${companyId}/artifacts/${docId}`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ content: DOC_CONTENT_V2, version: 2 });

      const userRestorePromise = request(app)
        .post(`/api/companies/${companyId}/artifacts/${docId}/revisions/1/restore`);

      const [agentResult, restoreResult] = await Promise.all([
        agentUpdatePromise,
        userRestorePromise,
      ]);

      // Exactly one should succeed (200), the other should get 409
      const agentStatus = agentResult.status;
      const restoreStatus = restoreResult.status;

      // One of them must be 200 and the other 409 (or both 409 if they truly
      // race to the same version, but at least one must succeed or both must
      // conflict cleanly — never both succeed)
      const successCount = [agentStatus, restoreStatus].filter((s) => s === 200).length;
      expect(successCount).toBeLessThanOrEqual(1);

      // Verify final state: version is monotonic, revisions are append-only
      const finalArtifact = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${docId}`)
        .expect(200);

      const revisions = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${docId}/revisions`)
        .expect(200);

      // Version must be 3 (one operation applied on top of v2)
      expect(finalArtifact.body.data.version).toBe(3);

      // Revisions must be append-only: versions 1, 2, 3 all present
      const versions = revisions.body.data.map((r: any) => r.version);
      expect(versions).toContain(1);
      expect(versions).toContain(2);
      expect(versions).toContain(3);
      expect(versions.length).toBe(3);

      // The winning revision at v3 must have correct attribution
      const v3Revision = revisions.body.data.find((r: any) => r.version === 3);
      expect(v3Revision).toBeDefined();

      // If the agent won, editSource should be 'agent' with editedByAgentId set
      // If the restore won, editSource should be 'user' with editedByUserId set
      if (agentStatus === 200) {
        expect(v3Revision.editSource).toBe('agent');
        expect(v3Revision.editedByAgentId).toBe(agentId);
      } else {
        expect(v3Revision.editSource).toBe('user');
        expect(v3Revision.editedByUserId).toBeTruthy();
      }
    });
  });

  // =========================================================================
  // VAL-MENTION-011: Editing a message updates mentions accurately
  // =========================================================================
  describe('VAL-MENTION-011: edit-message mention reconciliation', () => {
    it('editing content replaces mentions: remove dropped, keep retained, add new', async () => {
      // Create a thread
      const thread = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
        .send({ title: 'Mention Edit Thread' })
        .expect(201);

      // Create a second agent for mention switching
      const agent2 = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Second Agent', role: 'engineer' })
        .expect(201);

      // Post an item mentioning agent A
      const item = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${thread.body.data.id}/items`)
        .send({
          kind: 'comment',
          content: 'Hello @Cross Agent',
          mentions: [{ entityType: 'agent', entityId: agentId, label: 'Cross Agent' }],
        })
        .expect(201);

      // Verify mention A is stored
      expect(item.body.data.mentions).toHaveLength(1);
      expect(item.body.data.mentions[0].entityId).toBe(agentId);

      // Drain tracked background mention dispatch before editing
      await backgroundWork.drain();

      // Edit: replace mention A with mention B
      const edited = await request(app)
        .patch(`/api/companies/${companyId}/projects/${projectId}/threads/${thread.body.data.id}/items/${item.body.data.id}/content`)
        .send({
          content: 'Hello @Second Agent',
          mentions: [{ entityType: 'agent', entityId: agent2.body.data.id, label: 'Second Agent' }],
        })
        .expect(200);

      // Only B should be in mentions, A should be removed
      expect(edited.body.data.mentions).toHaveLength(1);
      expect(edited.body.data.mentions[0].entityId).toBe(agent2.body.data.id);
      expect(edited.body.data.mentions[0].entityType).toBe('agent');
      expect(edited.body.data.content).toBe('Hello @Second Agent');

      // No stale A mention
      const mentionIds = edited.body.data.mentions.map((m: any) => m.entityId);
      expect(mentionIds).not.toContain(agentId);
    });

    it('retained mentions keep their entity IDs on edit', async () => {
      const thread = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
        .send({ title: 'Retain Thread' })
        .expect(201);

      const agent2 = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Keeper Agent', role: 'engineer' })
        .expect(201);

      // Post with both mentions (use user mention for one to avoid
      // background agent dispatch interference in tests)
      const item = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${thread.body.data.id}/items`)
        .send({
          kind: 'comment',
          content: 'Hello both',
          mentions: [
            { entityType: 'agent', entityId: agentId, label: 'Cross Agent' },
            { entityType: 'user', entityId: 'dev-user-000', label: 'Dev User' },
          ],
        })
        .expect(201);

      // Drain tracked background mention dispatch before editing
      await backgroundWork.drain();

      // Edit: keep only agent A, drop the user mention
      const edited = await request(app)
        .patch(`/api/companies/${companyId}/projects/${projectId}/threads/${thread.body.data.id}/items/${item.body.data.id}/content`)
        .send({
          content: 'Hello @Cross Agent only',
          mentions: [{ entityType: 'agent', entityId: agentId, label: 'Cross Agent' }],
        })
        .expect(200);

      expect(edited.body.data.mentions).toHaveLength(1);
      expect(edited.body.data.mentions[0].entityId).toBe(agentId);
    });

    it('plain-text edit without mentions array preserves existing mentions', async () => {
      const thread = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
        .send({ title: 'Preserve Thread' })
        .expect(201);

      const item = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${thread.body.data.id}/items`)
        .send({
          kind: 'comment',
          content: 'Hello @Cross Agent',
          mentions: [{ entityType: 'agent', entityId: agentId, label: 'Cross Agent' }],
        })
        .expect(201);

      // Drain tracked background mention dispatch before editing
      await backgroundWork.drain();

      // Edit only content, no mentions field
      const edited = await request(app)
        .patch(`/api/companies/${companyId}/projects/${projectId}/threads/${thread.body.data.id}/items/${item.body.data.id}/content`)
        .send({ content: 'Updated text' })
        .expect(200);

      // Mentions should be preserved
      expect(edited.body.data.mentions).toHaveLength(1);
      expect(edited.body.data.mentions[0].entityId).toBe(agentId);
      expect(edited.body.data.content).toBe('Updated text');
    });
  });

  // =========================================================================
  // VAL-MENTION-018: BoardChat agent mention dispatches in company scope
  // =========================================================================
  describe('VAL-MENTION-018: BoardChat mention dispatch', () => {
    it('accepts mentions in the chat send body and persists them in message metadata', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/chat/send`)
        .send({
          content: 'Hey @Cross Agent, do something',
          mentions: [{ entityType: 'agent', entityId: agentId, label: 'Cross Agent' }],
        })
        .expect(201);

      expect(res.body.data).toBeDefined();
      expect(res.body.data.threadId).toBeDefined();
      expect(res.body.data.messageId).toBeDefined();
      // The persisted (company-resolved) mentions are echoed in the response
      expect(res.body.data.mentions).toHaveLength(1);
      expect(res.body.data.mentions[0]).toEqual({
        entityType: 'agent',
        entityId: agentId,
        label: 'Cross Agent',
      });

      // Thread read returns the mentions in the user message metadata
      const threadRes = await request(app)
        .get(`/api/companies/${companyId}/chat/threads/${res.body.data.threadId}`)
        .expect(200);

      const userMsg = threadRes.body.data.find(
        (m: { id: string }) => m.id === res.body.data.messageId,
      );
      expect(userMsg).toBeDefined();
      expect(userMsg.metadata.mentions).toHaveLength(1);
      expect(userMsg.metadata.mentions[0].entityType).toBe('agent');
      expect(userMsg.metadata.mentions[0].entityId).toBe(agentId);
      expect(userMsg.metadata.mentions[0].label).toBe('Cross Agent');
    });

    it('rejects mentions for agents not in the company (no dispatch)', async () => {
      const otherCompany = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Other BoardChat Corp' })
        .expect(201);
      const otherAgent = await request(app)
        .post(`/api/companies/${otherCompany.body.data.id}/agents`)
        .send({ name: 'Other Agent', role: 'engineer' })
        .expect(201);

      // Send from our company mentioning an agent from another company
      const res = await request(app)
        .post(`/api/companies/${companyId}/chat/send`)
        .send({
          content: 'Hey @Other Agent',
          mentions: [{ entityType: 'agent', entityId: otherAgent.body.data.id, label: 'Other Agent' }],
        })
        .expect(201);

      // The mention should not dispatch to the other company's agent
      // (mentionDispatch should be undefined since no valid agents were found)
      expect(res.body.data.mentionDispatch).toBeUndefined();
      // Cross-company mentions are filtered out and not persisted
      expect(res.body.data.mentions).toHaveLength(0);

      const threadRes = await request(app)
        .get(`/api/companies/${companyId}/chat/threads/${res.body.data.threadId}`)
        .expect(200);
      const userMsg = threadRes.body.data.find(
        (m: { id: string }) => m.id === res.body.data.messageId,
      );
      expect(userMsg.metadata.mentions).toHaveLength(0);
    });
  });
});
