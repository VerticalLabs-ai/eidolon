import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';

describe('Project Threads API — VAL-THREAD-*', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let threadsUrl: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Thread Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Thread Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({
        name: 'Thread Project',
        description: 'A project for thread tests',
        status: 'active',
        repoUrl: null,
      })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other project', status: 'active', repoUrl: null })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    threadsUrl = `/api/companies/${companyId}/projects/${projectId}/threads`;
  });

  function createThread(overrides: Record<string, unknown> = {}) {
    return request(app)
      .post(threadsUrl)
      .send({
        title: 'Test Thread',
        ...overrides,
      });
  }

  function createThreadItem(
    threadId: string,
    body: Record<string, unknown> = {},
  ) {
    return request(app)
      .post(`${threadsUrl}/${threadId}/items`)
      .send(body);
  }

  // -------------------------------------------------------------------------
  // VAL-THREAD-006: Thread types and defaults
  // -------------------------------------------------------------------------
  describe('POST /threads — VAL-THREAD-006', () => {
    it('creates a thread with type defaulting to conversation and status active', async () => {
      const res = await createThread({ title: 'Default Thread' }).expect(201);
      expect(res.body.data).toMatchObject({
        title: 'Default Thread',
        type: 'conversation',
        status: 'active',
        companyId,
        projectId,
      });
      expect(res.body.data.id).toBeDefined();
    });

    it('accepts all valid thread types', async () => {
      const types = ['conversation', 'plan_review', 'decision_review', 'standup'] as const;
      for (const type of types) {
        const res = await createThread({ title: `${type} thread`, type }).expect(201);
        expect(res.body.data.type).toBe(type);
      }
    });

    it('returns 400 without title', async () => {
      await request(app)
        .post(threadsUrl)
        .send({ type: 'conversation' })
        .expect(400);
    });

    it('returns 400 with invalid type', async () => {
      await request(app)
        .post(threadsUrl)
        .send({ title: 'Bad type', type: 'chitchat' })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-007: List and filter threads
  // -------------------------------------------------------------------------
  describe('GET /threads — VAL-THREAD-007', () => {
    it('returns only active threads by default', async () => {
      const active = await createThread({ title: 'Active' }).expect(201);
      const archived = await createThread({ title: 'Archived', status: 'archived' }).expect(201);

      const res = await request(app).get(threadsUrl).expect(200);
      const ids = res.body.data.map((t: { id: string }) => t.id);
      expect(ids).toContain(active.body.data.id);
      expect(ids).not.toContain(archived.body.data.id);
    });

    it('filters by status=archived', async () => {
      const active = await createThread({ title: 'Active' }).expect(201);
      const archived = await createThread({ title: 'Archived', status: 'archived' }).expect(201);

      const res = await request(app)
        .get(threadsUrl)
        .query({ status: 'archived' })
        .expect(200);
      const ids = res.body.data.map((t: { id: string }) => t.id);
      expect(ids).not.toContain(active.body.data.id);
      expect(ids).toContain(archived.body.data.id);
    });

    it('filters by type=plan_review', async () => {
      const plan = await createThread({ title: 'Plan', type: 'plan_review' }).expect(201);
      const standup = await createThread({ title: 'Standup', type: 'standup' }).expect(201);

      const res = await request(app)
        .get(threadsUrl)
        .query({ type: 'plan_review' })
        .expect(200);
      const ids = res.body.data.map((t: { id: string }) => t.id);
      expect(ids).toContain(plan.body.data.id);
      expect(ids).not.toContain(standup.body.data.id);
    });

    it('combines status and type filters', async () => {
      const activePlan = await createThread({ title: 'Active Plan', type: 'plan_review' }).expect(201);
      await createThread({ title: 'Archived Plan', type: 'plan_review', status: 'archived' }).expect(201);
      await createThread({ title: 'Active Conversation', type: 'conversation' }).expect(201);

      const res = await request(app)
        .get(threadsUrl)
        .query({ status: 'active', type: 'plan_review' })
        .expect(200);
      const ids = res.body.data.map((t: { id: string }) => t.id);
      expect(ids).toEqual([activePlan.body.data.id]);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-010: Multiple threads coexist independently
  // -------------------------------------------------------------------------
  describe('GET /threads/:threadId — VAL-THREAD-010', () => {
    it('returns a thread with recent items', async () => {
      const thread = await createThread({ title: 'With items' }).expect(201);
      const item1 = await createThreadItem(thread.body.data.id, {
        kind: 'comment',
        content: 'First message',
      }).expect(201);
      const item2 = await createThreadItem(thread.body.data.id, {
        kind: 'comment',
        content: 'Second message',
      }).expect(201);

      const res = await request(app)
        .get(`${threadsUrl}/${thread.body.data.id}`)
        .expect(200);

      expect(res.body.data.id).toBe(thread.body.data.id);
      expect(res.body.data.items).toHaveLength(2);
      const itemIds = res.body.data.items.map((i: { id: string }) => i.id);
      expect(itemIds).toContain(item1.body.data.id);
      expect(itemIds).toContain(item2.body.data.id);
    });

    it('returns a thread with empty items when none exist', async () => {
      const thread = await createThread({ title: 'Empty' }).expect(201);
      const res = await request(app)
        .get(`${threadsUrl}/${thread.body.data.id}`)
        .expect(200);
      expect(res.body.data.items).toEqual([]);
    });

    it('does not include items from another thread', async () => {
      const threadA = await createThread({ title: 'A' }).expect(201);
      const threadB = await createThread({ title: 'B' }).expect(201);
      await createThreadItem(threadA.body.data.id, { content: 'A message' }).expect(201);

      const res = await request(app)
        .get(`${threadsUrl}/${threadB.body.data.id}`)
        .expect(200);
      expect(res.body.data.items).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-004 & VAL-THREAD-011: Items are scoped and support all kinds
  // -------------------------------------------------------------------------
  describe('POST /threads/:threadId/items — VAL-THREAD-004, VAL-THREAD-011', () => {
    it('creates an item with projectThreadId set and taskId null', async () => {
      const thread = await createThread({ title: 'Item host' }).expect(201);
      const res = await createThreadItem(thread.body.data.id, {
        kind: 'comment',
        content: 'Hello',
      }).expect(201);

      expect(res.body.data).toMatchObject({
        companyId,
        projectThreadId: thread.body.data.id,
        taskId: null,
        kind: 'comment',
        content: 'Hello',
      });
    });

    it('supports all item kinds', async () => {
      const thread = await createThread({ title: 'Kinds' }).expect(201);
      const kinds = ['comment', 'interaction', 'decision', 'approval_link', 'execution_event'] as const;

      for (const kind of kinds) {
        const res = await createThreadItem(thread.body.data.id, {
          kind,
          content: `${kind} message`,
          payload: { kind },
        }).expect(201);
        expect(res.body.data.kind).toBe(kind);
      }
    });

    it('defaults kind to comment and status to pending', async () => {
      const thread = await createThread({ title: 'Defaults' }).expect(201);
      const res = await createThreadItem(thread.body.data.id, {
        content: 'Just content',
      }).expect(201);
      expect(res.body.data.kind).toBe('comment');
      expect(res.body.data.status).toBe('pending');
    });

    it('returns 404 for nonexistent thread', async () => {
      await createThreadItem(randomUUID(), { content: 'x' }).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-005: Resolve interaction items
  // -------------------------------------------------------------------------
  describe('PATCH /threads/:threadId/items/:itemId — VAL-THREAD-005', () => {
    it('resolves an interaction item to accepted', async () => {
      const thread = await createThread({ title: 'Interaction' }).expect(201);
      const item = await createThreadItem(thread.body.data.id, {
        kind: 'interaction',
        content: 'Accept me',
      }).expect(201);

      const res = await request(app)
        .patch(`${threadsUrl}/${thread.body.data.id}/items/${item.body.data.id}`)
        .send({ status: 'accepted', note: 'Approved' })
        .expect(200);

      expect(res.body.data.status).toBe('accepted');
      expect(res.body.data.resolutionNote).toBe('Approved');
      expect(res.body.data.resolvedAt).toBeDefined();
    });

    it('resolves an interaction item to rejected', async () => {
      const thread = await createThread({ title: 'Interaction' }).expect(201);
      const item = await createThreadItem(thread.body.data.id, {
        kind: 'interaction',
        content: 'Reject me',
      }).expect(201);

      const res = await request(app)
        .patch(`${threadsUrl}/${thread.body.data.id}/items/${item.body.data.id}`)
        .send({ status: 'rejected' })
        .expect(200);

      expect(res.body.data.status).toBe('rejected');
    });

    it('resolves an interaction item to answered', async () => {
      const thread = await createThread({ title: 'Interaction' }).expect(201);
      const item = await createThreadItem(thread.body.data.id, {
        kind: 'interaction',
        content: 'Answer me',
      }).expect(201);

      const res = await request(app)
        .patch(`${threadsUrl}/${thread.body.data.id}/items/${item.body.data.id}`)
        .send({ status: 'answered', answers: { ready: true } })
        .expect(200);

      expect(res.body.data.status).toBe('answered');
      expect(res.body.data.payload).toMatchObject({ answers: { ready: true } });
    });

    it('returns 400 when patching a non-interaction item', async () => {
      const thread = await createThread({ title: 'Comment thread' }).expect(201);
      const item = await createThreadItem(thread.body.data.id, {
        kind: 'comment',
        content: 'Just a comment',
      }).expect(201);

      await request(app)
        .patch(`${threadsUrl}/${thread.body.data.id}/items/${item.body.data.id}`)
        .send({ status: 'accepted' })
        .expect(400);
    });

    it('returns 404 for nonexistent item', async () => {
      const thread = await createThread({ title: 'Missing item' }).expect(201);
      await request(app)
        .patch(`${threadsUrl}/${thread.body.data.id}/items/${randomUUID()}`)
        .send({ status: 'accepted' })
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-008: Cross-company access returns 404
  // -------------------------------------------------------------------------
  describe('Cross-company boundary — VAL-THREAD-008', () => {
    it('returns 404 on GET list with wrong company', async () => {
      await request(app)
        .get(`/api/companies/${companyId}/projects/${otherProjectId}/threads`)
        .expect(404);
    });

    it('returns 404 on GET thread with wrong company', async () => {
      const thread = await createThread({ title: 'Ours' }).expect(201);
      await request(app)
        .get(`/api/companies/${otherCompanyId}/projects/${projectId}/threads/${thread.body.data.id}`)
        .expect(404);
    });

    it('returns 404 on POST thread with wrong company', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/projects/${otherProjectId}/threads`)
        .send({ title: 'Wrong company' })
        .expect(404);
    });

    it('returns 404 on POST item with wrong company', async () => {
      const thread = await createThread({ title: 'Ours' }).expect(201);
      await request(app)
        .post(`/api/companies/${otherCompanyId}/projects/${projectId}/threads/${thread.body.data.id}/items`)
        .send({ content: 'x' })
        .expect(404);
    });

    it('returns 404 on PATCH item with wrong company', async () => {
      const thread = await createThread({ title: 'Ours' }).expect(201);
      const item = await createThreadItem(thread.body.data.id, { kind: 'interaction' }).expect(201);
      await request(app)
        .patch(`/api/companies/${otherCompanyId}/projects/${projectId}/threads/${thread.body.data.id}/items/${item.body.data.id}`)
        .send({ status: 'accepted' })
        .expect(404);
    });

    it('returns 404 for nonexistent thread', async () => {
      await request(app)
        .get(`${threadsUrl}/${randomUUID()}`)
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-013: Inherit companyId/projectId from route context
  // -------------------------------------------------------------------------
  describe('Route context inheritance — VAL-THREAD-013', () => {
    it('ignores companyId and projectId in create thread body', async () => {
      const res = await request(app)
        .post(threadsUrl)
        .send({
          title: 'Body override attempt',
          companyId: otherCompanyId,
          projectId: otherProjectId,
        })
        .expect(201);

      expect(res.body.data.companyId).toBe(companyId);
      expect(res.body.data.projectId).toBe(projectId);
    });

    it('ignores companyId in create item body', async () => {
      const thread = await createThread({ title: 'Item context' }).expect(201);
      const res = await request(app)
        .post(`${threadsUrl}/${thread.body.data.id}/items`)
        .send({
          content: 'x',
          companyId: otherCompanyId,
        })
        .expect(201);

      expect(res.body.data.companyId).toBe(companyId);
    });

    it('stores the thread in the project from the route', async () => {
      const res = await createThread({ title: 'Routed' }).expect(201);
      const [row] = await db.drizzle
        .select()
        .from(db.schema.projectThreads)
        .where(
          and(
            eq(db.schema.projectThreads.id, res.body.data.id),
            eq(db.schema.projectThreads.companyId, companyId),
            eq(db.schema.projectThreads.projectId, projectId),
          ),
        )
        .limit(1);
      expect(row).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Event emission
  // -------------------------------------------------------------------------
  describe('Event emission', () => {
    it('emits project.thread.created when a thread is created', async () => {
      const events: Array<{ type: string; payload: unknown }> = [];
      const onEvent = (event: { type: string; payload: unknown }) => {
        if (event.type === 'project.thread.created') events.push(event);
      };
      eventBus.onEvent(onEvent);

      try {
        const res = await createThread({ title: 'Evented' }).expect(201);
        expect(events).toHaveLength(1);
        expect((events[0].payload as any).thread.id).toBe(res.body.data.id);
      } finally {
        eventBus.off('event', onEvent);
      }
    });

    it('emits project.thread.item.created when an item is added', async () => {
      const thread = await createThread({ title: 'Item event' }).expect(201);
      const events: Array<{ type: string; payload: unknown }> = [];
      const onEvent = (event: { type: string; payload: unknown }) => {
        if (event.type === 'project.thread.item.created') events.push(event);
      };
      eventBus.onEvent(onEvent);

      try {
        const res = await createThreadItem(thread.body.data.id, { content: 'x' }).expect(201);
        expect(events).toHaveLength(1);
        expect((events[0].payload as any).item.id).toBe(res.body.data.id);
      } finally {
        eventBus.off('event', onEvent);
      }
    });

    it('emits project.thread.item.updated when an interaction is resolved', async () => {
      const thread = await createThread({ title: 'Update event' }).expect(201);
      const item = await createThreadItem(thread.body.data.id, { kind: 'interaction' }).expect(201);

      const events: Array<{ type: string; payload: unknown }> = [];
      const onEvent = (event: { type: string; payload: unknown }) => {
        if (event.type === 'project.thread.item.updated') events.push(event);
      };
      eventBus.onEvent(onEvent);

      try {
        await request(app)
          .patch(`${threadsUrl}/${thread.body.data.id}/items/${item.body.data.id}`)
          .send({ status: 'accepted' })
          .expect(200);
        expect(events).toHaveLength(1);
        expect((events[0].payload as any).item.status).toBe('accepted');
      } finally {
        eventBus.off('event', onEvent);
      }
    });
  });
});
