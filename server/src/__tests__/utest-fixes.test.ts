import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestServer, createTestDb } from '../test-utils.js';
import { eventBus } from '../realtime/events.js';
import { MentionService } from '../services/mention-service.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// User-testing fix integration tests — four failed assertion fixes:
//
//   (1) VAL-ART-058/072: project DELETE nulls artifacts.project_id
//   (2) VAL-ART-061: artifact.revision.created WS event includes editSource
//   (3) VAL-ART-098: X-Eidolon-Agent-Id present but agent not in company → 403
//   (4) VAL-MENTION-011: removing an agent mention cancels queued dispatch
// ---------------------------------------------------------------------------

const DOC_CONTENT = { format: 'markdown' as const, body: '# Hello' };
const DOC_CONTENT_V2 = { format: 'markdown' as const, body: '# Updated' };

/** Collect EventBus events emitted during an async operation. */
async function captureEvents<T extends EidolonEvent = EidolonEvent>(
  fn: () => Promise<void>,
): Promise<T[]> {
  const events: T[] = [];
  const handler = (event: EidolonEvent) => events.push(event as T);
  eventBus.onEvent(handler);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    eventBus.off('event', handler);
  }
  return events;
}

function filterEvents<T extends EidolonEvent>(
  events: T[],
  type: string,
): T[] {
  return events.filter((e) => e.type === type);
}

