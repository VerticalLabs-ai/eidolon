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

import { eq, and, ilike, or, desc, sql } from 'drizzle-orm';
import type { Mention, MentionableEntity } from '@eidolon/shared';
import type { DbInstance } from '../types.js';
import { ArtifactToolService } from './artifact-tools.js';
import { AgenticLoop } from './agentic-loop.js';
import { getCompanyMembers, isCompanyMember, type CompanyMember } from '../auth.js';
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

    // Search agents by name within the company.
    // VAL-ART-084: filter out paused/offline agents so they are not
    // selectable in the mention picker. Only active, idle, working, or
    // error-status agents are available for mention dispatch.
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
      // Skip paused/offline agents — they cannot be dispatched
      if (a.status === 'paused' || a.status === 'offline') continue;
      results.push({
        entityType: 'agent',
        entityId: a.id,
        label: a.name,
        subtitle: a.title ?? a.role,
      });
    }

    // Search teammates (users) via real company membership lookup.
    const users = await this.searchTeammates(companyId, q, limit - results.length);
    results.push(...users);

    return results.slice(0, limit);
  }

  private async searchTeammates(
    companyId: string,
    q: string,
    remaining: number,
  ): Promise<MentionableEntity[]> {
    if (remaining <= 0) return [];

    // Query real company members via Clerk org membership (or the dev user
    // in local_trusted mode). Never hard-coded — always reflects actual
    // company membership.
    let members: CompanyMember[];
    try {
      members = await getCompanyMembers(companyId);
    } catch (err) {
      logger.debug({ err, companyId }, 'searchTeammates: membership lookup failed');
      members = [];
    }

    const ql = q.trim().toLowerCase();
    const entities: MentionableEntity[] = [];
    for (const m of members) {
      if (ql && !m.name.toLowerCase().includes(ql) && !(m.email ?? '').toLowerCase().includes(ql)) {
        continue;
      }
      entities.push({
        entityType: 'user',
        entityId: m.id,
        label: m.name,
        subtitle: m.email ?? 'Teammate',
      });
      if (entities.length >= remaining) break;
    }

    // Also include test users created via the
    // /api/auth/local-trusted/create-test-user endpoint. This enables
    // validators to create a second user, mention them, and verify inbox
    // notifications + thread.mention WS events. The test_users table is
    // empty in production (the endpoint is guarded to local_trusted mode),
    // so this query is harmless in Clerk mode.
    if (entities.length < remaining) {
      const { testUsers } = this.db.schema;
      const testUserRows = await this.db.drizzle
        .select({
          id: testUsers.id,
          name: testUsers.name,
          email: testUsers.email,
        })
        .from(testUsers)
        .where(eq(testUsers.companyId, companyId))
        .orderBy(testUsers.name)
        .limit(remaining - entities.length);

      for (const tu of testUserRows) {
        if (ql && !tu.name.toLowerCase().includes(ql) && !tu.email.toLowerCase().includes(ql)) {
          continue;
        }
        entities.push({
          entityType: 'user',
          entityId: tu.id,
          label: tu.name,
          subtitle: tu.email,
        });
        if (entities.length >= remaining) break;
      }
    }

    return entities;
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

    // User mention — verify via real company membership lookup.
    // In local_trusted, the dev user is a member of every company.
    // In Clerk mode, queries org memberships to verify the user belongs
    // to this company. In local_trusted mode, also check test users
    // created via the create-test-user endpoint.
    if (entityType === 'user') {
      // First check real company membership (dev user in local_trusted,
      // Clerk org members in production).
      try {
        if (await isCompanyMember(companyId, entityId)) {
          return true;
        }
      } catch (err) {
        logger.debug({ err, companyId, entityId }, 'resolveMention: membership lookup failed');
      }

      // Also check the test_users table for additional test users
      // created via the create-test-user endpoint. The table is empty
      // in production (endpoint guarded to local_trusted mode), so this
      // is harmless in Clerk mode.
      const { testUsers } = this.db.schema;
      const [testUser] = await this.db.drizzle
        .select({ id: testUsers.id })
        .from(testUsers)
        .where(and(eq(testUsers.id, entityId), eq(testUsers.companyId, companyId)))
        .limit(1);
      return !!testUser;
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
    const producedMeetings = loop.getProducedMeetings();

    const payload: Record<string, unknown> = {};
    if (producedArtifacts.length > 0) {
      payload.artifactId = producedArtifacts[0].artifactId;
      payload.artifactType = producedArtifacts[0].artifactType;
      payload.artifacts = producedArtifacts;
    }
    if (producedMeetings.length > 0) {
      // Link the first meeting outcome so the thread can render a meeting card
      // (VAL-MEETING-015). The full list is carried for multi-meeting runs.
      payload.meetingId = producedMeetings[0].meetingId;
      payload.meetings = producedMeetings;
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
  // Process queued mentions for an agent that has resumed / changed status.
  //
  // Finds thread items with payload.queuedMention.agentId == agentId that
  // have not yet been processed, marks them as processed (to prevent
  // double-dispatch), and dispatches the original mention to the now-active
  // agent. Called when an agent transitions from paused/offline to an active
  // status (idle/working/error).
  // -------------------------------------------------------------------------

  async processQueuedMentions(
    agentId: string,
  ): Promise<{ processed: number; dispatched: number; errors: number }> {
    const { taskThreadItems, agents } = this.db.schema;

    // Look up the agent to get its company + name
    const [agent] = await this.db.drizzle
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);

    if (!agent) {
      return { processed: 0, dispatched: 0, errors: 0 };
    }

    // Safety guard: don't process queued mentions if the agent is still
    // paused or offline — dispatching would just re-queue them. This method
    // is intended to be called after the agent has resumed to an active
    // status (idle/working/error).
    if (agent.status === 'paused' || agent.status === 'offline') {
      return { processed: 0, dispatched: 0, errors: 0 };
    }

    // Find unprocessed queued mention items for this agent.
    // Queued mentions are stored as execution_event thread items with
    // payload.queuedMention.agentId == agentId and processed != true.
    const queuedItems = await this.db.drizzle
      .select()
      .from(taskThreadItems)
      .where(
        and(
          eq(taskThreadItems.companyId, agent.companyId),
          eq(taskThreadItems.kind, 'execution_event'),
          sql`${taskThreadItems.payload}->'queuedMention'->>'agentId' = ${agentId}`,
          sql`COALESCE((${taskThreadItems.payload}->'queuedMention'->>'processed')::bool, false) = false`,
          sql`COALESCE((${taskThreadItems.payload}->'queuedMention'->>'cancelled')::bool, false) = false`,
        ),
      )
      .orderBy(desc(taskThreadItems.createdAt));

    let processed = 0;
    let dispatched = 0;
    let errors = 0;

    for (const queuedItem of queuedItems) {
      const payload = queuedItem.payload as Record<string, unknown> | null;
      const queuedMention = payload?.queuedMention as
        | { agentId?: string; itemId?: string; content?: string }
        | undefined;
      if (!queuedMention?.itemId) continue;

      // Mark the queued item as processed FIRST to prevent double-dispatch
      // if processQueuedMentions is called again concurrently.
      const now = new Date();
      await this.db.drizzle
        .update(taskThreadItems)
        .set({
          payload: {
            ...payload,
            queuedMention: { ...queuedMention, processed: true, processedAt: now.toISOString() },
          },
          content: `@${agent.name} resumed. Processing queued mention…`,
          updatedAt: now,
        } as any)
        .where(eq(taskThreadItems.id, queuedItem.id));

      processed++;

      // Fetch the original mention item to get the full context
      const [originalItem] = await this.db.drizzle
        .select()
        .from(taskThreadItems)
        .where(eq(taskThreadItems.id, queuedMention.itemId))
        .limit(1);

      if (!originalItem) {
        logger.warn(
          { queuedItemId: queuedItem.id, originalItemId: queuedMention.itemId },
          'processQueuedMentions: original mention item not found',
        );
        errors++;
        continue;
      }

      // Build the dispatch context from the original mention item
      const threadId = queuedItem.projectThreadId ?? originalItem.projectThreadId;
      if (!threadId) {
        logger.warn(
          { queuedItemId: queuedItem.id },
          'processQueuedMentions: queued item has no threadId',
        );
        errors++;
        continue;
      }

      const ctx: MentionDispatchContext = {
        companyId: agent.companyId,
        projectId: originalItem.projectId ?? queuedItem.projectId ?? null,
        threadId,
        itemId: originalItem.id,
        content: queuedMention.content ?? originalItem.content ?? '',
        mentions: [
          {
            entityType: 'agent',
            entityId: agentId,
            label: agent.name,
          },
        ],
        authorUserId: originalItem.authorUserId ?? null,
      };

      try {
        const result = await this.dispatchAgentMention(ctx, {
          entityType: 'agent',
          entityId: agentId,
          label: agent.name,
        });
        if (result.status === 'dispatched') {
          dispatched++;
        } else if (result.status === 'skipped') {
          errors++;
        }
        // 'queued' would mean the agent is paused again — leave it for the
        // next resume cycle.
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error(
          { err, agentId, queuedItemId: queuedItem.id },
          'processQueuedMentions: dispatch failed for queued mention',
        );
        errors++;
        // Post a failure item so the thread reflects the error
        await this.postAgentFailureItem(ctx, {
          entityType: 'agent',
          entityId: agentId,
          label: agent.name,
        }, errorMsg);
      }
    }

    if (processed > 0) {
      logger.info(
        { agentId, processed, dispatched, errors },
        'processQueuedMentions: processed queued mentions on agent resume',
      );
    }

    return { processed, dispatched, errors };
  }

  // -------------------------------------------------------------------------
  // Cancel queued dispatch for removed agent mentions.
  //
  // When a thread item is edited to remove an agent mention, any pending
  // queued dispatch for that agent (stored as execution_event items with
  // payload.queuedMention) must be cancelled so the agent does not process
  // a mention the user no longer intends. Marks the queued item as
  // cancelled and updates its content to reflect the cancellation.
  // -------------------------------------------------------------------------

  async cancelQueuedMentions(
    companyId: string,
    threadId: string,
    removedAgentIds: string[],
  ): Promise<{ cancelled: number }> {
    if (removedAgentIds.length === 0) return { cancelled: 0 };

    const { taskThreadItems } = this.db.schema;
    let cancelled = 0;

    for (const agentId of removedAgentIds) {
      // Find unprocessed, non-cancelled queued mention items for this agent
      // within this thread.
      const queuedItems = await this.db.drizzle
        .select()
        .from(taskThreadItems)
        .where(
          and(
            eq(taskThreadItems.companyId, companyId),
            eq(taskThreadItems.projectThreadId, threadId),
            eq(taskThreadItems.kind, 'execution_event'),
            sql`${taskThreadItems.payload}->'queuedMention'->>'agentId' = ${agentId}`,
            sql`COALESCE((${taskThreadItems.payload}->'queuedMention'->>'processed')::bool, false) = false`,
            sql`COALESCE((${taskThreadItems.payload}->'queuedMention'->>'cancelled')::bool, false) = false`,
          ),
        );

      for (const queuedItem of queuedItems) {
        const payload = queuedItem.payload as Record<string, unknown> | null;
        const queuedMention = payload?.queuedMention as Record<string, unknown> | undefined;
        if (!queuedMention) continue;

        const now = new Date();
        await this.db.drizzle
          .update(taskThreadItems)
          .set({
            payload: {
              ...payload,
              queuedMention: {
                ...queuedMention,
                cancelled: true,
                cancelledAt: now.toISOString(),
              },
            },
            content: 'Mention removed by editor — queued dispatch cancelled.',
            updatedAt: now,
          } as any)
          .where(eq(taskThreadItems.id, queuedItem.id));

        cancelled++;
      }
    }

    if (cancelled > 0) {
      logger.info(
        { companyId, threadId, removedAgentIds, cancelled },
        'cancelQueuedMentions: cancelled queued dispatch for removed agent mentions',
      );
    }

    return { cancelled };
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
