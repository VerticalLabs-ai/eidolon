import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestDb, createTestApp } from '../test-utils.js';

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

  it('should create and list a local environment', async () => {
    const created = await request(app)
      .post(environmentsUrl())
      .send({
        name: 'Local Workspace',
        workspacePath: '/Users/mgunnin/Developer/06_Projects/Eidolon',
        branchName: 'main',
        runtimeUrl: 'http://localhost:5173',
        metadata: { runtime: 'pnpm' },
      })
      .expect(201);

    expect(created.body.data.provider).toBe('local');
    expect(created.body.data.status).toBe('available');
    expect(created.body.data.workspacePath).toContain('/Eidolon');

    const listed = await request(app)
      .get(environmentsUrl())
      .expect(200);

    expect(listed.body.data).toEqual([
      expect.objectContaining({ id: created.body.data.id, name: 'Local Workspace' }),
    ]);
  });

  it('should lease, reject double-lease, release, and assign an environment to an agent', async () => {
    const agent = await request(app)
      .post(agentsUrl())
      .send({ name: 'Env Agent', role: 'engineer' })
      .expect(201);
    const agentId = agent.body.data.id;

    const environment = await request(app)
      .post(environmentsUrl())
      .send({ name: 'Local Lease Target' })
      .expect(201);
    const environmentId = environment.body.data.id;

    const leased = await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId })
      .expect(200);
    expect(leased.body.data.status).toBe('leased');
    expect(leased.body.data.leaseOwnerAgentId).toBe(agentId);

    await request(app)
      .post(`${environmentsUrl()}/${environmentId}/lease`)
      .send({ agentId })
      .expect(409);

    const assignedAgent = await request(app)
      .post(`${environmentsUrl()}/${environmentId}/assign`)
      .send({ agentId })
      .expect(200);
    expect(assignedAgent.body.data.defaultEnvironmentId).toBe(environmentId);

    const released = await request(app)
      .post(`${environmentsUrl()}/${environmentId}/release`)
      .expect(200);
    expect(released.body.data.status).toBe('available');
    expect(released.body.data.leaseOwnerAgentId).toBeNull();
  });
});