describe('User-testing fixes — integration tests', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let agentId: string;
  let threadId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ UTest Fix Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ UTest Other Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'UTest Fix Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'UTest Fix Agent',
        role: 'engineer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      })
      .expect(201);
    agentId = agent.body.data.id;

    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'UTest Fix Thread', type: 'conversation' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  // =========================================================================
  // Fix 1: VAL-ART-058/072 — project DELETE nulls artifacts.project_id
  // =========================================================================

  describe('Fix 1: project DELETE nulls artifacts.project_id (VAL-ART-058/072)', () => {
    it('deleting a project clears artifact projectId to null', async () => {
      // Create a project-scoped artifact
      const createRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ Project Doc',
          content: DOC_CONTENT,
          projectId,
        })
        .expect(201);

      const aid = createRes.body.data.id;
      expect(createRes.body.data.projectId).toBe(projectId);

      // Delete the project (archives it)
      await request(app)
        .delete(`/api/companies/${companyId}/projects/${projectId}`)
        .expect(200);

      // Artifact's projectId should now be null
      const getRes = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${aid}`)
        .expect(200);

      expect(getRes.body.data.projectId).toBeNull();
      expect(getRes.body.data.status).toBe('active');
    });

    it('re-scoped artifact remains accessible at company level', async () => {
      const createRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ Company Rescope Doc',
          content: DOC_CONTENT,
          projectId,
        })
        .expect(201);
      const aid = createRes.body.data.id;

      await request(app)
        .delete(`/api/companies/${companyId}/projects/${projectId}`)
        .expect(200);

      // Company-level list (unscoped) should include the re-scoped artifact
      const listRes = await request(app)
        .get(`/api/companies/${companyId}/artifacts?unscoped=true`)
        .expect(200);

      const found = listRes.body.data.find((a: any) => a.id === aid);
      expect(found).toBeDefined();
      expect(found.projectId).toBeNull();
    });

    it('re-scoped artifact retains full revision history', async () => {
      const createRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ History Doc',
          content: DOC_CONTENT,
          projectId,
        })
        .expect(201);
      const aid = createRes.body.data.id;

      // Edit to version 2
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${aid}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);

      // Delete the project
      await request(app)
        .delete(`/api/companies/${companyId}/projects/${projectId}`)
        .expect(200);

      // Revisions should still be intact
      const revRes = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${aid}/revisions`)
        .expect(200);

      expect(revRes.body.data).toHaveLength(2);
      expect(revRes.body.data[0].version).toBe(1);
      expect(revRes.body.data[1].version).toBe(2);
    });

    it('edit after re-scope succeeds and increments version (VAL-ART-072)', async () => {
      const createRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ Edit After Rescope',
          content: DOC_CONTENT,
          projectId,
        })
        .expect(201);
      const aid = createRes.body.data.id;
      expect(createRes.body.data.version).toBe(1);

      // Delete the project → artifact re-scoped to company level
      await request(app)
        .delete(`/api/companies/${companyId}/projects/${projectId}`)
        .expect(200);

      // Edit the re-scoped artifact — should succeed and increment version
      const patchRes = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${aid}`)
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(200);

      expect(patchRes.body.data.version).toBe(2);
      expect(patchRes.body.data.projectId).toBeNull();
    });

    it('only artifacts of the deleted project are re-scoped (other projects untouched)', async () => {
      const otherProject = await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'UTest Other Proj', status: 'active' })
        .expect(201);
      const otherPid = otherProject.body.data.id;

      // Artifact in the project to be deleted
      const doc1 = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Doc1', content: DOC_CONTENT, projectId })
        .expect(201);

      // Artifact in a different project
      const doc2 = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Doc2', content: DOC_CONTENT, projectId: otherPid })
        .expect(201);

      // Delete the first project
      await request(app)
        .delete(`/api/companies/${companyId}/projects/${projectId}`)
        .expect(200);

      // doc1 should be re-scoped (projectId null)
      const get1 = await request(app).get(`/api/companies/${companyId}/artifacts/${doc1.body.data.id}`).expect(200);
      expect(get1.body.data.projectId).toBeNull();

      // doc2 should still be scoped to otherPid
      const get2 = await request(app).get(`/api/companies/${companyId}/artifacts/${doc2.body.data.id}`).expect(200);
      expect(get2.body.data.projectId).toBe(otherPid);
    });
  });

  // =========================================================================
  // Fix 2: VAL-ART-061 — revision.created event includes editSource
  // =========================================================================

  describe('Fix 2: revision.created event includes editSource (VAL-ART-061)', () => {
    it('revision.created event on create includes editSource=user', async () => {
      const events = await captureEvents(async () => {
        await request(app)
          .post(`/api/companies/${companyId}/artifacts`)
          .send({ type: 'document', title: '__mtest__ EditSrc Create', content: DOC_CONTENT, projectId })
          .expect(201);
      });

      const revEvents = filterEvents(events, 'artifact.revision.created');
      expect(revEvents.length).toBe(1);
      expect(revEvents[0].payload.artifact).toHaveProperty('editSource', 'user');
      expect(revEvents[0].payload.artifact).toHaveProperty('version', 1);
    });

    it('revision.created event on PATCH includes editSource=user', async () => {
      const createRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ EditSrc Patch', content: DOC_CONTENT, projectId })
        .expect(201);
      const aid = createRes.body.data.id;

      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${aid}`)
          .send({ content: DOC_CONTENT_V2, version: 1 })
          .expect(200);
      });

      const revEvents = filterEvents(events, 'artifact.revision.created');
      expect(revEvents.length).toBe(1);
      expect(revEvents[0].payload.artifact).toHaveProperty('editSource', 'user');
      expect(revEvents[0].payload.artifact).toHaveProperty('version', 2);
    });

    it('revision.created event on agent-authored create includes editSource=agent', async () => {
      const events = await captureEvents(async () => {
        await request(app)
          .post(`/api/companies/${companyId}/artifacts`)
          .set('X-Eidolon-Agent-Id', agentId)
          .send({ type: 'document', title: '__mtest__ EditSrc Agent', content: DOC_CONTENT, projectId })
          .expect(201);
      });

      const revEvents = filterEvents(events, 'artifact.revision.created');
      expect(revEvents.length).toBe(1);
      expect(revEvents[0].payload.artifact).toHaveProperty('editSource', 'agent');
      expect(revEvents[0].payload.artifact).toHaveProperty('version', 1);
    });

    it('revision.created event on agent-authored PATCH includes editSource=agent', async () => {
      const createRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ type: 'document', title: '__mtest__ EditSrc Agent Patch', content: DOC_CONTENT, projectId })
        .expect(201);
      const aid = createRes.body.data.id;

      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${aid}`)
          .set('X-Eidolon-Agent-Id', agentId)
          .send({ content: DOC_CONTENT_V2, version: 1 })
          .expect(200);
      });

      const revEvents = filterEvents(events, 'artifact.revision.created');
      expect(revEvents.length).toBe(1);
      expect(revEvents[0].payload.artifact).toHaveProperty('editSource', 'agent');
    });
  });

  // =========================================================================
  // Fix 3: VAL-ART-098 — agent header present but not in company → 403
  // =========================================================================

  describe('Fix 3: out-of-company agent header rejected with 403 (VAL-ART-098)', () => {
    it('POST with out-of-company agent header returns 403 and no artifact created', async () => {
      const res = await request(app)
        .post(`/api/companies/${otherCompanyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId) // agent belongs to companyId, not otherCompanyId
        .send({
          type: 'document',
          title: '__mtest__ Should Reject',
          content: DOC_CONTENT,
        })
        .expect(403);

      expect(res.body.code).toBe('AGENT_NOT_IN_COMPANY');

      // Verify no artifact was created in otherCompanyId
      const listRes = await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts`)
        .expect(200);
      expect(listRes.body.data).toHaveLength(0);
    });

    it('PATCH with out-of-company agent header returns 403', async () => {
      // Create artifact in companyId as user
      const createRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Patch Reject', content: DOC_CONTENT, projectId })
        .expect(201);
      const aid = createRes.body.data.id;

      // Try to PATCH with an out-of-company agent header
      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${aid}`)
        .set('X-Eidolon-Agent-Id', randomUUID()) // unknown agent
        .send({ content: DOC_CONTENT_V2, version: 1 })
        .expect(403);

      expect(res.body.code).toBe('AGENT_NOT_IN_COMPANY');

      // Verify artifact was not modified
      const getRes = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${aid}`)
        .expect(200);
      expect(getRes.body.data.version).toBe(1);
    });

    it('DELETE with out-of-company agent header returns 403', async () => {
      const createRes = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Delete Reject', content: DOC_CONTENT, projectId })
        .expect(201);
      const aid = createRes.body.data.id;

      const res = await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${aid}`)
        .set('X-Eidolon-Agent-Id', randomUUID())
        .expect(403);

      expect(res.body.code).toBe('AGENT_NOT_IN_COMPANY');

      // Artifact should still be active (not deleted)
      const getRes = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${aid}`)
        .expect(200);
      expect(getRes.body.data.status).toBe('active');
    });

    it('header ABSENT → normal user-authored flow (no regression)', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ No Header', content: DOC_CONTENT, projectId })
        .expect(201);

      expect(res.body.data.createdByAgentId).toBeNull();
      expect(res.body.data.createdByUserId).toBeDefined();
      expect(res.body.data.version).toBe(1);
    });

    it('header present with valid member agent → agent-authored (no regression)', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ type: 'document', title: '__mtest__ Valid Agent', content: DOC_CONTENT, projectId })
        .expect(201);

      expect(res.body.data.createdByAgentId).toBe(agentId);
      expect(res.body.data.createdByUserId).toBeNull();
    });
  });

  // =========================================================================
  // Fix 4: VAL-MENTION-011 — removing an agent mention cancels queued dispatch
  // =========================================================================

  describe('Fix 4: removing agent mention cancels queued dispatch (VAL-MENTION-011)', () => {
    it('editing to remove a paused agent mention cancels its queued dispatch', async () => {
      // 1. Pause the agent so mentions queue
      await request(app)
        .patch(`/api/companies/${companyId}/agents/${agentId}`)
        .send({ status: 'paused' })
        .expect(200);

      // 2. Post a thread item mentioning the paused agent — queues dispatch
      const createRes = await request(app)
        .post(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`,
        )
        .send({
          kind: 'comment',
          content: 'Hey @UTest Fix Agent, help when you can',
          mentions: [
            { entityType: 'agent', entityId: agentId, label: 'UTest Fix Agent' },
          ],
        })
        .expect(201);

      const itemId = createRes.body.data.id;
      expect(createRes.body.data.mentions).toHaveLength(1);

      // Wait for async queue to process
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify the queued item exists and is unprocessed
      const threadRes1 = await request(app)
        .get(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}`,
        )
        .expect(200);

      const queuedItem = threadRes1.body.data.items.find(
        (i: any) => i.payload?.queuedMention?.agentId === agentId,
      );
      expect(queuedItem).toBeDefined();
      expect(queuedItem.payload.queuedMention.processed).toBeFalsy();
      expect(queuedItem.payload.queuedMention.cancelled).toBeFalsy();

      // 3. Edit the thread item to remove the mention
      await request(app)
        .patch(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items/${itemId}/content`,
        )
        .send({
          content: 'Never mind, I figured it out',
          mentions: [],
        })
        .expect(200);

      // Wait for async cancel to process
      await new Promise((resolve) => setTimeout(resolve, 200));

      // 4. Verify the queued dispatch was cancelled
      const threadRes2 = await request(app)
        .get(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}`,
        )
        .expect(200);

      const cancelledItem = threadRes2.body.data.items.find(
        (i: any) =>
          i.payload?.queuedMention?.agentId === agentId &&
          i.payload?.queuedMention?.cancelled === true,
      );
      expect(cancelledItem).toBeDefined();
      expect(cancelledItem.payload.queuedMention.cancelled).toBe(true);
      expect(cancelledItem.payload.queuedMention.processed).toBeFalsy();
    });

    it('cancelled queued mention is not processed on agent resume', async () => {
      // 1. Pause the agent
      await request(app)
        .patch(`/api/companies/${companyId}/agents/${agentId}`)
        .send({ status: 'paused' })
        .expect(200);

      // 2. Mention the paused agent → queues
      const createRes = await request(app)
        .post(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`,
        )
        .send({
          kind: 'comment',
          content: 'Hey @UTest Fix Agent',
          mentions: [
            { entityType: 'agent', entityId: agentId, label: 'UTest Fix Agent' },
          ],
        })
        .expect(201);

      const itemId = createRes.body.data.id;

      await new Promise((resolve) => setTimeout(resolve, 300));

      // 3. Remove the mention via edit
      await request(app)
        .patch(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items/${itemId}/content`,
        )
        .send({
          content: 'Never mind',
          mentions: [],
        })
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // 4. Resume the agent — the cancelled queued mention should NOT be processed
      await request(app)
        .patch(`/api/companies/${companyId}/agents/${agentId}`)
        .send({ status: 'idle' })
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, 800));

      // 5. Verify the queued item is cancelled but NOT processed (dispatch skipped)
      const threadRes = await request(app)
        .get(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}`,
        )
        .expect(200);

      const queuedItem = threadRes.body.data.items.find(
        (i: any) => i.payload?.queuedMention?.agentId === agentId,
      );
      expect(queuedItem).toBeDefined();
      expect(queuedItem.payload.queuedMention.cancelled).toBe(true);
      expect(queuedItem.payload.queuedMention.processed).toBeFalsy();
      // The content should reflect cancellation, not dispatch processing
      expect(queuedItem.content).toContain('cancelled');
    });

    it('retained agent mention is not cancelled when editing content only', async () => {
      // 1. Pause the agent
      await request(app)
        .patch(`/api/companies/${companyId}/agents/${agentId}`)
        .send({ status: 'paused' })
        .expect(200);

      // 2. Mention the paused agent → queues
      const createRes = await request(app)
        .post(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`,
        )
        .send({
          kind: 'comment',
          content: 'Hey @UTest Fix Agent, please help',
          mentions: [
            { entityType: 'agent', entityId: agentId, label: 'UTest Fix Agent' },
          ],
        })
        .expect(201);

      const itemId = createRes.body.data.id;

      await new Promise((resolve) => setTimeout(resolve, 300));

      // 3. Edit content but KEEP the mention
      await request(app)
        .patch(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items/${itemId}/content`,
        )
        .send({
          content: 'Hey @UTest Fix Agent, please help with the report',
          mentions: [
            { entityType: 'agent', entityId: agentId, label: 'UTest Fix Agent' },
          ],
        })
        .expect(200);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // 4. Verify the queued mention was NOT cancelled (still pending)
      const threadRes = await request(app)
        .get(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}`,
        )
        .expect(200);

      const queuedItem = threadRes.body.data.items.find(
        (i: any) => i.payload?.queuedMention?.agentId === agentId,
      );
      expect(queuedItem).toBeDefined();
      expect(queuedItem.payload.queuedMention.cancelled).toBeFalsy();
    });

    it('cancelQueuedMentions returns correct count', async () => {
      // 1. Pause the agent
      await request(app)
        .patch(`/api/companies/${companyId}/agents/${agentId}`)
        .send({ status: 'paused' })
        .expect(200);

      // 2. Queue a mention
      await request(app)
        .post(
          `/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`,
        )
        .send({
          kind: 'comment',
          content: 'Hey @UTest Fix Agent',
          mentions: [
            { entityType: 'agent', entityId: agentId, label: 'UTest Fix Agent' },
          ],
        })
        .expect(201);

      await new Promise((resolve) => setTimeout(resolve, 300));

      // 3. Cancel via MentionService directly
      const mentionService = new MentionService(db);
      const result = await mentionService.cancelQueuedMentions(companyId, threadId, [agentId]);
      expect(result.cancelled).toBe(1);

      // 4. Cancel again — should find 0 (already cancelled)
      const result2 = await mentionService.cancelQueuedMentions(companyId, threadId, [agentId]);
      expect(result2.cancelled).toBe(0);
    });
  });
});
