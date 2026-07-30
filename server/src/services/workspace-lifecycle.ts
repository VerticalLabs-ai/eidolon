import { and, eq, exists, gt, isNull, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

export const WORKSPACE_LEASE_TTL_MS = 30_000;

type WorkspaceClient = DbInstance['drizzle'];

export type WorkspaceLeaseState = 'none' | 'active' | 'stale';
export type WorkspaceLifecycleEventType = 'created' | 'leased' | 'released' | 'finalized' | 'recovered';

export interface WorkspaceLeaseOwner {
  agentId: string;
  executionId: string | null;
}

interface LeaseWorkspaceInput extends WorkspaceLeaseOwner {
  companyId: string;
  environmentId: string;
  baseSha: string | null;
  now?: Date;
}

interface ExactWorkspaceLeaseInput extends WorkspaceLeaseOwner {
  companyId: string;
  environmentId: string;
  leaseId: string;
  now?: Date;
}

interface RecordWorkspaceEventInput {
  companyId: string;
  environmentId: string;
  leaseId?: string | null;
  eventType: WorkspaceLifecycleEventType;
  actorAgentId?: string | null;
  actorExecutionId?: string | null;
  metadata?: Record<string, unknown>;
  now?: Date;
}

export function deriveWorkspaceLeaseState(
  environment: { status: string; leaseId: string | null; leaseExpiresAt: Date | null },
  now = new Date(),
): WorkspaceLeaseState {
  if (environment.status !== 'leased' || !environment.leaseId) return 'none';
  if (!environment.leaseExpiresAt || environment.leaseExpiresAt.getTime() <= now.getTime()) return 'stale';
  return 'active';
}

export async function recordWorkspaceLifecycleEvent(
  db: DbInstance,
  input: RecordWorkspaceEventInput,
) {
  return recordWorkspaceLifecycleEventWithClient(db, db.drizzle, input);
}

export async function recordWorkspaceLifecycleEventWithClient(
  db: DbInstance,
  client: WorkspaceClient,
  input: RecordWorkspaceEventInput,
) {
  const { workspaceLifecycleEvents } = db.schema;
  const [event] = await client
    .insert(workspaceLifecycleEvents)
    .values({
      id: randomUUID(),
      companyId: input.companyId,
      environmentId: input.environmentId,
      leaseId: input.leaseId ?? null,
      eventType: input.eventType,
      actorAgentId: input.actorAgentId ?? null,
      actorExecutionId: input.actorExecutionId ?? null,
      metadata: input.metadata ?? {},
      createdAt: input.now ?? new Date(),
    })
    .returning();
  return event;
}

export async function leaseWorkspace(db: DbInstance, input: LeaseWorkspaceInput) {
  return db.drizzle.transaction((tx) => leaseWorkspaceWithClient(db, tx, input));
}

export async function leaseWorkspaceWithClient(
  db: DbInstance,
  client: WorkspaceClient,
  input: LeaseWorkspaceInput,
) {
  const { agentExecutions, agents, executionEnvironments } = db.schema;
  const now = input.now ?? new Date();
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + WORKSPACE_LEASE_TTL_MS);

  // Lease owners are foreign keys, so their existence is enforced in the same statement
  // that writes them. Otherwise a concurrent delete turns leasing into an FK violation.
  const agentExistsPredicate = exists(
    client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId))),
  );
  const executionExistsPredicate = input.executionId
    ? exists(
        client
          .select({ id: agentExecutions.id })
          .from(agentExecutions)
          .where(
            and(
              eq(agentExecutions.id, input.executionId),
              eq(agentExecutions.companyId, input.companyId),
              eq(agentExecutions.agentId, input.agentId),
            ),
          ),
      )
    : undefined;

  const [environment] = await client
    .update(executionEnvironments)
    .set({
      status: 'leased',
      leaseOwnerAgentId: input.agentId,
      leaseOwnerExecutionId: input.executionId,
      leaseId,
      leasedAt: now,
      leaseHeartbeatAt: now,
      leaseExpiresAt,
      leaseBaseSha: input.baseSha,
      releasedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(executionEnvironments.id, input.environmentId),
        eq(executionEnvironments.companyId, input.companyId),
        eq(executionEnvironments.status, 'available'),
        agentExistsPredicate,
        executionExistsPredicate,
      ),
    )
    .returning();

  if (!environment) {
    const [existing] = await client
      .select({ id: executionEnvironments.id })
      .from(executionEnvironments)
      .where(
        and(
          eq(executionEnvironments.id, input.environmentId),
          eq(executionEnvironments.companyId, input.companyId),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${input.environmentId} not found`);
    }

    const [agent] = await client
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)))
      .limit(1);
    if (!agent) {
      throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${input.agentId} not found`);
    }

    if (input.executionId) {
      const [execution] = await client
        .select({ id: agentExecutions.id })
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
        throw new AppError(
          404,
          'EXECUTION_NOT_FOUND',
          `Execution ${input.executionId} not found for agent ${input.agentId}`,
        );
      }
    }

    throw new AppError(409, 'WORKSPACE_LEASE_CONFLICT', `Environment ${input.environmentId} is already leased`);
  }

  await recordWorkspaceLifecycleEventWithClient(db, client, {
    companyId: input.companyId,
    environmentId: input.environmentId,
    leaseId,
    eventType: 'leased',
    actorAgentId: input.agentId,
    actorExecutionId: input.executionId,
    metadata: { baseSha: input.baseSha },
    now,
  });

  if (input.executionId) {
    await client
      .update(agentExecutions)
      .set({ environmentId: input.environmentId, lastEventAt: now })
      .where(
        and(
          eq(agentExecutions.id, input.executionId),
          eq(agentExecutions.companyId, input.companyId),
          eq(agentExecutions.agentId, input.agentId),
        ),
      );
  }

  return environment;
}

