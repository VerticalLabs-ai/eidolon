import { Router } from 'express';
import { eq, and, sql, desc } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateTaskBody = z.object({
  projectId: z.string().uuid().nullable().default(null),
  goalId: z.string().uuid().nullable().default(null),
  parentId: z.string().uuid().nullable().default(null),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  type: z.enum(['feature', 'bug', 'chore', 'spike', 'epic']).default('feature'),
  status: z.enum(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled']).default('backlog'),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  assigneeAgentId: z.string().uuid().nullable().default(null),
  createdByAgentId: z.string().uuid().nullable().default(null),
  createdByUserId: z.string().uuid().nullable().default(null),
  dependencies: z.array(z.string().uuid()).default([]),
  estimatedTokens: z.number().int().nonnegative().nullable().default(null),
  tags: z.array(z.string().min(1).max(50)).default([]),
  dueAt: z.coerce.date().nullable().default(null),
});

const UpdateTaskBody = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50_000).nullable().optional(),
  type: z.enum(['feature', 'bug', 'chore', 'spike', 'epic']).optional(),
  status: z.enum(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled']).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  estimatedTokens: z.number().int().nonnegative().nullable().optional(),
  actualTokens: z.number().int().nonnegative().nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  startedAt: z.coerce.date().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
});

const AssignTaskBody = z.object({
  agentId: z.string().uuid(),
});

const AddCommentBody = z.object({
  authorAgentId: z.string().uuid().nullable().default(null),
  authorUserId: z.string().uuid().nullable().default(null),
  content: z.string().min(1).max(10_000),
});

