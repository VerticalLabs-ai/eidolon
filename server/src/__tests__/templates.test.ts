import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Templates API', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createTestApp(db);
  });

  it('lists the built-in demo template when no database templates exist', async () => {
    const res = await request(app).get('/api/templates').expect(200);

    expect(res.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'builtin-demo-saas-operator',
          name: 'SaaS Operator Demo',
          agentCount: 5,
        }),
      ]),
    );

    const builtIns = res.body.data.filter((template: any) => template.id.startsWith('builtin-'));
    expect(builtIns.map((template: any) => template.category)).toEqual(
      expect.arrayContaining(['software', 'marketing', 'ecommerce', 'consulting', 'content']),
    );
    expect(builtIns.every((template: any) => template.version === '1.0.0')).toBe(true);
  });

  it('imports the built-in demo template as a user-owned company', async () => {
    const res = await request(app)
      .post('/api/templates/builtin-demo-saas-operator/import')
      .send({ companyName: 'Demo Import' })
      .expect(201);

    const companyId = res.body.data.companyId;
    expect(companyId).toBeTruthy();

    const company = await request(app).get(`/api/companies/${companyId}`).expect(200);
    expect(company.body.data.name).toBe('Demo Import');

    const agents = await request(app).get(`/api/companies/${companyId}/agents`).expect(200);
    expect(agents.body.data).toHaveLength(5);
  });

  it('exports, updates, versions, and deletes user-created templates', async () => {
    const companyRes = await request(app)
      .post('/api/companies')
      .send({
        name: 'Template Source Co',
        description: 'Company to save as a template',
        mission: 'Keep template snapshots current',
        budgetMonthlyCents: 100000,
      })
      .expect(201);

    const companyId = companyRes.body.data.id;
    const exportRes = await request(app)
      .post(`/api/companies/${companyId}/export`)
      .send({
        name: 'Source Snapshot',
        category: 'consulting',
        tags: ['snapshot'],
      })
      .expect(201);

    const template = exportRes.body.data.template;
    expect(template.version).toBe('1.0.0');
    expect(template.category).toBe('consulting');

    const updateRes = await request(app)
      .patch(`/api/companies/${companyId}/export/${template.id}`)
      .send({
        name: 'Source Snapshot Updated',
        category: 'content',
        tags: ['snapshot', 'updated'],
      })
      .expect(200);

    expect(updateRes.body.data.template).toMatchObject({
      id: template.id,
      name: 'Source Snapshot Updated',
      category: 'content',
      version: '1.0.1',
      tags: ['snapshot', 'updated'],
    });

    await request(app).delete(`/api/templates/${template.id}`).expect(204);
    await request(app).get(`/api/templates/${template.id}`).expect(404);
  });

  it('prevents deleting built-in templates', async () => {
    await request(app).delete('/api/templates/builtin-demo-saas-operator').expect(403);
  });
});