export async function requireActiveWorkspaceLease(
  db: DbInstance,
  input: ExactWorkspaceLeaseInput,
) {
  return requireActiveWorkspaceLeaseWithClient(db, db.drizzle, input);
}

export async function findActiveWorkspaceLeaseForOwnerWithClient(
  db: DbInstance,
  client: WorkspaceClient,
  input: Omit<ExactWorkspaceLeaseInput, 'leaseId'>,
) {
  const { executionEnvironments } = db.schema;
  const now = input.now ?? new Date();
  const executionPredicate = input.executionId
    ? eq(executionEnvironments.leaseOwnerExecutionId, input.executionId)
    : isNull(executionEnvironments.leaseOwnerExecutionId);
  const [environment] = await client
    .select()
    .from(executionEnvironments)
    .where(
      and(
        eq(executionEnvironments.id, input.environmentId),
        eq(executionEnvironments.companyId, input.companyId),
        eq(executionEnvironments.status, 'leased'),
        eq(executionEnvironments.leaseOwnerAgentId, input.agentId),
        executionPredicate,
        gt(executionEnvironments.leaseExpiresAt, now),
      ),
    )
    .limit(1);
  if (!environment?.leaseId) {
    throw new AppError(409, 'WORKSPACE_LEASE_EXPIRED', `Environment ${input.environmentId} has no active owned lease`);
  }
  return environment;
}

export async function requireActiveWorkspaceLeaseWithClient(
  db: DbInstance,
  client: WorkspaceClient,
  input: ExactWorkspaceLeaseInput,
) {
  const { executionEnvironments } = db.schema;
  const now = input.now ?? new Date();
  const executionPredicate = input.executionId
    ? eq(executionEnvironments.leaseOwnerExecutionId, input.executionId)
    : isNull(executionEnvironments.leaseOwnerExecutionId);
  const [environment] = await client
    .select()
    .from(executionEnvironments)
    .where(
      and(
        eq(executionEnvironments.id, input.environmentId),
        eq(executionEnvironments.companyId, input.companyId),
        eq(executionEnvironments.status, 'leased'),
        eq(executionEnvironments.leaseId, input.leaseId),
        eq(executionEnvironments.leaseOwnerAgentId, input.agentId),
        executionPredicate,
        gt(executionEnvironments.leaseExpiresAt, now),
      ),
    )
    .limit(1);
  if (environment) return environment;
  throw new AppError(409, 'WORKSPACE_LEASE_EXPIRED', `Workspace lease ${input.leaseId} is no longer active`);
}

export async function renewWorkspaceLease(db: DbInstance, input: ExactWorkspaceLeaseInput) {
  return renewWorkspaceLeaseWithClient(db, db.drizzle, input);
}

export async function renewWorkspaceLeaseWithClient(
  db: DbInstance,
  client: WorkspaceClient,
  input: ExactWorkspaceLeaseInput,
) {
  const { executionEnvironments } = db.schema;
  const now = input.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + WORKSPACE_LEASE_TTL_MS);
  const executionPredicate = input.executionId
    ? eq(executionEnvironments.leaseOwnerExecutionId, input.executionId)
    : isNull(executionEnvironments.leaseOwnerExecutionId);
  const [environment] = await client
    .update(executionEnvironments)
    .set({ leaseHeartbeatAt: now, leaseExpiresAt, updatedAt: now })
    .where(
      and(
        eq(executionEnvironments.id, input.environmentId),
        eq(executionEnvironments.companyId, input.companyId),
        eq(executionEnvironments.status, 'leased'),
        eq(executionEnvironments.leaseId, input.leaseId),
        eq(executionEnvironments.leaseOwnerAgentId, input.agentId),
        executionPredicate,
        gt(executionEnvironments.leaseExpiresAt, now),
      ),
    )
    .returning();
  if (!environment) {
    throw new AppError(409, 'WORKSPACE_LEASE_EXPIRED', `Workspace lease ${input.leaseId} is no longer active`);
  }
  return environment;
}

export async function releaseWorkspaceLease(
  db: DbInstance,
  input: ExactWorkspaceLeaseInput & { eventType?: 'released' | 'finalized' },
) {
  return db.drizzle.transaction((tx) => releaseWorkspaceLeaseWithClient(db, tx, input));
}

