import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
import { clearCompanyPresence } from '../realtime/presence-store.js';
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
  const { companies, agents, tasks } = db.schema;

  // GET /api/companies - list all
  router.get('/', async (_req, res) => {
    const rows = await db.drizzle.select().from(companies);
    res.json({ data: rows });
  });

  // POST /api/companies - create
  router.post('/', validate(CreateCompanyBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateCompanyBody>;
    const now = new Date();
    const [row] = await db.drizzle
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

  // PATCH /api/companies/:id - update
  router.patch('/:id', validate(UpdateCompanyBody), async (req, res) => {
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
  });

  // DELETE /api/companies/:id - soft delete (archive) or hard delete with ?hard=true
  router.delete('/:id', async (req, res) => {
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
          await tx.delete(db.schema.knowledgeChunks).where(eq(db.schema.knowledgeChunks.documentId, doc.id));
        }
        const templates = await tx
          .select({ id: db.schema.promptTemplates.id })
          .from(db.schema.promptTemplates)
          .where(eq(db.schema.promptTemplates.companyId, companyId));
        for (const template of templates) {
          await tx.delete(db.schema.promptVersions).where(eq(db.schema.promptVersions.templateId, template.id));
        }
        // Chunks also carry a denormalized company_id and may exist even when
        // their document has already been removed.
        await deleteByCompany(db.schema.knowledgeChunks);
        const approvals = await tx
          .select({ id: db.schema.approvals.id })
          .from(db.schema.approvals)
          .where(eq(db.schema.approvals.companyId, companyId));
        for (const approval of approvals) {
          await tx.delete(db.schema.approvalComments).where(eq(db.schema.approvalComments.approvalId, approval.id));
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
