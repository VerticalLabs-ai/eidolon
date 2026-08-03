import { Router } from 'express';
import { eq, and, desc, asc, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import { validateProjectOwnership } from '../utils/project-validation.js';

// ---------------------------------------------------------------------------
// Constants & validation schemas
// ---------------------------------------------------------------------------

const PLAN_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;
const STEP_TYPES = ['action', 'review_gate', 'permission_gate'] as const;
const STEP_STATUSES = ['pending', 'in_progress', 'completed', 'blocked', 'skipped'] as const;

const CreatePlanBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).optional(),
  taskId: z.string().uuid().optional(),
  createdByAgentId: z.string().uuid().nullable().optional(),
});

const PlanListQuery = z.object({
  status: z.enum(PLAN_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const UpdatePlanBody = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(10_000).nullable().optional(),
  status: z.enum(PLAN_STATUSES).optional(),
  progress: z.number().int().min(0).max(100).optional(),
});

const CreateStepBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).optional(),
  stepType: z.enum(STEP_TYPES).default('action'),
  gateConfig: z.record(z.unknown()).default({}),
});

const UpdateStepBody = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(10_000).nullable().optional(),
  status: z.enum(STEP_STATUSES).optional(),
  stepOrder: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function projectPlansRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { projectPlans, projectPlanSteps, approvals } = db.schema;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function getPlanOrThrow(companyId: string, projectId: string, planId: string) {
    const [row] = await db.drizzle
      .select()
      .from(projectPlans)
      .where(
        and(
          eq(projectPlans.id, planId),
          eq(projectPlans.companyId, companyId),
          eq(projectPlans.projectId, projectId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'PLAN_NOT_FOUND', `Plan ${planId} not found`);
    }

    return row;
  }

  async function getStepOrThrow(companyId: string, planId: string, stepId: string) {
    const [row] = await db.drizzle
      .select()
      .from(projectPlanSteps)
      .where(
        and(
          eq(projectPlanSteps.id, stepId),
          eq(projectPlanSteps.planId, planId),
          eq(projectPlanSteps.companyId, companyId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'PLAN_STEP_NOT_FOUND', `Plan step ${stepId} not found`);
    }

    return row;
  }

  /**
   * Recalculate plan progress = round(completed / non-skipped * 100).
   * Persists the computed value to the plan row and returns it.
   */
  async function recalcProgress(
    companyId: string,
    planId: string,
  ): Promise<number> {
    const steps = await db.drizzle
      .select({ status: projectPlanSteps.status })
      .from(projectPlanSteps)
      .where(
        and(
          eq(projectPlanSteps.planId, planId),
          eq(projectPlanSteps.companyId, companyId),
        ),
      );

    const nonSkipped = steps.filter((s) => s.status !== 'skipped').length;
    const completed = steps.filter((s) => s.status === 'completed').length;
    const progress = nonSkipped > 0 ? Math.round((completed / nonSkipped) * 100) : 0;

    await db.drizzle
      .update(projectPlans)
      .set({ progress, updatedAt: new Date() })
      .where(eq(projectPlans.id, planId));

    return progress;
  }

  // -------------------------------------------------------------------------
  // GET /plans — list with status filter + step summaries
  // -------------------------------------------------------------------------
  router.get('/', validate(PlanListQuery, 'query'), async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof PlanListQuery>;

    await validateProjectOwnership(db, companyId, projectId);

    const conditions = [
      eq(projectPlans.companyId, companyId),
      eq(projectPlans.projectId, projectId),
    ];

    if (query.status) {
      conditions.push(eq(projectPlans.status, query.status));
    }

    const rows = await db.drizzle
      .select()
      .from(projectPlans)
      .where(and(...conditions))
      .orderBy(desc(projectPlans.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    // Compute step summaries per plan
    const planIds = rows.map((r) => r.id);
    if (planIds.length === 0) {
      return res.json({ data: [] });
    }

    const stepCounts = await db.drizzle
      .select({
        planId: projectPlanSteps.planId,
        stepCount: sql<number>`count(*)`.as('step_count'),
        completedStepCount:
          sql<number>`count(*) filter (where ${projectPlanSteps.status} = 'completed')`.as('completed_step_count'),
      })
      .from(projectPlanSteps)
      .where(inArray(projectPlanSteps.planId, planIds))
      .groupBy(projectPlanSteps.planId);

    const countsByPlan = new Map<string, { stepCount: number; completedStepCount: number }>();
    for (const sc of stepCounts) {
      countsByPlan.set(sc.planId, {
        stepCount: Number(sc.stepCount),
        completedStepCount: Number(sc.completedStepCount),
      });
    }

    const data = rows.map((r) => ({
      ...r,
      stepCount: countsByPlan.get(r.id)?.stepCount ?? 0,
      completedStepCount: countsByPlan.get(r.id)?.completedStepCount ?? 0,
    }));

    res.json({ data });
  });

  // -------------------------------------------------------------------------
  // POST /plans — create a plan
  // -------------------------------------------------------------------------
  router.post('/', validate(CreatePlanBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreatePlanBody>;
    const { companyId, projectId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);

    const [row] = await db.drizzle
      .insert(projectPlans)
      .values({
        companyId,
        projectId,
        title: body.title,
        description: body.description ?? null,
        status: 'draft',
        progress: 0,
        taskId: body.taskId ?? null,
        createdByUserId: req.user?.id ?? null,
        createdByAgentId: body.createdByAgentId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'project.plan.created' as any,
      companyId,
      payload: { plan: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: { ...row, stepCount: 0, completedStepCount: 0 } });
  });

  // -------------------------------------------------------------------------
  // GET /plans/:planId — plan with ordered steps
  // -------------------------------------------------------------------------
  router.get('/:planId', async (req, res) => {
    const { companyId, projectId, planId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);
    const plan = await getPlanOrThrow(companyId, projectId, planId);

    const steps = await db.drizzle
      .select()
      .from(projectPlanSteps)
      .where(
        and(
          eq(projectPlanSteps.planId, planId),
          eq(projectPlanSteps.companyId, companyId),
        ),
      )
      .orderBy(asc(projectPlanSteps.stepOrder));

    res.json({ data: { ...plan, steps } });
  });

  // -------------------------------------------------------------------------
  // PATCH /plans/:planId — update status / progress / title
  // -------------------------------------------------------------------------
  router.patch('/:planId', validate(UpdatePlanBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdatePlanBody>;
    const { companyId, projectId, planId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);
    await getPlanOrThrow(companyId, projectId, planId);

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.status !== undefined) updates.status = body.status;
    if (body.progress !== undefined) updates.progress = body.progress;

    const [row] = await db.drizzle
      .update(projectPlans)
      .set(updates)
      .where(eq(projectPlans.id, planId))
      .returning();

    eventBus.emitEvent({
      type: 'project.plan.updated' as any,
      companyId,
      payload: { plan: row },
      timestamp: now.toISOString(),
    });

    res.json({ data: row });
  });

  // -------------------------------------------------------------------------
  // POST /plans/:planId/steps — add a step with auto stepOrder
  // -------------------------------------------------------------------------
  router.post('/:planId/steps', validate(CreateStepBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateStepBody>;
    const { companyId, projectId, planId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);
    await getPlanOrThrow(companyId, projectId, planId);

    // Determine next stepOrder
    const [{ maxOrder }] = await db.drizzle
      .select({ maxOrder: sql<number>`coalesce(max(${projectPlanSteps.stepOrder}), -1)` })
      .from(projectPlanSteps)
      .where(eq(projectPlanSteps.planId, planId));

    const stepOrder = Number(maxOrder) + 1;

    const [row] = await db.drizzle
      .insert(projectPlanSteps)
      .values({
        planId,
        companyId,
        title: body.title,
        description: body.description ?? null,
        stepOrder,
        stepType: body.stepType,
        status: 'pending',
        gateConfig: body.gateConfig,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Recalc plan progress (adding a pending step doesn't change it but keeps it consistent)
    await recalcProgress(companyId, planId);

    eventBus.emitEvent({
      type: 'project.plan.step.created' as any,
      companyId,
      payload: { planId, step: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // -------------------------------------------------------------------------
  // PATCH /plans/:planId/steps/:stepId — update status / reorder
  // -------------------------------------------------------------------------
  router.patch('/:planId/steps/:stepId', validate(UpdateStepBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateStepBody>;
    const { companyId, projectId, planId, stepId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);
    const step = await getStepOrThrow(companyId, planId, stepId);

    const updates: Record<string, unknown> = { updatedAt: now };
    if (body.title !== undefined) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description;
    if (body.stepOrder !== undefined) updates.stepOrder = body.stepOrder;

    if (body.status !== undefined) {
      updates.status = body.status;
      if (body.status === 'completed' && step.status !== 'completed') {
        updates.completedAt = now;
        updates.completedByUserId = req.user?.id ?? null;
      } else if (body.status !== 'completed') {
        // Clear completion fields when moving away from completed
        updates.completedAt = null;
        updates.completedByUserId = null;
      }
    }

    const [row] = await db.drizzle
      .update(projectPlanSteps)
      .set(updates)
      .where(eq(projectPlanSteps.id, stepId))
      .returning();

    // Recalc plan progress after status change
    await recalcProgress(companyId, planId);

    eventBus.emitEvent({
      type: 'project.plan.step.updated' as any,
      companyId,
      payload: { planId, stepId, step: row },
      timestamp: now.toISOString(),
    });

    res.json({ data: row });
  });

  // -------------------------------------------------------------------------
  // POST /plans/:planId/steps/:stepId/advance — advance gate
  // -------------------------------------------------------------------------
  router.post('/:planId/steps/:stepId/advance', async (req, res) => {
    const { companyId, projectId, planId, stepId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);
    const plan = await getPlanOrThrow(companyId, projectId, planId);
    const step = await getStepOrThrow(companyId, planId, stepId);

    if (step.stepType === 'action') {
      // Action steps complete directly
      const [row] = await db.drizzle
        .update(projectPlanSteps)
        .set({
          status: 'completed',
          completedAt: now,
          completedByUserId: req.user?.id ?? null,
          updatedAt: now,
        })
        .where(eq(projectPlanSteps.id, stepId))
        .returning();

      await recalcProgress(companyId, planId);

      eventBus.emitEvent({
        type: 'project.plan.step.advanced' as any,
        companyId,
        payload: { planId, stepId, step: row },
        timestamp: now.toISOString(),
      });

      return res.json({ data: row });
    }

    // Gate steps (review_gate / permission_gate)
    if (step.status === 'in_progress') {
      throw new AppError(
        409,
        'PLAN_STEP_ALREADY_IN_PROGRESS',
        `Step ${stepId} is already in progress (gate already advanced)`,
      );
    }

    if (step.status === 'completed' || step.status === 'blocked') {
      throw new AppError(
        409,
        'PLAN_STEP_ALREADY_RESOLVED',
        `Step ${stepId} is already ${step.status}`,
      );
    }

    // Create approval + transition step to in_progress inside a transaction
    const result = await db.drizzle.transaction(async (tx) => {
      const approvalId = randomUUID();
      const [approval] = await tx
        .insert(approvals)
        .values({
          id: approvalId,
          companyId,
          kind: 'plan_gate',
          title: `Gate approval: ${step.title}`,
          description: step.description ?? null,
          status: 'pending',
          priority: 'medium',
          requestedByUserId: req.user?.id ?? null,
          payload: { planId, stepId, stepType: step.stepType, gateConfig: step.gateConfig },
          projectId: plan.projectId,
          planStepId: stepId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      const [updatedStep] = await tx
        .update(projectPlanSteps)
        .set({
          status: 'in_progress',
          gateApprovalId: approvalId,
          updatedAt: now,
        })
        .where(eq(projectPlanSteps.id, stepId))
        .returning();

      return { approval, updatedStep };
    });

    await recalcProgress(companyId, planId);

    eventBus.emitEvent({
      type: 'approval.created' as any,
      companyId,
      payload: { approval: result.approval },
      timestamp: now.toISOString(),
    });

    eventBus.emitEvent({
      type: 'project.plan.step.advanced' as any,
      companyId,
      payload: { planId, stepId, step: result.updatedStep, approvalId: result.approval.id },
      timestamp: now.toISOString(),
    });

    res.json({ data: result.updatedStep });
  });

  return router;
}
