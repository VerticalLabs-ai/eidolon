import { Router, type Request } from 'express';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
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
  status: z.enum(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled', 'timed_out']).default('backlog'),
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
  status: z.enum(['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled', 'timed_out']).optional(),
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

const CreateThreadCommentBody = z.object({
  content: z.string().min(1).max(20_000),
  authorAgentId: z.string().uuid().nullable().default(null),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

const CreateInteractionBody = z.object({
  interactionType: z.enum(['suggested_tasks', 'confirmation', 'form']),
  content: z.string().min(1).max(20_000),
  payload: z.record(z.unknown()).default({}),
  idempotencyKey: z.string().min(1).max(255).optional(),
  authorAgentId: z.string().uuid().nullable().default(null),
});

const InteractionDecisionBody = z.object({
  note: z.string().max(10_000).optional(),
  answers: z.record(z.unknown()).optional(),
});

const SubtreeControlBody = z.object({
  reason: z.string().max(10_000).optional(),
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
  const {
    tasks,
    agents,
    approvals,
    agentExecutions,
    taskThreadItems,
    taskHolds,
  } = db.schema;

  async function getTaskOrThrow(companyId: string, id: string) {
    const [row] = await db.drizzle
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.companyId, companyId)))
      .limit(1);

    if (!row) {
      throw new AppError(404, 'TASK_NOT_FOUND', `Task ${id} not found`);
    }

    return row;
  }

  async function fetchSubtree(companyId: string, rootTaskId: string) {
    const rows = await db.drizzle
      .select()
      .from(tasks)
      .where(eq(tasks.companyId, companyId));
    const byParent = new Map<string | null, typeof rows>();
    for (const row of rows) {
      const key = row.parentId ?? null;
      const bucket = byParent.get(key) ?? [];
      bucket.push(row);
      byParent.set(key, bucket);
    }

    const result: typeof rows = [];
    const visit = (id: string) => {
      const row = rows.find((candidate) => candidate.id === id);
      if (row) result.push(row);
      for (const child of byParent.get(id) ?? []) visit(child.id);
    };
    visit(rootTaskId);
    return result;
  }

  async function wakeDependentsIfUnblocked(companyId: string, completedTaskId: string) {
    const companyTasks = await db.drizzle
      .select()
      .from(tasks)
      .where(eq(tasks.companyId, companyId));
    const statusById = new Map(companyTasks.map((task) => [task.id, task.status]));
    const dependentTasks = companyTasks.filter((task) =>
      Array.isArray(task.dependencies) && task.dependencies.includes(completedTaskId),
    );

    for (const task of dependentTasks) {
      const dependencies = Array.isArray(task.dependencies) ? task.dependencies : [];
      const unblocked = dependencies.every((dependencyId) => statusById.get(dependencyId) === 'done');
      if (!unblocked || !task.assigneeAgentId) continue;

      await db.drizzle
        .update(agents)
        .set({ status: 'idle', lastHeartbeatAt: null, updatedAt: new Date() } as any)
        .where(eq(agents.id, task.assigneeAgentId));

      eventBus.emitEvent({
        type: 'task.blocker_resolved' as any,
        companyId,
        payload: { taskId: task.id, resolvedDependencyId: completedTaskId, assigneeAgentId: task.assigneeAgentId },
        timestamp: new Date().toISOString(),
      });
    }
  }

  async function createThreadItem(values: Record<string, unknown>) {
    const now = new Date();
    const [row] = await db.drizzle
      .insert(taskThreadItems)
      .values({
        id: randomUUID(),
        createdAt: now,
        updatedAt: now,
        ...values,
      } as any)
      .returning();
    return row;
  }

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
      timed_out: [],
    };

    for (const row of rows) {
      if (board[row.status]) {
        board[row.status].push(row);
      }
    }

    res.json({ data: board });
  });

  // GET /api/companies/:companyId/tasks/:id/thread
  router.get('/:id/thread', async (req, res) => {
    const { id, companyId } = routeParams(req);
    await getTaskOrThrow(companyId, id);

    const [threadRows, executionRows, approvalRows] = await Promise.all([
      db.drizzle
        .select()
        .from(taskThreadItems)
        .where(and(eq(taskThreadItems.taskId, id), eq(taskThreadItems.companyId, companyId)))
        .orderBy(taskThreadItems.createdAt),
      db.drizzle
        .select()
        .from(agentExecutions)
        .where(and(eq(agentExecutions.taskId, id), eq(agentExecutions.companyId, companyId)))
        .orderBy(agentExecutions.createdAt),
      db.drizzle
        .select()
        .from(approvals)
        .where(and(eq(approvals.taskId, id), eq(approvals.companyId, companyId)))
        .orderBy(approvals.createdAt),
    ]);

    const items = [
      ...threadRows.map((item) => ({ ...item, source: 'thread' })),
      ...executionRows.map((execution) => ({
        id: `execution:${execution.id}`,
        companyId,
        taskId: id,
        kind: 'execution_event',
        content: execution.summary ?? execution.error ?? `${execution.status} execution`,
        payload: execution,
        status: execution.status,
        relatedExecutionId: execution.id,
        createdAt: new Date(execution.createdAt).toISOString(),
        updatedAt: new Date(execution.completedAt ?? execution.createdAt).toISOString(),
        source: 'execution',
      })),
      ...approvalRows.map((approval) => ({
        id: `approval:${approval.id}`,
        companyId,
        taskId: id,
        kind: 'approval_link',
        content: approval.title,
        payload: approval,
        status: approval.status,
        relatedApprovalId: approval.id,
        createdAt: new Date(approval.createdAt).toISOString(),
        updatedAt: new Date(approval.updatedAt).toISOString(),
        source: 'approval',
      })),
    ].sort((a: any, b: any) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    res.json({ data: items });
  });

  // POST /api/companies/:companyId/tasks/:id/thread/comments
  router.post('/:id/thread/comments', validate(CreateThreadCommentBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateThreadCommentBody>;
    const { id, companyId } = routeParams(req);
    await getTaskOrThrow(companyId, id);

    if (body.idempotencyKey) {
      const [existing] = await db.drizzle
        .select()
        .from(taskThreadItems)
        .where(
          and(
            eq(taskThreadItems.companyId, companyId),
            eq(taskThreadItems.taskId, id),
            eq(taskThreadItems.idempotencyKey, body.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) return res.json({ data: existing });
    }

    const row = await createThreadItem({
      companyId,
      taskId: id,
      kind: 'comment',
      authorUserId: req.user?.id ?? null,
      authorAgentId: body.authorAgentId,
      content: body.content,
      payload: {},
      status: 'answered',
      idempotencyKey: body.idempotencyKey ?? null,
    });

    eventBus.emitEvent({
      type: 'task.commented',
      companyId,
      payload: { taskId: id, item: row },
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // POST /api/companies/:companyId/tasks/:id/thread/interactions
  router.post('/:id/thread/interactions', validate(CreateInteractionBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateInteractionBody>;
    const { id, companyId } = routeParams(req);
    await getTaskOrThrow(companyId, id);

    if (body.idempotencyKey) {
      const [existing] = await db.drizzle
        .select()
        .from(taskThreadItems)
        .where(
          and(
            eq(taskThreadItems.companyId, companyId),
            eq(taskThreadItems.taskId, id),
            eq(taskThreadItems.idempotencyKey, body.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) return res.json({ data: existing });
    }

    const row = await createThreadItem({
      companyId,
      taskId: id,
      kind: 'interaction',
      authorUserId: req.user?.id ?? null,
      authorAgentId: body.authorAgentId,
      content: body.content,
      payload: body.payload,
      interactionType: body.interactionType,
      status: 'pending',
      idempotencyKey: body.idempotencyKey ?? null,
    });

    res.status(201).json({ data: row });
  });

  async function resolveInteraction(
    req: Request,
    status: 'accepted' | 'rejected' | 'answered',
    body: z.infer<typeof InteractionDecisionBody>,
  ) {
    const { id, companyId, interactionId } = routeParams(req);
    await getTaskOrThrow(companyId, id);

    const [interaction] = await db.drizzle
      .select()
      .from(taskThreadItems)
      .where(
        and(
          eq(taskThreadItems.id, interactionId),
          eq(taskThreadItems.taskId, id),
          eq(taskThreadItems.companyId, companyId),
        ),
      )
      .limit(1);

    if (!interaction) {
      throw new AppError(404, 'INTERACTION_NOT_FOUND', `Interaction ${interactionId} not found`);
    }

    if (interaction.status !== 'pending') {
      return interaction;
    }

    const now = new Date();
    const payload: Record<string, unknown> = {
      ...(interaction.payload as Record<string, unknown>),
      response: body.answers ?? {},
    };
    const createdTaskIds: string[] = [];

    if (status === 'accepted' && interaction.interactionType === 'suggested_tasks') {
      const suggested = Array.isArray((interaction.payload as any)?.tasks)
        ? ((interaction.payload as any).tasks as Array<Record<string, unknown>>)
        : [];

      if (suggested.length > 0) {
        const newTaskIds = await db.drizzle.transaction(async (tx) => {
          const [{ maxNum }] = await tx
            .select({ maxNum: sql<number>`coalesce(max(${tasks.taskNumber}), 0)` })
            .from(tasks)
            .where(eq(tasks.companyId, companyId));
          let taskNumber = Number(maxNum);
          const ids: string[] = [];

          for (const suggestedTask of suggested) {
            const title = typeof suggestedTask.title === 'string' ? suggestedTask.title : null;
            if (!title) continue;
            taskNumber += 1;
            const [created] = await tx
              .insert(tasks)
              .values({
                companyId,
                parentId: id,
                title,
                description:
                  typeof suggestedTask.description === 'string'
                    ? suggestedTask.description
                    : null,
                type: typeof suggestedTask.type === 'string' ? suggestedTask.type : 'feature',
                status: 'backlog',
                priority:
                  typeof suggestedTask.priority === 'string'
                    ? suggestedTask.priority
                    : 'medium',
                dependencies: [],
                tags: Array.isArray(suggestedTask.tags) ? suggestedTask.tags : [],
                taskNumber,
                identifier: `TASK-${taskNumber}`,
                createdByUserId: req.user?.id ?? null,
                createdAt: now,
                updatedAt: now,
              } as any)
              .returning();
            ids.push(created.id);
          }

          return ids;
        });
        createdTaskIds.push(...newTaskIds);
      }
      payload.createdTaskIds = createdTaskIds;
    }

    const [updated] = await db.drizzle
      .update(taskThreadItems)
      .set({
        status,
        payload,
        resolutionNote: body.note ?? null,
        resolvedByUserId: req.user?.id ?? null,
        resolvedAt: now,
        updatedAt: now,
      } as any)
      .where(eq(taskThreadItems.id, interaction.id))
      .returning();

    await createThreadItem({
      companyId,
      taskId: id,
      kind: 'decision',
      authorUserId: req.user?.id ?? null,
      content: body.note ?? `${status} ${interaction.interactionType ?? 'interaction'}`,
      payload: { interactionId: interaction.id, status, answers: body.answers ?? {}, createdTaskIds },
      status,
    });

    return updated;
  }

  router.post('/:id/thread/interactions/:interactionId/accept', validate(InteractionDecisionBody), async (req, res) => {
    const row = await resolveInteraction(req, 'accepted', req.body);
    res.json({ data: row });
  });

  router.post('/:id/thread/interactions/:interactionId/reject', validate(InteractionDecisionBody), async (req, res) => {
    const row = await resolveInteraction(req, 'rejected', req.body);
    res.json({ data: row });
  });

  router.post('/:id/thread/interactions/:interactionId/answer', validate(InteractionDecisionBody), async (req, res) => {
    const row = await resolveInteraction(req, 'answered', req.body);
    res.json({ data: row });
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

      if (body.status === 'done') {
        await wakeDependentsIfUnblocked(companyId, id);
      }
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

  // POST /api/companies/:companyId/tasks/:id/subtree/pause
  router.post('/:id/subtree/pause', validate(SubtreeControlBody), async (req, res) => {
    const body = req.body as z.infer<typeof SubtreeControlBody>;
    const { id, companyId } = routeParams(req);
    await getTaskOrThrow(companyId, id);
    const subtree = await fetchSubtree(companyId, id);
    const now = new Date();
    const inserted = [];

    for (const task of subtree) {
      const [existing] = await db.drizzle
        .select()
        .from(taskHolds)
        .where(
          and(
            eq(taskHolds.companyId, companyId),
            eq(taskHolds.taskId, task.id),
            eq(taskHolds.action, 'pause'),
            eq(taskHolds.status, 'active'),
          ),
        )
        .limit(1);
      if (existing) continue;

      const [hold] = await db.drizzle
        .insert(taskHolds)
        .values({
          id: randomUUID(),
          companyId,
          taskId: task.id,
          action: 'pause',
          status: 'active',
          previousStatus: task.status,
          reason: body.reason ?? null,
          createdByUserId: req.user?.id ?? null,
          createdAt: now,
          updatedAt: now,
        } as any)
        .returning();
      inserted.push(hold);
    }

    eventBus.emitEvent({
      type: 'task.subtree_paused' as any,
      companyId,
      payload: { rootTaskId: id, affectedTaskIds: subtree.map((task) => task.id) },
      timestamp: now.toISOString(),
    });

    res.json({ data: { rootTaskId: id, affectedTaskIds: subtree.map((task) => task.id), holds: inserted } });
  });

  // POST /api/companies/:companyId/tasks/:id/subtree/cancel
  router.post('/:id/subtree/cancel', validate(SubtreeControlBody), async (req, res) => {
    const body = req.body as z.infer<typeof SubtreeControlBody>;
    const { id, companyId } = routeParams(req);
    await getTaskOrThrow(companyId, id);
    const subtree = await fetchSubtree(companyId, id);
    const now = new Date();
    const taskIds = subtree.map((task) => task.id);

    for (const task of subtree) {
      const holdValues = {
        id: randomUUID(),
        companyId,
        taskId: task.id,
        action: 'cancel' as const,
        status: 'active' as const,
        previousStatus: task.status,
        reason: body.reason ?? null,
        createdByUserId: req.user?.id ?? null,
        createdAt: now,
        updatedAt: now,
      };

      const [existingHold] = await db.drizzle
        .select({ id: taskHolds.id })
        .from(taskHolds)
        .where(
          and(
            eq(taskHolds.companyId, companyId),
            eq(taskHolds.taskId, task.id),
            eq(taskHolds.action, 'cancel'),
            eq(taskHolds.status, 'active'),
          ),
        )
        .limit(1);

      if (existingHold) {
        await db.drizzle
          .update(taskHolds)
          .set({
            previousStatus: holdValues.previousStatus,
            reason: holdValues.reason,
            createdByUserId: holdValues.createdByUserId,
            updatedAt: now,
          })
          .where(eq(taskHolds.id, existingHold.id));
      } else {
        await db.drizzle.insert(taskHolds).values({
          id: randomUUID(),
          companyId,
          taskId: task.id,
          action: 'cancel',
          status: 'active',
          previousStatus: task.status,
          reason: body.reason ?? null,
          createdByUserId: req.user?.id ?? null,
          createdAt: now,
          updatedAt: now,
        } as any);
      }
    }

    if (taskIds.length > 0) {
      await db.drizzle
        .update(tasks)
        .set({ status: 'cancelled', updatedAt: now } as any)
        .where(and(eq(tasks.companyId, companyId), inArray(tasks.id, taskIds)));
    }

    eventBus.emitEvent({
      type: 'task.subtree_cancelled' as any,
      companyId,
      payload: { rootTaskId: id, affectedTaskIds: taskIds },
      timestamp: now.toISOString(),
    });

    res.json({ data: { rootTaskId: id, affectedTaskIds: taskIds } });
  });

  // POST /api/companies/:companyId/tasks/:id/subtree/restore
  router.post('/:id/subtree/restore', async (req, res) => {
    const { id, companyId } = routeParams(req);
    await getTaskOrThrow(companyId, id);
    const subtree = await fetchSubtree(companyId, id);
    const taskIds = subtree.map((task) => task.id);
    const now = new Date();

    const activeHolds = taskIds.length
      ? await db.drizzle
          .select()
          .from(taskHolds)
          .where(
            and(
              eq(taskHolds.companyId, companyId),
              eq(taskHolds.status, 'active'),
              inArray(taskHolds.taskId, taskIds),
            ),
          )
      : [];

    for (const hold of activeHolds) {
      if (hold.action === 'cancel' && hold.previousStatus && hold.previousStatus !== 'cancelled') {
        await db.drizzle
          .update(tasks)
          .set({ status: hold.previousStatus as any, updatedAt: now })
          .where(and(eq(tasks.id, hold.taskId), eq(tasks.companyId, companyId)));
      }
    }

    if (taskIds.length > 0) {
      await db.drizzle
        .update(taskHolds)
        .set({ status: 'restored', resolvedAt: now, updatedAt: now } as any)
        .where(
          and(
            eq(taskHolds.companyId, companyId),
            eq(taskHolds.status, 'active'),
            inArray(taskHolds.taskId, taskIds),
          ),
        );
    }

    eventBus.emitEvent({
      type: 'task.subtree_restored' as any,
      companyId,
      payload: { rootTaskId: id, affectedTaskIds: taskIds },
      timestamp: now.toISOString(),
    });

    res.json({ data: { rootTaskId: id, affectedTaskIds: taskIds } });
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

    const comment = {
      id: randomUUID(),
      authorAgentId: body.authorAgentId,
      authorUserId: body.authorUserId ?? req.user?.id ?? null,
      content: body.content,
      createdAt: new Date().toISOString(),
    };

    await createThreadItem({
      id: comment.id,
      companyId,
      taskId: id,
      kind: 'comment',
      authorUserId: comment.authorUserId,
      authorAgentId: body.authorAgentId,
      content: body.content,
      payload: {},
      status: 'answered',
    });

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
