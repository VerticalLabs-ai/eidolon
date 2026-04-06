import { Router } from 'express';
import { eq, sql, and, gte, desc } from 'drizzle-orm';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

export function analyticsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { agents, tasks, companies, costEvents } = db.schema;

  // GET /api/companies/:companyId/analytics/overview
  router.get('/overview', async (req, res) => {
    const companyId = routeParams(req).companyId;

    const [company] = await db.drizzle
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);

    // Agent summary
    const agentSummary = await db.drizzle
      .select({
        status: agents.status,
        count: sql<number>`count(*)`,
      })
      .from(agents)
      .where(eq(agents.companyId, companyId))
      .groupBy(agents.status);

    // Task summary
    const taskSummary = await db.drizzle
      .select({
        status: tasks.status,
        count: sql<number>`count(*)`,
      })
      .from(tasks)
      .where(eq(tasks.companyId, companyId))
      .groupBy(tasks.status);

    // Total costs this month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [monthlyCost] = await db.drizzle
      .select({
        totalCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.createdAt, startOfMonth),
        ),
      );

    const agentsByStatus: Record<string, number> = {};
    let totalAgents = 0;
    for (const r of agentSummary) {
      agentsByStatus[r.status] = Number(r.count);
      totalAgents += Number(r.count);
    }

    const tasksByStatus: Record<string, number> = {};
    let totalTasks = 0;
    for (const r of taskSummary) {
      tasksByStatus[r.status] = Number(r.count);
      totalTasks += Number(r.count);
    }

    res.json({
      data: {
        company: company ?? null,
        agents: { total: totalAgents, byStatus: agentsByStatus },
        tasks: { total: totalTasks, byStatus: tasksByStatus },
        costs: {
          budgetCents: company?.budgetMonthlyCents ?? 0,
          spentThisMonthCents: Number(monthlyCost?.totalCents ?? 0),
        },
      },
    });
  });

  // GET /api/companies/:companyId/analytics/agents
  router.get('/agents', async (req, res) => {
    const companyId = routeParams(req).companyId;

    const agentList = await db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.companyId, companyId));

    const agentMetrics = await Promise.all(
      agentList.map(async (agent) => {
        const taskCounts = await db.drizzle
          .select({
            status: tasks.status,
            count: sql<number>`count(*)`,
          })
          .from(tasks)
          .where(
            and(
              eq(tasks.companyId, companyId),
              eq(tasks.assigneeAgentId, agent.id),
            ),
          )
          .groupBy(tasks.status);

        const byStatus: Record<string, number> = {};
        let total = 0;
        for (const r of taskCounts) {
          byStatus[r.status] = Number(r.count);
          total += Number(r.count);
        }

        return {
          agentId: agent.id,
          name: agent.name,
          role: agent.role,
          status: agent.status,
          budget: {
            monthlyCents: agent.budgetMonthlyCents,
            spentCents: agent.spentMonthlyCents,
            utilizationPct:
              agent.budgetMonthlyCents > 0
                ? Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)
                : 0,
          },
          tasks: { total, byStatus },
          lastHeartbeatAt: agent.lastHeartbeatAt,
        };
      }),
    );

    res.json({ data: agentMetrics });
  });

  // GET /api/companies/:companyId/analytics/costs
  router.get('/costs', async (req, res) => {
    const companyId = routeParams(req).companyId;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Daily cost totals
    const dailyCosts = await db.drizzle
      .select({
        day: sql<string>`date(${costEvents.createdAt} / 1000, 'unixepoch')`,
        totalCents: sql<number>`sum(${costEvents.costCents})`,
        eventCount: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.createdAt, thirtyDaysAgo),
        ),
      )
      .groupBy(sql`date(${costEvents.createdAt} / 1000, 'unixepoch')`)
      .orderBy(sql`date(${costEvents.createdAt} / 1000, 'unixepoch')`);

    // By provider
    const byProvider = await db.drizzle
      .select({
        provider: costEvents.provider,
        totalCents: sql<number>`sum(${costEvents.costCents})`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.createdAt, thirtyDaysAgo),
        ),
      )
      .groupBy(costEvents.provider);

    // By model
    const byModel = await db.drizzle
      .select({
        model: costEvents.model,
        totalCents: sql<number>`sum(${costEvents.costCents})`,
        totalInputTokens: sql<number>`sum(${costEvents.inputTokens})`,
        totalOutputTokens: sql<number>`sum(${costEvents.outputTokens})`,
      })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          gte(costEvents.createdAt, thirtyDaysAgo),
        ),
      )
      .groupBy(costEvents.model);

    res.json({
      data: {
        daily: dailyCosts.map((r) => ({
          date: r.day,
          totalCents: Number(r.totalCents),
          eventCount: Number(r.eventCount),
        })),
        byProvider: byProvider.map((r) => ({
          provider: r.provider,
          totalCents: Number(r.totalCents),
        })),
        byModel: byModel.map((r) => ({
          model: r.model,
          totalCents: Number(r.totalCents),
          totalInputTokens: Number(r.totalInputTokens),
          totalOutputTokens: Number(r.totalOutputTokens),
        })),
      },
    });
  });

  // GET /api/companies/:companyId/analytics/tasks
  router.get('/tasks', async (req, res) => {
    const companyId = routeParams(req).companyId;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Completed tasks per day
    const completedByDay = await db.drizzle
      .select({
        day: sql<string>`date(${tasks.completedAt} / 1000, 'unixepoch')`,
        count: sql<number>`count(*)`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.status, 'done'),
          gte(tasks.completedAt, thirtyDaysAgo),
        ),
      )
      .groupBy(sql`date(${tasks.completedAt} / 1000, 'unixepoch')`)
      .orderBy(sql`date(${tasks.completedAt} / 1000, 'unixepoch')`);

    // By priority
    const byPriority = await db.drizzle
      .select({
        priority: tasks.priority,
        total: sql<number>`count(*)`,
        done: sql<number>`sum(case when ${tasks.status} = 'done' then 1 else 0 end)`,
      })
      .from(tasks)
      .where(eq(tasks.companyId, companyId))
      .groupBy(tasks.priority);

    // By type
    const byType = await db.drizzle
      .select({
        type: tasks.type,
        count: sql<number>`count(*)`,
      })
      .from(tasks)
      .where(eq(tasks.companyId, companyId))
      .groupBy(tasks.type);

    res.json({
      data: {
        completedByDay: completedByDay.map((r) => ({
          date: r.day,
          count: Number(r.count),
        })),
        byPriority: byPriority.map((r) => ({
          priority: r.priority,
          total: Number(r.total),
          done: Number(r.done),
        })),
        byType: byType.map((r) => ({
          type: r.type,
          count: Number(r.count),
        })),
      },
    });
  });

  return router;
}