export async function releaseWorkspaceLeaseWithClient(
  db: DbInstance,
  client: WorkspaceClient,
  input: ExactWorkspaceLeaseInput & { eventType?: 'released' | 'finalized' },
) {
  const { agentExecutions, executionEnvironments } = db.schema;
  const now = input.now ?? new Date();
  const executionPredicate = input.executionId
    ? eq(executionEnvironments.leaseOwnerExecutionId, input.executionId)
    : isNull(executionEnvironments.leaseOwnerExecutionId);
  const [environment] = await client
    .update(executionEnvironments)
    .set({
      status: 'available',
      leaseOwnerAgentId: null,
      leaseOwnerExecutionId: null,
      leaseId: null,
      leaseHeartbeatAt: null,
      leaseExpiresAt: null,
      leaseBaseSha: null,
      releasedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(executionEnvironments.id, input.environmentId),
        eq(executionEnvironments.companyId, input.companyId),
        eq(executionEnvironments.status, 'leased'),
        eq(executionEnvironments.leaseId, input.leaseId),
        eq(executionEnvironments.leaseOwnerAgentId, input.agentId),
        executionPredicate,
      ),
    )
    .returning();
  if (!environment) {
    throw new AppError(409, 'WORKSPACE_LEASE_CONFLICT', `Workspace lease ${input.leaseId} is not owned by this caller`);
  }

  await recordWorkspaceLifecycleEventWithClient(db, client, {
    companyId: input.companyId,
    environmentId: input.environmentId,
    leaseId: input.leaseId,
    eventType: input.eventType ?? 'released',
    actorAgentId: input.agentId,
    actorExecutionId: input.executionId,
    now,
  });
  if (input.executionId) {
    await client
      .update(agentExecutions)
      .set({ environmentId: null, lastEventAt: now })
      .where(
        and(
          eq(agentExecutions.id, input.executionId),
          eq(agentExecutions.companyId, input.companyId),
          eq(agentExecutions.agentId, input.agentId),
          eq(agentExecutions.environmentId, input.environmentId),
        ),
      );
  }
  return environment;
}

export async function recoverWorkspaceLease(
  db: DbInstance,
  input: {
    companyId: string;
    environmentId: string;
    recoveredByUserId?: string | null;
    now?: Date;
  },
) {
  const { agentExecutions, executionEnvironments } = db.schema;
  const now = input.now ?? new Date();
  return db.drizzle.transaction(async (tx) => {
    const [stale] = await tx
      .select()
      .from(executionEnvironments)
      .where(
        and(
          eq(executionEnvironments.id, input.environmentId),
          eq(executionEnvironments.companyId, input.companyId),
          eq(executionEnvironments.status, 'leased'),
          lte(executionEnvironments.leaseExpiresAt, now),
        ),
      )
      .limit(1);
    if (!stale) {
      const [existing] = await tx
        .select({ id: executionEnvironments.id })
        .from(executionEnvironments)
        .where(
          and(
            eq(executionEnvironments.id, input.environmentId),
            eq(executionEnvironments.companyId, input.companyId),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${input.environmentId} not found`);
      }
      throw new AppError(409, 'WORKSPACE_LEASE_NOT_STALE', `Environment ${input.environmentId} does not have a stale lease`);
    }
    if (!stale.leaseId) {
      throw new AppError(409, 'WORKSPACE_LEASE_CONFLICT', `Environment ${input.environmentId} has no recoverable lease token`);
    }

    const [environment] = await tx
      .update(executionEnvironments)
      .set({
        status: 'available',
        leaseOwnerAgentId: null,
        leaseOwnerExecutionId: null,
        leaseId: null,
        leaseHeartbeatAt: null,
        leaseExpiresAt: null,
        leaseBaseSha: null,
        releasedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(executionEnvironments.id, input.environmentId),
          eq(executionEnvironments.companyId, input.companyId),
          eq(executionEnvironments.status, 'leased'),
          eq(executionEnvironments.leaseId, stale.leaseId),
          lte(executionEnvironments.leaseExpiresAt, now),
        ),
      )
      .returning();
    if (!environment) {
      throw new AppError(409, 'WORKSPACE_LEASE_CONFLICT', `Environment ${input.environmentId} changed during recovery`);
    }

    if (stale.leaseOwnerExecutionId) {
      await tx
        .update(agentExecutions)
        .set({ environmentId: null, lastEventAt: now })
        .where(
          and(
            eq(agentExecutions.id, stale.leaseOwnerExecutionId),
            eq(agentExecutions.companyId, input.companyId),
            eq(agentExecutions.environmentId, input.environmentId),
          ),
        );
    }

    await recordWorkspaceLifecycleEventWithClient(db, tx, {
      companyId: input.companyId,
      environmentId: input.environmentId,
      leaseId: stale.leaseId,
      eventType: 'recovered',
      metadata: {
        expiredAt: stale.leaseExpiresAt?.toISOString() ?? null,
        formerOwnerAgentId: stale.leaseOwnerAgentId,
        formerOwnerExecutionId: stale.leaseOwnerExecutionId,
        recoveredByUserId: input.recoveredByUserId ?? null,
      },
      now,
    });
    return environment;
  });
}
