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
    for (const repoUrl of ['not-a-url', 'javascript:alert(document.domain)']) {
      await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'Invalid repository', repoUrl })
        .expect(400);
    }

    const list = await request(app)
      .get(`/api/companies/${companyId}/projects`)
      .expect(200);
    expect(list.body.data).toEqual([]);
  });

  it('updates and soft-archives a project with durable detail reads', async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Lifecycle draft', status: 'planning', repoUrl: null })
      .expect(201);
    const projectId = created.body.data.id;

    await request(app)
      .patch(`/api/companies/${companyId}/projects/${projectId}`)
      .send({
        name: 'Lifecycle verified',
        description: 'Prove edits survive a canonical detail reload.',
        status: 'active',
        repoUrl: 'https://github.com/vertical-labs/eidolon',
      })
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual(expect.objectContaining({
          id: projectId,
          name: 'Lifecycle verified',
          status: 'active',
          repoUrl: 'https://github.com/vertical-labs/eidolon',
        }));
      });

    await request(app)
      .get(`/api/companies/${companyId}/projects/${projectId}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual(expect.objectContaining({
          id: projectId,
          name: 'Lifecycle verified',
          description: 'Prove edits survive a canonical detail reload.',
        }));
      });

    await request(app)
      .delete(`/api/companies/${companyId}/projects/${projectId}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual(expect.objectContaining({ id: projectId, status: 'archived' }));
      });

    await request(app)
      .get(`/api/companies/${companyId}/projects/${projectId}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual(expect.objectContaining({ id: projectId, status: 'archived' }));
      });
  });

  it('rejects an invalid repository URL during an update without changing the project', async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Keep canonical state', status: 'planning', repoUrl: null })
      .expect(201);

    await request(app)
      .patch(`/api/companies/${companyId}/projects/${created.body.data.id}`)
      .send({ name: 'Do not persist', repoUrl: 'javascript:alert(document.domain)' })
      .expect(400);

    await request(app)
      .get(`/api/companies/${companyId}/projects/${created.body.data.id}`)
      .expect(200)
      .expect(({ body }) => {
        expect(body.data).toEqual(expect.objectContaining({
          name: 'Keep canonical state',
          repoUrl: null,
        }));
      });
  });
});
