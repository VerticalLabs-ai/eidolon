import { sql } from 'drizzle-orm';
import type { DbInstance } from '../types.js';

/**
 * A single dependency probe result.
 *
 * `ok` is deliberately the only detail exposed. Readiness is an unauthenticated
 * endpoint, so probe errors are never surfaced: a driver error string can carry
 * the database host, user, and port.
 */
export type ReadinessCheck = {
  name: string;
  ok: boolean;
  /** Wall-clock duration of the probe, rounded to whole milliseconds. */
  durationMs: number;
};

/**
 * Readiness is unauthenticated, so it carries only what a load balancer needs.
 * Circuit-breaker state is deliberately not included here; it is published on
 * the token-gated `/api/metrics` route instead, because circuit keys are
 * derived from tenant-registered endpoints.
 */
export type ReadinessReport = {
  status: 'ok' | 'degraded';
  timestamp: string;
  checks: ReadinessCheck[];
};

/**
 * Time budget for a single dependency probe. Readiness is polled by load
 * balancers and by the desktop companion, so it must answer quickly even when
 * the dependency is a black hole rather than a refused connection.
 */
const PROBE_TIMEOUT_MS = 2_000;

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Readiness probe timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function probeDatabase(db: DbInstance): Promise<ReadinessCheck> {
  const startedAt = process.hrtime.bigint();
  let ok = false;
  try {
    await withTimeout(db.drizzle.execute(sql`select 1`), PROBE_TIMEOUT_MS);
    ok = true;
  } catch {
    ok = false;
  }
  return {
    name: 'database',
    ok,
    durationMs: Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000),
  };
}

/**
 * Probe every required dependency and report whether this instance can serve
 * traffic. Unlike `/api/health`, which answers "the process is alive", this
 * answers "the process can do useful work" — the distinction an operator needs
 * when Postgres is unreachable but the event loop is fine.
 */
export async function checkReadiness(db: DbInstance): Promise<ReadinessReport> {
  const checks = [await probeDatabase(db)];
  return {
    status: checks.every((check) => check.ok) ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  };
}
