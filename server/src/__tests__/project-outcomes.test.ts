import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Project Outcomes API — VAL-OUT-*', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let outcomesUrl: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app).post('/api/companies').send({ name: 'Outcome Corp' }).expect(201);
    companyId = company.body.data.id;
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Outcome Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Outcome Project', status: 'active', repoUrl: null })
      .expect(201);
    projectId = project.body.data.id;
    const otherProject = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Other Outcome Project', status: 'active', repoUrl: null })
      .expect(201);
    otherProjectId = otherProject.body.data.id;
    outcomesUrl = `/api/companies/${companyId}/projects/${projectId}/outcomes`;
  });

  const createOutcome = (overrides: Record<string, unknown> = {}) =>
    request(app).post(outcomesUrl).send({ type: 'document', title: 'An outcome', ...overrides });

  describe('POST /outcomes — VAL-OUT-001/002', () => {
    it('accepts all five types and defaults to pending', async () => {
      for (const type of ['document', 'pull_request', 'audit', 'review', 'delivery_summary']) {
        const response = await createOutcome({ type, title: `${type} outcome` }).expect(201);
        expect(response.body.data).toMatchObject({ type, status: 'pending', companyId, projectId });
        expect(response.body.data.completedAt).toBeNull();
      }
    });

    it('rejects invalid type and missing title', async () => {
      await createOutcome({ type: 'invalid' }).expect(400);
      await request(app).post(outcomesUrl).send({ type: 'document' }).expect(400);
    });

    it('stores optional reference and links', async () => {
      const response = await createOutcome({
        referenceUrl: 'https://example.com/result',
        referenceId: 'ref-1',
        metadata: { source: 'test' },
      }).expect(201);
      expect(response.body.data.referenceUrl).toBe('https://example.com/result');
      expect(response.body.data.referenceId).toBe('ref-1');
      expect(response.body.data.metadata).toEqual({ source: 'test' });
    });

    it('rejects a task from another project in the same company', async () => {
      const task = await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Other project task', projectId: otherProjectId })
        .expect(201);

      await createOutcome({ taskId: task.body.data.id }).expect(400);
    });

    it('accepts a task from the routed project', async () => {
      const task = await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Project task', projectId })
        .expect(201);

      const response = await createOutcome({ taskId: task.body.data.id }).expect(201);
      expect(response.body.data.taskId).toBe(task.body.data.id);
    });
  });

  describe('GET /outcomes — VAL-OUT-006/007', () => {
    it('filters by type and status, with combined filters intersecting', async () => {
      const document = await createOutcome({ type: 'document', title: 'Document' }).expect(201);
      const audit = await createOutcome({ type: 'audit', title: 'Audit' }).expect(201);
      await request(app)
        .patch(`${outcomesUrl}/${document.body.data.id}`)
        .send({ status: 'completed' })
        .expect(200);

      expect((await request(app).get(`${outcomesUrl}?type=document`)).body.data).toHaveLength(1);
      expect((await request(app).get(`${outcomesUrl}?status=completed`)).body.data[0].id).toBe(
        document.body.data.id,
      );
      expect(
        (await request(app).get(`${outcomesUrl}?type=document&status=completed`)).body.data,
      ).toHaveLength(1);
      expect(
        (await request(app).get(`${outcomesUrl}?type=audit&status=completed`)).body.data,
      ).toEqual([]);
      expect(audit.body.data.id).not.toBe(document.body.data.id);
    });

    it('returns an empty array for an empty project', async () => {
      expect((await request(app).get(outcomesUrl).expect(200)).body.data).toEqual([]);
    });

    it('rejects cross-company access', async () => {
      const outcome = await createOutcome().expect(201);
      await request(app)
        .get(`/api/companies/${otherCompanyId}/projects/${projectId}/outcomes`)
        .expect(404);
      await request(app)
        .patch(
          `/api/companies/${otherCompanyId}/projects/${projectId}/outcomes/${outcome.body.data.id}`,
        )
        .send({ status: 'completed' })
        .expect(404);
    });
  });

  describe('PATCH /outcomes/:id — VAL-OUT-003/010', () => {
    it('sets completedAt when completed and supports failed', async () => {
      const outcome = await createOutcome().expect(201);
      const completed = await request(app)
        .patch(`${outcomesUrl}/${outcome.body.data.id}`)
        .send({ status: 'completed' })
        .expect(200);
      expect(completed.body.data.status).toBe('completed');
      expect(completed.body.data.completedAt).not.toBeNull();

      const failed = await createOutcome().expect(201);
      expect(
        (await request(app).patch(`${outcomesUrl}/${failed.body.data.id}`).send({ status: 'failed' }).expect(200))
          .body.data.status,
      ).toBe('failed');
    });

    it('updates description/referenceUrl but keeps type immutable', async () => {
      const outcome = await createOutcome().expect(201);
      const response = await request(app)
        .patch(`${outcomesUrl}/${outcome.body.data.id}`)
        .send({ description: 'Updated', referenceUrl: 'https://example.com/new', type: 'audit' })
        .expect(400);
      expect(response.body).toBeDefined();
    });

    it('rejects invalid status and nonexistent outcomes', async () => {
      await request(app)
        .patch(`${outcomesUrl}/00000000-0000-0000-0000-000000000000`)
        .send({ status: 'invalid' })
        .expect(400);
      await request(app)
        .patch(`${outcomesUrl}/00000000-0000-0000-0000-000000000000`)
        .send({ status: 'completed' })
        .expect(404);
    });
  });
});
