import { Router } from 'express';
import { eq, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import eventBus from '../realtime/events.js';
import logger from '../utils/logger.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const ActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function activityRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { activityLog } = db.schema;

  // GET /api/companies/:companyId/activity
  router.get('/', async (req, res) => {
    const companyId = routeParams(req).companyId;
    const parsed = ActivityQuery.safeParse(req.query);
    const query = parsed.success ? parsed.data : { limit: 50, offset: 0 };

    const rows = await db.drizzle
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(desc(activityLog.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId));

    res.json({
      data: rows,
      meta: { total: Number(total), limit: query.limit, offset: query.offset },
    });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Activity logging helper - listens to events and records them
// ---------------------------------------------------------------------------

export function setupActivityLogger(db: DbInstance): void {
  const { activityLog } = db.schema;

  eventBus.onEvent(async (event) => {
    try {
      let actorType: 'agent' | 'user' | 'system' = 'system';
      let actorId = 'system';
      let entityType = 'unknown';
      let entityId = event.companyId;

      if (event.type.startsWith('agent.')) {
        entityType = 'agent';
        entityId = (event.payload as any).agentId ?? (event.payload as any).agent?.id ?? event.companyId;
      } else if (event.type.startsWith('task.')) {
        entityType = 'task';
        entityId = (event.payload as any).taskId ?? (event.payload as any).task?.id ?? event.companyId;
      } else if (event.type.startsWith('company.')) {
        entityType = 'company';
        entityId = event.companyId;
      } else if (event.type.startsWith('goal.')) {
        entityType = 'goal';
        entityId = (event.payload as any).goalId ?? (event.payload as any).goal?.id ?? event.companyId;
      } else if (event.type.startsWith('workflow.')) {
        entityType = 'workflow';
        entityId = (event.payload as any).workflowId ?? (event.payload as any).workflow?.id ?? event.companyId;
      } else if (event.type.startsWith('message.')) {
        entityType = 'message';
        entityId = (event.payload as any).message?.id ?? event.companyId;
        actorType = 'agent';
        actorId = (event.payload as any).message?.fromAgentId ?? 'system';
      } else if (event.type.startsWith('cost.') || event.type.startsWith('budget.')) {
        entityType = 'budget';
        entityId = (event.payload as any).costEvent?.id ?? (event.payload as any).alert?.id ?? event.companyId;
      }

      await db.drizzle.insert(activityLog).values({
        companyId: event.companyId,
        actorType,
        actorId,
        action: event.type,
        entityType,
        entityId,
        description: `${event.type} event`,
        metadata: event.payload as Record<string, unknown>,
        createdAt: new Date(event.timestamp),
      });
    } catch (err) {
      // Activity logging should never break the application
      logger.debug({ err }, 'Failed to log activity event');
    }
  });
}
