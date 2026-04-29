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
});
