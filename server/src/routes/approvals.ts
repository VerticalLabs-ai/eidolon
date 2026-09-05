import { Router, type Request, type Response } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppError } from '../middleware/error-handler.js';
import { validate } from '../middleware/validate.js';
import { hasPermission, type Permission } from '../middleware/permissions.js';
import { isFeatureEnabled } from '../services/feature-flags.js';
import { validateIdempotencyKey } from '../services/mission/idempotency.js';
import { redactCanaries } from '../services/mission/reason-security.js';
import { MissionCommandService } from '../services/mission/commands.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import { resolveTaskProjectId } from '../utils/task-project-resolver.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const CreateApprovalBody = z.object({
  kind: z.enum(['budget_change', 'agent_termination', 'task_review', 'custom']).default('custom'),
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
  /**
   * Mission plan_gate delegation fields (VAL-CROSS-085). When the approval
   * is kind='plan_gate', the legacy decide route delegates to the Mission
   * command transaction using these fields plus the `If-Match` header and
   * `Idempotency-Key`. Without them, the route refuses to resolve a
   * plan_gate approval rather than bypassing the Mission transaction.
   */
  revisionId: z.string().uuid().optional(),
  contentHash: z.string().optional(),
  disposition: z.enum(['revise']).optional(),
  feedback: z.string().max(10_000).optional(),
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
  const { approvals, approvalComments, taskThreadItems, tasks, projectPlanSteps, projectPlans } =
    db.schema;

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

    const row = await db.drizzle.transaction(async (tx) => {
      const approvalValues: typeof approvals.$inferInsert = {
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
      };

      const [created] = await tx.insert(approvals).values(approvalValues).returning();

      if (created.taskId) {
        // Resolve project_id through a same-company join so stale/deleted/
        // cross-company task.project_id values yield NULL.
        const resolvedProjectId = await resolveTaskProjectId(tx, companyId, created.taskId);

        const threadValues: typeof taskThreadItems.$inferInsert = {
          id: randomUUID(),
          companyId,
          taskId: created.taskId,
          kind: 'approval_link',
          authorUserId: userId,
          content: created.title,
          payload: { approvalId: created.id, kind: created.kind, priority: created.priority },
          status: 'linked',
          relatedApprovalId: created.id,
          projectId: resolvedProjectId,
          createdAt: now,
          updatedAt: now,
        };

        await tx.insert(taskThreadItems).values(threadValues);
      }

      return created;
    });

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

    // VAL-CROSS-085: Mission plan_gate approvals must be resolved through
    // the Mission command transaction (with run version, revision ID, and
    // hash) rather than the legacy generic decide path, which would bypass
    // hash-bound governance and produce a divergent approval row. When the
    // approval is a plan_gate, the route either delegates with the
    // Mission-bound fields or refuses without resolving the approval.
    // Legacy plan_gate approvals (created by the project-plans advance-step
    // flow without a Mission binding) fall through to the generic decide path.
    if (existing.kind === 'plan_gate') {
      const [binding] = await db.drizzle
        .select()
        .from(db.schema.runPlanApprovalBindings)
        .where(
          and(
            eq(db.schema.runPlanApprovalBindings.companyId, companyId),
            eq(db.schema.runPlanApprovalBindings.approvalId, existing.id),
          ),
        )
        .limit(1);

      if (binding) {
        await handlePlanGateDecision(db, req, res, existing, body);
        return;
      }
      // No Mission binding → legacy plan_gate approval, fall through to generic.
    }

    const row = await db.drizzle.transaction(async (tx) => {
      const [updated] = await tx
        .update(approvals)
        .set({
          status: body.decision,
          resolutionNote: body.resolutionNote ?? null,
          resolvedByUserId: req.user?.id ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(approvals.id, id),
            eq(approvals.companyId, companyId),
            eq(approvals.status, 'pending'),
          ),
        )
        .returning();

      if (!updated) {
        throw new AppError(
          409,
          'APPROVAL_NOT_PENDING',
          `Approval ${id} was resolved by another request`,
        );
      }

      if (updated.taskId) {
        // Resolve project_id through a same-company join so stale/deleted/
        // cross-company task.project_id values yield NULL.
        const resolvedProjectId = await resolveTaskProjectId(tx, companyId, updated.taskId);

        const threadValues: typeof taskThreadItems.$inferInsert = {
          id: randomUUID(),
          companyId,
          taskId: updated.taskId,
          kind: 'decision',
          authorUserId: req.user?.id ?? null,
          content: body.resolutionNote ?? `Approval ${body.decision}`,
          payload: { approvalId: updated.id, decision: body.decision },
          status: body.decision === 'approved' ? 'accepted' : 'rejected',
          relatedApprovalId: updated.id,
          resolvedByUserId: req.user?.id ?? null,
          resolvedAt: now,
          projectId: resolvedProjectId,
          createdAt: now,
          updatedAt: now,
        };

        await tx.insert(taskThreadItems).values(threadValues);
      }

      // Plan gate resolution: update the linked plan step status.
      if (updated.planStepId) {
        if (body.decision === 'approved') {
          await tx
            .update(projectPlanSteps)
            .set({
              status: 'completed',
              completedAt: now,
              completedByUserId: req.user?.id ?? null,
              updatedAt: now,
            })
            .where(eq(projectPlanSteps.id, updated.planStepId));
        } else {
          await tx
            .update(projectPlanSteps)
            .set({
              status: 'blocked',
              updatedAt: now,
            })
            .where(eq(projectPlanSteps.id, updated.planStepId));
        }
      }

      return updated;
    });

    // Recalculate plan progress after a gate resolution changes step status.
    if (row.planStepId) {
      const [step] = await db.drizzle
        .select({ planId: projectPlanSteps.planId })
        .from(projectPlanSteps)
        .where(eq(projectPlanSteps.id, row.planStepId))
        .limit(1);

      if (step) {
        const steps = await db.drizzle
          .select({ status: projectPlanSteps.status })
          .from(projectPlanSteps)
          .where(eq(projectPlanSteps.planId, step.planId));

        const nonSkipped = steps.filter((s) => s.status !== 'skipped').length;
        const completed = steps.filter((s) => s.status === 'completed').length;
        const progress = nonSkipped > 0 ? Math.round((completed / nonSkipped) * 100) : 0;

        await db.drizzle
          .update(projectPlans)
          .set({ progress, updatedAt: now })
          .where(eq(projectPlans.id, step.planId));
      }
    }

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

// ---------------------------------------------------------------------------
// VAL-CROSS-085: Mission plan_gate delegation from the legacy decide route
// ---------------------------------------------------------------------------

/**
 * Resolve a Mission `plan_gate` approval by delegating to the Mission
 * command transaction. The legacy generic decide path must not bypass
 * hash-bound governance or produce a divergent approval row.
 *
 * When the required Mission-bound fields (revisionId, contentHash, If-Match,
 * Idempotency-Key) are present, the route delegates to
 * `MissionCommandService.submit` with `plan.approve` or `plan.reject`.
 * When any required field is missing, the route refuses with 409
 * `APPROVAL_REQUIRES_MISSION_FIELDS` without resolving the approval.
 *
 * Permission and actor checks mirror the dedicated Mission routes:
 * `mission.approve` (owner/admin only), human-only actor, and actor
 * derived from authenticated context (never the request body).
 */
async function handlePlanGateDecision(
  db: DbInstance,
  req: Request,
  res: Response,
  approval: { id: string; companyId: string; projectId: string | null },
  body: z.infer<typeof DecideBody>,
): Promise<void> {
  const { companyId } = routeParams(req);

  // Require the Mission feature flag, mission.approve permission, and a
  // human actor (owner/admin only, agent API keys denied).
  requirePlanGateAuthority(req, companyId);

  // Require the Mission-bound fields. Without them, refuse without
  // resolving the approval.
  if (!body.revisionId || !body.contentHash) {
    throw new AppError(
      409,
      'APPROVAL_REQUIRES_MISSION_FIELDS',
      'Mission plan_gate approvals require revisionId, contentHash, If-Match, and Idempotency-Key to resolve through the Mission command transaction',
    );
  }

  // Require the If-Match header and Idempotency-Key.
  const ifMatch = parseIfMatchHeader(req);
  const idempotencyKey = validateIdempotencyKey(req.get('Idempotency-Key'));

  // Look up the binding to find the run and project scope.
  const { runPlanApprovalBindings, missionRuns } = db.schema;
  const [binding] = await db.drizzle
    .select()
    .from(runPlanApprovalBindings)
    .where(
      and(
        eq(runPlanApprovalBindings.companyId, companyId),
        eq(runPlanApprovalBindings.approvalId, approval.id),
      ),
    )
    .limit(1);

  if (!binding) {
    throw new AppError(
      409,
      'APPROVAL_REQUIRES_MISSION_FIELDS',
      'No Mission plan approval binding found for this plan_gate approval',
    );
  }

  // Load the run to get project scope for project ownership validation.
  const [run] = await db.drizzle
    .select()
    .from(missionRuns)
    .where(and(eq(missionRuns.companyId, companyId), eq(missionRuns.id, binding.runId)))
    .limit(1);

  if (!run) {
    throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
  }

  // Validate project ownership (same-company project scope).
  await validateProjectOwnership(db, companyId, run.projectId);

  // Delegate to the Mission command transaction.
  const userId = req.user?.id ?? null;
  const service = new MissionCommandService(db);

  if (body.decision === 'approved') {
    const result = await service.submit({
      companyId,
      projectId: run.projectId,
      runId: run.id,
      type: 'plan.approve',
      body: { revisionId: body.revisionId, contentHash: body.contentHash },
      idempotencyKey,
      ifMatch,
      actorType: 'user',
      actorId: userId,
      traceId: req.traceId ?? null,
    });

    sendPlanGateResponse(res, companyId, run.projectId, result);
  } else {
    const result = await service.submit({
      companyId,
      projectId: run.projectId,
      runId: run.id,
      type: 'plan.reject',
      body: buildRejectBody(body),
      idempotencyKey,
      ifMatch,
      actorType: 'user',
      actorId: userId,
      traceId: req.traceId ?? null,
    });

    sendPlanGateResponse(res, companyId, run.projectId, result);
  }
}

/**
 * Require the Mission feature flag, mission.approve permission (owner/admin),
 * and a human actor for plan_gate decisions. Mirrors the dedicated Mission
 * route's `requireMissionEnabled`, `requireMissionApprove`, and
 * `requireHumanActor` checks.
 */
function requirePlanGateAuthority(req: Request, companyId: string): void {
  if (!isFeatureEnabled('missionAgentIntelligence', companyId)) {
    throw new AppError(
      404,
      'FEATURE_NOT_AVAILABLE',
      'Mission runs are not available for this company',
    );
  }

  const role = (req.organizationMembership?.role ?? 'viewer') as
    'owner' | 'admin' | 'member' | 'viewer';
  if (!hasPermission(role, 'mission.approve' as Permission)) {
    throw new AppError(
      403,
      'INSUFFICIENT_PERMISSION',
      'Mission plan approval requires the mission.approve permission',
    );
  }

  const userId = req.user?.id;
  if (userId && String(userId).startsWith('agent:')) {
    throw new AppError(
      403,
      'INSUFFICIENT_PERMISSION',
      'Plan governance decisions require a human actor; agent API keys are not permitted',
    );
  }
}

/**
 * Parse the `If-Match` header into a state version integer. Returns 428
 * when absent and 400 when malformed.
 */
function parseIfMatchHeader(req: Request): number {
  const header = req.get('If-Match');
  if (!header) {
    throw new AppError(
      428,
      'PRECONDITION_REQUIRED',
      'Mission plan_gate decisions require an If-Match header with the current run state version',
    );
  }
  const match = /^"(\d+)"$/.exec(header.trim());
  if (!match) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'If-Match must be a quoted state version, e.g. "3"',
    );
  }
  return Number(match[1]);
}

