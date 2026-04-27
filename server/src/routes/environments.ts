import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateEnvironmentBody = z.object({
  name: z.string().min(1).max(255),
  workspacePath: z.string().max(2000).optional(),
  branchName: z.string().max(255).optional(),
  runtimeUrl: z.string().url().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const LeaseEnvironmentBody = z.object({
  agentId: z.string().uuid(),
  executionId: z.string().uuid().optional(),
});

const ReleaseEnvironmentBody = z.object({
  agentId: z.string().uuid().optional(),
  executionId: z.string().uuid().optional(),
});

const AssignEnvironmentBody = z.object({
  agentId: z.string().uuid(),
});

const EnvironmentListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function environmentsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { executionEnvironments, agents } = db.schema;

  router.get('/', validate(EnvironmentListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = (req as any).validated.query as z.infer<typeof EnvironmentListQuery>;
    const rows = await db.drizzle
      .select()
      .from(executionEnvironments)
      .where(eq(executionEnvironments.companyId, companyId))
      .orderBy(executionEnvironments.createdAt)
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(executionEnvironments)
      .where(eq(executionEnvironments.companyId, companyId));

    res.json({ data: rows, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  router.post('/', validate(CreateEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateEnvironmentBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const [row] = await db.drizzle
      .insert(executionEnvironments)
      .values({
        id: randomUUID(),
        companyId,
        name: body.name,
        provider: 'local',
        status: 'available',
        workspacePath: body.workspacePath ?? null,
        branchName: body.branchName ?? null,
        runtimeUrl: body.runtimeUrl ?? null,
        metadata: body.metadata,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'environment.created',
      companyId,
      payload: { environment: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  router.post('/:id/lease', validate(LeaseEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof LeaseEnvironmentBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();

    const [row] = await db.drizzle
      .update(executionEnvironments)
      .set({
        status: 'leased',
        leaseOwnerAgentId: body.agentId,
        leaseOwnerExecutionId: body.executionId ?? null,
        leasedAt: now,
        releasedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(executionEnvironments.id, id),
          eq(executionEnvironments.companyId, companyId),
          eq(executionEnvironments.status, 'available'),
          sql`EXISTS (
            SELECT 1
            FROM agents
            WHERE agents.id = ${body.agentId}
              AND agents.company_id = ${companyId}
          )`,
        ),
      )
      .returning();

    if (!row) {
      const [agent] = await db.drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, body.agentId), eq(agents.companyId, companyId)))
        .limit(1);

      if (!agent) {
        throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${body.agentId} not found`);
      }

      const [environment] = await db.drizzle
        .select({ id: executionEnvironments.id })
        .from(executionEnvironments)
        .where(
          and(
            eq(executionEnvironments.id, id),
            eq(executionEnvironments.companyId, companyId),
          ),
        )
        .limit(1);

      if (!environment) {
        throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${id} not found`);
      }

      throw new AppError(409, 'ENVIRONMENT_NOT_AVAILABLE', `Environment ${id} is not available`);
    }

    eventBus.emitEvent({
      type: 'environment.leased',
      companyId,
      payload: { environment: row },
      timestamp: now.toISOString(),
    });

    res.json({ data: row });
  });

  router.post('/:id/release', validate(ReleaseEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof ReleaseEnvironmentBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();

    if (!body.agentId && !body.executionId) {
      throw new AppError(
        400,
        'ENVIRONMENT_RELEASE_OWNER_REQUIRED',
        'Releasing an environment requires an agentId or executionId',
      );
    }

    const ownerPredicates = [
      body.agentId ? eq(executionEnvironments.leaseOwnerAgentId, body.agentId) : undefined,
      body.executionId ? eq(executionEnvironments.leaseOwnerExecutionId, body.executionId) : undefined,
    ].filter((check): check is NonNullable<typeof check> => Boolean(check));
    // When both owner identifiers are provided, require both to match the active lease.
    const ownerPredicate =
      ownerPredicates.length > 1 ? and(...ownerPredicates) : ownerPredicates[0]!;

    const [row] = await db.drizzle
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
          eq(executionEnvironments.id, id),
          eq(executionEnvironments.companyId, companyId),
          eq(executionEnvironments.status, 'leased'),
          ownerPredicate,
        ),
      )
      .returning();

    if (!row) {
      const [environment] = await db.drizzle
        .select({ id: executionEnvironments.id })
        .from(executionEnvironments)
        .where(
          and(
            eq(executionEnvironments.id, id),
            eq(executionEnvironments.companyId, companyId),
          ),
        )
        .limit(1);

      if (!environment) {
        throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${id} not found`);
      }

      throw new AppError(
        409,
        'ENVIRONMENT_LEASE_OWNER_MISMATCH',
        `Environment ${id} can only be released by its lease owner`,
      );
    }

    eventBus.emitEvent({
      type: 'environment.released',
      companyId,
      payload: { environment: row },
      timestamp: now.toISOString(),
    });

    res.json({ data: row });
  });

  router.post('/:id/assign', validate(AssignEnvironmentBody), async (req, res) => {
    const body = req.body as z.infer<typeof AssignEnvironmentBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();

    const [environment] = await db.drizzle
      .select({ id: executionEnvironments.id })
      .from(executionEnvironments)
      .where(
        and(
          eq(executionEnvironments.id, id),
          eq(executionEnvironments.companyId, companyId),
        ),
      )
      .limit(1);

    if (!environment) {
      throw new AppError(404, 'ENVIRONMENT_NOT_FOUND', `Environment ${id} not found`);
    }

    const [agent] = await db.drizzle
      .update(agents)
      .set({ defaultEnvironmentId: id, updatedAt: now })
      .where(and(eq(agents.id, body.agentId), eq(agents.companyId, companyId)))
      .returning();

    if (!agent) {
      throw new AppError(404, 'AGENT_NOT_FOUND', `Agent ${body.agentId} not found`);
    }

    eventBus.emitEvent({
      type: 'environment.assigned',
      companyId,
      payload: { agentId: agent.id, environmentId: id },
      timestamp: now.toISOString(),
    });

    res.json({ data: { agent, environment } });
  });

  return router;
}
