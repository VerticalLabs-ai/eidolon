import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { eq, sql, inArray, and } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import { clearCompanyPresence } from '../realtime/presence-store.js';
import { requireStepUp } from '../services/stepup-service.js';
import { hasPermission, type Permission, type Role } from '../middleware/permissions.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const CreateCompanyBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  mission: z.string().max(2000).optional(),
  status: z.enum(['active', 'paused', 'archived']).default('active'),
  budgetMonthlyCents: z.number().int().nonnegative().default(0),
  settings: z.record(z.unknown()).default({}),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color')
    .optional(),
  logoUrl: z.string().url().optional(),
});

const UpdateCompanyBody = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  mission: z.string().max(2000).nullable().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
  settings: z.record(z.unknown()).optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color')
    .nullable()
    .optional(),
  logoUrl: z.string().url().nullable().optional(),
});

export function companiesRouter(db: DbInstance): Router {
  const router = Router();
  const { companies, agents, tasks, companyMembers } = db.schema;

  // Capture auth mode at creation time (same pattern as createAuthMiddleware).
  // process.env.AUTH_MODE is set during createApp() and may be restored
  // afterward, so we must not read it at request time.
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';

  /**
   * Resolve the effective user id for the current request.
   *
   * In local_trusted mode, `requireAuth` injects `dev-user-000` and does
   * not process impersonation headers.  The `X-Eidolon-Test-User-Id`
   * header lets tests simulate different users (same pattern as
   * `resolveMembership` in auth.ts).  In authenticated (Clerk) mode the
   * header is ignored and the real Clerk user id is used.
   */
  function resolveUserId(req: Request): string {
    if (isLocalTrusted) {
      const testUserId = req.get('X-Eidolon-Test-User-Id');
      if (testUserId) {
        return testUserId;
      }
    }
    return req.user?.id ?? 'dev-user-000';
  }

  /**
   * Permission middleware for company-level operations that use `:id` as
   * the route parameter (not `:companyId`). This is needed because the
   * companies router is mounted at `/api/companies` with `requireAuth`
   * only — the `requirePermission` middleware in auth.ts reads
   * `req.params.companyId`, which is not set for `/:id` routes.
   *
   * Resolves the user's role from `company_members` (or local_trusted
   * impersonation/default) and checks `hasPermission` against the
   * permission matrix. Sets `req.organizationMembership` for downstream
   * handlers.
   */
  function checkCompanyPermission(permission: Permission) {
    return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
      const companyId = String(req.params.id ?? '');
      if (!companyId) {
        return next(new AppError(400, 'BAD_REQUEST', 'Company ID is required'));
      }

      // Platform admin bypass (authenticated mode only)
      if (!isLocalTrusted && req.user?.role === 'admin') {
        req.organizationMembership = {
          id: 'admin-bypass',
          role: 'owner',
          organizationId: companyId,
          userId: req.user.id,
        };
        return next();
      }

      let role: string;
      if (isLocalTrusted) {
        const testRole = req.get('X-Eidolon-Test-Org-Role');
        const validRoles = ['owner', 'admin', 'member', 'viewer'];
        if (testRole && validRoles.includes(testRole)) {
          role = testRole;
        } else {
          const userId = resolveUserId(req);
          try {
            const [memberRow] = await db.drizzle
              .select()
              .from(companyMembers)
              .where(
                and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)),
              )
              .limit(1);
            role = memberRow?.role ?? 'owner';
          } catch {
            role = 'owner';
          }
        }
      } else {
        if (!req.user) {
          return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
        }
        try {
          const [memberRow] = await db.drizzle
            .select()
            .from(companyMembers)
            .where(
              and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, req.user.id)),
            )
            .limit(1);
          if (!memberRow) {
            return next(new AppError(403, 'NOT_MEMBER', 'You are not a member of this company'));
          }
          role = memberRow.role;
        } catch {
          return next(new AppError(403, 'NOT_MEMBER', 'You are not a member of this company'));
        }
      }

      if (!hasPermission(role as Role, permission)) {
        return next(
          new AppError(
            403,
            'INSUFFICIENT_PERMISSION',
            `This action requires '${permission}' permission`,
          ),
        );
      }

      req.organizationMembership = {
        id: 'local',
        role,
        organizationId: companyId,
        userId: resolveUserId(req),
      };
      next();
    };
  }

  // GET /api/companies - list companies where the user has a company_members row
  router.get('/', async (req, res) => {
    const userId = resolveUserId(req);
    const memberCompanyIds = db.drizzle
      .select({ companyId: companyMembers.companyId })
      .from(companyMembers)
      .where(eq(companyMembers.userId, userId));

    const rows = await db.drizzle
      .select()
      .from(companies)
      .where(inArray(companies.id, memberCompanyIds));

    res.json({ data: rows });
  });

  // POST /api/companies - create
  router.post('/', validate(CreateCompanyBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateCompanyBody>;
    const userId = resolveUserId(req);
    const now = new Date();

    // Insert company and owner membership atomically so the creator is
    // always recorded as the owner of their new company (VAL-RBAC-012).
    const [row] = await db.drizzle.transaction(async (tx) => {
      const [company] = await tx
        .insert(companies)
        .values({
          name: body.name,
          description: body.description ?? null,
          mission: body.mission ?? null,
          status: body.status,
          budgetMonthlyCents: body.budgetMonthlyCents,
          spentMonthlyCents: 0,
          settings: body.settings,
          brandColor: body.brandColor ?? null,
          logoUrl: body.logoUrl ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      await tx.insert(companyMembers).values({
        companyId: company.id,
        userId,
        role: 'owner',
        createdByUserId: userId,
      });

      return [company];
    });

    eventBus.emitEvent({
      type: 'company.created',
      companyId: row.id,
      payload: { company: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:id - get by id
  router.get('/:id', async (req, res) => {
    const [row] = await db.drizzle
      .select()
      .from(companies)
      .where(eq(companies.id, routeParams(req).id))
      .limit(1);

    if (!row) {
      throw new AppError(404, 'COMPANY_NOT_FOUND', `Company ${routeParams(req).id} not found`);
    }
    res.json({ data: row });
  });

  // GET /api/companies/:id/my-role - current user's role in this company
  // Permission: company.view (all members can view; non-members get 403)
  router.get('/:id/my-role', async (req, res) => {
    const companyId = routeParams(req).id;
    const userId = resolveUserId(req);

    const [memberRow] = await db.drizzle
      .select({ role: companyMembers.role })
      .from(companyMembers)
      .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)))
      .limit(1);

    if (!memberRow) {
      throw new AppError(403, 'NOT_MEMBER', 'You are not a member of this company');
    }

    res.json({ data: { role: memberRow.role } });
  });

  // PATCH /api/companies/:id - update (requires company.settings.update permission)
  router.patch(
    '/:id',
    checkCompanyPermission('company.settings.update'),
    validate(UpdateCompanyBody),
    async (req, res) => {
      const body = req.body as z.infer<typeof UpdateCompanyBody>;

      const [existing] = await db.drizzle
        .select()
        .from(companies)
        .where(eq(companies.id, routeParams(req).id))
        .limit(1);

      if (!existing) {
        throw new AppError(404, 'COMPANY_NOT_FOUND', `Company ${routeParams(req).id} not found`);
      }

      const [updated] = await db.drizzle
        .update(companies)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(companies.id, routeParams(req).id))
        .returning();

      eventBus.emitEvent({
        type: 'company.updated',
        companyId: updated.id,
        payload: { company: updated, changes: Object.keys(body) },
        timestamp: new Date().toISOString(),
      });

      res.json({ data: updated });
    },
  );

  // DELETE /api/companies/:id - soft delete (archive) or hard delete with ?hard=true
  // (requires company.delete permission — owner only)
  router.delete('/:id', checkCompanyPermission('company.delete'), async (req, res) => {
    const companyId = routeParams(req).id;
    const hard = req.query.hard === 'true';

    const [existing] = await db.drizzle
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'COMPANY_NOT_FOUND', `Company ${companyId} not found`);
    }

    if (hard) {
      // VAL-SEC-002/003/008: permanent (hard) deletion is a sensitive
      // operation that requires step-up re-authentication. A valid step-up
      // session for the `company_delete` scope must be presented via the
      // `X-Eidolon-Step-Up-Token` header or `?stepUpToken=` query; absent
      // or expired → 403 MFA_STEP_UP_REQUIRED and NO mutation occurs.
      const actingUserId = req.user?.id ?? 'dev-user-000';
      const stepUpToken =
        (req.query.stepUpToken as string | undefined) ?? req.get('X-Eidolon-Step-Up-Token') ?? null;
      await requireStepUp(db, actingUserId, 'company_delete', stepUpToken);

      const deletedCompanyName = existing.name;
      // Every hard-delete operation must be atomic. In particular, the company
      // must not be left partially cleaned if a newly-added company-scoped
      // table rejects its delete.
      await db.drizzle.transaction(async (tx) => {
        const deleteByCompany = async (table: any) => {
          await tx.delete(table).where(eq(table.companyId, companyId));
        };

        // Delete indirect children before their parent rows.
        const docs = await tx
          .select({ id: db.schema.knowledgeDocuments.id })
          .from(db.schema.knowledgeDocuments)
          .where(eq(db.schema.knowledgeDocuments.companyId, companyId));
        for (const doc of docs) {
          await tx
            .delete(db.schema.knowledgeChunks)
            .where(eq(db.schema.knowledgeChunks.documentId, doc.id));
        }
        const templates = await tx
          .select({ id: db.schema.promptTemplates.id })
          .from(db.schema.promptTemplates)
          .where(eq(db.schema.promptTemplates.companyId, companyId));
        for (const template of templates) {
          await tx
            .delete(db.schema.promptVersions)
            .where(eq(db.schema.promptVersions.templateId, template.id));
        }
        // Chunks also carry a denormalized company_id and may exist even when
        // their document has already been removed.
        await deleteByCompany(db.schema.knowledgeChunks);
        const approvals = await tx
          .select({ id: db.schema.approvals.id })
          .from(db.schema.approvals)
          .where(eq(db.schema.approvals.companyId, companyId));
        for (const approval of approvals) {
          await tx
            .delete(db.schema.approvalComments)
            .where(eq(db.schema.approvalComments.approvalId, approval.id));
        }

        // Audit and join rows reference agents, tasks, executions, approvals,
        // plans, and project threads with NO ACTION foreign keys.
        for (const table of [
          db.schema.taskThreadItems,
          db.schema.taskCheckouts,
          db.schema.agentCollaborations,
          db.schema.agentEvaluations,
          db.schema.agentMemories,
          db.schema.agentConfigRevisions,
          db.schema.agentFiles,
          db.schema.mcpToolCalls,
          db.schema.agentRuntimeSessions,
          db.schema.workspaceLifecycleEvents,
          db.schema.executionEnvironments,
          db.schema.automationRuns,
          db.schema.taskHolds,
          db.schema.routines,
          db.schema.agentSkills,
          db.schema.companySkills,
          db.schema.approvals,
          db.schema.projectDecisions,
          db.schema.projectOutcomes,
          db.schema.projectPlanSteps,
          db.schema.projectPlans,
          db.schema.projectThreads,
          db.schema.agentExecutions,
        ]) {
          await deleteByCompany(table);
        }

        // Remaining direct company rows. These must be removed before the
        // company because their foreign keys use the default NO ACTION.
        for (const table of [
          db.schema.costEvents,
          db.schema.budgetAlerts,
          db.schema.heartbeats,
          db.schema.messages,
          db.schema.tasks,
          db.schema.goals,
          db.schema.workflows,
          db.schema.projects,
          db.schema.webhooks,
          db.schema.secrets,
          db.schema.integrations,
          db.schema.mcpServers,
          db.schema.inboxReadStates,
          db.schema.activityLog,
          db.schema.knowledgeDocuments,
          db.schema.promptTemplates,
        ]) {
          await deleteByCompany(table);
        }

        await tx.delete(db.schema.agents).where(eq(db.schema.agents.companyId, companyId));
        await tx.delete(companies).where(eq(companies.id, companyId));
      });

      eventBus.emitEvent({
        type: 'company.deleted',
        companyId,
        payload: { company: existing },
        timestamp: new Date().toISOString(),
      });

      // Audit: company permanent deletion is security-relevant (VAL-SEC-007).
      // Inserted AFTER the transaction so the cascade (which deletes the
      // company's other activity_log rows) doesn't remove this audit entry.
      // activity_log.company_id is a plain text column (no FK), so the row
      // survives the company deletion.
      await db.drizzle.insert(db.schema.activityLog).values({
        companyId,
        actorType: 'user',
        actorId: actingUserId,
        action: 'company.delete_permanent',
        entityType: 'company',
        entityId: companyId,
        description: `Permanently deleted company "${deletedCompanyName}"`,
        metadata: { hard: true, companyName: deletedCompanyName },
        createdAt: new Date(),
      });

      // Clear in-memory presence entries for the deleted company so stale
      // viewing/typing indicators don't linger until the TTL sweep.
      clearCompanyPresence(companyId);

      res.status(204).end();
    } else {
      // Soft delete (archive)
      const [archived] = await db.drizzle
        .update(companies)
        .set({ status: 'archived', updatedAt: new Date() })
        .where(eq(companies.id, companyId))
        .returning();

      eventBus.emitEvent({
        type: 'company.archived',
        companyId: archived.id,
        payload: { company: archived },
        timestamp: new Date().toISOString(),
      });

      res.json({ data: archived });
    }
  });

  // GET /api/companies/:id/dashboard - aggregated dashboard
  router.get('/:id/dashboard', async (req, res) => {
    const companyId = routeParams(req).id;

    const [company] = await db.drizzle
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    if (!company) {
      throw new AppError(404, 'COMPANY_NOT_FOUND', `Company ${companyId} not found`);
    }

    // Agent counts by status
    const agentRows = await db.drizzle
      .select({
        status: agents.status,
        count: sql<number>`count(*)`,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .groupBy(agents.status);

    const agentStats: Record<string, number> = {};
    let totalAgents = 0;
    for (const r of agentRows) {
      agentStats[r.status] = Number(r.count);
      totalAgents += Number(r.count);
    }

    // Task counts by status
    const taskRows = await db.drizzle
      .select({
        status: tasks.status,
        count: sql<number>`count(*)`,
      })
      .from(tasks)
      .where(eq(tasks.companyId, companyId))
      .groupBy(tasks.status);

    const taskStats: Record<string, number> = {};
    let totalTasks = 0;
    for (const r of taskRows) {
      taskStats[r.status] = Number(r.count);
      totalTasks += Number(r.count);
    }

    // Cost summary from agents
    const [costRow] = await db.drizzle
      .select({
        totalSpent: sql<number>`coalesce(sum(${agents.spentMonthlyCents}), 0)`,
        totalBudget: sql<number>`coalesce(sum(${agents.budgetMonthlyCents}), 0)`,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId));

    res.json({
      data: {
        company,
        agents: {
          total: totalAgents,
          byStatus: agentStats,
        },
        tasks: {
          total: totalTasks,
          byStatus: taskStats,
        },
        costs: {
          budgetCents: company.budgetMonthlyCents,
          spentCents: company.spentMonthlyCents,
          agentBudgetCents: Number(costRow?.totalBudget ?? 0),
          agentSpentCents: Number(costRow?.totalSpent ?? 0),
        },
      },
    });
  });

  return router;
}
