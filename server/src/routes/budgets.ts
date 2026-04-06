import { Router } from 'express';
import { eq, and, gte, lte, desc, sql } from 'drizzle-orm';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

const RecordCostBody = z.object({
  agentId: z.string().uuid(),
  taskId: z.string().uuid().optional(),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  costCents: z.number().int().nonnegative(),
});

const CostListQuery = z.object({
  agentId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const CreateAlertBody = z.object({
  agentId: z.string().uuid().nullable().default(null),
  thresholdPercent: z.number().int().min(1).max(200),
});

export function budgetsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { costEvents, budgetAlerts, agents } = db.schema;

  // GET /api/companies/:companyId/costs
  router.get('/costs', validate(CostListQuery, 'query'), async (req, res) => {
    const companyId = routeParams(req).companyId;
    const query = req.query as unknown as z.infer<typeof CostListQuery>;

    const conditions = [eq(costEvents.companyId, companyId)];
    if (query.agentId) conditions.push(eq(costEvents.agentId, query.agentId));
    if (query.from) conditions.push(gte(costEvents.createdAt, query.from));
    if (query.to) conditions.push(lte(costEvents.createdAt, query.to));

    const rows = await db.drizzle
      .select()
      .from(costEvents)
      .where(and(...conditions))
      .orderBy(desc(costEvents.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    const [{ total }] = await db.drizzle
      .select({ total: sql<number>`count(*)` })
      .from(costEvents)
      .where(and(...conditions));

    res.json({ data: rows, meta: { total: Number(total), limit: query.limit, offset: query.offset } });
  });

  // GET /api/companies/:companyId/costs/summary
  router.get('/costs/summary', async (req, res) => {
    const companyId = routeParams(req).companyId;

    // By agent
    const byAgent = await db.drizzle
      .select({
        agentId: costEvents.agentId,
        totalCents: sql<number>`sum(${costEvents.costCents})`,
        totalInputTokens: sql<number>`sum(${costEvents.inputTokens})`,
        totalOutputTokens: sql<number>`sum(${costEvents.outputTokens})`,
        eventCount: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(eq(costEvents.companyId, companyId))
      .groupBy(costEvents.agentId);

    // By provider
    const byProvider = await db.drizzle
      .select({
        provider: costEvents.provider,
        totalCents: sql<number>`sum(${costEvents.costCents})`,
        eventCount: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(eq(costEvents.companyId, companyId))
      .groupBy(costEvents.provider);

    // Grand total
    const [grandTotal] = await db.drizzle
      .select({
        totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)`,
        totalEvents: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(eq(costEvents.companyId, companyId));

    res.json({
      data: {
        totalCents: Number(grandTotal?.totalCents ?? 0),
        totalEvents: Number(grandTotal?.totalEvents ?? 0),
        byAgent: byAgent.map((r) => ({
          agentId: r.agentId,
          totalCents: Number(r.totalCents),
          totalInputTokens: Number(r.totalInputTokens),
          totalOutputTokens: Number(r.totalOutputTokens),
          eventCount: Number(r.eventCount),
        })),
        byProvider: byProvider.map((r) => ({
          provider: r.provider,
          totalCents: Number(r.totalCents),
          eventCount: Number(r.eventCount),
        })),
      },
    });
  });

  // POST /api/companies/:companyId/costs
  router.post('/costs', validate(RecordCostBody), async (req, res) => {
    const body = req.body as z.infer<typeof RecordCostBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const [row] = await db.drizzle
      .insert(costEvents)
      .values({
        companyId,
        agentId: body.agentId,
        taskId: body.taskId ?? null,
        provider: body.provider,
        model: body.model,
        inputTokens: body.inputTokens,
        outputTokens: body.outputTokens,
        costCents: body.costCents,
        createdAt: now,
      })
      .returning();

    // Update agent spent counter
    await db.drizzle
      .update(agents)
      .set({
        spentMonthlyCents: sql`${agents.spentMonthlyCents} + ${body.costCents}`,
        updatedAt: now,
      })
      .where(eq(agents.id, body.agentId));

    eventBus.emitEvent({
      type: 'cost.recorded',
      companyId,
      payload: { costEvent: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/budget/alerts
  router.get('/budget/alerts', async (req, res) => {
    const rows = await db.drizzle
      .select()
      .from(budgetAlerts)
      .where(eq(budgetAlerts.companyId, routeParams(req).companyId));
    res.json({ data: rows });
  });

  // POST /api/companies/:companyId/budget/alerts
  router.post('/budget/alerts', validate(CreateAlertBody), async (req, res) => {
    const body = req.body as z.infer<typeof CreateAlertBody>;
    const companyId = routeParams(req).companyId;
    const now = new Date();

    const [row] = await db.drizzle
      .insert(budgetAlerts)
      .values({
        companyId,
        agentId: body.agentId,
        thresholdPercent: body.thresholdPercent,
        triggered: false,
        createdAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'budget.alert',
      companyId,
      payload: { alert: row },
      timestamp: now.toISOString(),
    });

    res.status(201).json({ data: row });
  });

  return router;
}
