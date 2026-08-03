import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, sql } from 'drizzle-orm';
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
  opts: {
    name: string;
    prompt: string;
    agentId?: string;
    projectId?: string;
    mode?: string;
    jarvisMode?: string;
    schedule?: string;
    enabled?: boolean;
  },
) {
  const body: Record<string, unknown> = { name: opts.name, prompt: opts.prompt };
  if (opts.agentId) body.agentId = opts.agentId;
  if (opts.projectId) body.projectId = opts.projectId;
  if (opts.mode) body.mode = opts.mode;
  if (opts.jarvisMode) body.jarvisMode = opts.jarvisMode;
  if (opts.schedule) body.schedule = opts.schedule;
  if (opts.enabled !== undefined) body.enabled = opts.enabled;
  const res = await request(app).post(`/api/companies/${companyId}/routines`).send(body).expect(201);
  return res.body.data;
}

async function createWorkflow(
  app: ReturnType<typeof createTestApp>,
  companyId: string,
  opts: {
    name: string;
    projectId?: string;
    nodes?: unknown[];
    status?: string;
  },
) {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.projectId) body.projectId = opts.projectId;
  if (opts.nodes) body.nodes = opts.nodes;
  if (opts.status) body.status = opts.status;
  const res = await request(app).post(`/api/companies/${companyId}/workflows`).send(body).expect(201);
  return res.body.data;
}

async function createWebhook(
  app: ReturnType<typeof createTestApp>,
  companyId: string,
  opts: {
    name: string;
    eventType?: string;
    projectId?: string;
    targetAgentId?: string;
  },
) {
  const body: Record<string, unknown> = { name: opts.name };
  if (opts.eventType) body.eventType = opts.eventType;
  if (opts.projectId) body.projectId = opts.projectId;
  if (opts.targetAgentId) body.targetAgentId = opts.targetAgentId;
  const res = await request(app)
    .post(`/api/companies/${companyId}/webhooks`)
    .send(body)
    .expect(201);
  return res.body.data;
}

