import * as Sentry from '@sentry/node';
import type { Request } from 'express';

let initialized = false;

export function initializeErrorTracking(): boolean {
  if (initialized) {
    return Boolean(Sentry.getClient());
  }

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return false;
  }

  const tracesSampleRate = Number.parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0');
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: process.env.SENTRY_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate:
      Number.isFinite(tracesSampleRate) && tracesSampleRate >= 0
        ? Math.min(tracesSampleRate, 1)
        : 0,
    sendDefaultPii: false,
  });
  initialized = true;
  return true;
}

export function captureServerError(error: Error, req: Request): void {
  if (!initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    scope.setTag('request_id', req.requestId ?? 'unknown');
    scope.setTag('trace_id', req.traceId ?? 'unknown');
    scope.setTag('route', req.route?.path?.toString() ?? req.path);
    if (req.user) {
      scope.setUser({ id: req.user.id });
    }
    scope.setContext('request', {
      method: req.method,
      path: req.path,
    });
    Sentry.captureException(error);
  });
}
