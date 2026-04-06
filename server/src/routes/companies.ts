import { Router } from 'express';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import eventBus from '../realtime/events.js';
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
    const rows = await db.drizzle.select().from(companies).all();
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
      // Hard delete: remove all related data then the company
      // Order matters due to foreign key constraints
      const tables = [
        db.schema.agentCollaborations,
        db.schema.agentEvaluations,
        db.schema.agentMemories,
        db.schema.agentExecutions,
        db.schema.agentConfigRevisions,
        db.schema.agentFiles,
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
        db.schema.activityLog,
      ];

      for (const table of tables) {
        await db.drizzle.delete(table).where(eq((table as any).companyId, companyId));
      }

      // Delete knowledge (chunks reference documents, not company directly)
      const docs = await db.drizzle
        .select({ id: db.schema.knowledgeDocuments.id })
        .from(db.schema.knowledgeDocuments)
        .where(eq(db.schema.knowledgeDocuments.companyId, companyId));
      for (const doc of docs) {
        await db.drizzle.delete(db.schema.knowledgeChunks).where(eq(db.schema.knowledgeChunks.documentId, doc.id));
      }
      await db.drizzle.delete(db.schema.knowledgeDocuments).where(eq(db.schema.knowledgeDocuments.companyId, companyId));

      // Delete prompt versions (reference templates, not company)
      const templates = await db.drizzle
        .select({ id: db.schema.promptTemplates.id })
        .from(db.schema.promptTemplates)
        .where(eq(db.schema.promptTemplates.companyId, companyId));
      for (const tmpl of templates) {
        await db.drizzle.delete(db.schema.promptVersions).where(eq(db.schema.promptVersions.templateId, tmpl.id));
      }
      await db.drizzle.delete(db.schema.promptTemplates).where(eq(db.schema.promptTemplates.companyId, companyId));

      // Delete agents (after all agent-referencing tables)
      await db.drizzle.delete(db.schema.agents).where(eq(db.schema.agents.companyId, companyId));

      // Finally delete the company
      await db.drizzle.delete(companies).where(eq(companies.id, companyId));

      eventBus.emitEvent({
        type: 'company.deleted',
        companyId,
        payload: { company: existing },
        timestamp: new Date().toISOString(),
      });

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
