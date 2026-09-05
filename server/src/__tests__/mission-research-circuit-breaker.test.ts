import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, and, sql } from 'drizzle-orm';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { ResearchCircuitBreaker } from '../services/mission/research/circuit-breaker.js';
import {
  isProviderWideFailure,
  isTenantSpecificFailure,
} from '../services/mission/research/health-classification.js';
import type { ResearchProviderErrorCode } from '../services/mission/research/spi.js';

/**
 * Persistent circuit breaker tests.
 *
 * VAL-RES-013: Circuit state survives restart (Postgres-backed).
 * VAL-RES-014: Single half-open probe (row-lock-claimed, concurrent denial).
 * VAL-RES-015: Provider health privacy (no tenant data in health rows).
 * VAL-RES-109: Tenant failures cannot poison shared provider health.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  // Clean health table between tests.
  await db.drizzle.execute(sql`DELETE FROM "research_provider_health"`);
});

// ---------------------------------------------------------------------------
// Health classification (VAL-RES-109) — pure unit tests
// ---------------------------------------------------------------------------

describe('Health classification (VAL-RES-109)', () => {
  it('counts provider-wide transport/5xx and malformed-service failures', () => {
    expect(isProviderWideFailure('PROVIDER_TRANSIENT')).toBe(true);
    expect(isProviderWideFailure('MALFORMED_RESPONSE')).toBe(true);
  });

  it('does not count tenant-specific failures as provider-wide', () => {
    const tenantSpecific: ResearchProviderErrorCode[] = [
      'PROVIDER_CREDENTIAL_UNAVAILABLE',
      'PROVIDER_AUTHENTICATION_FAILED',
      'PROVIDER_QUOTA_EXCEEDED',
      'PROVIDER_RATE_LIMITED',
      'PROVIDER_TIMEOUT',
      'INVALID_REQUEST',
      'UNSUPPORTED_OPERATION',
      'POLICY_DENIED',
      'BUDGET_EXHAUSTED',
      'CANCELLED',
      'RESEARCH_NO_USABLE_SOURCES',
      'MISSING_CREDENTIAL',
      'PROVIDER_PERMANENT',
    ];
    for (const code of tenantSpecific) {
      expect(isProviderWideFailure(code)).toBe(false);
      expect(isTenantSpecificFailure(code)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Circuit transitions (VAL-RES-013)
// ---------------------------------------------------------------------------

describe('Circuit breaker transitions (VAL-RES-013)', () => {
  it('starts closed with zero failures', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 1_000_000,
      failureThreshold: 3,
    });
    const health = await cb.getHealth('tavily', 'search');
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.open).toBe(false);
  });

  it('opens after reaching the failure threshold with provider-wide failures', async () => {
    const now = 2_000_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => now,
      failureThreshold: 3,
      openDurationMs: 30_000,
    });

    // Two failures — not enough to open.
    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    let health = await cb.getHealth('tavily', 'search');
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(2);

    // Third failure — opens.
    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    health = await cb.getHealth('tavily', 'search');
    expect(health.state).toBe('open');
    expect(health.open).toBe(true);
    expect(health.retryAfterMs).toBeGreaterThan(0);
  });

  it('resets to closed on success', async () => {
    const now = 3_000_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => now,
      failureThreshold: 2,
      openDurationMs: 30_000,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    expect((await cb.getHealth('tavily', 'search')).state).toBe('open');

    // Success closes the circuit.
    await cb.recordSuccess('tavily', 'search', 150);
    const health = await cb.getHealth('tavily', 'search');
    expect(health.state).toBe('closed');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.open).toBe(false);
    expect(health.avgLatencyMs).toBe(150);
  });

  it('malformed-service failures also open the circuit', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 4_000_000,
      failureThreshold: 2,
      openDurationMs: 30_000,
    });

    await cb.recordFailure('firecrawl', 'scrape', 'MALFORMED_RESPONSE');
    await cb.recordFailure('firecrawl', 'scrape', 'MALFORMED_RESPONSE');
    const health = await cb.getHealth('firecrawl', 'scrape');
    expect(health.state).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (VAL-RES-109)
// ---------------------------------------------------------------------------

describe('Tenant failure isolation (VAL-RES-109)', () => {
  it('tenant credential failures do not increment shared health', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 5_000_000,
      failureThreshold: 3,
    });

    // Record many tenant-specific failures.
    for (let i = 0; i < 10; i++) {
      await cb.recordFailure('tavily', 'search', 'PROVIDER_CREDENTIAL_UNAVAILABLE');
    }
    const health = await cb.getHealth('tavily', 'search');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.state).toBe('closed');
  });

  it('401/403 auth failures do not increment shared health', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 5_000_000,
      failureThreshold: 2,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_AUTHENTICATION_FAILED');
    await cb.recordFailure('tavily', 'search', 'PROVIDER_AUTHENTICATION_FAILED');
    const health = await cb.getHealth('tavily', 'search');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.state).toBe('closed');
  });

  it('tenant quota/429 failures do not increment shared health', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 5_000_000,
      failureThreshold: 2,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_QUOTA_EXCEEDED');
    await cb.recordFailure('tavily', 'search', 'PROVIDER_RATE_LIMITED');
    const health = await cb.getHealth('tavily', 'search');
    expect(health.consecutiveFailures).toBe(0);
  });

  it('policy/input/cancellation/budget failures do not increment shared health', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 5_000_000,
      failureThreshold: 1,
    });

    const codes: ResearchProviderErrorCode[] = [
      'POLICY_DENIED',
      'INVALID_REQUEST',
      'UNSUPPORTED_OPERATION',
      'CANCELLED',
      'BUDGET_EXHAUSTED',
    ];
    for (const code of codes) {
      await cb.recordFailure('tavily', 'search', code);
    }
    const health = await cb.getHealth('tavily', 'search');
    expect(health.consecutiveFailures).toBe(0);
    expect(health.state).toBe('closed');
  });

  it('company-A credential failures do not block company-B (independent circuits)', async () => {
    // The circuit is per provider/operation, not per tenant. Tenant-specific
    // failures don't open it, so company-B succeeds even after company-A
    // had credential failures.
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 6_000_000,
      failureThreshold: 3,
    });

    // Company-A has credential failures.
    for (let i = 0; i < 10; i++) {
      await cb.recordFailure('tavily', 'search', 'PROVIDER_CREDENTIAL_UNAVAILABLE');
    }
    // Circuit is still closed — company-B can use the provider.
    expect(await cb.isOpen('tavily', 'search')).toBe(false);

    // Company-B succeeds.
    await cb.recordSuccess('tavily', 'search', 100);
    const health = await cb.getHealth('tavily', 'search');
    expect(health.state).toBe('closed');
    expect(health.lastSuccessAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Restart persistence (VAL-RES-013)
// ---------------------------------------------------------------------------

describe('Restart persistence (VAL-RES-013)', () => {
  it('circuit state survives restart (new service instance reads Postgres)', async () => {
    const now = 7_000_000;
    // First instance opens the circuit.
    const cb1 = new ResearchCircuitBreaker(db, {
      clock: () => now,
      failureThreshold: 2,
      openDurationMs: 60_000,
    });
    await cb1.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    await cb1.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    expect((await cb1.getHealth('tavily', 'search')).state).toBe('open');

    // Simulate restart: create a new instance. State is persisted.
    const cb2 = new ResearchCircuitBreaker(db, {
      clock: () => now + 1_000, // 1 second later
      failureThreshold: 2,
      openDurationMs: 60_000,
    });
    const health = await cb2.getHealth('tavily', 'search');
    expect(health.state).toBe('open');
    expect(health.open).toBe(true);
    expect(health.consecutiveFailures).toBe(2);
  });

  it('provider is not called while circuit is open after restart', async () => {
    const now = 8_000_000;
    const cb1 = new ResearchCircuitBreaker(db, {
      clock: () => now,
      failureThreshold: 1,
      openDurationMs: 60_000,
    });
    await cb1.recordFailure('firecrawl', 'scrape', 'PROVIDER_TRANSIENT');

    // New instance after restart.
    const cb2 = new ResearchCircuitBreaker(db, {
      clock: () => now + 5_000,
      failureThreshold: 1,
      openDurationMs: 60_000,
    });
    expect(await cb2.isOpen('firecrawl', 'scrape')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Single half-open probe (VAL-RES-014)
// ---------------------------------------------------------------------------

describe('Half-open probe (VAL-RES-014)', () => {
  it('transitions to half-open after open-until expires', async () => {
    const openDuration = 30_000;
    const startTime = 9_000_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => startTime,
      failureThreshold: 1,
      openDurationMs: openDuration,
      halfOpenLeaseMs: 30_000,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    expect((await cb.getHealth('tavily', 'search')).state).toBe('open');

    // After open-until, the effective state is half-open.
    cb['clock'] = () => startTime + openDuration + 1;
    const health = await cb.getHealth('tavily', 'search');
    expect(health.state).toBe('half_open');
  });

  it('exactly one concurrent caller claims the half-open probe', async () => {
    const openDuration = 30_000;
    const startTime = 10_000_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => startTime,
      failureThreshold: 1,
      openDurationMs: openDuration,
      halfOpenLeaseMs: 30_000,
    });

    // Open the circuit.
    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');

    // Advance past open-until.
    cb['clock'] = () => startTime + openDuration + 1;

    // Two concurrent claims.
    const [claim1, claim2] = await Promise.all([
      cb.claimHalfOpenProbe('tavily', 'search', 'worker-A'),
      cb.claimHalfOpenProbe('tavily', 'search', 'worker-B'),
    ]);

    // Exactly one wins.
    const claimed = [claim1, claim2].filter((c) => c.claimed);
    expect(claimed.length).toBe(1);
    const denied = [claim1, claim2].filter((c) => !c.claimed);
    expect(denied.length).toBe(1);
    expect(denied[0]!.owner).toBeNull();
  });

  it('probe success closes the circuit', async () => {
    const openDuration = 30_000;
    const startTime = 11_000_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => startTime,
      failureThreshold: 1,
      openDurationMs: openDuration,
      halfOpenLeaseMs: 30_000,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    cb['clock'] = () => startTime + openDuration + 1;

    const claim = await cb.claimHalfOpenProbe('tavily', 'search', 'worker-A');
    expect(claim.claimed).toBe(true);

    // Probe succeeds — circuit closes.
    await cb.recordSuccess('tavily', 'search', 200);
    const health = await cb.getHealth('tavily', 'search');
    expect(health.state).toBe('closed');
    expect(health.halfOpenProbeOwner).toBeNull();
  });

  it('probe failure reopens the circuit', async () => {
    const openDuration = 30_000;
    const startTime = 12_000_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => startTime,
      failureThreshold: 1,
      openDurationMs: openDuration,
      halfOpenLeaseMs: 30_000,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    cb['clock'] = () => startTime + openDuration + 1;

    const claim = await cb.claimHalfOpenProbe('tavily', 'search', 'worker-A');
    expect(claim.claimed).toBe(true);

    // Probe fails with a provider-wide failure — circuit reopens.
    cb['clock'] = () => startTime + openDuration + 2_000;
    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    const health = await cb.getHealth('tavily', 'search');
    expect(health.state).toBe('open');
    expect(health.halfOpenProbeOwner).toBeNull();
  });

  it('half-open probe lease has a 30-second fenced duration', async () => {
    const startTime = 13_000_000;
    const openDuration = 30_000;
    const halfOpenLease = 30_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => startTime,
      failureThreshold: 1,
      openDurationMs: openDuration,
      halfOpenLeaseMs: halfOpenLease,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    cb['clock'] = () => startTime + openDuration + 1;

    const claim = await cb.claimHalfOpenProbe('tavily', 'search', 'worker-X');
    expect(claim.claimed).toBe(true);

    // Verify the lease is set in the database.
    const schema = db.schema;
    const [row] = await db.drizzle
      .select()
      .from(schema.researchProviderHealth)
      .where(
        and(
          eq(schema.researchProviderHealth.provider, 'tavily'),
          eq(schema.researchProviderHealth.operation, 'search'),
        ),
      )
      .limit(1);

    expect(row!.halfOpenProbeOwner).toBe('worker-X');
    expect(row!.halfOpenProbeLeaseExpiresMs).toBe(startTime + openDuration + 1 + halfOpenLease);
  });

  it('crash/cancellation releases the probe lease (expireStale)', async () => {
    const startTime = 14_000_000;
    const openDuration = 30_000;
    const halfOpenLease = 30_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => startTime,
      failureThreshold: 1,
      openDurationMs: openDuration,
      halfOpenLeaseMs: halfOpenLease,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    cb['clock'] = () => startTime + openDuration + 1;

    await cb.claimHalfOpenProbe('tavily', 'search', 'worker-crash');

    // Simulate crash: advance past the lease expiry.
    cb['clock'] = () => startTime + openDuration + 1 + halfOpenLease + 1;

    const expired = await cb.expireStaleHalfOpenProbes();
    expect(expired).toBe(1);

    // A new worker can now claim the probe.
    const claim = await cb.claimHalfOpenProbe('tavily', 'search', 'worker-new');
    expect(claim.claimed).toBe(true);
  });

  it('explicit release allows a new claim', async () => {
    const startTime = 15_000_000;
    const openDuration = 30_000;
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => startTime,
      failureThreshold: 1,
      openDurationMs: openDuration,
      halfOpenLeaseMs: 30_000,
    });

    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    cb['clock'] = () => startTime + openDuration + 1;

    await cb.claimHalfOpenProbe('tavily', 'search', 'worker-A');
    await cb.releaseHalfOpenProbe('tavily', 'search', 'worker-A');

    // New claim succeeds.
    const claim = await cb.claimHalfOpenProbe('tavily', 'search', 'worker-B');
    expect(claim.claimed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Health privacy (VAL-RES-015)
// ---------------------------------------------------------------------------

describe('Provider health privacy (VAL-RES-015)', () => {
  it('health rows contain no tenant query, URL, content, user ID, or credential', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 16_000_000,
      failureThreshold: 1,
    });

    // Record various failures and successes.
    await cb.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    await cb.recordSuccess('tavily', 'search', 150);

    // Inspect the raw database row.
    const schema = db.schema;
    const [row] = await db.drizzle
      .select()
      .from(schema.researchProviderHealth)
      .where(
        and(
          eq(schema.researchProviderHealth.provider, 'tavily'),
          eq(schema.researchProviderHealth.operation, 'search'),
        ),
      )
      .limit(1);

    expect(row).toBeDefined();
    // Verify only bounded provider/operation/status/latency columns exist.
    const columns = Object.keys(row!);
    const forbidden = [
      'company_id',
      'companyId',
      'project_id',
      'projectId',
      'run_id',
      'runId',
      'user_id',
      'userId',
      'query',
      'url',
      'content',
      'text',
      'credential',
      'api_key',
      'apiKey',
      'token',
    ];
    for (const key of forbidden) {
      expect(columns).not.toContain(key);
    }
  });

  it('health snapshot contains only bounded provider/operation/status/latency data', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 17_000_000,
      failureThreshold: 1,
    });

    await cb.recordSuccess('firecrawl', 'scrape', 300);
    const snapshot = await cb.getHealth('firecrawl', 'scrape');

    // Verify the snapshot has only safe fields.
    const keys = Object.keys(snapshot);
    const allowedKeys = new Set([
      'provider',
      'operation',
      'state',
      'consecutiveFailures',
      'open',
      'retryAfterMs',
      'lastSuccessAt',
      'lastFailureAt',
      'avgLatencyMs',
      'halfOpenProbeOwner',
    ]);
    for (const key of keys) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // The provider and operation are safe labels, not tenant data.
    expect(snapshot.provider).toBe('firecrawl');
    expect(snapshot.operation).toBe('scrape');
    expect(snapshot.avgLatencyMs).toBe(300);
  });

  it('getAllHealth returns only privacy-safe snapshots', async () => {
    const cb = new ResearchCircuitBreaker(db, {
      clock: () => 18_000_000,
      failureThreshold: 1,
    });

    await cb.recordSuccess('tavily', 'search', 100);
    await cb.recordSuccess('firecrawl', 'scrape', 200);

    const all = await cb.getAllHealth();
    expect(all.length).toBe(2);

    // Each snapshot must be privacy-safe.
    for (const snap of all) {
      const keys = Object.keys(snap);
      expect(keys).not.toContain('companyId');
      expect(keys).not.toContain('query');
      expect(keys).not.toContain('url');
      expect(keys).not.toContain('credential');
    }
  });
});

it('persists real epoch-millisecond circuit and probe deadlines without overflow', async () => {
  const deadline = Date.now() + 60_000;
  await db.drizzle.insert(db.schema.researchProviderHealth).values({
    provider: 'tavily',
    operation: 'search',
    state: 'open',
    openUntilMs: deadline,
    halfOpenProbeLeaseExpiresMs: deadline + 30_000,
  });
  const [row] = await db.drizzle.select().from(db.schema.researchProviderHealth);
  expect(row.openUntilMs).toBe(deadline);
  expect(row.halfOpenProbeLeaseExpiresMs).toBe(deadline + 30_000);
});