/**
 * Build the `plan.reject` command body from the legacy decide body,
 * applying canary redaction to reason and feedback.
 */
function buildRejectBody(body: z.infer<typeof DecideBody>): Record<string, unknown> {
  const commandBody: Record<string, unknown> = {
    revisionId: body.revisionId,
    contentHash: body.contentHash,
    reason: redactCanaries(body.resolutionNote ?? 'Rejected via Approvals').redacted,
  };

  if (body.disposition === 'revise') {
    commandBody.disposition = 'revise';
    commandBody.feedback = body.feedback
      ? redactCanaries(body.feedback).redacted
      : redactCanaries(body.resolutionNote ?? '').redacted;
  }

  return commandBody;
}

/**
 * Send the Mission command response for a plan_gate delegation. Mirrors
 * the Mission route's `sendCommandResponse` shape but translates Mission
 * error sanitizer behavior for the legacy route.
 */
function sendPlanGateResponse(
  res: Response,
  companyId: string,
  projectId: string,
  result: {
    statusCode: number;
    etag: number;
    run: { id: string };
    command: unknown;
    successorRunId?: string;
  },
): void {
  res.status(result.statusCode).setHeader('ETag', `"${result.etag}"`);
  if (result.successorRunId) {
    res.location(
      `/api/companies/${companyId}/projects/${projectId}/mission-runs/${result.successorRunId}`,
    );
  }
  res.json({ data: { run: result.run, command: result.command } });
}
