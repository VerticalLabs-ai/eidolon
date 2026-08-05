import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Automation project scoping', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    companyId = (await request(app).post('/api/companies').send({ name: 'Automation Corp' }).expect(201)).body.data.id;
    otherCompanyId = (await request(app).post('/api/companies').send({ name: 'Other Corp' }).expect(201)).body.data.id;
    projectId = (await request(app).post(`/api/companies/${companyId}/projects`).send({ name: 'Project' }).expect(201)).body.data.id;
  });

  it('creates and filters workflows by project, while allowing unscoped rows', async () => {
    const scoped = await request(app).post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Scoped', projectId }).expect(201);
    const unscoped = await request(app).post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Unscoped' }).expect(201);
    expect(scoped.body.data.projectId).toBe(projectId);
    expect(unscoped.body.data.projectId).toBeNull();

    const filtered = await request(app).get(`/api/companies/${companyId}/workflows`)
      .query({ project: projectId }).expect(200);
    expect(filtered.body.data.map((row: { id: string }) => row.id)).toEqual([scoped.body.data.id]);
  });

  it('rejects a workflow project owned by another company', async () => {
    const foreignProject = (await request(app).post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Foreign' }).expect(201)).body.data.id;
    await request(app).post(`/api/companies/${companyId}/workflows`)
      .send({ name: 'Invalid', projectId: foreignProject }).expect(404);
    const rows = await db.drizzle.select().from(db.schema.workflows)
      .where(eq(db.schema.workflows.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  it('creates and filters routines by project, while allowing unscoped rows', async () => {
    const scoped = await request(app).post(`/api/companies/${companyId}/routines`)
      .send({ name: 'Scoped', prompt: 'Run scoped work', projectId }).expect(201);
    const unscoped = await request(app).post(`/api/companies/${companyId}/routines`)
      .send({ name: 'Unscoped', prompt: 'Run unscoped work' }).expect(201);
    expect(scoped.body.data.projectId).toBe(projectId);
    expect(unscoped.body.data.projectId).toBeNull();

    const filtered = await request(app).get(`/api/companies/${companyId}/routines`)
      .query({ project: projectId }).expect(200);
    expect(filtered.body.data.map((row: { id: string }) => row.id)).toEqual([scoped.body.data.id]);
  });

  it('rejects a routine project owned by another company', async () => {
    const foreignProject = (await request(app).post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Foreign' }).expect(201)).body.data.id;
    await request(app).post(`/api/companies/${companyId}/routines`)
      .send({ name: 'Invalid', prompt: 'Do not run', projectId: foreignProject }).expect(404);
    const rows = await db.drizzle.select().from(db.schema.routines)
      .where(eq(db.schema.routines.companyId, companyId));
    expect(rows).toHaveLength(0);
  });
});
