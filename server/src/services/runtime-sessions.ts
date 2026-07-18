import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../types.js';
import eventBus from '../realtime/events.js';
import {
  isLocalCliAdapterId,
  isProcessRuntimeAdapterId,
  LOCAL_CLI_SUPERVISOR_LEASE_TIMEOUT_MS,
  normalizeLocalCliGraceSec,
  runLocalCliAdapter,
  testProcessRuntimeAdapter,
  type LocalCliTranscriptEntry,
} from './local-cli-adapter.js';
import {
  isRemoteRuntimeAdapterId,
  runRemoteRuntimeAdapter,
  testRemoteRuntimeAdapter,
} from './remote-runtime-adapter.js';

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

export interface RunRuntimeSessionInput {
  prompt: string;
}

const activeRuntimeSessionControllers = new Map<string, AbortController>();
const runtimeProcessOwnerId = randomUUID();
const MAX_PERSISTED_RUNTIME_ENTRIES = 5_000;
const MAX_PERSISTED_RUNTIME_BYTES = 5 * 1024 * 1024;
const RUN_HEARTBEAT_INTERVAL_MS = 5_000;
const RUN_OWNER_RECONCILIATION_BUFFER_MS =
  LOCAL_CLI_SUPERVISOR_LEASE_TIMEOUT_MS + RUN_HEARTBEAT_INTERVAL_MS;

function runtimeSessionProcessKey(companyId: string, sessionId: string): string {
  return `${companyId}:${sessionId}`;
}

function isRunnableRuntimeAdapterId(adapterId: string): boolean {
  return (
    isLocalCliAdapterId(adapterId) ||
    isProcessRuntimeAdapterId(adapterId) ||
    isRemoteRuntimeAdapterId(adapterId)
  );
}

function runtimeAction(
  adapterId: string,
  localAction: string,
  genericAction: string,
): string {
  return isLocalCliAdapterId(adapterId) ? localAction : genericAction;
}

