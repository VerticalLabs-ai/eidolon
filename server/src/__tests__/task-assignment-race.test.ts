import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../test-utils.js';
import { HeartbeatScheduler } from '../services/scheduler.js';
import { TaskAssigner } from '../services/task-assigner.js';
import type { DbInstance } from '../types.js';

/**
 * Concurrency guarantees for task assignment.
 *
 * The scheduler and TaskAssigner both rely on conditional `UPDATE … WHERE
 * assigneeAgentId IS NULL` to claim an unassigned task atomically. If two
 * workers race for the same task, exactly one must win and the rest must be
 * no-ops — never double-assignment.
 *
 * better-sqlite3 is synchronous, so JavaScript `Promise.all` plus the event
 * loop actually produces interleaved calls against the same transaction-less
 * connection. That's the sharpest test we can write without spinning a second
 * process, and it already catches the happy-path correctness regression.
 */
describe('Task assignment concurrency', () => {
  let db: DbInstance;
  let companyId: string;

  async function insertCompany(): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.companies).values({
      id,
      name: 'Race Corp',
      status: 'active',
      budgetMonthlyCents: 100_000_000,
      spentMonthlyCents: 0,
      settings: {},
      createdAt: now,
      updatedAt: now,
    } as any);
    return id;
  }

  async function insertAgent(
    overrides: Partial<{
      name: string;
      status: 'idle' | 'working';
      autoAssign: 0 | 1;
      intervalSeconds: number;
      executionTimeoutSeconds: number;
      budgetMonthlyCents: number;
      spentMonthlyCents: number;
    }> = {},
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.agents).values({
      id,
      companyId,
      name: overrides.name ?? 'Racer',
      role: 'engineer',
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      status: overrides.status ?? 'idle',
      capabilities: [],
      config: {},
      metadata: {},
      permissions: [],
      toolsEnabled: [],
      allowedDomains: [],
      maxConcurrentTasks: 1,
      heartbeatIntervalSeconds: overrides.intervalSeconds ?? 0,
      executionTimeoutSeconds: overrides.executionTimeoutSeconds ?? 600,
      autoAssignTasks: overrides.autoAssign ?? 1,
      budgetMonthlyCents: overrides.budgetMonthlyCents ?? 0,
      spentMonthlyCents: overrides.spentMonthlyCents ?? 0,
      createdAt: now,
      updatedAt: now,
    } as any);
    return id;
  }

  async function insertTask(
    overrides: Partial<{
      title: string;
      status: 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'cancelled' | 'timed_out';
      priority: 'critical' | 'high' | 'medium' | 'low';
      dependencies: string[];
      assigneeAgentId: string | null;
      startedAt: Date | null;
    }> = {},
  ): Promise<string> {
    const id = randomUUID();
    const now = new Date();
    await db.drizzle.insert(db.schema.tasks).values({
      id,
      companyId,
      title: overrides.title ?? 'Ship it',
      type: 'feature',
      status: overrides.status ?? 'todo',
      priority: overrides.priority ?? 'medium',
      assigneeAgentId: overrides.assigneeAgentId ?? null,
      dependencies: overrides.dependencies ?? [],
      tags: [],
      startedAt: overrides.startedAt ?? null,
      createdAt: now,
      updatedAt: now,
    } as any);
    return id;
  }

  beforeEach(async () => {
    db = await createTestDb();
    companyId = await insertCompany();
  });

  it('TaskAssigner.assignTask: only one of two concurrent claims wins', async () => {
    const taskId = await insertTask();
    const agentA = await insertAgent({ name: 'A' });
    const agentB = await insertAgent({ name: 'B' });

    const assigner = new TaskAssigner(db);

    await Promise.all([
      assigner.assignTask(taskId, agentA),
      assigner.assignTask(taskId, agentB),
    ]);

    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));

    expect(task.status).toBe('in_progress');
    expect([agentA, agentB]).toContain(task.assigneeAgentId);

    // Exactly one agent should be 'working', the other should remain 'idle'
    const agents = await db.drizzle.select().from(db.schema.agents);
    const working = agents.filter((a) => a.status === 'working');
    const idle = agents.filter((a) => a.status === 'idle');
    expect(working).toHaveLength(1);
    expect(idle).toHaveLength(1);
    expect(working[0].id).toBe(task.assigneeAgentId);
  });

  it('HeartbeatScheduler.wakeAgent: two agents racing a single task yield exactly one assignment', async () => {
    const taskId = await insertTask({ priority: 'high' });
    const agentA = await insertAgent({ name: 'A' });
    const agentB = await insertAgent({ name: 'B' });

    const scheduler = new HeartbeatScheduler(db);

    const results = await Promise.all([
      scheduler.wakeAgent(agentA),
      scheduler.wakeAgent(agentB),
    ]);

    const winners = results.filter((r) => r.assigned);
    const losers = results.filter((r) => !r.assigned);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(winners[0].taskId).toBe(taskId);

    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));
    expect(task.status).toBe('in_progress');
    expect([agentA, agentB]).toContain(task.assigneeAgentId);

    const agents = await db.drizzle.select().from(db.schema.agents);
    const workingCount = agents.filter((a) => a.status === 'working').length;
    expect(workingCount).toBe(1);
  });

  it('HeartbeatScheduler.wakeAgent: five racers on one task still yield exactly one assignment', async () => {
    const taskId = await insertTask();
    const agentIds = await Promise.all(
      Array.from({ length: 5 }, (_, i) => insertAgent({ name: `A${i}` })),
    );

    const scheduler = new HeartbeatScheduler(db);
    const results = await Promise.all(
      agentIds.map((id) => scheduler.wakeAgent(id)),
    );

    const winners = results.filter((r) => r.assigned);
    expect(winners).toHaveLength(1);

    const [task] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, taskId));
    expect(agentIds).toContain(task.assigneeAgentId);

    const workingAgents = (
      await db.drizzle.select().from(db.schema.agents)
    ).filter((a) => a.status === 'working');
    expect(workingAgents).toHaveLength(1);
    expect(workingAgents[0].id).toBe(task.assigneeAgentId);
  });

  it('HeartbeatScheduler.wakeAgent: skips tasks while dependencies remain open', async () => {
    const blockerId = await insertTask({ title: 'Blocker', status: 'todo' });
    const dependentId = await insertTask({
      title: 'Dependent',
      priority: 'critical',
      dependencies: [blockerId],
    });
    const fallbackId = await insertTask({ title: 'Fallback', priority: 'low' });
    const agentId = await insertAgent();

    const scheduler = new HeartbeatScheduler(db);
    const blockedResult = await scheduler.wakeAgent(agentId);

    expect(blockedResult).toEqual({ assigned: true, taskId: blockerId });

    await db.drizzle
      .update(db.schema.tasks)
      .set({ status: 'done', assigneeAgentId: null, updatedAt: new Date() })
      .where(eq(db.schema.tasks.id, blockerId));
    await db.drizzle
      .update(db.schema.agents)
      .set({ status: 'idle', updatedAt: new Date() })
      .where(eq(db.schema.agents.id, agentId));

    const unblockedResult = await scheduler.wakeAgent(agentId);

    expect(unblockedResult).toEqual({ assigned: true, taskId: dependentId });

    const [fallback] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, fallbackId));
    expect(fallback.status).toBe('todo');
    expect(fallback.assigneeAgentId).toBeNull();
  });

  it('HeartbeatScheduler.wakeAgent: skips tasks with active holds', async () => {
    const heldTaskId = await insertTask({ priority: 'critical' });
    const fallbackTaskId = await insertTask({ priority: 'low' });
    const agentId = await insertAgent();
    const now = new Date();

    await db.drizzle.insert(db.schema.taskHolds).values({
      id: randomUUID(),
      companyId,
      taskId: heldTaskId,
      action: 'pause',
      status: 'active',
      previousStatus: 'todo',
      reason: 'operator paused',
      createdAt: now,
      updatedAt: now,
    } as any);

    const scheduler = new HeartbeatScheduler(db);
    const result = await scheduler.wakeAgent(agentId);

    expect(result).toEqual({ assigned: true, taskId: fallbackTaskId });
  });

  it('HeartbeatScheduler.runOnce: creates redacted recovery tasks for stalled executions', async () => {
    const agentId = await insertAgent({ status: 'working', intervalSeconds: 0, executionTimeoutSeconds: 1 });
    const taskId = await insertTask({
      title: 'Original task',
      status: 'in_progress',
      assigneeAgentId: agentId,
      startedAt: new Date(Date.now() - 120_000),
    });
    const executionId = randomUUID();
    const startedAt = new Date(Date.now() - 120_000);

    await db.drizzle.insert(db.schema.agentExecutions).values({
      id: executionId,
      companyId,
      agentId,
      taskId,
      status: 'running',
      startedAt,
      error: 'provider secret stack trace should not be copied',
      livenessStatus: 'healthy',
      log: [],
      createdAt: startedAt,
    } as any);

    await new HeartbeatScheduler(db).runOnce();

    const [execution] = await db.drizzle
      .select()
      .from(db.schema.agentExecutions)
      .where(eq(db.schema.agentExecutions.id, executionId));
    expect(execution.livenessStatus).toBe('recovering');
    expect(execution.recoveryTaskId).toBeTruthy();

    const [recoveryTask] = await db.drizzle
      .select()
      .from(db.schema.tasks)
      .where(eq(db.schema.tasks.id, execution.recoveryTaskId!));
    expect(recoveryTask.title).toContain('Recover stalled execution');
    expect(recoveryTask.description).toContain('Raw provider errors are intentionally redacted');
    expect(recoveryTask.description).not.toContain('provider secret stack trace');
  });
});
