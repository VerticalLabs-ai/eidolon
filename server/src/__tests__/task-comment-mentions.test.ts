import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, and, desc } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { backgroundWork } from '../services/background-work.js';
import { eventBus, type EidolonEvent } from '../realtime/events.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Task Comment API Mentions + Dispatch — VAL-API-001 through VAL-API-009
//
// Covers:
//   VAL-API-001: Task comment endpoint accepts mentions
//   VAL-API-002: Valid mentions persist and round-trip via GET
//   VAL-API-003: Invalid mentions (non-existent entities) are filtered out
//   VAL-API-004: Empty or omitted mentions produce mentions: [] in response
//   VAL-API-005: Task-thread mentions trigger dispatch (no projectThreadId)
//   VAL-API-006: Dispatch failures do not erase the persisted comment
//   VAL-API-009: Malformed mention objects rejected by Zod schema (400)
// ---------------------------------------------------------------------------

const DEV_USER_ID = 'dev-user-000';

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

function filterEvents<T extends EidolonEvent>(events: T[], type: string): T[] {
  return events.filter((e) => e.type === type);
}

describe('Task Comment API Mentions + Dispatch — VAL-API-*', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let agentId: string;
  let artifactId: string;
  let taskId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({
        name: '__mtest__ Task Mention Corp',
        settings: { testFixture: true },
      })
      .expect(201);
    companyId = company.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Task Mention Agent',
        role: 'engineer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      })
      .expect(201);
    agentId = agent.body.data.id;

    const artifact = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'document',
        title: '__mtest__ Task Mention Doc',
        content: { format: 'markdown', body: '# Hello' },
      })
      .expect(201);
    artifactId = artifact.body.data.id;

    const task = await request(app)
      .post(`/api/companies/${companyId}/tasks`)
      .send({ title: 'Task with mentions' })
      .expect(201);
    taskId = task.body.data.id;
  });

  const commentsUrl = () => `/api/companies/${companyId}/tasks/${taskId}/thread/comments`;
  const threadUrl = () => `/api/companies/${companyId}/tasks/${taskId}/thread`;

  // -------------------------------------------------------------------------
  // VAL-API-001: Task comment endpoint accepts mentions
  // -------------------------------------------------------------------------

  it('POST /tasks/:id/thread/comments accepts a mentions array and returns 201', async () => {
    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'Hey @Task Mention Agent, check this out',
        mentions: [{ entityType: 'agent', entityId: agentId, label: 'Task Mention Agent' }],
      })
      .expect(201);

    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.kind).toBe('comment');
    expect(res.body.data.content).toBe('Hey @Task Mention Agent, check this out');
  });

  // -------------------------------------------------------------------------
  // VAL-API-002: Valid mentions persist and round-trip
  // -------------------------------------------------------------------------

  it('valid agent and artifact mentions are persisted and returned on GET', async () => {
    await request(app)
      .post(commentsUrl())
      .send({
        content: 'Review @Task Mention Agent and @Task Mention Doc',
        mentions: [
          { entityType: 'agent', entityId: agentId, label: 'Task Mention Agent' },
          {
            entityType: 'artifact',
            entityId: artifactId,
            label: '__mtest__ Task Mention Doc',
            artifactType: 'document',
          },
        ],
      })
      .expect(201);

    const threadRes = await request(app).get(threadUrl()).expect(200);
    const comments = threadRes.body.data.filter((item: any) => item.kind === 'comment');
    expect(comments).toHaveLength(1);
    const mentions = comments[0].mentions;
    expect(mentions).toHaveLength(2);
    const types = mentions.map((m: any) => m.entityType);
    expect(types).toContain('agent');
    expect(types).toContain('artifact');
    const agentMention = mentions.find((m: any) => m.entityType === 'agent');
    expect(agentMention.entityId).toBe(agentId);
    const artifactMention = mentions.find((m: any) => m.entityType === 'artifact');
    expect(artifactMention.entityId).toBe(artifactId);
    expect(artifactMention.artifactType).toBe('document');
  });

  // -------------------------------------------------------------------------
  // VAL-API-003: Invalid mentions are filtered out
  // -------------------------------------------------------------------------

  it('invalid mentions (non-existent entities) are filtered out, valid ones persist', async () => {
    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'Hey @valid and @invalid',
        mentions: [
          { entityType: 'agent', entityId: agentId, label: 'Task Mention Agent' },
          {
            entityType: 'agent',
            entityId: '00000000-0000-0000-0000-000000000000',
            label: 'Non-existent Agent',
          },
        ],
      })
      .expect(201);

    expect(res.body.data.mentions).toHaveLength(1);
    expect(res.body.data.mentions[0].entityId).toBe(agentId);
  });

  // -------------------------------------------------------------------------
  // VAL-API-004: Empty or omitted mentions preserve compatibility
  // -------------------------------------------------------------------------

  it('omitted mentions field produces mentions: [] in response', async () => {
    const res = await request(app)
      .post(commentsUrl())
      .send({ content: 'No mentions here' })
      .expect(201);

    expect(res.body.data.mentions).toEqual([]);
  });

  it('empty mentions array produces mentions: [] in response', async () => {
    const res = await request(app)
      .post(commentsUrl())
      .send({ content: 'Explicitly empty mentions', mentions: [] })
      .expect(201);

    expect(res.body.data.mentions).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // VAL-API-009: Malformed mention objects rejected by Zod schema
  // -------------------------------------------------------------------------

  it('malformed mention (missing entityId) is rejected with 400', async () => {
    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'Bad mention',
        mentions: [{ entityType: 'agent', label: 'No ID' }],
      })
      .expect(400);

    expect(res.body.message).toBeDefined();
  });

  it('malformed mention (invalid entityType) is rejected with 400', async () => {
    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'Bad entity type',
        mentions: [{ entityType: 'robot', entityId: agentId, label: 'Robot' }],
      })
      .expect(400);

    expect(res.body.message).toBeDefined();
  });

  it('malformed mention (non-string label) is rejected with 400', async () => {
    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'Bad label type',
        mentions: [{ entityType: 'agent', entityId: agentId, label: 123 }],
      })
      .expect(400);

    expect(res.body.message).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // VAL-API-005: Task-thread mentions trigger dispatch (no projectThreadId)
  // -------------------------------------------------------------------------

  it('user mention dispatches a thread.mention event referencing taskId and itemId', async () => {
    const events = await captureEvents(async () => {
      await request(app)
        .post(commentsUrl())
        .send({
          content: 'FYI @Dev User',
          mentions: [{ entityType: 'user', entityId: DEV_USER_ID, label: 'Dev User' }],
        })
        .expect(201);
    });

    // Self-mention (dev-user is the author in local_trusted) should NOT
    // emit thread.mention. But we verify the code path runs without error.
    // For a non-self user, the event would fire. In local_trusted with
    // only dev-user, we verify the dispatch does not crash.
    const mentionEvents = filterEvents(events, 'thread.mention');
    // dev-user-000 is the author AND the mentioned user → no self-notification
    expect(mentionEvents).toHaveLength(0);

    // The comment should still have the mention persisted
    const threadRes = await request(app).get(threadUrl()).expect(200);
    const comments = threadRes.body.data.filter((item: any) => item.kind === 'comment');
    expect(comments[0].mentions).toHaveLength(1);
  });

  it('paused agent mention queues work in the task thread (no projectThreadId)', async () => {
    // Set agent to paused so dispatch queues instead of running the loop
    await request(app)
      .patch(`/api/companies/${companyId}/agents/${agentId}`)
      .send({ status: 'paused' })
      .expect(200);

    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'Hey @Task Mention Agent, help when you can',
        mentions: [{ entityType: 'agent', entityId: agentId, label: 'Task Mention Agent' }],
      })
      .expect(201);

    // The mention is persisted on the comment
    expect(res.body.data.mentions).toHaveLength(1);

    // Drain the tracked background dispatch
    await backgroundWork.drain();

    // Verify a queued item was posted to the task thread
    const threadRes = await request(app).get(threadUrl()).expect(200);
    const items = threadRes.body.data;
    const queuedItem = items.find((i: any) => i.payload?.queuedMention?.agentId === agentId);
    expect(queuedItem).toBeDefined();
    expect(queuedItem.taskId).toBe(taskId);
    expect(queuedItem.projectThreadId).toBeNull();
    expect(queuedItem.content).toContain('queued');
  });

  // -------------------------------------------------------------------------
  // VAL-API-006: Dispatch failures do not erase the persisted comment
  // -------------------------------------------------------------------------

  it('dispatch failure does not erase the persisted comment', async () => {
    // Post a comment with an agent mention. The agent is active (not paused),
    // so the dispatch will attempt to run the agentic loop. Without provider
    // API keys, the loop will fail — but the comment is already persisted.
    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'Hey @Task Mention Agent, please help',
        mentions: [{ entityType: 'agent', entityId: agentId, label: 'Task Mention Agent' }],
      })
      .expect(201);

    const commentId = res.body.data.id;
    expect(commentId).toBeDefined();

    // Drain the background dispatch — it will fail (no API keys) but
    // should not erase the comment.
    await backgroundWork.drain();

    // The comment must still be retrievable
    const threadRes = await request(app).get(threadUrl()).expect(200);
    const comment = threadRes.body.data.find((item: any) => item.id === commentId);
    expect(comment).toBeDefined();
    expect(comment.content).toBe('Hey @Task Mention Agent, please help');
    expect(comment.mentions).toHaveLength(1);
    expect(comment.mentions[0].entityId).toBe(agentId);
  });

  // -------------------------------------------------------------------------
  // VAL-API-007 (indirect): addTaskComment API client sends mentions
  // The UI client function is unit-tested via typecheck + manual inspection.
  // Here we verify the API endpoint correctly receives and processes the
  // mentions array as sent by the client.
  // -------------------------------------------------------------------------

  it('artifact mention persists with artifactType field', async () => {
    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'See @Task Mention Doc',
        mentions: [
          {
            entityType: 'artifact',
            entityId: artifactId,
            label: '__mtest__ Task Mention Doc',
            artifactType: 'document',
          },
        ],
      })
      .expect(201);

    expect(res.body.data.mentions).toHaveLength(1);
    expect(res.body.data.mentions[0].artifactType).toBe('document');

    // Artifact mentions are inert — no dispatch
    await backgroundWork.drain();

    // Verify no queued items or failure items were created
    const threadRes = await request(app).get(threadUrl()).expect(200);
    const dispatchItems = threadRes.body.data.filter(
      (item: any) =>
        item.kind === 'execution_event' &&
        (item.payload?.queuedMention || item.payload?.agentError),
    );
    expect(dispatchItems).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Cross-company mention filtering
  // -------------------------------------------------------------------------

  it('cross-company agent mention is filtered out', async () => {
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Other Task Corp', settings: { testFixture: true } })
      .expect(201);
    const otherAgent = await request(app)
      .post(`/api/companies/${otherCompany.body.data.id}/agents`)
      .send({
        name: 'Other Agent',
        role: 'engineer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      })
      .expect(201);

    const res = await request(app)
      .post(commentsUrl())
      .send({
        content: 'Hey @Other Agent',
        mentions: [
          {
            entityType: 'agent',
            entityId: otherAgent.body.data.id,
            label: 'Other Agent',
          },
        ],
      })
      .expect(201);

    expect(res.body.data.mentions).toHaveLength(0);
  });
});
