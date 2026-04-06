import { Router } from 'express';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

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
});

export function chatRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { messages, agents } = db.schema;

  // ── GET /threads ── list board chat threads ────────────────────────────
  router.get('/threads', async (req, res) => {
    const companyId = routeParams(req).companyId;

    // Find all threads that involve the board (either from or to)
    const rows = await db.drizzle
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.companyId, companyId),
          sql`(${messages.fromAgentId} = ${BOARD_SENDER_ID} OR ${messages.toAgentId} = ${BOARD_SENDER_ID})`,
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

      // Track participating agents (skip the board sentinel)
      if (row.fromAgentId !== BOARD_SENDER_ID) thread.participantAgentIds.add(row.fromAgentId);
      if (row.toAgentId !== BOARD_SENDER_ID) thread.participantAgentIds.add(row.toAgentId);
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

    // Insert the board message using raw SQL to avoid FK constraint issues
    // (the fromAgentId '__board__' is not a real agent)
    const rawDb = (db.drizzle as any).run
      ? db.drizzle
      : db.drizzle;

    // Use drizzle's run method via the underlying better-sqlite3 connection
    // Since we can't bypass FK with drizzle ORM, we temporarily disable FK checks
    // Actually, safer: insert with raw SQL through drizzle
    await (db.drizzle as any).run(
      sql`INSERT INTO messages (id, company_id, from_agent_id, to_agent_id, thread_id, content, message_type, metadata, created_at)
          VALUES (${userMessageId}, ${companyId}, ${BOARD_SENDER_ID}, ${targetAgentId ?? BOARD_SENDER_ID}, ${threadId}, ${body.content}, 'text', '{}', ${now})`,
    );

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
      },
      timestamp: new Date(now).toISOString(),
    });

    res.status(201).json({
      data: {
        messageId: userMessageId,
        threadId,
        respondingAgentId: targetAgentId,
        respondingAgentName,
      },
    });
  });

  return router;
}
