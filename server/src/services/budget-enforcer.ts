import { eq, sql } from 'drizzle-orm';
import logger from '../utils/logger.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';

/**
 * Budget enforcement service.
 *
 * Records costs against agents, checks thresholds, and emits alerts
 * when spending approaches or exceeds configured limits.
 */
export class BudgetEnforcer {
  constructor(private db: DbInstance) {}

  /**
   * Record a cost event for an agent and check alert thresholds.
   */
  async recordCost(
    agentId: string,
    costCents: number,
    options?: {
      taskId?: string;
      provider?: string;
      model?: string;
      inputTokens?: number;
      outputTokens?: number;
    },
  ): Promise<{
    costEvent: Record<string, unknown>;
    agent: Record<string, unknown>;
    alerts: string[];
  } | null> {
    const { agents, costEvents, budgetAlerts } = this.db.schema;

    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      logger.warn({ agentId }, 'BudgetEnforcer: agent not found');
      return null;
    }

    const now = new Date();
    const [event] = await this.db.drizzle
      .insert(costEvents)
      .values({
        companyId: agent.companyId,
        agentId,
        taskId: options?.taskId ?? null,
        provider: options?.provider ?? agent.provider,
        model: options?.model ?? agent.model,
        inputTokens: options?.inputTokens ?? 0,
        outputTokens: options?.outputTokens ?? 0,
        costCents,
        createdAt: now,
      })
      .returning();

    // Update agent spent counter
    const newSpent = agent.spentMonthlyCents + costCents;
    const [updatedAgent] = await this.db.drizzle
      .update(agents)
      .set({
        spentMonthlyCents: newSpent,
        updatedAt: now,
      })
      .where(eq(agents.id, agentId))
      .returning();

    eventBus.emitEvent({
      type: 'cost.recorded',
      companyId: agent.companyId,
      payload: { costEvent: event },
      timestamp: now.toISOString(),
    });

    // Check thresholds
    const triggeredAlerts: string[] = [];

    if (agent.budgetMonthlyCents > 0) {
      const utilizationPct = Math.round(
        (newSpent / agent.budgetMonthlyCents) * 100,
      );

      const alerts = await this.db.drizzle
        .select()
        .from(budgetAlerts)
        .where(eq(budgetAlerts.companyId, agent.companyId));

      for (const alert of alerts) {
        if (alert.triggered) continue;
        if (alert.agentId && alert.agentId !== agentId) continue;

        if (utilizationPct >= alert.thresholdPercent) {
          triggeredAlerts.push(
            `Budget ${alert.thresholdPercent}% threshold exceeded (${utilizationPct}% used)`,
          );

          await this.db.drizzle
            .update(budgetAlerts)
            .set({ triggered: true, triggeredAt: now })
            .where(eq(budgetAlerts.id, alert.id));

          eventBus.emitEvent({
            type: 'budget.threshold_exceeded',
            companyId: agent.companyId,
            payload: {
              agentId,
              agentName: agent.name,
              thresholdPercent: alert.thresholdPercent,
              currentPct: utilizationPct,
              spentCents: newSpent,
              budgetCents: agent.budgetMonthlyCents,
            },
            timestamp: now.toISOString(),
          });
        }
      }

      if (triggeredAlerts.length > 0) {
        logger.warn(
          { agentId, utilizationPct, alerts: triggeredAlerts.length },
          'BudgetEnforcer: threshold alerts triggered',
        );
      }
    }

    return {
      costEvent: event as unknown as Record<string, unknown>,
      agent: updatedAgent as unknown as Record<string, unknown>,
      alerts: triggeredAlerts,
    };
  }

  /**
   * Check remaining budget for an agent.
   */
  async checkBudget(agentId: string): Promise<{
    withinBudget: boolean;
    budgetCents: number;
    spentCents: number;
    remainingCents: number;
    utilizationPct: number;
  } | null> {
    const { agents } = this.db.schema;

    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) return null;

    const remaining = agent.budgetMonthlyCents - agent.spentMonthlyCents;
    const utilization =
      agent.budgetMonthlyCents > 0
        ? Math.round((agent.spentMonthlyCents / agent.budgetMonthlyCents) * 100)
        : 0;

    return {
      withinBudget: remaining > 0 || agent.budgetMonthlyCents === 0,
      budgetCents: agent.budgetMonthlyCents,
      spentCents: agent.spentMonthlyCents,
      remainingCents: Math.max(0, remaining),
      utilizationPct: utilization,
    };
  }

  /**
   * Reset monthly budget counters for all agents.
   * Intended to be called by a cron job at the start of each month.
   */
  async resetMonthlyBudgets(): Promise<number> {
    const { agents, companies, budgetAlerts } = this.db.schema;
    const now = new Date();

    const result = await this.db.drizzle
      .update(agents)
      .set({
        spentMonthlyCents: 0,
        updatedAt: now,
      })
      .returning();

    // Reset company-level spent counters
    await this.db.drizzle
      .update(companies)
      .set({
        spentMonthlyCents: 0,
        updatedAt: now,
      });

    // Reset budget alert triggers
    await this.db.drizzle
      .update(budgetAlerts)
      .set({ triggered: false, triggeredAt: null });

    logger.info(
      { agentsReset: result.length },
      'BudgetEnforcer: monthly budgets reset',
    );

    return result.length;
  }
}
