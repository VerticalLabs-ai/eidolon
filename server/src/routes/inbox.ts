import { Router } from 'express';
import { and, desc, eq, inArray, isNotNull, sql, or, gte } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';
import { buildMissionUiLink } from '@eidolon/shared';

// ---------------------------------------------------------------------------
// Unified inbox feed
// ---------------------------------------------------------------------------
//
// Merges the three signal sources an operator wants to see in one place:
//   1. Pending approvals          — require a decision
//   2. Inbound collaborations     — delegations / help requests / reviews
//   3. Recent activity log        — high-signal events
//
// Per-user read state lives in inbox_read_states. Each item ships with a
// `readAt` timestamp (null when unread). Clients mutate read state via
// POST /read and POST /unread; the state syncs across devices.
// ---------------------------------------------------------------------------

export interface InboxItem {
  id: string;
  kind: 'approval' | 'collaboration' | 'activity' | 'task_thread' | 'mission_question';
  title: string;
  subtitle?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  status?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  taskId?: string;
  threadItemId?: string;
  link: string;
  createdAt: string;
  readAt: string | null;
  /** Mission question attention item context (kind === 'mission_question'). */
  projectId?: string;
  runId?: string;
  questionSetId?: string;
  /** Whether the attention item is still actionable (open) or resolved history. */
  actionable?: boolean;
}

const ACTIVITY_KINDS_OF_INTEREST = new Set([
  'approval.created',
  'approval.decided',
  'execution.completed',
  'budget.alert',
  'budget.threshold_exceeded',
  'cost.recorded',
  'agent.created',
  'agent.terminated',
  'agent.status_changed',
  'task.timed_out',
  'thread.mention',
]);

/**
 * Resolved mission question sets are retained in the inbox feed as
 * non-actionable history for this many days (VAL-MODEQ-090). Older
 * resolved sets fall out of the bounded feed and remain reachable only
 * via the run timeline / snapshot.
 */
const MISSION_QUESTION_RETENTION_DAYS = 7;

const MarkBody = z.object({
  itemIds: z.array(z.string().min(1).max(255)).min(1).max(500),
});

