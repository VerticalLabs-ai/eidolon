import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateGoalBody = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  level: z.enum(['company', 'department', 'team', 'individual']).default('company'),
  status: z.enum(['draft', 'active', 'completed', 'cancelled']).default('draft'),
  parentId: z.string().uuid().nullable().default(null),
  ownerAgentId: z.string().uuid().nullable().default(null),
  progress: z.number().int().min(0).max(100).default(0),
  targetDate: z.coerce.date().nullable().default(null),
  metrics: z.record(z.unknown()).default({}),
});

const UpdateGoalBody = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  level: z.enum(['company', 'department', 'team', 'individual']).optional(),
  status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional(),
  parentId: z.string().uuid().nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  targetDate: z.coerce.date().nullable().optional(),
  metrics: z.record(z.unknown()).optional(),
});

export function goalsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { goals } = db.schema;

  // GET /api/companies/:companyId/goals
  router.get('/', async (req, res) => {
    const rows = await db.drizzle
      .select()
      .from(goals)
      .where(eq(goals.companyId, routeParams(req).companyId));
    res.json({ data: rows });
  });

  // GET /api/companies/:companyId/goals/tree
  router.get('/tree', async (req, res) => {
    const companyId = routeParams(req).companyId;
    const allGoals = await db.drizzle
      .select()
      .from(goals)
      .where(eq(goals.companyId, companyId));

    type GoalNode = (typeof allGoals)[number] & { children: GoalNode[] };
    const nodeMap = new Map<string, GoalNode>();
    const roots: GoalNode[] = [];

    for (const g of allGoals) {
      nodeMap.set(g.id, { ...g, children: [] });
    }

    for (const g of allGoals) {
      const node = nodeMap.get(g.id)!;
      if (g.parentId && nodeMap.has(g.parentId)) {
        nodeMap.get(g.parentId)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    res.json({ data: roots });
  });

  // POST /api/companies/:companyId/goals
  router.post('/', validate(CreateGoalBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateGoalBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const [row] = await db.drizzle
      .insert(goals)
      .values({
        companyId,
        title: body.title,
        description: body.description ?? null,
        level: body.level,
        status: body.status,
        parentId: body.parentId,
        ownerAgentId: body.ownerAgentId,
        progress: body.progress,
        targetDate: body.targetDate,
        metrics: body.metrics,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'goal.created',
      companyId,
      payload: { goal: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/goals/:id
  router.get('/:id', async (req, res) => {
    const [row] = await db.drizzle
      .select()
      .from(goals)
      .where(
        and(
          eq(goals.id, routeParams(req).id),
          eq(goals.companyId, routeParams(req).companyId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'GOAL_NOT_FOUND', `Goal ${routeParams(req).id} not found`);
    }
    res.json({ data: row });
  });

  // PATCH /api/companies/:companyId/goals/:id
  router.patch('/:id', validate(UpdateGoalBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateGoalBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'GOAL_NOT_FOUND', `Goal ${id} not found`);
    }

    const progressChanged =
      body.progress !== undefined && body.progress !== existing.progress;

    const [updated] = await db.drizzle
      .update(goals)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(goals.id, id))
      .returning();

    if (progressChanged) {
      eventBus.emitEvent({
        type: 'goal.progress_changed',
        companyId,
        payload: {
          goalId: id,
          previousProgress: existing.progress,
          newProgress: body.progress!,
        },
        timestamp: new Date().toISOString(),
      });
    }

    eventBus.emitEvent({
      type: 'goal.updated',
      companyId,
      payload: { goal: updated, changes: Object.keys(body) },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: updated });
  });

  // DELETE /api/companies/:companyId/goals/:id
  router.delete('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(goals)
      .where(and(eq(goals.id, id), eq(goals.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'GOAL_NOT_FOUND', `Goal ${id} not found`);
    }

    await db.drizzle.delete(goals).where(eq(goals.id, id));

    eventBus.emitEvent({
      type: 'goal.deleted',
      companyId,
      payload: { goalId: id },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: { deleted: true, id } });
  });

  return router;
}
