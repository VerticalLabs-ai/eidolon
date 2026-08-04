import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Knowledge API — project scoping', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let otherCompanyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Knowledge Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Knowledge Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Scoped project' })
      .expect(201);
    projectId = project.body.data.id;
  });

  function createDoc(body: Record<string, unknown>, company = companyId) {
    return request(app).post(`/api/companies/${company}/knowledge`).send(body);
  }

  // -------------------------------------------------------------------------
  // VAL-KNOWLEDGE-001: Create assigns project ownership
  // -------------------------------------------------------------------------
  it('POST /knowledge with valid projectId creates document with that project_id', async () => {
    const res = await createDoc({
      title: 'Project doc',
      content: 'Some content for the project.',
      projectId,
    }).expect(201);

    expect(res.body.data.projectId).toBe(projectId);

    const [row] = await db.drizzle
      .select({ projectId: db.schema.knowledgeDocuments.projectId })
      .from(db.schema.knowledgeDocuments)
      .where(eq(db.schema.knowledgeDocuments.id, res.body.data.id))
      .limit(1);
    expect(row.projectId).toBe(projectId);
  });

  // -------------------------------------------------------------------------
  // VAL-KNOWLEDGE-002: Reject cross-company project assignment
  // -------------------------------------------------------------------------
  it('POST /knowledge with cross-company projectId returns 404 and creates no document', async () => {
    const foreignProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Foreign project' })
      .expect(201);

    const beforeCount = await db.drizzle
      .select({ count: sql<number>`count(*)` })
      .from(db.schema.knowledgeDocuments)
      .where(eq(db.schema.knowledgeDocuments.companyId, companyId));

    const res = await createDoc({
      title: 'Cross-company doc',
      content: 'Should be rejected.',
      projectId: foreignProject.body.data.id,
    }).expect(404);

    expect(res.body.code).toBe('PROJECT_INVALID');

    const afterCount = await db.drizzle
      .select({ count: sql<number>`count(*)` })
      .from(db.schema.knowledgeDocuments)
      .where(eq(db.schema.knowledgeDocuments.companyId, companyId));
    expect(Number(afterCount[0].count)).toBe(Number(beforeCount[0].count));
  });

  // -------------------------------------------------------------------------
  // VAL-KNOWLEDGE-003: Unscoped create remains backward compatible
  // -------------------------------------------------------------------------
  it('POST /knowledge without projectId creates document with null project_id', async () => {
    const res = await createDoc({
      title: 'Unscoped doc',
      content: 'No project context.',
    }).expect(201);

    expect(res.body.data.projectId).toBeNull();

    const [row] = await db.drizzle
      .select({ projectId: db.schema.knowledgeDocuments.projectId })
      .from(db.schema.knowledgeDocuments)
      .where(eq(db.schema.knowledgeDocuments.id, res.body.data.id))
      .limit(1);
    expect(row.projectId).toBeNull();
  });

  // -------------------------------------------------------------------------
  // VAL-KNOWLEDGE-004: Project filter returns only matching documents
  // -------------------------------------------------------------------------
  it('GET /knowledge?project=X returns only documents with project_id=X', async () => {
    const scoped = await createDoc({
      title: 'Scoped doc',
      content: 'Scoped content.',
      projectId,
    }).expect(201);

    await createDoc({
      title: 'Unscoped doc',
      content: 'Unscoped content.',
    }).expect(201);

    const otherProject = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Other project' })
      .expect(201);
    await createDoc({
      title: 'Other-project doc',
      content: 'Other project content.',
      projectId: otherProject.body.data.id,
    }).expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/knowledge`)
      .query({ project: projectId })
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe(scoped.body.data.id);
    expect(res.body.data[0].projectId).toBe(projectId);
  });

  // -------------------------------------------------------------------------
  // VAL-KNOWLEDGE-005: Unfiltered list includes all company documents
  // -------------------------------------------------------------------------
  it('GET /knowledge without ?project returns all company documents including null project_id', async () => {
    const scoped = await createDoc({
      title: 'Scoped doc',
      content: 'Scoped content.',
      projectId,
    }).expect(201);
    const unscoped = await createDoc({
      title: 'Unscoped doc',
      content: 'Unscoped content.',
    }).expect(201);

    // Insert a document for another company to verify isolation
    const otherCompanyDoc = await request(app)
      .post(`/api/companies/${otherCompanyId}/knowledge`)
      .send({ title: 'Other company doc', content: 'Other company content.' })
      .expect(201);

    const res = await request(app)
      .get(`/api/companies/${companyId}/knowledge`)
      .expect(200);

    const ids = res.body.data.map((d: any) => d.id);
    expect(ids).toContain(scoped.body.data.id);
    expect(ids).toContain(unscoped.body.data.id);
    expect(ids).not.toContain(otherCompanyDoc.body.data.id);
  });
});
