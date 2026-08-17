import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import { sql } from 'drizzle-orm';
import client from 'prom-client';
import { getProviderCircuitSnapshot } from '../services/provider-circuit-breaker.js';
import type { DbInstance } from '../types.js';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      traceId?: string;
    }
  }
}

const register = new client.Registry();
client.collectDefaultMetrics({ register });

/**
 * Circuit-key prefixes emitted by `externalCircuitKey`. LLM provider circuits
 * are keyed by bare provider name and have no prefix.
 */
const CIRCUIT_KINDS = ['llm_provider', 'mcp', 'remote_runtime'] as const;

function circuitKind(circuitKey: string): string {
  const prefix = circuitKey.includes(':') ? circuitKey.split(':', 1)[0] : 'llm_provider';
  return (CIRCUIT_KINDS as readonly string[]).includes(prefix) ? prefix : 'other';
}

const requestCounter = new client.Counter({
  name: 'eidolon_http_requests_total',
  help: 'Total HTTP requests handled by the Eidolon server.',
  labelNames: ['method', 'route', 'status_code'] as const,
  registers: [register],
});

const requestDuration = new client.Histogram({
  name: 'eidolon_http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Open circuits, aggregated by dependency kind rather than by circuit.
 *
 * Per-circuit labels would grow with every tenant-registered MCP server and
 * remote runtime, so the label set is bounded to the fixed set of kinds. The
 * per-circuit detail stays on the authenticated operations surface.
 */
const openCircuits = new client.Gauge({
  name: 'eidolon_provider_circuits_open',
  help: 'Number of circuit breakers currently open, by dependency kind.',
  labelNames: ['kind'] as const,
  registers: [register],
  collect() {
    const counts = new Map<string, number>(CIRCUIT_KINDS.map((kind) => [kind, 0]));
    for (const circuit of getProviderCircuitSnapshot()) {
      if (!circuit.open) {
        continue;
      }
      const kind = circuitKind(circuit.provider);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    for (const [kind, count] of counts) {
      this.set({ kind }, count);
    }
  },
});

// ---------------------------------------------------------------------------
// Business metrics (DB-backed gauges)
//
// These gauges query the database on each scrape to report operationally
// useful counts. The DB reference is set via `setBusinessMetricsDb()` from
// `createApp`. When the DB is not yet wired (e.g. early in startup or in
// unit tests that don't exercise the metrics endpoint), the collect
// callbacks short-circuit and leave the gauges at zero.
// ---------------------------------------------------------------------------

let businessMetricsDb: DbInstance | null = null;

/**
 * Wire the database instance used by business-metric gauges. Called once
 * from `createApp` after the DB pool is available.
 */
export function setBusinessMetricsDb(db: DbInstance): void {
  businessMetricsDb = db;
}

/** Agent statuses tracked by the `eidolon_agents_by_status` gauge. */
const AGENT_STATUSES = ['idle', 'working', 'paused', 'error', 'offline'] as const;

/** Task statuses tracked by the `eidolon_tasks_by_status` gauge. */
const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
  'timed_out',
] as const;

const activeCompaniesGauge = new client.Gauge({
  name: 'eidolon_companies_active',
  help: 'Number of companies with status "active".',
  registers: [register],
  async collect() {
    if (!businessMetricsDb) {
      return;
    }
    try {
      const rows = (await businessMetricsDb.drizzle.execute(sql`
        SELECT count(*)::int AS count FROM companies WHERE status = 'active'
      `)) as unknown as Array<{ count: number }>;
      this.set(Number(rows[0]?.count ?? 0));
    } catch {
      // Leave the gauge at its last value on transient DB errors.
    }
  },
});

const agentsByStatusGauge = new client.Gauge({
  name: 'eidolon_agents_by_status',
  help: 'Number of agents, grouped by status.',
  labelNames: ['status'] as const,
  registers: [register],
  async collect() {
    if (!businessMetricsDb) {
      return;
    }
    try {
      const rows = (await businessMetricsDb.drizzle.execute(sql`
        SELECT status, count(*)::int AS count FROM agents GROUP BY status
      `)) as unknown as Array<{ status: string; count: number }>;
      const counts = new Map<string, number>(AGENT_STATUSES.map((s) => [s, 0]));
      for (const row of rows) {
        counts.set(row.status, Number(row.count));
      }
      for (const [status, count] of counts) {
        this.set({ status }, count);
      }
    } catch {
      // Leave the gauge at its last value on transient DB errors.
    }
  },
});

const tasksByStatusGauge = new client.Gauge({
  name: 'eidolon_tasks_by_status',
  help: 'Number of tasks, grouped by status.',
  labelNames: ['status'] as const,
  registers: [register],
  async collect() {
    if (!businessMetricsDb) {
      return;
    }
    try {
      const rows = (await businessMetricsDb.drizzle.execute(sql`
        SELECT status, count(*)::int AS count FROM tasks GROUP BY status
      `)) as unknown as Array<{ status: string; count: number }>;
      const counts = new Map<string, number>(TASK_STATUSES.map((s) => [s, 0]));
      for (const row of rows) {
        counts.set(row.status, Number(row.count));
      }
      for (const [status, count] of counts) {
        this.set({ status }, count);
      }
    } catch {
      // Leave the gauge at its last value on transient DB errors.
    }
  },
});

// Touch gauges so they are not tree-shaken in production builds.
void activeCompaniesGauge;
void agentsByStatusGauge;
void tasksByStatusGauge;

function safeRequestId(candidate: string | undefined): string {
  if (candidate && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}

function validTraceId(traceId: string): boolean {
  return /^[0-9a-f]{32}$/i.test(traceId) && !/^0+$/.test(traceId);
}

function createTraceId(): string {
  return randomUUID().replaceAll('-', '');
}

function traceContext(req: Request): { traceId: string; spanId: string } {
  const traceparent = req.get('traceparent');
  const match = traceparent?.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i);
  const traceId = match && validTraceId(match[1]) ? match[1].toLowerCase() : createTraceId();
  const spanId = randomUUID().replaceAll('-', '').slice(0, 16);
  return { traceId, spanId };
}

function routeLabel(req: Request): string {
  const route = req.route?.path;
  const path = typeof route === 'string' ? route : req.path;
  return path.length <= 160 ? path : `${path.slice(0, 157)}...`;
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = safeRequestId(req.get('x-request-id'));
  const { traceId, spanId } = traceContext(req);
  req.requestId = requestId;
  req.traceId = traceId;
  res.setHeader('X-Request-ID', requestId);
  res.setHeader('X-Trace-ID', traceId);
  res.setHeader('traceparent', `00-${traceId}-${spanId}-01`);
  next();
}

export function requestMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status_code: String(res.statusCode),
    };
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    requestCounter.inc(labels);
    requestDuration.observe(labels, seconds);
  });
  next();
}

function hasMetricsAccess(req: Request): boolean {
  const expected = process.env.METRICS_TOKEN;
  if (!expected) {
    return false;
  }

  const provided = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}

export function metricsRouter(): Router {
  const router = Router();
  router.get('/metrics', async (req, res, next) => {
    if (!hasMetricsAccess(req)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    try {
      res.type(register.contentType).send(await register.metrics());
    } catch (error) {
      next(error);
    }
  });
  return router;
}
