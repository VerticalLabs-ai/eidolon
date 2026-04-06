import type { DbInstance } from '../types.js';
import { eq, and, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import eventBus from '../realtime/events.js';
import logger from '../utils/logger.js';

type CollaborationType = 'delegation' | 'request_help' | 'review' | 'consensus' | 'escalation';

export class CollaborationService {
  constructor(private db: DbInstance) {}

  /**
   * An agent delegates a subtask to another agent (Orchestrator-Workers pattern).
   */
  async delegate(
    fromAgentId: string,
    toAgentId: string,
    companyId: string,
    data: {
      taskId?: string;
      requestContent: string;
      priority?: string;
      parentCollaborationId?: string;
    },
  ) {
    const { agentCollaborations } = this.db.schema;
    const id = randomUUID();
    const now = new Date();

    const [collab] = await this.db.drizzle
      .insert(agentCollaborations)
      .values({
        id,
        companyId,
        type: 'delegation',
        fromAgentId,
        toAgentId,
        taskId: data.taskId ?? null,
        parentCollaborationId: data.parentCollaborationId ?? null,
        status: 'pending',
        requestContent: data.requestContent,
        priority: (data.priority as any) ?? 'medium',
        createdAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'agent.collaboration' as any,
      companyId,
      payload: { collaborationId: id, type: 'delegation', from: fromAgentId, to: toAgentId },
      timestamp: now.toISOString(),
    });

    logger.info({ collaborationId: id, from: fromAgentId, to: toAgentId }, 'Delegation created');
    return collab;
  }

  /**
   * An agent requests help from another agent.
   */
  async requestHelp(
    fromAgentId: string,
    toAgentId: string,
    companyId: string,
    content: string,
    taskId?: string,
  ) {
    const { agentCollaborations } = this.db.schema;
    const id = randomUUID();
    const now = new Date();

    const [collab] = await this.db.drizzle
      .insert(agentCollaborations)
      .values({
        id,
        companyId,
        type: 'request_help',
        fromAgentId,
        toAgentId,
        taskId: taskId ?? null,
        status: 'pending',
        requestContent: content,
        priority: 'medium',
        createdAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'agent.collaboration' as any,
      companyId,
      payload: { collaborationId: id, type: 'request_help', from: fromAgentId, to: toAgentId },
      timestamp: now.toISOString(),
    });

    return collab;
  }

  /**
   * An agent requests review from its manager (found via reportsTo).
   */
  async requestReview(agentId: string, taskId: string, companyId: string) {
    const { agents, agentCollaborations } = this.db.schema;

    // Find the agent and their manager
    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (!agent.reportsTo) throw new Error(`Agent ${agentId} has no manager to request review from`);

    const id = randomUUID();
    const now = new Date();

    const [collab] = await this.db.drizzle
      .insert(agentCollaborations)
      .values({
        id,
        companyId,
        type: 'review',
        fromAgentId: agentId,
        toAgentId: agent.reportsTo,
        taskId,
        status: 'pending',
        requestContent: `Review requested for task ${taskId} by ${agent.name}`,
        priority: 'medium',
        createdAt: now,
      })
      .returning();

    eventBus.emitEvent({
      type: 'agent.collaboration' as any,
      companyId,
      payload: { collaborationId: id, type: 'review', from: agentId, to: agent.reportsTo, taskId },
      timestamp: now.toISOString(),
    });

    return collab;
  }

  /**
   * Escalate a task up the org chart when an agent is blocked.
   */
  async escalate(agentId: string, taskId: string, companyId: string, reason: string) {
    const { agents, agentCollaborations, tasks } = this.db.schema;

    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) throw new Error(`Agent ${agentId} not found`);
    if (!agent.reportsTo) throw new Error(`Agent ${agentId} has no manager to escalate to`);

    const id = randomUUID();
    const now = new Date();

    // Create the escalation collaboration
    const [collab] = await this.db.drizzle
      .insert(agentCollaborations)
      .values({
        id,
        companyId,
        type: 'escalation',
        fromAgentId: agentId,
        toAgentId: agent.reportsTo,
        taskId,
        status: 'pending',
        requestContent: reason,
        priority: 'high',
        createdAt: now,
      })
      .returning();

    // Update the task status to blocked
    await this.db.drizzle
      .update(tasks)
      .set({ status: 'blocked' as any, updatedAt: now })
      .where(eq(tasks.id, taskId));

    eventBus.emitEvent({
      type: 'agent.collaboration' as any,
      companyId,
      payload: { collaborationId: id, type: 'escalation', from: agentId, to: agent.reportsTo, taskId, reason },
      timestamp: now.toISOString(),
    });

    logger.warn({ collaborationId: id, agentId, taskId, reason }, 'Task escalated');
    return collab;
  }

  /**
   * Respond to a collaboration request.
   */
  async respond(collaborationId: string, responseContent: string) {
    const { agentCollaborations } = this.db.schema;
    const now = new Date();

    const [collab] = await this.db.drizzle
      .update(agentCollaborations)
      .set({
        responseContent,
        status: 'completed',
        completedAt: now,
      })
      .where(eq(agentCollaborations.id, collaborationId))
      .returning();

    if (collab) {
      eventBus.emitEvent({
        type: 'agent.collaboration' as any,
        companyId: collab.companyId,
        payload: { collaborationId, status: 'completed', respondedBy: collab.toAgentId },
        timestamp: now.toISOString(),
      });
    }

    return collab;
  }

  /**
   * Get pending collaborations for an agent (incoming requests).
   */
  async getPendingForAgent(agentId: string) {
    const { agentCollaborations } = this.db.schema;

    return this.db.drizzle
      .select()
      .from(agentCollaborations)
      .where(
        and(
          eq(agentCollaborations.toAgentId, agentId),
          eq(agentCollaborations.status, 'pending'),
        ),
      )
      .orderBy(desc(agentCollaborations.createdAt))
      .all();
  }

  /**
   * Get collaboration history for a company.
   */
  async getHistory(companyId: string, limit = 50) {
    const { agentCollaborations } = this.db.schema;

    return this.db.drizzle
      .select()
      .from(agentCollaborations)
      .where(eq(agentCollaborations.companyId, companyId))
      .orderBy(desc(agentCollaborations.createdAt))
      .limit(limit)
      .all();
  }

  /**
   * Get a single collaboration by ID.
   */
  async getById(collaborationId: string) {
    const { agentCollaborations } = this.db.schema;

    const [collab] = await this.db.drizzle
      .select()
      .from(agentCollaborations)
      .where(eq(agentCollaborations.id, collaborationId))
      .limit(1);

    return collab ?? null;
  }

  /**
   * Get all collaborations for a specific agent (both sent and received).
   */
  async getForAgent(agentId: string, companyId: string) {
    const { agentCollaborations } = this.db.schema;
    const { or } = await import('drizzle-orm');

    return this.db.drizzle
      .select()
      .from(agentCollaborations)
      .where(
        and(
          eq(agentCollaborations.companyId, companyId),
          or(
            eq(agentCollaborations.fromAgentId, agentId),
            eq(agentCollaborations.toAgentId, agentId),
          ),
        ),
      )
      .orderBy(desc(agentCollaborations.createdAt))
      .all();
  }
}
