// ---------------------------------------------------------------------------
// Mention Service -- @-mention resolution, search, and dispatch
// ---------------------------------------------------------------------------
//
// Handles:
//   1. Searching for mentionable entities (agents + teammates) within a company
//   2. Dispatching mentions after a thread item is posted:
//      - Agent mention → wake agent with thread context (may produce artifacts)
//      - User mention → inbox notification + thread.mention realtime event
// ---------------------------------------------------------------------------

import { eq, and, ilike, or, desc } from 'drizzle-orm';
import type { Mention, MentionableEntity } from '@eidolon/shared';
import type { DbInstance } from '../types.js';
import { ArtifactToolService } from './artifact-tools.js';
import { AgenticLoop } from './agentic-loop.js';
import eventBus from '../realtime/events.js';
import logger from '../utils/logger.js';

export interface MentionDispatchContext {
  companyId: string;
  projectId: string | null;
  threadId: string;
  itemId: string;
  content: string;
  mentions: Mention[];
  authorUserId: string | null;
}

export interface MentionDispatchResult {
  agentDispatches: Array<{
    agentId: string;
    status: 'dispatched' | 'queued' | 'skipped';
    responseItemId?: string;
    error?: string;
  }>;
  userNotifications: Array<{
    userId: string;
    notified: boolean;
  }>;
}

export class MentionService {
  private artifactTools: ArtifactToolService;

  constructor(private db: DbInstance) {
    this.artifactTools = new ArtifactToolService(db);
  }

  // -------------------------------------------------------------------------
  // Search for mentionable entities within a company
  // -------------------------------------------------------------------------

