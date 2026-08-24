/**
 * Postgres-backed persistent circuit breaker for research provider health.
 *
 * (architecture.md: Provider Fallback and Health,
 *  VAL-RES-013, VAL-RES-014, VAL-RES-015, VAL-RES-109)
 *
 * Circuit state is persisted in `research_provider_health` so worker restart
 * does not erase health (VAL-RES-013). One row per (provider, operation).
 *
 * Transitions:
 *   closed  — requests pass; provider-wide failures increment the counter.
 *   open    — requests are blocked; `open_until_ms` is the deadline after
 *             which a half-open probe may be attempted. Fallback is used.
 *   half_open — exactly one caller may claim the probe via a row lock with
 *             a 30-second fenced lease (VAL-RES-014). Probe success closes
 *             the circuit; probe failure reopens it. Crash/cancellation
 *             releases or expires the lease so the circuit cannot remain
 *             permanently half-open.
 *
 * Privacy (VAL-RES-015): health rows and any derived output contain ONLY
 * bounded provider/operation/status/latency data. No tenant query, URL,
 * source text, user ID, company ID, run ID, or credential is stored or
 * returned.
 *
 * Tenant isolation (VAL-RES-109): only provider-wide failures (transport,
 * 5xx, malformed-service) increment the threshold. Tenant-specific failures
 * never affect shared health.
 *
 * Clocks are injectable for deterministic tests. Production origins and
 * policy decisions remain closed (not injectable).
 */

import { and, eq, gt, lt } from 'drizzle-orm';
import type { DbInstance } from '../../../types.js';
import { isProviderWideFailure } from './health-classification.js';
import {
  ResearchProviderError,
  type ResearchProviderErrorCode,
  type ResearchOperation,
} from './spi.js';
import type { ResearchProviderName } from './origins.js';

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

// ---------------------------------------------------------------------------
// Default sleep (real timer, abortable) — used by waitForProbeEligibility
// ---------------------------------------------------------------------------

function defaultCircuitSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default failure threshold before opening the circuit. */
export const DEFAULT_FAILURE_THRESHOLD = 5;

/** Default open duration in milliseconds (30 seconds). */
export const DEFAULT_OPEN_DURATION_MS = 30_000;

/** Default half-open probe lease duration in milliseconds (30 seconds). */
export const DEFAULT_HALF_OPEN_LEASE_MS = 30_000;

/** Default latency sample window size. */
export const DEFAULT_LATENCY_WINDOW = 100;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Circuit state values. */
export type CircuitState = 'closed' | 'open' | 'half_open';

/** Injectable dependencies for deterministic tests. */
export interface CircuitBreakerDeps {
  /** Clock function returning the current time as epoch milliseconds. */
  clock?: () => number;
  /** Failure threshold before opening. */
  failureThreshold?: number;
  /** Open duration in milliseconds. */
  openDurationMs?: number;
  /** Half-open probe lease duration in milliseconds. */
  halfOpenLeaseMs?: number;
  /** Latency sample window size. */
  latencyWindow?: number;
  /**
   * Injectable sleep function for `waitForProbeEligibility`. Production uses
   * a real timer-based sleep that respects AbortSignal. Tests inject an
   * instant no-op or a controllable mock.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Read-only health snapshot (privacy-safe: no tenant data). */
export interface ProviderHealthSnapshot {
  provider: ResearchProviderName;
  operation: ResearchOperation;
  state: CircuitState;
  consecutiveFailures: number;
  open: boolean;
  /** Milliseconds until a probe is allowed; 0 when closed. */
  retryAfterMs: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Average latency in milliseconds over the recent window, or null. */
  avgLatencyMs: number | null;
  halfOpenProbeOwner: string | null;
}

/** Result of a half-open probe claim. */
export interface HalfOpenProbeClaim {
  claimed: boolean;
  /** The lease owner identifier if claimed. */
  owner: string | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Postgres-backed persistent circuit breaker for research provider health.
 *
 * All mutations are atomic and use row-level locking. The service is
 * safe to call from multiple workers concurrently.
 */
export class ResearchCircuitBreaker {
  private clock: () => number;
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly halfOpenLeaseMs: number;
  private readonly latencyWindow: number;
  private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private db: DbInstance,
    deps: CircuitBreakerDeps = {},
  ) {
    this.clock = deps.clock ?? Date.now;
    this.failureThreshold = deps.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.openDurationMs = deps.openDurationMs ?? DEFAULT_OPEN_DURATION_MS;
    this.halfOpenLeaseMs = deps.halfOpenLeaseMs ?? DEFAULT_HALF_OPEN_LEASE_MS;
    this.latencyWindow = deps.latencyWindow ?? DEFAULT_LATENCY_WINDOW;
    this.sleepFn = deps.sleep ?? defaultCircuitSleep;
  }

