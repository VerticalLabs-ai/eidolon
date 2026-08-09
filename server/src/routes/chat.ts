import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { MentionSchema } from '@eidolon/shared';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import { MentionService } from '../services/mention-service.js';
import { AgenticLoop } from '../services/agentic-loop.js';
import { backgroundWork } from '../services/background-work.js';
import logger from '../utils/logger.js';

/**
 * Board Director Chat routes.
 *
 * Board messages use the special sentinel `__board__` for fromAgentId / toAgentId
 * instead of a real agent UUID.  Because the messages table has a FK to agents(id),
 * we bypass the Drizzle insert helper and use raw SQL for board messages.
 */

const BOARD_SENDER_ID = '__board__';

const SendMessageBody = z.object({
  content: z.string().min(1).max(10_000),
  targetAgentId: z.string().uuid().optional(),
  threadId: z.string().uuid().optional(),
  // VAL-MENTION-018: support @-mentions from BoardChat (company-level scope)
  mentions: z.array(MentionSchema).default([]),
});

export function chatRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { messages, agents } = db.schema;

  // ── GET /threads ── list board chat threads ────────────────────────────
  router.get('/threads', async (req, res) => {
    const companyId = routeParams(req).companyId;

    // Find all threads that involve the board (NULL from_agent_id = board-sent)
    const rows = await db.drizzle
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.companyId, companyId),
          sql`(${messages.fromAgentId} IS NULL OR ${messages.toAgentId} IS NULL)`,
        ),
      )
      .orderBy(desc(messages.createdAt));

    // Group by threadId to build thread summaries
    const threadMap = new Map<
      string,
      {
        id: string;
        lastMessage: string;
        lastMessageAt: string;
        participantAgentIds: Set<string>;
        messageCount: number;
      }
    >();

    for (const row of rows) {
      const tid = row.threadId ?? row.id;
      if (!threadMap.has(tid)) {
        threadMap.set(tid, {
          id: tid,
          lastMessage: row.content,
          lastMessageAt: row.createdAt
            ? new Date(row.createdAt as unknown as number).toISOString()
            : new Date().toISOString(),
          participantAgentIds: new Set<string>(),
          messageCount: 0,
        });
      }
      const thread = threadMap.get(tid)!;
      thread.messageCount++;

      // Track participating agents (skip NULL = board sender)
      if (row.fromAgentId) thread.participantAgentIds.add(row.fromAgentId);
      if (row.toAgentId) thread.participantAgentIds.add(row.toAgentId);
    }

    const threadList = Array.from(threadMap.values()).map((t) => ({
      ...t,
      participantAgentIds: Array.from(t.participantAgentIds),
    }));

    // Already sorted by most recent first (from query order)
    res.json({ data: threadList });
  });

  // ── GET /threads/:threadId ── messages in a thread ────────────────────
  router.get('/threads/:threadId', async (req, res) => {
    const { companyId, threadId } = routeParams(req);

    const rows = await db.drizzle
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.companyId, companyId),
          eq(messages.threadId, threadId),
        ),
      )
      .orderBy(messages.createdAt);

    res.json({ data: rows });
  });

  // ── POST /send ── send a message from the board ───────────────────────
  router.post('/send', async (req, res) => {
    const body = SendMessageBody.parse(req.body);
    const companyId = routeParams(req).companyId;
    const threadId = body.threadId || randomUUID();
    const userMessageId = randomUUID();
    const now = Date.now();

    // Determine which agent should respond
    let targetAgentId = body.targetAgentId ?? null;
    let respondingAgentName: string | null = null;

    if (targetAgentId) {
      // Specific agent requested
      const [agent] = await db.drizzle
        .select({ name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, targetAgentId), eq(agents.companyId, companyId)))
        .limit(1);
      respondingAgentName = agent?.name ?? null;
    } else {
      // Auto-route based on content
      const content = body.content.toLowerCase();

      // Fetch all agents for this company so we can match names
      const companyAgents = await db.drizzle
        .select({ id: agents.id, name: agents.name, role: agents.role })
        .from(agents)
        .where(eq(agents.companyId, companyId));

      // 1. Check if content mentions an agent by name
      for (const a of companyAgents) {
        if (content.includes(a.name.toLowerCase())) {
          targetAgentId = a.id;
          respondingAgentName = a.name;
          break;
        }
      }

      // 2. Route by topic keywords
      if (!targetAgentId) {
        const techKeywords = ['code', 'technical', 'bug', 'deploy', 'architecture', 'api', 'database', 'server', 'frontend', 'backend', 'infra'];
        const marketingKeywords = ['marketing', 'brand', 'campaign', 'social', 'content', 'seo', 'growth', 'audience'];
        const financeKeywords = ['budget', 'cost', 'revenue', 'financial', 'spending', 'profit', 'expense'];

        const isTech = techKeywords.some((k) => content.includes(k));
        const isMarketing = marketingKeywords.some((k) => content.includes(k));
        const isFinance = financeKeywords.some((k) => content.includes(k));

        let targetRole: string | null = null;
        if (isTech) targetRole = 'cto';
        else if (isMarketing) targetRole = 'marketer';
        else if (isFinance) targetRole = 'cfo';
        else targetRole = 'ceo'; // Default to CEO

        const matched = companyAgents.find((a) => a.role === targetRole);
        if (matched) {
          targetAgentId = matched.id;
          respondingAgentName = matched.name;
        } else if (companyAgents.length > 0) {
          // Fallback to the first agent (likely CEO)
          const fallback = companyAgents.find((a) => a.role === 'ceo') ?? companyAgents[0];
          targetAgentId = fallback.id;
          respondingAgentName = fallback.name;
        }
      }
    }

    // VAL-MENTION-018: resolve @-mentions against company membership before
    // persisting, so only company-scoped mentions are stored/dispatched.
    // Mentions are persisted durably in the message metadata so thread reads
    // return them for the UI to render chips + artifact cards.
    const mentionService = new MentionService(db);
    const resolvedMentions: Array<{ entityType: 'agent' | 'user'; entityId: string; label: string }> = [];
    for (const m of body.mentions) {
      const valid = await mentionService.resolveMention(companyId, m.entityType, m.entityId);
      if (valid) resolvedMentions.push({ entityType: m.entityType, entityId: m.entityId, label: m.label });
    }

    const userMetadata = { mentions: resolvedMentions };

    // Insert the board message. from_agent_id is NULL for board-sent messages
    // (migration 0019 made it nullable), so the Drizzle insert helper works
    // without FK constraint issues and serializes timestamp/jsonb correctly.
    await db.drizzle.insert(messages).values({
      id: userMessageId,
      companyId,
      fromAgentId: null,
      toAgentId: targetAgentId ?? null,
      threadId,
      content: body.content,
      type: 'directive',
      metadata: userMetadata,
      createdAt: new Date(now),
    });

    // Emit WebSocket event for real-time updates
    eventBus.emitEvent({
      type: 'message.sent',
      companyId,
      payload: {
        messageId: userMessageId,
        threadId,
        fromBoard: true,
        targetAgentId,
        respondingAgentName,
        mentions: resolvedMentions,
      },
      timestamp: new Date(now).toISOString(),
    });

    // VAL-MENTION-018: dispatch @-mentions from BoardChat in company scope
    // Agent mentions wake the agent with company-level context (projectId=null);
    // any produced artifacts are company-scoped and linked back to the thread.
    let mentionDispatchInfo: Record<string, unknown> | undefined;
    if (resolvedMentions.length > 0) {
      const agentMentions = resolvedMentions.filter((m) => m.entityType === 'agent');
      const userMentions = resolvedMentions.filter((m) => m.entityType === 'user');

      // Dispatch user mentions (notifications) in company scope — tracked
      // fire-and-forget so tests can drain deterministically.
      if (userMentions.length > 0) {
        backgroundWork.fire(
          mentionService.dispatchMentions({
            companyId,
            projectId: null,
            threadId: threadId,
            itemId: userMessageId,
            content: body.content,
            mentions: userMentions,
            authorUserId: req.user?.id ?? null,
          }),
          'boardchat user-mention dispatch',
        );
      }

      // For agent mentions, fetch the agent rows (already company-validated
      // above) and dispatch the agent run in the background (fire and forget).
      if (agentMentions.length > 0) {
        const { tasks, agents: agentsTable } = db.schema;
        const validAgentMentions: Array<{ id: string; name: string; status: string; mention: any }> = [];
        for (const mention of agentMentions) {
          const [agent] = await db.drizzle
            .select()
            .from(agentsTable)
            .where(and(eq(agentsTable.id, mention.entityId), eq(agentsTable.companyId, companyId)))
            .limit(1);
          if (agent) {
            validAgentMentions.push({ id: agent.id, name: agent.name, status: agent.status, mention });
          }
        }

        if (validAgentMentions.length > 0) {
          mentionDispatchInfo = {
            dispatchedAgents: validAgentMentions.map((a) => ({ agentId: a.id, agentName: a.name })),
          };

          // Tracked fire-and-forget: create task, run agent loop, post
          // response as message. Errors are logged with context in the
          // background work tracker.
          backgroundWork.fire(
            (async () => {
              for (const { id: aId, name: aName, status: aStatus, mention } of validAgentMentions) {
                if (aStatus === 'paused' || aStatus === 'offline') continue;
                try {
                  const agentTaskNow = new Date();
                  const [task] = await db.drizzle
                    .insert(tasks)
                    .values({
                      companyId,
                      projectId: null,
                      title: `@${mention.label}: ${body.content.slice(0, 100)}`,
                      description: body.content,
                      type: 'feature',
                      priority: 'medium',
                      status: 'todo',
                      assigneeAgentId: aId,
                      createdAt: agentTaskNow,
                      updatedAt: agentTaskNow,
                    })
                    .returning();

                  await db.drizzle
                    .update(agentsTable)
                    .set({ status: 'working', updatedAt: agentTaskNow })
                    .where(eq(agentsTable.id, aId));

                  const loop = new AgenticLoop(db, { maxIterations: 8 });
                  const result = await loop.run(aId, task.id, companyId);
                  const producedArtifacts = loop.getProducedArtifacts();

                  const responseContent = result.finalOutput || '(Agent completed with no output)';
                  const responseMetadata: Record<string, unknown> = {
                    agentResponse: true,
                    agentId: aId,
                    agentName: aName,
                  };
                  if (producedArtifacts.length > 0) {
                    responseMetadata.artifactId = producedArtifacts[0].artifactId;
                    responseMetadata.artifactType = producedArtifacts[0].artifactType;
                    responseMetadata.artifacts = producedArtifacts;
                  }

                  const responseMsgId = randomUUID();
                  const responseNow = Date.now();
                  await db.drizzle.insert(messages).values({
                    id: responseMsgId,
                    companyId,
                    fromAgentId: aId,
                    toAgentId: null,
                    threadId,
                    content: responseContent.slice(0, 10_000),
                    type: 'response',
                    metadata: responseMetadata,
                    createdAt: new Date(responseNow),
                  });

                  eventBus.emitEvent({
                    type: 'message.sent',
                    companyId,
                    payload: {
                      messageId: responseMsgId,
                      threadId,
                      fromBoard: false,
                      agentId: aId,
                      agentName: aName,
                      artifacts: producedArtifacts,
                    },
                    timestamp: new Date(responseNow).toISOString(),
                  });
                } catch (err) {
                  logger.error({ err, agentId: aId }, '[boardchat-mention] agent dispatch error');
                }
              }
            })(),
            'boardchat agent-mention dispatch',
          );
        }
      }
    }

    res.status(201).json({
      data: {
        messageId: userMessageId,
        threadId,
        respondingAgentId: targetAgentId,
        respondingAgentName,
        mentions: resolvedMentions,
        mentionDispatch: mentionDispatchInfo,
      },
    });
  });

  return router;
}
