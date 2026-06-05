import { describe, expect, it, beforeEach } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Hybrid Jarvis runtime foundation', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Jarvis Runtime Corp', budgetMonthlyCents: 100000 })
      .expect(201);
    companyId = company.body.data.id;
  });

  it('exposes provider and runtime-only adapter descriptors', async () => {
    const res = await request(app).get('/api/runtime/adapters').expect(200);
    const ids = res.body.data.map((adapter: any) => adapter.id);

    expect(ids).toContain('provider:anthropic');
    expect(ids).toContain('process:local');
    expect(ids).toContain('http:remote');
    expect(ids).toContain('mcp:tool-runtime');
    expect(ids).toContain('openjarvis:local');

    const openJarvis = res.body.data.find((adapter: any) => adapter.id === 'openjarvis:local');
    expect(openJarvis.capabilities.voice).toBe(true);
    expect(openJarvis.capabilities.browser).toBe(true);
    expect(openJarvis.supportedModes).toContain('continuous');
  });

  it('stores adapter, skill, routine, and session policy on agents', async () => {
    const created = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Local Jarvis',
        role: 'engineer',
        provider: 'ollama',
        model: 'gemma4',
        adapterId: 'openjarvis:local',
        adapterConfig: { preset: 'code-assistant' },
        skillsEnabled: ['code-explainer'],
        routinePolicy: { allowContinuous: true },
        sessionPolicy: { resume: true },
      })
      .expect(201);

    expect(created.body.data.provider).toBe('local');
    expect(created.body.data.adapterId).toBe('openjarvis:local');
    expect(created.body.data.adapterConfig).toEqual({ preset: 'code-assistant' });
    expect(created.body.data.skillsEnabled).toEqual(['code-explainer']);
    expect(created.body.data.routinePolicy).toEqual({ allowContinuous: true });
    expect(created.body.data.sessionPolicy).toEqual({ resume: true });
  });

  it('keeps agent wake scoped to the route company', async () => {
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other Corp', budgetMonthlyCents: 100000 })
      .expect(201);

    const otherAgent = await request(app)
      .post(`/api/companies/${otherCompany.body.data.id}/agents`)
      .send({ name: 'Other Worker', role: 'engineer' })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/agents/${otherAgent.body.data.id}/wake`)
      .expect(404);
  });

  it('rejects runtime sessions with unrelated task or execution ids', async () => {
    const agentA = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Agent A', role: 'engineer' })
      .expect(201);
    const agentB = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Agent B', role: 'engineer' })
      .expect(201);

    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentB.body.data.id}/executions`)
      .send({})
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agentA.body.data.id,
        executionId: execution.body.data.id,
      })
      .expect(400);

    const otherCompanyId = randomUUID();
    const otherTaskId = randomUUID();
    await db.drizzle.insert(db.schema.companies).values({
      id: otherCompanyId,
      name: 'Task Owner Corp',
      budgetMonthlyCents: 100000,
    });
    await db.drizzle.insert(db.schema.tasks).values({
      id: otherTaskId,
      companyId: otherCompanyId,
      title: 'Other company task',
    });

    await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agentA.body.data.id,
        taskId: otherTaskId,
      })
      .expect(400);
  });

  it('maps pre-migration local agents to the Ollama runtime adapter', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Legacy Local', role: 'engineer', provider: 'ollama', model: 'gemma4' })
      .expect(201);

    await db.drizzle
      .update(db.schema.agents)
      .set({ adapterId: null })
      .where(eq(db.schema.agents.id, agent.body.data.id));

    const session = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId: agent.body.data.id })
      .expect(201);

    expect(session.body.data.adapterId).toBe('provider:ollama');
  });

  it('inherits agent adapter config and preserves an execution workspace when omitted', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Configured Runtime',
        role: 'engineer',
        adapterId: 'openjarvis:local',
        adapterConfig: { preset: 'desktop-assistant' },
      })
      .expect(201);
    const environment = await request(app)
      .post(`/api/companies/${companyId}/environments`)
      .send({ name: 'Existing Workspace', workspacePath: 'existing-workspace' })
      .expect(201);
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agent.body.data.id}/executions`)
      .send({})
      .expect(201);
    const previousLeaseAt = new Date(Date.now() - 60_000);

    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({ environmentId: environment.body.data.id })
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));
    await db.drizzle
      .update(db.schema.executionEnvironments)
      .set({
        status: 'leased',
        leaseOwnerAgentId: agent.body.data.id,
        leaseOwnerExecutionId: execution.body.data.id,
        leasedAt: previousLeaseAt,
      })
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));

    const session = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
      })
      .expect(201);

    expect(session.body.data.adapterConfig).toEqual({ preset: 'desktop-assistant' });
    expect(session.body.data.environmentId).toBe(environment.body.data.id);

    const nullEnvironmentSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        executionId: execution.body.data.id,
        environmentId: null,
      })
      .expect(201);
    expect(nullEnvironmentSession.body.data.environmentId).toBe(environment.body.data.id);

    await request(app)
      .post(`/api/companies/${companyId}/sessions/${session.body.data.id}/finalize`)
      .expect(200);

    const [updatedExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, execution.body.data.id));
    expect(updatedExecution.environmentId).toBe(environment.body.data.id);

    const [stillLeased] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));
    expect(stillLeased.status).toBe('leased');
    expect(stillLeased.leaseOwnerExecutionId).toBe(execution.body.data.id);
  });

  it('creates, cancels, and finalizes durable runtime sessions with workspace leases', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Worker', role: 'engineer', provider: 'ollama', model: 'gemma4' })
      .expect(201);

    const environment = await request(app)
      .post(`/api/companies/${companyId}/environments`)
      .send({ name: 'Local Worktree', workspacePath: 'runtime-foundation' })
      .expect(201);

    const created = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        environmentId: environment.body.data.id,
        adapterId: 'process:local',
        adapterConfig: { command: 'echo' },
        resumeState: { turn: 1 },
      })
      .expect(201);

    expect(created.body.data.status).toBe('running');
    expect(created.body.data.runId).toBeDefined();
    expect(created.body.data.environmentId).toBe(environment.body.data.id);

    const [leased] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));
    expect(leased.status).toBe('leased');

    const cancelled = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/cancel`)
      .send({ reason: 'operator stop' })
      .expect(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect(cancelled.body.data.cancellationReason).toBe('operator stop');

    const finalized = await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/finalize`)
      .expect(200);
    expect(finalized.body.data.status).toBe('finalized');

    const [released] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));
    expect(released.status).toBe('available');

    const secondSession = await request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({
        agentId: agent.body.data.id,
        environmentId: environment.body.data.id,
        adapterId: 'process:local',
      })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/sessions/${created.body.data.id}/finalize`)
      .expect(200);

    const [stillLeased] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environment.body.data.id));
    expect(secondSession.body.data.status).toBe('running');
    expect(stillLeased.status).toBe('leased');
    expect(stillLeased.leaseOwnerAgentId).toBe(agent.body.data.id);
  });

  it('installs company skills and assigns them to agents', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Researcher', role: 'engineer' })
      .expect(201);

    const installed = await request(app)
      .post(`/api/companies/${companyId}/skills/install`)
      .send({
        name: 'code-explainer',
        version: '1.0.0',
        source: 'github:example/skills',
        provenance: 'github',
        trustLevel: 'markdown_only',
        content: '# Code Explainer\nExplain code with citations.',
        agentIds: [agent.body.data.id],
      })
      .expect(201);

    expect(installed.body.data.skill.name).toBe('code-explainer');
    expect(installed.body.data.assignments).toHaveLength(1);

    const refreshedAgent = await request(app)
      .get(`/api/companies/${companyId}/agents/${agent.body.data.id}`)
      .expect(200);
    expect(refreshedAgent.body.data.skillsEnabled).toContain('code-explainer');
  });

  it('audits, exports, and resets company skill sync state', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Skill Operator', role: 'engineer' })
      .expect(201);

    const installed = await request(app)
      .post(`/api/companies/${companyId}/skills/install`)
      .send({
        name: 'daily-briefing',
        version: '1.0.0',
        source: 'agentskills.io/manual',
        provenance: 'manual',
        trustLevel: 'markdown_only',
        entrypoint: '../escape.md',
        content: '# Daily Briefing\nSummarize open tasks and approvals.',
        tags: ['jarvis', 'briefing'],
        agentIds: [agent.body.data.id],
      })
      .expect(201);

    await db.drizzle
      .update(db.schema.agentSkills)
      .set({
        syncStatus: 'synced',
        materializedPath: '/tmp/eidolon/skills/daily-briefing',
        lastSyncedAt: new Date(),
      })
      .where(eq(db.schema.agentSkills.id, installed.body.data.assignments[0].id));

    const audit = await request(app)
      .get(`/api/companies/${companyId}/skills/audit`)
      .expect(200);
    expect(audit.body.data.totals.skills).toBe(1);
    expect(audit.body.data.totals.assignments).toBe(1);
    expect(audit.body.data.totals.syncedAssignments).toBe(1);
    expect(audit.body.data.skills[0]).toMatchObject({
      name: 'daily-briefing',
      assignmentCount: 1,
      issues: [],
    });

    const exported = await request(app)
      .get(`/api/companies/${companyId}/skills/${installed.body.data.skill.id}/export`)
      .expect(200);
    expect(exported.body.data.schema).toBe('agentskills.io/v1');
    expect(exported.body.data.skill.name).toBe('daily-briefing');
    expect(exported.body.data.skill.entrypoint).toBe('SKILL.md');
    expect(exported.body.data.files).toEqual([
      {
        path: 'SKILL.md',
        content: '# Daily Briefing\nSummarize open tasks and approvals.',
      },
    ]);
    expect(exported.body.data.assignments[0]).toMatchObject({
      agentId: agent.body.data.id,
      syncStatus: 'synced',
      materializedPath: '/tmp/eidolon/skills/daily-briefing',
    });

    const reset = await request(app)
      .post(`/api/companies/${companyId}/skills/${installed.body.data.skill.id}/reset`)
      .send({ reason: 'resync local adapter home' })
      .expect(200);
    expect(reset.body.data.assignments[0]).toMatchObject({
      agentId: agent.body.data.id,
      syncStatus: 'pending',
      materializedPath: null,
      lastSyncedAt: null,
    });

    await request(app)
      .post(`/api/companies/${companyId}/skills/${installed.body.data.skill.id}/reset`)
      .send({ agentIds: [] })
      .expect(400);

    const unassignedAgent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Unassigned Skill Agent', role: 'support' })
      .expect(201);

    await request(app)
      .post(`/api/companies/${companyId}/skills/${installed.body.data.skill.id}/reset`)
      .send({ agentIds: [unassignedAgent.body.data.id] })
      .expect(404);

    const [assignment] = await db.drizzle
      .select()
      .from(db.schema.agentSkills)
      .where(
        and(
          eq(db.schema.agentSkills.companyId, companyId),
          eq(db.schema.agentSkills.skillId, installed.body.data.skill.id),
        ),
      );
    expect(assignment.syncStatus).toBe('pending');
    expect(assignment.materializedPath).toBeNull();
    expect(assignment.lastSyncedAt).toBeNull();
  });

  it('creates and triggers Jarvis routines', async () => {
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Briefing Agent', role: 'support' })
      .expect(201);

    const routine = await request(app)
      .post(`/api/companies/${companyId}/routines`)
      .send({
        name: 'Morning briefing',
        agentId: agent.body.data.id,
        jarvisMode: 'daily_briefing',
        schedule: '0 8 * * *',
        prompt: 'Summarize the day.',
      })
      .expect(201);

    expect(routine.body.data.jarvisMode).toBe('daily_briefing');
    expect(routine.body.data.enabled).toBe(true);

    const triggered = await request(app)
      .post(`/api/companies/${companyId}/routines/${routine.body.data.id}/trigger`)
      .expect(200);
    expect(triggered.body.data.lastTriggeredAt).toBeTruthy();
  });
});
