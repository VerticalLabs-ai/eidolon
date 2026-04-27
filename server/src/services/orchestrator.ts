import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import eventBus from "../realtime/events.js";
import type { WorkflowNode } from "../routes/workflows.js";
import type { DbInstance } from "../types.js";
import logger from "../utils/logger.js";

/**
 * Core orchestration engine for the Eidolon AI Company Runtime.
 *
 * Handles task assignment, escalation, and workflow advancement logic.
 */
export class Orchestrator {
  constructor(private db: DbInstance) {}

  /**
   * Find and assign the highest priority unassigned task that matches the
   * agent's capabilities, then return it.  Returns null if nothing matches.
   */
  async assignNextTask(
    agentId: string,
  ): Promise<Record<string, unknown> | null> {
    const { agents, tasks, taskHolds } = this.db.schema;

    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      logger.warn({ agentId }, "Orchestrator: agent not found");
      return null;
    }

    // Priority ordering: critical > high > medium > low
    const priorityOrder = sql`
      CASE ${tasks.priority}
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
      END
    `;

    // Find unassigned tasks in this company, ordered by priority
    const candidates = await this.db.drizzle
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, agent.companyId),
          isNull(tasks.assigneeAgentId),
          eq(tasks.status, "todo"),
        ),
      )
      .orderBy(asc(priorityOrder), asc(tasks.createdAt))
      .limit(10);

    if (candidates.length === 0) return null;

    const candidateIds = candidates.map((task) => task.id);
    const activeHolds = await this.db.drizzle
      .select({ taskId: taskHolds.taskId })
      .from(taskHolds)
      .where(
        and(
          eq(taskHolds.companyId, agent.companyId),
          eq(taskHolds.status, "active"),
          inArray(taskHolds.taskId, candidateIds),
        ),
      );
    const heldTaskIds = new Set(activeHolds.map((hold) => hold.taskId));
    const availableCandidates = candidates.filter((task) => !heldTaskIds.has(task.id));
    if (availableCandidates.length === 0) return null;

    // If the agent has capabilities, try to match tags. Otherwise take the first.
    const agentCaps = (agent.capabilities as string[]) ?? [];
    let bestTask = availableCandidates[0];

    if (agentCaps.length > 0) {
      const matched = availableCandidates.find((t) => {
        const tags = (t.tags as string[]) ?? [];
        return tags.some((tag) => agentCaps.includes(tag));
      });
      if (matched) bestTask = matched;
    }

    // Assign it
    const now = new Date();
    const [assigned] = await this.db.drizzle
      .update(tasks)
      .set({
        assigneeAgentId: agentId,
        status: "in_progress",
        startedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(tasks.id, bestTask.id),
          isNull(tasks.assigneeAgentId),
          sql`NOT EXISTS (
            SELECT 1
            FROM task_holds
            WHERE task_holds.task_id = ${bestTask.id}
              AND task_holds.status = 'active'
          )`,
        ),
      )
      .returning();

    if (!assigned) return null;

    eventBus.emitEvent({
      type: "task.assigned",
      companyId: agent.companyId,
      payload: {
        taskId: assigned.id,
        previousAssignee: null,
        newAssignee: agentId,
      },
      timestamp: now.toISOString(),
    });

    eventBus.emitEvent({
      type: "task.status_changed",
      companyId: agent.companyId,
      payload: {
        taskId: assigned.id,
        previousStatus: "todo",
        newStatus: "in_progress",
      },
      timestamp: now.toISOString(),
    });

    logger.info(
      { agentId, taskId: assigned.id },
      "Orchestrator: assigned task to agent",
    );
    return assigned as unknown as Record<string, unknown>;
  }

  /**
   * Check whether an agent is within its monthly budget.
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
   * Escalate a task to the assignee's supervisor in the org chart.
   * If the assignee has no supervisor, the task becomes unassigned.
   */
  async escalateTask(taskId: string): Promise<Record<string, unknown> | null> {
    const { agents, tasks } = this.db.schema;

    const [task] = await this.db.drizzle
      .select()
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    if (!task) {
      logger.warn({ taskId }, "Orchestrator: task not found for escalation");
      return null;
    }

    let newAssignee: string | null = null;

    if (task.assigneeAgentId) {
      const [currentAgent] = await this.db.drizzle
        .select()
        .from(agents)
        .where(eq(agents.id, task.assigneeAgentId))
        .limit(1);

      if (currentAgent?.reportsTo) {
        newAssignee = currentAgent.reportsTo;
      }
    }

    const now = new Date();
    const [escalated] = await this.db.drizzle
      .update(tasks)
      .set({
        assigneeAgentId: newAssignee,
        priority: "high",
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .returning();

    eventBus.emitEvent({
      type: "task.assigned",
      companyId: task.companyId,
      payload: {
        taskId,
        previousAssignee: task.assigneeAgentId,
        newAssignee,
        escalated: true,
      },
      timestamp: now.toISOString(),
    });

    logger.info(
      { taskId, from: task.assigneeAgentId, to: newAssignee },
      "Orchestrator: escalated task",
    );
    return escalated as unknown as Record<string, unknown>;
  }

  /**
   * Advance a DAG workflow by marking a node as completed and starting
   * any downstream nodes whose dependencies are now satisfied.
   */
  async advanceWorkflow(
    workflowId: string,
    nodeId: string,
  ): Promise<Record<string, unknown> | null> {
    const { workflows } = this.db.schema;

    const [wf] = await this.db.drizzle
      .select()
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .limit(1);

    if (!wf) return null;

    const nodes = wf.nodes as unknown as WorkflowNode[];
    const nodeIndex = nodes.findIndex((n) => n.id === nodeId);
    if (nodeIndex === -1) return null;

    nodes[nodeIndex].status = "completed";

    // Advance downstream nodes
    for (const node of nodes) {
      if (
        node.status === "pending" &&
        node.dependsOn.length > 0 &&
        node.dependsOn.every((depId) => {
          const dep = nodes.find((n) => n.id === depId);
          return dep?.status === "completed";
        })
      ) {
        node.status = "running";
      }
    }

    const allDone = nodes.every(
      (n) => n.status === "completed" || n.status === "skipped",
    );
    const now = new Date();

    const updates: Record<string, unknown> = {
      nodes: nodes as unknown as Record<string, unknown>[],
      updatedAt: now,
    };
    if (allDone) {
      updates.status = "archived";
    }

    const [updated] = await this.db.drizzle
      .update(workflows)
      .set(updates)
      .where(eq(workflows.id, workflowId))
      .returning();

    eventBus.emitEvent({
      type: "workflow.node_updated",
      companyId: wf.companyId,
      payload: { workflowId, nodeId, status: "completed" },
      timestamp: now.toISOString(),
    });

    return updated as unknown as Record<string, unknown>;
  }
}
