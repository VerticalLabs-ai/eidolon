import { Router } from 'express';
import { eq, and, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const SendMessageBody = z.object({
  fromAgentId: z.string().uuid(),
  toAgentId: z.string().uuid(),
  type: z.enum(['directive', 'report', 'question', 'response', 'notification']).default('directive'),
  subject: z.string().max(500).optional(),
  content: z.string().min(1).max(50_000),
  threadId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const MessageListQuery = z.object({
  fromAgent: z.string().uuid().optional(),
  toAgent: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  type: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function messagesRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { messages } = db.schema;

  // GET /api/companies/:companyId/messages
  router.get('/', validate(MessageListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = req.query as unknown as z.infer<typeof MessageListQuery>;

    const conditions = [eq(messages.companyId, companyId)];
    if (query.fromAgent) conditions.push(eq(messages.fromAgentId, query.fromAgent));
    if (query.toAgent) conditions.push(eq(messages.toAgentId, query.toAgent));
    if (query.threadId) conditions.push(eq(messages.threadId, query.threadId));
    if (query.type) conditions.push(eq(messages.type, query.type as any));

    const rows = await db.drizzle
      .select()
      .from(messages)
      .where(and(...conditions))
      .orderBy(desc(messages.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(messages)
      .where(and(...conditions));

    res.json({ data: rows, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  // POST /api/companies/:companyId/messages
  router.post('/', validate(SendMessageBody), async (req, res) => {
    const body = req.body as z.infer<typeof SendMessageBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const [row] = await db.drizzle
      .insert(messages)
      .values({
        companyId,
        fromAgentId: body.fromAgentId,
        toAgentId: body.toAgentId,
        type: body.type,
        subject: body.subject ?? null,
        content: body.content,
        threadId: body.threadId ?? randomUUID(),
        parentMessageId: body.parentMessageId ?? null,
        metadata: body.metadata,
        createdAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'message.sent',
      companyId,
      payload: { message: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/messages/threads/:threadId
  router.get('/threads/:threadId', async (req, res) => {
    const { companyId, threadId } = routeParams(req);

    const rows = await db.drizzle
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.companyId, companyId),
          eq(messages.threadId, threadId),
        ),
      )
      .orderBy(messages.createdAt);

    if (rows.length === 0) {
      throw new AppError(404, 'THREAD_NOT_FOUND', `Thread ${threadId} not found`);
    }

    res.json({ data: rows });
  });

  return router;
}
