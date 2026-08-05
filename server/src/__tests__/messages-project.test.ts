import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Messages API — project scoping', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let otherCompanyId: string;
  let fromAgentId: string;
  let toAgentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Messages Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Messages Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Scoped project' })
      .expect(201);
    projectId = project.body.data.id;

    const fromAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Sender Agent', role: 'engineer' })
      .expect(201);
    fromAgentId = fromAgent.body.data.id;

    const toAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Receiver Agent', role: 'engineer' })
      .expect(201);
    toAgentId = toAgent.body.data.id;
  });

  function sendMessage(body: Record<string, unknown>, company = companyId) {
    return request(app).post(`/api/companies/${company}/messages`).send(body);
  }

  function baseMessage(overrides: Record<string, unknown> = {}) {
    return {
      fromAgentId,
      toAgentId,
      content: 'Hello from the test.',
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // VAL-MESSAGES-001: Create assigns project ownership
  // -------------------------------------------------------------------------
  it('POST /messages with valid projectId creates message with that project_id', async () => {
    const res = await sendMessage(baseMessage({ projectId })).expect(201);

    expect(res.body.data.projectId).toBe(projectId);

    const [row] = await db.drizzle
      .select({ projectId: db.schema.messages.projectId })
      .from(db.schema.messages)
      .where(eq(db.schema.messages.id, res.body.data.id))
      .limit(1);
    expect(row.projectId).toBe(projectId);
  });

  // -------------------------------------------------------------------------
  // VAL-MESSAGES-002: Reject cross-company project assignment
  // -------------------------------------------------------------------------
  it('POST /messages with cross-company projectId returns 404 and creates no message', async () => {
    const foreignProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Foreign project' })
      .expect(201);

    const beforeCount = await db.drizzle
      .select({ count: sql<number>`count(*)` })
      .from(db.schema.messages)
      .where(eq(db.schema.messages.companyId, companyId));

    const res = await sendMessage(
      baseMessage({ projectId: foreignProject.body.data.id }),
    ).expect(404);

    expect(res.body.code).toBe('PROJECT_INVALID');

    const afterCount = await db.drizzle
      .select({ count: sql<number>`count(*)` })
      .from(db.schema.messages)
      .where(eq(db.schema.messages.companyId, companyId));
    expect(Number(afterCount[0].count)).toBe(Number(beforeCount[0].count));
  });

  // -------------------------------------------------------------------------
  // VAL-MESSAGES-003: Unscoped create remains backward compatible
  // -------------------------------------------------------------------------
  it('POST /messages without projectId creates message with null project_id', async () => {
    const res = await sendMessage(baseMessage()).expect(201);

    expect(res.body.data.projectId).toBeNull();

    const [row] = await db.drizzle
      .select({ projectId: db.schema.messages.projectId })
      .from(db.schema.messages)
      .where(eq(db.schema.messages.id, res.body.data.id))
      .limit(1);
    expect(row.projectId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // VAL-MESSAGES-004: Project filter returns only matching messages
  // -------------------------------------------------------------------------
  it('GET /messages?project=X returns only messages with project_id=X', async () => {
    const scoped = await sendMessage(baseMessage({ projectId })).expect(201);
    await sendMessage(baseMessage({ content: 'Unscoped message.' })).expect(201);

    const otherProject = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Other project' })
      .expect(201);
    await sendMessage(
      baseMessage({ content: 'Other-project message.', projectId: otherProject.body.data.id }),
    ).expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/messages`)
      .query({ project: projectId })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(scoped.body.data.id);
    expect(res.body.data[0].projectId).toBe(projectId);
  });

  // -------------------------------------------------------------------------
  // VAL-MESSAGES-005: Unfiltered list includes all company messages
  // -------------------------------------------------------------------------
  it('GET /messages without ?project returns all company messages including null project_id', async () => {
    const scoped = await sendMessage(baseMessage({ projectId })).expect(201);
    const unscoped = await sendMessage(baseMessage({ content: 'Unscoped message.' })).expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/messages`)
      .expect(200);

    const ids = res.body.data.map((m: any) => m.id);
    expect(ids).toContain(scoped.body.data.id);
    expect(ids).toContain(unscoped.body.data.id);
  });
});
