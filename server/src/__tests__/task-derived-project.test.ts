import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Task-derived project ownership — task_thread_items & agent_executions', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let otherProjectId: string;
  let agentId: string;
  let scopedTaskId: string;
  let unscopedTaskId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Derived Ownership Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Scoped project' })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Other project' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Worker', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;

    const scopedTask = await request(app)
      .post(`/api/companies/${companyId}/tasks`)
      .send({ title: 'Scoped task', status: 'todo', projectId })
      .expect(201);
    scopedTaskId = scopedTask.body.data.id;

    const unscopedTask = await request(app)
      .post(`/api/companies/${companyId}/tasks`)
      .send({ title: 'Unscoped task', status: 'todo' })
      .expect(201);
    unscopedTaskId = unscopedTask.body.data.id;
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-001: Thread item derives project from task
  // -------------------------------------------------------------------------
  describe('VAL-THREAD-001: thread item derives project from task', () => {
    it('POST /tasks/:id/thread/comments for a project-scoped task persists project_id', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/tasks/${scopedTaskId}/thread/comments`)
        .send({ content: 'Comment on scoped task' })
        .expect(201);

      expect(res.body.data.projectId).toBe(projectId);

      const [row] = await db.drizzle
        .select({ projectId: db.schema.taskThreadItems.projectId })
        .from(db.schema.taskThreadItems)
        .where(eq(db.schema.taskThreadItems.id, res.body.data.id))
        .limit(1);
      expect(row.projectId).toBe(projectId);
    });

    it('POST /tasks/:id/comments for a project-scoped task persists project_id', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/tasks/${scopedTaskId}/comments`)
        .send({ content: 'Legacy comment on scoped task' })
        .expect(201);

      // The legacy comments endpoint doesn't return the thread item, so check DB
      const [row] = await db.drizzle
        .select({ projectId: db.schema.taskThreadItems.projectId })
        .from(db.schema.taskThreadItems)
        .where(eq(db.schema.taskThreadItems.taskId, scopedTaskId))
        .limit(1);
      expect(row.projectId).toBe(projectId);
    });

    it('task checkout for a project-scoped task creates thread item with project_id', async () => {
      const execution = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({ taskId: scopedTaskId })
        .expect(201);

      await request(app)
        .post(`/api/companies/${companyId}/tasks/${scopedTaskId}/checkout`)
        .send({
          agentId,
          executionId: execution.body.data.id,
          idempotencyKey: `test-checkout:${execution.body.data.id}`,
        })
        .expect(201);

      const [row] = await db.drizzle
        .select({ projectId: db.schema.taskThreadItems.projectId })
        .from(db.schema.taskThreadItems)
        .where(
          eq(db.schema.taskThreadItems.relatedExecutionId, execution.body.data.id),
        )
        .limit(1);
      expect(row.projectId).toBe(projectId);
    });

    it('approval creation for a project-scoped task creates thread item with project_id', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/approvals`)
        .send({
          title: 'Approve scoped task',
          taskId: scopedTaskId,
        })
        .expect(201);

      const [row] = await db.drizzle
        .select({ projectId: db.schema.taskThreadItems.projectId })
        .from(db.schema.taskThreadItems)
        .where(eq(db.schema.taskThreadItems.taskId, scopedTaskId))
        .limit(1);
      expect(row.projectId).toBe(projectId);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-002: Unscoped task yields unscoped thread item
  // -------------------------------------------------------------------------
  describe('VAL-THREAD-002: unscoped task yields unscoped thread item', () => {
    it('POST /tasks/:id/thread/comments for an unscoped task persists null project_id', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/tasks/${unscopedTaskId}/thread/comments`)
        .send({ content: 'Comment on unscoped task' })
        .expect(201);

      expect(res.body.data.projectId).toBeNull();

      const [row] = await db.drizzle
        .select({ projectId: db.schema.taskThreadItems.projectId })
        .from(db.schema.taskThreadItems)
        .where(eq(db.schema.taskThreadItems.id, res.body.data.id))
        .limit(1);
      expect(row.projectId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-THREAD-003: Project filter returns only matching thread items
  // -------------------------------------------------------------------------
  describe('VAL-THREAD-003: ?project filter on thread items', () => {
    it('GET /tasks/thread-items?project=X returns only items with project_id=X', async () => {
      // Create thread items: scoped to project, unscoped, and scoped to other project
      await request(app)
        .post(`/api/companies/${companyId}/tasks/${scopedTaskId}/thread/comments`)
        .send({ content: 'Scoped comment' })
        .expect(201);

      await request(app)
        .post(`/api/companies/${companyId}/tasks/${unscopedTaskId}/thread/comments`)
        .send({ content: 'Unscoped comment' })
        .expect(201);

      const otherProjectTask = await request(app)
        .post(`/api/companies/${companyId}/tasks`)
        .send({ title: 'Other project task', status: 'todo', projectId: otherProjectId })
        .expect(201);
      await request(app)
        .post(`/api/companies/${companyId}/tasks/${otherProjectTask.body.data.id}/thread/comments`)
        .send({ content: 'Other project comment' })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/tasks/thread-items`)
        .query({ project: projectId })
        .expect(200);

      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of res.body.data) {
        expect(item.projectId).toBe(projectId);
      }
      // Ensure the scoped comment is included
      const contents = res.body.data.map((d: any) => d.content);
      expect(contents).toContain('Scoped comment');
    });

    it('GET /tasks/thread-items without ?project returns all company thread items', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/tasks/${scopedTaskId}/thread/comments`)
        .send({ content: 'Scoped comment' })
        .expect(201);

      await request(app)
        .post(`/api/companies/${companyId}/tasks/${unscopedTaskId}/thread/comments`)
        .send({ content: 'Unscoped comment' })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/tasks/thread-items`)
        .expect(200);

      const contents = res.body.data.map((d: any) => d.content);
      expect(contents).toContain('Scoped comment');
      expect(contents).toContain('Unscoped comment');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-EXEC-001: Execution derives project from task
  // -------------------------------------------------------------------------
  describe('VAL-EXEC-001: execution derives project from task', () => {
    it('POST /agents/:id/executions with taskId for a project-scoped task persists project_id', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({ taskId: scopedTaskId })
        .expect(201);

      expect(res.body.data.projectId).toBe(projectId);

      const [row] = await db.drizzle
        .select({ projectId: db.schema.agentExecutions.projectId })
        .from(db.schema.agentExecutions)
        .where(eq(db.schema.agentExecutions.id, res.body.data.id))
        .limit(1);
      expect(row.projectId).toBe(projectId);
    });
  });

  // -------------------------------------------------------------------------
  // VAL-EXEC-002: Manual execution accepts project assignment
  // -------------------------------------------------------------------------
  describe('VAL-EXEC-002: manual execution accepts projectId', () => {
    it('POST /agents/:id/executions without taskId with valid projectId persists that project_id', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({ projectId })
        .expect(201);

      expect(res.body.data.projectId).toBe(projectId);

      const [row] = await db.drizzle
        .select({ projectId: db.schema.agentExecutions.projectId })
        .from(db.schema.agentExecutions)
        .where(eq(db.schema.agentExecutions.id, res.body.data.id))
        .limit(1);
      expect(row.projectId).toBe(projectId);
    });

    it('POST /agents/:id/executions with cross-company projectId returns 404', async () => {
      const otherCompany = await request(app)
        .post('/api/companies')
        .send({ name: 'Other Corp' })
        .expect(201);
      const foreignProject = await request(app)
        .post(`/api/companies/${otherCompany.body.data.id}/projects`)
        .send({ name: 'Foreign project' })
        .expect(201);

      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({ projectId: foreignProject.body.data.id })
        .expect(404);

      expect(res.body.code).toBe('PROJECT_INVALID');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-EXEC-003: Manual execution defaults to NULL project
  // -------------------------------------------------------------------------
  describe('VAL-EXEC-003: manual execution without projectId gets null', () => {
    it('POST /agents/:id/executions without taskId and without projectId persists null project_id', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({})
        .expect(201);

      expect(res.body.data.projectId).toBeNull();

      const [row] = await db.drizzle
        .select({ projectId: db.schema.agentExecutions.projectId })
        .from(db.schema.agentExecutions)
        .where(eq(db.schema.agentExecutions.id, res.body.data.id))
        .limit(1);
      expect(row.projectId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // VAL-EXEC-004: Project filter returns only matching executions
  // -------------------------------------------------------------------------
  describe('VAL-EXEC-004: ?project filter on executions', () => {
    it('GET /agents/:id/executions?project=X returns only executions with project_id=X', async () => {
      // Create execution for scoped task (project_id = projectId)
      const scopedExec = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({ taskId: scopedTaskId })
        .expect(201);

      // Create manual execution with projectId = otherProjectId
      const otherExec = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({ projectId: otherProjectId })
        .expect(201);

      // Create manual execution without projectId (null)
      const nullExec = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({})
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .query({ project: projectId })
        .expect(200);

      const ids = res.body.data.map((e: any) => e.id);
      expect(ids).toContain(scopedExec.body.data.id);
      expect(ids).not.toContain(otherExec.body.data.id);
      expect(ids).not.toContain(nullExec.body.data.id);
      for (const exec of res.body.data) {
        expect(exec.projectId).toBe(projectId);
      }
    });

    it('GET /agents/:id/executions without ?project returns all agent executions', async () => {
      const scopedExec = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({ taskId: scopedTaskId })
        .expect(201);

      const nullExec = await request(app)
        .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .send({})
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/agents/${agentId}/executions`)
        .expect(200);

      const ids = res.body.data.map((e: any) => e.id);
      expect(ids).toContain(scopedExec.body.data.id);
      expect(ids).toContain(nullExec.body.data.id);
    });
  });
});
