import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, and, desc } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { setupActivityLogger } from '../routes/activity.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Integration test — setupActivityLogger + user @-mention duplicate fix
// ---------------------------------------------------------------------------
//
// Regression guard for the duplicate-inbox bug (VAL-MENTION-007 /
// VAL-MENTION-010): MentionService.dispatchUserMention inserts a
// user-attributed thread.mention activity_log row directly, then emits the
// thread.mention realtime event. setupActivityLogger listens to that event
// and would otherwise insert a SECOND, system-attributed row carrying the
// same metadata.mentionedUserId — both rows surface in the recipient's inbox
// as duplicate notifications.
//
// createTestServer does NOT call setupActivityLogger, so the rest of the
// suite never observed the duplicate. These tests wire setupActivityLogger
// explicitly and assert:
//   - exactly one thread.mention activity_log row per mention
//   - the single row is user-attributed (actorType='user', actorId=author)
//   - the recipient's inbox shows exactly one mention entry
// The afterEach hook in test-setup.ts calls eventBus.removeAllListeners(),
// so the logger handler registered here is torn down after each test.
// ---------------------------------------------------------------------------

const DEV_USER_ID = 'dev-user-000';

describe('setupActivityLogger + thread.mention — no duplicate inbox row', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    // Register the event-based activity logger — this is the production
    // wiring (bootstrap.ts) that the rest of the test suite omits.
    setupActivityLogger(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Activity Logger Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Logger Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Logger Thread', type: 'conversation' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  it('user mention produces exactly one thread.mention activity_log row (no system duplicate)', async () => {
    // Create a second user so the mention is not a self-mention
    const created = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'dupe@example.com', name: 'Dupe Target', companyId })
      .expect(201);
    const testUserId = created.body.data.id;

    await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
      .send({
        kind: 'comment',
        content: 'Hey @Dupe Target, look here',
        mentions: [
          { entityType: 'user', entityId: testUserId, label: 'Dupe Target' },
        ],
      })
      .expect(201);

    // Allow the fire-and-forget dispatch + event-driven logger to land
    await new Promise((resolve) => setTimeout(resolve, 150));

    const { activityLog } = db.schema;
    const mentionRows = await db.drizzle
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, 'thread.mention'),
        ),
      )
      .orderBy(desc(activityLog.createdAt));

    // The fix: exactly one row, not two
    expect(mentionRows).toHaveLength(1);

    // The single row is user-attributed (inserted by MentionService), not
    // a 'system'-attributed duplicate from setupActivityLogger
    expect(mentionRows[0].actorType).toBe('user');
    expect(mentionRows[0].actorId).toBe(DEV_USER_ID);
    expect((mentionRows[0].metadata as any).mentionedUserId).toBe(testUserId);
  });

  it('recipient inbox shows exactly one mention entry with setupActivityLogger active', async () => {
    const created = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'inbox@example.com', name: 'Inbox Target', companyId })
      .expect(201);
    const testUserId = created.body.data.id;

    await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
      .send({
        kind: 'comment',
        content: 'Hey @Inbox Target, check this out',
        mentions: [
          { entityType: 'user', entityId: testUserId, label: 'Inbox Target' },
        ],
      })
      .expect(201);

    // Poll the activity_log until the thread.mention row count is stable
    // (no new rows for two consecutive reads ~80ms apart). This ensures
    // both the direct MentionService insert AND any event-driven logger
    // insert have landed before we query the inbox, so the inbox assertion
    // reliably observes whether a duplicate was produced.
    const { activityLog } = db.schema;
    let lastCount = -1;
    let stable = false;
    for (let i = 0; i < 20 && !stable; i++) {
      const rows = await db.drizzle
        .select()
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, 'thread.mention'),
          ),
        );
      if (rows.length === lastCount && rows.length > 0) {
        stable = true;
      } else {
        lastCount = rows.length;
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
    }
    expect(stable).toBe(true);

    const inboxRes = await request(app)
      .get(`/api/companies/${companyId}/inbox?userId=${testUserId}`)
      .expect(200);

    // In a fresh company the only activity-log actions that surface in the
    // inbox are thread.mention rows (ACTIVITY_KINDS_OF_INTEREST in inbox.ts),
    // so every activity-kind item here corresponds to a thread.mention row.
    // Count all of them — both the user-attributed MentionService row and any
    // system-attributed duplicate would appear (with different titles), so a
    // title-based filter would miss the duplicate.
    const activityEntries = inboxRes.body.data.filter(
      (i: any) => i.kind === 'activity',
    );
    // Exactly one inbox entry, not a duplicate
    expect(activityEntries).toHaveLength(1);
    expect(activityEntries[0].title).toContain('Mentioned you');
  });

  it('multiple mentions of different users each produce exactly one row', async () => {
    const u1 = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'multi1@example.com', name: 'Multi One', companyId })
      .expect(201);
    const u2 = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'multi2@example.com', name: 'Multi Two', companyId })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
      .send({
        kind: 'comment',
        content: 'Hey @Multi One and @Multi Two',
        mentions: [
          { entityType: 'user', entityId: u1.body.data.id, label: 'Multi One' },
          { entityType: 'user', entityId: u2.body.data.id, label: 'Multi Two' },
        ],
      })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const { activityLog } = db.schema;
    const mentionRows = await db.drizzle
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.companyId, companyId),
          eq(activityLog.action, 'thread.mention'),
        ),
      )
      .orderBy(desc(activityLog.createdAt));

    // Two mentions → two rows (one per recipient), no duplicates
    expect(mentionRows).toHaveLength(2);
    const mentionedIds = mentionRows.map(
      (r) => (r.metadata as any).mentionedUserId,
    );
    expect(mentionedIds).toContain(u1.body.data.id);
    expect(mentionedIds).toContain(u2.body.data.id);
    // Both rows are user-attributed, none are system
    for (const row of mentionRows) {
      expect(row.actorType).toBe('user');
      expect(row.actorId).toBe(DEV_USER_ID);
    }
  });
});
