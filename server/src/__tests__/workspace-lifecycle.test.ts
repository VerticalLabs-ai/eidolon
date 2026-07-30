import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';
import {
  deriveWorkspaceLeaseState,
  leaseWorkspace,
  recoverWorkspaceLease,
  releaseWorkspaceLease,
  renewWorkspaceLease,
} from '../services/workspace-lifecycle.js';

describe('managed workspace lifecycle', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let companyId: string;
  let agentId: string;
  let executionId: string;
  let environmentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    const app = createTestApp(db);
    const company = await request(app).post('/api/companies').send({ name: 'Lifecycle Corp' }).expect(201);
    companyId = company.body.data.id;
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Lifecycle Agent', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;
    const execution = await request(app)
      .post(`/api/companies/${companyId}/agents/${agentId}/executions`)
      .send({})
      .expect(201);
    executionId = execution.body.data.id;
    const environment = await request(app)
      .post(`/api/companies/${companyId}/environments`)
      .send({ name: 'Lifecycle Workspace' })
      .expect(201);
    environmentId = environment.body.data.id;
  });

  it('leases exactly once and records the transition', async () => {
    const now = new Date('2026-07-30T12:00:00.000Z');
    const [first, second] = await Promise.allSettled([
      leaseWorkspace(db, { companyId, environmentId, agentId, executionId, baseSha: 'abc123', now }),
      leaseWorkspace(db, { companyId, environmentId, agentId, executionId, baseSha: 'abc123', now }),
    ]);

    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected']);
    const leased = first.status === 'fulfilled' ? first.value : (second as PromiseFulfilledResult<any>).value;
    expect(leased.leaseId).toEqual(expect.any(String));
    expect(deriveWorkspaceLeaseState(leased, now)).toBe('active');

    const events = await db.drizzle
      .select()
      .from(db.schema.workspaceLifecycleEvents)
      .where(eq(db.schema.workspaceLifecycleEvents.environmentId, environmentId));
    expect(events).toHaveLength(2);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: 'created' }),
      expect.objectContaining({ eventType: 'leased', leaseId: leased.leaseId }),
    ]));
  });

  it('renews only the exact active lease', async () => {
    const leasedAt = new Date('2026-07-30T12:00:00.000Z');
    const leased = await leaseWorkspace(db, {
      companyId,
      environmentId,
      agentId,
      executionId,
      baseSha: null,
      now: leasedAt,
    });
    const renewedAt = new Date(leasedAt.getTime() + 5_000);
    const renewed = await renewWorkspaceLease(db, {
      companyId,
      environmentId,
      agentId,
      executionId,
      leaseId: leased.leaseId!,
      now: renewedAt,
    });

    expect(renewed.leaseHeartbeatAt).toEqual(renewedAt);
    expect(renewed.leaseExpiresAt!.getTime()).toBeGreaterThan(leased.leaseExpiresAt!.getTime());
    await expect(renewWorkspaceLease(db, {
      companyId,
      environmentId,
      agentId,
      executionId,
      leaseId: 'stale-token',
      now: renewedAt,
    })).rejects.toMatchObject({ code: 'WORKSPACE_LEASE_EXPIRED' });
  });

  it('rejects early recovery and atomically recovers a stale lease', async () => {
    const leasedAt = new Date('2026-07-30T12:00:00.000Z');
    const leased = await leaseWorkspace(db, {
      companyId,
      environmentId,
      agentId,
      executionId,
      baseSha: null,
      now: leasedAt,
    });
    await expect(recoverWorkspaceLease(db, {
      companyId,
      environmentId,
      now: new Date(leasedAt.getTime() + 1_000),
    })).rejects.toMatchObject({ code: 'WORKSPACE_LEASE_NOT_STALE' });

    const recovered = await recoverWorkspaceLease(db, {
      companyId,
      environmentId,
      now: new Date(leased.leaseExpiresAt!.getTime() + 1),
    });
    expect(recovered).toEqual(expect.objectContaining({ status: 'available', leaseId: null }));

    const [execution] = await db.drizzle
      .select({ environmentId: db.schema.agentExecutions.environmentId })
      .from(db.schema.agentExecutions)
      .where(
        and(
          eq(db.schema.agentExecutions.id, executionId),
          eq(db.schema.agentExecutions.companyId, companyId),
        ),
      );
    expect(execution.environmentId).toBeNull();

    const events = await db.drizzle
      .select({ type: db.schema.workspaceLifecycleEvents.eventType })
      .from(db.schema.workspaceLifecycleEvents)
      .where(eq(db.schema.workspaceLifecycleEvents.environmentId, environmentId));
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'created',
      'leased',
      'recovered',
    ]));
    expect(events).toHaveLength(3);
  });

  it('prevents an old token from releasing a newer lease', async () => {
    const first = await leaseWorkspace(db, {
      companyId,
      environmentId,
      agentId,
      executionId,
      baseSha: null,
    });
    await releaseWorkspaceLease(db, {
      companyId,
      environmentId,
      agentId,
      executionId,
      leaseId: first.leaseId!,
    });
    const second = await leaseWorkspace(db, {
      companyId,
      environmentId,
      agentId,
      executionId,
      baseSha: null,
    });

    await expect(releaseWorkspaceLease(db, {
      companyId,
      environmentId,
      agentId,
      executionId,
      leaseId: first.leaseId!,
    })).rejects.toMatchObject({ code: 'WORKSPACE_LEASE_CONFLICT' });
    expect(second.leaseId).not.toBe(first.leaseId);
  });
});
