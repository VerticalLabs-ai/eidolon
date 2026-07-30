import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('runtime workspace lease binding', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let agentId: string;
  let environmentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    const company = await request(app).post('/api/companies').send({ name: 'Runtime Lease Corp' }).expect(201);
    companyId = company.body.data.id;
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Runtime Lease Agent', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;
    const environment = await request(app)
      .post(`/api/companies/${companyId}/environments`)
      .send({ name: 'Runtime Lease Environment' })
      .expect(201);
    environmentId = environment.body.data.id;
  });

  async function createSession() {
    return request(app)
      .post(`/api/companies/${companyId}/sessions`)
      .send({ agentId, environmentId, adapterId: 'process:local', adapterConfig: { command: 'echo' } })
      .expect(201);
  }

  it('rejects a recovered lease at run time and protects the next lease from old finalization', async () => {
    const firstSession = await createSession();
    expect(firstSession.body.data.environmentLeaseId).toEqual(expect.any(String));

    await db.drizzle
      .update(db.schema.executionEnvironments)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(
        and(
          eq(db.schema.executionEnvironments.id, environmentId),
          eq(db.schema.executionEnvironments.leaseId, firstSession.body.data.environmentLeaseId),
        ),
      );
    await request(app)
      .post(`/api/companies/${companyId}/environments/${environmentId}/recover`)
      .expect(200);

    const run = await request(app)
      .post(`/api/companies/${companyId}/sessions/${firstSession.body.data.id}/run`)
      .send({ prompt: 'This must not start.' })
      .expect(400);
    expect(run.body.code).toBe('RUNTIME_SESSION_RUN_FAILED');
    expect(run.body.message).toContain('no longer active');

    const secondSession = await createSession();
    expect(secondSession.body.data.environmentLeaseId).not.toBe(firstSession.body.data.environmentLeaseId);
    await request(app)
      .post(`/api/companies/${companyId}/sessions/${firstSession.body.data.id}/finalize`)
      .expect(200);

    const [environment] = await db.drizzle
      .select()
      .from(db.schema.executionEnvironments)
      .where(eq(db.schema.executionEnvironments.id, environmentId));
    expect(environment).toEqual(expect.objectContaining({
      status: 'leased',
      leaseId: secondSession.body.data.environmentLeaseId,
    }));
  });
});
