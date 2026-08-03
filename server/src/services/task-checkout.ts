import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';

export type TaskCheckoutSource = 'api' | 'agent_executor' | 'agentic_loop' | 'routine';

type TaskCheckoutErrorCode =
  | 'TASK_NOT_FOUND'
  | 'AGENT_NOT_FOUND'
  | 'EXECUTION_NOT_FOUND'
  | 'TASK_CHECKOUT_IDENTITY_MISMATCH'
  | 'TASK_CHECKOUT_EXECUTION_NOT_RUNNING'
  | 'TASK_CHECKOUT_PAUSED'
  | 'TASK_CHECKOUT_DEPENDENCIES_BLOCKED'
  | 'TASK_CHECKOUT_RELEASED'
  | 'TASK_CHECKOUT_CONFLICT';

export class TaskCheckoutError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: TaskCheckoutErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TaskCheckoutError';
  }
}

export type TaskCheckoutInput = {
  companyId: string;
  taskId: string;
  agentId: string;
  executionId: string;
  source: TaskCheckoutSource;
  idempotencyKey: string;
};

export type TaskCheckoutReleaseInput = {
  companyId: string;
  taskId: string;
  agentId: string;
  executionId: string;
  reason: string;
};

type TaskCheckoutRow = DbInstance['schema']['taskCheckouts']['$inferSelect'];

export class TaskCheckoutService {
  constructor(private db: DbInstance) {}

  async checkout(input: TaskCheckoutInput) {
    const {
      tasks,
      agents,
      agentExecutions,
      taskCheckouts,
      taskThreadItems,
    } = this.db.schema;
    const now = new Date();

    const result = await this.db.drizzle.transaction(async (tx) => {
      const [candidateTask] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)))
        .limit(1);

      if (!candidateTask) {
        throw new TaskCheckoutError(404, 'TASK_NOT_FOUND', `Task ${input.taskId} not found`);
      }