/** Insert an automation_run directly into the DB for aggregation testing. */
async function insertRun(
  db: DbInstance,
  opts: {
    companyId: string;
    projectId?: string | null;
    automationType: 'routine' | 'workflow' | 'webhook';
    automationId: string;
    automationName: string;
    triggerType?: string;
    status?: string;
    taskId?: string | null;
    outcome?: string | null;
    error?: string | null;
    createdAt?: Date;
    completedAt?: Date | null;
  },
) {
  const id = randomUUID();
  const now = opts.createdAt ?? new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "automation_runs"
      ("id", "company_id", "project_id", "automation_type", "automation_id", "automation_name",
       "trigger_type", "trigger_payload", "status", "task_id", "outcome", "error",
       "started_at", "completed_at", "created_at", "updated_at")
    VALUES (
      ${id}, ${opts.companyId}, ${opts.projectId ?? null}, ${opts.automationType},
      ${opts.automationId}, ${opts.automationName},
      ${opts.triggerType ?? 'manual'}, ${'{}'}::jsonb,
      ${opts.status ?? 'completed'},
      ${opts.taskId ?? null}, ${opts.outcome ?? null}, ${opts.error ?? null},
      ${now}, ${opts.completedAt ?? null}, ${now}, ${now}
    )
  `);
  return id;
}

// ---------------------------------------------------------------------------
// Unified automations listing
// ---------------------------------------------------------------------------

describe('Unified automations API — GET /automations', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Auto Corp');
    otherCompanyId = await createCompany(app, 'Other Corp');
    projectId = await createProject(app, companyId, 'Project Alpha');
    otherProjectId = await createProject(app, otherCompanyId, 'Other Project');
  });

  // VAL-AUTO-001, VAL-CROSS-006
  it('returns all three automation types in a unified list', async () => {
    const routine = await createRoutine(app, companyId, { name: 'Daily Standup', prompt: 'Do standup' });
    const workflow = await createWorkflow(app, companyId, { name: 'Deploy Flow' });
    const webhook = await createWebhook(app, companyId, { name: 'GitHub Hook' });

    const res = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);

    const types = res.body.data.map((e: any) => e.type).sort();
    expect(types).toContain('routine');
    expect(types).toContain('workflow');
    expect(types).toContain('webhook');

    const routineEntry = res.body.data.find((e: any) => e.type === 'routine');
    expect(routineEntry.id).toBe(routine.id);
    const workflowEntry = res.body.data.find((e: any) => e.type === 'workflow');
    expect(workflowEntry.id).toBe(workflow.id);
    const webhookEntry = res.body.data.find((e: any) => e.type === 'webhook');
    expect(webhookEntry.id).toBe(webhook.id);
  });

  // VAL-AUTO-002
  it('every entry has the canonical common shape with correct types', async () => {
    await createRoutine(app, companyId, { name: 'R1', prompt: 'P' });
    await createWorkflow(app, companyId, { name: 'W1' });
    await createWebhook(app, companyId, { name: 'Hook1' });

    const res = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);

    for (const entry of res.body.data) {
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('enabled');
      expect(typeof entry.enabled).toBe('boolean');
      expect(entry).toHaveProperty('status');
      expect(typeof entry.status).toBe('string');
      expect(entry).toHaveProperty('triggerInfo');
      expect(typeof entry.triggerInfo).toBe('object');
      expect(entry).toHaveProperty('projectId');
      expect(entry).toHaveProperty('lastRun');
      expect(entry).toHaveProperty('runCount');
      expect(typeof entry.runCount).toBe('number');
      expect(entry.runCount).toBeGreaterThanOrEqual(0);
    }
  });

  // VAL-AUTO-003
  it('filters by project, returning only matching project entries', async () => {
    await createRoutine(app, companyId, { name: 'Scoped R', prompt: 'P', projectId });
    await createRoutine(app, companyId, { name: 'Unscoped R', prompt: 'P' });
    await createWorkflow(app, companyId, { name: 'Scoped W', projectId });
    await createWebhook(app, companyId, { name: 'Scoped Hook', projectId });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations?project=${projectId}`)
      .expect(200);

    expect(res.body.data.length).toBe(3);
    for (const entry of res.body.data) {
      expect(entry.projectId).toBe(projectId);
    }
  });

  // VAL-AUTO-004
  it('project filtering excludes unscoped (null projectId) automations', async () => {
    await createRoutine(app, companyId, { name: 'Scoped R', prompt: 'P', projectId });
    await createRoutine(app, companyId, { name: 'Unscoped R', prompt: 'P' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations?project=${projectId}`)
      .expect(200);

    for (const entry of res.body.data) {
      expect(entry.projectId).not.toBeNull();
    }
  });

  // VAL-AUTO-005
  it('listing is isolated to the requested company', async () => {
    const r1 = await createRoutine(app, companyId, { name: 'Company A Routine', prompt: 'P' });
    const r2 = await createRoutine(app, otherCompanyId, { name: 'Company B Routine', prompt: 'P' });

    const resA = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);
    const resB = await request(app).get(`/api/companies/${otherCompanyId}/automations`).expect(200);

    const idsA = resA.body.data.map((e: any) => e.id);
    const idsB = resB.body.data.map((e: any) => e.id);

    expect(idsA).toContain(r1.id);
    expect(idsA).not.toContain(r2.id);
    expect(idsB).toContain(r2.id);
    expect(idsB).not.toContain(r1.id);
  });

  // VAL-AUTO-006
  it('type discrimination preserves source identity', async () => {
    const routine = await createRoutine(app, companyId, { name: 'My Routine', prompt: 'P' });
    const workflow = await createWorkflow(app, companyId, { name: 'My Workflow' });
    const webhook = await createWebhook(app, companyId, { name: 'My Webhook' });

    const res = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);

    const routineEntry = res.body.data.find((e: any) => e.id === routine.id);
    expect(routineEntry.type).toBe('routine');
    expect(routineEntry.name).toBe('My Routine');

    const workflowEntry = res.body.data.find((e: any) => e.id === workflow.id);
    expect(workflowEntry.type).toBe('workflow');
    expect(workflowEntry.name).toBe('My Workflow');

    const webhookEntry = res.body.data.find((e: any) => e.id === webhook.id);
    expect(webhookEntry.type).toBe('webhook');
    expect(webhookEntry.name).toBe('My Webhook');
  });

  // VAL-AUTO-007
  it('routine triggerInfo surfaces mode, schedule, and jarvisMode', async () => {
    const routine = await createRoutine(app, companyId, {
      name: 'Scheduled Briefing',
      prompt: 'P',
      mode: 'scheduled',
      jarvisMode: 'daily_briefing',
      schedule: '0 9 * * *',
    });

    const res = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);

    const entry = res.body.data.find((e: any) => e.id === routine.id);
    expect(entry.triggerInfo.mode).toBe('scheduled');
    expect(entry.triggerInfo.schedule).toBe('0 9 * * *');
    expect(entry.triggerInfo.jarvisMode).toBe('daily_briefing');
  });

  // VAL-AUTO-008
  it('workflow triggerInfo surfaces nodeCount and status', async () => {
    const nodes = [
      { id: 'n1', type: 'task', label: 'Task 1', config: {}, status: 'pending', dependsOn: [] },
      { id: 'n2', type: 'decision', label: 'Decide', config: {}, status: 'pending', dependsOn: ['n1'] },
    ];
    const workflow = await createWorkflow(app, companyId, { name: 'Two Node Flow', nodes });

    const res = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);

    const entry = res.body.data.find((e: any) => e.id === workflow.id);
    expect(entry.triggerInfo.nodeCount).toBe(2);
    expect(entry.triggerInfo.status).toBe('draft');
  });

  // VAL-AUTO-009
  it('webhook triggerInfo surfaces eventType, enabled, and triggerCount', async () => {
    const webhook = await createWebhook(app, companyId, {
      name: 'Task Hook',
      eventType: 'task.create',
    });

    const res = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);

    const entry = res.body.data.find((e: any) => e.id === webhook.id);
    expect(entry.triggerInfo.eventType).toBe('task.create');
    expect(entry.triggerInfo.enabled).toBe(true);
    expect(entry.triggerInfo.triggerCount).toBe(0);
  });

  // VAL-AUTO-010
  it('runCount and lastRun are derived from automation_runs scoped by company/type/id', async () => {
    const routine = await createRoutine(app, companyId, { name: 'Counted Routine', prompt: 'P' });

    const t1 = new Date('2025-01-01T10:00:00Z');
    const t2 = new Date('2025-01-02T10:00:00Z');
    const t3 = new Date('2025-01-03T10:00:00Z');

    await insertRun(db, {
      companyId,
      automationType: 'routine',
      automationId: routine.id,
      automationName: routine.name,
      status: 'completed',
      createdAt: t1,
    });
    await insertRun(db, {
      companyId,
      automationType: 'routine',
      automationId: routine.id,
      automationName: routine.name,
      status: 'failed',
      createdAt: t2,
    });
    await insertRun(db, {
      companyId,
      automationType: 'routine',
      automationId: routine.id,
      automationName: routine.name,
      status: 'completed',
      createdAt: t3,
    });

    const res = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);

    const entry = res.body.data.find((e: any) => e.id === routine.id);
    expect(entry.runCount).toBe(3);
    expect(entry.lastRun).toBe(t3.toISOString());
  });

  // VAL-AUTO-011
  it('automations without runs report runCount: 0 and lastRun: null', async () => {
    const routine = await createRoutine(app, companyId, { name: 'No Runs Routine', prompt: 'P' });

    const res = await request(app).get(`/api/companies/${companyId}/automations`).expect(200);

    const entry = res.body.data.find((e: any) => e.id === routine.id);
    expect(entry.runCount).toBe(0);
    expect(entry.lastRun).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Automation runs listing — GET /automations/runs
// ---------------------------------------------------------------------------

describe('Unified automations API — GET /automations/runs', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let routineId: string;
  let workflowId: string;
  let webhookId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Runs Corp');
    otherCompanyId = await createCompany(app, 'Other Runs Corp');
    projectId = await createProject(app, companyId, 'Proj A');
    otherProjectId = await createProject(app, otherCompanyId, 'Proj B');

    const routine = await createRoutine(app, companyId, { name: 'R', prompt: 'P', projectId });
    routineId = routine.id;
    const workflow = await createWorkflow(app, companyId, { name: 'W', projectId });
    workflowId = workflow.id;
    const webhook = await createWebhook(app, companyId, { name: 'Hook', projectId });
    webhookId = webhook.id;
  });

  // VAL-RUN-025
  it('returns paginated run list ordered by createdAt desc', async () => {
    const baseTime = new Date('2025-06-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await insertRun(db, {
        companyId,
        automationType: 'routine',
        automationId: routineId,
        automationName: 'R',
        createdAt: new Date(baseTime.getTime() + i * 60000),
      });
    }

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/runs?limit=2&offset=0`)
      .expect(200);

    expect(res.body.data).toHaveLength(2);
    // Descending order — first entry should be the latest
    expect(new Date(res.body.data[0].createdAt).getTime()).toBeGreaterThan(
      new Date(res.body.data[1].createdAt).getTime(),
    );

    const res2 = await request(app)
      .get(`/api/companies/${companyId}/automations/runs?limit=2&offset=2`)
      .expect(200);

    expect(res2.body.data).toHaveLength(2);
    // offset window should be earlier than first page
    expect(new Date(res2.body.data[0].createdAt).getTime()).toBeLessThan(
      new Date(res.body.data[1].createdAt).getTime(),
    );
  });

  // VAL-RUN-026
  it('filters runs by automation type', async () => {
    await insertRun(db, { companyId, automationType: 'routine', automationId: routineId, automationName: 'R' });
    await insertRun(db, { companyId, automationType: 'workflow', automationId: workflowId, automationName: 'W' });
    await insertRun(db, { companyId, automationType: 'webhook', automationId: webhookId, automationName: 'Hook' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/runs?type=routine`)
      .expect(200);

    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].automationType).toBe('routine');
  });

  // VAL-RUN-027
  it('filters runs by status', async () => {
    await insertRun(db, { companyId, automationType: 'routine', automationId: routineId, automationName: 'R', status: 'completed' });
    await insertRun(db, { companyId, automationType: 'routine', automationId: routineId, automationName: 'R', status: 'failed' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/runs?status=completed`)
      .expect(200);

    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].status).toBe('completed');
  });

  // VAL-RUN-028
  it('filters runs by project', async () => {
    await insertRun(db, { companyId, projectId, automationType: 'routine', automationId: routineId, automationName: 'R' });
    await insertRun(db, { companyId, projectId: null, automationType: 'routine', automationId: routineId, automationName: 'R' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/runs?project=${projectId}`)
      .expect(200);

    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].projectId).toBe(projectId);
  });

  // VAL-RUN-029
  it('combined filters intersect (type + status + project)', async () => {
    await insertRun(db, { companyId, projectId, automationType: 'routine', automationId: routineId, automationName: 'R', status: 'completed' });
    await insertRun(db, { companyId, projectId, automationType: 'workflow', automationId: workflowId, automationName: 'W', status: 'completed' });
    await insertRun(db, { companyId, projectId, automationType: 'routine', automationId: routineId, automationName: 'R', status: 'failed' });
    await insertRun(db, { companyId, projectId: null, automationType: 'routine', automationId: routineId, automationName: 'R', status: 'completed' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/runs?type=routine&status=completed&project=${projectId}`)
      .expect(200);

    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].automationType).toBe('routine');
    expect(res.body.data[0].status).toBe('completed');
    expect(res.body.data[0].projectId).toBe(projectId);
  });

  // VAL-RUN-030
  it('excludes runs from other companies', async () => {
    await insertRun(db, { companyId, automationType: 'routine', automationId: routineId, automationName: 'R' });
    await insertRun(db, { companyId: otherCompanyId, automationType: 'routine', automationId: routineId, automationName: 'R' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/runs`)
      .expect(200);

    for (const run of res.body.data) {
      expect(run.companyId).toBe(companyId);
    }
    expect(res.body.data.length).toBe(1);
  });

  // VAL-RUN-021 — run list includes link fields
  it('run list response includes taskId, executionId, sessionId, messageId fields', async () => {
    await insertRun(db, {
      companyId,
      automationType: 'routine',
      automationId: routineId,
      automationName: 'R',
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/runs`)
      .expect(200);

    const run = res.body.data[0];
    expect(run).toHaveProperty('taskId');
    expect(run).toHaveProperty('executionId');
    expect(run).toHaveProperty('sessionId');
    expect(run).toHaveProperty('messageId');
    // Fields are nullable; without linked work they are null
    expect(run.taskId).toBeNull();
    expect(run.executionId).toBeNull();
    expect(run.sessionId).toBeNull();
    expect(run.messageId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-automation runs — GET /automations/:type/:id/runs
// ---------------------------------------------------------------------------

describe('Unified automations API — per-automation runs', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let routineId: string;
  let workflowId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Per-Auto Corp');
    otherCompanyId = await createCompany(app, 'Other Per-Auto Corp');

    const routine = await createRoutine(app, companyId, { name: 'R', prompt: 'P' });
    routineId = routine.id;
    const workflow = await createWorkflow(app, companyId, { name: 'W' });
    workflowId = workflow.id;
  });

  // VAL-RUN-031
  it('returns runs for the specified automation only', async () => {
    await insertRun(db, { companyId, automationType: 'routine', automationId: routineId, automationName: 'R' });
    await insertRun(db, { companyId, automationType: 'routine', automationId: routineId, automationName: 'R', createdAt: new Date(Date.now() + 1000) });
    await insertRun(db, { companyId, automationType: 'workflow', automationId: workflowId, automationName: 'W' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/routine/${routineId}/runs`)
      .expect(200);

    expect(res.body.data.length).toBe(2);
    for (const run of res.body.data) {
      expect(run.automationType).toBe('routine');
      expect(run.automationId).toBe(routineId);
    }
  });

  // VAL-RUN-031 — pagination
  it('supports limit and offset pagination', async () => {
    for (let i = 0; i < 5; i++) {
      await insertRun(db, {
        companyId,
        automationType: 'routine',
        automationId: routineId,
        automationName: 'R',
        createdAt: new Date(Date.now() + i * 1000),
      });
    }

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/routine/${routineId}/runs?limit=2&offset=0`)
      .expect(200);

    expect(res.body.data).toHaveLength(2);
  });

  // VAL-RUN-032
  it('returns 400 for invalid automation type', async () => {
    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/invalid_type/${routineId}/runs`)
      .expect(400);

    expect(res.body).toHaveProperty('code');
  });

  // VAL-RUN-033
  it('returns empty list for valid type but nonexistent automationId', async () => {
    const fakeId = randomUUID();
    const res = await request(app)
      .get(`/api/companies/${companyId}/automations/routine/${fakeId}/runs`)
      .expect(200);

    expect(res.body.data).toEqual([]);
  });

  // VAL-RUN-034, VAL-RUN-036
  it('cross-company per-automation runs does not leak existence (empty list, not 404)', async () => {
    await insertRun(db, { companyId, automationType: 'routine', automationId: routineId, automationName: 'R' });

    const res = await request(app)
      .get(`/api/companies/${otherCompanyId}/automations/routine/${routineId}/runs`)
      .expect(200);

    expect(res.body.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Webhook project scoping — POST/GET /webhooks
// ---------------------------------------------------------------------------

describe('Unified automations API — webhook project scoping', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Webhook Corp');
    otherCompanyId = await createCompany(app, 'Other Webhook Corp');
    projectId = await createProject(app, companyId, 'Hook Project');
    otherProjectId = await createProject(app, otherCompanyId, 'Other Hook Project');
  });

  // VAL-WHK-001
  it('creates a webhook scoped to a valid project', async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/webhooks`)
      .send({ name: 'Project Hook', eventType: 'task.create', projectId })
      .expect(201);

    expect(res.body.data.projectId).toBe(projectId);
    expect(res.body.data.companyId).toBe(companyId);
  });

  // VAL-WHK-001 — nonexistent project rejected
  it('rejects webhook creation with nonexistent project', async () => {
    const fakeProjectId = randomUUID();
    await request(app)
      .post(`/api/companies/${companyId}/webhooks`)
      .send({ name: 'Bad Hook', projectId: fakeProjectId })
      .expect(404);
  });

  // VAL-WHK-001, VAL-WHK-007 — foreign company project rejected
  it('rejects webhook creation with foreign company project', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/webhooks`)
      .send({ name: 'Cross Hook', projectId: otherProjectId })
      .expect(404);
  });

  // VAL-WHK-006 — unscoped (null projectId) behavior preserved
  it('creates a valid company-scoped webhook without projectId', async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/webhooks`)
      .send({ name: 'Company Hook' })
      .expect(201);

    expect(res.body.data.projectId).toBeNull();
  });

  // VAL-WHK-002
  it('lists webhooks filtered by project', async () => {
    await createWebhook(app, companyId, { name: 'Scoped Hook', projectId });
    await createWebhook(app, companyId, { name: 'Unscoped Hook' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/webhooks?project=${projectId}`)
      .expect(200);

    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].projectId).toBe(projectId);
    expect(res.body.data[0].name).toBe('Scoped Hook');
  });

  // VAL-WHK-002 — unfiltered returns all
  it('unfiltered webhook listing returns all company webhooks', async () => {
    await createWebhook(app, companyId, { name: 'Scoped Hook', projectId });
    await createWebhook(app, companyId, { name: 'Unscoped Hook' });

    const res = await request(app)
      .get(`/api/companies/${companyId}/webhooks`)
      .expect(200);

    expect(res.body.data.length).toBe(2);
  });

  // VAL-WHK-007 — cross-company isolation
  it('enforces cross-company webhook isolation', async () => {
    await createWebhook(app, companyId, { name: 'A Hook' });
    await createWebhook(app, otherCompanyId, { name: 'B Hook' });

    const resA = await request(app)
      .get(`/api/companies/${companyId}/webhooks`)
      .expect(200);
    const resB = await request(app)
      .get(`/api/companies/${otherCompanyId}/webhooks`)
      .expect(200);

    const namesA = resA.body.data.map((w: any) => w.name);
    const namesB = resB.body.data.map((w: any) => w.name);

    expect(namesA).toContain('A Hook');
    expect(namesA).not.toContain('B Hook');
    expect(namesB).toContain('B Hook');
    expect(namesB).not.toContain('A Hook');
  });
});

// ---------------------------------------------------------------------------
// Cross-area: VAL-CROSS-005 — project deletion clears projectId
// ---------------------------------------------------------------------------

describe('Unified automations API — project deletion and cross-area flows', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Cross Corp');
    projectId = await createProject(app, companyId, 'Cross Project');
  });

  // VAL-CROSS-005
  it('deleting a project sets webhook projectId to NULL and webhook still appears unscoped', async () => {
    const webhook = await createWebhook(app, companyId, { name: 'Proj Hook', projectId });

    // Verify it appears in project-filtered listing
    const beforeRes = await request(app)
      .get(`/api/companies/${companyId}/automations?project=${projectId}`)
      .expect(200);
    expect(beforeRes.body.data.some((e: any) => e.id === webhook.id)).toBe(true);

    // Hard-delete the project from the DB (the API only archives; ON DELETE SET NULL
    // is a DB-level constraint that fires on actual row deletion)
    await db.drizzle.execute(sql`DELETE FROM "projects" WHERE "id" = ${projectId}`);

    // Webhook should still exist but with null projectId
    const webhookRes = await request(app)
      .get(`/api/companies/${companyId}/webhooks`)
      .expect(200);
    const wh = webhookRes.body.data.find((w: any) => w.id === webhook.id);
    expect(wh).toBeDefined();
    expect(wh.projectId).toBeNull();

    // Unfiltered listing should still include it with null projectId
    const allRes = await request(app)
      .get(`/api/companies/${companyId}/automations`)
      .expect(200);
    const entry = allRes.body.data.find((e: any) => e.id === webhook.id);
    expect(entry).toBeDefined();
    expect(entry.projectId).toBeNull();
  });

  // VAL-CROSS-006
  it('unified listing includes all three types with correct discrimination and fields', async () => {
    const agentId = await createAgent(app, companyId, 'Agent X');
    const routine = await createRoutine(app, companyId, {
      name: 'Cross Routine',
      prompt: 'P',
      agentId,
      projectId,
    });
    const workflow = await createWorkflow(app, companyId, { name: 'Cross Workflow', projectId });
    const webhook = await createWebhook(app, companyId, { name: 'Cross Webhook', projectId });

    // Seed a run for the routine
    await insertRun(db, {
      companyId,
      projectId,
      automationType: 'routine',
      automationId: routine.id,
      automationName: routine.name,
      status: 'completed',
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/automations`)
      .expect(200);

    const r = res.body.data.find((e: any) => e.id === routine.id);
    expect(r.type).toBe('routine');
    expect(r.projectId).toBe(projectId);
    expect(r.runCount).toBe(1);
    expect(r.lastRun).not.toBeNull();

    const w = res.body.data.find((e: any) => e.id === workflow.id);
    expect(w.type).toBe('workflow');
    expect(w.projectId).toBe(projectId);
    expect(w.runCount).toBe(0);
    expect(w.lastRun).toBeNull();

    const wh = res.body.data.find((e: any) => e.id === webhook.id);
    expect(wh.type).toBe('webhook');
    expect(wh.projectId).toBe(projectId);
    expect(wh.runCount).toBe(0);
    expect(wh.lastRun).toBeNull();
  });
});
