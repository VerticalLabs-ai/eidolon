import { eq, and, sql, inArray, isNull } from 'drizzle-orm';
import logger from '../utils/logger.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';

/**
 * Heartbeat Scheduler
 *
 * Runs as a background service inside the server process. On each tick it:
 *   1. Finds all idle agents that have autoAssignTasks enabled and remaining budget.
 *   2. Checks whether each agent's heartbeat interval has elapsed.
 *   3. Locates the highest-priority unassigned task in the agent's company.
 *   4. Assigns the task, transitions the agent to "working", and emits events.
 *
 * Overlapping ticks are prevented with a simple `running` guard.
 */
export class HeartbeatScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickIntervalMs = 30_000; // Check every 30 seconds

  constructor(private db: DbInstance) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    if (this.intervalId) return;
    logger.info('Heartbeat scheduler started');
    this.intervalId = setInterval(() => this.tick(), this.tickIntervalMs);
    // Run immediately on start
    this.tick();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Heartbeat scheduler stopped');
    }
  }

  /** Allow external callers (e.g. the /wake endpoint) to trigger a single tick for one agent. */
  async wakeAgent(agentId: string): Promise<{ assigned: boolean; taskId?: string }> {
    const { agents, tasks } = this.db.schema;

    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      return { assigned: false };
    }

    // Budget guard
    if (agent.budgetMonthlyCents > 0 && agent.spentMonthlyCents >= agent.budgetMonthlyCents) {
      return { assigned: false };
    }

    // Only wake idle agents
    if (agent.status !== 'idle') {
      return { assigned: false };
    }

    const result = await this.tryAssignTask(agent, agents, tasks);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Core tick logic
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (this.running) return; // Prevent overlapping ticks
    this.running = true;

    try {
      const { agents, tasks } = this.db.schema;

      // Find agents due for a heartbeat
      const now = Date.now();
      const idleAgents = await this.db.drizzle
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.status, 'idle'),
            eq(agents.autoAssignTasks, 1),
            // Budget check: spent < budget (or budget is 0 = unlimited)
            sql`(${agents.budgetMonthlyCents} = 0 OR ${agents.spentMonthlyCents} < ${agents.budgetMonthlyCents})`,
          ),
        );

      for (const agent of idleAgents) {
        // Check heartbeat interval
        const intervalMs = (agent.heartbeatIntervalSeconds ?? 300) * 1000;
        const lastBeat = agent.lastHeartbeatAt
          ? new Date(agent.lastHeartbeatAt).getTime()
          : 0;

        if (now - lastBeat < intervalMs) continue;

        await this.tryAssignTask(agent, agents, tasks);
      }
    } catch (err) {
      logger.error({ err }, 'Heartbeat tick error');
    } finally {
      this.running = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Task assignment helper
  // ---------------------------------------------------------------------------

  private async tryAssignTask(
    agent: Record<string, any>,
    agents: typeof this.db.schema.agents,
    tasks: typeof this.db.schema.tasks,
  ): Promise<{ assigned: boolean; taskId?: string }> {
    // Find unassigned task for this company, ordered by priority
    const [nextTask] = await this.db.drizzle
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, agent.companyId),
          inArray(tasks.status, ['todo', 'backlog']),
          isNull(tasks.assigneeAgentId),
        ),
      )
      .orderBy(
        sql`CASE ${tasks.priority}
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END`,
      )
      .limit(1);

    if (!nextTask) {
      // No tasks available -- just update heartbeat timestamp
      await this.db.drizzle
        .update(agents)
        .set({ lastHeartbeatAt: new Date() })
        .where(eq(agents.id, agent.id));
      return { assigned: false };
    }

    // Assign task to agent
    const now = new Date();

    await this.db.drizzle
      .update(tasks)
      .set({
        assigneeAgentId: agent.id,
        status: 'in_progress',
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(tasks.id, nextTask.id));

    // Update agent status
    await this.db.drizzle
      .update(agents)
      .set({
        status: 'working',
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(agents.id, agent.id));

    // Emit events
    eventBus.emitEvent({
      type: 'agent.status_changed',
      companyId: agent.companyId,
      payload: { agentId: agent.id, status: 'working', taskId: nextTask.id },
      timestamp: now.toISOString(),
    });

    eventBus.emitEvent({
      type: 'task.updated',
      companyId: agent.companyId,
      payload: {
        taskId: nextTask.id,
        status: 'in_progress',
        assigneeAgentId: agent.id,
      },
      timestamp: now.toISOString(),
    });

    logger.info(
      {
        agentId: agent.id,
        agentName: agent.name,
        taskId: nextTask.id,
        taskTitle: nextTask.title,
      },
      'Heartbeat: assigned task to agent',
    );

    // NOTE: Actual AI execution would be triggered here via AgentExecutor.
    // For now we just assign the task. The execution runtime (built separately)
    // will handle calling the AI API.

    return { assigned: true, taskId: nextTask.id };
  }
}
