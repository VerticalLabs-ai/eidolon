import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/error-handler.js';
import { validate } from '../middleware/validate.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateApprovalBody = z.object({
  kind: z
    .enum(['budget_change', 'agent_termination', 'task_review', 'custom'])
    .default('custom'),
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).optional(),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
  requestedByAgentId: z.string().uuid().optional(),
  payload: z.record(z.unknown()).default({}),
  taskId: z.string().uuid().optional(),
});

const DecideBody = z.object({
  decision: z.enum(['approved', 'rejected']),
  resolutionNote: z.string().max(10_000).optional(),
});

const CommentBody = z.object({
  content: z.string().min(1).max(10_000),
  authorAgentId: z.string().uuid().optional(),
});

const CancelBody = z.object({
  resolutionNote: z.string().max(10_000).optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function approvalsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { approvals, approvalComments } = db.schema;

  // GET /api/companies/:companyId/approvals?status=pending
  router.get('/', async (req, res) => {
    const companyId = routeParams(req).companyId;
    const status = req.query.status as string | undefined;

    const conditions = [eq(approvals.companyId, companyId)];
    if (status && ['pending', 'approved', 'rejected', 'cancelled'].includes(status)) {
      conditions.push(
        eq(approvals.status, status as 'pending' | 'approved' | 'rejected' | 'cancelled'),
      );
    }

    const rows = await db.drizzle
      .select()
      .from(approvals)
      .where(and(...conditions))
      .orderBy(desc(approvals.createdAt))
      .limit(200);

    res.json({ data: rows });
  });

  // POST /api/companies/:companyId/approvals
  router.post('/', validate(CreateApprovalBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateApprovalBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();
    const userId = req.user?.id ?? null;

    const [row] = await db.drizzle
      .insert(approvals)
      .values({
        id: randomUUID(),
        companyId,
        kind: body.kind,
        title: body.title,
        description: body.description ?? null,
        status: 'pending',
        priority: body.priority,
        requestedByUserId: userId,
        requestedByAgentId: body.requestedByAgentId ?? null,
        payload: body.payload,
        taskId: body.taskId ?? null,
        createdAt: now,
        updatedAt: now,
      } as any)
      .returning();

    eventBus.emitEvent({
      type: 'approval.created' as any,
      companyId,
      payload: { approval: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/approvals/:id
  router.get('/:id', async (req, res) => {
    const { id, companyId } = routeParams(req);

    const [row] = await db.drizzle
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.companyId, companyId)))
      .limit(1);

    if (!row) {
      throw new AppError(404, 'APPROVAL_NOT_FOUND', `Approval ${id} not found`);
    }

    const comments = await db.drizzle
      .select()
      .from(approvalComments)
      .where(eq(approvalComments.approvalId, id))
      .orderBy(approvalComments.createdAt);

    res.json({ data: { approval: row, comments } });
  });

  // POST /api/companies/:companyId/approvals/:id/decide
  router.post('/:id/decide', validate(DecideBody), async (req, res) => {
    const body = req.body as z.infer<typeof DecideBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();

    const [existing] = await db.drizzle
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'APPROVAL_NOT_FOUND', `Approval ${id} not found`);
    }

    if (existing.status !== 'pending') {
      throw new AppError(
        409,
        'APPROVAL_NOT_PENDING',
        `Approval ${id} is already ${existing.status}`,
      );
    }

    const [row] = await db.drizzle
      .update(approvals)
      .set({
        status: body.decision,
        resolutionNote: body.resolutionNote ?? null,
        resolvedByUserId: req.user?.id ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(approvals.id, id))
      .returning();

    eventBus.emitEvent({
      type: 'approval.decided' as any,
      companyId,
      payload: {
        approval: row,
        decision: body.decision,
      },
      timestamp: now.toISOString(),
    });

    res.json({ data: row });
  });

  // POST /api/companies/:companyId/approvals/:id/cancel
  router.post('/:id/cancel', validate(CancelBody), async (req, res) => {
    const body = req.body as z.infer<typeof CancelBody>;
    const { id, companyId } = routeParams(req);
    const now = new Date();

    const [existing] = await db.drizzle
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.companyId, companyId)))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'APPROVAL_NOT_FOUND', `Approval ${id} not found`);
    }

    if (existing.status !== 'pending') {
      throw new AppError(
        409,
        'APPROVAL_NOT_PENDING',
        `Approval ${id} is already ${existing.status}`,
      );
    }

    const [row] = await db.drizzle
      .update(approvals)
      .set({
        status: 'cancelled',
        resolutionNote: body.resolutionNote ?? null,
        resolvedByUserId: req.user?.id ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(eq(approvals.id, id))
      .returning();

    res.json({ data: row });
  });

  // POST /api/companies/:companyId/approvals/:id/comments
  router.post('/:id/comments', validate(CommentBody), async (req, res) => {
    const body = req.body as z.infer<typeof CommentBody>;
    const { id, companyId } = routeParams(req);

    const [approval] = await db.drizzle
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(eq(approvals.id, id), eq(approvals.companyId, companyId)))
      .limit(1);

    if (!approval) {
      throw new AppError(404, 'APPROVAL_NOT_FOUND', `Approval ${id} not found`);
    }

    const now = new Date();
    const [row] = await db.drizzle
      .insert(approvalComments)
      .values({
        id: randomUUID(),
        approvalId: id,
        authorUserId: req.user?.id ?? null,
        authorAgentId: body.authorAgentId ?? null,
        content: body.content,
        createdAt: now,
      } as any)
      .returning();

    res.status(201).json({ data: row });
  });

  return router;
}
