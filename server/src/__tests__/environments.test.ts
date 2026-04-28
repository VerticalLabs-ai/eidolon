import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestDb, createTestApp } from '../test-utils.js';
import { workspaceRootForCompany } from '../routes/environments.js';

describe('Execution Environments API', () => {
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createTestApp(db);

    const res = await request(app)
      .post('/api/companies')
      .send({ name: 'Environment Test Corp' });
    companyId = res.body.data.id;
  });

  const environmentsUrl = () => `/api/companies/${companyId}/environments`;
  const agentsUrl = () => `/api/companies/${companyId}/agents`;

  async function createAgentAndEnvironment() {
    const agent = await request(app)
      .post(agentsUrl())
      .send({ name: 'Env Agent', role: 'engineer' })
      .expect(201);
    const environment = await request(app)
      .post(environmentsUrl())
      .send({ name: 'Local Lease Target' })
      .expect(201);

    return {
      agentId: agent.body.data.id as string,
      environmentId: environment.body.data.id as string,
    };
  }

  async function createExecution(agentId: string): Promise<string> {
    const execution = await request(app)
      .post(`${agentsUrl()}/${agentId}/executions`)
      .send({})
      .expect(201);
    return execution.body.data.id as string;
  }

  it('should create and list a local environment', async () => {
    const created = await request(app)
      .post(environmentsUrl())
      .send({
        name: 'Local Workspace',
        workspacePath: 'runtime/local-workspace',
        branchName: 'main',
        runtimeUrl: 'http://localhost:5173',
        metadata: { runtime: 'pnpm' },
      })
      .expect(201);

    expect(created.body.data.provider).toBe('local');
    expect(created.body.data.status).toBe('available');
    expect(created.body.data.workspacePath).toBe(
      `${workspaceRootForCompany(companyId)}/runtime/local-workspace`,
    );

    const listed = await request(app)
      .get(environmentsUrl())
      .expect(200);

    expect(listed.body.data).toEqual([
      expect.objectContaining({ id: created.body.data.id, name: 'Local Workspace' }),
    ]);
    expect(listed.body.meta).toEqual(expect.objectContaining({ total: 1, limit: 50, offset: 0 }));
  });

  it('should lease an environment to an agent', async () => {
    const { agentId, environmentId } = await createAgentAndEnvironment();
    const executionId = await createExecution(agentId);
    const leased = await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId, executionId })
      .expect(200);

    expect(leased.body.data.status).toBe('leased');
    expect(leased.body.data.leaseOwnerAgentId).toBe(agentId);
    expect(leased.body.data.leaseOwnerExecutionId).toBe(executionId);
  });

  it('should reject double-lease with 409', async () => {
    const { agentId, environmentId } = await createAgentAndEnvironment();
    const executionId = await createExecution(agentId);
    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId, executionId })
      .expect(200);
    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId, executionId })
      .expect(409);
  });

  it('should reject release by non-owner with 409', async () => {
    const { agentId, environmentId } = await createAgentAndEnvironment();
    const executionId = await createExecution(agentId);
    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId, executionId })
      .expect(200);
    const otherAgent = await request(app)
      .post(agentsUrl())
      .send({ name: 'Other Env Agent', role: 'engineer' })
      .expect(201);
    const otherExecutionId = await createExecution(otherAgent.body.data.id);
    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/release`)
      .send({ agentId: otherAgent.body.data.id, executionId: otherExecutionId })
      .expect(409);
  });

  it('should assign environment as agent default', async () => {
    const { agentId, environmentId } = await createAgentAndEnvironment();
    const assignedAgent = await request(app)
      .post(`${environmentsUrl()}/${environmentId}/assign`)
      .send({ agentId })
      .expect(200);

    expect(assignedAgent.body.data.agent.defaultEnvironmentId).toBe(environmentId);
    expect(assignedAgent.body.data.environment.id).toBe(environmentId);
  });

  it('should reject release without agentId or executionId', async () => {
    const { environmentId } = await createAgentAndEnvironment();
    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/release`)
      .send({})
      .expect(400);
  });

  it('should release environment successfully', async () => {
    const { agentId, environmentId } = await createAgentAndEnvironment();
    const executionId = await createExecution(agentId);
    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId, executionId })
      .expect(200);
    const released = await request(app)
      .post(`${environmentsUrl()}/${environmentId}/release`)
      .send({ agentId, executionId })
      .expect(200);

    expect(released.body.data.status).toBe('available');
    expect(released.body.data.leaseOwnerAgentId).toBeNull();
  });

  it('should support execution-based leasing', async () => {
    const { agentId, environmentId } = await createAgentAndEnvironment();
    const execution = await request(app)
      .post(`${agentsUrl()}/${agentId}/executions`)
      .send({})
      .expect(201);

    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId, executionId: execution.body.data.id })
      .expect(200);

    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/release`)
      .send({ agentId, executionId: '00000000-0000-0000-0000-000000000000' })
      .expect(409);

    const released = await request(app)
      .post(`${environmentsUrl()}/${environmentId}/release`)
      .send({ agentId, executionId: execution.body.data.id })
      .expect(200);
    expect(released.body.data.status).toBe('available');
  });

  it('should reject unsafe workspace paths outside the workspace root', async () => {
    await request(app)
      .post(environmentsUrl())
      .send({
        name: 'Escaping Workspace',
        workspacePath: '../outside-root',
      })
      .expect(400);

    await request(app)
      .post(environmentsUrl())
      .send({
        name: 'Absolute Outside Workspace',
        workspacePath: '/tmp/not-eidolon-workspace',
      })
      .expect(400);
  });

  it('should reject leases without execution ownership', async () => {
    const { agentId, environmentId } = await createAgentAndEnvironment();
    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId })
      .expect(400);

    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId, executionId: '00000000-0000-0000-0000-000000000000' })
      .expect(404);
  });
});
