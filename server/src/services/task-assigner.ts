import { eq, and, sql, ne, isNull, inArray } from 'drizzle-orm';
import logger from '../utils/logger.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';

/**
 * Smart Task Assignment Service
 *
 * Provides intelligent task routing by evaluating:
 *   - Agent capabilities vs task type/tags
 *   - Current workload (fewer in-progress tasks preferred)
 *   - Remaining budget headroom
 *   - Role hierarchy (prefer lower-level agents for implementation work)
 */
export class TaskAssigner {
  constructor(private db: DbInstance) {}

  // ---------------------------------------------------------------------------
  // Find the best agent for a given task
  // ---------------------------------------------------------------------------

  /**
   * Score and rank all eligible agents in the company, then return the best
   * candidate.  Returns `null` when no suitable agent is available.
   */
  async findBestAgent(
    companyId: string,
    task: {
      id: string;
      type: string;
      tags: string[];
      priority: string;
    },
  ): Promise<Record<string, any> | null> {
    const { agents, tasks } = this.db.schema;

    // Fetch all non-offline agents in the company that still have budget
    const candidates = await this.db.drizzle
      .select()
      .from(agents)
      .where(
        and(
          eq(agents.companyId, companyId),
          ne(agents.status, 'offline'),
          ne(agents.status, 'error'),
          sql`(${agents.budgetMonthlyCents} = 0 OR ${agents.spentMonthlyCents} < ${agents.budgetMonthlyCents})`,
        ),
      );

    if (candidates.length === 0) return null;

    // Count in-progress tasks per agent in a single query
    const workloadRows = await this.db.drizzle
      .select({
        agentId: tasks.assigneeAgentId,
        activeCount: sql<number>`count(*)`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, companyId),
          eq(tasks.status, 'in_progress'),
        ),
      )
      .groupBy(tasks.assigneeAgentId);

    const workloadMap = new Map<string, number>();
    for (const row of workloadRows) {
      if (row.agentId) workloadMap.set(row.agentId, Number(row.activeCount));
    }

    // Role hierarchy weights -- lower = preferred for implementation tasks
    const roleWeight: Record<string, number> = {
      engineer: 1,
      designer: 1,
      marketer: 2,
      sales: 2,
      support: 2,
      hr: 3,
      custom: 3,
      cto: 4,
      cfo: 4,
      ceo: 5,
    };

    type ScoredCandidate = { agent: Record<string, any>; score: number };
    const scored: ScoredCandidate[] = [];

    for (const agent of candidates) {
      let score = 0;

      // --- Capability match (0-40 points) ---
      const capabilities = (agent.capabilities ?? []) as string[];
      const taskTags = task.tags ?? [];
      const taskType = task.type ?? '';

      // Each matching tag/type adds points
      for (const cap of capabilities) {
        const capLower = cap.toLowerCase();
        if (capLower === taskType.toLowerCase()) score += 20;
        for (const tag of taskTags) {
          if (capLower === tag.toLowerCase()) score += 10;
        }
      }

      // --- Workload preference (0-30 points) ---
      const activeCount = workloadMap.get(agent.id) ?? 0;
      const maxConcurrent = agent.maxConcurrentTasks ?? 1;

      // Skip agents already at capacity
      if (activeCount >= maxConcurrent) continue;

      // More headroom = higher score
      const headroom = maxConcurrent - activeCount;
      score += Math.min(headroom * 10, 30);

      // --- Budget headroom (0-10 points) ---
      if (agent.budgetMonthlyCents === 0) {
        // Unlimited budget
        score += 10;
      } else {
        const remaining = agent.budgetMonthlyCents - agent.spentMonthlyCents;
        const pct = remaining / agent.budgetMonthlyCents;
        score += Math.round(pct * 10);
      }

      // --- Role hierarchy preference (0-20 points) ---
      const rw = roleWeight[agent.role] ?? 3;
      // Implementation-type tasks prefer lower-level roles
      const isImplementation = ['feature', 'bug', 'chore'].includes(taskType);
      if (isImplementation) {
        score += Math.max(0, (6 - rw) * 4); // engineer=20, ceo=4
      } else {
        // Strategic tasks prefer higher-level roles
        score += rw * 4;
      }

      // --- Idle preference (0-10 points) ---
      if (agent.status === 'idle') score += 10;

      scored.push({ agent, score });
    }

