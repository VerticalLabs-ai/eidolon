import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestApp, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

/**
 * Tests for fix-task-derived-project-validation:
 *   (a) Thread item from release_active_task_checkouts SQL function path has
 *       project_id when task has a project.
 *   (b) Insert with stale project_id (project deleted after task creation)
 *       yields null project_id, not an FK violation.
 *   (c) Insert with cross-company project_id yields null, not an FK violation.
 *
 * Also includes unfiltered-read API tests for messages, workflows, and
 * routines to strengthen VAL-MIG-004 / VAL-CROSS-002 evidence.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedCompany(db: DbInstance, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.insert(db.schema.companies).values({
    id,
    name,
    status: 'active',
    budgetMonthlyCents: 100_000,
    spentMonthlyCents: 0,
    settings: {},
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedAgent(db: DbInstance, companyId: string, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.insert(db.schema.agents).values({
    id,
    companyId,
    name,
    role: 'engineer',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    status: 'idle',
    capabilities: [],
    config: {},
    metadata: {},
    permissions: [],
    toolsEnabled: [],
    skillsEnabled: [],
    routinePolicy: {},
    sessionPolicy: {},
    allowedDomains: [],
    maxConcurrentTasks: 1,
    heartbeatIntervalSeconds: 0,
    executionTimeoutSeconds: 600,
    autoAssignTasks: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedProject(db: DbInstance, companyId: string, name: string) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.insert(db.schema.projects).values({
    id,
    companyId,
    name,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** Insert a task with a specific (possibly stale or cross-company) project_id. */
