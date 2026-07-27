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
import { CollaborationService } from '../services/collaboration.js';
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

  async function insertAgent(name: string, maxConcurrentTasks = 1) {
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
      maxConcurrentTasks,
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

  async function insertTask(
    assigneeAgentId: string | null = null,
    dependencies: string[] = [],
  ) {
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
      dependencies,
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

    await expect(service.checkout(checkoutInput)).rejects.toMatchObject({
      status: 409,
      code: 'TASK_CHECKOUT_RELEASED',
      details: {
        checkoutId: first.checkout.id,
        checkoutStatus: 'released',
      },
    });

    const checkouts = await db.drizzle.select().from(db.schema.taskCheckouts);
    const threadItems = await db.drizzle
      .select()
      .from(db.schema.taskThreadItems)
      .where(eq(db.schema.taskThreadItems.taskId, taskId));
    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));
    expect(first.replayed).toBe(false);
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0]).toMatchObject({ status: 'released' });
    expect(threadItems).toHaveLength(2);
    expect(task.status).toBe('review');
  });

  it('rejects paused tasks and incomplete dependencies at checkout', async () => {
    const dependencyId = await insertTask();
    const agentId = await insertAgent('A');
    const taskId = await insertTask(agentId, [dependencyId]);
    const executionId = await insertExecution(agentId, taskId);
    const service = new TaskCheckoutService(db);
    const now = new Date();

    await db.drizzle.insert(db.schema.taskHolds).values({
      id: randomUUID(),
      companyId,
      taskId,
      action: 'pause',
      status: 'active',
      previousStatus: 'todo',
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      service.checkout(input(taskId, agentId, executionId, 'paused-checkout')),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TASK_CHECKOUT_PAUSED',
    });

    await db.drizzle
      .update(db.schema.taskHolds)
      .set({ status: 'restored', resolvedAt: now, updatedAt: now })
      .where(eq(db.schema.taskHolds.taskId, taskId));

    await expect(
      service.checkout(input(taskId, agentId, executionId, 'blocked-checkout')),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TASK_CHECKOUT_DEPENDENCIES_BLOCKED',
      details: { blockedBy: [dependencyId] },
    });

    await db.drizzle
      .update(db.schema.tasks)
      .set({ status: 'done', completedAt: now, updatedAt: now })
      .where(eq(db.schema.tasks.id, dependencyId));

    await expect(
      service.checkout(input(taskId, agentId, executionId, 'ready-checkout')),
    ).resolves.toMatchObject({ replayed: false });
  });

  it('serializes checkout with reopening a completed dependency', async () => {
    const dependencyId = await insertTask();
    await db.drizzle
      .update(db.schema.tasks)
      .set({ status: 'done', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(db.schema.tasks.id, dependencyId));
    const agentId = await insertAgent('A');
    const taskId = await insertTask(agentId, [dependencyId]);
    const executionId = await insertExecution(agentId, taskId);
    const service = new TaskCheckoutService(db);

    const outcomes = await Promise.allSettled([
      service.checkout(input(taskId, agentId, executionId, 'dependency-race')),
      db.drizzle
        .update(db.schema.tasks)
        .set({ status: 'todo', completedAt: null, updatedAt: new Date() })
        .where(eq(db.schema.tasks.id, dependencyId)),
    ]);

    const [dependency] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, dependencyId));
    const activeCheckouts = await db.drizzle
      .select()
      .from(db.schema.taskCheckouts)
      .where(eq(db.schema.taskCheckouts.status, 'active'));

    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(activeCheckouts.length === 0 || dependency.status === 'done').toBe(true);
  });

  it('serializes checkout with execution termination', async () => {
    const agentId = await insertAgent('A');
    const taskId = await insertTask(agentId);
    const executionId = await insertExecution(agentId, taskId);
    const service = new TaskCheckoutService(db);
    const completedAt = new Date();

    await Promise.allSettled([
      service.checkout(input(taskId, agentId, executionId, 'racing-checkout')),
      db.drizzle
        .update(db.schema.agentExecutions)
        .set({ status: 'completed', completedAt, updatedAt: completedAt })
        .where(eq(db.schema.agentExecutions.id, executionId)),
    ]);

    const activeCheckouts = await db.drizzle
      .select()
      .from(db.schema.taskCheckouts)
      .where(eq(db.schema.taskCheckouts.status, 'active'));
    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));

    expect(activeCheckouts).toHaveLength(0);
    expect(task.status).not.toBe('in_progress');
  });

  it('does not let a stale execution release a newer checkout', async () => {
    const taskId = await insertTask();
    const agentId = await insertAgent('A');
    const firstExecutionId = await insertExecution(agentId, taskId);
    const service = new TaskCheckoutService(db);

    await service.checkout(input(taskId, agentId, firstExecutionId, 'first-owner'));
    await service.release({
      companyId,
      taskId,
      agentId,
      executionId: firstExecutionId,
      reason: 'Yielding the task',
    });

    const secondExecutionId = await insertExecution(agentId, taskId);
    const secondCheckout = await service.checkout(
      input(taskId, agentId, secondExecutionId, 'second-owner'),
    );

    await db.drizzle
      .update(db.schema.agentExecutions)
      .set({ status: 'failed', completedAt: new Date(), updatedAt: new Date() })
      .where(eq(db.schema.agentExecutions.id, firstExecutionId));

    const [activeCheckout] = await db.drizzle
      .select()
      .from(db.schema.taskCheckouts)
      .where(eq(db.schema.taskCheckouts.status, 'active'));
    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));

    expect(activeCheckout).toMatchObject({
      id: secondCheckout.checkout.id,
      executionId: secondExecutionId,
    });
    expect(task).toMatchObject({ status: 'in_progress', assigneeAgentId: agentId });
  });

  it('releases checkout ownership explicitly and idempotently', async () => {
    const taskId = await insertTask();
    const agentA = await insertAgent('A');
    const agentB = await insertAgent('B');
    const executionId = await insertExecution(agentA, taskId);
    const checkout = await new TaskCheckoutService(db).checkout(
      input(taskId, agentA, executionId, 'release-checkout'),
    );
    const url = `/api/companies/${companyId}/tasks/${taskId}/release`;

    const conflict = await request(app)
      .post(url)
      .send({
        agentId: agentB,
        executionId,
        reason: 'Wrong owner',
      })
      .expect(409);
    expect(conflict.body.code).toBe('TASK_CHECKOUT_CONFLICT');

    const released = await request(app)
      .post(url)
      .send({
        agentId: agentA,
        executionId,
        reason: 'Yielding the task',
      })
      .expect(201);
    expect(released.body.data).toMatchObject({
      replayed: false,
      checkout: { id: checkout.checkout.id, status: 'released' },
      task: { status: 'todo', startedAt: null, completedAt: null },
      threadItem: { relatedExecutionId: executionId },
    });
    const [cancelledExecution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, executionId));
    expect(cancelledExecution).toMatchObject({ status: 'cancelled' });

    const replay = await request(app)
      .post(url)
      .send({
        agentId: agentA,
        executionId,
        reason: 'Yielding the task',
      })
      .expect(200);
    expect(replay.body.data).toMatchObject({
      replayed: true,
      checkout: { id: checkout.checkout.id, status: 'released' },
    });

    const mismatchedReplay = await request(app)
      .post(url)
      .send({
        agentId: agentA,
        executionId,
        reason: 'A different release request',
      })
      .expect(409);
    expect(mismatchedReplay.body).toMatchObject({
      code: 'TASK_CHECKOUT_CONFLICT',
      details: { conflictReason: 'release_request_mismatch' },
    });
  });

  it('keeps an agent working until its final active checkout is released', async () => {
    const agentId = await insertAgent('Parallel agent', 2);
    const firstTaskId = await insertTask(agentId);
    const secondTaskId = await insertTask(agentId);
    const firstExecutionId = await insertExecution(agentId, firstTaskId);
    const secondExecutionId = await insertExecution(agentId, secondTaskId);
    const service = new TaskCheckoutService(db);

    await service.checkout(input(firstTaskId, agentId, firstExecutionId, 'parallel-first'));
    await service.checkout(input(secondTaskId, agentId, secondExecutionId, 'parallel-second'));

    await service.release({
      companyId,
      taskId: firstTaskId,
      agentId,
      executionId: firstExecutionId,
      reason: 'First task released',
    });

    let [agent] = await db.drizzle
      .select()
      .from(db.schema.agents)
      .where(eq(db.schema.agents.id, agentId));
    expect(agent.status).toBe('working');

    await service.release({
      companyId,
      taskId: secondTaskId,
      agentId,
      executionId: secondExecutionId,
      reason: 'Second task released',
    });

    [agent] = await db.drizzle
      .select()
      .from(db.schema.agents)
      .where(eq(db.schema.agents.id, agentId));
    expect(agent.status).toBe('idle');
  });

  it('releases checkout and execution ownership when work is escalated', async () => {
    const managerId = await insertAgent('Manager');
    const agentId = await insertAgent('Blocked agent');
    await db.drizzle
      .update(db.schema.agents)
      .set({ reportsTo: managerId, updatedAt: new Date() })
      .where(eq(db.schema.agents.id, agentId));
    const taskId = await insertTask(agentId);
    const executionId = await insertExecution(agentId, taskId);
    await new TaskCheckoutService(db).checkout(
      input(taskId, agentId, executionId, 'escalated-checkout'),
    );

    await new CollaborationService(db).escalate(
      agentId,
      taskId,
      companyId,
      'Waiting on an operator decision',
    );

    const [[checkout], [execution], [task], [agent], [hold]] = await Promise.all([
      db.drizzle
        .select()
        .from(db.schema.taskCheckouts)
        .where(eq(db.schema.taskCheckouts.executionId, executionId)),
      db.drizzle
        .select()
        .from(db.schema.agentExecutions)
        .where(eq(db.schema.agentExecutions.id, executionId)),
      db.drizzle.select().from(db.schema.tasks).where(eq(db.schema.tasks.id, taskId)),
      db.drizzle.select().from(db.schema.agents).where(eq(db.schema.agents.id, agentId)),
      db.drizzle.select().from(db.schema.taskHolds).where(eq(db.schema.taskHolds.taskId, taskId)),
    ]);

    expect(checkout).toMatchObject({ status: 'released' });
    expect(execution).toMatchObject({ status: 'cancelled' });
    expect(task).toMatchObject({ status: 'todo', startedAt: null });
    expect(agent).toMatchObject({ status: 'idle' });
    expect(hold).toMatchObject({ status: 'active', previousStatus: 'todo' });
  });

  it('rejects escalation by an agent that does not own the active checkout', async () => {
    const managerId = await insertAgent('Manager');
    const ownerId = await insertAgent('Checkout owner');
    const escalatingAgentId = await insertAgent('Different blocked agent');
    await db.drizzle
      .update(db.schema.agents)
      .set({ reportsTo: managerId, updatedAt: new Date() })
      .where(eq(db.schema.agents.id, escalatingAgentId));
    const taskId = await insertTask(ownerId);
    const executionId = await insertExecution(ownerId, taskId);
    await new TaskCheckoutService(db).checkout(
      input(taskId, ownerId, executionId, 'owner-checkout'),
    );

    await expect(
      new CollaborationService(db).escalate(
        escalatingAgentId,
        taskId,
        companyId,
        'Attempt to pause another owner',
      ),
    ).rejects.toMatchObject({ status: 409, code: 'TASK_CHECKOUT_CONFLICT' });

    const [[checkout], [execution], holds] = await Promise.all([
      db.drizzle
        .select()
        .from(db.schema.taskCheckouts)
        .where(eq(db.schema.taskCheckouts.executionId, executionId)),
      db.drizzle
        .select()
        .from(db.schema.agentExecutions)
        .where(eq(db.schema.agentExecutions.id, executionId)),
      db.drizzle
        .select()
        .from(db.schema.taskHolds)
        .where(eq(db.schema.taskHolds.taskId, taskId)),
    ]);
    expect(checkout.status).toBe('active');
    expect(execution.status).toBe('running');
    expect(holds).toHaveLength(0);
  });

  it('identifies an execution-scoped uniqueness conflict', async () => {
    const agentId = await insertAgent('A');
    const taskId = await insertTask(agentId);
    const executionId = await insertExecution(agentId, taskId);
    const service = new TaskCheckoutService(db);
    const first = await service.checkout(input(taskId, agentId, executionId, 'first-checkout'));

    await db.drizzle
      .update(db.schema.taskCheckouts)
      .set({
        status: 'released',
        releasedAt: new Date(),
        releaseReason: 'manual_release',
        updatedAt: new Date(),
      })
      .where(eq(db.schema.taskCheckouts.id, first.checkout.id));
    await db.drizzle
      .update(db.schema.tasks)
      .set({ status: 'todo', startedAt: null, updatedAt: new Date() })
      .where(eq(db.schema.tasks.id, taskId));

    await expect(
      service.checkout(input(taskId, agentId, executionId, 'second-checkout')),
    ).rejects.toMatchObject({
      status: 409,
      code: 'TASK_CHECKOUT_CONFLICT',
      details: {
        conflictReason: 'execution_already_checked_out',
        conflictingTaskId: taskId,
        conflictingCheckoutStatus: 'released',
        activeExecutionId: executionId,
      },
    });
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
