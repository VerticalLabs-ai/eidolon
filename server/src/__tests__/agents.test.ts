import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestDb, createTestApp } from '../test-utils.js';
import { decrypt } from '../services/crypto.js';

describe('Agents API', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);

    // Every test needs a company to attach agents to
    const res = await request(app)
      .post('/api/companies')
      .send({ name: 'Agent Test Corp', budgetMonthlyCents: 100000 });
    companyId = res.body.data.id;
  });

  const agentsUrl = () => `/api/companies/${companyId}/agents`;
  const agentUrl = (id: string) => `${agentsUrl()}/${id}`;

  // ---------------------------------------------------------------------------
  // POST - create agent
  // ---------------------------------------------------------------------------

  describe('POST /api/companies/:companyId/agents', () => {
    it('should create an agent with minimal fields', async () => {
      const res = await request(app)
        .post(agentsUrl())
        .send({ name: 'Alice', role: 'engineer' })
        .expect(201);

      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.name).toBe('Alice');
      expect(res.body.data.role).toBe('engineer');
      expect(res.body.data.companyId).toBe(companyId);
      expect(res.body.data.status).toBe('idle');
      expect(res.body.data.provider).toBe('anthropic');
      expect(res.body.data.model).toBe('claude-opus-4-7');
      expect(res.body.data.temperature).toBeCloseTo(0.7);
      expect(res.body.data.maxTokens).toBe(4096);
    });

    it('should create an agent with full config', async () => {
      const res = await request(app)
        .post(agentsUrl())
        .send({
          name: 'Bob',
          role: 'cto',
          title: 'Chief Technology Officer',
          provider: 'openai',
          model: 'gpt-4o',
          status: 'idle',
          capabilities: ['code-review', 'architecture'],
          systemPrompt: 'You are a CTO assistant.',
          budgetMonthlyCents: 20000,
          config: { priority: 'high' },
          metadata: { team: 'leadership' },
          permissions: ['admin', 'deploy'],
          instructions: '# Instructions\nReview all PRs.',
          instructionsFormat: 'markdown',
          temperature: 0.3,
          maxTokens: 8192,
          toolsEnabled: ['code-search', 'file-edit'],
          allowedDomains: ['github.com'],
          maxConcurrentTasks: 3,
          heartbeatIntervalSeconds: 120,
          autoAssignTasks: 1,
        })
        .expect(201);

      expect(res.body.data.name).toBe('Bob');
      expect(res.body.data.role).toBe('cto');
      expect(res.body.data.title).toBe('Chief Technology Officer');
      expect(res.body.data.provider).toBe('openai');
      expect(res.body.data.model).toBe('gpt-4o');
      expect(res.body.data.budgetMonthlyCents).toBe(20000);
      expect(res.body.data.temperature).toBeCloseTo(0.3);
      expect(res.body.data.maxTokens).toBe(8192);
      expect(res.body.data.instructions).toBe('# Instructions\nReview all PRs.');
      expect(res.body.data.maxConcurrentTasks).toBe(3);
      expect(res.body.data.autoAssignTasks).toBe(1);
    });

    it('should normalize the ollama provider alias to local', async () => {
      const res = await request(app)
        .post(agentsUrl())
        .send({
          name: 'Local Agent',
          role: 'engineer',
          provider: 'ollama',
          model: 'gemma4',
        })
        .expect(201);

      expect(res.body.data.provider).toBe('local');
      expect(res.body.data.model).toBe('gemma4');
    });

    it('should reject invalid role', async () => {
      await request(app)
        .post(agentsUrl())
        .send({ name: 'Invalid', role: 'janitor' })
        .expect(400);
    });

    it('should reject missing name', async () => {
      await request(app)
        .post(agentsUrl())
        .send({ role: 'engineer' })
        .expect(400);
    });

    it('should reject temperature out of range', async () => {
      await request(app)
        .post(agentsUrl())
        .send({ name: 'Hot', role: 'engineer', temperature: 5.0 })
        .expect(400);
    });
  });

  // ---------------------------------------------------------------------------
  // GET - list agents
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/agents', () => {
    it('should return empty array when no agents exist', async () => {
      const res = await request(app).get(agentsUrl()).expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('should list all agents for a company', async () => {
      await request(app).post(agentsUrl()).send({ name: 'A1', role: 'engineer' });
      await request(app).post(agentsUrl()).send({ name: 'A2', role: 'designer' });

      const res = await request(app).get(agentsUrl()).expect(200);

      expect(res.body.data).toHaveLength(2);
    });
  });

  // ---------------------------------------------------------------------------
  // GET - get agent by id
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/agents/:id', () => {
    it('should get an agent by id', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Lookup', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app).get(agentUrl(id)).expect(200);

      expect(res.body.data.id).toBe(id);
      expect(res.body.data.name).toBe('Lookup');
    });

    it('should 404 for non-existent agent', async () => {
      const res = await request(app)
        .get(agentUrl('00000000-0000-0000-0000-000000000000'))
        .expect(404);

      expect(res.body.code).toBe('AGENT_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // PATCH - update agent (with revision tracking)
  // ---------------------------------------------------------------------------

  describe('PATCH /api/companies/:companyId/agents/:id', () => {
    it('should update agent fields', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Before', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(agentUrl(id))
        .send({ name: 'After', temperature: 0.5 })
        .expect(200);

      expect(res.body.data.name).toBe('After');
      expect(res.body.data.temperature).toBeCloseTo(0.5);
    });

    it('should create a config revision on update', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Rev Agent', role: 'engineer', temperature: 0.7 });
      const id = created.body.data.id;

      // Update the agent
      await request(app)
        .patch(agentUrl(id))
        .send({ temperature: 0.9 })
        .expect(200);

      // Check revisions
      const revRes = await request(app)
        .get(`${agentUrl(id)}/revisions`)
        .expect(200);

      expect(revRes.body.data.length).toBeGreaterThanOrEqual(1);
      const revision = revRes.body.data[0];
      expect(revision.agentId).toBe(id);
      expect(revision.changedKeys).toContain('temperature');
    });

    it('should update agent status', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Status Agent', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(agentUrl(id))
        .send({ status: 'working' })
        .expect(200);

      expect(res.body.data.status).toBe('working');
    });

    it('should encrypt plaintext API keys before storing them', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Key Agent', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app)
        .patch(agentUrl(id))
        .send({ apiKeyEncrypted: 'sk-test-123' })
        .expect(200);

      expect(res.body.data.apiKeyEncrypted).not.toBe('sk-test-123');
      expect(decrypt(res.body.data.apiKeyEncrypted)).toBe('sk-test-123');
    });

    it('should 404 for non-existent agent', async () => {
      await request(app)
        .patch(agentUrl('00000000-0000-0000-0000-000000000000'))
        .send({ name: 'Ghost' })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE - terminate agent
  // ---------------------------------------------------------------------------

  describe('DELETE /api/companies/:companyId/agents/:id', () => {
    it('should set agent status to offline', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Terminate Me', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app).delete(agentUrl(id)).expect(200);

      expect(res.body.data.status).toBe('offline');
    });

    it('should 404 for non-existent agent', async () => {
      await request(app)
        .delete(agentUrl('00000000-0000-0000-0000-000000000000'))
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // POST - heartbeat
  // ---------------------------------------------------------------------------

  describe('POST /api/companies/:companyId/agents/:id/heartbeat', () => {
    it('should update heartbeat timestamp', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Heartbeat Agent', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app)
        .post(`${agentUrl(id)}/heartbeat`)
        .expect(200);

      expect(res.body.data.agentId).toBe(id);
      expect(res.body.data.heartbeatAt).toBeDefined();
    });

    it('should 404 for non-existent agent', async () => {
      await request(app)
        .post(`${agentUrl('00000000-0000-0000-0000-000000000000')}/heartbeat`)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // GET - agent metrics
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/agents/:id/metrics', () => {
    it('should return agent metrics', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Metrics Agent', role: 'engineer', budgetMonthlyCents: 10000 });
      const id = created.body.data.id;

      const res = await request(app)
        .get(`${agentUrl(id)}/metrics`)
        .expect(200);

      expect(res.body.data.agentId).toBe(id);
      expect(res.body.data.status).toBe('idle');
      expect(res.body.data.budget).toBeDefined();
      expect(res.body.data.budget.monthlyCents).toBe(10000);
      expect(res.body.data.budget.spentCents).toBe(0);
      expect(res.body.data.budget.remainingCents).toBe(10000);
      expect(res.body.data.budget.utilizationPct).toBe(0);
      expect(res.body.data.tasks).toBeDefined();
      expect(res.body.data.tasks.total).toBe(0);
    });

    it('should 404 for non-existent agent', async () => {
      await request(app)
        .get(`${agentUrl('00000000-0000-0000-0000-000000000000')}/metrics`)
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Instructions endpoints
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/agents/:id/instructions', () => {
    it('should return agent instructions', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({
          name: 'Instruction Agent',
          role: 'engineer',
          instructions: '# Do this\nFollow these steps.',
          instructionsFormat: 'markdown',
        });
      const id = created.body.data.id;

      const res = await request(app)
        .get(`${agentUrl(id)}/instructions`)
        .expect(200);

      expect(res.body.data.agentId).toBe(id);
      expect(res.body.data.instructions).toBe('# Do this\nFollow these steps.');
      expect(res.body.data.format).toBe('markdown');
    });

    it('should return null instructions for agent without them', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'No Instructions', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app)
        .get(`${agentUrl(id)}/instructions`)
        .expect(200);

      expect(res.body.data.instructions).toBeNull();
    });
  });

  describe('PUT /api/companies/:companyId/agents/:id/instructions', () => {
    it('should update agent instructions', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Update Instructions', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app)
        .put(`${agentUrl(id)}/instructions`)
        .send({ instructions: '# New Instructions', format: 'markdown' })
        .expect(200);

      expect(res.body.data.instructions).toBe('# New Instructions');
      expect(res.body.data.format).toBe('markdown');
    });

    it('should create a revision when instructions are updated', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Rev Instructions', role: 'engineer' });
      const id = created.body.data.id;

      await request(app)
        .put(`${agentUrl(id)}/instructions`)
        .send({ instructions: 'Updated text', format: 'markdown' })
        .expect(200);

      const revRes = await request(app)
        .get(`${agentUrl(id)}/revisions`)
        .expect(200);

      expect(revRes.body.data.length).toBeGreaterThanOrEqual(1);
      const changedKeys = revRes.body.data[0].changedKeys;
      expect(changedKeys).toContain('instructions');
      expect(changedKeys).toContain('instructionsFormat');
    });

    it('should 404 for non-existent agent', async () => {
      await request(app)
        .put(`${agentUrl('00000000-0000-0000-0000-000000000000')}/instructions`)
        .send({ instructions: 'nope', format: 'markdown' })
        .expect(404);
    });
  });

  // ---------------------------------------------------------------------------
  // Revisions endpoint
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/agents/:id/revisions', () => {
    it('should return empty array for agent with no revisions', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'No Revisions', role: 'engineer' });
      const id = created.body.data.id;

      const res = await request(app)
        .get(`${agentUrl(id)}/revisions`)
        .expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('should list multiple revisions in descending order', async () => {
      const created = await request(app)
        .post(agentsUrl())
        .send({ name: 'Multi Rev', role: 'engineer', temperature: 0.5 });
      const id = created.body.data.id;

      await request(app).patch(agentUrl(id)).send({ temperature: 0.6 }).expect(200);
      await request(app).patch(agentUrl(id)).send({ temperature: 0.7 }).expect(200);
      await request(app).patch(agentUrl(id)).send({ temperature: 0.8 }).expect(200);

      const res = await request(app)
        .get(`${agentUrl(id)}/revisions`)
        .expect(200);

      expect(res.body.data).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Org chart
  // ---------------------------------------------------------------------------

  describe('GET /api/companies/:companyId/org-chart', () => {
    it('should return empty array when no agents', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/org-chart`)
        .expect(200);

      expect(res.body.data).toEqual([]);
    });

    it('should build a tree structure from agents', async () => {
      // Create CEO (root)
      const ceoRes = await request(app)
        .post(agentsUrl())
        .send({ name: 'CEO', role: 'ceo' });
      const ceoId = ceoRes.body.data.id;

      // Create CTO reporting to CEO
      const ctoRes = await request(app)
        .post(agentsUrl())
        .send({ name: 'CTO', role: 'cto', reportsTo: ceoId });
      const ctoId = ctoRes.body.data.id;

      // Create Engineer reporting to CTO
      await request(app)
        .post(agentsUrl())
        .send({ name: 'Engineer', role: 'engineer', reportsTo: ctoId });

      const res = await request(app)
        .get(`/api/companies/${companyId}/org-chart`)
        .expect(200);

      // Should have one root (CEO)
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('CEO');
      expect(res.body.data[0].children).toHaveLength(1);
      expect(res.body.data[0].children[0].name).toBe('CTO');
      expect(res.body.data[0].children[0].children).toHaveLength(1);
      expect(res.body.data[0].children[0].children[0].name).toBe('Engineer');
    });
  });

  // ---------------------------------------------------------------------------
  // Executions
  // ---------------------------------------------------------------------------

  describe('Execution endpoints', () => {
    let agentId: string;

    beforeEach(async () => {
      const agentRes = await request(app)
        .post(agentsUrl())
        .send({ name: 'Exec Agent', role: 'engineer' });
      agentId = agentRes.body.data.id;
    });

    it('should create an execution', async () => {
      const res = await request(app)
        .post(`${agentUrl(agentId)}/executions`)
        .send({})
        .expect(201);

      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.agentId).toBe(agentId);
      expect(res.body.data.status).toBe('running');
      expect(res.body.data.livenessStatus).toBe('healthy');
      expect(res.body.data.startedAt).toBeDefined();
    });

    it('should list executions', async () => {
      await request(app).post(`${agentUrl(agentId)}/executions`).send({});
      await request(app).post(`${agentUrl(agentId)}/executions`).send({});

      const res = await request(app)
        .get(`${agentUrl(agentId)}/executions`)
        .expect(200);

      expect(res.body.data).toHaveLength(2);
    });

    it('should return executions in the UI-friendly summary shape', async () => {
      const execRes = await request(app)
        .post(`${agentUrl(agentId)}/executions`)
        .send({});
      const execId = execRes.body.data.id;

      await request(app)
        .patch(`${agentUrl(agentId)}/executions/${execId}`)
        .send({
          status: 'completed',
          inputTokens: 120,
          outputTokens: 30,
          summary: 'Generated homepage plan',
        })
        .expect(200);

      const res = await request(app)
        .get(`${agentUrl(agentId)}/executions`)
        .expect(200);

      expect(res.body.data[0].action).toBe('Generated homepage plan');
      expect(res.body.data[0].tokensUsed).toBe(150);
      expect(res.body.data[0].durationMs).toBeTypeOf('number');
      expect(res.body.data[0].startedAt).toBeTypeOf('string');
      expect(res.body.data[0].completedAt).toBeTypeOf('string');
    });

    it('should update an execution status to completed', async () => {
      const execRes = await request(app)
        .post(`${agentUrl(agentId)}/executions`)
        .send({});
      const execId = execRes.body.data.id;

      const res = await request(app)
        .patch(`${agentUrl(agentId)}/executions/${execId}`)
        .send({
          status: 'completed',
          inputTokens: 100,
          outputTokens: 200,
          costCents: 5,
          summary: 'Task completed successfully',
        })
        .expect(200);

      expect(res.body.data.status).toBe('completed');
      expect(res.body.data.inputTokens).toBe(100);
      expect(res.body.data.outputTokens).toBe(200);
      expect(res.body.data.costCents).toBe(5);
      expect(res.body.data.summary).toBe('Task completed successfully');
      expect(res.body.data.completedAt).toBeDefined();
    });

    it('should append log entries to execution', async () => {
      const execRes = await request(app)
        .post(`${agentUrl(agentId)}/executions`)
        .send({});
      const execId = execRes.body.data.id;

      const res = await request(app)
        .patch(`${agentUrl(agentId)}/executions/${execId}`)
        .send({
          logEntry: { level: 'info', message: 'Processing started' },
        })
        .expect(200);

      expect(res.body.data.log).toHaveLength(1);
      expect(res.body.data.log[0].level).toBe('info');
      expect(res.body.data.log[0].message).toBe('Processing started');
    });

    it('should update liveness and continuation metadata on executions', async () => {
      const execRes = await request(app)
        .post(`${agentUrl(agentId)}/executions`)
        .send({});
      const execId = execRes.body.data.id;

      const res = await request(app)
        .patch(`${agentUrl(agentId)}/executions/${execId}`)
        .send({
          livenessStatus: 'stalled',
          lastUsefulAction: 'tool_result_received',
          nextActionHint: 'continue_after_timeout',
          continuationAttempted: true,
        })
        .expect(200);

      expect(res.body.data.livenessStatus).toBe('stalled');
      expect(res.body.data.lastUsefulAction).toBe('tool_result_received');
      expect(res.body.data.nextActionHint).toBe('continue_after_timeout');
      expect(res.body.data.continuationAttempts).toBe(1);
      expect(res.body.data.lastContinuationAt).toBeDefined();
    });

    it('should persist structured transcript fields on log entries', async () => {
      const execRes = await request(app)
        .post(`${agentUrl(agentId)}/executions`)
        .send({});
      const execId = execRes.body.data.id;

      const res = await request(app)
        .patch(`${agentUrl(agentId)}/executions/${execId}`)
        .send({
          logEntry: {
            level: 'info',
            message: '[act] iteration 2: called search tool',
            phase: 'act',
            iteration: 2,
            content: 'Calling web_search to find the current time.',
            toolCalls: [
              {
                tool: 'web_search',
                serverId: 'srv-1',
                args: { query: 'current time in SF' },
                result: '2026-04-17T14:00:00Z',
              },
            ],
          },
        })
        .expect(200);

      const entry = res.body.data.log[0];
      expect(entry.phase).toBe('act');
      expect(entry.iteration).toBe(2);
      expect(entry.content).toBe(
        'Calling web_search to find the current time.',
      );
      expect(entry.toolCalls).toHaveLength(1);
      expect(entry.toolCalls[0].tool).toBe('web_search');
      expect(entry.toolCalls[0].args).toEqual({
        query: 'current time in SF',
      });
    });

    it('should reject log entries with an invalid phase', async () => {
      const execRes = await request(app)
        .post(`${agentUrl(agentId)}/executions`)
        .send({});
      const execId = execRes.body.data.id;

      await request(app)
        .patch(`${agentUrl(agentId)}/executions/${execId}`)
        .send({
          logEntry: {
            level: 'info',
            message: 'bogus phase',
            phase: 'meditate',
          },
        })
        .expect(400);
    });
  });
});