async function seedTaskWithProjectId(
  db: DbInstance,
  companyId: string,
  projectId: string | null,
  agentId?: string,
) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.insert(db.schema.tasks).values({
    id,
    companyId,
    projectId: projectId ?? undefined,
    title: 'Test task',
    type: 'feature',
    status: 'todo',
    priority: 'medium',
    assigneeAgentId: agentId,
    dependencies: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

// ===========================================================================
// (a) release_active_task_checkouts SQL function path
// ===========================================================================

describe('release_active_task_checkouts SQL function — project_id derivation', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let agentId: string;
  let taskId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await seedCompany(db, 'Checkout Release Corp');
    projectId = await seedProject(db, companyId, 'Release Project');
    agentId = await seedAgent(db, companyId, 'Checkout Agent');
    taskId = await seedTaskWithProjectId(db, companyId, projectId, agentId);
  });

  it('thread item from release_active_task_checkouts has project_id when task has a project', async () => {
    // Create a running execution for the task
    const execId = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.agentExecutions).values({
      id: execId,
      companyId,
      agentId,
      taskId,
      status: 'running',
      startedAt: now,
      executionMode: 'manual',
      lastEventAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Create an active task checkout
    const checkoutId = randomUUID();
    await db.drizzle.insert(db.schema.taskCheckouts).values({
      id: checkoutId,
      companyId,
      taskId,
      agentId,
      executionId: execId,
      source: 'api',
      status: 'active',
      idempotencyKey: `test-release:${checkoutId}`,
      claimedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Transition execution to completed — this triggers
    // release_checkout_on_execution_terminal which calls
    // release_active_task_checkouts, which inserts a thread item.
    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({ status: 'completed', completedAt: now, updatedAt: now })
      .where(eq(db.schema.agentExecutions.id, execId));

    // Find the thread item created by the SQL function
    const [threadItem] = await db.drizzle
      .select({
        projectId: db.schema.taskThreadItems.projectId,
        kind: db.schema.taskThreadItems.kind,
        idempotencyKey: db.schema.taskThreadItems.idempotencyKey,
      })
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.taskId, taskId))
      .limit(1);

    expect(threadItem).toBeDefined();
    expect(threadItem.projectId).toBe(projectId);
  });

  it('thread item from release_active_task_checkouts has null project_id when task has no project', async () => {
    // Create a task without a project
    const unscopedTaskId = await seedTaskWithProjectId(db, companyId, null, agentId);

    const execId = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.agentExecutions).values({
      id: execId,
      companyId,
      agentId,
      taskId: unscopedTaskId,
      status: 'running',
      startedAt: now,
      executionMode: 'manual',
      lastEventAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const checkoutId = randomUUID();
    await db.drizzle.insert(db.schema.taskCheckouts).values({
      id: checkoutId,
      companyId,
      taskId: unscopedTaskId,
      agentId,
      executionId: execId,
      source: 'api',
      status: 'active',
      idempotencyKey: `test-release-unscoped:${checkoutId}`,
      claimedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({ status: 'completed', completedAt: now, updatedAt: now })
      .where(eq(db.schema.agentExecutions.id, execId));

    const [threadItem] = await db.drizzle
      .select({ projectId: db.schema.taskThreadItems.projectId })
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.taskId, unscopedTaskId))
      .limit(1);

    expect(threadItem).toBeDefined();
    expect(threadItem.projectId).toBeNull();
  });
});

// ===========================================================================
// (b) Stale project_id (project deleted) yields null, not FK error
// ===========================================================================

describe('stale project_id (project deleted) yields null project_id, not FK error', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await seedCompany(db, 'Stale Project Corp');
    agentId = await seedAgent(db, companyId, 'Stale Agent');
  });

  it('thread item insert via API yields null project_id when task.project_id points to a deleted project', async () => {
    // Create a project, then delete it
    const projectId = await seedProject(db, companyId, 'Doomed Project');
    const taskId = await seedTaskWithProjectId(db, companyId, projectId, agentId);

    // Delete the project — tasks.project_id has no FK so it retains the stale ID
    await db.drizzle
      .delete(db.schema.projects)
      .where(eq(db.schema.projects.id, projectId));

    // Verify the task still holds the stale project_id
    const [task] = await db.drizzle
      .select({ projectId: db.schema.tasks.projectId })
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId))
      .limit(1);
    expect(task.projectId).toBe(projectId);

    // Insert a thread item via the API — should succeed with null project_id
    const res = await request(app)
      .post(`/api/companies/${companyId}/tasks/${taskId}/thread/comments`)
      .send({ content: 'Comment on stale-project task' })
      .expect(201);

    expect(res.body.data.projectId).toBeNull();

    const [row] = await db.drizzle
      .select({ projectId: db.schema.taskThreadItems.projectId })
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.id, res.body.data.id))
      .limit(1);
    expect(row.projectId).toBeNull();
  });

  it('execution insert via API yields null project_id when task.project_id points to a deleted project', async () => {
    const projectId = await seedProject(db, companyId, 'Doomed Exec Project');
    const taskId = await seedTaskWithProjectId(db, companyId, projectId, agentId);

    await db.drizzle
      .delete(db.schema.projects)
      .where(eq(db.schema.projects.id, projectId));

    // Create an execution for the stale-project task
    const res = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
      .send({ taskId })
      .expect(201);

    expect(res.body.data.projectId).toBeNull();

    const [row] = await db.drizzle
      .select({ projectId: db.schema.agentExecutions.projectId })
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, res.body.data.id))
      .limit(1);
    expect(row.projectId).toBeNull();
  });

  it('task checkout thread item yields null project_id when task.project_id is stale', async () => {
    const projectId = await seedProject(db, companyId, 'Doomed Checkout Project');
    const taskId = await seedTaskWithProjectId(db, companyId, projectId, agentId);

    await db.drizzle
      .delete(db.schema.projects)
      .where(eq(db.schema.projects.id, projectId));

    // Create execution and checkout via API
    const exec = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
      .send({ taskId })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/tasks/${taskId}/checkout`)
      .send({
        agentId,
        executionId: exec.body.data.id,
        idempotencyKey: `stale-checkout:${exec.body.data.id}`,
      })
      .expect(201);

    // The checkout thread item should have null project_id
    const [row] = await db.drizzle
      .select({ projectId: db.schema.taskThreadItems.projectId })
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.relatedExecutionId, exec.body.data.id))
      .limit(1);
    expect(row.projectId).toBeNull();
  });

  it('approval thread item yields null project_id when task.project_id is stale', async () => {
    const projectId = await seedProject(db, companyId, 'Doomed Approval Project');
    const taskId = await seedTaskWithProjectId(db, companyId, projectId, agentId);

    await db.drizzle
      .delete(db.schema.projects)
      .where(eq(db.schema.projects.id, projectId));

    await request(app)
      .post(`/api/companies/${companyId}/approvals`)
      .send({ title: 'Approve stale task', taskId })
      .expect(201);

    const [row] = await db.drizzle
      .select({ projectId: db.schema.taskThreadItems.projectId })
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.taskId, taskId))
      .limit(1);
    expect(row.projectId).toBeNull();
  });
});

// ===========================================================================
// (c) Cross-company project_id yields null, not FK error
// ===========================================================================

describe('cross-company project_id yields null project_id, not FK error', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let foreignProjectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await seedCompany(db, 'Company A');
    otherCompanyId = await seedCompany(db, 'Company B');
    agentId = await seedAgent(db, companyId, 'Cross-company Agent');
    foreignProjectId = await seedProject(db, otherCompanyId, 'Foreign Project');
  });

  it('thread item insert via API yields null project_id when task.project_id is cross-company', async () => {
    // Create a task in company A with company B's project_id (possible since
    // tasks.project_id has no FK)
    const taskId = await seedTaskWithProjectId(db, companyId, foreignProjectId, agentId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/tasks/${taskId}/thread/comments`)
      .send({ content: 'Comment on cross-company task' })
      .expect(201);

    expect(res.body.data.projectId).toBeNull();
  });

  it('execution insert via API yields null project_id when task.project_id is cross-company', async () => {
    const taskId = await seedTaskWithProjectId(db, companyId, foreignProjectId, agentId);

    const res = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
      .send({ taskId })
      .expect(201);

    expect(res.body.data.projectId).toBeNull();
  });

  it('task checkout thread item yields null project_id when task.project_id is cross-company', async () => {
    const taskId = await seedTaskWithProjectId(db, companyId, foreignProjectId, agentId);

    const exec = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
      .send({ taskId })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/tasks/${taskId}/checkout`)
      .send({
        agentId,
        executionId: exec.body.data.id,
        idempotencyKey: `cross-company-checkout:${exec.body.data.id}`,
      })
      .expect(201);

    const [row] = await db.drizzle
      .select({ projectId: db.schema.taskThreadItems.projectId })
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.relatedExecutionId, exec.body.data.id))
      .limit(1);
    expect(row.projectId).toBeNull();
  });
});

// ===========================================================================
// Unfiltered-read API tests for messages, workflows, routines
// (VAL-MIG-004 / VAL-CROSS-002)
// ===========================================================================

describe('VAL-MIG-004 / VAL-CROSS-002: unfiltered reads for multiple resources', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let fromAgentId: string;
  let toAgentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await seedCompany(db, 'Unfiltered Corp');
    otherCompanyId = await seedCompany(db, 'Other Unfiltered Corp');
    projectId = await seedProject(db, companyId, 'Scoped Project');
    fromAgentId = await seedAgent(db, companyId, 'Sender');
    toAgentId = await seedAgent(db, companyId, 'Receiver');
  });

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  describe('messages unfiltered read', () => {
    it('GET /messages without ?project returns all company messages including null project_id, excludes other companies', async () => {
      const scoped = await request(app)
        .post(`/api/companies/${companyId}/messages`)
        .send({ fromAgentId, toAgentId, content: 'Scoped', projectId })
        .expect(201);
      const unscoped = await request(app)
        .post(`/api/companies/${companyId}/messages`)
        .send({ fromAgentId, toAgentId, content: 'Unscoped' })
        .expect(201);

      // Create a message in the other company — must NOT appear
      const otherAgent = await seedAgent(db, otherCompanyId, 'Other Agent');
      await request(app)
        .post(`/api/companies/${otherCompanyId}/messages`)
        .send({ fromAgentId: otherAgent, toAgentId: otherAgent, content: 'Other company' })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/messages`)
        .expect(200);

      const ids = res.body.data.map((m: any) => m.id);
      expect(ids).toContain(scoped.body.data.id);
      expect(ids).toContain(unscoped.body.data.id);
      // Verify no cross-company messages
      expect(res.body.data.every((m: any) => m.companyId === companyId)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Workflows
  // -------------------------------------------------------------------------

  describe('workflows unfiltered read', () => {
    it('GET /workflows without ?project returns all company workflows including null project_id, excludes other companies', async () => {
      const scoped = await request(app)
        .post(`/api/companies/${companyId}/workflows`)
        .send({ name: 'Scoped Workflow', projectId })
        .expect(201);
      const unscoped = await request(app)
        .post(`/api/companies/${companyId}/workflows`)
        .send({ name: 'Unscoped Workflow' })
        .expect(201);

      // Create a workflow in the other company
      await request(app)
        .post(`/api/companies/${otherCompanyId}/workflows`)
        .send({ name: 'Other Company Workflow' })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/workflows`)
        .expect(200);

      const ids = res.body.data.map((w: any) => w.id);
      expect(ids).toContain(scoped.body.data.id);
      expect(ids).toContain(unscoped.body.data.id);
      expect(res.body.data.every((w: any) => w.companyId === companyId)).toBe(true);
      // Verify unscoped has null projectId
      const unscopedRow = res.body.data.find((w: any) => w.id === unscoped.body.data.id);
      expect(unscopedRow.projectId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Routines
  // -------------------------------------------------------------------------

  describe('routines unfiltered read', () => {
    it('GET /routines without ?project returns all company routines including null project_id, excludes other companies', async () => {
      const scoped = await request(app)
        .post(`/api/companies/${companyId}/routines`)
        .send({ name: 'Scoped Routine', prompt: 'Run scoped', projectId })
        .expect(201);
      const unscoped = await request(app)
        .post(`/api/companies/${companyId}/routines`)
        .send({ name: 'Unscoped Routine', prompt: 'Run unscoped' })
        .expect(201);

      // Create a routine in the other company
      await request(app)
        .post(`/api/companies/${otherCompanyId}/routines`)
        .send({ name: 'Other Company Routine', prompt: 'Do not run' })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/routines`)
        .expect(200);

      const ids = res.body.data.map((r: any) => r.id);
      expect(ids).toContain(scoped.body.data.id);
      expect(ids).toContain(unscoped.body.data.id);
      expect(res.body.data.every((r: any) => r.companyId === companyId)).toBe(true);
      // Verify unscoped has null projectId
      const unscopedRow = res.body.data.find((r: any) => r.id === unscoped.body.data.id);
      expect(unscopedRow.projectId).toBeNull();
    });
  });
});
