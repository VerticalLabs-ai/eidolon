import { pgTable, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

/**
 * Persistent provider/operation circuit-breaker health.
 *
 * (architecture.md: Provider Fallback and Health, VAL-RES-013, VAL-RES-014,
 *  VAL-RES-015, VAL-RES-109)
 *
 * Circuit state is Postgres-backed so worker restart does not erase health.
 * One row per (provider, operation) pair. The row records closed/open/half_open
 * state, consecutive provider-wide failures, open-until deadline, last
 * success/failure timestamps, and a latency aggregate.
 *
 * Privacy (VAL-RES-015): this table holds ONLY bounded provider/operation/
 * status/latency data. It NEVER contains tenant queries, target URLs, source
 * text, user IDs, company IDs, run IDs, or credentials. Health is a
 * platform-level shared concern, not tenant-scoped.
 *
 * Tenant isolation (VAL-RES-109): only classified provider-wide transport,
 * 5xx, and malformed-service failures increment `consecutive_failures`.
 * Tenant-specific failures (missing/disabled/invalid credentials, 401/403,
 * tenant quota/429, policy/input/URL rejection, cancellation, budget denial)
 * never increment the global threshold.
 *
 * Half-open probe (VAL-RES-014): when `state = 'half_open'`, exactly one
 * caller may claim the probe via a row lock. The claim records a fenced
 * lease owner and a 30-second lease expiry. Crash/cancellation releases or
 * expires the lease so the circuit cannot remain permanently half-open.
 */
export const researchProviderHealth = pgTable(
  'research_provider_health',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Provider name (e.g. 'tavily', 'firecrawl'). */
    provider: text('provider').notNull(),
    /** Research operation (e.g. 'search', 'extract', 'scrape'). */
    operation: text('operation').notNull(),
    /** Circuit state: 'closed' | 'open' | 'half_open'. */
    state: text('state').notNull().default('closed'),
    /** Consecutive provider-wide failures (reset on success). */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    /**
     * Epoch-millis deadline after which a half-open probe may be attempted.
     * `0` when the circuit is closed. Stored as bigint to avoid date-math
     * ambiguity across driver modes.
     */
    openUntilMs: integer('open_until_ms').notNull().default(0),
    /** Last success timestamp (nullable until first success). */
    lastSuccessAt: timestamp('last_success_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }),
    /** Last failure timestamp (nullable until first failure). */
    lastFailureAt: timestamp('last_failure_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }),
    /**
     * Latency aggregate: running count and sum of recent success latencies
     * in milliseconds. Used to compute an average for metrics/observability.
     * Bounded to a window by the service layer.
     */
    latencyCount: integer('latency_count').notNull().default(0),
    latencySumMs: integer('latency_sum_ms').notNull().default(0),
    /**
     * Half-open probe fenced lease owner. Set when a caller claims the
     * probe via row lock; cleared on probe success/failure/release/expiry.
     * Never a tenant credential or lease token — a safe caller identifier.
     */
    halfOpenProbeOwner: text('half_open_probe_owner'),
    /**
     * Half-open probe lease expiry (epoch-millis). A stale lease (now >
     * expiry) may be reclaimed. 30-second default set by the service.
     */
    halfOpenProbeLeaseExpiresMs: integer('half_open_probe_lease_expires_ms').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_research_provider_health_provider_operation').on(
      table.provider,
      table.operation,
    ),
    index('idx_research_provider_health_state').on(table.state),
  ],
);
