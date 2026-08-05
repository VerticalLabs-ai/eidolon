import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Project Decisions API — VAL-DEC-*', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let decisionsUrl: string;
  let plansUrl: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Decision Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Decision Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({
        name: 'Decision Project',
        description: 'A project for decision tests',
        status: 'active',
        repoUrl: null,
      })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other project', status: 'active', repoUrl: null })
      .expect(201);
    void otherProject;

    decisionsUrl = `/api/companies/${companyId}/projects/${projectId}/decisions`;
    plansUrl = `/api/companies/${companyId}/projects/${projectId}/plans`;
  });

  function createDecision(overrides: Record<string, unknown> = {}) {
    return request(app)
      .post(decisionsUrl)
      .send({
        title: 'Test Decision',
        ...overrides,
      });
  }

  async function createPlanAndStep() {
    const plan = await request(app)
      .post(plansUrl)
      .send({ title: 'Test Plan' })
      .expect(201);
    const step = await request(app)
      .post(`${plansUrl}/${plan.body.data.id}/steps`)
      .send({ title: 'Test Step' })
      .expect(201);
    return { plan: plan.body.data, step: step.body.data };
  }

  // -------------------------------------------------------------------------
  // VAL-DEC-001: Create a decision card
  // -------------------------------------------------------------------------
  describe('POST /decisions — VAL-DEC-001', () => {
    it('creates a decision with status=pending', async () => {
      const res = await createDecision({ title: 'My Decision' }).expect(201);
      expect(res.body.data).toMatchObject({
        title: 'My Decision',
        status: 'pending',
        companyId,
        projectId,
      });
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.decidedAt).toBeNull();
    });

    it('accepts optional description', async () => {
      const res = await createDecision({
        title: 'Full Decision',
        description: 'A description',
      }).expect(201);
      expect(res.body.data.description).toBe('A description');
    });

    it('returns 400 without title', async () => {
      await request(app)
        .post(decisionsUrl)
        .send({ description: 'no title' })
        .expect(400);
    });

    it('inherits companyId/projectId from route', async () => {
      const res = await createDecision({ title: 'Scoped Decision' }).expect(201);
      expect(res.body.data.companyId).toBe(companyId);
      expect(res.body.data.projectId).toBe(projectId);
    });

    it('creates a linked decision with planId and planStepId', async () => {
      const { plan, step } = await createPlanAndStep();
      const res = await createDecision({
        title: 'Linked Decision',
        planId: plan.id,
        planStepId: step.id,
      }).expect(201);
      expect(res.body.data.planId).toBe(plan.id);
      expect(res.body.data.planStepId).toBe(step.id);
    });

    it('returns 400 when planStepId does not belong to planId', async () => {
      const { plan } = await createPlanAndStep();
      // Create a second plan + step; step belongs to a different plan
      const plan2 = await request(app)
        .post(plansUrl)
        .send({ title: 'Plan 2' })
        .expect(201);
      const step2 = await request(app)
        .post(`${plansUrl}/${plan2.body.data.id}/steps`)
        .send({ title: 'Step 2' })
        .expect(201);

      await createDecision({
        title: 'Bad Link',
        planId: plan.id,
        planStepId: step2.body.data.id,
      }).expect(400);
    });

    it('returns 400 for nonexistent planId', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await createDecision({
        title: 'Bad Plan',
        planId: fakeId,
      }).expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-DEC-002: Approve a decision
  // -------------------------------------------------------------------------
  describe('PATCH /decisions/:id approve — VAL-DEC-002', () => {
    it('sets status=approved, decidedAt, decidedByUserId', async () => {
      const decision = await createDecision({ title: 'Approve Me' }).expect(201);
      const res = await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'approved' })
        .expect(200);
      expect(res.body.data.status).toBe('approved');
      expect(res.body.data.decidedAt).not.toBeNull();
      expect(res.body.data.decidedByUserId).not.toBeNull();
    });

    it('stores optional rationale', async () => {
      const decision = await createDecision({ title: 'Approve Me' }).expect(201);
      const res = await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'approved', rationale: 'Looks good' })
        .expect(200);
      expect(res.body.data.rationale).toBe('Looks good');
    });

    it('decision no longer appears in pending list', async () => {
      const decision = await createDecision({ title: 'Approve Me' }).expect(201);
      await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'approved' })
        .expect(200);

      const res = await request(app)
        .get(`${decisionsUrl}?status=pending`)
        .expect(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(decision.body.data.id);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-DEC-003: Reject a decision
  // -------------------------------------------------------------------------
  describe('PATCH /decisions/:id reject — VAL-DEC-003', () => {
    it('sets status=rejected, decidedAt, decidedByUserId', async () => {
      const decision = await createDecision({ title: 'Reject Me' }).expect(201);
      const res = await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'rejected' })
        .expect(200);
      expect(res.body.data.status).toBe('rejected');
      expect(res.body.data.decidedAt).not.toBeNull();
      expect(res.body.data.decidedByUserId).not.toBeNull();
    });

    it('stores optional rationale on reject', async () => {
      const decision = await createDecision({ title: 'Reject Me' }).expect(201);
      const res = await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'rejected', rationale: 'Not viable' })
        .expect(200);
      expect(res.body.data.rationale).toBe('Not viable');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-DEC-004: Supersede a decision
  // -------------------------------------------------------------------------
  describe('PATCH /decisions/:id supersede — VAL-DEC-004', () => {
    it('links old decision to replacement via supersededById', async () => {
      const oldDecision = await createDecision({ title: 'Old' }).expect(201);
      const newDecision = await createDecision({ title: 'New' }).expect(201);

      const res = await request(app)
        .patch(`${decisionsUrl}/${oldDecision.body.data.id}`)
        .send({ status: 'superseded', supersededById: newDecision.body.data.id })
        .expect(200);
      expect(res.body.data.status).toBe('superseded');
      expect(res.body.data.supersededById).toBe(newDecision.body.data.id);
    });

    it('superseded decisions excluded from pending list', async () => {
      const oldDecision = await createDecision({ title: 'Old' }).expect(201);
      const newDecision = await createDecision({ title: 'New' }).expect(201);

      await request(app)
        .patch(`${decisionsUrl}/${oldDecision.body.data.id}`)
        .send({ status: 'superseded', supersededById: newDecision.body.data.id })
        .expect(200);

      const res = await request(app)
        .get(`${decisionsUrl}?status=pending`)
        .expect(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(oldDecision.body.data.id);
      // New decision is still pending
      expect(ids).toContain(newDecision.body.data.id);
    });

    it('replacement decision keeps its own independent status', async () => {
      const oldDecision = await createDecision({ title: 'Old' }).expect(201);
      const newDecision = await createDecision({ title: 'New' }).expect(201);

      await request(app)
        .patch(`${decisionsUrl}/${oldDecision.body.data.id}`)
        .send({ status: 'superseded', supersededById: newDecision.body.data.id })
        .expect(200);

      const res = await request(app)
        .get(`${decisionsUrl}/${newDecision.body.data.id}`)
        .expect(200);
      expect(res.body.data.status).toBe('pending');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-DEC-006: List decisions with status filter
  // -------------------------------------------------------------------------
  describe('GET /decisions with status filter — VAL-DEC-006', () => {
    it('returns all decisions without filter', async () => {
      await createDecision({ title: 'D1' });
      await createDecision({ title: 'D2' });
      const res = await request(app).get(decisionsUrl).expect(200);
      expect(res.body.data).toHaveLength(2);
    });

    it('GET ?status=pending returns only pending', async () => {
      const d1 = await createDecision({ title: 'Pending 1' }).expect(201);
      const d2 = await createDecision({ title: 'To Approve' }).expect(201);
      await request(app)
        .patch(`${decisionsUrl}/${d2.body.data.id}`)
        .send({ status: 'approved' })
        .expect(200);

      const res = await request(app)
        .get(`${decisionsUrl}?status=pending`)
        .expect(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).toContain(d1.body.data.id);
      expect(ids).not.toContain(d2.body.data.id);
    });

    it('GET ?status=approved returns only approved', async () => {
      const d1 = await createDecision({ title: 'Stay Pending' }).expect(201);
      const d2 = await createDecision({ title: 'Approve' }).expect(201);
      await request(app)
        .patch(`${decisionsUrl}/${d2.body.data.id}`)
        .send({ status: 'approved' })
        .expect(200);

      const res = await request(app)
        .get(`${decisionsUrl}?status=approved`)
        .expect(200);
      const ids = res.body.data.map((d: { id: string }) => d.id);
      expect(ids).toContain(d2.body.data.id);
      expect(ids).not.toContain(d1.body.data.id);
    });

    it('returns [] for project with no decisions', async () => {
      const res = await request(app).get(decisionsUrl).expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-DEC-008: Cross-company decision access returns 404
  // -------------------------------------------------------------------------
  describe('Cross-company access — VAL-DEC-008', () => {
    it('GET /decisions from wrong company project returns 404', async () => {
      await request(app)
        .get(`/api/companies/${otherCompanyId}/projects/${projectId}/decisions`)
        .expect(404);
    });

    it('POST /decisions to wrong company project returns 404', async () => {
      await request(app)
        .post(`/api/companies/${otherCompanyId}/projects/${projectId}/decisions`)
        .send({ title: 'X' })
        .expect(404);
    });

    it('PATCH /decisions/:id to wrong company returns 404', async () => {
      const decision = await createDecision({ title: 'Mine' }).expect(201);
      await request(app)
        .patch(
          `/api/companies/${otherCompanyId}/projects/${projectId}/decisions/${decision.body.data.id}`,
        )
        .send({ status: 'approved' })
        .expect(404);
    });

    it('GET /decisions/:id from wrong company returns 404', async () => {
      const decision = await createDecision({ title: 'Mine' }).expect(201);
      await request(app)
        .get(
          `/api/companies/${otherCompanyId}/projects/${projectId}/decisions/${decision.body.data.id}`,
        )
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-DEC-010: Cannot re-resolve a completed decision
  // -------------------------------------------------------------------------
  describe('Cannot re-resolve — VAL-DEC-010', () => {
    it('PATCH on already-approved decision returns 400', async () => {
      const decision = await createDecision({ title: 'Done' }).expect(201);
      await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'approved' })
        .expect(200);

      await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'rejected' })
        .expect(400);
    });

    it('PATCH on already-rejected decision returns 400', async () => {
      const decision = await createDecision({ title: 'Done' }).expect(201);
      await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'rejected' })
        .expect(200);

      await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'approved' })
        .expect(400);
    });

    it('PATCH on already-superseded decision returns 400', async () => {
      const old = await createDecision({ title: 'Old' }).expect(201);
      const replacement = await createDecision({ title: 'New' }).expect(201);
      await request(app)
        .patch(`${decisionsUrl}/${old.body.data.id}`)
        .send({ status: 'superseded', supersededById: replacement.body.data.id })
        .expect(200);

      await request(app)
        .patch(`${decisionsUrl}/${old.body.data.id}`)
        .send({ status: 'approved' })
        .expect(400);
    });

    it('PATCH with invalid status returns 400', async () => {
      const decision = await createDecision({ title: 'Pending' }).expect(201);
      await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'invalid' })
        .expect(400);
    });

    it('PATCH superseded without supersededById returns 400', async () => {
      const decision = await createDecision({ title: 'Pending' }).expect(201);
      await request(app)
        .patch(`${decisionsUrl}/${decision.body.data.id}`)
        .send({ status: 'superseded' })
        .expect(400);
    });

    it('PATCH with nonexistent decisionId returns 404', async () => {
      await request(app)
        .patch(`${decisionsUrl}/00000000-0000-0000-0000-000000000000`)
        .send({ status: 'approved' })
        .expect(404);
    });
  });
});
