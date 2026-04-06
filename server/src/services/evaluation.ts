import { eq, and, desc, sql, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../types.js';

export class EvaluationService {
  constructor(private db: DbInstance) {}

  /**
   * Auto-evaluate an agent's execution based on objective metrics.
   * Scores are 0-100.
   */
  async autoEvaluate(
    agentId: string,
    companyId: string,
    data: {
      executionId?: string;
      taskId?: string;
      completionTimeMs: number;
      tokenCount: number;
      costCents: number;
      taskCompleted: boolean;
      errorCount: number;
    },
  ) {
    const { agentEvaluations } = this.db.schema;

    // Quality score: task completion is primary, errors reduce the score
    let qualityScore = data.taskCompleted ? 80 : 20;
    if (data.errorCount === 0 && data.taskCompleted) {
      qualityScore = 100;
    } else if (data.errorCount === 1) {
      qualityScore = Math.max(qualityScore - 15, 0);
    } else if (data.errorCount >= 2) {
      qualityScore = Math.max(qualityScore - 30, 0);
    }

    // Speed score: tokens per millisecond ratio (higher = better)
    // Baseline: 1 token per 10ms is average (score 50)
    const tokensPerMs = data.tokenCount > 0 ? data.tokenCount / data.completionTimeMs : 0;
    let speedScore: number;
    if (data.completionTimeMs <= 0) {
      speedScore = 100;
    } else if (tokensPerMs >= 0.2) {
      speedScore = 100;
    } else if (tokensPerMs >= 0.1) {
      speedScore = 80;
    } else if (tokensPerMs >= 0.05) {
      speedScore = 60;
    } else if (tokensPerMs >= 0.02) {
      speedScore = 40;
    } else {
      speedScore = 20;
    }

    // Cost efficiency: cost per 1000 output tokens
    // Lower cost = better score
    const costPer1kTokens = data.tokenCount > 0 ? (data.costCents / data.tokenCount) * 1000 : 0;
    let costEfficiencyScore: number;
    if (data.costCents === 0) {
      costEfficiencyScore = 100;
    } else if (costPer1kTokens <= 0.5) {
      costEfficiencyScore = 100;
    } else if (costPer1kTokens <= 1) {
      costEfficiencyScore = 85;
    } else if (costPer1kTokens <= 3) {
      costEfficiencyScore = 70;
    } else if (costPer1kTokens <= 5) {
      costEfficiencyScore = 50;
    } else if (costPer1kTokens <= 10) {
      costEfficiencyScore = 30;
    } else {
      costEfficiencyScore = 15;
    }

    // Overall: weighted average (quality 40%, speed 30%, cost 30%)
    const overallScore = Math.round(
      qualityScore * 0.4 + speedScore * 0.3 + costEfficiencyScore * 0.3,
    );

    const id = randomUUID();
    const now = new Date();

    const [row] = await this.db.drizzle
      .insert(agentEvaluations)
      .values({
        id,
        companyId,
        agentId,
        executionId: data.executionId ?? null,
        taskId: data.taskId ?? null,
        qualityScore,
        speedScore,
        costEfficiencyScore,
        overallScore,
        evaluator: 'system',
        feedback: null,
        metrics: {
          completionTimeMs: data.completionTimeMs,
          tokenCount: data.tokenCount,
          costCents: data.costCents,
          taskCompleted: data.taskCompleted,
          errorCount: data.errorCount,
          tokensPerMs,
          costPer1kTokens,
        },
        createdAt: now,
      })
      .returning();

    return row;
  }

  /**
   * Manual evaluation by the board (human).
   * Quality score is 1-10 from user input, mapped to 0-100 internally.
   */
  async manualEvaluate(
    agentId: string,
    companyId: string,
    data: {
      executionId?: string;
      taskId?: string;
      qualityScore: number;
      feedback: string;
    },
  ) {
    const { agentEvaluations } = this.db.schema;

    // Map 1-10 to 0-100
    const qualityScore = Math.min(Math.max(Math.round(data.qualityScore * 10), 0), 100);

    const id = randomUUID();
    const now = new Date();

    const [row] = await this.db.drizzle
      .insert(agentEvaluations)
      .values({
        id,
        companyId,
        agentId,
        executionId: data.executionId ?? null,
        taskId: data.taskId ?? null,
        qualityScore,
        speedScore: null,
        costEfficiencyScore: null,
        overallScore: qualityScore, // manual evals use quality as overall
        evaluator: 'human',
        feedback: data.feedback,
        metrics: {},
        createdAt: now,
      })
      .returning();

    return row;
  }

  /**
   * Get agent performance summary with averages, trend, and recent evaluations.
   */
  async getAgentPerformance(agentId: string) {
    const { agentEvaluations } = this.db.schema;

    // Get all evaluations for the agent
    const allEvals = await this.db.drizzle
      .select()
      .from(agentEvaluations)
      .where(eq(agentEvaluations.agentId, agentId))
      .orderBy(desc(agentEvaluations.createdAt));

    const totalEvaluations = allEvals.length;

    if (totalEvaluations === 0) {
      return {
        averageScores: { quality: 0, speed: 0, costEfficiency: 0, overall: 0 },
        totalEvaluations: 0,
        trend: 'stable' as const,
        recentEvaluations: [],
      };
    }

    // Calculate averages
    let qualitySum = 0;
    let qualityCount = 0;
    let speedSum = 0;
    let speedCount = 0;
    let costSum = 0;
    let costCount = 0;
    let overallSum = 0;
    let overallCount = 0;

    for (const e of allEvals) {
      if (e.qualityScore != null) {
        qualitySum += e.qualityScore;
        qualityCount++;
      }
      if (e.speedScore != null) {
        speedSum += e.speedScore;
        speedCount++;
      }
      if (e.costEfficiencyScore != null) {
        costSum += e.costEfficiencyScore;
        costCount++;
      }
      if (e.overallScore != null) {
        overallSum += e.overallScore;
        overallCount++;
      }
    }

    const averageScores = {
      quality: qualityCount > 0 ? Math.round(qualitySum / qualityCount) : 0,
      speed: speedCount > 0 ? Math.round(speedSum / speedCount) : 0,
      costEfficiency: costCount > 0 ? Math.round(costSum / costCount) : 0,
      overall: overallCount > 0 ? Math.round(overallSum / overallCount) : 0,
    };

    // Calculate trend: compare last 5 vs previous 5 overall scores
    let trend: 'improving' | 'stable' | 'declining' = 'stable';
    const evalsWithOverall = allEvals.filter((e) => e.overallScore != null);

    if (evalsWithOverall.length >= 6) {
      const recent5 = evalsWithOverall.slice(0, 5);
      const prev5 = evalsWithOverall.slice(5, 10);

      const recentAvg =
        recent5.reduce((sum, e) => sum + (e.overallScore ?? 0), 0) / recent5.length;
      const prevAvg =
        prev5.reduce((sum, e) => sum + (e.overallScore ?? 0), 0) / prev5.length;

      const diff = recentAvg - prevAvg;
      if (diff > 5) trend = 'improving';
      else if (diff < -5) trend = 'declining';
    }

    return {
      averageScores,
      totalEvaluations,
      trend,
      recentEvaluations: allEvals.slice(0, 10),
    };
  }

  /**
   * Get company-wide agent rankings by average overall score.
   */
  async getCompanyRankings(companyId: string) {
    const { agentEvaluations, agents } = this.db.schema;

    // Get all evaluations for the company
    const rows = await this.db.drizzle
      .select({
        agentId: agentEvaluations.agentId,
        agentName: agents.name,
        role: agents.role,
        overallScore: agentEvaluations.overallScore,
        costCents: agentEvaluations.metrics,
      })
      .from(agentEvaluations)
      .leftJoin(agents, eq(agentEvaluations.agentId, agents.id))
      .where(eq(agentEvaluations.companyId, companyId))
      .orderBy(asc(agents.name));

    // Aggregate per agent
    const agentMap = new Map<
      string,
      {
        agentId: string;
        agentName: string;
        role: string;
        scores: number[];
        totalCostCents: number;
      }
    >();

    for (const row of rows) {
      if (!agentMap.has(row.agentId)) {
        agentMap.set(row.agentId, {
          agentId: row.agentId,
          agentName: row.agentName ?? 'Unknown',
          role: row.role ?? 'custom',
          scores: [],
          totalCostCents: 0,
        });
      }
      const entry = agentMap.get(row.agentId)!;
      if (row.overallScore != null) {
        entry.scores.push(row.overallScore);
      }
      const metrics = row.costCents as Record<string, unknown>;
      if (metrics && typeof metrics.costCents === 'number') {
        entry.totalCostCents += metrics.costCents;
      }
    }

    const rankings = Array.from(agentMap.values())
      .map((a) => ({
        agentId: a.agentId,
        agentName: a.agentName,
        role: a.role,
        averageScore:
          a.scores.length > 0
            ? Math.round(a.scores.reduce((s, v) => s + v, 0) / a.scores.length)
            : 0,
        totalTasks: a.scores.length,
        totalCostCents: a.totalCostCents,
      }))
      .sort((a, b) => b.averageScore - a.averageScore);

    return rankings;
  }

  /**
   * Get evaluation history for an agent.
   */
  async getEvaluations(agentId: string, limit = 50) {
    const { agentEvaluations } = this.db.schema;

    const rows = await this.db.drizzle
      .select()
      .from(agentEvaluations)
      .where(eq(agentEvaluations.agentId, agentId))
      .orderBy(desc(agentEvaluations.createdAt))
      .limit(limit);

    return rows;
  }

  /**
   * Get all evaluations for a company.
   */
  async getCompanyEvaluations(companyId: string, limit = 100) {
    const { agentEvaluations, agents } = this.db.schema;

    const rows = await this.db.drizzle
      .select({
        evaluation: agentEvaluations,
        agentName: agents.name,
        agentRole: agents.role,
      })
      .from(agentEvaluations)
      .leftJoin(agents, eq(agentEvaluations.agentId, agents.id))
      .where(eq(agentEvaluations.companyId, companyId))
      .orderBy(desc(agentEvaluations.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      ...r.evaluation,
      agentName: r.agentName,
      agentRole: r.agentRole,
    }));
  }
}
