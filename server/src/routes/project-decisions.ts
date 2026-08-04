import { Router } from 'express';
import { eq, and, desc } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import { validateProjectOwnership } from '../utils/project-validation.js';

// ---------------------------------------------------------------------------
// Constants & validation schemas
// ---------------------------------------------------------------------------

const DECISION_STATUSES = ['pending', 'approved', 'rejected', 'superseded'] as const;

const CreateDecisionBody = z.object({
  title: z.string().trim().min(1).max(500),
  description: z.string().max(10_000).optional(),
  planId: z.string().uuid().optional(),
  planStepId: z.string().uuid().optional(),
  createdByAgentId: z.string().uuid().nullable().optional(),
});

const DecisionListQuery = z.object({
  status: z.enum(DECISION_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const UpdateDecisionBody = z.object({
  status: z.enum(['approved', 'rejected', 'superseded']),
  rationale: z.string().max(10_000).optional(),
  supersededById: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function projectDecisionsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { projectDecisions, projectPlans, projectPlanSteps } = db.schema;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function getDecisionOrThrow(companyId: string, projectId: string, decisionId: string) {
    const [row] = await db.drizzle
      .select()
      .from(projectDecisions)
      .where(
        and(
          eq(projectDecisions.id, decisionId),
          eq(projectDecisions.companyId, companyId),
          eq(projectDecisions.projectId, projectId),
        ),
      )
      .limit(1);

    if (!row) {
      throw new AppError(404, 'DECISION_NOT_FOUND', `Decision ${decisionId} not found`);
    }

    return row;
  }

  /**
   * Validate that a planId exists in the given company+project scope.
   * Throws 400 if not found.
   */
  async function validatePlanBelongsToProject(
    companyId: string,
    projectId: string,
    planId: string,
  ): Promise<void> {
    const [plan] = await db.drizzle
      .select({ id: projectPlans.id })
      .from(projectPlans)
      .where(
        and(
          eq(projectPlans.id, planId),
          eq(projectPlans.companyId, companyId),
          eq(projectPlans.projectId, projectId),
        ),
      )
      .limit(1);

    if (!plan) {
      throw new AppError(400, 'PLAN_NOT_FOUND', `Plan ${planId} not found in this project`);
    }
  }

  /**
   * Validate that a planStepId belongs to the given planId.
   * Throws 400 if not found.
   */
  async function validateStepBelongsToPlan(
    companyId: string,
    planId: string,
    planStepId: string,
  ): Promise<void> {
    const [step] = await db.drizzle
      .select({ id: projectPlanSteps.id })
      .from(projectPlanSteps)
      .where(
        and(
          eq(projectPlanSteps.id, planStepId),
          eq(projectPlanSteps.planId, planId),
          eq(projectPlanSteps.companyId, companyId),
        ),
      )
      .limit(1);

    if (!step) {
      throw new AppError(
        400,
        'PLAN_STEP_NOT_IN_PLAN',
        `Plan step ${planStepId} does not belong to plan ${planId}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // GET /decisions — list with optional status filter
  // -------------------------------------------------------------------------
  router.get('/', validate(DecisionListQuery, 'query'), async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const query = (req as any).validated.query as z.infer<typeof DecisionListQuery>;

    await validateProjectOwnership(db, companyId, projectId);

    const conditions = [
      eq(projectDecisions.companyId, companyId),
      eq(projectDecisions.projectId, projectId),
    ];

    if (query.status) {
      conditions.push(eq(projectDecisions.status, query.status));
    }

    const rows = await db.drizzle
      .select()
      .from(projectDecisions)
      .where(and(...conditions))
      .orderBy(desc(projectDecisions.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    res.json({ data: rows });
  });

  // -------------------------------------------------------------------------
  // GET /decisions/:decisionId — get a single decision
  // -------------------------------------------------------------------------
  router.get('/:decisionId', async (req, res) => {
    const { companyId, projectId, decisionId } = routeParams(req);

    await validateProjectOwnership(db, companyId, projectId);
    const row = await getDecisionOrThrow(companyId, projectId, decisionId);

    res.json({ data: row });
  });

  // -------------------------------------------------------------------------
  // POST /decisions — create a decision card (status defaults to pending)
  // -------------------------------------------------------------------------
  router.post('/', validate(CreateDecisionBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateDecisionBody>;
    const { companyId, projectId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);

    // Validate plan linkage if provided
    if (body.planId) {
      await validatePlanBelongsToProject(companyId, projectId, body.planId);

      if (body.planStepId) {
        await validateStepBelongsToPlan(companyId, body.planId, body.planStepId);
      }
    } else if (body.planStepId) {
      // planStepId without planId — reject
      throw new AppError(
        400,
        'PLAN_STEP_WITHOUT_PLAN',
        'planStepId requires planId',
      );
    }

    const [row] = await db.drizzle
      .insert(projectDecisions)
      .values({
        companyId,
        projectId,
        title: body.title,
        description: body.description ?? null,
        status: 'pending',
        planId: body.planId ?? null,
        planStepId: body.planStepId ?? null,
        createdByUserId: req.user?.id ?? null,
        createdByAgentId: body.createdByAgentId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'project.decision.created' as any,
      companyId,
      payload: { decision: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // -------------------------------------------------------------------------
  // PATCH /decisions/:decisionId — approve / reject / supersede
  // -------------------------------------------------------------------------
  router.patch('/:decisionId', validate(UpdateDecisionBody), async (req, res) => {
    const body = req.body as z.infer<typeof UpdateDecisionBody>;
    const { companyId, projectId, decisionId } = routeParams(req);
    const now = new Date();

    await validateProjectOwnership(db, companyId, projectId);
    const decision = await getDecisionOrThrow(companyId, projectId, decisionId);

    // Prevent re-resolution of already-resolved decisions
    if (decision.status !== 'pending') {
      throw new AppError(
        400,
        'DECISION_ALREADY_RESOLVED',
        `Decision ${decisionId} is already ${decision.status}`,
      );
    }

    // Supersede requires supersededById
    if (body.status === 'superseded') {
      if (!body.supersededById) {
        throw new AppError(
          400,
          'SUPERSEDED_BY_ID_REQUIRED',
          'supersededById is required when status=superseded',
        );
      }

      // Verify the replacement decision exists in this project
      const [replacement] = await db.drizzle
        .select({ id: projectDecisions.id, status: projectDecisions.status })
        .from(projectDecisions)
        .where(
          and(
            eq(projectDecisions.id, body.supersededById),
            eq(projectDecisions.companyId, companyId),
            eq(projectDecisions.projectId, projectId),
          ),
        )
        .limit(1);

      if (!replacement) {
        throw new AppError(
          400,
          'REPLACEMENT_DECISION_NOT_FOUND',
          `Replacement decision ${body.supersededById} not found in this project`,
        );
      }
    }

    const updates: Record<string, unknown> = {
      status: body.status,
      updatedAt: now,
    };

    // approve / rejected set decidedAt + decidedByUserId + rationale
    // superseded sets supersededById (decidedAt/by not set for superseded)
    if (body.status === 'approved' || body.status === 'rejected') {
      updates.decidedAt = now;
      updates.decidedByUserId = req.user?.id ?? null;
      if (body.rationale !== undefined) {
        updates.rationale = body.rationale;
      }
    }

    if (body.status === 'superseded') {
      updates.supersededById = body.supersededById;
      if (body.rationale !== undefined) {
        updates.rationale = body.rationale;
      }
    }

    const [row] = await db.drizzle
      .update(projectDecisions)
      .set(updates)
      .where(eq(projectDecisions.id, decisionId))
      .returning();

    eventBus.emitEvent({
      type: 'project.decision.updated' as any,
      companyId,
      payload: { decision: row, previousStatus: decision.status },
      timestamp: now.toISOString(),
    });

    res.json({ data: row });
  });

  return router;
}