  // -------------------------------------------------------------------------
  // Health queries
  // -------------------------------------------------------------------------

  /**
   * Returns a privacy-safe health snapshot for a provider/operation.
   * Creates the row if it does not exist (defaulting to closed).
   */
  async getHealth(
    provider: ResearchProviderName,
    operation: ResearchOperation,
  ): Promise<ProviderHealthSnapshot> {
    const schema = this.db.schema;
    const now = this.clock();

    const [row] = await this.db.drizzle
      .select()
      .from(schema.researchProviderHealth)
      .where(
        and(
          eq(schema.researchProviderHealth.provider, provider),
          eq(schema.researchProviderHealth.operation, operation),
        ),
      )
      .limit(1);

    if (!row) {
      // Row doesn't exist — circuit is closed by default.
      return {
        provider,
        operation,
        state: 'closed',
        consecutiveFailures: 0,
        open: false,
        retryAfterMs: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        avgLatencyMs: null,
        halfOpenProbeOwner: null,
      };
    }

    return this.rowToSnapshot(row, now);
  }

  /**
   * Returns all health snapshots (for metrics/observability).
   * Privacy-safe: no tenant data in any row.
   */
  async getAllHealth(): Promise<ProviderHealthSnapshot[]> {
    const schema = this.db.schema;
    const now = this.clock();

    const rows = await this.db.drizzle
      .select()
      .from(schema.researchProviderHealth)
      .orderBy(schema.researchProviderHealth.provider, schema.researchProviderHealth.operation);

    return rows.map((row) => this.rowToSnapshot(row, now));
  }

  /**
   * Returns true if the circuit is open (requests should be blocked).
   * Does not create a row if one does not exist.
   */
  async isOpen(provider: ResearchProviderName, operation: ResearchOperation): Promise<boolean> {
    const health = await this.getHealth(provider, operation);
    return health.open;
  }

  // -------------------------------------------------------------------------
  // Success / failure recording
  // -------------------------------------------------------------------------

  /**
   * Record a successful provider call. Resets consecutive failures, closes
   * the circuit, clears any half-open probe lease, and updates the latency
   * aggregate.
   *
   * @param latencyMs The call latency in milliseconds (for the aggregate).
   */
  async recordSuccess(
    provider: ResearchProviderName,
    operation: ResearchOperation,
    latencyMs?: number,
  ): Promise<void> {
    const schema = this.db.schema;
    const now = this.clock();
    const nowDate = new Date(now);

    await this.db.drizzle.transaction(async (tx) => {
      const row = await this.lockRow(tx, provider, operation);
      const current = row ?? (await this.createRow(tx, provider, operation, now));

      const newCount = current.latencyCount >= this.latencyWindow ? 1 : current.latencyCount + 1;
      const newSum =
        current.latencyCount >= this.latencyWindow
          ? (latencyMs ?? 0)
          : current.latencySumMs + (latencyMs ?? 0);

      await tx
        .update(schema.researchProviderHealth)
        .set({
          state: 'closed',
          consecutiveFailures: 0,
          openUntilMs: 0,
          lastSuccessAt: nowDate,
          halfOpenProbeOwner: null,
          halfOpenProbeLeaseExpiresMs: 0,
          latencyCount: newCount,
          latencySumMs: newSum,
          updatedAt: nowDate,
        })
        .where(eq(schema.researchProviderHealth.id, current.id));
    });
  }

  /**
   * Record a provider failure. Only provider-wide failures (transport, 5xx,
   * malformed-service) increment the shared threshold (VAL-RES-109).
   * Tenant-specific failures do NOT affect shared health.
   *
   * If the threshold is reached, the circuit opens with a bounded duration.
   *
   * @param code The classified error code.
   */
  async recordFailure(
    provider: ResearchProviderName,
    operation: ResearchOperation,
    code: ResearchProviderErrorCode,
  ): Promise<void> {
    // Tenant-specific failures never affect shared health (VAL-RES-109).
    if (!isProviderWideFailure(code)) {
      return;
    }

    const schema = this.db.schema;
    const now = this.clock();
    const nowDate = new Date(now);

    await this.db.drizzle.transaction(async (tx) => {
      const row = await this.lockRow(tx, provider, operation);
      const current = row ?? (await this.createRow(tx, provider, operation, now));

      const newConsecutive = current.consecutiveFailures + 1;
      const shouldOpen = newConsecutive >= this.failureThreshold;
      const openUntilMs = shouldOpen ? now + this.openDurationMs : current.openUntilMs;

      await tx
        .update(schema.researchProviderHealth)
        .set({
          state: shouldOpen ? 'open' : current.state === 'half_open' ? 'open' : current.state,
          consecutiveFailures: newConsecutive,
          openUntilMs,
          lastFailureAt: nowDate,
          // Clear any half-open probe lease on failure.
          halfOpenProbeOwner: null,
          halfOpenProbeLeaseExpiresMs: 0,
          updatedAt: nowDate,
        })
        .where(eq(schema.researchProviderHealth.id, current.id));
    });
  }

