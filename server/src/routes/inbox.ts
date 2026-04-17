import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Unified inbox feed
// ---------------------------------------------------------------------------
//
// Merges the three signal sources an operator actually wants to see in one
// place:
//   1. Pending approvals          — require a decision
//   2. Inbound collaborations     — delegations / help requests / reviews
//                                     whose target is an agent you operate
//   3. Recent activity log        — high-signal events (agent created,
//                                     execution completed/failed, cost/budget
//                                     alerts, approval decisions)
// Each item lands with a stable `id`, `kind`, `title`, `createdAt`, and a
// `link` the UI can navigate to. Client-side stores read-state locally — we
// intentionally avoid a new per-user table at this stage.
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

export function inboxRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { approvals, agentCollaborations, activityLog } = db.schema;

  router.get('/', async (req, res) => {
    const companyId = routeParams(req).companyId;
    const limit = Math.min(
      Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1),
      200,
    );

    // 1. Pending approvals — always surface
    const pendingApprovals = await db.drizzle
      .select()
      .from(approvals)
      .where(
        and(eq(approvals.companyId, companyId), eq(approvals.status, 'pending')),
      )
      .orderBy(desc(approvals.createdAt))
      .limit(limit);

    // 2. Pending collaborations (recipient-oriented)
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

    // 3. Recent high-signal activity
    const recentActivity = await db.drizzle
      .select()
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .orderBy(desc(activityLog.createdAt))
      .limit(limit * 2); // over-fetch then filter

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
      });
    }

    items.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    res.json({
      data: items.slice(0, limit),
      meta: {
        pendingApprovals: Number(pendingApprovalTotal),
        pendingCollaborations: Number(pendingCollabTotal),
        total: items.length,
      },
    });
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
