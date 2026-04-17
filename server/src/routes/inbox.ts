import { Router } from 'express';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

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
  kind: 'approval' | 'collaboration' | 'activity';
  title: string;
  subtitle?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  status?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  link: string;
  createdAt: string;
  readAt: string | null;
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
]);

const MarkBody = z.object({
  itemIds: z.array(z.string().min(1).max(255)).min(1).max(500),
});

export function inboxRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { approvals, agentCollaborations, activityLog, inboxReadStates } =
    db.schema;

  // -------------------------------------------------------------------------
  // GET / — unified feed with readAt per item
  // -------------------------------------------------------------------------
  router.get('/', async (req, res) => {
    const companyId = routeParams(req).companyId;
    const userId = req.user?.id;
    if (!userId) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1),
      200,
    );

    const pendingApprovals = await db.drizzle
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.companyId, companyId), eq(approvals.status, 'pending')),
      )
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

    const recentActivity = await db.drizzle
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit * 2);

    // Accurate meta counts (independent of the feed limit)
    const [{ pendingApprovalTotal }] = await db.drizzle
      .select({ pendingApprovalTotal: sql<number>`count(*)` })
      .from(approvals)
      .where(
        and(eq(approvals.companyId, companyId), eq(approvals.status, 'pending')),
      );
    const [{ pendingCollabTotal }] = await db.drizzle
      .select({ pendingCollabTotal: sql<number>`count(*)` })
      .from(agentCollaborations)
      .where(
        and(
          eq(agentCollaborations.companyId, companyId),
          eq(agentCollaborations.status, 'pending'),
        ),
      );

    const items: InboxItem[] = [];

    for (const a of pendingApprovals) {
      items.push({
        id: `approval:${a.id}`,
        kind: 'approval',
        title: a.title,
        subtitle:
          (a.description ?? '').slice(0, 160) ||
          `Pending ${(a.kind as string).replace('_', ' ')}`,
        priority: a.priority as InboxItem['priority'],
        status: a.status as string,
        entityType: 'approval',
        entityId: a.id,
        link: `/company/${companyId}/approvals?focus=${a.id}`,
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

    for (const row of recentActivity) {
      if (!ACTIVITY_KINDS_OF_INTEREST.has(row.action)) continue;
      items.push({
        id: `activity:${row.id}`,
        kind: 'activity',
        title:
          row.description ??
          row.action
            .split('.')
            .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
            .join(' '),
        subtitle: `${row.actorType} · ${row.entityType}`,
        actorId: row.actorId ?? undefined,
        entityType: row.entityType,
        entityId: row.entityId ?? undefined,
        link: linkForActivity(companyId, row),
        createdAt: new Date(row.createdAt).toISOString(),
        readAt: null,
      });
    }

    items.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

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
        if (when) item.readAt = new Date(when).toISOString();
      }
    }

    const unread = limited.filter((i) => i.readAt === null).length;

    res.json({
      data: limited,
      meta: {
        pendingApprovals: Number(pendingApprovalTotal),
        pendingCollaborations: Number(pendingCollabTotal),
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
        target: [
          inboxReadStates.userId,
          inboxReadStates.companyId,
          inboxReadStates.itemId,
        ],
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
  },
): string {
  const base = `/company/${companyId}`;
  switch (row.entityType) {
    case 'agent':
      return row.entityId ? `${base}/agents/${row.entityId}` : `${base}/agents`;
    case 'task':
      return row.entityId ? `${base}/tasks/${row.entityId}` : `${base}/issues`;
    case 'goal':
      return `${base}/goals`;
    case 'approval':
      return row.entityId
        ? `${base}/approvals?focus=${row.entityId}`
        : `${base}/approvals`;
    case 'execution':
      return `${base}/agents`;
    default:
      return base;
  }
}
