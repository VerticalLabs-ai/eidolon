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
      const [[task], [agent], [execution]] = await Promise.all([
        tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)))
          .limit(1),
        tx
          .select()
          .from(agents)
          .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
          .limit(1),
        tx
          .select()
          .from(agentExecutions)
          .where(
            and(
              eq(agentExecutions.id, input.executionId),
              eq(agentExecutions.companyId, input.companyId),
            ),
          )
          .limit(1),
      ]);

      if (!task) {
        throw new TaskCheckoutError(404, 'TASK_NOT_FOUND', `Task ${input.taskId} not found`);
      }
      if (!agent) {
        throw new TaskCheckoutError(404, 'AGENT_NOT_FOUND', `Agent ${input.agentId} not found`);
      }
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
        const [activeCheckout] = await tx
          .select()
          .from(taskCheckouts)
          .where(
            and(
              eq(taskCheckouts.companyId, input.companyId),
              eq(taskCheckouts.taskId, input.taskId),
              eq(taskCheckouts.status, 'active'),
            ),
          )
          .limit(1);

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
        throw this.conflict(input, activeCheckout);
      }

      const [updatedTask] = await tx
        .update(tasks)
        .set({
          assigneeAgentId: input.agentId,
          status: 'in_progress',
          startedAt: task.startedAt ?? now,
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
        throw this.conflict(input, null, {
          currentStatus: task.status,
          currentAssigneeAgentId: task.assigneeAgentId,
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

  private conflict(
    input: TaskCheckoutInput,
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
