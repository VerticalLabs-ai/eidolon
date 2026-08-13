import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { eq } from 'drizzle-orm';
import { createTestDb, createTestServer } from '../test-utils.js';
import { setupActivityLogger } from '../routes/activity.js';
import { hashAgentKey, AGENT_KEY_PREFIX } from '../middleware/agent-key-auth.js';

describe('Companies API', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: Awaited<ReturnType<typeof createTestDb>>;

  /**
   * Helper: enroll a TOTP MFA factor for the dev user and grant a step-up
   * session for the `company_delete` scope. M8 security gates permanent
   * (hard) company deletion behind step-up re-authentication.
   */
  async function grantCompanyDeleteStepUp(): Promise<string> {
    await request(app).post('/api/auth/mfa/enroll').send({ label: 'test' }).expect(201);
    const codeRes = await request(app).post('/api/auth/mfa/generate-valid-code').expect(200);
    const stepUp = await request(app)
      .post('/api/auth/step-up')
      .send({ code: codeRes.body.data.code, scope: 'company_delete' })
      .expect(201);
    return stepUp.body.data.stepUpToken as string;
  }

  /**
   * Helper: seed an agent API key for a company. The raw key is used in
   * Authorization: Bearer headers; only its SHA-256 hash is persisted.
   */
  async function seedAgentKey(
    companyId: string,
    keyId: string,
    rawKey: string,
    role: 'owner' | 'admin' | 'member' | 'viewer' = 'member',
  ) {
    await db.drizzle.insert(db.schema.agentApiKeys).values({
      id: keyId,
      companyId,
      name: 'Isolation Test Key',
      keyHash: hashAgentKey(rawKey),
      keyPrefix: rawKey.slice(0, 10),
      role,
      createdByUserId: 'test-user',
    });
  }

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  // ---------------------------------------------------------------------------
  // POST /api/companies
  // ---------------------------------------------------------------------------

  describe('POST /api/companies', () => {
    it('should create a company with minimal fields', async () => {
      const res = await request(app).post('/api/companies').send({ name: 'Test Corp' }).expect(201);

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
      const res = await request(app).post('/api/companies').send({ name: '' }).expect(400);

      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject missing name', async () => {
      const res = await request(app).post('/api/companies').send({}).expect(400);

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
      const created = await request(app).post('/api/companies').send({ name: 'Lookup Corp' });
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
      const created = await request(app).post('/api/companies').send({ name: 'Old Name' });
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
      const created = await request(app).post('/api/companies').send({ name: 'Pause Corp' });
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
      const created = await request(app).post('/api/companies').send({ name: 'Invalid Status' });
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
      const created = await request(app).post('/api/companies').send({ name: 'Delete Me' });
      const id = created.body.data.id;

      const res = await request(app).delete(`/api/companies/${id}`).expect(200);

      expect(res.body.data.status).toBe('archived');
      expect(res.body.data.id).toBe(id);
    });

    it('should still be retrievable after archiving', async () => {
      const created = await request(app).post('/api/companies').send({ name: 'Archive Me' });
      const id = created.body.data.id;

      await request(app).delete(`/api/companies/${id}`).expect(200);

      const getRes = await request(app).get(`/api/companies/${id}`).expect(200);
      expect(getRes.body.data.status).toBe('archived');
    });

    it('should 404 for non-existent company', async () => {
      await request(app).delete('/api/companies/00000000-0000-0000-0000-000000000000').expect(404);
    });

    it('should hard-delete a company and its dependent rows', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Hard Delete Me', settings: { testFixture: true } })
        .expect(201);
      const companyId = created.body.data.id;

      const agent = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Delete Agent', role: 'engineer' })
        .expect(201);
      const task = await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Delete Task' })
        .expect(201);
      const project = await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'Delete Project' })
        .expect(201);

      // M8: permanent deletion requires step-up re-authentication.
      const stepUpToken = await grantCompanyDeleteStepUp();
      await request(app)
        .delete(`/api/companies/${companyId}?hard=true`)
        .set('X-Eidolon-Step-Up-Token', stepUpToken)
        .expect(204);

      const [company, remainingAgent, remainingTask, remainingProject] = await Promise.all([
        db.drizzle.select().from(db.schema.companies).where(eq(db.schema.companies.id, companyId)),
        db.drizzle
          .select()
          .from(db.schema.agents)
          .where(eq(db.schema.agents.id, agent.body.data.id)),
        db.drizzle.select().from(db.schema.tasks).where(eq(db.schema.tasks.id, task.body.data.id)),
        db.drizzle
          .select()
          .from(db.schema.projects)
          .where(eq(db.schema.projects.id, project.body.data.id)),
      ]);

      expect(company).toHaveLength(0);
      expect(remainingAgent).toHaveLength(0);
      expect(remainingTask).toHaveLength(0);
      expect(remainingProject).toHaveLength(0);
    });

    it('should not recreate an activity log row after hard delete', async () => {
      const created = await request(app)
        .post('/api/companies')
        .send({ name: 'Activity Hard Delete Me', settings: { testFixture: true } })
        .expect(201);
      const companyId = created.body.data.id;

      await db.drizzle.insert(db.schema.activityLog).values({
        companyId,
        actorType: 'system',
        actorId: 'system',
        action: 'company.created',
        entityType: 'company',
        entityId: companyId,
        description: 'Company created',
        metadata: {},
        createdAt: new Date(),
      });
      setupActivityLogger(db);

      // M8: permanent deletion requires step-up re-authentication.
      const stepUpToken = await grantCompanyDeleteStepUp();
      await request(app)
        .delete(`/api/companies/${companyId}?hard=true`)
        .set('X-Eidolon-Step-Up-Token', stepUpToken)
        .expect(204);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const remainingActivity = await db.drizzle
        .select()
        .from(db.schema.activityLog)
        .where(eq(db.schema.activityLog.companyId, companyId));

      // VAL-SEC-007: the company permanent-deletion audit entry survives the
      // cascade (it is inserted after the transaction; activity_log.company_id
      // has no FK). The pre-deletion 'company.created' row is cascade-deleted.
      // The event-based logger still skips 'company.deleted' so no duplicate.
      expect(remainingActivity).toHaveLength(1);
      expect(remainingActivity[0].action).toBe('company.delete_permanent');
      expect(remainingActivity[0].actorType).toBe('user');
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

      const res = await request(app).get(`/api/companies/${id}/dashboard`).expect(200);

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
      const created = await request(app).post('/api/companies').send({ name: 'Stats Corp' });
      const companyId = created.body.data.id;

      // Create agents
      await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Agent 1', role: 'engineer' });
      await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Agent 2', role: 'designer', status: 'working' });

      // Create tasks
      await request(app).post(`/api/companies/${companyId}/tasks`).send({ title: 'Task 1' });
      await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Task 2', status: 'todo' });

      const res = await request(app).get(`/api/companies/${companyId}/dashboard`).expect(200);

      expect(res.body.data.agents.total).toBe(2);
      expect(res.body.data.tasks.total).toBe(2);
    });

    it('should 404 for non-existent company', async () => {
      await request(app)
        .get('/api/companies/00000000-0000-0000-0000-000000000000/dashboard')
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Agent API key isolation on companiesRouter :id endpoints
  // ---------------------------------------------------------------------------

  describe('Agent key isolation on companiesRouter :id endpoints', () => {
    const rawKey = `${AGENT_KEY_PREFIX}companies_isolation_test_key`;

    it('agent key for company A cannot GET company B details', async () => {
      const companyA = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company A', settings: { testFixture: true } })
        .expect(201);
      const companyB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      await seedAgentKey(companyA.body.data.id, 'key-isolation-get', rawKey, 'member');

      const res = await request(app)
        .get(`/api/companies/${companyB.body.data.id}`)
        .set('authorization', `Bearer ${rawKey}`)
        .expect(403);

      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('agent key for company A cannot GET company B dashboard', async () => {
      const companyA = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company A', settings: { testFixture: true } })
        .expect(201);
      const companyB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      await seedAgentKey(companyA.body.data.id, 'key-isolation-dash', rawKey, 'member');

      const res = await request(app)
        .get(`/api/companies/${companyB.body.data.id}/dashboard`)
        .set('authorization', `Bearer ${rawKey}`)
        .expect(403);

      expect(res.body.code).toBe('NOT_MEMBER');
    });

    it('agent key for company A cannot PATCH company B', async () => {
      const companyA = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company A', settings: { testFixture: true } })
        .expect(201);
      const companyB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      await seedAgentKey(companyA.body.data.id, 'key-isolation-patch', rawKey, 'member');

      const res = await request(app)
        .patch(`/api/companies/${companyB.body.data.id}`)
        .set('authorization', `Bearer ${rawKey}`)
        .send({ name: 'Hacked' })
        .expect(403);

      expect(res.body.code).toBe('NOT_MEMBER');

      // Verify company B was not mutated
      const unchanged = await db.drizzle
        .select({ name: db.schema.companies.name })
        .from(db.schema.companies)
        .where(eq(db.schema.companies.id, companyB.body.data.id));
      expect(unchanged[0].name).toBe('__mtest__ Company B');
    });

    it('agent key for company A cannot DELETE company B', async () => {
      const companyA = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company A', settings: { testFixture: true } })
        .expect(201);
      const companyB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      await seedAgentKey(companyA.body.data.id, 'key-isolation-delete', rawKey, 'admin');

      const res = await request(app)
        .delete(`/api/companies/${companyB.body.data.id}`)
        .set('authorization', `Bearer ${rawKey}`)
        .expect(403);

      expect(res.body.code).toBe('NOT_MEMBER');

      // Verify company B was not archived or deleted
      const unchanged = await db.drizzle
        .select({ status: db.schema.companies.status })
        .from(db.schema.companies)
        .where(eq(db.schema.companies.id, companyB.body.data.id));
      expect(unchanged[0].status).toBe('active');
    });

    it('agent key for company A can still access its own company endpoints', async () => {
      const companyA = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company A', settings: { testFixture: true } })
        .expect(201);
      const companyB = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Company B', settings: { testFixture: true } })
        .expect(201);
      await seedAgentKey(companyA.body.data.id, 'key-isolation-own', rawKey, 'owner');

      // Read own company
      const getRes = await request(app)
        .get(`/api/companies/${companyA.body.data.id}`)
        .set('authorization', `Bearer ${rawKey}`)
        .expect(200);
      expect(getRes.body.data.id).toBe(companyA.body.data.id);

      // Read own dashboard
      await request(app)
        .get(`/api/companies/${companyA.body.data.id}/dashboard`)
        .set('authorization', `Bearer ${rawKey}`)
        .expect(200);

      // Mutate own company (owner permission)
      const patchRes = await request(app)
        .patch(`/api/companies/${companyA.body.data.id}`)
        .set('authorization', `Bearer ${rawKey}`)
        .send({ name: '__mtest__ Company A Updated' })
        .expect(200);
      expect(patchRes.body.data.name).toBe('__mtest__ Company A Updated');

      // Soft-delete own company (owner permission)
      await request(app)
        .delete(`/api/companies/${companyA.body.data.id}`)
        .set('authorization', `Bearer ${rawKey}`)
        .expect(200);

      // Cross-company access still fails after own-company operations
      const crossRes = await request(app)
        .get(`/api/companies/${companyB.body.data.id}`)
        .set('authorization', `Bearer ${rawKey}`)
        .expect(403);
      expect(crossRes.body.code).toBe('NOT_MEMBER');
    });

    it('normal user auth still works for all companiesRouter :id endpoints', async () => {
      const company = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Normal User Corp', settings: { testFixture: true } })
        .expect(201);
      const id = company.body.data.id;

      await request(app).get(`/api/companies/${id}`).expect(200);
      await request(app).get(`/api/companies/${id}/dashboard`).expect(200);

      const patchRes = await request(app)
        .patch(`/api/companies/${id}`)
        .send({ name: '__mtest__ Normal User Corp Updated' })
        .expect(200);
      expect(patchRes.body.data.name).toBe('__mtest__ Normal User Corp Updated');

      const deleteRes = await request(app).delete(`/api/companies/${id}`).expect(200);
      expect(deleteRes.body.data.status).toBe('archived');
    });
  });
});
