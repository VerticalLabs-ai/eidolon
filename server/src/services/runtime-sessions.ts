import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../types.js';
import eventBus from '../realtime/events.js';

export interface CreateRuntimeSessionInput {
  companyId: string;
  agentId: string;
  taskId?: string | null;
  executionId?: string | null;
  environmentId?: string | null;
  adapterId?: string | null;
  adapterConfig?: Record<string, unknown>;
  mode?: 'on_demand' | 'scheduled' | 'continuous' | 'manual' | 'recovery';
  resumeState?: Record<string, unknown>;
  finalizeRequired?: boolean;
}

export class RuntimeSessionService {
  constructor(private db: DbInstance) {}

  async createSession(input: CreateRuntimeSessionInput) {
    const { agents, agentRuntimeSessions, agentExecutions, executionEnvironments, tasks } = this.db.schema;
    const now = new Date();

    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .limit(1);

    if (!agent) {
      throw new Error(`Agent ${input.agentId} not found`);
    }

    if (input.taskId) {
      const [task] = await this.db.drizzle
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, input.taskId), eq(tasks.companyId, input.companyId)))
        .limit(1);

      if (!task) {
        throw new Error(`Task ${input.taskId} not found`);
      }
    }

    let existingExecutionEnvironmentId: string | null = null;
    if (input.executionId) {
      const [execution] = await this.db.drizzle
        .select({
          id: agentExecutions.id,
          taskId: agentExecutions.taskId,
          environmentId: agentExecutions.environmentId,
        })
        .from(agentExecutions)
        .where(
          and(
            eq(agentExecutions.id, input.executionId),
            eq(agentExecutions.companyId, input.companyId),
            eq(agentExecutions.agentId, input.agentId),
          ),
        )
        .limit(1);

      if (!execution) {
        throw new Error(`Execution ${input.executionId} not found`);
      }
      if (input.taskId && execution.taskId && execution.taskId !== input.taskId) {
        throw new Error(`Execution ${input.executionId} is not linked to task ${input.taskId}`);
      }
      existingExecutionEnvironmentId = execution.environmentId ?? null;
    }

    const environmentId =
      input.environmentId == null
        ? existingExecutionEnvironmentId
        : input.environmentId;

    const adapterId =
      input.adapterId ??
      (typeof agent.adapterId === 'string' && agent.adapterId.length > 0
        ? agent.adapterId
        : defaultRuntimeAdapterId(agent.provider));

    const [session] = await this.db.drizzle.transaction(async (tx) => {
      if (input.environmentId) {
        const [leased] = await tx
          .update(executionEnvironments)
          .set({
            status: 'leased',
            leaseOwnerAgentId: input.agentId,
            leaseOwnerExecutionId: input.executionId ?? null,
            leasedAt: now,
            releasedAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(executionEnvironments.id, input.environmentId),
              eq(executionEnvironments.companyId, input.companyId),
              eq(executionEnvironments.status, 'available'),
            ),
          )
          .returning();

        if (!leased) {
          throw new Error(`Environment ${input.environmentId} is not available`);
        }
      }

      const [created] = await tx
        .insert(agentRuntimeSessions)
        .values({
          id: randomUUID(),
          companyId: input.companyId,
          agentId: input.agentId,
          taskId: input.taskId ?? null,
          executionId: input.executionId ?? null,
          environmentId: environmentId ?? null,
          runId: randomUUID(),
          adapterId,
          adapterConfig: input.adapterConfig ?? agent.adapterConfig ?? {},
          mode: input.mode ?? 'on_demand',
          status: 'running',
          resumeState: input.resumeState ?? {},
          transcript: [],
          finalizeRequired: input.finalizeRequired ?? true,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (input.executionId) {
        await tx
          .update(agentExecutions)
          .set({
            runtimeSessionId: created.id,
            environmentId: environmentId ?? null,
            lastEventAt: now,
          })
          .where(
            and(
              eq(agentExecutions.id, input.executionId),
              eq(agentExecutions.companyId, input.companyId),
            ),
          );
      }

      return [created];
    });

    eventBus.emitEvent({
      type: 'runtime.session_started' as any,
      companyId: input.companyId,
      payload: { session },
      timestamp: now.toISOString(),
    });

    return session;
  }

  async cancelSession(companyId: string, sessionId: string, reason?: string | null) {
    const { agentRuntimeSessions } = this.db.schema;
    const now = new Date();

    const [session] = await this.db.drizzle
      .update(agentRuntimeSessions)
      .set({
        status: 'cancelled',
        cancellationReason: reason ?? null,
        completedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentRuntimeSessions.id, sessionId), eq(agentRuntimeSessions.companyId, companyId)))
      .returning();

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    eventBus.emitEvent({
      type: 'runtime.session_cancelled' as any,
      companyId,
      payload: { sessionId, reason: reason ?? null },
      timestamp: now.toISOString(),
    });

    return session;
  }

  async finalizeSession(companyId: string, sessionId: string) {
    const { agentRuntimeSessions, executionEnvironments } = this.db.schema;
    const now = new Date();

    const session = await this.db.drizzle.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(agentRuntimeSessions)
        .where(and(eq(agentRuntimeSessions.id, sessionId), eq(agentRuntimeSessions.companyId, companyId)))
        .limit(1);

      if (!existing) {
        throw new Error(`Session ${sessionId} not found`);
      }

      if (existing.status === 'finalized') {
        return existing;
      }

      const [updated] = await tx
        .update(agentRuntimeSessions)
        .set({
          status: 'finalized',
          finalizedAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .where(and(eq(agentRuntimeSessions.id, sessionId), eq(agentRuntimeSessions.companyId, companyId)))
        .returning();

      if (updated.environmentId) {
        const leaseOwnerExecutionPredicate = updated.executionId
          ? eq(executionEnvironments.leaseOwnerExecutionId, updated.executionId)
          : isNull(executionEnvironments.leaseOwnerExecutionId);
        const leaseStartedAt = updated.startedAt ?? now;

        await tx
          .update(executionEnvironments)
          .set({
            status: 'available',
            leaseOwnerAgentId: null,
            leaseOwnerExecutionId: null,
            releasedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(executionEnvironments.id, updated.environmentId),
              eq(executionEnvironments.companyId, companyId),
              eq(executionEnvironments.status, 'leased'),
              eq(executionEnvironments.leaseOwnerAgentId, updated.agentId),
              leaseOwnerExecutionPredicate,
              eq(executionEnvironments.leasedAt, leaseStartedAt),
            ),
          );
      }

      return updated;
    });

    eventBus.emitEvent({
      type: 'runtime.workspace_finalized' as any,
      companyId,
      payload: { sessionId, environmentId: session.environmentId ?? null },
      timestamp: now.toISOString(),
    });

    return session;
  }

  async listSessions(companyId: string) {
    const { agentRuntimeSessions } = this.db.schema;
    return this.db.drizzle
      .select()
      .from(agentRuntimeSessions)
      .where(eq(agentRuntimeSessions.companyId, companyId))
      .orderBy(agentRuntimeSessions.createdAt);
  }
}

function defaultRuntimeAdapterId(provider: string | null | undefined): string {
  return `provider:${provider === 'local' ? 'ollama' : provider ?? 'anthropic'}`;
}
