import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq, and, sql } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Project Home Summary Endpoint — VAL-HOME-*', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Home Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Home Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({
        name: 'Home project',
        description: 'A project for home summary tests',
        status: 'active',
        repoUrl: 'https://github.com/org/repo',
      })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other project' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Home Agent', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  // -------------------------------------------------------------------------
  // Helpers — direct DB inserts for rows that can't be created via the API
  // -------------------------------------------------------------------------

  async function insertTask(overrides: {
    title?: string;
    status?: string;
    projectId?: string | null;
    companyId?: string;
    assigneeAgentId?: string | null;
    updatedAt?: Date;
  }): Promise<{ id: string; title: string; status: string; projectId: string | null }> {
    const id = randomUUID();
    const now = overrides.updatedAt ?? new Date();
    const taskProjectId = overrides.projectId === undefined ? projectId : overrides.projectId;
    await db.drizzle
      .insert(db.schema.tasks)
      .values({
        id,
        companyId: overrides.companyId ?? companyId,
        projectId: taskProjectId,
        title: overrides.title ?? 'Test task',
        type: 'feature',
        status: (overrides.status ?? 'backlog') as any,
        priority: 'medium',
        assigneeAgentId: overrides.assigneeAgentId === undefined ? null : overrides.assigneeAgentId,
        dependencies: [],
        tags: [],
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning();
    return { id, title: overrides.title ?? 'Test task', status: overrides.status ?? 'backlog', projectId: taskProjectId };
  }

  async function insertGoal(overrides: {
    title?: string;
    progress?: number;
    projectId?: string | null;
    companyId?: string;
  }): Promise<{ id: string; progress: number }> {
    const id = randomUUID();
    const now = new Date();
    const goalProjectId = overrides.projectId === undefined ? projectId : overrides.projectId;
    await db.drizzle
      .insert(db.schema.goals)
      .values({
        id,
        companyId: overrides.companyId ?? companyId,
        projectId: goalProjectId,
        title: overrides.title ?? 'Test goal',
        level: 'company',
        status: 'active',
        progress: overrides.progress ?? 0,
        metrics: {},
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning();
    return { id, progress: overrides.progress ?? 0 };
  }

  async function insertFile(overrides: {
    name?: string;
    projectId?: string | null;
    companyId?: string;
    createdAt?: Date;
    isDirectory?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    const now = overrides.createdAt ?? new Date();
    const fileProjectId = overrides.projectId === undefined ? projectId : overrides.projectId;
    await db.drizzle
      .insert(db.schema.agentFiles)
      .values({
        id,
        companyId: overrides.companyId ?? companyId,
        agentId: null,
        name: overrides.name ?? 'test.txt',
        path: `/${overrides.name ?? 'test.txt'}`,
        mimeType: 'text/plain',
        sizeBytes: 0,
        content: null,
        storageType: 'inline',
        parentId: null,
        isDirectory: overrides.isDirectory ?? false,
        projectId: fileProjectId,
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning();
    return id;
  }

  async function insertExecution(overrides: {
    taskId?: string | null;
    status?: string;
    companyId?: string;
    agentId?: string;
    updatedAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const now = overrides.updatedAt ?? new Date();
    await db.drizzle
      .insert(db.schema.agentExecutions)
      .values({
        id,
        companyId: overrides.companyId ?? companyId,
        agentId: overrides.agentId ?? agentId,
        taskId: overrides.taskId ?? null,
        status: (overrides.status ?? 'running') as any,
        startedAt: now,
        livenessStatus: 'healthy',
        retryStatus: 'none',
        executionMode: 'single',
        log: [],
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning();
    return id;
  }

  async function insertThreadItem(overrides: {
    taskId: string;
    status?: string;
    companyId?: string;
  }): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle
      .insert(db.schema.taskThreadItems)
      .values({
        id,
        companyId: overrides.companyId ?? companyId,
        taskId: overrides.taskId,
        kind: 'interaction',
        content: 'needs input',
        status: (overrides.status ?? 'pending') as any,
        payload: {},
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning();
    return id;
  }

  async function insertActivity(overrides: {
    action?: string;
    entityType?: string;
    entityId?: string;
    metadata?: Record<string, unknown>;
    companyId?: string;
    createdAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    const now = overrides.createdAt ?? new Date();
    await db.drizzle
      .insert(db.schema.activityLog)
      .values({
        id,
        companyId: overrides.companyId ?? companyId,
        actorType: 'system',
        actorId: 'system',
        action: overrides.action ?? 'project.created',
        entityType: overrides.entityType ?? 'project',
        entityId: overrides.entityId ?? projectId,
        description: 'Test event',
        metadata: overrides.metadata ?? { project: { id: projectId } },
        createdAt: now,
      } as any)
      .returning();
    return id;
  }

  // -------------------------------------------------------------------------
  // VAL-HOME-001: Returns 200 with composed object for a valid project
  // -------------------------------------------------------------------------
  describe('VAL-HOME-001: composed object shape', () => {
    it('returns 200 with all nine top-level keys and correct project id', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const data = res.body.data;
      expect(data).toBeDefined();
      expect(Object.keys(data).sort()).toEqual([
        'activePlanProgress',
        'activeWork',
        'artifacts',
        'counts',
        'failedWork',
        'goalProgress',
        'healthSummary',
        'needsAttention',
        'pendingDecisions',
        'project',
        'recentActivity',
        'recentFiles',
        'recentThreadItems',
        'taskStatusBreakdown',
      ]);
      expect(data.project.id).toBe(projectId);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-002: counts.taskCount/goalCount/agentCount match scoped rows
  // -------------------------------------------------------------------------
  describe('VAL-HOME-002: counts match scoped rows', () => {
    it('taskCount, goalCount, agentCount match direct scoped counts and project detail', async () => {
      await insertTask({ title: 't1', status: 'todo', assigneeAgentId: agentId });
      await insertTask({ title: 't2', status: 'backlog', assigneeAgentId: agentId });
      await insertTask({ title: 't3', status: 'in_progress' });
      // other-project task (should not be counted)
      await insertTask({ title: 'other', projectId: otherProjectId, companyId: otherCompanyId });
      await insertGoal({ title: 'g1', progress: 50 });
      await insertGoal({ title: 'g2', progress: 100 });
      // other-company goal
      await insertGoal({ title: 'other-goal', projectId: null, companyId: otherCompanyId });

      const home = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const detail = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}`)
        .expect(200);

      expect(home.body.data.counts.taskCount).toBe(3);
      expect(home.body.data.counts.goalCount).toBe(2);
      expect(home.body.data.counts.agentCount).toBe(1); // distinct assignee
      expect(home.body.data.counts.taskCount).toBe(detail.body.data.taskCount);
      expect(home.body.data.counts.goalCount).toBe(detail.body.data.goalCount);
      expect(home.body.data.counts.agentCount).toBe(detail.body.data.agentCount);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-003: counts.fileCount matches project files
  // -------------------------------------------------------------------------
  describe('VAL-HOME-003: fileCount matches scoped files', () => {
    it('fileCount excludes project folders and unscoped or foreign files', async () => {
      await insertFile({ name: 'project-folder', isDirectory: true });
      await insertFile({ name: 'f1.txt' });
      await insertFile({ name: 'f2.txt' });
      await insertFile({ name: 'unscoped.txt', projectId: null });
      await insertFile({ name: 'other.txt', projectId: otherProjectId, companyId: otherCompanyId });

      const home = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const filesRes = await request(app)
        .get(`/api/companies/${companyId}/files`)
        .query({ project: projectId })
        .expect(200);

      expect(home.body.data.counts.fileCount).toBe(2);
      expect(filesRes.body.data).toHaveLength(3);
      expect(filesRes.body.data.filter((file: { isDirectory: boolean }) => !file.isDirectory)).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-004: taskStatusBreakdown sums to taskCount and per-status correct
  // -------------------------------------------------------------------------
  describe('VAL-HOME-004: taskStatusBreakdown', () => {
    it('per-status counts are correct and sum to taskCount', async () => {
      await insertTask({ title: 'bl', status: 'backlog' });
      await insertTask({ title: 'td', status: 'todo' });
      await insertTask({ title: 'ip', status: 'in_progress' });
      await insertTask({ title: 'rv', status: 'review' });
      await insertTask({ title: 'dn', status: 'done' });
      await insertTask({ title: 'cn', status: 'cancelled' });
      await insertTask({ title: 'to', status: 'timed_out' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const b = res.body.data.taskStatusBreakdown;
      expect(b.backlog).toBe(1);
      expect(b.todo).toBe(1);
      expect(b.in_progress).toBe(1);
      expect(b.review).toBe(1);
      expect(b.done).toBe(1);
      expect(b.cancelled).toBe(1);
      expect(b.timed_out).toBe(1);

      const sum = b.backlog + b.todo + b.in_progress + b.review + b.done + b.cancelled + b.timed_out;
      expect(sum).toBe(res.body.data.counts.taskCount);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-005: activeWork = in_progress + review, scoped, top 10
  // -------------------------------------------------------------------------
  describe('VAL-HOME-005: activeWork', () => {
    it('returns scoped in_progress + review tasks, top 10 by updatedAt desc', async () => {
      const base = Date.now();
      // 5 in_progress + 5 review + 3 backlog (should be excluded) = 10 activeWork
      for (let i = 0; i < 5; i++) {
        await insertTask({
          title: `ip-${i}`,
          status: 'in_progress',
          updatedAt: new Date(base + i * 1000),
        });
      }
      for (let i = 0; i < 5; i++) {
        await insertTask({
          title: `rv-${i}`,
          status: 'review',
          updatedAt: new Date(base + (5 + i) * 1000),
        });
      }
      await insertTask({ title: 'bl-1', status: 'backlog' });
      // other-project task
      await insertTask({
        title: 'other-ip',
        status: 'in_progress',
        projectId: otherProjectId,
        companyId: otherCompanyId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const aw = res.body.data.activeWork;
      expect(aw).toHaveLength(10);
      for (const t of aw) {
        expect(t.projectId).toBe(projectId);
        expect(['in_progress', 'review']).toContain(t.status);
      }
      // ordering: updatedAt non-increasing
      for (let i = 1; i < aw.length; i++) {
        expect(new Date(aw[i].updatedAt).getTime()).toBeLessThanOrEqual(
          new Date(aw[i - 1].updatedAt).getTime(),
        );
      }
    });

    it('caps at 10 when more than 10 qualifying tasks exist', async () => {
      const base = Date.now();
      for (let i = 0; i < 15; i++) {
        await insertTask({
          title: `ip-${i}`,
          status: 'in_progress',
          updatedAt: new Date(base + i * 1000),
        });
      }
      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);
      expect(res.body.data.activeWork).toHaveLength(10);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-006: needsAttention = review + timed_out + pending-thread, deduped, top 10
  // -------------------------------------------------------------------------
  describe('VAL-HOME-006: needsAttention', () => {
    it('includes review, timed_out, and pending-thread tasks; deduped; scoped; top 10', async () => {
      const reviewTask = await insertTask({ title: 'review-1', status: 'review' });
      const timedOutTask = await insertTask({ title: 'to-1', status: 'timed_out' });
      const pendingThreadTask = await insertTask({ title: 'pending-thread', status: 'todo' });
      await insertThreadItem({ taskId: pendingThreadTask.id, status: 'pending' });

      // a task that is review AND has a pending thread item — should appear once
      const dupTask = await insertTask({ title: 'review-and-pending', status: 'review' });
      await insertThreadItem({ taskId: dupTask.id, status: 'pending' });

      // non-qualifying task
      await insertTask({ title: 'plain-todo', status: 'todo' });
      // other-project task with pending thread
      const otherTask = await insertTask({
        title: 'other-pending',
        status: 'todo',
        projectId: otherProjectId,
        companyId: otherCompanyId,
      });
      await insertThreadItem({ taskId: otherTask.id, status: 'pending', companyId: otherCompanyId });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const na = res.body.data.needsAttention;
      const ids = na.map((t: any) => t.id);
      // no duplicates
      expect(new Set(ids).size).toBe(ids.length);
      // all scoped
      for (const t of na) {
        expect(t.projectId).toBe(projectId);
      }
      // includes the expected tasks
      expect(ids).toContain(reviewTask.id);
      expect(ids).toContain(timedOutTask.id);
      expect(ids).toContain(pendingThreadTask.id);
      expect(ids).toContain(dupTask.id);
      // excludes the other-project task
      expect(ids).not.toContain(otherTask.id);
      // length <= 10
      expect(na.length).toBeLessThanOrEqual(10);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-007: failedWork = failed executions scoped via task linkage, top 10
  // -------------------------------------------------------------------------
  describe('VAL-HOME-007: failedWork', () => {
    it('returns failed executions linked to project tasks, top 10', async () => {
      const task1 = await insertTask({ title: 'task-1', status: 'todo' });
      const task2 = await insertTask({ title: 'task-2', status: 'todo' });

      await insertExecution({ taskId: task1.id, status: 'failed' });
      await insertExecution({ taskId: task2.id, status: 'failed' });
      // non-failed execution (should be excluded)
      await insertExecution({ taskId: task1.id, status: 'completed' });
      // execution for other-project task
      const otherTask = await insertTask({
        title: 'other-task',
        status: 'todo',
        projectId: otherProjectId,
        companyId: otherCompanyId,
      });
      await insertExecution({
        taskId: otherTask.id,
        status: 'failed',
        companyId: otherCompanyId,
      });
      // execution with no task linkage
      await insertExecution({ taskId: null, status: 'failed' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const fw = res.body.data.failedWork;
      expect(fw.length).toBe(2);
      for (const e of fw) {
        expect(e.status).toBe('failed');
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-008: recentActivity = top 5 project activity events, scoped
  // -------------------------------------------------------------------------
  describe('VAL-HOME-008: recentActivity', () => {
    it('returns top 5 project-scoped activity events ordered by createdAt desc', async () => {
      const base = Date.now();
      // 7 project events
      for (let i = 0; i < 7; i++) {
        await insertActivity({
          action: 'project.updated',
          entityType: 'project',
          entityId: projectId,
          metadata: { project: { id: projectId } },
          createdAt: new Date(base + i * 1000),
        });
      }
      // non-project event
      await insertActivity({
        action: 'company.updated',
        entityType: 'company',
        entityId: companyId,
        createdAt: new Date(base + 99999),
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const ra = res.body.data.recentActivity;
      expect(ra.length).toBeLessThanOrEqual(5);
      expect(ra).toHaveLength(5);
      // ordering non-increasing
      for (let i = 1; i < ra.length; i++) {
        expect(new Date(ra[i].createdAt).getTime()).toBeLessThanOrEqual(
          new Date(ra[i - 1].createdAt).getTime(),
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-009: recentFiles = top 5 project files by createdAt desc
  // -------------------------------------------------------------------------
  describe('VAL-HOME-009: recentFiles', () => {
    it('returns top 5 project files ordered by createdAt desc', async () => {
      const base = Date.now();
      await insertFile({ name: 'project-folder', isDirectory: true, createdAt: new Date(base + 9999) });
      for (let i = 0; i < 7; i++) {
        await insertFile({ name: `f-${i}.txt`, createdAt: new Date(base + i * 1000) });
      }
      // unscoped file (should be excluded)
      await insertFile({ name: 'unscoped.txt', projectId: null });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const rf = res.body.data.recentFiles;
      expect(rf).toHaveLength(5);
      for (const f of rf) {
        expect(f.projectId).toBe(projectId);
        expect(f.isDirectory).toBe(false);
      }
      for (let i = 1; i < rf.length; i++) {
        expect(new Date(rf[i].createdAt).getTime()).toBeLessThanOrEqual(
          new Date(rf[i - 1].createdAt).getTime(),
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-010: goalProgress = count + aggregate progress, zero when none
  // -------------------------------------------------------------------------
  describe('VAL-HOME-010: goalProgress', () => {
    it('count equals goalCount and aggregateProgress is the average', async () => {
      await insertGoal({ title: 'g1', progress: 40 });
      await insertGoal({ title: 'g2', progress: 60 });
      await insertGoal({ title: 'g3', progress: 80 });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const gp = res.body.data.goalProgress;
      expect(gp.count).toBe(3);
      expect(gp.count).toBe(res.body.data.counts.goalCount);
      // avg(40, 60, 80) = 60
      expect(gp.aggregateProgress).toBe(60);
    });

    it('returns {0, 0} when there are no goals', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      expect(res.body.data.goalProgress).toEqual({ count: 0, aggregateProgress: 0 });
    });

    it('returns the exact fractional average (not rounded) — regression for VAL-HOME-010', async () => {
      // progress [0, 1] → avg = 0.5, NOT Math.round(0.5) = 1
      await insertGoal({ title: 'g-zero', progress: 0 });
      await insertGoal({ title: 'g-one', progress: 1 });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const gp = res.body.data.goalProgress;
      expect(gp.count).toBe(2);
      // The exact average must be returned — 0.5, not rounded to 0 or 1
      expect(gp.aggregateProgress).toBeCloseTo(0.5, 5);
      expect(Number.isInteger(gp.aggregateProgress)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-011: Cross-company project returns 404
  // -------------------------------------------------------------------------
  describe('VAL-HOME-011: cross-company 404', () => {
    it('returns 404 when project belongs to another company', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${otherProjectId}/home`)
        .expect(404);

      expect(res.body).not.toHaveProperty('data');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-012: Non-existent project returns 404
  // -------------------------------------------------------------------------
  describe('VAL-HOME-012: non-existent project 404', () => {
    it('returns 404 for a random UUID', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${randomUUID()}/home`)
        .expect(404);

      expect(res.body).not.toHaveProperty('data');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-013: Empty project yields zeroed counts and empty arrays
  // -------------------------------------------------------------------------
  describe('VAL-HOME-013: empty project', () => {
    it('returns 200 with zeroed counts, empty arrays, and populated project fields', async () => {
      const emptyProject = await request(app)
        .post(`/api/companies/${companyId}/projects`)
        .send({ name: 'Empty project', description: 'No data' })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${emptyProject.body.data.id}/home`)
        .expect(200);

      const data = res.body.data;
      expect(data.project.id).toBe(emptyProject.body.data.id);
      expect(data.project.name).toBe('Empty project');
      expect(data.project.status).toBe('planning');

      expect(data.counts).toEqual({ taskCount: 0, goalCount: 0, agentCount: 0, fileCount: 0 });
      expect(data.taskStatusBreakdown).toEqual({
        backlog: 0,
        todo: 0,
        in_progress: 0,
        review: 0,
        done: 0,
        cancelled: 0,
        timed_out: 0,
      });
      expect(data.activeWork).toEqual([]);
      expect(data.needsAttention).toEqual([]);
      expect(data.failedWork).toEqual([]);
      expect(data.recentActivity).toEqual([]);
      expect(data.recentFiles).toEqual([]);
      expect(data.goalProgress).toEqual({ count: 0, aggregateProgress: 0 });
      // New composed fields (VER-514)
      expect(data.recentThreadItems).toEqual([]);
      expect(data.pendingDecisions).toEqual([]);
      expect(data.activePlanProgress).toEqual([]);
      expect(data.artifacts).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-014: Company boundary — no cross-company data in any field
  // -------------------------------------------------------------------------
  describe('VAL-HOME-014: company boundary', () => {
    it('no cross-company data appears in any field', async () => {
      // seed other-company data
      const otherTask = await insertTask({
        title: 'other-task',
        status: 'in_progress',
        projectId: otherProjectId,
        companyId: otherCompanyId,
      });
      await insertGoal({ title: 'other-goal', projectId: otherProjectId, companyId: otherCompanyId });
      await insertFile({ name: 'other.txt', projectId: otherProjectId, companyId: otherCompanyId });
      await insertExecution({
        taskId: otherTask.id,
        status: 'failed',
        companyId: otherCompanyId,
      });

      // seed our-project data
      await insertTask({ title: 'our-task', status: 'in_progress' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const data = res.body.data;
      // No other-company task ids in any array
      for (const t of data.activeWork) {
        expect(t.companyId).toBe(companyId);
        expect(t.id).not.toBe(otherTask.id);
      }
      for (const t of data.needsAttention) {
        expect(t.companyId).toBe(companyId);
        expect(t.id).not.toBe(otherTask.id);
      }
      for (const e of data.failedWork) {
        expect(e.companyId).toBe(companyId);
      }
      for (const f of data.recentFiles) {
        expect(f.companyId).toBe(companyId);
      }
      for (const a of data.recentActivity) {
        expect(a.companyId).toBe(companyId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-015: Endpoint is read-only (no side effects)
  // -------------------------------------------------------------------------
  describe('VAL-HOME-015: read-only idempotency', () => {
    it('does not modify any table and returns identical results on repeated calls', async () => {
      await insertTask({ title: 't1', status: 'in_progress' });
      await insertGoal({ title: 'g1', progress: 50 });
      await insertFile({ name: 'f1.txt' });

      const countsBefore = await Promise.all([
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.tasks),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.goals),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.agentFiles),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.activityLog),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.agentExecutions),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.taskThreadItems),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.projects),
      ]);

      const res1 = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const countsAfter = await Promise.all([
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.tasks),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.goals),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.agentFiles),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.activityLog),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.agentExecutions),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.taskThreadItems),
        db.drizzle.select({ c: sql<number>`count(*)` }).from(db.schema.projects),
      ]);

      for (let i = 0; i < countsBefore.length; i++) {
        expect(Number(countsAfter[i][0].c)).toBe(Number(countsBefore[i][0].c));
      }

      const res2 = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      // Compare stable fields (strip volatile date serialization)
      const strip = (obj: any) => JSON.parse(JSON.stringify(obj));
      expect(strip(res1.body.data)).toEqual(strip(res2.body.data));
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-016: counts and breakdown stay internally consistent
  // -------------------------------------------------------------------------
  describe('VAL-HOME-016: internal consistency', () => {
    it('breakdown in_progress + review >= activeWork.length; review >= review in needsAttention', async () => {
      await insertTask({ title: 'ip1', status: 'in_progress' });
      await insertTask({ title: 'ip2', status: 'in_progress' });
      await insertTask({ title: 'rv1', status: 'review' });
      await insertTask({ title: 'rv2', status: 'review' });

      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const b = res.body.data.taskStatusBreakdown;
      const aw = res.body.data.activeWork;
      const na = res.body.data.needsAttention;

      expect(b.in_progress + b.review).toBeGreaterThanOrEqual(aw.length);
      const reviewInNeeds = na.filter((t: any) => t.status === 'review').length;
      expect(b.review).toBeGreaterThanOrEqual(reviewInNeeds);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-017: Default ordering is stable and deterministic for ties
  // -------------------------------------------------------------------------
  describe('VAL-HOME-017: deterministic tie ordering', () => {
    it('returns the same row sequence on repeated requests when timestamps tie', async () => {
      const sameTime = new Date();
      // Create 3 tasks with identical updatedAt (all in_progress so they're in activeWork)
      await insertTask({ title: 'tie-a', status: 'in_progress', updatedAt: sameTime });
      await insertTask({ title: 'tie-b', status: 'in_progress', updatedAt: sameTime });
      await insertTask({ title: 'tie-c', status: 'in_progress', updatedAt: sameTime });

      const res1 = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);
      const res2 = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);

      const ids1 = res1.body.data.activeWork.map((t: any) => t.id);
      const ids2 = res2.body.data.activeWork.map((t: any) => t.id);
      expect(ids1).toEqual(ids2);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-HOME-018: Invalid route params yield 400, not 500
  // -------------------------------------------------------------------------
  describe('VAL-HOME-018: invalid params 400', () => {
    it('returns 400 for a non-UUID project id', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/projects/not-a-uuid/home`)
        .expect(400);

      expect(res.body).toHaveProperty('code', 'VALIDATION_ERROR');
      expect(res.status).toBeLessThan(500);
    });
  });
});