  // -------------------------------------------------------------------------
  // Half-open probe (VAL-RES-014)
  // -------------------------------------------------------------------------

  /**
   * Attempt to claim the half-open probe for a provider/operation.
   *
   * After the open-until deadline passes, the circuit transitions to
   * half-open. Exactly one caller may claim the probe via a row lock with
   * a 30-second fenced lease. Concurrent callers are denied (they should
   * fail over or wait according to policy).
   *
   * If a previous probe lease has expired (crash/cancellation), it may be
   * reclaimed.
   *
   * @param owner A safe caller identifier (e.g. worker ID). Never a lease
   *   token or tenant credential.
   * @returns `{ claimed: true, owner }` if this caller won the probe,
   *   `{ claimed: false, owner: null }` otherwise.
   */
  async claimHalfOpenProbe(
    provider: ResearchProviderName,
    operation: ResearchOperation,
    owner: string,
  ): Promise<HalfOpenProbeClaim> {
    const schema = this.db.schema;
    const now = this.clock();
    const nowDate = new Date(now);

    return this.db.drizzle.transaction(async (tx) => {
      const row = await this.lockRow(tx, provider, operation);
      const current = row ?? (await this.createRow(tx, provider, operation, now));

      // The circuit must be open and past the open-until deadline,
      // OR already half-open with an expired lease.
      const isPastOpenUntil = current.openUntilMs > 0 && current.openUntilMs <= now;
      const isHalfOpenWithExpiredLease =
        current.state === 'half_open' &&
        current.halfOpenProbeLeaseExpiresMs > 0 &&
        current.halfOpenProbeLeaseExpiresMs <= now;

      if (!isPastOpenUntil && !isHalfOpenWithExpiredLease) {
        return { claimed: false, owner: null };
      }

      // If already half-open with an active lease, deny.
      if (
        current.state === 'half_open' &&
        current.halfOpenProbeOwner !== null &&
        current.halfOpenProbeLeaseExpiresMs > now
      ) {
        return { claimed: false, owner: null };
      }

      // Claim the probe.
      const leaseExpiresMs = now + this.halfOpenLeaseMs;
      await tx
        .update(schema.researchProviderHealth)
        .set({
          state: 'half_open',
          halfOpenProbeOwner: owner,
          halfOpenProbeLeaseExpiresMs: leaseExpiresMs,
          updatedAt: nowDate,
        })
        .where(eq(schema.researchProviderHealth.id, current.id));

      return { claimed: true, owner };
    });
  }

  /**
   * Release a half-open probe lease (e.g. after the probe completes or is
   * cancelled). The caller must be the current lease owner.
   */
  async releaseHalfOpenProbe(
    provider: ResearchProviderName,
    operation: ResearchOperation,
    owner: string,
  ): Promise<void> {
    const schema = this.db.schema;
    const now = this.clock();
    const nowDate = new Date(now);

    await this.db.drizzle.transaction(async (tx) => {
      const row = await this.lockRow(tx, provider, operation);
      if (!row) {
        return;
      }

      // Only the current owner may release.
      if (row.halfOpenProbeOwner !== owner) {
        return;
      }

      await tx
        .update(schema.researchProviderHealth)
        .set({
          halfOpenProbeOwner: null,
          halfOpenProbeLeaseExpiresMs: 0,
          updatedAt: nowDate,
        })
        .where(eq(schema.researchProviderHealth.id, row.id));
    });
  }

  /**
   * Expire stale half-open probe leases whose lease has passed.
   * Called periodically (e.g. on every worker tick) so the circuit cannot
   * remain permanently half-open after a crash (VAL-RES-109).
   */
  async expireStaleHalfOpenProbes(): Promise<number> {
    const schema = this.db.schema;
    const now = this.clock();
    const nowDate = new Date(now);

    const result = await this.db.drizzle
      .update(schema.researchProviderHealth)
      .set({
        halfOpenProbeOwner: null,
        halfOpenProbeLeaseExpiresMs: 0,
        updatedAt: nowDate,
      })
      .where(
        and(
          eq(schema.researchProviderHealth.state, 'half_open'),
          gt(schema.researchProviderHealth.halfOpenProbeLeaseExpiresMs, 0),
          lt(schema.researchProviderHealth.halfOpenProbeLeaseExpiresMs, now),
        ),
      )
      .returning({ id: schema.researchProviderHealth.id });

    return result.length;
  }

