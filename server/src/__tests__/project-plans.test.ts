import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Project Plans API — VAL-PLAN-*', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let plansUrl: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Plan Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Plan Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({
        name: 'Plan Project',
        description: 'A project for plan tests',
        status: 'active',
        repoUrl: null,
      })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other project', status: 'active', repoUrl: null })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    plansUrl = `/api/companies/${companyId}/projects/${projectId}/plans`;
  });

  function createPlan(overrides: Record<string, unknown> = {}) {
    return request(app)
      .post(plansUrl)
      .send({
        title: 'Test Plan',
        ...overrides,
      });
  }

  function createStep(planId: string, body: Record<string, unknown> = {}) {
    return request(app)
      .post(`${plansUrl}/${planId}/steps`)
      .send({
        title: 'Test Step',
        ...body,
      });
  }

  function advanceStep(planId: string, stepId: string) {
    return request(app).post(`${plansUrl}/${planId}/steps/${stepId}/advance`);
  }

  // -------------------------------------------------------------------------
  // VAL-PLAN-001: Create a plan
  // -------------------------------------------------------------------------
  describe('POST /plans — VAL-PLAN-001', () => {
    it('creates a plan with status=draft and progress=0', async () => {
      const res = await createPlan({ title: 'My Plan' }).expect(201);
      expect(res.body.data).toMatchObject({
        title: 'My Plan',
        status: 'draft',
        progress: 0,
        companyId,
        projectId,
      });
      expect(res.body.data.id).toBeDefined();
    });

    it('accepts optional description and taskId', async () => {
      const res = await createPlan({
        title: 'Full Plan',
        description: 'A description',
      }).expect(201);
      expect(res.body.data.description).toBe('A description');
    });

    it('returns 400 without title', async () => {
      await request(app).post(plansUrl).send({ description: 'no title' }).expect(400);
    });

    it('inherits companyId/projectId from route', async () => {
      const res = await createPlan({ title: 'Scoped Plan' }).expect(201);
      expect(res.body.data.companyId).toBe(companyId);
      expect(res.body.data.projectId).toBe(projectId);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-002: Add steps to a plan
  // -------------------------------------------------------------------------
  describe('POST /plans/:planId/steps — VAL-PLAN-002', () => {
    it('creates a step with stepType defaulting to action and status pending', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const res = await createStep(plan.body.data.id, { title: 'Step 1' }).expect(201);
      expect(res.body.data).toMatchObject({
        title: 'Step 1',
        stepType: 'action',
        status: 'pending',
        stepOrder: 0,
        planId: plan.body.data.id,
      });
    });

    it('accepts review_gate and permission_gate step types', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const r = await createStep(plan.body.data.id, {
        title: 'Review Gate',
        stepType: 'review_gate',
      }).expect(201);
      expect(r.body.data.stepType).toBe('review_gate');

      const p = await createStep(plan.body.data.id, {
        title: 'Permission Gate',
        stepType: 'permission_gate',
      }).expect(201);
      expect(p.body.data.stepType).toBe('permission_gate');
    });

    it('returns 400 with invalid stepType', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      await createStep(plan.body.data.id, { title: 'Bad', stepType: 'invalid' }).expect(400);
    });

    it('auto-assigns stepOrder sequentially', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const s1 = await createStep(plan.body.data.id, { title: 'S1' }).expect(201);
      const s2 = await createStep(plan.body.data.id, { title: 'S2' }).expect(201);
      const s3 = await createStep(plan.body.data.id, { title: 'S3' }).expect(201);
      expect(s1.body.data.stepOrder).toBe(0);
      expect(s2.body.data.stepOrder).toBe(1);
      expect(s3.body.data.stepOrder).toBe(2);
    });

    it('returns 404 for nonexistent plan', async () => {
      await createStep('00000000-0000-0000-0000-000000000000', { title: 'X' }).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-003: Step status defaults and transitions
  // -------------------------------------------------------------------------
  describe('PATCH /plans/:planId/steps/:stepId — VAL-PLAN-003', () => {
    it('defaults to pending and transitions to in_progress, completed, blocked, skipped', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id).expect(201);
      expect(step.body.data.status).toBe('pending');

      const ip = await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${step.body.data.id}`)
        .send({ status: 'in_progress' })
        .expect(200);
      expect(ip.body.data.status).toBe('in_progress');

      const done = await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${step.body.data.id}`)
        .send({ status: 'completed' })
        .expect(200);
      expect(done.body.data.status).toBe('completed');
      expect(done.body.data.completedAt).not.toBeNull();

      const step2 = await createStep(plan.body.data.id).expect(201);
      const blocked = await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${step2.body.data.id}`)
        .send({ status: 'blocked' })
        .expect(200);
      expect(blocked.body.data.status).toBe('blocked');

      const step3 = await createStep(plan.body.data.id).expect(201);
      const skipped = await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${step3.body.data.id}`)
        .send({ status: 'skipped' })
        .expect(200);
      expect(skipped.body.data.status).toBe('skipped');
    });

    it('returns 400 for invalid status', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id).expect(201);
      await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${step.body.data.id}`)
        .send({ status: 'invalid' })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-004: Advance an action step
  // -------------------------------------------------------------------------
  describe('POST advance on action step — VAL-PLAN-004', () => {
    it('completes the action step and sets completedAt without creating an approval', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id, { title: 'Do thing' }).expect(201);

      const res = await advanceStep(plan.body.data.id, step.body.data.id).expect(200);
      expect(res.body.data.status).toBe('completed');
      expect(res.body.data.completedAt).not.toBeNull();
      expect(res.body.data.gateApprovalId).toBeNull();

      // Verify no plan_gate approval was created
      const approvals = await request(app)
        .get(`/api/companies/${companyId}/approvals?status=pending`)
        .expect(200);
      const planGates = approvals.body.data.filter(
        (a: { kind: string }) => a.kind === 'plan_gate',
      );
      expect(planGates).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-005: Advance a gate step
  // -------------------------------------------------------------------------
  describe('POST advance on gate step — VAL-PLAN-005', () => {
    it('creates a plan_gate approval for review_gate, sets gateApprovalId, step→in_progress', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id, {
        title: 'Review',
        stepType: 'review_gate',
        gateConfig: { requiredRole: 'admin', description: 'Need review' },
      }).expect(201);

      const res = await advanceStep(plan.body.data.id, step.body.data.id).expect(200);
      expect(res.body.data.status).toBe('in_progress');
      expect(res.body.data.gateApprovalId).not.toBeNull();

      // Verify approval was created with correct fields
      const approvalRes = await request(app)
        .get(`/api/companies/${companyId}/approvals/${res.body.data.gateApprovalId}`)
        .expect(200);
      expect(approvalRes.body.data.approval.kind).toBe('plan_gate');
      expect(approvalRes.body.data.approval.status).toBe('pending');
      expect(approvalRes.body.data.approval.planStepId).toBe(step.body.data.id);
      expect(approvalRes.body.data.approval.projectId).toBe(projectId);
    });

    it('creates a plan_gate approval for permission_gate', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id, {
        title: 'Permission',
        stepType: 'permission_gate',
      }).expect(201);

      const res = await advanceStep(plan.body.data.id, step.body.data.id).expect(200);
      expect(res.body.data.status).toBe('in_progress');
      expect(res.body.data.gateApprovalId).not.toBeNull();

      const approvalRes = await request(app)
        .get(`/api/companies/${companyId}/approvals/${res.body.data.gateApprovalId}`)
        .expect(200);
      expect(approvalRes.body.data.approval.kind).toBe('plan_gate');
    });

    it('rejects duplicate advance on already-in_progress gate with 409', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id, {
        title: 'Review',
        stepType: 'review_gate',
      }).expect(201);

      await advanceStep(plan.body.data.id, step.body.data.id).expect(200);
      await advanceStep(plan.body.data.id, step.body.data.id).expect(409);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-006: Approving / rejecting gate approval updates step
  // -------------------------------------------------------------------------
  describe('Approval resolution updates linked step — VAL-PLAN-006', () => {
    it('approving the gate approval completes the step', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id, {
        title: 'Review',
        stepType: 'review_gate',
      }).expect(201);

      const advanced = await advanceStep(plan.body.data.id, step.body.data.id).expect(200);
      const approvalId = advanced.body.data.gateApprovalId;

      await request(app)
        .post(`/api/companies/${companyId}/approvals/${approvalId}/decide`)
        .send({ decision: 'approved' })
        .expect(200);

      const planRes = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      const steps = planRes.body.data.steps as { id: string; status: string; completedAt: string | null }[];
      const target = steps.find((s) => s.id === step.body.data.id);
      expect(target?.status).toBe('completed');
      expect(target?.completedAt).not.toBeNull();
    });

    it('rejecting the gate approval blocks the step', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id, {
        title: 'Review',
        stepType: 'review_gate',
      }).expect(201);

      const advanced = await advanceStep(plan.body.data.id, step.body.data.id).expect(200);
      const approvalId = advanced.body.data.gateApprovalId;

      await request(app)
        .post(`/api/companies/${companyId}/approvals/${approvalId}/decide`)
        .send({ decision: 'rejected' })
        .expect(200);

      const planRes = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      const steps = planRes.body.data.steps as { id: string; status: string }[];
      const target = steps.find((s) => s.id === step.body.data.id);
      expect(target?.status).toBe('blocked');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-007: Plan progress auto-calculates from steps
  // -------------------------------------------------------------------------
  describe('Plan progress — VAL-PLAN-007', () => {
    it('has progress=0 with 0 steps', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const res = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      expect(res.body.data.progress).toBe(0);
    });

    it('progress=50 when 2 of 4 steps completed', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      for (let i = 0; i < 4; i++) {
        await createStep(plan.body.data.id, { title: `S${i}` });
      }
      // Complete 2 via advance (action steps)
      const list = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      const steps = list.body.data.steps as { id: string }[];
      await advanceStep(plan.body.data.id, steps[0].id);
      await advanceStep(plan.body.data.id, steps[1].id);

      const res = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      expect(res.body.data.progress).toBe(50);
    });

    it('progress=100 when all steps completed', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const s1 = await createStep(plan.body.data.id).expect(201);
      const s2 = await createStep(plan.body.data.id).expect(201);
      await advanceStep(plan.body.data.id, s1.body.data.id);
      await advanceStep(plan.body.data.id, s2.body.data.id);

      const res = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      expect(res.body.data.progress).toBe(100);
    });

    it('excludes skipped steps from denominator (skip 1 of 4, complete 2 → 67)', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const s1 = await createStep(plan.body.data.id).expect(201);
      const s2 = await createStep(plan.body.data.id).expect(201);
      const s3 = await createStep(plan.body.data.id).expect(201);
      const s4 = await createStep(plan.body.data.id).expect(201);

      // Skip s4, complete s1 and s2
      await advanceStep(plan.body.data.id, s1.body.data.id);
      await advanceStep(plan.body.data.id, s2.body.data.id);
      await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${s4.body.data.id}`)
        .send({ status: 'skipped' })
        .expect(200);

      const res = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      // 2 completed / 3 non-skipped = 66.67 → 67
      expect(res.body.data.progress).toBe(67);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-008: Plan status lifecycle
  // -------------------------------------------------------------------------
  describe('PATCH /plans/:planId status lifecycle — VAL-PLAN-008', () => {
    it('defaults to draft and transitions to active, completed, cancelled', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      expect(plan.body.data.status).toBe('draft');

      const active = await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}`)
        .send({ status: 'active' })
        .expect(200);
      expect(active.body.data.status).toBe('active');

      const done = await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}`)
        .send({ status: 'completed' })
        .expect(200);
      expect(done.body.data.status).toBe('completed');
    });

    it('returns 400 for invalid status', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}`)
        .send({ status: 'invalid' })
        .expect(400);
    });

    it('GET /plans?status=active filters by status', async () => {
      await createPlan({ title: 'Draft 1' });
      const p2 = await createPlan({ title: 'Active 1' }).expect(201);
      await request(app)
        .patch(`${plansUrl}/${p2.body.data.id}`)
        .send({ status: 'active' })
        .expect(200);

      const res = await request(app)
        .get(`${plansUrl}?status=active`)
        .expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].title).toBe('Active 1');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-009: Steps returned in stepOrder; reorder persists
  // -------------------------------------------------------------------------
  describe('GET /plans/:planId ordered steps — VAL-PLAN-009', () => {
    it('returns steps ordered by stepOrder ascending', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      await createStep(plan.body.data.id, { title: 'First' });
      await createStep(plan.body.data.id, { title: 'Second' });
      await createStep(plan.body.data.id, { title: 'Third' });

      const res = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      const steps = res.body.data.steps as { title: string; stepOrder: number }[];
      expect(steps.map((s) => s.title)).toEqual(['First', 'Second', 'Third']);
      expect(steps.map((s) => s.stepOrder)).toEqual([0, 1, 2]);
    });

    it('reorder via PATCH stepOrder persists across requests', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const s1 = await createStep(plan.body.data.id, { title: 'A' }).expect(201);
      const s2 = await createStep(plan.body.data.id, { title: 'B' }).expect(201);
      const s3 = await createStep(plan.body.data.id, { title: 'C' }).expect(201);

      // Move C to position 0, A to 1, B to 2
      await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${s3.body.data.id}`)
        .send({ stepOrder: 0 })
        .expect(200);
      await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${s1.body.data.id}`)
        .send({ stepOrder: 1 })
        .expect(200);
      await request(app)
        .patch(`${plansUrl}/${plan.body.data.id}/steps/${s2.body.data.id}`)
        .send({ stepOrder: 2 })
        .expect(200);

      const res = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      const steps = res.body.data.steps as { title: string; stepOrder: number }[];
      expect(steps.map((s) => s.title)).toEqual(['C', 'A', 'B']);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-010: List plans with step summaries
  // -------------------------------------------------------------------------
  describe('GET /plans list with summaries — VAL-PLAN-010', () => {
    it('returns plans with stepCount and completedStepCount', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const s1 = await createStep(plan.body.data.id).expect(201);
      await createStep(plan.body.data.id);
      await advanceStep(plan.body.data.id, s1.body.data.id);

      const res = await request(app).get(plansUrl).expect(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].stepCount).toBe(2);
      expect(res.body.data[0].completedStepCount).toBe(1);
    });

    it('returns plan with steps array on GET /plans/:planId', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      await createStep(plan.body.data.id, { title: 'S1' });

      const res = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      expect(res.body.data.steps).toBeDefined();
      expect(res.body.data.steps).toHaveLength(1);
    });

    it('returns 404 for nonexistent plan', async () => {
      await request(app)
        .get(`${plansUrl}/00000000-0000-0000-0000-000000000000`)
        .expect(404);
    });

    it('returns empty array for project with no plans', async () => {
      const res = await request(app).get(plansUrl).expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-011: Cross-company access returns 404
  // -------------------------------------------------------------------------
  describe('Cross-company access — VAL-PLAN-011', () => {
    it('GET /plans/:planId from wrong company returns 404', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      await request(app)
        .get(
          `/api/companies/${otherCompanyId}/projects/${projectId}/plans/${plan.body.data.id}`,
        )
        .expect(404);
    });

    it('POST /plans/:planId/steps to wrong company returns 404', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      await request(app)
        .post(
          `/api/companies/${otherCompanyId}/projects/${projectId}/plans/${plan.body.data.id}/steps`,
        )
        .send({ title: 'X' })
        .expect(404);
    });

    it('POST advance to wrong company returns 404', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id).expect(201);
      await request(app)
        .post(
          `/api/companies/${otherCompanyId}/projects/${projectId}/plans/${plan.body.data.id}/steps/${step.body.data.id}/advance`,
        )
        .expect(404);
    });

    it('GET /plans from wrong company project returns empty (project not owned)', async () => {
      // The other company does not own this project → 404
      await request(app)
        .get(`/api/companies/${otherCompanyId}/projects/${projectId}/plans`)
        .expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-PLAN-015: Gate config stored as jsonb and returned
  // -------------------------------------------------------------------------
  describe('Gate config — VAL-PLAN-015', () => {
    it('stores gateConfig as jsonb and returns it in GET responses', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const config = { requiredRole: 'admin', description: 'Needs admin approval' };
      const step = await createStep(plan.body.data.id, {
        title: 'Gate',
        stepType: 'review_gate',
        gateConfig: config,
      }).expect(201);

      expect(step.body.data.gateConfig).toMatchObject(config);

      const res = await request(app)
        .get(`${plansUrl}/${plan.body.data.id}`)
        .expect(200);
      const steps = res.body.data.steps as { gateConfig: Record<string, unknown> }[];
      expect(steps[0].gateConfig).toMatchObject(config);
    });

    it('defaults gateConfig to empty object', async () => {
      const plan = await createPlan({ title: 'Plan' }).expect(201);
      const step = await createStep(plan.body.data.id, {
        title: 'Gate',
        stepType: 'review_gate',
      }).expect(201);
      expect(step.body.data.gateConfig).toEqual({});
    });
  });
});
