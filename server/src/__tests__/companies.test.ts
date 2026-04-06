import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestDb, createTestApp } from '../test-utils.js';

describe('Companies API', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: ReturnType<typeof createTestDb>;

  beforeEach(() => {
    db = createTestDb();
    app = createTestApp(db);
  });

  // ---------------------------------------------------------------------------
  // POST /api/companies
  // ---------------------------------------------------------------------------

  describe('POST /api/companies', () => {
    it('should create a company with minimal fields', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({ name: 'Test Corp' })
        .expect(201);

      expect(res.body.data).toBeDefined();
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBe('Test Corp');
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.budgetMonthlyCents).toBe(0);
      expect(res.body.data.spentMonthlyCents).toBe(0);
      expect(res.body.data.createdAt).toBeDefined();
      expect(res.body.data.updatedAt).toBeDefined();
    });

    it('should create a company with all optional fields', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({
          name: 'Full Corp',
          description: 'A test description',
          mission: 'Build great things',
          status: 'active',
          budgetMonthlyCents: 50000,
          settings: { theme: 'dark' },
          brandColor: '#FF5733',
          logoUrl: 'https://example.com/logo.png',
        })
        .expect(201);

      expect(res.body.data.name).toBe('Full Corp');
      expect(res.body.data.description).toBe('A test description');
      expect(res.body.data.mission).toBe('Build great things');
      expect(res.body.data.budgetMonthlyCents).toBe(50000);
      expect(res.body.data.brandColor).toBe('#FF5733');
      expect(res.body.data.logoUrl).toBe('https://example.com/logo.png');
    });

    it('should reject empty name', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({ name: '' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject missing name', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({})
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject invalid brand color format', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({ name: 'Bad Color Corp', brandColor: 'red' })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject negative budget', async () => {
      const res = await request(app)
        .post('/api/companies')
        .send({ name: 'Negative Corp', budgetMonthlyCents: -100 })
        .expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/companies
  // ---------------------------------------------------------------------------

  describe('GET /api/companies', () => {
    it('should return empty array when no companies exist', async () => {
      const res = await request(app).get('/api/companies').expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('should list all companies', async () => {
      await request(app).post('/api/companies').send({ name: 'Corp A' });
      await request(app).post('/api/companies').send({ name: 'Corp B' });
      await request(app).post('/api/companies').send({ name: 'Corp C' });

      const res = await request(app).get('/api/companies').expect(200);

      expect(res.body.data).toHaveLength(3);
      const names = res.body.data.map((c: any) => c.name);
      expect(names).toContain('Corp A');
      expect(names).toContain('Corp B');
      expect(names).toContain('Corp C');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/companies/:id
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:id', () => {
    it('should get a company by id', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Lookup Corp' });
      const id = created.body.data.id;

      const res = await request(app).get(`/api/companies/${id}`).expect(200);

      expect(res.body.data.id).toBe(id);
      expect(res.body.data.name).toBe('Lookup Corp');
    });

    it('should 404 for non-existent company', async () => {
      const res = await request(app)
        .get('/api/companies/00000000-0000-0000-0000-000000000000')
        .expect(404);

      expect(res.body.code).toBe('COMPANY_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/companies/:id
  // ---------------------------------------------------------------------------

  describe('PATCH /api/companies/:id', () => {
    it('should update a company name', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Old Name' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${id}`)
        .send({ name: 'New Name' })
        .expect(200);

      expect(res.body.data.name).toBe('New Name');
    });

    it('should update budget', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Budget Corp', budgetMonthlyCents: 1000 });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${id}`)
        .send({ budgetMonthlyCents: 5000 })
        .expect(200);

      expect(res.body.data.budgetMonthlyCents).toBe(5000);
    });

    it('should update status', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Pause Corp' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${id}`)
        .send({ status: 'paused' })
        .expect(200);

      expect(res.body.data.status).toBe('paused');
    });

    it('should 404 for non-existent company', async () => {
      await request(app)
        .patch('/api/companies/00000000-0000-0000-0000-000000000000')
        .send({ name: 'Ghost' })
        .expect(404);
    });

    it('should reject invalid status', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Invalid Status' });
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${id}`)
        .send({ status: 'invalid_status' })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/companies/:id
  // ---------------------------------------------------------------------------

  describe('DELETE /api/companies/:id', () => {
    it('should archive a company (soft delete)', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Delete Me' });
      const id = created.body.data.id;

      const res = await request(app)
        .delete(`/api/companies/${id}`)
        .expect(200);

      expect(res.body.data.status).toBe('archived');
      expect(res.body.data.id).toBe(id);
    });

    it('should still be retrievable after archiving', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Archive Me' });
      const id = created.body.data.id;

      await request(app).delete(`/api/companies/${id}`).expect(200);

      const getRes = await request(app)
        .get(`/api/companies/${id}`)
        .expect(200);
      expect(getRes.body.data.status).toBe('archived');
    });

    it('should 404 for non-existent company', async () => {
      await request(app)
        .delete('/api/companies/00000000-0000-0000-0000-000000000000')
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/companies/:id/dashboard
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:id/dashboard', () => {
    it('should return dashboard data for a new company', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Dash Corp', budgetMonthlyCents: 50000 });
      const id = created.body.data.id;

      const res = await request(app)
        .get(`/api/companies/${id}/dashboard`)
        .expect(200);

      expect(res.body.data.company).toBeDefined();
      expect(res.body.data.company.name).toBe('Dash Corp');

      expect(res.body.data.agents).toBeDefined();
      expect(res.body.data.agents.total).toBe(0);
      expect(res.body.data.agents.byStatus).toBeDefined();

      expect(res.body.data.tasks).toBeDefined();
      expect(res.body.data.tasks.total).toBe(0);
      expect(res.body.data.tasks.byStatus).toBeDefined();

      expect(res.body.data.costs).toBeDefined();
      expect(res.body.data.costs.budgetCents).toBe(50000);
      expect(res.body.data.costs.spentCents).toBe(0);
    });

    it('should aggregate agent and task counts', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Stats Corp' });
      const companyId = created.body.data.id;

      // Create agents
      await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Agent 1', role: 'engineer' });
      await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Agent 2', role: 'designer', status: 'working' });

      // Create tasks
      await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Task 1' });
      await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Task 2', status: 'in_progress' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/dashboard`)
        .expect(200);

      expect(res.body.data.agents.total).toBe(2);
      expect(res.body.data.tasks.total).toBe(2);
    });

    it('should 404 for non-existent company', async () => {
      await request(app)
        .get('/api/companies/00000000-0000-0000-0000-000000000000/dashboard')
        .expect(404);
    });
  });
});
