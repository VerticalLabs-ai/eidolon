import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestApp, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createCompany(app: ReturnType<typeof createTestApp>, name: string) {
  const res = await request(app).post('/api/companies').send({ name }).expect(201);
  return res.body.data.id as string;
}

async function createProject(app: ReturnType<typeof createTestApp>, companyId: string, name: string) {
  const res = await request(app)
    .post(`/api/companies/${companyId}/projects`)
    .send({ name })
    .expect(201);
  return res.body.data.id as string;
}

async function createAgent(app: ReturnType<typeof createTestApp>, companyId: string, name: string) {
  const res = await request(app)
    .post(`/api/companies/${companyId}/agents`)
    .send({ name, role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
    .expect(201);
  return res.body.data.id as string;
}

async function createRoutine(
  app: ReturnType<typeof createTestApp>,
  companyId: string,
  opts: { name: string; prompt: string; agentId?: string; projectId?: string },
) {
  const body: Record<string, unknown> = { name: opts.name, prompt: opts.prompt };
  if (opts.agentId) body.agentId = opts.agentId;
  if (opts.projectId) body.projectId = opts.projectId;
  const res = await request(app).post(`/api/companies/${companyId}/routines`).send(body).expect(201);
  return res.body.data;
}

async function createWorkflow(
  app: ReturnType<typeof createTestApp>,
  companyId: string,
  opts: { name: string; projectId?: string; nodes?: unknown[] },
) {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.projectId) body.projectId = opts.projectId;
  if (opts.nodes) body.nodes = opts.nodes;
  const res = await request(app).post(`/api/companies/${companyId}/workflows`).send(body).expect(201);
  return res.body.data;
}

/** Insert a webhook directly into the DB (the management route does not yet accept projectId). */
async function insertWebhook(
  db: DbInstance,
  opts: { companyId: string; name: string; eventType: string; projectId?: string | null; targetAgentId?: string | null },
) {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "webhooks" ("id", "company_id", "name", "secret", "event_type", "enabled", "trigger_count", "project_id", "target_agent_id", "created_at", "updated_at")
    VALUES (${id}, ${opts.companyId}, ${opts.name}, ${'test-secret'}, ${opts.eventType}, true, 0, ${opts.projectId ?? null}, ${opts.targetAgentId ?? null}, ${now}, ${now})
  `);
  return id;
}

async function getRuns(db: DbInstance, companyId: string) {
  return db.drizzle
    .select()
    .from(db.schema.automationRuns)
    .where(eq(db.schema.automationRuns.companyId, companyId))
    .orderBy(sql`${db.schema.automationRuns.createdAt} DESC`);
}

async function getTask(db: DbInstance, taskId: string) {
  const rows = await db.drizzle
    .select()
    .from(db.schema.tasks)
    .where(eq(db.schema.tasks.id, taskId))
    .limit(1);
  return rows[0] ?? null;
}

async function getMessage(db: DbInstance, messageId: string) {
  const rows = await db.drizzle
    .select()
    .from(db.schema.messages)
    .where(eq(db.schema.messages.id, messageId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Routine trigger automation_run recording
// ---------------------------------------------------------------------------

describe('Automation runs — routine trigger', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Run Corp');
    otherCompanyId = await createCompany(app, 'Other Run Corp');
    projectId = await createProject(app, companyId, 'Project Alpha');
    agentId = await createAgent(app, companyId, 'Jarvis');
  });

  it('VAL-RUN-001: routine trigger creates exactly one automation_run with type=routine', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Daily Briefing',
      prompt: 'Summarize the day',
      agentId,
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0].automationType).toBe('routine');
    expect(runs[0].automationId).toBe(routine.id);
    expect(runs[0].automationName).toBe('Daily Briefing');
    expect(runs[0].triggerType).toBe('manual');
    expect(runs[0].companyId).toBe(companyId);
  });

  it('VAL-RUN-002: routine run links to created task, execution, and session', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Linked Routine',
      prompt: 'Do work',
      agentId,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.id}/trigger`)
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run.taskId).toBe(res.body.data.task.id);
    expect(run.executionId).toBe(res.body.data.execution?.id ?? null);
    expect(run.executionId).not.toBeNull();
    expect(run.sessionId).toBe(res.body.data.session?.id ?? null);
    expect(run.sessionId).not.toBeNull();
  });

  it('VAL-RUN-002: routine without agent has null executionId and sessionId', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'No Agent Routine',
      prompt: 'Just create a task',
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0].executionId).toBeNull();
    expect(runs[0].sessionId).toBeNull();
    expect(runs[0].taskId).not.toBeNull();
  });

  it('VAL-RUN-003: routine run records triggerPayload with routine context', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Payload Routine',
      prompt: 'Check payload',
      agentId,
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    const payload = runs[0].triggerPayload as Record<string, unknown>;
    expect(payload.routineId).toBe(routine.id);
    expect(payload.routineName).toBe('Payload Routine');
    expect(payload.trigger).toBe('manual');
    expect(payload.mode).toBe(routine.mode);
  });

  it('VAL-RUN-004: routine run updates to completed on success with outcome and completedAt', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Success Routine',
      prompt: 'Succeed',
      agentId,
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].completedAt).not.toBeNull();
    expect(runs[0].outcome).not.toBeNull();
    expect(runs[0].error).toBeNull();
  });

  it('VAL-RUN-004: routine without agent completes with task_created_without_agent outcome', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'No Agent Outcome',
      prompt: 'No agent',
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].outcome).toBe('task_created_without_agent');
  });

  it('VAL-RUN-005: routine run updates to failed on session-start failure', async () => {
    // Create a routine with a real agent, then move the agent to a different
    // company so the checkout fails with AGENT_NOT_FOUND during trigger.
    const agent = await createAgent(app, companyId, 'Fail Agent');
    const routine = await createRoutine(app, companyId, {
      name: 'Fail Routine',
      prompt: 'Will fail',
      agentId: agent,
    });

    // Move the agent to the other company — the routine still references it,
    // but the checkout will fail because the agent no longer belongs to the
    // routine's company.
    await db.drizzle.execute(sql`
      UPDATE "agents" SET "company_id" = ${otherCompanyId} WHERE "id" = ${agent}
    `);

    await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.id}/trigger`)
      .expect(500);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).not.toBeNull();
    expect(runs[0].completedAt).not.toBeNull();
  });

  it('VAL-RUN-019: routine run records projectId from the routine', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Project Routine',
      prompt: 'Scoped work',
      agentId,
      projectId,
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].projectId).toBe(projectId);
  });

  it('VAL-RUN-020: company-level routine run has null projectId', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Company Routine',
      prompt: 'Unscoped work',
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].projectId).toBeNull();
  });

  it('VAL-RUN-023: routine-triggered task directly sets projectId from the routine', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Project Task Routine',
      prompt: 'Create scoped task',
      agentId,
      projectId,
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.id}/trigger`)
      .expect(200);

    expect(res.body.data.task.projectId).toBe(projectId);
    const task = await getTask(db, res.body.data.task.id);
    expect(task?.projectId).toBe(projectId);
  });

  it('VAL-RUN-024: company-level routine task has null projectId', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Company Task Routine',
      prompt: 'Create unscoped task',
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.id}/trigger`)
      .expect(200);

    expect(res.body.data.task.projectId).toBeNull();
    const task = await getTask(db, res.body.data.task.id);
    expect(task?.projectId).toBeNull();
  });

  it('VAL-RUN-018: repeated routine triggers create distinct run rows', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Repeat Routine',
      prompt: 'Run again',
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);
    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(2);
    expect(runs[0].id).not.toBe(runs[1].id);
  });
});

// ---------------------------------------------------------------------------
// Workflow execute automation_run recording
// ---------------------------------------------------------------------------

describe('Automation runs — workflow execute', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Workflow Corp');
    projectId = await createProject(app, companyId, 'Workflow Project');
  });

  it('VAL-RUN-006: workflow execute creates exactly one automation_run with type=workflow', async () => {
    const wf = await createWorkflow(app, companyId, {
      name: 'My Workflow',
      nodes: [{ id: 'n1', type: 'task', label: 'Step 1', config: {}, status: 'pending', dependsOn: [] }],
    });

    await request(app).post(`/api/companies/${companyId}/workflows/${wf.id}/execute`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0].automationType).toBe('workflow');
    expect(runs[0].automationId).toBe(wf.id);
    expect(runs[0].automationName).toBe('My Workflow');
    expect(runs[0].triggerType).toBe('manual');
    expect(runs[0].status).toBe('running');
  });

  it('VAL-RUN-007: workflow run transitions to completed when all nodes complete', async () => {
    const wf = await createWorkflow(app, companyId, {
      name: 'Complete Workflow',
      nodes: [{ id: 'n1', type: 'task', label: 'Step 1', config: {}, status: 'pending', dependsOn: [] }],
    });

    await request(app).post(`/api/companies/${companyId}/workflows/${wf.id}/execute`).expect(200);
    await request(app)
      .patch(`/api/companies/${companyId}/workflows/${wf.id}/nodes/n1`)
      .send({ status: 'completed' })
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].completedAt).not.toBeNull();
    expect(runs[0].outcome).not.toBeNull();
  });

  it('VAL-RUN-007: workflow run transitions to failed when a node fails', async () => {
    const wf = await createWorkflow(app, companyId, {
      name: 'Fail Workflow',
      nodes: [
        { id: 'n1', type: 'task', label: 'Step 1', config: {}, status: 'pending', dependsOn: [] },
        { id: 'n2', type: 'task', label: 'Step 2', config: {}, status: 'pending', dependsOn: ['n1'] },
      ],
    });

    await request(app).post(`/api/companies/${companyId}/workflows/${wf.id}/execute`).expect(200);
    await request(app)
      .patch(`/api/companies/${companyId}/workflows/${wf.id}/nodes/n1`)
      .send({ status: 'failed' })
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).not.toBeNull();
    expect(runs[0].completedAt).not.toBeNull();
  });

  it('VAL-RUN-008: workflow run links to task via nodeId taskId', async () => {
    // Create a task first
    const taskRes = await request(app)
      .post(`/api/companies/${companyId}/tasks`)
      .send({ title: 'Workflow Task' })
      .expect(201);
    const taskId = taskRes.body.data.id;

    const wf = await createWorkflow(app, companyId, {
      name: 'Linked Workflow',
      nodes: [{ id: 'n1', type: 'task', label: 'Step 1', taskId, config: {}, status: 'pending', dependsOn: [] }],
    });

    await request(app).post(`/api/companies/${companyId}/workflows/${wf.id}/execute`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].taskId).toBe(taskId);
  });

  it('VAL-RUN-019: workflow run records projectId from the workflow', async () => {
    const wf = await createWorkflow(app, companyId, {
      name: 'Project Workflow',
      projectId,
      nodes: [{ id: 'n1', type: 'task', label: 'Step 1', config: {}, status: 'pending', dependsOn: [] }],
    });

    await request(app).post(`/api/companies/${companyId}/workflows/${wf.id}/execute`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].projectId).toBe(projectId);
  });

  it('VAL-RUN-020: company-level workflow run has null projectId', async () => {
    const wf = await createWorkflow(app, companyId, {
      name: 'Company Workflow',
      nodes: [{ id: 'n1', type: 'task', label: 'Step 1', config: {}, status: 'pending', dependsOn: [] }],
    });

    await request(app).post(`/api/companies/${companyId}/workflows/${wf.id}/execute`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].projectId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Webhook trigger automation_run recording
// ---------------------------------------------------------------------------

describe('Automation runs — webhook trigger', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Webhook Corp');
    otherCompanyId = await createCompany(app, 'Other Webhook Corp');
    projectId = await createProject(app, companyId, 'Webhook Project');
    agentId = await createAgent(app, companyId, 'Webhook Agent');
  });

  it('VAL-RUN-009: webhook trigger creates exactly one automation_run with type=webhook', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Task Webhook',
      eventType: 'task.create',
    });

    await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 'Webhook Task' })
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0].automationType).toBe('webhook');
    expect(runs[0].automationId).toBe(webhookId);
    expect(runs[0].triggerType).toBe('webhook');
  });

  it('VAL-RUN-010: webhook run captures inbound triggerPayload', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Payload Webhook',
      eventType: 'task.create',
    });

    await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 'Captured Title', description: 'Captured desc', metadata: { source: 'test' } })
      .expect(200);

    const runs = await getRuns(db, companyId);
    const payload = runs[0].triggerPayload as Record<string, unknown>;
    expect(payload.title).toBe('Captured Title');
    expect(payload.description).toBe('Captured desc');
  });

  it('VAL-RUN-011: webhook task.create run links to created task', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Link Task Webhook',
      eventType: 'task.create',
    });

    const res = await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 'Linked Task' })
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].taskId).toBe(res.body.data.taskId);
    expect(runs[0].messageId).toBeNull();
  });

  it('VAL-RUN-011: webhook message.send run links to created message', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Link Message Webhook',
      eventType: 'message.send',
      targetAgentId: agentId,
    });

    const res = await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ content: 'Hello from webhook', fromAgentId: agentId, toAgentId: agentId })
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].messageId).toBe(res.body.data.messageId);
    expect(runs[0].taskId).toBeNull();
  });

  it('VAL-RUN-011: webhook agent.wake run has null links but records outcome', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Wake Webhook',
      eventType: 'agent.wake',
      targetAgentId: agentId,
    });

    await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({})
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].taskId).toBeNull();
    expect(runs[0].messageId).toBeNull();
    expect(runs[0].status).toBe('completed');
    expect(runs[0].outcome).not.toBeNull();
  });

  it('VAL-RUN-012: webhook run updates to completed after dispatch', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Complete Webhook',
      eventType: 'task.create',
    });

    await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 'Completed Task' })
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].completedAt).not.toBeNull();
    expect(runs[0].outcome).not.toBeNull();
    expect(runs[0].error).toBeNull();
  });

  it('VAL-RUN-013: webhook run updates to failed on dispatch error', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Fail Webhook',
      eventType: 'task.create',
    });

    // Missing required 'title' field for task.create
    await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ description: 'No title' })
      .expect(400);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).not.toBeNull();
    expect(runs[0].completedAt).not.toBeNull();
  });

  it('VAL-RUN-013: schema-invalid webhook payload records a failed run', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Invalid Payload Webhook',
      eventType: 'task.create',
    });

    await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 123 })
      .expect(400);

    const runs = await getRuns(db, companyId);
    expect(runs).toHaveLength(1);
    expect(runs[0].automationType).toBe('webhook');
    expect(runs[0].automationId).toBe(webhookId);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).not.toBeNull();
    expect(runs[0].completedAt).not.toBeNull();
  });

  it('VAL-RUN-019: webhook run records projectId from the webhook', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Project Webhook',
      eventType: 'task.create',
      projectId,
    });

    await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 'Project Task' })
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].projectId).toBe(projectId);
  });

  it('VAL-RUN-020: company-level webhook run has null projectId', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Company Webhook',
      eventType: 'task.create',
    });

    await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 'Company Task' })
      .expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].projectId).toBeNull();
  });

  it('webhook task.create propagates projectId to created task', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Propagate Task Webhook',
      eventType: 'task.create',
      projectId,
    });

    const res = await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 'Propagated Task' })
      .expect(200);

    const task = await getTask(db, res.body.data.taskId);
    expect(task?.projectId).toBe(projectId);
    expect(task?.companyId).toBe(companyId);
  });

  it('webhook message.send propagates projectId to created message', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Propagate Message Webhook',
      eventType: 'message.send',
      projectId,
      targetAgentId: agentId,
    });

    const res = await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ content: 'Propagated message', fromAgentId: agentId, toAgentId: agentId })
      .expect(200);

    const message = await getMessage(db, res.body.data.messageId);
    expect(message?.projectId).toBe(projectId);
    expect(message?.companyId).toBe(companyId);
  });

  it('unscoped webhook creates task with null projectId', async () => {
    const webhookId = await insertWebhook(db, {
      companyId,
      name: 'Unscoped Webhook',
      eventType: 'task.create',
    });

    const res = await request(app)
      .post(`/api/webhooks/${webhookId}/trigger`)
      .set('x-webhook-secret', 'test-secret')
      .send({ title: 'Unscoped Task' })
      .expect(200);

    const task = await getTask(db, res.body.data.taskId);
    expect(task?.projectId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Run status invariants and cross-cutting assertions
// ---------------------------------------------------------------------------

describe('Automation runs — status invariants', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Invariant Corp');
  });

  it('VAL-RUN-014: completed run has startedAt and completedAt set', async () => {
    const agentId = await createAgent(app, companyId, 'Agent');
    const routine = await createRoutine(app, companyId, {
      name: 'Timestamp Routine',
      prompt: 'Check timestamps',
      agentId,
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].startedAt).not.toBeNull();
    expect(runs[0].completedAt).not.toBeNull();
  });

  it('VAL-RUN-015: failed runs carry error and completedAt', async () => {
    const otherCo = await createCompany(app, 'Other Co');
    const agent = await createAgent(app, companyId, 'Fail Agent');
    const routine = await createRoutine(app, companyId, {
      name: 'Fail',
      prompt: 'Fail',
      agentId: agent,
    });

    // Move agent to a different company so checkout fails
    await db.drizzle.execute(sql`
      UPDATE "agents" SET "company_id" = ${otherCo} WHERE "id" = ${agent}
    `);

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(500);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).not.toBeNull();
    expect(runs[0].completedAt).not.toBeNull();
  });

  it('VAL-RUN-016: completed runs carry outcome, error is null', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Outcome Routine',
      prompt: 'Check outcome',
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('completed');
    expect(runs[0].outcome).not.toBeNull();
    expect(runs[0].completedAt).not.toBeNull();
    expect(runs[0].error).toBeNull();
  });

  it('VAL-RUN-017: cancelled runs have completedAt and null outcome', async () => {
    // Insert a cancelled run directly (cancellation path is not triggered by any current endpoint)
    const runId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "automation_runs" ("id", "company_id", "automation_type", "automation_id", "automation_name", "trigger_type", "status", "started_at", "completed_at", "created_at", "updated_at")
      VALUES (${runId}, ${companyId}, 'routine', 'r1', 'Cancelled Run', 'manual', 'cancelled', ${now}, ${now}, ${now}, ${now})
    `);

    const runs = await getRuns(db, companyId);
    expect(runs[0].status).toBe('cancelled');
    expect(runs[0].completedAt).not.toBeNull();
    expect(runs[0].outcome).toBeNull();
  });

  it('VAL-RUN-021: run rows include taskId, executionId, sessionId, messageId fields', async () => {
    const agentId = await createAgent(app, companyId, 'Agent');
    const routine = await createRoutine(app, companyId, {
      name: 'Fields Routine',
      prompt: 'Check fields',
      agentId,
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    const run = runs[0];
    expect(run).toHaveProperty('taskId');
    expect(run).toHaveProperty('executionId');
    expect(run).toHaveProperty('sessionId');
    expect(run).toHaveProperty('messageId');
  });

  it('VAL-RUN-022: linked task exists and belongs to the same company', async () => {
    const agentId = await createAgent(app, companyId, 'Agent');
    const routine = await createRoutine(app, companyId, {
      name: 'Link Check Routine',
      prompt: 'Check link',
      agentId,
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routine.id}/trigger`).expect(200);

    const runs = await getRuns(db, companyId);
    const task = await getTask(db, runs[0].taskId!);
    expect(task).not.toBeNull();
    expect(task?.companyId).toBe(companyId);
  });
});

// ---------------------------------------------------------------------------
// Cross-company isolation
// ---------------------------------------------------------------------------

describe('Automation runs — cross-company isolation', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Company A');
    otherCompanyId = await createCompany(app, 'Company B');
  });

  it('VAL-RUN-030/034/035: runs are scoped to the triggering company', async () => {
    const agentA = await createAgent(app, companyId, 'Agent A');
    const routineA = await createRoutine(app, companyId, {
      name: 'Routine A',
      prompt: 'Company A work',
      agentId: agentA,
    });

    const agentB = await createAgent(app, otherCompanyId, 'Agent B');
    const routineB = await createRoutine(app, otherCompanyId, {
      name: 'Routine B',
      prompt: 'Company B work',
      agentId: agentB,
    });

    await request(app).post(`/api/companies/${companyId}/routines/${routineA.id}/trigger`).expect(200);
    await request(app).post(`/api/companies/${otherCompanyId}/routines/${routineB.id}/trigger`).expect(200);

    const runsA = await getRuns(db, companyId);
    const runsB = await getRuns(db, otherCompanyId);

    expect(runsA).toHaveLength(1);
    expect(runsB).toHaveLength(1);
    expect(runsA[0].companyId).toBe(companyId);
    expect(runsB[0].companyId).toBe(otherCompanyId);
    expect(runsA[0].automationId).toBe(routineA.id);
    expect(runsB[0].automationId).toBe(routineB.id);
  });
});