      const [execution] = await tx
        .select()
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.id, input.executionId),
            eq(agentExecutions.companyId, input.companyId),
          ),
        )
        .limit(1)
        .for('update');

      if (!execution) {
        throw new TaskCheckoutError(
          404,
          'EXECUTION_NOT_FOUND',
          `Execution ${input.executionId} not found`,
        );
      }
      if (execution.agentId !== input.agentId || execution.taskId !== input.taskId) {
        throw new TaskCheckoutError(
          400,
          'TASK_CHECKOUT_IDENTITY_MISMATCH',
          'Execution, agent, and task identity must match',
          {
            executionId: execution.id,
            executionAgentId: execution.agentId,
            executionTaskId: execution.taskId,
          },
        );
      }

      const candidateDependencyIds = Array.isArray(candidateTask.dependencies)
        ? [...candidateTask.dependencies].sort()
        : [];
      const lockedTasks = await tx
        .select()
        .from(tasks)
        .where(
          and(
            eq(tasks.companyId, input.companyId),
            inArray(tasks.id, [...new Set([input.taskId, ...candidateDependencyIds])].sort()),
          ),
        )
        .orderBy(tasks.id)
        .for('update');
      const task = lockedTasks.find((row) => row.id === input.taskId);

      if (!task) {
        throw new TaskCheckoutError(404, 'TASK_NOT_FOUND', `Task ${input.taskId} not found`);
      }

      const dependencyIds = Array.isArray(task.dependencies)
        ? [...task.dependencies].sort()
        : [];
      if (dependencyIds.join('\0') !== candidateDependencyIds.join('\0')) {
        throw this.conflict(input, null, {
          conflictReason: 'task_dependencies_changed',
        });
      }

      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
        .limit(1);

      if (!agent) {
        throw new TaskCheckoutError(404, 'AGENT_NOT_FOUND', `Agent ${input.agentId} not found`);
      }

      const [pauseHold] = await tx
        .select({ id: this.db.schema.taskHolds.id })
        .from(this.db.schema.taskHolds)
        .where(
          and(
            eq(this.db.schema.taskHolds.companyId, input.companyId),
            eq(this.db.schema.taskHolds.taskId, input.taskId),
            eq(this.db.schema.taskHolds.action, 'pause'),
            eq(this.db.schema.taskHolds.status, 'active'),
          ),
        )
        .limit(1);

      if (pauseHold) {
        throw new TaskCheckoutError(
          409,
          'TASK_CHECKOUT_PAUSED',
          `Task ${input.taskId} is paused`,
          { taskId: input.taskId, holdId: pauseHold.id },
        );
      }

      if (dependencyIds.length > 0) {
        const completedIds = new Set(
          lockedTasks
            .filter((dependency) => dependency.status === 'done')
            .map((dependency) => dependency.id),
        );
        const blockedBy = dependencyIds.filter((dependencyId) => !completedIds.has(dependencyId));
        if (blockedBy.length > 0) {
          throw new TaskCheckoutError(
            409,
            'TASK_CHECKOUT_DEPENDENCIES_BLOCKED',
            `Task ${input.taskId} has incomplete dependencies`,
            { taskId: input.taskId, blockedBy },
          );
        }
      }

      const [existingReplay] = await tx
        .select()
        .from(taskCheckouts)
        .where(
          and(
            eq(taskCheckouts.companyId, input.companyId),
            eq(taskCheckouts.taskId, input.taskId),
            eq(taskCheckouts.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);

      if (existingReplay) {
        if (
          existingReplay.agentId !== input.agentId ||
          existingReplay.executionId !== input.executionId
        ) {
          throw this.conflict(input, existingReplay);
        }
        if (existingReplay.status !== 'active') {
          throw new TaskCheckoutError(
            409,
            'TASK_CHECKOUT_RELEASED',
            `Checkout ${existingReplay.id} has already been released`,
            {
              taskId: input.taskId,
              checkoutId: existingReplay.id,
              checkoutStatus: existingReplay.status,
              releasedAt: existingReplay.releasedAt,
              releaseReason: existingReplay.releaseReason,
            },
          );
        }
        return { checkout: existingReplay, task, threadItem: null, replayed: true };
      }

      if (execution.status !== 'running') {
        throw new TaskCheckoutError(
          409,
          'TASK_CHECKOUT_EXECUTION_NOT_RUNNING',
          `Execution ${input.executionId} is not running`,
          {
            executionId: execution.id,
            executionStatus: execution.status,
          },
        );
      }

      const [checkout] = await tx
        .insert(taskCheckouts)
        .values({
          id: randomUUID(),
          companyId: input.companyId,
          taskId: input.taskId,
          agentId: input.agentId,
          executionId: input.executionId,
          source: input.source,
          status: 'active',
          idempotencyKey: input.idempotencyKey,
          claimedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();

      if (!checkout) {
        const [[activeCheckout], [executionCheckout]] = await Promise.all([
          tx
            .select()
            .from(taskCheckouts)
            .where(
              and(
                eq(taskCheckouts.companyId, input.companyId),
                eq(taskCheckouts.taskId, input.taskId),
                eq(taskCheckouts.status, 'active'),
              ),
            )
            .limit(1),
          tx
            .select()
            .from(taskCheckouts)
            .where(
              and(
                eq(taskCheckouts.companyId, input.companyId),
                eq(taskCheckouts.executionId, input.executionId),
              ),
            )
            .limit(1),
        ]);

        if (
          activeCheckout &&
          activeCheckout.agentId === input.agentId &&
          activeCheckout.executionId === input.executionId
        ) {
          const [currentTask] = await tx
            .select()
            .from(tasks)
            .where(
              and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)),
            )
            .limit(1);
          return {
            checkout: activeCheckout,
            task: currentTask ?? task,
            threadItem: null,
            replayed: true,
          };
        }
        const conflictingCheckout = activeCheckout ?? executionCheckout;
        throw this.conflict(input, conflictingCheckout, {
          conflictReason: activeCheckout
            ? 'task_already_checked_out'
            : executionCheckout
              ? 'execution_already_checked_out'
              : 'checkout_write_conflict',
          conflictingTaskId: conflictingCheckout?.taskId ?? null,
          conflictingCheckoutStatus: conflictingCheckout?.status ?? null,
        });
      }

      const [updatedTask] = await tx
        .update(tasks)
        .set({
          assigneeAgentId: input.agentId,
          status: 'in_progress',
          startedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(tasks.id, input.taskId),
            eq(tasks.companyId, input.companyId),
            inArray(tasks.status, ['backlog', 'todo']),
            sql`(${tasks.assigneeAgentId} IS NULL OR ${tasks.assigneeAgentId} = ${input.agentId})`,
          ),
        )
        .returning();

      if (!updatedTask) {
        const [currentTask] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)))
          .limit(1);
        throw this.conflict(input, null, {
          currentStatus: currentTask?.status ?? null,
          currentAssigneeAgentId: currentTask?.assigneeAgentId ?? null,
        });
      }

      await tx
        .update(agents)
        .set({
          status: 'working',
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));

      const [threadItem] = await tx
        .insert(taskThreadItems)
        .values({
          id: randomUUID(),
          companyId: input.companyId,
          taskId: input.taskId,
          kind: 'execution_event',
          authorAgentId: input.agentId,
          content: `Task checked out by execution ${input.executionId}.`,
          payload: {
            checkoutId: checkout.id,
            agentId: input.agentId,
            executionId: input.executionId,
            source: input.source,
            previousStatus: task.status,
            newStatus: 'in_progress',
          },
          status: 'linked',
          idempotencyKey: `task-checkout:${checkout.id}`,
          relatedExecutionId: input.executionId,
          projectId: task.projectId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return { checkout, task: updatedTask, threadItem, replayed: false };
    });

    if (!result.replayed) {
      eventBus.emitEvent({
        type: 'task.checked_out',
        companyId: input.companyId,
        payload: {
          taskId: input.taskId,
          checkoutId: result.checkout.id,
          agentId: input.agentId,
          executionId: input.executionId,
          source: input.source,
        },
        timestamp: now.toISOString(),
      });
      eventBus.emitEvent({
        type: 'task.updated',
        companyId: input.companyId,
        payload: { task: result.task, changes: ['assigneeAgentId', 'status', 'startedAt'] },
        timestamp: now.toISOString(),
      });
      eventBus.emitEvent({
        type: 'agent.status_changed',
        companyId: input.companyId,
        payload: {
          agentId: input.agentId,
          status: 'working',
          taskId: input.taskId,
          executionId: input.executionId,
        },
        timestamp: now.toISOString(),
      });
      if (result.threadItem) {
        eventBus.emitEvent({
          type: 'task.thread_item_seen',
          companyId: input.companyId,
          payload: { taskId: input.taskId, item: result.threadItem },
          timestamp: now.toISOString(),
        });
      }
    }

    return result;
  }

  async release(input: TaskCheckoutReleaseInput) {
    const { tasks, agentExecutions, taskCheckouts, taskThreadItems } = this.db.schema;
    const now = new Date();

    const result = await this.db.drizzle.transaction(async (tx) => {
      const [execution] = await tx
        .select()
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.id, input.executionId),
            eq(agentExecutions.companyId, input.companyId),
          ),
        )
        .limit(1)
        .for('update');

      if (!execution) {
        throw new TaskCheckoutError(
          404,
          'EXECUTION_NOT_FOUND',
          `Execution ${input.executionId} not found`,
        );
      }

      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)))
        .limit(1)
        .for('update');

      if (!task) {
        throw new TaskCheckoutError(404, 'TASK_NOT_FOUND', `Task ${input.taskId} not found`);
      }

      const [checkout] = await tx
        .select()
        .from(taskCheckouts)
        .where(
          and(
            eq(taskCheckouts.companyId, input.companyId),
            eq(taskCheckouts.taskId, input.taskId),
            eq(taskCheckouts.executionId, input.executionId),
          ),
        )
        .limit(1)
        .for('update');

      if (!checkout) {
        throw this.conflict(input, null, { conflictReason: 'checkout_not_found' });
      }
      if (checkout.agentId !== input.agentId) {
        throw this.conflict(input, checkout, { conflictReason: 'checkout_owner_mismatch' });
      }
      if (execution.agentId !== input.agentId || execution.taskId !== input.taskId) {
        throw new TaskCheckoutError(
          400,
          'TASK_CHECKOUT_IDENTITY_MISMATCH',
          'Execution, agent, and task identity must match',
          {
            executionId: execution.id,
            executionAgentId: execution.agentId,
            executionTaskId: execution.taskId,
          },
        );
      }

      if (checkout.status === 'released') {
        if (checkout.releaseReason !== input.reason) {
          throw this.conflict(input, checkout, {
            conflictReason: 'release_request_mismatch',
            requestedReason: input.reason,
            recordedReason: checkout.releaseReason,
          });
        }
        const [threadItem] = await tx
          .select()
          .from(taskThreadItems)
          .where(
            and(
              eq(taskThreadItems.companyId, input.companyId),
              eq(taskThreadItems.taskId, input.taskId),
              eq(taskThreadItems.idempotencyKey, `task-release:${checkout.id}`),
            ),
          )
          .limit(1);
        return { checkout, task, threadItem: threadItem ?? null, replayed: true };
      }

      if (execution.status !== 'running') {
        throw new TaskCheckoutError(
          409,
          'TASK_CHECKOUT_EXECUTION_NOT_RUNNING',
          `Execution ${input.executionId} is ${execution.status}`,
          { executionId: execution.id, executionStatus: execution.status },
        );
      }

      const [released] = await tx
        .update(taskCheckouts)
        .set({
          status: 'released',
          releasedAt: now,
          releaseReason: input.reason,
          updatedAt: now,
        })
        .where(
          and(
            eq(taskCheckouts.id, checkout.id),
            eq(taskCheckouts.status, 'active'),
            eq(taskCheckouts.agentId, input.agentId),
            eq(taskCheckouts.executionId, input.executionId),
          ),
        )
        .returning();

      if (!released) {
        throw this.conflict(input, checkout, { conflictReason: 'checkout_release_race' });
      }

      const [updatedTask] = await tx
        .update(tasks)
        .set({
          status: 'todo',
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)))
        .returning();

      const [cancelledExecution] = await tx
        .update(agentExecutions)
        .set({ status: 'cancelled', completedAt: now, updatedAt: now })
        .where(
          and(
            eq(agentExecutions.id, input.executionId),
            eq(agentExecutions.companyId, input.companyId),
            eq(agentExecutions.status, 'running'),
          ),
        )
        .returning();

      if (!cancelledExecution) {
        throw this.conflict(input, checkout, { conflictReason: 'execution_release_race' });
      }

      const [threadItem] = await tx
        .insert(taskThreadItems)
        .values({
          id: randomUUID(),
          companyId: input.companyId,
          taskId: input.taskId,
          kind: 'execution_event',
          authorAgentId: input.agentId,
          content: input.reason,
          payload: {
            event: 'task_checkout_released',
            checkoutId: checkout.id,
            agentId: input.agentId,
            executionId: input.executionId,
            previousStatus: task.status,
            newStatus: 'todo',
            reason: input.reason,
          },
          status: 'linked',
          idempotencyKey: `task-release:${checkout.id}`,
          relatedExecutionId: input.executionId,
          projectId: task.projectId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();

      return {
        checkout: released,
        task: updatedTask,
        threadItem: threadItem ?? null,
        replayed: false,
      };
    });

    if (!result.replayed) {
      eventBus.emitEvent({
        type: 'task.status_changed',
        companyId: input.companyId,
        payload: {
          taskId: input.taskId,
          previousStatus: 'in_progress',
          newStatus: 'todo',
          executionId: input.executionId,
        },
        timestamp: now.toISOString(),
      });
      if (result.threadItem) {
        eventBus.emitEvent({
          type: 'task.thread_item_seen',
          companyId: input.companyId,
          payload: { taskId: input.taskId, item: result.threadItem },
          timestamp: now.toISOString(),
        });
      }
    }

    return result;
  }

  private conflict(
    input: Pick<TaskCheckoutInput, 'taskId' | 'agentId' | 'executionId'>,
    activeCheckout: TaskCheckoutRow | null | undefined,
    details: Record<string, unknown> = {},
  ) {
    return new TaskCheckoutError(
      409,
      'TASK_CHECKOUT_CONFLICT',
      `Task ${input.taskId} is not available for execution ${input.executionId}`,
      {
        taskId: input.taskId,
        requestedAgentId: input.agentId,
        requestedExecutionId: input.executionId,
        activeCheckoutId: activeCheckout?.id ?? null,
        activeAgentId: activeCheckout?.agentId ?? null,
        activeExecutionId: activeCheckout?.executionId ?? null,
        ...details,
      },
    );
  }
}
