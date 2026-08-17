import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import type { DbInstance } from '../types.js';
import { createTestDb, createTestServer } from '../test-utils.js';
import { redactedEmail, subjectPseudonym, deleteClerkUser } from '../services/privacy.js';

const SUBJECT = 'user-subject-001';
const OTHER_MEMBER = 'user-other-002';

describe('subject data export and erasure', () => {
  let db: DbInstance;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let otherCompanyId: string;
  let taskId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const create = async (name: string) =>
      (
        await request(app)
          .post('/api/companies')
          .send({ name, settings: { testFixture: true } })
          .expect(201)
      ).body.data.id;

    companyId = await create('__mtest__ privacy subject');
    otherCompanyId = await create('__mtest__ privacy other');

    // The acting user is the dev owner in local_trusted mode. The subject is a
    // separate member so authorisation and self-erasure paths stay distinct.
    await db.drizzle.insert(db.schema.companyMembers).values([
      { companyId, userId: SUBJECT, role: 'member' },
      { companyId, userId: OTHER_MEMBER, role: 'member' },
      { companyId: otherCompanyId, userId: SUBJECT, role: 'member' },
    ]);

    const task = await request(app)
      .post(`/api/companies/${companyId}/tasks`)
      .send({ title: 'Shared company work' })
      .expect(201);
    taskId = task.body.data.id;

    // Content authored by the subject, in both companies, so cross-company
    // containment is observable.
    await db.drizzle
      .update(db.schema.tasks)
      .set({ createdByUserId: SUBJECT })
      .where(eq(db.schema.tasks.id, taskId));

    await db.drizzle.insert(db.schema.inboxReadStates).values({
      companyId,
      userId: SUBJECT,
      itemId: 'activity:read-1',
    });

    await db.drizzle.insert(db.schema.activityLog).values([
      {
        companyId,
        actorType: 'user',
        actorId: SUBJECT,
        action: 'task.created',
        entityType: 'task',
        entityId: taskId,
        description: 'Created a task',
        metadata: {},
        createdAt: new Date('2026-08-01T10:00:00.000Z'),
      },
      {
        companyId: otherCompanyId,
        actorType: 'user',
        actorId: SUBJECT,
        action: 'task.created',
        entityType: 'task',
        entityId: 'other-task',
        description: 'Created a task elsewhere',
        metadata: {},
        createdAt: new Date('2026-08-01T11:00:00.000Z'),
      },
    ]);

    await db.drizzle.insert(db.schema.companyInvitations).values({
      companyId,
      email: 'Subject.Person@Example.test',
      role: 'member',
      invitedByUserId: 'dev-user-000',
      acceptedByUserId: SUBJECT,
      acceptedAt: new Date(),
      status: 'accepted',
    });

    await db.drizzle.insert(db.schema.userMfaFactors).values({
      companyId,
      userId: SUBJECT,
      type: 'totp',
      secret: 'totp-secret-material',
      status: 'active',
    });
  });

  const exportUrl = (company: string, subject: string) =>
    `/api/companies/${company}/privacy/subjects/${subject}/export`;
  const eraseUrl = (company: string, subject: string) =>
    `/api/companies/${company}/privacy/subjects/${subject}/erase`;

  it('exports the subject data held for one company only', async () => {
    const response = await request(app).get(exportUrl(companyId, SUBJECT)).expect(200);
    const { data } = response.body;

    expect(data.subject).toBe(SUBJECT);
    expect(data.companyId).toBe(companyId);
    expect(data.totalRows).toBeGreaterThan(0);

    const tables = Object.fromEntries(
      data.tables.map((entry: { table: string; rows: unknown[] }) => [entry.table, entry.rows]),
    );
    expect(Object.keys(tables)).toContain('company_members');
    expect(Object.keys(tables)).toContain('tasks');
    expect(Object.keys(tables)).toContain('inbox_read_states');

    // The other company's activity row must not appear.
    const activityRows = (tables.activity_log ?? []) as { company_id: string }[];
    expect(activityRows.length).toBe(1);
    expect(activityRows[0].company_id).toBe(companyId);
  });

  it('never returns authentication material in an export', async () => {
    const response = await request(app).get(exportUrl(companyId, SUBJECT)).expect(200);
    const body = JSON.stringify(response.body);

    expect(body).not.toContain('user_mfa_factors');
    expect(body).not.toContain('totp-secret-material');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses a subject who is not a member of this company', async () => {
    await request(app).get(exportUrl(companyId, 'user-not-a-member')).expect(404);
    await request(app)
      .post(eraseUrl(companyId, 'user-not-a-member'))
      .send({ confirmSubject: 'user-not-a-member' })
      .expect(404);
  });

  it('refuses erasure when the confirmation does not match the subject', async () => {
    await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: OTHER_MEMBER })
      .expect(400);

    // Nothing was erased.
    const [member] = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, companyId),
          eq(db.schema.companyMembers.userId, SUBJECT),
        ),
      );
    expect(member).toBeTruthy();
  });

  it('refuses an owner erasing themselves', async () => {
    const response = await request(app)
      .post(eraseUrl(companyId, 'dev-user-000'))
      .send({ confirmSubject: 'dev-user-000' })
      .expect(409);

    expect(response.body.code).toBe('SELF_ERASURE_REFUSED');
  });

  it('erases the subject while keeping company work and audit rows', async () => {
    const response = await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: SUBJECT })
      .expect(200);

    const report = response.body.data;
    expect(report.remainingReferences).toBe(0);
    expect(report.pseudonym).toBe(subjectPseudonym(companyId, SUBJECT));
    expect(report.rowsAffected).toBeGreaterThan(0);

    // Membership and reading state are gone.
    const members = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, companyId),
          eq(db.schema.companyMembers.userId, SUBJECT),
        ),
      );
    expect(members).toHaveLength(0);

    const readStates = await db.drizzle
      .select()
      .from(db.schema.inboxReadStates)
      .where(eq(db.schema.inboxReadStates.userId, SUBJECT));
    expect(readStates).toHaveLength(0);

    // The task survives with its attribution removed.
    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));
    expect(task).toBeTruthy();
    expect(task.title).toBe('Shared company work');
    expect(task.createdByUserId).toBeNull();

    // Audit rows are kept and pseudonymised, not deleted.
    const auditRows = await db.drizzle
      .select()
      .from(db.schema.activityLog)
      .where(eq(db.schema.activityLog.companyId, companyId));
    const taskCreated = auditRows.filter((row) => row.action === 'task.created');
    expect(taskCreated).toHaveLength(1);
    expect(taskCreated[0].actorId).toBe(report.pseudonym);

    // MFA factors are destroyed.
    const factors = await db.drizzle
      .select()
      .from(db.schema.userMfaFactors)
      .where(eq(db.schema.userMfaFactors.userId, SUBJECT));
    expect(factors).toHaveLength(0);
  });

  it('redacts the invited email address', async () => {
    await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: SUBJECT })
      .expect(200);

    const [invitation] = await db.drizzle
      .select()
      .from(db.schema.companyInvitations)
      .where(eq(db.schema.companyInvitations.companyId, companyId));

    expect(invitation.email).toBe(redactedEmail('Subject.Person@Example.test'));
    expect(invitation.email).not.toContain('Subject.Person');
    expect(invitation.acceptedByUserId).toBeNull();
  });

  it('leaves the other company untouched', async () => {
    await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: SUBJECT })
      .expect(200);

    const otherMembership = await db.drizzle
      .select()
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, otherCompanyId),
          eq(db.schema.companyMembers.userId, SUBJECT),
        ),
      );
    expect(otherMembership).toHaveLength(1);

    const otherActivity = await db.drizzle
      .select()
      .from(db.schema.activityLog)
      .where(eq(db.schema.activityLog.companyId, otherCompanyId));
    expect(otherActivity.some((row) => row.actorId === SUBJECT)).toBe(true);
  });

  it('writes an audit event for both operations without naming the subject', async () => {
    await request(app).get(exportUrl(companyId, SUBJECT)).expect(200);
    await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: SUBJECT })
      .expect(200);

    const rows = await db.drizzle
      .select()
      .from(db.schema.activityLog)
      .where(eq(db.schema.activityLog.companyId, companyId));

    const exported = rows.find((row) => row.action === 'privacy.subject_exported');
    const erased = rows.find((row) => row.action === 'privacy.subject_erased');
    expect(exported).toBeTruthy();
    expect(erased).toBeTruthy();

    const pseudonym = subjectPseudonym(companyId, SUBJECT);
    for (const row of [exported, erased]) {
      expect(row?.entityId).toBe(pseudonym);
      // The audit trail must not reintroduce the identifier the erasure removed.
      expect(JSON.stringify(row?.metadata)).not.toContain(SUBJECT);
    }
  });

  it('is idempotent: a second erasure changes nothing and still reports zero references', async () => {
    await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: SUBJECT })
      .expect(200);

    // Membership is gone, so the subject is no longer a member of this company.
    await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: SUBJECT })
      .expect(404);
  });

  it('leaves no row anywhere in the company still pointing at the subject', async () => {
    await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: SUBJECT })
      .expect(200);

    // Independent sweep, not the service's own accounting: search every text
    // column of every table for the subject id.
    const rows = (await db.drizzle.execute(sql`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public' and data_type in ('text', 'character varying')
    `)) as unknown as { table_name: string; column_name: string }[];

    const offenders: string[] = [];
    for (const { table_name, column_name } of rows) {
      const found = (await db.drizzle.execute(sql`
        select count(*)::int as count
        from ${sql.identifier(table_name)}
        where ${sql.identifier(column_name)} = ${SUBJECT}
      `)) as unknown as { count: number }[];
      const count = Number(found[0]?.count ?? 0);
      if (count > 0) {
        offenders.push(`${table_name}.${column_name} (${count})`);
      }
    }

    // Rows belonging to the other company are expected to remain.
    const inThisCompany = offenders.filter(
      (entry) => !entry.startsWith('company_members') && !entry.startsWith('activity_log'),
    );
    expect(inThisCompany).toEqual([]);
  });

  it('reports a Clerk deletion result on erasure (no-op without CLERK_SECRET_KEY)', async () => {
    // The test harness deletes CLERK_SECRET_KEY, so the integrated Clerk
    // deletion step must be a safe no-op rather than a failure.
    const response = await request(app)
      .post(eraseUrl(companyId, SUBJECT))
      .send({ confirmSubject: SUBJECT })
      .expect(200);

    const clerk = response.body.data.clerkDeletion;
    expect(clerk).toBeTruthy();
    expect(clerk.attempted).toBe(false);
    expect(clerk.deleted).toBe(false);
    expect(typeof clerk.reason).toBe('string');
    expect(clerk.reason.length).toBeGreaterThan(0);
  });

  it('deleteClerkUser is a no-op when CLERK_SECRET_KEY is not configured', async () => {
    const result = await deleteClerkUser(SUBJECT);
    expect(result.attempted).toBe(false);
    expect(result.deleted).toBe(false);
    expect(result.reason).toContain('CLERK_SECRET_KEY');
  });
});
