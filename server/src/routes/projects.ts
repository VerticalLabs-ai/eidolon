import { Router } from 'express';
import { eq, and, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateProjectBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  status: z.enum(['planning', 'active', 'completed', 'archived']).default('planning'),
  repoUrl: z.string().url().nullable().default(null),
});

const UpdateProjectBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: z.enum(['planning', 'active', 'completed', 'archived']).optional(),
  repoUrl: z.string().url().nullable().optional(),
});

const ProjectListQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function projectsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { projects, tasks } = db.schema;

  // GET /api/companies/:companyId/projects - list all projects for a company
  router.get('/', validate(ProjectListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = req.query as unknown as z.infer<typeof ProjectListQuery>;

    const conditions = [eq(projects.companyId, companyId)];

    if (query.status) {
      conditions.push(eq(projects.status, query.status as any));
    }

    const rows = await db.drizzle
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(desc(projects.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(projects)
      .where(and(...conditions));

    res.json({ data: rows, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  // GET /api/companies/:companyId/projects/:id - get single project with counts
  router.get('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [row] = await db.drizzle
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, id),
          eq(projects.companyId, companyId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${id} not found`);
    }

    // Task count for this project
    const [{ taskCount }] = await db.drizzle
      .select({ taskCount: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.projectId, id),
        ),
      );

    // Goal count - goals table does not have projectId yet, so we return 0
    const goalCount = 0;

    // Agent count - count distinct assignee agents from tasks in this project
    const [{ agentCount }] = await db.drizzle
      .select({
        agentCount: sql<number>`count(distinct ${tasks.assigneeAgentId})`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.projectId, id),
          sql`${tasks.assigneeAgentId} is not null`,
        ),
      );

    res.json({
      data: {
        ...row,
        taskCount: Number(taskCount),
        goalCount,
        agentCount: Number(agentCount),
      },
    });
  });

  // POST /api/companies/:companyId/projects - create
  router.post('/', validate(CreateProjectBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateProjectBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const [row] = await db.drizzle
      .insert(projects)
      .values({
        companyId,
        name: body.name,
        description: body.description ?? null,
        status: body.status,
        repoUrl: body.repoUrl,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'project.created',
      companyId,
      payload: { project: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // PATCH /api/companies/:companyId/projects/:id - update
  router.patch('/:id', validate(UpdateProjectBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateProjectBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${id} not found`);
    }

    const [updated] = await db.drizzle
      .update(projects)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'project.updated',
      companyId,
      payload: { project: updated, changes: Object.keys(body) },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: updated });
  });

  // DELETE /api/companies/:companyId/projects/:id - archive
  router.delete('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'PROJECT_NOT_FOUND', `Project ${id} not found`);
    }

    const [archived] = await db.drizzle
      .update(projects)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'project.deleted',
      companyId,
      payload: { project: archived },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: archived });
  });

  return router;
}
