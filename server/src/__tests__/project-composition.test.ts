import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Project Composition Endpoints — VAL-CROSS-006/007/010, VAL-DEC-007', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let threadsUrl: string;
  let plansUrl: string;
  let decisionsUrl: string;
  let outcomesUrl: string;
  let homeUrl: string;
  let workUrl: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Composition Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Composition Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Composition Project', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other Project', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    threadsUrl = `/api/companies/${companyId}/projects/${projectId}/threads`;
    plansUrl = `/api/companies/${companyId}/projects/${projectId}/plans`;
    decisionsUrl = `/api/companies/${companyId}/projects/${projectId}/decisions`;
    outcomesUrl = `/api/companies/${companyId}/projects/${projectId}/outcomes`;
    homeUrl = `/api/companies/${companyId}/projects/${projectId}/home`;
    workUrl = `/api/companies/${companyId}/projects/${projectId}/work`;
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function createThread(title: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app).post(threadsUrl).send({ title, ...overrides }).expect(201);
    return res.body.data;
  }

  async function createThreadItem(threadId: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post(`${threadsUrl}/${threadId}/items`)
      .send({ kind: 'comment', content: 'Hello', ...overrides })
      .expect(201);
    return res.body.data;
  }

  async function createPlan(title: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app).post(plansUrl).send({ title, ...overrides }).expect(201);
    return res.body.data;
  }

  async function createPlanStep(planId: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post(`${plansUrl}/${planId}/steps`)
      .send({ title: 'Step', ...overrides })
      .expect(201);
    return res.body.data;
  }

  async function updatePlanStep(
    planId: string,
    stepId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const res = await request(app)
      .patch(`${plansUrl}/${planId}/steps/${stepId}`)
      .send(overrides)
      .expect(200);
    return res.body.data;
  }

  async function createDecision(title: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post(decisionsUrl)
      .send({ title, ...overrides })
      .expect(201);
    return res.body.data;
  }

  async function createOutcome(title: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post(outcomesUrl)
      .send({ type: 'document', title, ...overrides })
      .expect(201);
    return res.body.data;
  }

  // =========================================================================
  // GET /home — Extended composition (VAL-CROSS-006, VAL-DEC-007)
  // =========================================================================
  describe('GET /home — VAL-CROSS-006: extended composed data', () => {
    it('includes recentThreadItems, pendingDecisions, and activePlanProgress keys', async () => {
      const res = await request(app).get(homeUrl).expect(200);

      const data = res.body.data;
      expect(data).toHaveProperty('recentThreadItems');
      expect(data).toHaveProperty('pendingDecisions');
      expect(data).toHaveProperty('activePlanProgress');
    });

    it('preserves existing /home fields (no breaking changes)', async () => {
      const res = await request(app).get(homeUrl).expect(200);

      const data = res.body.data;
      // All existing fields must still be present
      expect(data).toHaveProperty('project');
      expect(data).toHaveProperty('counts');
      expect(data).toHaveProperty('taskStatusBreakdown');
      expect(data).toHaveProperty('activeWork');
      expect(data).toHaveProperty('needsAttention');
      expect(data).toHaveProperty('failedWork');
      expect(data).toHaveProperty('recentActivity');
      expect(data).toHaveProperty('recentFiles');
      expect(data).toHaveProperty('goalProgress');
    });
  });

  describe('GET /home — recentThreadItems (top 5 from active threads)', () => {
    it('returns empty array for a project with no threads', async () => {
      const res = await request(app).get(homeUrl).expect(200);
      expect(res.body.data.recentThreadItems).toEqual([]);
    });

    it('returns up to 5 recent items from active threads', async () => {
      const thread = await createThread('Thread 1');
      // Post 7 items — only 5 should come back
      for (let i = 0; i < 7; i++) {
        await createThreadItem(thread.id, { content: `Message ${i}` });
      }

      const res = await request(app).get(homeUrl).expect(200);
      const items = res.body.data.recentThreadItems;
      expect(items).toHaveLength(5);
      // All items should have projectThreadId set
      for (const item of items) {
        expect(item.projectThreadId).toBe(thread.id);
      }
    });

    it('only includes items from active threads, not archived ones', async () => {
      const activeThread = await createThread('Active Thread');
      const archivedThread = await createThread('Archived Thread');

      // Archive the second thread via direct DB update (no archive endpoint)
      await db.drizzle
        .update(db.schema.projectThreads)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(db.schema.projectThreads.id, archivedThread.id));

      await createThreadItem(activeThread.id, { content: 'Active message' });
      await createThreadItem(archivedThread.id, { content: 'Archived message' });

      const res = await request(app).get(homeUrl).expect(200);
      const items = res.body.data.recentThreadItems;
      expect(items).toHaveLength(1);
      expect(items[0].content).toBe('Active message');
    });

    it('aggregates items across multiple active threads', async () => {
      const thread1 = await createThread('Thread 1');
      const thread2 = await createThread('Thread 2');

      await createThreadItem(thread1.id, { content: 'T1 msg' });
      await createThreadItem(thread2.id, { content: 'T2 msg' });

      const res = await request(app).get(homeUrl).expect(200);
      const items = res.body.data.recentThreadItems;
      expect(items).toHaveLength(2);
    });
  });

  describe('GET /home — pendingDecisions (top 5 status=pending) — VAL-DEC-007', () => {
    it('returns empty array for a project with no decisions', async () => {
      const res = await request(app).get(homeUrl).expect(200);
      expect(res.body.data.pendingDecisions).toEqual([]);
    });

    it('returns up to 5 pending decisions', async () => {
      for (let i = 0; i < 7; i++) {
        await createDecision(`Decision ${i}`);
      }

      const res = await request(app).get(homeUrl).expect(200);
      const decisions = res.body.data.pendingDecisions;
      expect(decisions).toHaveLength(5);
      for (const d of decisions) {
        expect(d.status).toBe('pending');
      }
    });

    it('excludes non-pending decisions', async () => {
      const pending = await createDecision('Pending decision');
      const approved = await createDecision('Approved decision');
      await request(app)
        .patch(`${decisionsUrl}/${approved.id}`)
        .send({ status: 'approved' })
        .expect(200);

      const res = await request(app).get(homeUrl).expect(200);
      const decisions = res.body.data.pendingDecisions;
      expect(decisions).toHaveLength(1);
      expect(decisions[0].id).toBe(pending.id);
    });
  });

  describe('GET /home — activePlanProgress (top 3 active plans with step counts)', () => {
    it('returns empty array for a project with no active plans', async () => {
      const res = await request(app).get(homeUrl).expect(200);
      expect(res.body.data.activePlanProgress).toEqual([]);
    });

    it('returns up to 3 active plans with stepCount and completedStepCount', async () => {
      // Create 4 plans, activate 3 of them, add steps
      const plan1 = await createPlan('Plan 1');
      const plan2 = await createPlan('Plan 2');
      const plan3 = await createPlan('Plan 3');
      const plan4 = await createPlan('Plan 4 (draft)');

      // Activate plans 1-3
      for (const p of [plan1, plan2, plan3]) {
        await request(app)
          .patch(`${plansUrl}/${p.id}`)
          .send({ status: 'active' })
          .expect(200);
      }

      // Add steps to plan1: 2 completed, 1 pending
      const s1 = await createPlanStep(plan1.id, { title: 'Step 1' });
      const s2 = await createPlanStep(plan1.id, { title: 'Step 2' });
      await createPlanStep(plan1.id, { title: 'Step 3' });
      await updatePlanStep(plan1.id, s1.id, { status: 'completed' });
      await updatePlanStep(plan1.id, s2.id, { status: 'completed' });

      // Add 1 step to plan2
      await createPlanStep(plan2.id, { title: 'Step A' });

      const res = await request(app).get(homeUrl).expect(200);
      const plans = res.body.data.activePlanProgress;
      expect(plans).toHaveLength(3);

      const p1Data = plans.find((p: any) => p.id === plan1.id);
      expect(p1Data).toBeDefined();
      expect(p1Data.stepCount).toBe(3);
      expect(p1Data.completedStepCount).toBe(2);

      const p2Data = plans.find((p: any) => p.id === plan2.id);
      expect(p2Data).toBeDefined();
      expect(p2Data.stepCount).toBe(1);
      expect(p2Data.completedStepCount).toBe(0);

      const p4Data = plans.find((p: any) => p.id === plan4.id);
      expect(p4Data).toBeUndefined(); // draft plan should not appear
    });
  });

  // =========================================================================
  // GET /work — New composed endpoint (VAL-CROSS-007)
  // =========================================================================
  describe('GET /work — VAL-CROSS-007: composed work data', () => {
    it('returns 200 with plans, outcomes, and threadSummary keys', async () => {
      const res = await request(app).get(workUrl).expect(200);

      const data = res.body.data;
      expect(data).toHaveProperty('plans');
      expect(data).toHaveProperty('outcomes');
      expect(data).toHaveProperty('threadSummary');
    });

    it('returns empty arrays and zero counts for an empty project', async () => {
      const res = await request(app).get(workUrl).expect(200);

      const data = res.body.data;
      expect(data.plans).toEqual([]);
      expect(data.outcomes).toEqual([]);
      expect(data.threadSummary).toEqual({
        activeThreadCount: 0,
        pendingInteractionCount: 0,
      });
    });
  });

  describe('GET /work — plans with step status summaries', () => {
    it('returns all plans with stepCount and completedStepCount', async () => {
      const plan1 = await createPlan('Plan 1');
      const plan2 = await createPlan('Plan 2');

      // Add steps to plan1
      const s1 = await createPlanStep(plan1.id, { title: 'Step 1' });
      await createPlanStep(plan1.id, { title: 'Step 2' });
      await updatePlanStep(plan1.id, s1.id, { status: 'completed' });

      const res = await request(app).get(workUrl).expect(200);
      const plans = res.body.data.plans;
      expect(plans).toHaveLength(2);

      const p1 = plans.find((p: any) => p.id === plan1.id);
      expect(p1).toBeDefined();
      expect(p1.stepCount).toBe(2);
      expect(p1.completedStepCount).toBe(1);

      const p2 = plans.find((p: any) => p.id === plan2.id);
      expect(p2).toBeDefined();
      expect(p2.stepCount).toBe(0);
      expect(p2.completedStepCount).toBe(0);
    });
  });

  describe('GET /work — recent outcomes (top 20)', () => {
    it('returns up to 20 recent outcomes ordered by createdAt desc', async () => {
      for (let i = 0; i < 25; i++) {
        await createOutcome(`Outcome ${i}`);
      }

      const res = await request(app).get(workUrl).expect(200);
      const outcomes = res.body.data.outcomes;
      expect(outcomes).toHaveLength(20);
      // Verify descending order
      for (let i = 1; i < outcomes.length; i++) {
        expect(new Date(outcomes[i].createdAt).getTime()).toBeLessThanOrEqual(
          new Date(outcomes[i - 1].createdAt).getTime(),
        );
      }
    });

    it('returns all outcomes when fewer than 20 exist', async () => {
      for (let i = 0; i < 3; i++) {
        await createOutcome(`Outcome ${i}`);
      }

      const res = await request(app).get(workUrl).expect(200);
      expect(res.body.data.outcomes).toHaveLength(3);
    });
  });

  describe('GET /work — threadSummary', () => {
    it('returns activeThreadCount and pendingInteractionCount', async () => {
      const thread1 = await createThread('Thread 1');
      const thread2 = await createThread('Thread 2');

      // Add some interaction items (pending) to thread1
      await createThreadItem(thread1.id, { kind: 'interaction', status: 'pending' });
      await createThreadItem(thread1.id, { kind: 'interaction', status: 'pending' });
      // Add a comment (should not count as pending interaction)
      await createThreadItem(thread1.id, { kind: 'comment' });
      // Add a resolved interaction (should not count)
      await createThreadItem(thread1.id, { kind: 'interaction', status: 'accepted' });

      const res = await request(app).get(workUrl).expect(200);
      const summary = res.body.data.threadSummary;
      expect(summary.activeThreadCount).toBe(2);
      expect(summary.pendingInteractionCount).toBe(2);
    });

    it('excludes archived threads from activeThreadCount', async () => {
      const activeThread = await createThread('Active');
      const archivedThread = await createThread('To Archive');

      await db.drizzle
        .update(db.schema.projectThreads)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(db.schema.projectThreads.id, archivedThread.id));

      const res = await request(app).get(workUrl).expect(200);
      expect(res.body.data.threadSummary.activeThreadCount).toBe(1);
    });
  });

  // =========================================================================
  // Cross-company boundary (VAL-CROSS-006/007)
  // =========================================================================
  describe('Cross-company boundary — both endpoints', () => {
    it('GET /home returns 404 for cross-company project access', async () => {
      await request(app)
        .get(`/api/companies/${otherCompanyId}/projects/${projectId}/home`)
        .expect(404);
    });

    it('GET /work returns 404 for cross-company project access', async () => {
      await request(app)
        .get(`/api/companies/${otherCompanyId}/projects/${projectId}/work`)
        .expect(404);
    });

    it('GET /home returns 404 for nonexistent project', async () => {
      await request(app)
        .get(`/api/companies/${companyId}/projects/${randomUUID()}/home`)
        .expect(404);
    });

    it('GET /work returns 404 for nonexistent project', async () => {
      await request(app)
        .get(`/api/companies/${companyId}/projects/${randomUUID()}/work`)
        .expect(404);
    });

    it('does not leak cross-company data in /home composed fields', async () => {
      // Seed data in other company's project
      const otherThreadsUrl = `/api/companies/${otherCompanyId}/projects/${otherProjectId}/threads`;
      const otherDecisionsUrl = `/api/companies/${otherCompanyId}/projects/${otherProjectId}/decisions`;
      const otherPlansUrl = `/api/companies/${otherCompanyId}/projects/${otherProjectId}/plans`;

      const otherThread = (
        await request(app).post(otherThreadsUrl).send({ title: 'Other thread' }).expect(201)
      ).body.data;
      await request(app)
        .post(`${otherThreadsUrl}/${otherThread.id}/items`)
        .send({ kind: 'comment', content: 'Other company message' })
        .expect(201);

      await request(app)
        .post(otherDecisionsUrl)
        .send({ title: 'Other decision' })
        .expect(201);

      const otherPlan = (
        await request(app).post(otherPlansUrl).send({ title: 'Other plan' }).expect(201)
      ).body.data;
      await request(app)
        .patch(`${otherPlansUrl}/${otherPlan.id}`)
        .send({ status: 'active' })
        .expect(200);

      // Query our project's /home — should not contain other company's data
      const res = await request(app).get(homeUrl).expect(200);
      expect(res.body.data.recentThreadItems).toEqual([]);
      expect(res.body.data.pendingDecisions).toEqual([]);
      expect(res.body.data.activePlanProgress).toEqual([]);
    });

    it('does not leak cross-company data in /work composed fields', async () => {
      // Seed data in other company's project
      const otherOutcomesUrl = `/api/companies/${otherCompanyId}/projects/${otherProjectId}/outcomes`;
      const otherThreadsUrl = `/api/companies/${otherCompanyId}/projects/${otherProjectId}/threads`;

      await request(app)
        .post(otherOutcomesUrl)
        .send({ type: 'document', title: 'Other outcome' })
        .expect(201);

      const otherThread = (
        await request(app).post(otherThreadsUrl).send({ title: 'Other thread' }).expect(201)
      ).body.data;
      await request(app)
        .post(`${otherThreadsUrl}/${otherThread.id}/items`)
        .send({ kind: 'interaction', status: 'pending' })
        .expect(201);

      // Query our project's /work — should not contain other company's data
      const res = await request(app).get(workUrl).expect(200);
      expect(res.body.data.outcomes).toEqual([]);
      expect(res.body.data.threadSummary.activeThreadCount).toBe(0);
      expect(res.body.data.threadSummary.pendingInteractionCount).toBe(0);
    });
  });

  // =========================================================================
  // VAL-CROSS-010: Project archival preserves all primitives
  // =========================================================================
  describe('VAL-CROSS-010: project archival preserves composed data', () => {
    it('/home and /work still return data after project archival', async () => {
      // Seed data
      const thread = await createThread('Thread');
      await createThreadItem(thread.id, { content: 'Message' });
      await createDecision('Decision');
      const plan = await createPlan('Plan');
      await request(app).patch(`${plansUrl}/${plan.id}`).send({ status: 'active' }).expect(200);
      await createOutcome('Outcome');

      // Archive the project
      await request(app).delete(`/api/companies/${companyId}/projects/${projectId}`).expect(200);

      // /home should still work and return data (not 404)
      const homeRes = await request(app).get(homeUrl).expect(200);
      expect(homeRes.body.data.recentThreadItems.length).toBeGreaterThan(0);
      expect(homeRes.body.data.pendingDecisions.length).toBeGreaterThan(0);
      expect(homeRes.body.data.activePlanProgress.length).toBeGreaterThan(0);

      // /work should still work and return data (not 404)
      const workRes = await request(app).get(workUrl).expect(200);
      expect(workRes.body.data.plans.length).toBeGreaterThan(0);
      expect(workRes.body.data.outcomes.length).toBeGreaterThan(0);
      expect(workRes.body.data.threadSummary.activeThreadCount).toBeGreaterThan(0);
    });
  });
});
