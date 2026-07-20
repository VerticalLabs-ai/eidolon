import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createTestDb } from '../test-utils.js';
import {
  TaskCheckoutError,
  TaskCheckoutService,
  type TaskCheckoutInput,
} from '../services/task-checkout.js';
import type { DbInstance } from '../types.js';

describe('Task checkout protocol', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  async function insertCompany() {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.companies).values({
      id,
      name: 'Checkout Corp',
      status: 'active',
      budgetMonthlyCents: 100_000_000,
      spentMonthlyCents: 0,
      settings: {},
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function insertAgent(name: string) {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.agents).values({
      id,
      companyId,
      name,
      role: 'engineer',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      status: 'idle',
      capabilities: [],
      config: {},
      metadata: {},
      permissions: [],
      toolsEnabled: [],
      allowedDomains: [],
      maxConcurrentTasks: 1,
      heartbeatIntervalSeconds: 0,
      executionTimeoutSeconds: 600,
      autoAssignTasks: 1,
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function insertTask(assigneeAgentId: string | null = null) {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.tasks).values({
      id,
      companyId,
      title: 'Claim atomically',
      type: 'feature',
      status: 'todo',
      priority: 'high',
      assigneeAgentId,
      dependencies: [],
      tags: [],
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  async function insertExecution(agentId: string, taskId: string) {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.agentExecutions).values({
      id,
      companyId,
      agentId,
      taskId,
      status: 'running',
      startedAt: now,
      executionMode: 'single',
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  function input(
    taskId: string,
    agentId: string,
    executionId: string,
    idempotencyKey: string = randomUUID(),
  ): TaskCheckoutInput {
    return {
      companyId,
      taskId,
      agentId,
      executionId,
      source: 'api',
      idempotencyKey,
    };
  }

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await insertCompany();
  });

  it('allows exactly one execution to win a concurrent checkout', async () => {
    const taskId = await insertTask();
    const agentA = await insertAgent('A');
    const agentB = await insertAgent('B');
    const executionA = await insertExecution(agentA, taskId);
    const executionB = await insertExecution(agentB, taskId);
    const service = new TaskCheckoutService(db);

    const results = await Promise.allSettled([
      service.checkout(input(taskId, agentA, executionA)),
      service.checkout(input(taskId, agentB, executionB)),
    ]);

    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.checkout>>> =>
        result.status === 'fulfilled',
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(TaskCheckoutError);
    expect(rejected[0].reason).toMatchObject({
      status: 409,
      code: 'TASK_CHECKOUT_CONFLICT',
    });

    const [checkout] = await db.drizzle.select().from(db.schema.taskCheckouts);
    expect(checkout).toMatchObject({
      taskId,
      status: 'active',
      agentId: fulfilled[0].value.checkout.agentId,
      executionId: fulfilled[0].value.checkout.executionId,
    });

    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));
    expect(task).toMatchObject({
      status: 'in_progress',
      assigneeAgentId: checkout.agentId,
    });
    expect(task.startedAt).toBeInstanceOf(Date);

    const threadItems = await db.drizzle
      .select()
      .from(db.schema.taskThreadItems)
      .where(
        and(
          eq(db.schema.taskThreadItems.taskId, taskId),
          eq(db.schema.taskThreadItems.kind, 'execution_event'),
        ),
      );
    expect(threadItems).toHaveLength(1);
    expect(threadItems[0]).toMatchObject({
      authorAgentId: checkout.agentId,
      relatedExecutionId: checkout.executionId,
      status: 'linked',
    });

    const agents = await db.drizzle.select().from(db.schema.agents);
    expect(agents.find((agent) => agent.id === checkout.agentId)?.status).toBe('working');
    expect(
      agents.find((agent) => agent.id !== checkout.agentId)?.status,
    ).toBe('idle');
  });

  it('replays the same checkout idempotently without duplicate evidence', async () => {
    const agentId = await insertAgent('A');
    const taskId = await insertTask(agentId);
    const executionId = await insertExecution(agentId, taskId);
    const checkoutInput = input(taskId, agentId, executionId, 'same-checkout');
    const service = new TaskCheckoutService(db);

    const concurrent = await Promise.all([
      service.checkout(checkoutInput),
      service.checkout(checkoutInput),
    ]);
    const first = concurrent.find((result) => !result.replayed)!;
    const concurrentReplay = concurrent.find((result) => result.replayed)!;
    expect(concurrentReplay.checkout.id).toBe(first.checkout.id);
    expect(concurrentReplay.task.status).toBe('in_progress');

    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(db.schema.agentExecutions.id, executionId));
    const replay = await service.checkout(checkoutInput);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.checkout.id).toBe(first.checkout.id);

    const checkouts = await db.drizzle.select().from(db.schema.taskCheckouts);
    const threadItems = await db.drizzle
      .select()
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.taskId, taskId));
    expect(checkouts).toHaveLength(1);
    expect(threadItems).toHaveLength(1);
  });

  it('rejects an execution whose task and agent identity do not match', async () => {
    const taskId = await insertTask();
    const otherTaskId = await insertTask();
    const agentId = await insertAgent('A');
    const otherAgentId = await insertAgent('B');
    const executionId = await insertExecution(otherAgentId, otherTaskId);
    const service = new TaskCheckoutService(db);

    await expect(
      service.checkout(input(taskId, agentId, executionId)),
    ).rejects.toMatchObject({
      status: 400,
      code: 'TASK_CHECKOUT_IDENTITY_MISMATCH',
    });

    expect(await db.drizzle.select().from(db.schema.taskCheckouts)).toHaveLength(0);
    expect(await db.drizzle.select().from(db.schema.taskThreadItems)).toHaveLength(0);
  });

  it('rejects a terminal execution before it can check out work', async () => {
    const agentId = await insertAgent('A');
    const taskId = await insertTask(agentId);
    const executionId = await insertExecution(agentId, taskId);
    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({ status: 'failed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(db.schema.agentExecutions.id, executionId));
    const service = new TaskCheckoutService(db);

    await expect(
      service.checkout(input(taskId, agentId, executionId)),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TASK_CHECKOUT_EXECUTION_NOT_RUNNING',
    });

    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));
    const [agent] = await db.drizzle
      .select()
      .from(db.schema.agents)
      .where(eq(db.schema.agents.id, agentId));
    expect(task).toMatchObject({ status: 'todo', startedAt: null });
    expect(agent.status).toBe('idle');
    expect(await db.drizzle.select().from(db.schema.taskCheckouts)).toHaveLength(0);
  });

  it('exposes stable 201, replay 200, and conflict 409 API semantics', async () => {
    const taskId = await insertTask();
    const agentA = await insertAgent('A');
    const agentB = await insertAgent('B');
    const executionA = await insertExecution(agentA, taskId);
    const executionB = await insertExecution(agentB, taskId);
    const url = `/api/companies/${companyId}/tasks/${taskId}/checkout`;
    const bodyA = {
      agentId: agentA,
      executionId: executionA,
      idempotencyKey: 'api-checkout-a',
    };

    const first = await request(app).post(url).send(bodyA).expect(201);
    expect(first.body.data).toMatchObject({
      replayed: false,
      checkout: {
        taskId,
        agentId: agentA,
        executionId: executionA,
        status: 'active',
      },
      task: {
        status: 'in_progress',
        assigneeAgentId: agentA,
      },
    });

    const replay = await request(app).post(url).send(bodyA).expect(200);
    expect(replay.body.data).toMatchObject({
      replayed: true,
      checkout: { id: first.body.data.checkout.id },
    });

    const reassignment = await request(app)
      .post(`/api/companies/${companyId}/tasks/${taskId}/assign`)
      .send({ agentId: agentB })
      .expect(409);
    expect(reassignment.body.code).toBe('TASK_ASSIGNMENT_CONFLICT');

    const conflict = await request(app)
      .post(url)
      .send({
        agentId: agentB,
        executionId: executionB,
        idempotencyKey: 'api-checkout-b',
      })
      .expect(409);
    expect(conflict.body).toMatchObject({
      code: 'TASK_CHECKOUT_CONFLICT',
      details: {
        taskId,
        activeAgentId: agentA,
        activeExecutionId: executionA,
      },
    });
  });
});
