import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateGoalBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(5000).optional(),
  level: z.enum(['company', 'department', 'team', 'individual']).default('company'),
  status: z.enum(['draft', 'active', 'completed', 'cancelled']).default('draft'),
  parentId: z.string().uuid().nullable().default(null),
  projectId: z.string().uuid().nullable().default(null),
  ownerAgentId: z.string().uuid().nullable().default(null),
  progress: z.number().int().min(0).max(100).default(0),
  targetDate: z.coerce.date().nullable().default(null),
  metrics: z.record(z.unknown()).default({}),
});

const UpdateGoalBody = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  level: z.enum(['company', 'department', 'team', 'individual']).optional(),
  status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional(),
  parentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  progress: z.number().int().min(0).max(100).optional(),
  targetDate: z.coerce.date().nullable().optional(),
  metrics: z.record(z.unknown()).optional(),
});

type GoalLevel = z.infer<typeof CreateGoalBody>['level'];

const GOAL_LEVEL_RANK: Record<GoalLevel, number> = {
  company: 0,
  department: 1,
  team: 2,
  individual: 3,
};

export function goalsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { agents, goals, projects } = db.schema;

  const GoalListQuery = z.object({
    project: z.string().uuid().optional(),
  });

  async function validateGoalReferences({
    companyId,
    goalId,
    ownerAgentId,
    parentId,
    level,
    projectId,
  }: {
    companyId: string;
    goalId?: string;
    ownerAgentId?: string | null;
    parentId?: string | null;
    level?: GoalLevel;
    projectId?: string | null;
  }) {
    if (projectId !== undefined && projectId !== null) {
      const [project] = await db.drizzle
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
        .limit(1);

      if (!project) {
        throw new AppError(
          400,
          'GOAL_PROJECT_INVALID',
          'Choose a project from this company.',
        );
      }
    }

    if (parentId !== undefined || (goalId && level !== undefined)) {
      const companyGoals = await db.drizzle
        .select({ id: goals.id, parentId: goals.parentId, level: goals.level })
        .from(goals)
        .where(eq(goals.companyId, companyId));
      const goalsById = new Map(companyGoals.map((goal) => [goal.id, goal]));

      if (parentId !== undefined && parentId !== null) {
        const parent = goalsById.get(parentId);
        if (!parent) {
          throw new AppError(
            400,
            'GOAL_PARENT_INVALID',
            'Choose a parent goal from this company.',
          );
        }

        let ancestorId: string | null = parentId;
        const visited = new Set<string>();
        while (ancestorId) {
          if (ancestorId === goalId || visited.has(ancestorId)) {
            throw new AppError(
              400,
              'GOAL_PARENT_CYCLE',
              'A goal cannot be its own parent or a child of one of its descendants.',
            );
          }
          visited.add(ancestorId);
          ancestorId = goalsById.get(ancestorId)?.parentId ?? null;
        }

        if (level !== undefined && GOAL_LEVEL_RANK[level] <= GOAL_LEVEL_RANK[parent.level]) {
          throw new AppError(
            400,
            'GOAL_LEVEL_INVALID',
            'A child goal must use a level below its parent.',
          );
        }
      }

      if (
        goalId
        && level !== undefined
        && companyGoals.some(
          (goal) => goal.parentId === goalId && GOAL_LEVEL_RANK[goal.level] <= GOAL_LEVEL_RANK[level],
        )
      ) {
        throw new AppError(
          400,
          'GOAL_LEVEL_INVALID',
          'A parent goal must use a level above each child.',
        );
      }
    }

    if (ownerAgentId !== undefined && ownerAgentId !== null) {
      const [owner] = await db.drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, ownerAgentId), eq(agents.companyId, companyId)))
        .limit(1);

      if (!owner) {
        throw new AppError(
          400,
          'GOAL_OWNER_INVALID',
          'Choose an owner from this company.',
        );
      }
    }
  }

  // GET /api/companies/:companyId/goals
  router.get('/', validate(GoalListQuery, 'query'), async (req, res) => {
    const query = req.query as unknown as z.infer<typeof GoalListQuery>;
    const conditions = [eq(goals.companyId, routeParams(req).companyId)];
    if (query.project) conditions.push(eq(goals.projectId, query.project));

    const rows = await db.drizzle
      .select()
      .from(goals)
      .where(and(...conditions));
    res.json({ data: rows });
  });

  // GET /api/companies/:companyId/goals/tree
  router.get('/tree', validate(GoalListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = req.query as unknown as z.infer<typeof GoalListQuery>;
    const conditions = [eq(goals.companyId, companyId)];
    if (query.project) conditions.push(eq(goals.projectId, query.project));

    const allGoals = await db.drizzle
      .select()
      .from(goals)
      .where(and(...conditions));

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

    await validateGoalReferences({
      companyId,
      ownerAgentId: body.ownerAgentId,
      parentId: body.parentId,
      level: body.level,
      projectId: body.projectId,
    });

    const [row] = await db.drizzle
      .insert(goals)
      .values({
        companyId,
        title: body.title,
        description: body.description ?? null,
        projectId: body.projectId,
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

    const relationChanged = body.parentId !== undefined || body.level !== undefined;
    await validateGoalReferences({
      companyId,
      goalId: id,
      ownerAgentId: body.ownerAgentId,
      projectId: body.projectId,
      parentId: relationChanged
        ? body.parentId !== undefined ? body.parentId : existing.parentId
        : undefined,
      level: relationChanged ? body.level ?? existing.level : undefined,
    });

    const progressChanged =
      body.progress !== undefined && body.progress !== existing.progress;

    const [updated] = await db.drizzle
      .update(goals)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(goals.id, id), eq(goals.companyId, companyId)))
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
