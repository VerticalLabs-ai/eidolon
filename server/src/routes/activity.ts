import { Router, type Request } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import eventBus from '../realtime/events.js';
import logger from '../utils/logger.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import type { EidolonEvent } from '../realtime/events.js';

const ActivityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  project: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
});

type ActivityQueryParams = z.infer<typeof ActivityQuery>;
type ValidatedActivityRequest = Request & {
  validated: { query: ActivityQueryParams };
};

export function activityRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { activityLog } = db.schema;

  // GET /api/companies/:companyId/activity
  router.get('/', validate(ActivityQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = (req as ValidatedActivityRequest).validated.query;
    const projectScope = query.project ?? query.projectId;
    const where = projectScope
      ? and(eq(activityLog.companyId, companyId), eq(activityLog.projectId, projectScope))
      : eq(activityLog.companyId, companyId);

    const rows = await db.drizzle
      .select()
      .from(activityLog)
      .where(where)
      .orderBy(desc(activityLog.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(activityLog)
      .where(where);

    res.json({
      data: rows,
      meta: { total: Number(total), limit: query.limit, offset: query.offset },
    });
  });

  return router;
}

export function activityRecordFromEvent(event: EidolonEvent) {
  const payload = event.payload as Record<string, any>;
  let actorType: 'agent' | 'user' | 'system' = 'system';
  let actorId = 'system';
  let entityType = 'unknown';
  let entityId = event.companyId;

  if (event.type.startsWith('agent.')) {
    entityType = 'agent';
    entityId = payload.agentId ?? payload.agent?.id ?? event.companyId;
  } else if (event.type.startsWith('project.')) {
    entityType = 'project';
    entityId = payload.projectId ?? payload.project?.id ?? event.companyId;
  } else if (event.type.startsWith('task.')) {
    entityType = 'task';
    entityId = payload.taskId ?? payload.task?.id ?? event.companyId;
  } else if (event.type.startsWith('company.')) {
    entityType = 'company';
    entityId = event.companyId;
  } else if (event.type.startsWith('goal.')) {
    entityType = 'goal';
    entityId = payload.goalId ?? payload.goal?.id ?? event.companyId;
  } else if (event.type.startsWith('workflow.')) {
    entityType = 'workflow';
    entityId = payload.workflowId ?? payload.workflow?.id ?? event.companyId;
  } else if (event.type.startsWith('message.')) {
    entityType = 'message';
    entityId = payload.message?.id ?? event.companyId;
    actorType = 'agent';
    actorId = payload.message?.fromAgentId ?? 'system';
  } else if (event.type.startsWith('cost.') || event.type.startsWith('budget.')) {
    entityType = 'budget';
    entityId = payload.costEvent?.id ?? payload.alert?.id ?? event.companyId;
  }

  const entityName = payload.project?.name ?? payload.task?.title ?? payload.goal?.title;
  const descriptions: Record<string, string> = {
    'project.created': 'Project created',
    'project.updated': 'Project updated',
    'project.deleted': 'Project archived',
    'task.created': 'Task created',
    'task.updated': 'Task updated',
    'task.cancelled': 'Task cancelled',
    'goal.created': 'Goal created',
    'goal.updated': 'Goal updated',
    'goal.deleted': 'Goal deleted',
  };
  const description = descriptions[event.type] ?? `${event.type.replaceAll('.', ' ')} event`;

  return {
    companyId: event.companyId,
    actorType,
    actorId,
    action: event.type,
    entityType,
    entityId,
    description: entityName ? `${description}: ${entityName}` : description,
    metadata: event.payload as Record<string, unknown>,
    projectId:
      payload.projectId ??
      payload.task?.projectId ??
      payload.project?.id ??
      payload.workflow?.projectId ??
      payload.message?.projectId ??
      payload.goal?.projectId ??
      payload.routine?.projectId ??
      payload.agent?.projectId ??
      null,
    createdAt: new Date(event.timestamp),
  };
}

// ---------------------------------------------------------------------------
// Activity logging helper - listens to events and records them
// ---------------------------------------------------------------------------

export function setupActivityLogger(db: DbInstance): void {
  const { activityLog } = db.schema;

  eventBus.onEvent(async (event) => {
    try {
      await db.drizzle.insert(activityLog).values(activityRecordFromEvent(event));
    } catch (err) {
      // Activity logging should never break the application
      logger.debug({ err }, 'Failed to log activity event');
    }
  });
}
