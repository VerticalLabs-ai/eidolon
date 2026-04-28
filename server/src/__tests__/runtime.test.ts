import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

describe('Runtime snapshot API', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: DbInstance;
  let companyId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'Runtime Test Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Runtime Agent', role: 'engineer' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  const runtimeUrl = () => `/api/companies/${companyId}/runtime/state`;

  type TaskInsert = typeof db.schema.tasks.$inferInsert;
  type ExecutionInsert = typeof db.schema.agentExecutions.$inferInsert;
  type EnvironmentInsert = typeof db.schema.executionEnvironments.$inferInsert;

  function makeTask(now: Date, overrides: Partial<TaskInsert>): TaskInsert {
    const id = overrides.id ?? randomUUID();

    return {
      id,
      companyId,
      title: 'Runtime task',
      type: 'feature',
      status: 'todo',
      priority: 'medium',
      dependencies: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function makeExecution(now: Date, overrides: Partial<ExecutionInsert>): ExecutionInsert {
    return {
      id: randomUUID(),
      companyId,
      agentId,
      status: 'running',
      startedAt: now,
      log: [],
      createdAt: now,
      ...overrides,
    };
  }

  function makeEnvironment(now: Date, overrides: Partial<EnvironmentInsert>): EnvironmentInsert {
    return {
      id: randomUUID(),
      companyId,
      name: 'Runtime Lease',
      provider: 'local',
      status: 'available',
      metadata: {},
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it('returns an empty no-active-runtime snapshot', async () => {
    const res = await request(app).get(runtimeUrl()).expect(200);

    expect(res.body.data.counts).toEqual({
      running: 0,
      retrying: 0,
      recoveryTasks: 0,
      recentErrors: 0,
      environmentLeases: 0,
    });
    expect(res.body.data.running).toEqual([]);
    expect(res.body.data.retrying).toEqual([]);
    expect(res.body.data.totals.executions).toBe(0);
  });

  it('includes running, retrying, recovery tasks, totals, errors, and leases', async () => {
    const now = new Date();
    const taskId = randomUUID();
    const recoveryTaskId = randomUUID();
    const runningExecutionId = randomUUID();
    const retryExecutionId = randomUUID();
    const environmentId = randomUUID();
    const secondEnvironmentId = randomUUID();

    await db.drizzle.insert(db.schema.tasks).values([
      makeTask(now, {
        id: taskId,
        title: 'Runtime task',
        status: 'in_progress',
        priority: 'high',
        assigneeAgentId: agentId,
      }),
      makeTask(now, {
        id: recoveryTaskId,
        parentId: taskId,
        title: 'Recover stalled execution',
        type: 'chore',
        priority: 'high',
        assigneeAgentId: agentId,
        dependencies: [taskId],
        tags: ['recovery', 'liveness'],
      }),
    ]);

    await db.drizzle.insert(db.schema.agentExecutions).values([
      makeExecution(now, {
        id: runningExecutionId,
        taskId,
        inputTokens: 100,
        outputTokens: 40,
        costCents: 12,
        livenessStatus: 'recovering',
        retryAttempt: 1,
        retryStatus: 'scheduled',
        retryDueAt: new Date(now.getTime() + 10_000),
        failureCategory: 'execution_stalled',
        lastEventAt: now,
        executionMode: 'agentic-loop',
        recoveryTaskId,
      }),
      makeExecution(now, {
        id: retryExecutionId,
        taskId,
        status: 'failed',
        completedAt: now,
        inputTokens: 10,
        outputTokens: 5,
        costCents: 3,
        error: 'provider failed',
        retryAttempt: 2,
        retryStatus: 'scheduled',
        retryDueAt: new Date(now.getTime() + 20_000),
        failureCategory: 'provider_error',
        lastEventAt: now,
      }),
    ]);

    await db.drizzle.insert(db.schema.executionEnvironments).values([
      makeEnvironment(now, {
        id: environmentId,
        name: 'Runtime Lease 1',
        status: 'leased',
        workspacePath: '/tmp/eidolon-runtime-test',
        leaseOwnerAgentId: agentId,
        leaseOwnerExecutionId: runningExecutionId,
        leasedAt: now,
      }),
      makeEnvironment(now, {
        id: secondEnvironmentId,
        name: 'Runtime Lease 2',
        status: 'leased',
        workspacePath: '/tmp/eidolon-runtime-test-2',
        leaseOwnerAgentId: agentId,
        leaseOwnerExecutionId: retryExecutionId,
        leasedAt: new Date(now.getTime() - 1_000),
      }),
    ]);

    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({ environmentId })
      .where(eq(db.schema.agentExecutions.id, runningExecutionId));

    const res = await request(app).get(runtimeUrl()).expect(200);
    const snapshot = res.body.data;

    expect(snapshot.counts).toEqual({
      running: 1,
      retrying: 2,
      recoveryTasks: 1,
      recentErrors: 1,
      environmentLeases: 2,
    });
    expect(snapshot.running[0]).toEqual(expect.objectContaining({
      executionId: runningExecutionId,
      executionMode: 'agentic-loop',
      environmentId,
    }));
    expect(snapshot.retrying.map((row: any) => row.executionId)).toEqual([
      runningExecutionId,
      retryExecutionId,
    ]);
    expect(snapshot.retrying[0]).toEqual(expect.objectContaining({
      agentName: 'Runtime Agent',
      taskTitle: 'Runtime task',
    }));
    expect(snapshot.recoveryTasks[0]).toEqual(expect.objectContaining({
      id: recoveryTaskId,
      title: 'Recover stalled execution',
    }));
    expect(snapshot.pagination.recoveryTasks.total).toBe(1);
    expect(snapshot.totals).toEqual(expect.objectContaining({
      inputTokens: 110,
      outputTokens: 45,
      totalTokens: 155,
      costCents: 15,
      executions: 2,
    }));
    expect(snapshot.recentErrors[0]).toEqual(expect.objectContaining({
      executionId: retryExecutionId,
      failureCategory: 'provider_error',
    }));
    expect(snapshot.environmentLeases).toHaveLength(2);
    expect(snapshot.environmentLeases[0]).toEqual(expect.objectContaining({
      id: environmentId,
      leaseOwnerExecutionId: runningExecutionId,
    }));
    expect(snapshot.pagination.environmentLeases.total).toBe(2);

    const pagedPastEnd = await request(app)
      .get(`${runtimeUrl()}?runningLimit=1&runningOffset=5&retryingLimit=1&retryingOffset=5&recoveryLimit=1&recoveryOffset=5&recentErrorsLimit=1&recentErrorsOffset=5&environmentLeaseLimit=1&environmentLeaseOffset=5`)
      .expect(200);
    expect(pagedPastEnd.body.data.running).toEqual([]);
    expect(pagedPastEnd.body.data.retrying).toEqual([]);
    expect(pagedPastEnd.body.data.recoveryTasks).toEqual([]);
    expect(pagedPastEnd.body.data.recentErrors).toEqual([]);
    expect(pagedPastEnd.body.data.environmentLeases).toEqual([]);
    expect(pagedPastEnd.body.data.pagination.running.total).toBe(1);
    expect(pagedPastEnd.body.data.pagination.retrying.total).toBe(2);
    expect(pagedPastEnd.body.data.pagination.recoveryTasks.total).toBe(1);
    expect(pagedPastEnd.body.data.pagination.recentErrors.total).toBe(1);
    expect(pagedPastEnd.body.data.pagination.environmentLeases.total).toBe(2);
  });
});
