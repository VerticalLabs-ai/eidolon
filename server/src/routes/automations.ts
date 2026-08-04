import { and, count, desc, eq, max } from 'drizzle-orm';
import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { validate } from '../middleware/validate.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const RunListQuery = z.object({
  type: z.enum(['routine', 'workflow', 'webhook']).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']).optional(),
  project: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const PerAutomationRunsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const AUTOMATION_TYPES = ['routine', 'workflow', 'webhook'] as const;
type AutomationType = (typeof AUTOMATION_TYPES)[number];

// ---------------------------------------------------------------------------
// Canonical entry shape
// ---------------------------------------------------------------------------

export interface AutomationEntry {
  type: AutomationType;
  id: string;
  name: string;
  enabled: boolean;
  status: string;
  triggerInfo: Record<string, unknown>;
  projectId: string | null;
  lastRun: string | null;
  runCount: number;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function automationsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const { routines, workflows, webhooks, automationRuns } = db.schema;

  // GET / — unified automations listing (aggregates routines, workflows, webhooks)
  router.get('/', async (req, res) => {
    const { companyId } = routeParams(req);
    const project =
      typeof req.query.project === 'string' ? req.query.project : undefined;

    // Fetch all three sources in parallel
    const [routineRows, workflowRows, webhookRows] = await Promise.all([
      db.drizzle
        .select()
        .from(routines)
        .where(
          project
            ? and(eq(routines.companyId, companyId), eq(routines.projectId, project))
            : eq(routines.companyId, companyId),
        ),
      db.drizzle
        .select()
        .from(workflows)
        .where(
          project
            ? and(eq(workflows.companyId, companyId), eq(workflows.projectId, project))
            : eq(workflows.companyId, companyId),
        ),
      db.drizzle
        .select()
        .from(webhooks)
        .where(
          project
            ? and(eq(webhooks.companyId, companyId), eq(webhooks.projectId, project))
            : eq(webhooks.companyId, companyId),
        ),
    ]);

    // Fetch run aggregates (runCount + lastRun) grouped by type+id for this company
    const runAggregates = await db.drizzle
      .select({
        automationType: automationRuns.automationType,
        automationId: automationRuns.automationId,
        runCount: count(automationRuns.id),
        lastRun: max(automationRuns.createdAt),
      })
      .from(automationRuns)
      .where(eq(automationRuns.companyId, companyId))
      .groupBy(automationRuns.automationType, automationRuns.automationId);

    const runMap = new Map<string, { runCount: number; lastRun: string | null }>();
    for (const agg of runAggregates) {
      runMap.set(`${agg.automationType}:${agg.automationId}`, {
        runCount: Number(agg.runCount),
        lastRun: agg.lastRun ? (agg.lastRun as Date).toISOString() : null,
      });
    }

    const entries: AutomationEntry[] = [];

    // Routines → canonical entries
    for (const r of routineRows) {
      const key = `routine:${r.id}`;
      const agg = runMap.get(key);
      entries.push({
        type: 'routine',
        id: r.id,
        name: r.name,
        enabled: r.enabled,
        status: r.enabled ? 'active' : 'inactive',
        triggerInfo: {
          mode: r.mode,
          schedule: r.schedule,
          jarvisMode: r.jarvisMode,
        },
        projectId: r.projectId,
        lastRun: agg?.lastRun ?? null,
        runCount: agg?.runCount ?? 0,
      });
    }

    // Workflows → canonical entries
    for (const w of workflowRows) {
      const key = `workflow:${w.id}`;
      const agg = runMap.get(key);
      const nodes = (w.nodes as unknown as unknown[]) ?? [];
      entries.push({
        type: 'workflow',
        id: w.id,
        name: w.name,
        enabled: w.status === 'active',
        status: w.status,
        triggerInfo: {
          nodeCount: nodes.length,
          status: w.status,
        },
        projectId: w.projectId,
        lastRun: agg?.lastRun ?? null,
        runCount: agg?.runCount ?? 0,
      });
    }

    // Webhooks → canonical entries
    for (const wh of webhookRows) {
      const key = `webhook:${wh.id}`;
      const agg = runMap.get(key);
      entries.push({
        type: 'webhook',
        id: wh.id,
        name: wh.name,
        enabled: wh.enabled,
        status: wh.enabled ? 'active' : 'inactive',
        triggerInfo: {
          eventType: wh.eventType,
          enabled: wh.enabled,
          triggerCount: wh.triggerCount,
        },
        projectId: wh.projectId,
        lastRun: agg?.lastRun ?? null,
        runCount: agg?.runCount ?? 0,
      });
    }

    res.json({ data: entries });
  });

  // GET /runs — paginated list of all automation runs with filters
  router.get('/runs', validate(RunListQuery, 'query'), async (req, res) => {
    const { companyId } = routeParams(req);
    const query = (req as any).validated?.query as z.infer<typeof RunListQuery>;

    const conditions = [eq(automationRuns.companyId, companyId)];
    if (query.type) conditions.push(eq(automationRuns.automationType, query.type));
    if (query.status) conditions.push(eq(automationRuns.status, query.status));
    if (query.project) conditions.push(eq(automationRuns.projectId, query.project));

    const rows = await db.drizzle
      .select()
      .from(automationRuns)
      .where(and(...conditions))
      .orderBy(desc(automationRuns.createdAt))
      .limit(query.limit)
      .offset(query.offset);

    res.json({ data: rows });
  });

  // GET /:automationType/:automationId/runs — per-automation run history with pagination
  router.get(
    '/:automationType/:automationId/runs',
    validate(PerAutomationRunsQuery, 'query'),
    async (req, res) => {
      const { companyId } = routeParams(req);
      const { automationType, automationId } = routeParams(req);
      const query = (req as any).validated?.query as z.infer<typeof PerAutomationRunsQuery>;

      // Validate automation type — invalid type returns 400
      if (!AUTOMATION_TYPES.includes(automationType as AutomationType)) {
        throw new AppError(
          400,
          'INVALID_AUTOMATION_TYPE',
          `Invalid automation type: ${automationType}. Must be one of: routine, workflow, webhook`,
        );
      }

      const rows = await db.drizzle
        .select()
        .from(automationRuns)
        .where(
          and(
            eq(automationRuns.companyId, companyId),
            eq(automationRuns.automationType, automationType as AutomationType),
            eq(automationRuns.automationId, automationId),
          ),
        )
        .orderBy(desc(automationRuns.createdAt))
        .limit(query.limit)
        .offset(query.offset);

      res.json({ data: rows });
    },
  );

  return router;
}