  // -------------------------------------------------------------------------
  // Abortable wait (VAL-RES-094)
  // -------------------------------------------------------------------------

  /**
   * Wait for the circuit to become probe-eligible (closed or half-open
   * past the open-until deadline), respecting caller cancellation.
   *
   * When the circuit is open, sleeps for `retryAfterMs` using an abortable
   * sleep. If the AbortSignal fires during the wait, the wait is cleared
   * promptly and a `CANCELLED` error is thrown — no later provider attempt
   * or fallback may start (VAL-RES-094).
   *
   * When the circuit is already closed or probe-eligible, returns
   * immediately without sleeping.
   *
   * @param signal Optional AbortSignal for caller cancellation.
   * @throws ResearchProviderError('CANCELLED') if the signal aborts during
   *   the wait.
   */
  async waitForProbeEligibility(
    provider: ResearchProviderName,
    operation: ResearchOperation,
    signal?: AbortSignal,
  ): Promise<void> {
    // Check cancellation before any DB work.
    if (signal?.aborted) {
      throw new ResearchProviderError(
        'CANCELLED',
        'Research call cancelled before circuit wait',
        provider,
        operation,
      );
    }

    const health = await this.getHealth(provider, operation);

    // Circuit is closed or already probe-eligible — no wait needed.
    if (!health.open || health.retryAfterMs <= 0) {
      return;
    }

    // Circuit is open — sleep for the remaining open duration, respecting
    // cancellation.
    try {
      await this.sleepFn(health.retryAfterMs, signal);
    } catch {
      // Sleep was aborted — cancellation wins.
      throw new ResearchProviderError(
        'CANCELLED',
        'Research call cancelled during half-open circuit wait',
        provider,
        operation,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Lock the health row for a provider/operation using FOR UPDATE.
   * Returns the row or undefined if it doesn't exist.
   */
  private async lockRow(tx: Tx, provider: ResearchProviderName, operation: ResearchOperation) {
    const schema = this.db.schema;
    const [row] = await tx
      .select()
      .from(schema.researchProviderHealth)
      .where(
        and(
          eq(schema.researchProviderHealth.provider, provider),
          eq(schema.researchProviderHealth.operation, operation),
        ),
      )
      .for('update')
      .limit(1);
    return row;
  }

  /**
   * Create a new health row (closed, zero failures). Must be called inside
   * a transaction with the row lock already attempted.
   */
  private async createRow(
    tx: Tx,
    provider: ResearchProviderName,
    operation: ResearchOperation,
    now: number,
  ) {
    const schema = this.db.schema;
    const nowDate = new Date(now);
    const [row] = await tx
      .insert(schema.researchProviderHealth)
      .values({
        provider,
        operation,
        state: 'closed',
        consecutiveFailures: 0,
        openUntilMs: 0,
        latencyCount: 0,
        latencySumMs: 0,
        halfOpenProbeLeaseExpiresMs: 0,
        createdAt: nowDate,
        updatedAt: nowDate,
      })
      .returning();
    return row!;
  }

  /**
   * Convert a database row to a privacy-safe snapshot.
   */
  private rowToSnapshot(row: Record<string, unknown>, now: number): ProviderHealthSnapshot {
    const openUntilMs = row.openUntilMs as number;
    const isOpen = openUntilMs > now;
    const latencyCount = row.latencyCount as number;
    const latencySumMs = row.latencySumMs as number;

    // Determine effective state: if the row says 'open' but the deadline
    // has passed, the effective state is 'half_open' (probeable).
    const storedState = row.state as CircuitState;
    let effectiveState = storedState;
    if (storedState === 'open' && !isOpen) {
      effectiveState = 'half_open';
    }

    return {
      provider: row.provider as ResearchProviderName,
      operation: row.operation as ResearchOperation,
      state: effectiveState,
      consecutiveFailures: row.consecutiveFailures as number,
      open: isOpen && storedState !== 'half_open',
      retryAfterMs: Math.max(0, openUntilMs - now),
      lastSuccessAt: row.lastSuccessAt ? (row.lastSuccessAt as Date).toISOString() : null,
      lastFailureAt: row.lastFailureAt ? (row.lastFailureAt as Date).toISOString() : null,
      avgLatencyMs: latencyCount > 0 ? Math.round(latencySumMs / latencyCount) : null,
      halfOpenProbeOwner: (row.halfOpenProbeOwner as string | null) ?? null,
    };
  }
}
