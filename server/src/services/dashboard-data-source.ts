// ---------------------------------------------------------------------------
// Dashboard data-source provider registry
// ---------------------------------------------------------------------------
//
// Resolves a dashboard data-source config into live data for widget rendering.
// Three pluggable provider categories (architecture §3.8 / VAL-DASHBOARD-002):
//   - analytics_endpoint: proxies to an existing internal analytics API path
//     (same company scope); the endpoint path is validated against an
//     allowlist of known analytics routes to prevent SSRF.
//   - integration: returns the stored integration row's config + health as
//     the data payload (a bounded, safe resolution that does NOT execute
//     arbitrary remote calls).
//   - manual_json: returns the inline `config.data` payload directly.
//
// All resolution is server-side under the existing auth/RLS + company
// scoping; the route handler enforces company ownership of the artifact
// before invoking a provider.
// ---------------------------------------------------------------------------

import { eq, and } from 'drizzle-orm';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

/** Shape of a dashboard data source as stored in artifact content. */
export interface DashboardDataSource {
  id: string;
  type: 'analytics_endpoint' | 'integration' | 'manual_json';
  config: Record<string, unknown>;
}

/** Result of resolving a data source — the live data widgets render from. */
export interface ResolvedDataSource {
  dataSourceId: string;
  type: DashboardDataSource['type'];
  data: unknown;
  resolvedAt: string;
}

/**
 * Allowlist of analytics endpoint paths that an analytics_endpoint data
 * source may proxy to. The path is a suffix starting with `/analytics/`; the
 * resolver constructs the full internal URL relative to the company. This
 * prevents SSRF — arbitrary external URLs are rejected.
 */
const ANALYTICS_PATH_ALLOWLIST = [
  '/analytics/overview',
  '/analytics/agents',
  '/analytics/costs',
  '/analytics/tasks',
];

/**
 * Resolve a single dashboard data source into live data.
 *
 * @param db        DbInstance (for integration lookups)
 * @param companyId the artifact's company scope (validated by the caller)
 * @param source    the data source config from the dashboard content
 */
export async function resolveDataSource(
  db: DbInstance,
  companyId: string,
  source: DashboardDataSource,
): Promise<ResolvedDataSource> {
  const resolvedAt = new Date().toISOString();
  switch (source.type) {
    case 'manual_json': {
      const data = source.config.data;
      if (data === undefined) {
        throw new AppError(
          400,
          'INVALID_DATA_SOURCE_CONFIG',
          'manual_json data source requires a "data" config field',
        );
      }
      return { dataSourceId: source.id, type: source.type, data, resolvedAt };
    }
    case 'analytics_endpoint': {
      const endpoint = typeof source.config.endpoint === 'string'
        ? (source.config.endpoint as string)
        : '';
      if (!endpoint) {
        throw new AppError(
          400,
          'INVALID_DATA_SOURCE_CONFIG',
          'analytics_endpoint data source requires a non-empty "endpoint" config field',
        );
      }
      // Normalize: accept paths with or without a leading slash, and a
      // leading company-scoped prefix. We only need the suffix starting at
      // "/analytics/".
      const normalized = endpoint.startsWith('/')
        ? endpoint
        : `/${endpoint}`;
      const analyticsIdx = normalized.indexOf('/analytics/');
      if (analyticsIdx < 0) {
        throw new AppError(
          400,
          'INVALID_DATA_SOURCE_CONFIG',
          `analytics_endpoint "${endpoint}" must include an /analytics/ path`,
        );
      }
      const suffix = normalized.slice(analyticsIdx);
      if (!ANALYTICS_PATH_ALLOWLIST.includes(suffix)) {
        throw new AppError(
          400,
          'INVALID_DATA_SOURCE_CONFIG',
          `analytics_endpoint path "${suffix}" is not in the allowlist`,
        );
      }
      const data = await fetchAnalyticsInternal(db, companyId, suffix);
      return { dataSourceId: source.id, type: source.type, data, resolvedAt };
    }
    case 'integration': {
      const integrationId = typeof source.config.integrationId === 'string'
        ? (source.config.integrationId as string)
        : '';
      if (!integrationId) {
        throw new AppError(
          400,
          'INVALID_DATA_SOURCE_CONFIG',
          'integration data source requires a non-empty "integrationId" config field',
        );
      }
      const { integrations } = db.schema;
      const [row] = await db.drizzle
        .select()
        .from(integrations)
        .where(
          and(eq(integrations.id, integrationId), eq(integrations.companyId, companyId)),
        )
        .limit(1);
      if (!row) {
        throw new AppError(
          404,
          'DATA_SOURCE_INTEGRATION_NOT_FOUND',
          `Integration ${integrationId} not found in this company`,
        );
      }
      const data = {
        integrationId: row.id,
        name: row.name,
        type: row.type,
        provider: row.provider,
        status: row.status,
        healthStatus: row.healthStatus,
        config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
      };
      return { dataSourceId: source.id, type: source.type, data, resolvedAt };
    }
    default:
      throw new AppError(
        400,
        'INVALID_DATA_SOURCE_CONFIG',
        `Unknown data source type "${(source as { type: string }).type}"`,
      );
  }
}

/**
 * Fetch analytics data by directly querying the same tables the analytics
 * routes use. This keeps resolution server-side (no HTTP loopback) and
 * inherits the company scope passed in. The `suffix` is one of the
 * allowlisted analytics paths.
 */
async function fetchAnalyticsInternal(
  db: DbInstance,
  companyId: string,
  suffix: string,
): Promise<unknown> {
  const { agents, tasks, companies, costEvents } = db.schema;
  if (suffix === '/analytics/overview') {
    const [company] = await db.drizzle
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const agentRows = await db.drizzle.select().from(agents).where(eq(agents.companyId, companyId));
    const taskRows = await db.drizzle.select().from(tasks).where(eq(tasks.companyId, companyId));
    const agentsByStatus: Record<string, number> = {};
    for (const a of agentRows) {
      agentsByStatus[a.status] = (agentsByStatus[a.status] ?? 0) + 1;
    }
    const tasksByStatus: Record<string, number> = {};
    for (const t of taskRows) {
      tasksByStatus[t.status] = (tasksByStatus[t.status] ?? 0) + 1;
    }
    return {
      company: company ?? null,
      agents: { total: agentRows.length, byStatus: agentsByStatus },
      tasks: { total: taskRows.length, byStatus: tasksByStatus },
    };
  }
  if (suffix === '/analytics/agents') {
    const agentRows = await db.drizzle.select().from(agents).where(eq(agents.companyId, companyId));
    return agentRows.map((a) => ({
      agentId: a.id,
      name: a.name,
      role: a.role,
      status: a.status,
    }));
  }
  if (suffix === '/analytics/tasks') {
    const taskRows = await db.drizzle.select().from(tasks).where(eq(tasks.companyId, companyId));
    const byStatus: Record<string, number> = {};
    for (const t of taskRows) {
      byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
    }
    return { total: taskRows.length, byStatus };
  }
  if (suffix === '/analytics/costs') {
    const costRows = await db.drizzle
      .select()
      .from(costEvents)
      .where(eq(costEvents.companyId, companyId));
    const totalCents = costRows.reduce((sum, c) => sum + Number(c.costCents ?? 0), 0);
    return { totalCents, eventCount: costRows.length };
  }
  // Unreachable: allowlist check in the caller rejects unknown suffixes.
  throw new AppError(400, 'INVALID_DATA_SOURCE_CONFIG', `Unknown analytics path "${suffix}"`);
}
