import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import { validateProjectOwnership } from '../utils/project-validation.js';

const OUTCOME_TYPES = ['document', 'pull_request', 'audit', 'review', 'delivery_summary'] as const;
const OUTCOME_STATUSES = ['pending', 'completed', 'failed'] as const;

const CreateOutcomeBody = z.object({
  type: z.enum(OUTCOME_TYPES),
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).optional(),
  referenceUrl: z.string().url().optional(),
  referenceId: z.string().max(500).optional(),
  taskId: z.string().uuid().optional(),
  planId: z.string().uuid().optional(),
  planStepId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  createdByAgentId: z.string().uuid().nullable().optional(),
});

const OutcomeListQuery = z.object({
  type: z.enum(OUTCOME_TYPES).optional(),
  status: z.enum(OUTCOME_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const UpdateOutcomeBody = z
  .object({
    status: z.enum(OUTCOME_STATUSES).optional(),
    description: z.string().max(10_000).nullable().optional(),
    referenceUrl: z.string().url().nullable().optional(),
    referenceId: z.string().max(500).nullable().optional(),
  })
  .strict();

export function projectOutcomesRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { projectOutcomes, projectPlans, projectPlanSteps, tasks } = db.schema;

  async function getOutcomeOrThrow(companyId: string, projectId: string, outcomeId: string) {
    const [row] = await db.drizzle
      .select()
      .from(projectOutcomes)
      .where(
        and(
          eq(projectOutcomes.id, outcomeId),
          eq(projectOutcomes.companyId, companyId),
          eq(projectOutcomes.projectId, projectId),
        ),
      )
      .limit(1);
    if (!row) throw new AppError(404, 'OUTCOME_NOT_FOUND', `Outcome ${outcomeId} not found`);
    return row;
  }

  router.get('/', validate(OutcomeListQuery, 'query'), async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof OutcomeListQuery>;
    await validateProjectOwnership(db, companyId, projectId);

    const conditions = [
      eq(projectOutcomes.companyId, companyId),
      eq(projectOutcomes.projectId, projectId),
    ];
    if (query.type) conditions.push(eq(projectOutcomes.type, query.type));
    if (query.status) conditions.push(eq(projectOutcomes.status, query.status));

    const rows = await db.drizzle
      .select()
      .from(projectOutcomes)
      .where(and(...conditions))
      .orderBy(desc(projectOutcomes.createdAt))
      .limit(query.limit)
      .offset(query.offset);
    res.json({ data: rows });
  });

  router.get('/:outcomeId', async (req, res) => {
    const { companyId, projectId, outcomeId } = routeParams(req);
    await validateProjectOwnership(db, companyId, projectId);
    res.json({ data: await getOutcomeOrThrow(companyId, projectId, outcomeId) });
  });

  router.post('/', validate(CreateOutcomeBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateOutcomeBody>;
    const { companyId, projectId } = routeParams(req);
    const now = new Date();
    await validateProjectOwnership(db, companyId, projectId);

    if (body.planId) {
      const [plan] = await db.drizzle
        .select({ id: projectPlans.id })
        .from(projectPlans)
        .where(
          and(
            eq(projectPlans.id, body.planId),
            eq(projectPlans.companyId, companyId),
            eq(projectPlans.projectId, projectId),
          ),
        )
        .limit(1);
      if (!plan) throw new AppError(400, 'PLAN_NOT_FOUND', 'Plan is not in this project');
    }
    if (body.planStepId) {
      if (!body.planId) throw new AppError(400, 'PLAN_REQUIRED', 'planId is required with planStepId');
      const [step] = await db.drizzle
        .select({ id: projectPlanSteps.id })
        .from(projectPlanSteps)
        .where(
          and(
            eq(projectPlanSteps.id, body.planStepId),
            eq(projectPlanSteps.planId, body.planId),
            eq(projectPlanSteps.companyId, companyId),
          ),
        )
        .limit(1);
      if (!step) throw new AppError(400, 'PLAN_STEP_NOT_FOUND', 'Plan step is not in this plan');
    }
    if (body.taskId) {
      const [task] = await db.drizzle
        .select({ id: tasks.id, projectId: tasks.projectId })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, body.taskId),
            eq(tasks.companyId, companyId),
            eq(tasks.projectId, projectId),
          ),
        )
        .limit(1);
      if (!task) {
        throw new AppError(400, 'TASK_NOT_FOUND', 'Task is not in this project');
      }
    }

    const [row] = await db.drizzle
      .insert(projectOutcomes)
      .values({
        companyId,
        projectId,
        type: body.type,
        title: body.title,
        description: body.description ?? null,
        status: 'pending',
        referenceUrl: body.referenceUrl ?? null,
        referenceId: body.referenceId ?? null,
        taskId: body.taskId ?? null,
        planId: body.planId ?? null,
        planStepId: body.planStepId ?? null,
        metadata: body.metadata ?? {},
        createdByUserId: req.user?.id ?? null,
        createdByAgentId: body.createdByAgentId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'project.outcome.created' as any,
      companyId,
      payload: { outcome: row },
      timestamp: now.toISOString(),
    });
    res.status(201).json({ data: row });
  });

  router.patch('/:outcomeId', validate(UpdateOutcomeBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateOutcomeBody>;
    const { companyId, projectId, outcomeId } = routeParams(req);
    const now = new Date();
    await validateProjectOwnership(db, companyId, projectId);
    const outcome = await getOutcomeOrThrow(companyId, projectId, outcomeId);

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status === 'completed') updates.completedAt = outcome.completedAt ?? now;
      else if (outcome.status === 'completed') updates.completedAt = null;
    }
    if (body.description !== undefined) updates.description = body.description;
    if (body.referenceUrl !== undefined) updates.referenceUrl = body.referenceUrl;
    if (body.referenceId !== undefined) updates.referenceId = body.referenceId;

    const [row] = await db.drizzle
      .update(projectOutcomes)
      .set(updates)
      .where(
        and(
          eq(projectOutcomes.id, outcomeId),
          eq(projectOutcomes.companyId, companyId),
          eq(projectOutcomes.projectId, projectId),
        ),
      )
      .returning();
    eventBus.emitEvent({
      type: 'project.outcome.updated' as any,
      companyId,
      payload: { outcome: row, previousStatus: outcome.status },
      timestamp: now.toISOString(),
    });
    res.json({ data: row });
  });

  return router;
}