  async searchMentionable(
    companyId: string,
    query: string,
    limit = 20,
  ): Promise<MentionableEntity[]> {
    const { agents } = this.db.schema;
    const results: MentionableEntity[] = [];
    const q = query.trim();

    // Search agents by name within the company
    const conditions = [eq(agents.companyId, companyId)];
    if (q) {
      conditions.push(or(ilike(agents.name, `%${q}%`), ilike(agents.title, `%${q}%`))!);
    }

    const agentRows = await this.db.drizzle
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
      })
      .from(agents)
      .where(and(...conditions))
      .orderBy(agents.name)
      .limit(limit);

    for (const a of agentRows) {
      results.push({
        entityType: 'agent',
        entityId: a.id,
        label: a.name,
        subtitle: a.title ?? a.role,
      });
    }

    // Search teammates (users).
    // In local_trusted mode, the only user is the dev user.
    const users = this.searchTeammates(companyId, q, limit - results.length);
    results.push(...users);

    return results.slice(0, limit);
  }

  private searchTeammates(
    _companyId: string,
    q: string,
    remaining: number,
  ): MentionableEntity[] {
    if (remaining <= 0) return [];

    // In local_trusted mode, the only user is the dev user (dev-user-000).
    // The dev user ID is a well-known pattern that never conflicts with Clerk
    // user IDs (which use the user_xxx format), so it's safe to always include.
    // In Clerk mode, org membership queries would replace this.
    const devUser: MentionableEntity = {
      entityType: 'user',
      entityId: 'dev-user-000',
      label: 'Dev User',
      subtitle: 'You',
    };
    if (!q || 'dev user'.includes(q.toLowerCase())) {
      return [devUser];
    }

    return [];
  }

  // -------------------------------------------------------------------------
  // Resolve a mention entity (verify it belongs to the company)
  // -------------------------------------------------------------------------

  async resolveMention(
    companyId: string,
    entityType: 'agent' | 'user',
    entityId: string,
  ): Promise<boolean> {
    if (entityType === 'agent') {
      const { agents } = this.db.schema;
      const [agent] = await this.db.drizzle
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, entityId), eq(agents.companyId, companyId)))
        .limit(1);
      return !!agent;
    }

    // User mention — in local_trusted, dev-user-000 always resolves.
    // Clerk user IDs use a different format (user_xxx), so this is safe.
    if (entityType === 'user') {
      if (entityId === 'dev-user-000') {
        return true;
      }
      // In Clerk mode, would verify org membership
      return false;
    }

    return false;
  }

  // -------------------------------------------------------------------------
  // Dispatch mentions after a thread item is posted
  // -------------------------------------------------------------------------

  async dispatchMentions(
    ctx: MentionDispatchContext,
  ): Promise<MentionDispatchResult> {
    const agentDispatches: MentionDispatchResult['agentDispatches'] = [];
    const userNotifications: MentionDispatchResult['userNotifications'] = [];

    for (const mention of ctx.mentions) {
      if (mention.entityType === 'agent') {
        const result = await this.dispatchAgentMention(ctx, mention);
        agentDispatches.push(result);
      } else if (mention.entityType === 'user') {
        // Self-mention: no self-notification
        if (mention.entityId === ctx.authorUserId) {
          userNotifications.push({ userId: mention.entityId, notified: false });
          continue;
        }
        const notified = await this.dispatchUserMention(ctx, mention);
        userNotifications.push({ userId: mention.entityId, notified });
      }
    }

    return { agentDispatches, userNotifications };
  }

  // -------------------------------------------------------------------------
  // Agent mention dispatch: wake agent with thread context
  // -------------------------------------------------------------------------

  private async dispatchAgentMention(
    ctx: MentionDispatchContext,
    mention: Mention,
  ): Promise<{ agentId: string; status: 'dispatched' | 'queued' | 'skipped'; responseItemId?: string; error?: string }> {
    const { agents } = this.db.schema;

    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(and(eq(agents.id, mention.entityId), eq(agents.companyId, ctx.companyId)))
      .limit(1);

    if (!agent) {
      return { agentId: mention.entityId, status: 'skipped', error: 'Agent not found' };
    }

    // Paused or offline agents: queue the work (don't dispatch)
    if (agent.status === 'paused' || agent.status === 'offline') {
      await this.queueAgentMention(ctx, mention, agent.status);
      return { agentId: mention.entityId, status: 'queued' };
    }

    // Active/idle/error agents: dispatch immediately
    try {
      const responseItemId = await this.runAgentMention(ctx, mention, agent.id);
      return { agentId: mention.entityId, status: 'dispatched', responseItemId };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, agentId: agent.id, itemId: ctx.itemId }, 'Agent mention dispatch failed');
      await this.postAgentFailureItem(ctx, mention, errorMsg);
      return { agentId: mention.entityId, status: 'skipped', error: errorMsg };
    }
  }

  // -------------------------------------------------------------------------
  // Run agent in response to a mention — creates a task, runs the loop,
  // posts the response as a thread item
  // -------------------------------------------------------------------------

  private async runAgentMention(
    ctx: MentionDispatchContext,
    mention: Mention,
    agentId: string,
  ): Promise<string | undefined> {
    const { tasks, taskThreadItems, agents } = this.db.schema;
    const now = new Date();

    // Build thread context for the agent
    const threadContext = await this.buildThreadContext(ctx);

    // 1. Create a task for the agent from the mention content
    // Task must start in 'todo' status for the checkout service to accept it.
    const [task] = await this.db.drizzle
      .insert(tasks)
      .values({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        title: `@${mention.label}: ${ctx.content.slice(0, 100)}`,
        description: `${ctx.content}\n\n--- Thread Context ---\n${threadContext}`,
        type: 'feature',
        priority: 'medium',
        status: 'todo',
        assigneeAgentId: agentId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // 2. Set agent to working
    await this.db.drizzle
      .update(agents)
      .set({ status: 'working', updatedAt: now })
      .where(eq(agents.id, agentId));

    // 3. Run the agentic loop with built-in artifact tools
    const loop = new AgenticLoop(this.db, { maxIterations: 8 });
    const result = await loop.run(agentId, task.id, ctx.companyId);

    // 4. Post the agent's response as a thread item
    const responseContent = result.finalOutput || '(Agent completed with no output)';
    const producedArtifacts = loop.getProducedArtifacts();

    const payload: Record<string, unknown> = {};
    if (producedArtifacts.length > 0) {
      payload.artifactId = producedArtifacts[0].artifactId;
      payload.artifactType = producedArtifacts[0].artifactType;
      payload.artifacts = producedArtifacts;
    }
    payload.mentionDispatch = {
      agentId,
      taskId: task.id,
      executionId: result.executionId,
    };

    const [responseItem] = await this.db.drizzle
      .insert(taskThreadItems)
      .values({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        projectThreadId: ctx.threadId,
        taskId: null,
        kind: 'comment',
        authorAgentId: agentId,
        content: responseContent.slice(0, 20_000),
        payload,
        status: 'pending',
        mentions: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)
      .returning();

    eventBus.emitEvent({
      type: 'project.thread.item.created',
      companyId: ctx.companyId,
      payload: { threadId: ctx.threadId, item: responseItem },
      timestamp: new Date().toISOString(),
    });

    return responseItem.id;
  }

  // -------------------------------------------------------------------------
  // Build thread context string from recent thread items
  // -------------------------------------------------------------------------

  private async buildThreadContext(ctx: MentionDispatchContext): Promise<string> {
    const { taskThreadItems } = this.db.schema;

    const recentItems = await this.db.drizzle
      .select()
      .from(taskThreadItems)
      .where(
        and(
          eq(taskThreadItems.companyId, ctx.companyId),
          eq(taskThreadItems.projectThreadId, ctx.threadId),
        ),
      )
      .orderBy(desc(taskThreadItems.createdAt))
      .limit(10);

    recentItems.reverse();

    const lines: string[] = [];
    for (const item of recentItems) {
      const author = item.authorAgentId
        ? `Agent ${item.authorAgentId.slice(0, 8)}`
        : item.authorUserId
          ? `User ${item.authorUserId.slice(0, 8)}`
          : 'Unknown';
      const content = item.content ?? '(no content)';
      lines.push(`[${author}]: ${content}`);
    }

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Queue a mention for a paused/offline agent
  // -------------------------------------------------------------------------

  private async queueAgentMention(
    ctx: MentionDispatchContext,
    mention: Mention,
    agentStatus: string,
  ): Promise<void> {
    const { taskThreadItems } = this.db.schema;

    const [queueItem] = await this.db.drizzle
      .insert(taskThreadItems)
      .values({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        projectThreadId: ctx.threadId,
        taskId: null,
        kind: 'execution_event',
        authorAgentId: null,
        content: `@${mention.label} is ${agentStatus}. Mention queued — the agent will process this when resumed.`,
        payload: {
          queuedMention: {
            agentId: mention.entityId,
            itemId: ctx.itemId,
            content: ctx.content,
          },
        },
        status: 'pending',
        mentions: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)
      .returning();

    eventBus.emitEvent({
      type: 'project.thread.item.created',
      companyId: ctx.companyId,
      payload: { threadId: ctx.threadId, item: queueItem },
      timestamp: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Post a failure item to the thread
  // -------------------------------------------------------------------------

  private async postAgentFailureItem(
    ctx: MentionDispatchContext,
    mention: Mention,
    error: string,
  ): Promise<void> {
    const { taskThreadItems, agents } = this.db.schema;

    // Reset agent status on failure
    await this.db.drizzle
      .update(agents)
      .set({ status: 'error', updatedAt: new Date() })
      .where(eq(agents.id, mention.entityId));

    const [failItem] = await this.db.drizzle
      .insert(taskThreadItems)
      .values({
        companyId: ctx.companyId,
        projectId: ctx.projectId,
        projectThreadId: ctx.threadId,
        taskId: null,
        kind: 'execution_event',
        authorAgentId: null,
        content: `@${mention.label} failed to respond: ${error.slice(0, 500)}`,
        payload: {
          agentError: {
            agentId: mention.entityId,
            error,
            itemId: ctx.itemId,
          },
        },
        status: 'pending',
        mentions: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any)
      .returning();

    eventBus.emitEvent({
      type: 'project.thread.item.created',
      companyId: ctx.companyId,
      payload: { threadId: ctx.threadId, item: failItem },
      timestamp: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // User mention dispatch: notification + realtime event
  // -------------------------------------------------------------------------

  private async dispatchUserMention(
    ctx: MentionDispatchContext,
    mention: Mention,
  ): Promise<boolean> {
    const { activityLog } = this.db.schema;
    const now = new Date();

    // 1. Create an activity log entry (serves as the notification)
    await this.db.drizzle.insert(activityLog).values({
      companyId: ctx.companyId,
      actorType: 'user',
      actorId: ctx.authorUserId,
      action: 'thread.mention',
      entityType: 'task_thread_item',
      entityId: ctx.itemId,
      description: `Mentioned you in a thread: "${ctx.content.slice(0, 120)}"`,
      metadata: {
        mentionedUserId: mention.entityId,
        threadId: ctx.threadId,
        itemId: ctx.itemId,
        projectId: ctx.projectId,
        mentionLabel: mention.label,
      },
      projectId: ctx.projectId,
      createdAt: now,
    });

    // 2. Emit thread.mention realtime event
    eventBus.emitEvent({
      type: 'thread.mention',
      companyId: ctx.companyId,
      payload: {
        mentionedUserId: mention.entityId,
        threadId: ctx.threadId,
        itemId: ctx.itemId,
        mention,
        content: ctx.content.slice(0, 500),
        projectId: ctx.projectId,
      },
      timestamp: now.toISOString(),
    });

    return true;
  }
}
