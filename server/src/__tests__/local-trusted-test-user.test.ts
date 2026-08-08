import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// Helpers
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
    // Give fire-and-forget dispatch a tick to complete
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    eventBus.off('event', handler);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Test suite — local_trusted test user creation + mention flow
// ---------------------------------------------------------------------------

describe('POST /api/auth/local-trusted/create-test-user — local_trusted mode', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Test User Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Test User Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Mention Test Thread', type: 'conversation' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  // -- Endpoint basic behavior --

  it('POST /api/auth/local-trusted/create-test-user creates a second user', async () => {
    const res = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({
        email: 'second@example.com',
        name: 'Second User',
        companyId,
      })
      .expect(201);

    expect(res.body.data).toMatchObject({
      companyId,
      name: 'Second User',
      email: 'second@example.com',
    });
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.id).not.toBe(DEV_USER_ID);
  });

  it('POST /api/auth/local-trusted/create-test-user is idempotent (same company + email)', async () => {
    const body = { email: 'dup@example.com', name: 'Dup User', companyId };

    const res1 = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send(body)
      .expect(201);

    const res2 = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send(body)
      .expect(200);

    expect(res2.body.data.id).toBe(res1.body.data.id);
  });

  it('POST /api/auth/local-trusted/create-test-user rejects non-existent company', async () => {
    await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({
        email: 'ghost@example.com',
        name: 'Ghost User',
        companyId: randomUUID(),
      })
      .expect(404);
  });

  it('POST /api/auth/local-trusted/create-test-user rejects invalid body', async () => {
    await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'not-an-email', name: 'X', companyId })
      .expect(400); // Zod validation error

    await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ name: 'No Email', companyId })
      .expect(400);
  });

  // -- Mention search includes test users --

  it('test user appears in mention search', async () => {
    const created = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'searchable@example.com', name: 'Searchable Sue', companyId })
      .expect(201);
    const testUserId = created.body.data.id;

    const res = await request(app)
      .get(`/api/companies/${companyId}/mentions/search?q=`)
      .expect(200);

    const userResults = res.body.data.filter((e: any) => e.entityType === 'user');
    expect(userResults.some((e: any) => e.entityId === testUserId && e.label === 'Searchable Sue')).toBe(true);
  });

  it('test user appears in mention search filtered by name', async () => {
    await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'filter@example.com', name: 'Filterable Fred', companyId })
      .expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/mentions/search?q=Filterable`)
      .expect(200);

    const userResults = res.body.data.filter((e: any) => e.entityType === 'user');
    expect(userResults.some((e: any) => e.label === 'Filterable Fred')).toBe(true);
  });

  // -- Full mention flow: create test user → mention → inbox + WS event --

  it('full flow: mention test user → inbox notification + thread.mention WS event', async () => {
    // 1. Create a test user
    const created = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'mention@example.com', name: 'Mention Target', companyId })
      .expect(201);
    const testUserId = created.body.data.id;

    // 2. Post a thread item mentioning the test user
    const events = await captureEvents(async () => {
      await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Hey @Mention Target, check this out',
          mentions: [
            { entityType: 'user', entityId: testUserId, label: 'Mention Target' },
          ],
        })
        .expect(201);
    });

    // 3. Verify thread.mention WS event was emitted
    const mentionEvents = events.filter((e) => e.type === 'thread.mention');
    expect(mentionEvents.length).toBe(1);
    expect(mentionEvents[0].payload.mentionedUserId).toBe(testUserId);

    // 4. Verify the thread item persisted the mention
    const threadRes = await request(app)
      .get(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}`)
      .expect(200);

    const items = threadRes.body.data.items;
    const mentionItem = items.find((i: any) => i.mentions?.some((m: any) => m.entityId === testUserId));
    expect(mentionItem).toBeTruthy();
    expect(mentionItem.mentions).toContainEqual({
      entityType: 'user',
      entityId: testUserId,
      label: 'Mention Target',
    });

    // 5. Verify inbox notification exists for the test user (via userId query override)
    const inboxRes = await request(app)
      .get(`/api/companies/${companyId}/inbox?userId=${testUserId}`)
      .expect(200);

    const mentionActivity = inboxRes.body.data.filter(
      (i: any) => i.kind === 'activity' && i.title?.includes('Mentioned you'),
    );
    expect(mentionActivity.length).toBeGreaterThanOrEqual(1);

    // 6. Verify the activity log entry has the correct mentionedUserId
    const { activityLog } = db.schema;
    const logEntries = await db.drizzle
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, 'thread.mention'),
        ),
      )
      .orderBy(desc(activityLog.createdAt));

    const testUserEntry = logEntries.find(
      (e) => (e.metadata as any)?.mentionedUserId === testUserId,
    );
    expect(testUserEntry).toBeTruthy();
    expect((testUserEntry!.metadata as any).mentionedUserId).toBe(testUserId);
  });

  it('mention of test user is NOT skipped as self-mention (author is dev-user-000)', async () => {
    const created = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'selfcheck@example.com', name: 'Self Check User', companyId })
      .expect(201);
    const testUserId = created.body.data.id;

    // The test user ID must differ from dev-user-000
    expect(testUserId).not.toBe(DEV_USER_ID);

    const events = await captureEvents(async () => {
      await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Notifying @Self Check User',
          mentions: [
            { entityType: 'user', entityId: testUserId, label: 'Self Check User' },
          ],
        })
        .expect(201);
    });

    // A thread.mention event should fire (not skipped)
    const mentionEvents = events.filter((e) => e.type === 'thread.mention');
    expect(mentionEvents.length).toBe(1);
  });

  it('mention of dev-user-000 IS skipped as self-mention (no notification)', async () => {
    const events = await captureEvents(async () => {
      await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Hey @Dev User',
          mentions: [
            { entityType: 'user', entityId: DEV_USER_ID, label: 'Dev User' },
          ],
        })
        .expect(201);
    });

    // No thread.mention event should fire for self-mention
    const mentionEvents = events.filter((e) => e.type === 'thread.mention');
    expect(mentionEvents.length).toBe(0);
  });

  // -- Multi-mention: agent + test user --

  it('multi-mention: agent + test user dispatch independently', async () => {
    // Create an agent
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Multi Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    const agentId = agent.body.data.id;

    // Create a test user
    const created = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'multi@example.com', name: 'Multi User', companyId })
      .expect(201);
    const testUserId = created.body.data.id;

    // Post a thread item with both mentions (skip agent dispatch by using a
    // fire-and-forget capture — agent dispatch runs the agentic loop which
    // needs an LLM provider; we only verify the user mention side effects)
    const events = await captureEvents(async () => {
      await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Hey @Multi Agent and @Multi User',
          mentions: [
            { entityType: 'agent', entityId: agentId, label: 'Multi Agent' },
            { entityType: 'user', entityId: testUserId, label: 'Multi User' },
          ],
        })
        .expect(201);
    });

    // thread.mention event should fire for the test user
    const mentionEvents = events.filter(
      (e) => e.type === 'thread.mention' && e.payload.mentionedUserId === testUserId,
    );
    expect(mentionEvents.length).toBe(1);

    // Verify inbox for the test user
    const inboxRes = await request(app)
      .get(`/api/companies/${companyId}/inbox?userId=${testUserId}`)
      .expect(200);

    const mentionActivity = inboxRes.body.data.filter(
      (i: any) => i.kind === 'activity' && i.title?.includes('Mentioned you'),
    );
    expect(mentionActivity.length).toBeGreaterThanOrEqual(1);
  });

  // -- Endpoint guard: non-local_trusted mode --

  it('POST /api/auth/local-trusted/create-test-user returns 404 in non-local_trusted mode', async () => {
    // Create a server in authenticated mode
    const authApp = await createTestServer(db, 'authenticated');

    await request(authApp)
      .post('/api/auth/local-trusted/create-test-user')
      .send({
        email: 'forbidden@example.com',
        name: 'Forbidden User',
        companyId,
      })
      .expect(404);
  });
});