export function inboxRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const {
    approvals,
    agentCollaborations,
    activityLog,
    inboxReadStates,
    taskThreadItems,
    runQuestionSets,
    missionRuns,
  } = db.schema;

  // Capture auth mode at router creation time (during createApp() when
  // AUTH_MODE is set). In tests, AUTH_MODE is only set during createApp()
  // and restored afterward, so checking process.env at request time would
  // always be undefined.
  const isLocalTrusted = process.env.AUTH_MODE === 'local_trusted';

  // -------------------------------------------------------------------------
  // GET / — unified feed with readAt per item
  // -------------------------------------------------------------------------
  // In local_trusted mode, a `userId` query parameter overrides the
  // authenticated user so validators can check a test user's inbox
  // (e.g. mention notifications for a second user created via
  // /api/auth/local-trusted/create-test-user).
  router.get('/', async (req, res) => {
    const companyId = routeParams(req).companyId;
    let userId = req.user?.id;
    if (!userId) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    // local_trusted: allow userId override for test user inbox queries
    if (isLocalTrusted) {
      const overrideUserId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
      if (overrideUserId) {
        userId = overrideUserId;
      }
    }
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1),
      200,
    );

    const pendingApprovals = await db.drizzle
      .select()
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.createdAt))
      .limit(limit);

    const pendingCollabs = await db.drizzle
      .select()
      .from(agentCollaborations)
      .where(
        and(
          eq(agentCollaborations.companyId, companyId),
          eq(agentCollaborations.status, 'pending'),
        ),
      )
      .orderBy(desc(agentCollaborations.createdAt))
      .limit(limit);

    const pendingThreadItems = await db.drizzle
      .select()
      .from(taskThreadItems)
      .where(
        and(
          eq(taskThreadItems.companyId, companyId),
          eq(taskThreadItems.kind, 'interaction'),
          eq(taskThreadItems.status, 'pending'),
          isNotNull(taskThreadItems.taskId),
        ),
      )
      .orderBy(desc(taskThreadItems.createdAt))
      .limit(limit);

    const recentActivity = await db.drizzle
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit * 2);

    // Mission question needs-attention items (VAL-MODEQ-087..091, 120, 141).
    // Active items = open question sets whose run is awaiting_input. Resolved
    // history = answered/invalidated sets resolved within the retention
    // window. The query is company-scoped; project/content permission to
    // answer is enforced when the user opens Project Work, never inferred
    // here. No answer text is joined into the item.
    const missionQuestionRows = await db.drizzle
      .select({
        setId: runQuestionSets.id,
        setCompanyId: runQuestionSets.companyId,
        setProjectId: runQuestionSets.projectId,
        setRunId: runQuestionSets.runId,
        ordinal: runQuestionSets.ordinal,
        version: runQuestionSets.version,
        setStatus: runQuestionSets.status,
        invalidationReason: runQuestionSets.invalidationReason,
        setCreatedAt: runQuestionSets.createdAt,
        answeredAt: runQuestionSets.answeredAt,
        invalidatedAt: runQuestionSets.invalidatedAt,
        runStatus: missionRuns.status,
        threadId: missionRuns.projectThreadId,
        requestSafeSummary: missionRuns.requestSafeSummary,
      })
      .from(runQuestionSets)
      .innerJoin(missionRuns, eq(missionRuns.id, runQuestionSets.runId))
      .where(
        and(
          eq(runQuestionSets.companyId, companyId),
          // Active open sets, OR resolved sets within the retention window.
          or(
            eq(runQuestionSets.status, 'open'),
            and(
              inArray(runQuestionSets.status, ['answered', 'invalidated']),
              gte(
                sql`coalesce(${runQuestionSets.answeredAt}, ${runQuestionSets.invalidatedAt})`,
                sql`now() - interval ${sql.raw(`'${MISSION_QUESTION_RETENTION_DAYS} days'`)}`,
              ),
            ),
          ),
        ),
      )
      .orderBy(desc(runQuestionSets.createdAt))
      .limit(limit);

    // Accurate meta counts (independent of the feed limit)
    const [{ pendingApprovalTotal }] = await db.drizzle
      .select({ pendingApprovalTotal: sql<number>`count(*)` })
      .from(approvals)
      .where(and(eq(approvals.companyId, companyId), eq(approvals.status, 'pending')));
    const [{ pendingCollabTotal }] = await db.drizzle
      .select({ pendingCollabTotal: sql<number>`count(*)` })
      .from(agentCollaborations)
      .where(
        and(
          eq(agentCollaborations.companyId, companyId),
          eq(agentCollaborations.status, 'pending'),
        ),
      );
    const [{ pendingThreadItemTotal }] = await db.drizzle
      .select({ pendingThreadItemTotal: sql<number>`count(*)` })
      .from(taskThreadItems)
      .where(
        and(
          eq(taskThreadItems.companyId, companyId),
          eq(taskThreadItems.kind, 'interaction'),
          eq(taskThreadItems.status, 'pending'),
          isNotNull(taskThreadItems.taskId),
        ),
      );
    // Active mission question attention count = open sets on awaiting_input runs.
    const [{ pendingMissionQuestionTotal }] = await db.drizzle
      .select({ pendingMissionQuestionTotal: sql<number>`count(*)` })
      .from(runQuestionSets)
      .innerJoin(missionRuns, eq(missionRuns.id, runQuestionSets.runId))
      .where(
        and(
          eq(runQuestionSets.companyId, companyId),
          eq(runQuestionSets.status, 'open'),
          eq(missionRuns.status, 'awaiting_input'),
        ),
      );

    const items: InboxItem[] = [];

    for (const a of pendingApprovals) {
      const itemId = `approval:${a.id}`;
      const taskThreadLink = a.taskId ? taskThreadUrl(companyId, a.taskId, itemId) : null;
      items.push({
        id: itemId,
        kind: 'approval',
        title: a.title,
        subtitle:
          (a.description ?? '').slice(0, 160) || `Pending ${(a.kind as string).replace('_', ' ')}`,
        priority: a.priority as InboxItem['priority'],
        status: a.status as string,
        entityType: 'approval',
        entityId: a.id,
        taskId: a.taskId ?? undefined,
        threadItemId: a.taskId ? itemId : undefined,
        link: taskThreadLink
          ? withInboxItem(taskThreadLink, itemId)
          : `/company/${companyId}/approvals?focus=${a.id}`,
        createdAt: new Date(a.createdAt).toISOString(),
        readAt: null,
      });
    }

    for (const c of pendingCollabs) {
      items.push({
        id: `collaboration:${c.id}`,
        kind: 'collaboration',
        title:
          `${(c.type as string).replace('_', ' ')} — ${(c.requestContent ?? '').slice(0, 80)}`.trim() ||
          'Collaboration request',
        subtitle: `from agent ${c.fromAgentId.slice(0, 8)} → ${c.toAgentId.slice(0, 8)}`,
        priority: c.priority as InboxItem['priority'],
        status: c.status as string,
        actorId: c.fromAgentId,
        entityType: 'collaboration',
        entityId: c.id,
        link: `/company/${companyId}/agents/${c.toAgentId}`,
        createdAt: new Date(c.createdAt).toISOString(),
        readAt: null,
      });
    }

    for (const item of pendingThreadItems) {
      if (!item.taskId) {
        continue;
      }
      const inboxItemId = `thread:${item.id}`;
      const interactionLabel = (item.interactionType ?? 'interaction').replace('_', ' ');
      items.push({
        id: inboxItemId,
        kind: 'task_thread',
        title: `Task question: ${interactionLabel}`,
        subtitle: item.content?.slice(0, 160) ?? 'Agent needs an operator response',
        status: item.status,
        actorId: item.authorAgentId ?? item.authorUserId ?? undefined,
        entityType: 'task_thread_item',
        entityId: item.id,
        taskId: item.taskId,
        threadItemId: item.id,
        link: withInboxItem(taskThreadUrl(companyId, item.taskId, item.id), inboxItemId),
        createdAt: new Date(item.createdAt).toISOString(),
        readAt: null,
      });
    }

    for (const q of missionQuestionRows) {
      // Only open sets whose run is still awaiting input are actionable.
      const actionable = q.setStatus === 'open' && q.runStatus === 'awaiting_input';
      // Skip resolved rows that are not actually resolved (e.g. an open set
      // whose run advanced past awaiting_input without the set being closed —
      // a defensive guard; the run/set transition should keep these in sync).
      if (q.setStatus === 'open' && !actionable) {
        continue;
      }
      const link = buildMissionUiLink({
        companyId,
        projectId: q.setProjectId,
        threadId: q.threadId,
        runId: q.setRunId,
        target: { kind: 'question', questionSetId: q.setId },
      });
      const summary = (q.requestSafeSummary ?? '').slice(0, 120);
      items.push({
        id: `mission_question:${q.setId}`,
        kind: 'mission_question',
        title: actionable ? 'Mission needs input' : 'Mission question resolved',
        subtitle: actionable
          ? summary || 'Mission is awaiting your answer'
          : `Set ${q.setStatus}${q.invalidationReason ? ` (${q.invalidationReason})` : ''}`,
        status: q.setStatus,
        entityType: 'mission_question_set',
        entityId: q.setId,
        projectId: q.setProjectId,
        runId: q.setRunId,
        questionSetId: q.setId,
        actionable,
        link: withInboxItem(link, `mission_question:${q.setId}`),
        createdAt: new Date(q.setCreatedAt).toISOString(),
        readAt: null,
      });
    }

    for (const row of recentActivity) {
      if (!ACTIVITY_KINDS_OF_INTEREST.has(row.action)) {
        continue;
      }
      // thread.mention notifications are recipient-scoped: only the
      // mentioned user should see them in their inbox. Filter out
      // thread.mention entries whose metadata.mentionedUserId does not
      // match the requesting user to prevent cross-user notification leakage.
      if (row.action === 'thread.mention') {
        const mentionedUserId = row.metadata?.mentionedUserId;
        if (typeof mentionedUserId !== 'string' || mentionedUserId !== userId) {
          continue;
        }
      }
      items.push({
        id: `activity:${row.id}`,
        kind: 'activity',
        title:
          row.description ??
          row.action
            .split('.')
            .map((s: string) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(' '),
        subtitle: `${row.actorType} · ${row.entityType}`,
        actorId: row.actorId ?? undefined,
        entityType: row.entityType,
        entityId: row.entityId ?? undefined,
        taskId: activityTaskId(row) ?? undefined,
        link: withInboxItem(linkForActivity(companyId, row), `activity:${row.id}`),
        createdAt: new Date(row.createdAt).toISOString(),
        readAt: null,
      });
    }

    items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const limited = items.slice(0, limit);

    // Overlay read state for this user in one bulk query
    if (limited.length > 0) {
      const ids = limited.map((i) => i.id);
      const readRows = await db.drizzle
        .select({
          itemId: inboxReadStates.itemId,
          readAt: inboxReadStates.readAt,
        })
        .from(inboxReadStates)
        .where(
          and(
            eq(inboxReadStates.userId, userId),
            eq(inboxReadStates.companyId, companyId),
            inArray(inboxReadStates.itemId, ids),
          ),
        );
      const readMap = new Map<string, Date>();
      for (const r of readRows) {
        readMap.set(r.itemId, r.readAt as unknown as Date);
      }
      for (const item of limited) {
        const when = readMap.get(item.id);
        if (when) {
          item.readAt = new Date(when).toISOString();
        }
      }
    }

    const unread = limited.filter((i) => i.readAt === null).length;

    res.json({
      data: limited,
      meta: {
        pendingApprovals: Number(pendingApprovalTotal),
        pendingCollaborations: Number(pendingCollabTotal),
        pendingThreadItems: Number(pendingThreadItemTotal),
        pendingMissionQuestions: Number(pendingMissionQuestionTotal),
        total: items.length,
        unread,
      },
    });
  });

  // -------------------------------------------------------------------------
  // POST /read — bulk mark-as-read (idempotent)
  // -------------------------------------------------------------------------
  router.post('/read', validate(MarkBody), async (req, res) => {
    const body = req.body as z.infer<typeof MarkBody>;
    const companyId = routeParams(req).companyId;
    const userId = req.user?.id;
    if (!userId) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    const now = new Date();

    // Dedupe client-side payloads
    const uniqueIds = Array.from(new Set(body.itemIds));

    // SQLite INSERT … ON CONFLICT via drizzle's onConflictDoUpdate keeps this
    // single-round-trip for any size payload up to the 500 cap.
    await db.drizzle
      .insert(inboxReadStates)
      .values(
        uniqueIds.map((itemId) => ({
          id: randomUUID(),
          userId,
          companyId,
          itemId,
          readAt: now,
          createdAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [inboxReadStates.userId, inboxReadStates.companyId, inboxReadStates.itemId],
        set: { readAt: now },
      });

    res.json({ data: { marked: uniqueIds.length, readAt: now.toISOString() } });
  });

  // -------------------------------------------------------------------------
  // POST /unread — clear read state for specified items
  // -------------------------------------------------------------------------
  router.post('/unread', validate(MarkBody), async (req, res) => {
    const body = req.body as z.infer<typeof MarkBody>;
    const companyId = routeParams(req).companyId;
    const userId = req.user?.id;
    if (!userId) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const uniqueIds = Array.from(new Set(body.itemIds));

    await db.drizzle
      .delete(inboxReadStates)
      .where(
        and(
          eq(inboxReadStates.userId, userId),
          eq(inboxReadStates.companyId, companyId),
          inArray(inboxReadStates.itemId, uniqueIds),
        ),
      );

    res.json({ data: { cleared: uniqueIds.length } });
  });

  return router;
}

function linkForActivity(
  companyId: string,
  row: {
    entityType: string;
    entityId: string | null;
    metadata?: Record<string, unknown>;
  },
): string {
  const base = `/company/${companyId}`;
  const taskId = activityTaskId(row);
  if (taskId) {
    return `${base}/tasks/${taskId}`;
  }

  switch (row.entityType) {
    case 'agent':
      return row.entityId ? `${base}/agents/${row.entityId}` : `${base}/agents`;
    case 'task':
      return row.entityId ? `${base}/tasks/${row.entityId}` : `${base}/issues`;
    case 'goal':
      return `${base}/goals`;
    case 'approval':
      return row.entityId ? `${base}/approvals?focus=${row.entityId}` : `${base}/approvals`;
    case 'execution':
      return `${base}/agents`;
    default:
      return base;
  }
}

function activityTaskId(row: {
  entityType: string;
  entityId: string | null;
  metadata?: Record<string, unknown>;
}): string | null {
  if (row.entityType === 'task') {
    return row.entityId;
  }
  const taskId = row.metadata?.taskId;
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : null;
}

function taskThreadUrl(companyId: string, taskId: string, threadItemId: string): string {
  return `/company/${companyId}/tasks/${taskId}?threadItem=${encodeURIComponent(threadItemId)}`;
}

function withInboxItem(link: string, inboxItemId: string): string {
  const separator = link.includes('?') ? '&' : '?';
  return `${link}${separator}inboxItem=${encodeURIComponent(inboxItemId)}`;
}
