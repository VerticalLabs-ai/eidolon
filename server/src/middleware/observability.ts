import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import client from 'prom-client';

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
