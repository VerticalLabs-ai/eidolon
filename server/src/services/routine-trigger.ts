import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { RuntimeSessionService } from './runtime-sessions.js';
import type { DbInstance } from '../types.js';

export type RoutineTriggerStatus =
  | 'session_started'
  | 'task_created_without_agent';

type TableRow<Name extends keyof DbInstance['schema']> =
  DbInstance['schema'][Name]['$inferSelect'];

type RoutineTriggerWork = {
  routine: TableRow<'routines'>;
  task: TableRow<'tasks'>;
  execution: TableRow<'agentExecutions'> | null;
  threadItem: TableRow<'taskThreadItems'>;
};

export class RoutineTriggerService {
  private sessions: RuntimeSessionService;

  constructor(private db: DbInstance) {
    this.sessions = new RuntimeSessionService(db);
  }

  async trigger(companyId: string, routineId: string) {
    let result: RoutineTriggerWork | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        result = await this.createRoutineWork(companyId, routineId);
        break;
      } catch (error) {
        if (attempt === 2 || !isTaskNumberConflict(error)) {
          throw error;
        }
      }
    }

    if (!result) {
      return null;
    }

    let session = null;
    if (result.execution) {
      try {
        session = await this.sessions.createSession({
          companyId,
          agentId: result.execution.agentId,
          taskId: result.task.id,
          executionId: result.execution.id,
          mode: 'manual',
          resumeState: {
            routineId: result.routine.id,
            jarvisMode: result.routine.jarvisMode,
          },
        });
      } catch (error) {
        await this.markSessionStartFailed(companyId, result, error);
        throw error;
      }
    }

    const status: RoutineTriggerStatus = session
      ? 'session_started'
      : 'task_created_without_agent';

    return {
      ...result,
      execution: result.execution && session
        ? { ...result.execution, runtimeSessionId: session.id }
        : result.execution,
      session,
      status,
    };
  }

  private async createRoutineWork(
    companyId: string,
    routineId: string,
  ): Promise<RoutineTriggerWork | null> {
    const { routines, tasks, agentExecutions, taskThreadItems } = this.db.schema;
    const now = new Date();

    return this.db.drizzle.transaction(async (tx) => {
      const [routine] = await tx
        .select()
        .from(routines)
        .where(and(eq(routines.id, routineId), eq(routines.companyId, companyId)))
        .limit(1);

      if (!routine) {
        return null;
      }

      const [{ maxNum }] = await tx
        .select({ maxNum: sql<number>`coalesce(max(${tasks.taskNumber}), 0)` })
        .from(tasks)
        .where(eq(tasks.companyId, companyId));

      const taskNumber = Number(maxNum) + 1;
      const identifier = `TASK-${taskNumber}`;
      const taskId = randomUUID();
      const executionId = routine.agentId ? randomUUID() : null;
      const triggerId = randomUUID();
      const taskStatus = routine.agentId ? 'in_progress' : 'backlog';

      const [task] = await tx
        .insert(tasks)
        .values({
          id: taskId,
          companyId,
          title: `Run routine: ${routine.name}`,
          description: routine.prompt,
          type: 'chore',
          status: taskStatus,
          priority: 'medium',
          assigneeAgentId: routine.agentId,
          taskNumber,
          identifier,
          tags: ['jarvis-routine', routine.jarvisMode],
          startedAt: routine.agentId ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const [execution] = executionId
        ? await tx
            .insert(agentExecutions)
            .values({
              id: executionId,
              companyId,
              agentId: routine.agentId!,
              taskId: task.id,
              status: 'running',
              modelUsed: null,
              provider: null,
              summary: `Routine trigger started for ${routine.name}`,
              executionMode: 'manual',
              lastUsefulAction: 'routine_triggered',
              nextActionHint: 'await_runtime_session',
              lastEventAt: now,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
        : [null];

      const [threadItem] = await tx
        .insert(taskThreadItems)
        .values({
          id: randomUUID(),
          companyId,
          taskId: task.id,
          kind: 'execution_event',
          authorAgentId: routine.agentId,
          content: routine.agentId
            ? `Routine "${routine.name}" triggered runtime work for this agent.`
            : `Routine "${routine.name}" created a task but has no assigned agent.`,
          payload: {
            triggerId,
            routineId: routine.id,
            routineName: routine.name,
            jarvisMode: routine.jarvisMode,
            mode: routine.mode,
            schedule: routine.schedule,
            agentId: routine.agentId,
            executionId,
          },
          status: execution ? 'linked' : 'answered',
          idempotencyKey: `routine-trigger:${triggerId}`,
          relatedExecutionId: execution?.id ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const [updatedRoutine] = await tx
        .update(routines)
        .set({ lastTriggeredAt: now, updatedAt: now })
        .where(and(eq(routines.id, routine.id), eq(routines.companyId, companyId)))
        .returning();

      return {
        routine: updatedRoutine,
        task,
        execution,
        threadItem,
      };
    });
  }

  private async markSessionStartFailed(
    companyId: string,
    work: RoutineTriggerWork,
    error: unknown,
  ) {
    if (!work.execution) return;

    const { tasks, agentExecutions, taskThreadItems } = this.db.schema;
    const now = new Date();
    const message = error instanceof Error ? error.message : String(error);

    await this.db.drizzle.transaction(async (tx) => {
      await tx
        .update(agentExecutions)
        .set({
          status: 'failed',
          error: message,
          completedAt: now,
          lastEventAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(agentExecutions.companyId, companyId),
          eq(agentExecutions.id, work.execution!.id),
        ));

      await tx
        .update(tasks)
        .set({
          status: 'cancelled',
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, work.task.id)));

      await tx
        .update(taskThreadItems)
        .set({
          status: 'answered',
          content: `Routine "${work.routine.name}" could not start a runtime session.`,
          resolutionNote: message,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(taskThreadItems.companyId, companyId),
          eq(taskThreadItems.id, work.threadItem.id),
        ));
    });
  }
}

function isTaskNumberConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('uq_tasks_company_task_number') ||
    message.includes('tasks_company_task_number') ||
    (message.includes('unique') && message.includes('task_number'))
  );
}