const TaskListQuery = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  assignee: z.string().uuid().optional(),
  project: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function tasksRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { tasks } = db.schema;

  // GET /api/companies/:companyId/tasks - list with filters
  router.get('/', validate(TaskListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = req.query as unknown as z.infer<typeof TaskListQuery>;

    const conditions = [eq(tasks.companyId, companyId)];

    if (query.status) {
      conditions.push(eq(tasks.status, query.status as any));
    }
    if (query.priority) {
      conditions.push(eq(tasks.priority, query.priority as any));
    }
    if (query.assignee) {
      conditions.push(eq(tasks.assigneeAgentId, query.assignee));
    }
    if (query.project) {
      conditions.push(eq(tasks.projectId, query.project));
    }

    const rows = await db.drizzle
      .select()
      .from(tasks)
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(tasks)
      .where(and(...conditions));

    res.json({ data: rows, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  // GET /api/companies/:companyId/tasks/board - kanban board view
  router.get('/board', async (req, res) => {
    const companyId = routeParams(req).companyId;

    const rows = await db.drizzle
      .select()
      .from(tasks)
      .where(eq(tasks.companyId, companyId))
      .orderBy(desc(tasks.priority), desc(tasks.createdAt));

    const board: Record<string, (typeof rows)[number][]> = {
      backlog: [],
      todo: [],
      in_progress: [],
      review: [],
      done: [],
      cancelled: [],
    };

    for (const row of rows) {
      if (board[row.status]) {
        board[row.status].push(row);
      }
    }

    res.json({ data: board });
  });

  // POST /api/companies/:companyId/tasks - create
  router.post('/', validate(CreateTaskBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateTaskBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    // Auto-increment task number per company
    const [{ maxNum }] = await db.drizzle
      .select({ maxNum: sql<number>`coalesce(max(${tasks.taskNumber}), 0)` })
      .from(tasks)
      .where(eq(tasks.companyId, companyId));

    const taskNumber = Number(maxNum) + 1;
    const identifier = `TASK-${taskNumber}`;

    const [row] = await db.drizzle
      .insert(tasks)
      .values({
        companyId,
        projectId: body.projectId,
        goalId: body.goalId,
        parentId: body.parentId,
        title: body.title,
        description: body.description ?? null,
        type: body.type,
        status: body.status,
        priority: body.priority,
        assigneeAgentId: body.assigneeAgentId,
        createdByAgentId: body.createdByAgentId,
        createdByUserId: body.createdByUserId,
        taskNumber,
        identifier,
        dependencies: body.dependencies,
        estimatedTokens: body.estimatedTokens,
        tags: body.tags,
        dueAt: body.dueAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'task.created',
      companyId,
      payload: { task: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/tasks/:id - get
  router.get('/:id', async (req, res) => {
    const [row] = await db.drizzle
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.id, routeParams(req).id),
          eq(tasks.companyId, routeParams(req).companyId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'TASK_NOT_FOUND', `Task ${routeParams(req).id} not found`);
    }

    res.json({ data: row });
  });

  // PATCH /api/companies/:companyId/tasks/:id - update
  router.patch('/:id', validate(UpdateTaskBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateTaskBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'TASK_NOT_FOUND', `Task ${id} not found`);
    }

    const statusChanged = body.status && body.status !== existing.status;

    // Auto-set timestamps on status transitions
    const extraFields: Record<string, unknown> = {};
    if (body.status === 'in_progress' && !existing.startedAt) {
      extraFields.startedAt = new Date();
    }
    if (body.status === 'done' && !existing.completedAt) {
      extraFields.completedAt = new Date();
    }

    const [updated] = await db.drizzle
      .update(tasks)
      .set({ ...body, ...extraFields, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();

    if (statusChanged) {
      eventBus.emitEvent({
        type: 'task.status_changed',
        companyId,
        payload: {
          taskId: id,
          previousStatus: existing.status,
          newStatus: body.status!,
        },
        timestamp: new Date().toISOString(),
      });
    }

    eventBus.emitEvent({
      type: 'task.updated',
      companyId,
      payload: { task: updated, changes: Object.keys(body) },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: updated });
  });

  // DELETE /api/companies/:companyId/tasks/:id - cancel
  router.delete('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'TASK_NOT_FOUND', `Task ${id} not found`);
    }

    const [cancelled] = await db.drizzle
      .update(tasks)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'task.cancelled',
      companyId,
      payload: { task: cancelled },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: cancelled });
  });

  // POST /api/companies/:companyId/tasks/:id/assign
  router.post('/:id/assign', validate(AssignTaskBody), async (req, res) => {
    const body = req.body as z.infer<typeof AssignTaskBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'TASK_NOT_FOUND', `Task ${id} not found`);
    }

    const [updated] = await db.drizzle
      .update(tasks)
      .set({ assigneeAgentId: body.agentId, updatedAt: new Date() })
      .where(eq(tasks.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'task.assigned',
      companyId,
      payload: {
        taskId: id,
        previousAssignee: existing.assigneeAgentId,
        newAssignee: body.agentId,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ data: updated });
  });

  // POST /api/companies/:companyId/tasks/:id/comments
  router.post('/:id/comments', validate(AddCommentBody), async (req, res) => {
    const body = req.body as z.infer<typeof AddCommentBody>;
    const { id, companyId } = routeParams(req);

    const [existing] = await db.drizzle
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'TASK_NOT_FOUND', `Task ${id} not found`);
    }

    // Store comment in task metadata (since we don't have a comments table yet)
    const currentMeta = (existing as any).metadata ?? {};
    const comments = Array.isArray(currentMeta.comments) ? currentMeta.comments : [];
    const comment = {
      id: crypto.randomUUID(),
      authorAgentId: body.authorAgentId,
      authorUserId: body.authorUserId,
      content: body.content,
      createdAt: new Date().toISOString(),
    };
    comments.push(comment);

    // Tasks table doesn't have metadata column, so we emit the event and return
    // In a production system you'd have a task_comments table
    eventBus.emitEvent({
      type: 'task.commented',
      companyId,
      payload: { taskId: id, comment },
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ data: comment });
  });

  return router;
}
