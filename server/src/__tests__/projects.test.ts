import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Projects API', () => {
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createTestApp(db);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Project Test Corp' })
      .expect(201);
    companyId = company.body.data.id;
  });

  it('creates and persists a project with the operator fields', async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({
        name: 'Runtime reliability',
        description: 'Make agent execution durable.',
        status: 'active',
        repoUrl: 'https://github.com/vertical-labs/eidolon',
      })
      .expect(201);

    expect(created.body.data).toEqual(expect.objectContaining({
      companyId,
      name: 'Runtime reliability',
      description: 'Make agent execution durable.',
      status: 'active',
      repoUrl: 'https://github.com/vertical-labs/eidolon',
    }));

    const list = await request(app)
      .get(`/api/companies/${companyId}/projects`)
      .expect(200);

    expect(list.body.data).toEqual([
      expect.objectContaining({ id: created.body.data.id, name: 'Runtime reliability' }),
    ]);
  });

  it('rejects an invalid repository URL without persisting a project', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Invalid repository', repoUrl: 'not-a-url' })
      .expect(400);

    const list = await request(app)
      .get(`/api/companies/${companyId}/projects`)
      .expect(200);
    expect(list.body.data).toEqual([]);
  });
});