function boundPersistedEntries<T>(entries: T[]): T[] {
  const retained: T[] = [];
  let retainedBytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
    if (
      retained.length >= MAX_PERSISTED_RUNTIME_ENTRIES ||
      retainedBytes + entryBytes > MAX_PERSISTED_RUNTIME_BYTES
    ) {
      break;
    }
    retained.push(entry);
    retainedBytes += entryBytes;
  }
  return retained.reverse();
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
          status: isRunnableRuntimeAdapterId(adapterId) ? 'queued' : 'running',
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

  async runSession(
    companyId: string,
    sessionId: string,
    input: RunRuntimeSessionInput,
  ) {
    const { agentRuntimeSessions, agentExecutions, executionEnvironments } = this.db.schema;
    const [session] = await this.db.drizzle
      .select()
      .from(agentRuntimeSessions)
      .where(and(eq(agentRuntimeSessions.id, sessionId), eq(agentRuntimeSessions.companyId, companyId)))
      .limit(1);

    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!isRunnableRuntimeAdapterId(session.adapterId)) {
      throw new Error(
        `Session ${sessionId} uses unsupported run adapter "${session.adapterId}"`,
      );
    }
    if (session.status === 'running') {
      throw new Error(`Session ${sessionId} is already running`);
    }
    if (['cancelling', 'cancelled', 'finalizing', 'finalized'].includes(session.status)) {
      throw new Error(`Session ${sessionId} cannot run while ${session.status}`);
    }

    const [environment] = session.environmentId
      ? await this.db.drizzle
          .select({ workspacePath: executionEnvironments.workspacePath })
          .from(executionEnvironments)
          .where(
            and(
              eq(executionEnvironments.id, session.environmentId),
              eq(executionEnvironments.companyId, companyId),
            ),
          )
          .limit(1)
      : [];

    const processKey = runtimeSessionProcessKey(companyId, sessionId);
    if (activeRuntimeSessionControllers.has(processKey)) {
      throw new Error(`Session ${sessionId} is already running`);
    }
    const abortController = new AbortController();
    activeRuntimeSessionControllers.set(processKey, abortController);

    const startedAt = new Date();
    try {
      const claimed = await this.db.drizzle.transaction(async (tx) => {
        const [updated] = await tx
          .update(agentRuntimeSessions)
          .set({
            status: 'running',
            completedAt: null,
            resumeState: {
              ...session.resumeState,
              processOwnerId: runtimeProcessOwnerId,
            },
            updatedAt: startedAt,
          })
          .where(
            and(
              eq(agentRuntimeSessions.id, sessionId),
              eq(agentRuntimeSessions.companyId, companyId),
              eq(agentRuntimeSessions.status, session.status),
              eq(agentRuntimeSessions.updatedAt, session.updatedAt),
            ),
          )
          .returning({ id: agentRuntimeSessions.id });
        if (updated && session.executionId) {
          await tx
            .update(agentExecutions)
            .set({
              status: 'running',
              completedAt: null,
              provider: session.adapterId,
              summary: null,
              error: null,
              lastEventAt: startedAt,
              livenessStatus: 'healthy',
              lastUsefulAction: runtimeAction(
                session.adapterId,
                'local_cli_started',
                'runtime_adapter_started',
              ),
              nextActionHint: 'await_runtime_output',
              updatedAt: startedAt,
            })
            .where(
              and(
                eq(agentExecutions.id, session.executionId),
                eq(agentExecutions.companyId, companyId),
                eq(agentExecutions.agentId, session.agentId),
              ),
            );
        }
        return updated;
      });
      if (!claimed) throw new Error(`Session ${sessionId} is already being updated`);
    } catch (error) {
      if (activeRuntimeSessionControllers.get(processKey) === abortController) {
        activeRuntimeSessionControllers.delete(processKey);
      }
      throw error;
    }

    let transcript: LocalCliTranscriptEntry[];
    let resumeState: Record<string, unknown>;
    let status: 'completed' | 'failed';
    let summary: string | null;
    let errorMessage: string | null;
    let cancellationPoll: NodeJS.Timeout | null = null;
    let cancellationCheckInFlight = false;
    let lastHeartbeatAt = startedAt.getTime();

    const abortIfSessionStopped = async () => {
      if (cancellationCheckInFlight || abortController.signal.aborted) return;
      cancellationCheckInFlight = true;
      try {
        const [current] = await this.db.drizzle
          .select({
            status: agentRuntimeSessions.status,
            updatedAt: agentRuntimeSessions.updatedAt,
          })
          .from(agentRuntimeSessions)
          .where(
            and(
              eq(agentRuntimeSessions.id, sessionId),
              eq(agentRuntimeSessions.companyId, companyId),
            ),
          )
          .limit(1);
        if (!current || current.status !== 'running') {
          abortController.abort();
        } else if (Date.now() - lastHeartbeatAt >= RUN_HEARTBEAT_INTERVAL_MS) {
          const heartbeatAt = new Date();
          const [heartbeat] = await this.db.drizzle
            .update(agentRuntimeSessions)
            .set({ updatedAt: heartbeatAt })
            .where(
              and(
                eq(agentRuntimeSessions.id, sessionId),
                eq(agentRuntimeSessions.companyId, companyId),
                eq(agentRuntimeSessions.status, 'running'),
                eq(agentRuntimeSessions.updatedAt, current.updatedAt),
              ),
            )
            .returning({ id: agentRuntimeSessions.id });
          if (!heartbeat) abortController.abort();
          else lastHeartbeatAt = heartbeatAt.getTime();
        }
      } catch {
        // A local process must not outlive Eidolon's ability to verify its
        // durable session claim.
        abortController.abort();
      } finally {
        cancellationCheckInFlight = false;
      }
    };

    try {
      await abortIfSessionStopped();
      cancellationPoll = setInterval(() => {
        void abortIfSessionStopped();
      }, 250);
      cancellationPoll.unref?.();
      const result = isRemoteRuntimeAdapterId(session.adapterId)
        ? await runRemoteRuntimeAdapter({
            adapterId: session.adapterId,
            prompt: input.prompt,
            adapterConfig: session.adapterConfig,
            companyId,
            agentId: session.agentId,
            sessionId,
            resumeState: session.resumeState,
            signal: abortController.signal,
          })
        : await runLocalCliAdapter({
            adapterId: session.adapterId,
            prompt: input.prompt,
            adapterConfig: session.adapterConfig,
            companyId,
            agentId: session.agentId,
            sessionId,
            environmentId: session.environmentId,
            workspacePath: environment?.workspacePath,
            resumeState: session.resumeState,
            signal: abortController.signal,
            leaseHeartbeatAt: () => lastHeartbeatAt,
          });
      transcript = result.transcript;
      resumeState = result.resumeState;
      status = result.ok ? 'completed' : 'failed';
      summary = result.summary;
      errorMessage = result.ok
        ? null
        : String(result.diagnostic.message ?? 'Runtime adapter failed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      transcript = [{
        timestamp: new Date().toISOString(),
        stream: 'system',
        kind: 'diagnostic',
        data: {
          adapterId: session.adapterId,
          message,
        },
      }];
      resumeState = session.resumeState;
      status = 'failed';
      summary = null;
      errorMessage = message;
    } finally {
      if (cancellationPoll) clearInterval(cancellationPoll);
    }

    const persistRunResult = async () => {
      const completedAt = new Date();
      let finalSession: typeof session | undefined;
      for (let attempt = 0; attempt < 3 && !finalSession; attempt += 1) {
        finalSession = await this.db.drizzle.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(agentRuntimeSessions)
            .where(
              and(
                eq(agentRuntimeSessions.id, sessionId),
                eq(agentRuntimeSessions.companyId, companyId),
              ),
            )
            .limit(1);
          if (!current) throw new Error(`Session ${sessionId} not found`);
          const currentOwnerId =
            typeof current.resumeState.processOwnerId === 'string'
              ? current.resumeState.processOwnerId
              : null;
          if (
            !['running', 'cancelling'].includes(current.status) ||
            currentOwnerId !== runtimeProcessOwnerId
          ) {
            return undefined;
          }
          const persistedStatus: 'completed' | 'failed' | 'cancelled' =
            current.status === 'cancelling'
              ? 'cancelled'
              : status;
          const [updated] = await tx
            .update(agentRuntimeSessions)
            .set({
              status: persistedStatus,
              transcript: boundPersistedEntries([
                ...current.transcript,
                ...transcript,
              ]),
              resumeState,
              completedAt,
              updatedAt: completedAt,
            })
            .where(
              and(
                eq(agentRuntimeSessions.id, sessionId),
                eq(agentRuntimeSessions.companyId, companyId),
                eq(agentRuntimeSessions.status, current.status),
                eq(agentRuntimeSessions.updatedAt, current.updatedAt),
              ),
            )
            .returning();
          if (!updated) return undefined;

          if (session.executionId) {
            const executionError =
              persistedStatus === 'cancelled'
                ? `Runtime session cancelled${updated.cancellationReason ? `: ${updated.cancellationReason}` : ''}`
                : errorMessage;
            const [execution] = await tx
              .select({ log: agentExecutions.log })
              .from(agentExecutions)
              .where(
                and(
                  eq(agentExecutions.id, session.executionId),
                  eq(agentExecutions.companyId, companyId),
                  eq(agentExecutions.agentId, session.agentId),
                  eq(agentExecutions.runtimeSessionId, sessionId),
                ),
              )
              .limit(1);
            if (!execution) {
              throw new Error(
                `Linked execution ${session.executionId} is not available for session ${sessionId}`,
              );
            }

            const executionLog = transcript.map((entry) => {
              const content = entry.content ?? JSON.stringify(entry.data ?? {});
              const eventType =
                typeof entry.data?.type === 'string'
                  ? entry.data.type
                  : entry.kind;
              return {
                timestamp: entry.timestamp,
                level:
                  entry.stream === 'stderr' ||
                  (entry.kind === 'diagnostic' && persistedStatus !== 'completed')
                    ? 'error'
                    : 'info',
                message: `${session.adapterId} ${eventType}`,
                phase: 'act' as const,
                iteration: 1,
                content,
              };
            });

            const [updatedExecution] = await tx
              .update(agentExecutions)
              .set({
                status: persistedStatus,
                completedAt,
                provider: session.adapterId,
                summary,
                error: executionError,
                lastEventAt: completedAt,
                livenessStatus: persistedStatus === 'completed' ? 'healthy' : 'stalled',
                lastUsefulAction:
                  persistedStatus === 'completed'
                    ? runtimeAction(
                        session.adapterId,
                        'local_cli_response_recorded',
                        'runtime_adapter_response_recorded',
                      )
                    : persistedStatus === 'cancelled'
                      ? runtimeAction(
                          session.adapterId,
                          'local_cli_cancelled',
                          'runtime_adapter_cancelled',
                        )
                      : runtimeAction(
                          session.adapterId,
                          'local_cli_error_recorded',
                          'runtime_adapter_error_recorded',
                        ),
                nextActionHint:
                  persistedStatus === 'completed'
                    ? 'review_runtime_output'
                    : 'operator_review',
                log: boundPersistedEntries([...execution.log, ...executionLog]),
                updatedAt: completedAt,
              })
              .where(
                and(
                  eq(agentExecutions.id, session.executionId),
                  eq(agentExecutions.companyId, companyId),
                  eq(agentExecutions.agentId, session.agentId),
                  eq(agentExecutions.runtimeSessionId, sessionId),
                ),
              )
              .returning({ id: agentExecutions.id });
            if (!updatedExecution) {
              throw new Error(
                `Linked execution ${session.executionId} changed while session ${sessionId} completed`,
              );
            }
          }
          return updated;
        });
      }
      if (!finalSession) {
        throw new Error(`Session ${sessionId} is already being updated`);
      }

      if (finalSession.status === 'cancelled') {
        eventBus.emitEvent({
          type: 'runtime.session_cancelled',
          companyId,
          payload: {
            sessionId,
            reason: finalSession.cancellationReason,
            status: finalSession.status,
          },
          timestamp: completedAt.toISOString(),
        });
      }

      eventBus.emitEvent({
        type: 'runtime.session_completed',
        companyId,
        payload: {
          sessionId,
          adapterId: session.adapterId,
          status: finalSession.status,
        },
        timestamp: completedAt.toISOString(),
      });

      return finalSession;
    };

    try {
      return await persistRunResult();
    } finally {
      if (activeRuntimeSessionControllers.get(processKey) === abortController) {
        activeRuntimeSessionControllers.delete(processKey);
      }
    }
  }

  async testSessionAdapter(companyId: string, sessionId: string) {
    const { agentRuntimeSessions } = this.db.schema;
    const [session] = await this.db.drizzle
      .select()
      .from(agentRuntimeSessions)
      .where(
        and(
          eq(agentRuntimeSessions.id, sessionId),
          eq(agentRuntimeSessions.companyId, companyId),
        ),
      )
      .limit(1);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (isProcessRuntimeAdapterId(session.adapterId)) {
      return testProcessRuntimeAdapter({
        companyId,
        agentId: session.agentId,
        adapterConfig: session.adapterConfig,
      });
    }
    if (isRemoteRuntimeAdapterId(session.adapterId)) {
      return testRemoteRuntimeAdapter({
        adapterId: session.adapterId,
        adapterConfig: session.adapterConfig,
      });
    }
    throw new Error(
      `Session ${sessionId} uses unsupported test adapter "${session.adapterId}"`,
    );
  }

  async cancelSession(companyId: string, sessionId: string, reason?: string | null) {
    const { agentExecutions, agentRuntimeSessions } = this.db.schema;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date();
      const [existing] = await this.db.drizzle
        .select()
        .from(agentRuntimeSessions)
        .where(
          and(
            eq(agentRuntimeSessions.id, sessionId),
            eq(agentRuntimeSessions.companyId, companyId),
          ),
        )
        .limit(1);

      if (!existing) {
        throw new Error(`Session ${sessionId} not found`);
      }
      if (!['queued', 'running', 'cancelling'].includes(existing.status)) {
        return existing;
      }
      const processOwnerId =
        typeof existing.resumeState.processOwnerId === 'string'
          ? existing.resumeState.processOwnerId
          : null;
      const configuredGraceSec = normalizeLocalCliGraceSec(
        existing.adapterConfig.graceSec,
      );
      const ownerReconciliationDelayMs =
        configuredGraceSec * 1_000 + RUN_OWNER_RECONCILIATION_BUFFER_MS;
      const processKey = runtimeSessionProcessKey(companyId, sessionId);
      const hasActiveLocalController =
        activeRuntimeSessionControllers.has(processKey);
      const hasProcessOwnerOrController =
        Boolean(processOwnerId) || hasActiveLocalController;
      const isForeignLocalOwner =
        isRunnableRuntimeAdapterId(existing.adapterId) &&
        Boolean(processOwnerId) &&
        processOwnerId !== runtimeProcessOwnerId;
      const isOrphanedLocalOwner =
        isRunnableRuntimeAdapterId(existing.adapterId) &&
        processOwnerId === runtimeProcessOwnerId &&
        !hasActiveLocalController;
      const canReconcileExpiredOwner =
        (isForeignLocalOwner || isOrphanedLocalOwner) &&
        now.getTime() - existing.updatedAt.getTime() > ownerReconciliationDelayMs;
      if (
        existing.status === 'cancelling' &&
        hasProcessOwnerOrController &&
        !canReconcileExpiredOwner
      ) {
        activeRuntimeSessionControllers
          .get(processKey)
          ?.abort();
        return existing;
      }
      const waitsForLocalProcess =
        isRunnableRuntimeAdapterId(existing.adapterId) &&
        ['running', 'cancelling'].includes(existing.status) &&
        hasProcessOwnerOrController &&
        !canReconcileExpiredOwner;
      const cancellationStatus = waitsForLocalProcess ? 'cancelling' : 'cancelled';
      const cancellationReason =
        existing.cancellationReason ??
        reason ??
        null;
      const cancellationUpdatedAt =
        existing.status === 'cancelling' || isForeignLocalOwner
          ? existing.updatedAt
          : now;

      const session = await this.db.drizzle.transaction(async (tx) => {
        const [updated] = await tx
          .update(agentRuntimeSessions)
          .set({
            status: cancellationStatus,
            cancellationReason,
            completedAt: waitsForLocalProcess ? null : now,
            updatedAt: cancellationUpdatedAt,
          })
          .where(
            waitsForLocalProcess
              ? and(
                  eq(agentRuntimeSessions.id, sessionId),
                  eq(agentRuntimeSessions.companyId, companyId),
                  eq(agentRuntimeSessions.status, existing.status),
                  eq(agentRuntimeSessions.updatedAt, existing.updatedAt),
                )
              : and(
                  eq(agentRuntimeSessions.id, sessionId),
                  eq(agentRuntimeSessions.companyId, companyId),
                  eq(agentRuntimeSessions.status, existing.status),
                  eq(agentRuntimeSessions.updatedAt, existing.updatedAt),
                ),
          )
          .returning();

        if (updated && cancellationStatus === 'cancelled' && updated.executionId) {
          await tx
            .update(agentExecutions)
            .set({
              status: 'cancelled',
              completedAt: now,
              provider: updated.adapterId,
              error: `Runtime session cancelled${cancellationReason ? `: ${cancellationReason}` : ''}`,
              lastEventAt: now,
              livenessStatus: 'stalled',
              lastUsefulAction: runtimeAction(
                updated.adapterId,
                'local_cli_cancelled',
                'runtime_adapter_cancelled',
              ),
              nextActionHint: 'operator_review',
              updatedAt: now,
            })
            .where(
              and(
                eq(agentExecutions.id, updated.executionId),
                eq(agentExecutions.companyId, companyId),
                eq(agentExecutions.agentId, updated.agentId),
              ),
            );
        }

        return updated;
      });

      if (!session) continue;

      activeRuntimeSessionControllers
        .get(runtimeSessionProcessKey(companyId, sessionId))
        ?.abort();

      eventBus.emitEvent({
        type: (
          waitsForLocalProcess
            ? 'runtime.session_cancelling'
            : 'runtime.session_cancelled'
        ),
        companyId,
        payload: { sessionId, reason: cancellationReason, status: cancellationStatus },
        timestamp: now.toISOString(),
      });

      return session;
    }

    throw new Error(`Session ${sessionId} is already being updated`);
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
      if (
        existing.status === 'cancelling' ||
        (existing.status === 'running' &&
          isRunnableRuntimeAdapterId(existing.adapterId)) ||
        activeRuntimeSessionControllers.has(runtimeSessionProcessKey(companyId, sessionId))
      ) {
        throw new Error(`Session ${sessionId} must be cancelled before it can be finalized`);
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
