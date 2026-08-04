import { Router } from 'express';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import { validateProjectOwnership } from '../utils/project-validation.js';

const THREAD_TYPES = ['conversation', 'plan_review', 'decision_review', 'standup'] as const;
const THREAD_STATUSES = ['active', 'archived'] as const;
const ITEM_KINDS = ['comment', 'interaction', 'decision', 'approval_link', 'execution_event'] as const;
const ITEM_STATUSES = ['pending', 'accepted', 'rejected', 'answered', 'linked'] as const;
const INTERACTION_TYPES = ['suggested_tasks', 'confirmation', 'form'] as const;

const CreateThreadBody = z.object({
  title: z.string().trim().min(1).max(500),
  type: z.enum(THREAD_TYPES).optional(),
  status: z.enum(THREAD_STATUSES).optional(),
  createdByAgentId: z.string().uuid().nullable().optional(),
});

const ThreadListQuery = z.object({
  status: z.enum(THREAD_STATUSES).optional(),
  type: z.enum(THREAD_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const ThreadDetailQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const CreateThreadItemBody = z.object({
  kind: z.enum(ITEM_KINDS).default('comment'),
  content: z.string().max(20_000).optional(),
  payload: z.record(z.unknown()).default({}),
  interactionType: z.enum(INTERACTION_TYPES).optional(),
  status: z.enum(ITEM_STATUSES).optional(),
  authorAgentId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().min(1).max(255).optional(),
});

const ResolveInteractionBody = z.object({
  status: z.enum(['accepted', 'rejected', 'answered']),
  note: z.string().max(10_000).optional(),
  answers: z.record(z.unknown()).optional(),
});

export function projectThreadsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { projectThreads, taskThreadItems } = db.schema;

  async function getThreadOrThrow(companyId: string, projectId: string, threadId: string) {
    const [row] = await db.drizzle
      .select()
      .from(projectThreads)
      .where(
        and(
          eq(projectThreads.id, threadId),
          eq(projectThreads.companyId, companyId),
          eq(projectThreads.projectId, projectId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'THREAD_NOT_FOUND', `Thread ${threadId} not found`);
    }

    return row;
  }

  async function getThreadItemOrThrow(
    companyId: string,
    projectThreadId: string,
    itemId: string,
  ) {
    const [row] = await db.drizzle
      .select()
      .from(taskThreadItems)
      .where(
        and(
          eq(taskThreadItems.id, itemId),
          eq(taskThreadItems.companyId, companyId),
          eq(taskThreadItems.projectThreadId, projectThreadId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'THREAD_ITEM_NOT_FOUND', `Thread item ${itemId} not found`);
    }

    return row;
  }

  // GET /api/companies/:companyId/projects/:projectId/threads
  router.get('/', validate(ThreadListQuery, 'query'), async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof ThreadListQuery>;

    await validateProjectOwnership(db, companyId, projectId);

    const conditions = [
      eq(projectThreads.companyId, companyId),
      eq(projectThreads.projectId, projectId),
    ];

    // Default to active threads unless a status filter is explicitly provided.
    if (query.status) {
      conditions.push(eq(projectThreads.status, query.status));
    } else {
      conditions.push(eq(projectThreads.status, 'active'));
    }

    if (query.type) {
      conditions.push(eq(projectThreads.type, query.type));
    }

    const rows = await db.drizzle
      .select()
      .from(projectThreads)
      .where(and(...conditions))
      .orderBy(desc(projectThreads.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(projectThreads)
      .where(and(...conditions));

    res.json({
      data: rows,
      meta: { total: Number(total), limit: query.limit, offset: query.offset },
    });
  });

  // POST /api/companies/:companyId/projects/:projectId/threads
  router.post('/', validate(CreateThreadBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateThreadBody>;
    const { companyId, projectId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);

    const [row] = await db.drizzle
      .insert(projectThreads)
      .values({
        companyId,
        projectId,
        title: body.title,
        type: body.type ?? 'conversation',
        status: body.status ?? 'active',
        createdByUserId: req.user?.id ?? null,
        createdByAgentId: body.createdByAgentId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'project.thread.created',
      companyId,
      payload: { thread: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/projects/:projectId/threads/:threadId
  router.get('/:threadId', validate(ThreadDetailQuery, 'query'), async (req, res) => {
    const { companyId, projectId, threadId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof ThreadDetailQuery>;

    await validateProjectOwnership(db, companyId, projectId);
    const thread = await getThreadOrThrow(companyId, projectId, threadId);

    const items = await db.drizzle
      .select()
      .from(taskThreadItems)
      .where(
        and(
          eq(taskThreadItems.companyId, companyId),
          eq(taskThreadItems.projectThreadId, threadId),
        ),
      )
      .orderBy(desc(taskThreadItems.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(taskThreadItems)
      .where(
        and(
          eq(taskThreadItems.companyId, companyId),
          eq(taskThreadItems.projectThreadId, threadId),
        ),
      );

    res.json({
      data: {
        ...thread,
        items,
        meta: { total: Number(total), limit: query.limit, offset: query.offset },
      },
    });
  });

  // POST /api/companies/:companyId/projects/:projectId/threads/:threadId/items
  router.post('/:threadId/items', validate(CreateThreadItemBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateThreadItemBody>;
    const { companyId, projectId, threadId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);
    await getThreadOrThrow(companyId, projectId, threadId);

    if (body.idempotencyKey) {
      const [existing] = await db.drizzle
        .select()
        .from(taskThreadItems)
        .where(
          and(
            eq(taskThreadItems.companyId, companyId),
            eq(taskThreadItems.projectThreadId, threadId),
            eq(taskThreadItems.idempotencyKey, body.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        return res.json({ data: existing });
      }
    }

    const [row] = await db.drizzle
      .insert(taskThreadItems)
      .values({
        companyId,
        projectId,
        projectThreadId: threadId,
        taskId: null,
        kind: body.kind,
        authorUserId: req.user?.id ?? null,
        authorAgentId: body.authorAgentId ?? null,
        content: body.content ?? null,
        payload: body.payload,
        interactionType: body.interactionType ?? null,
        status: body.status ?? 'pending',
        idempotencyKey: body.idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning();

    eventBus.emitEvent({
      type: 'project.thread.item.created',
      companyId,
      payload: { threadId, item: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // PATCH /api/companies/:companyId/projects/:projectId/threads/:threadId/items/:itemId
  router.patch(
    '/:threadId/items/:itemId',
    validate(ResolveInteractionBody),
    async (req, res) => {
      const body = req.body as z.infer<typeof ResolveInteractionBody>;
      const { companyId, projectId, threadId, itemId } = routeParams(req);
      const now = new Date();

      await validateProjectOwnership(db, companyId, projectId);
      await getThreadOrThrow(companyId, projectId, threadId);
      const item = await getThreadItemOrThrow(companyId, threadId, itemId);

      if (item.kind !== 'interaction') {
        throw new AppError(
          400,
          'THREAD_ITEM_NOT_INTERACTION',
          'Only interaction items can be resolved',
        );
      }

      if (item.status !== 'pending') {
        return res.json({ data: item });
      }

      const payload: Record<string, unknown> = {
        ...(item.payload as Record<string, unknown>),
        answers: body.answers ?? {},
      };

      const [updated] = await db.drizzle
        .update(taskThreadItems)
        .set({
          status: body.status,
          payload,
          resolutionNote: body.note ?? null,
          resolvedByUserId: req.user?.id ?? null,
          resolvedAt: now,
          updatedAt: now,
        } as any)
        .where(eq(taskThreadItems.id, item.id))
        .returning();

      eventBus.emitEvent({
        type: 'project.thread.item.updated',
        companyId,
        payload: { threadId, itemId, item: updated },
        timestamp: now.toISOString(),
      });

      res.json({ data: updated });
    },
  );

  return router;
}