    if (scored.length === 0) return null;

    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    logger.debug(
      {
        taskId: task.id,
        candidates: scored.slice(0, 5).map((s) => ({
          agentId: s.agent.id,
          name: s.agent.name,
          score: s.score,
        })),
      },
      'TaskAssigner: scored candidates',
    );

    return scored[0].agent;
  }

  // ---------------------------------------------------------------------------
  // Assign a task to a specific agent
  // ---------------------------------------------------------------------------

  async assignTask(taskId: string, agentId: string): Promise<void> {
    const { agents, tasks } = this.db.schema;
    const now = new Date();

    // Atomic assignment: only assign if the task is not already assigned.
    // This prevents two concurrent calls from double-assigning the same task.
    const result = await this.db.drizzle
      .update(tasks)
      .set({
        assigneeAgentId: agentId,
        status: 'in_progress',
        startedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, taskId),
          // Guard: only assign if currently unassigned or re-assigning to same agent
          sql`(${tasks.assigneeAgentId} IS NULL OR ${tasks.assigneeAgentId} = ${agentId})`,
        ),
      );

    // Fetch updated task for the event payload
    const [task] = await this.db.drizzle
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!task || task.assigneeAgentId !== agentId) return;

    // Update agent status to working
    await this.db.drizzle
      .update(agents)
      .set({
        status: 'working',
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(agents.id, agentId));

    // Emit events
    eventBus.emitEvent({
      type: 'task.assigned',
      companyId: task.companyId,
      payload: { taskId, assigneeAgentId: agentId },
      timestamp: now.toISOString(),
    });

    eventBus.emitEvent({
      type: 'agent.status_changed',
      companyId: task.companyId,
      payload: { agentId, status: 'working', taskId },
      timestamp: now.toISOString(),
    });

    logger.info({ taskId, agentId }, 'TaskAssigner: task assigned');
  }

  // ---------------------------------------------------------------------------
  // Escalate a task up the org chart
  // ---------------------------------------------------------------------------

  /**
   * Moves a task from its current assignee to the assignee's manager
   * (the agent referenced by `reportsTo`).  If no manager exists, the task
   * is unassigned so the scheduler can re-evaluate.
   */
  async escalateTask(taskId: string): Promise<{ escalatedTo: string | null }> {
    const { agents, tasks } = this.db.schema;

    const [task] = await this.db.drizzle
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!task) {
      logger.warn({ taskId }, 'TaskAssigner.escalateTask: task not found');
      return { escalatedTo: null };
    }

    const currentAssignee = task.assigneeAgentId;
    let managerId: string | null = null;

    if (currentAssignee) {
      const [assignee] = await this.db.drizzle
        .select()
        .from(agents)
        .where(eq(agents.id, currentAssignee))
        .limit(1);

      managerId = assignee?.reportsTo ?? null;
    }

    const now = new Date();

    if (managerId) {
      // Reassign to manager
      await this.db.drizzle
        .update(tasks)
        .set({
          assigneeAgentId: managerId,
          status: 'todo',
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId));

      // Set previous assignee back to idle if they were working
      if (currentAssignee) {
        await this.db.drizzle
          .update(agents)
          .set({ status: 'idle', updatedAt: now })
          .where(
            and(
              eq(agents.id, currentAssignee),
              eq(agents.status, 'working'),
            ),
          );
      }

      eventBus.emitEvent({
        type: 'task.updated',
        companyId: task.companyId,
        payload: {
          taskId,
          escalatedFrom: currentAssignee,
          escalatedTo: managerId,
          status: 'todo',
        },
        timestamp: now.toISOString(),
      });

      logger.info(
        { taskId, from: currentAssignee, to: managerId },
        'TaskAssigner: task escalated to manager',
      );
    } else {
      // No manager found -- unassign and return to backlog
      await this.db.drizzle
        .update(tasks)
        .set({
          assigneeAgentId: null,
          status: 'todo',
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId));

      if (currentAssignee) {
        await this.db.drizzle
          .update(agents)
          .set({ status: 'idle', updatedAt: now })
          .where(
            and(
              eq(agents.id, currentAssignee),
              eq(agents.status, 'working'),
            ),
          );
      }

      logger.warn(
        { taskId, currentAssignee },
        'TaskAssigner: no manager found for escalation, task unassigned',
      );
    }

    return { escalatedTo: managerId };
  }
}
