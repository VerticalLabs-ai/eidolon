import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import {
  ResearchPricingService,
  convertCreditsToCents,
  type PricingTableEntry,
} from '../services/mission/research/pricing.js';
import { ResearchAttemptAccountingService } from '../services/mission/research/research-attempt-accounting.js';
import { SourceAvailabilityService } from '../services/mission/research/source-availability-service.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Research attempt accounting: reserve, settle, charge, and release every
 * research attempt exactly once.
 *
 * VAL-RES-064: Research budget preflight.
 * VAL-RES-065: In-flight budget reservation.
 * VAL-RES-066: Provider credits settled exactly once.
 * VAL-RES-067: Fallback attempts separately charged.
 * VAL-RES-068: Budget exhaustion blocks fallback.
 * VAL-RES-069: Unknown price is not free.
 * VAL-RES-070: Unused research budget released.
 * VAL-RES-110: Unknown paid attempts remain budget safe.
 * VAL-RES-119: Source availability refresh is explicit and nonmutating.
 *
 * All persistence tests use real Postgres on 127.0.0.1:55322. No mocks for
 * persistence, transactions, locking, or settlement idempotency.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

async function seedScope(
  db: AnyDb,
  label: string,
  opts: { companyBudget?: number; companySpent?: number } = {},
) {
  const companyId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', ${opts.companyBudget ?? 100000}, ${opts.companySpent ?? 0}, '{"testFixture": true}'::jsonb, ${now}, ${now})
  `);
  const projectId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${projectId}, ${companyId}, 'P', 'active', ${now}, ${now})
  `);
  const threadId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, 'T', 'conversation', 'active', ${now}, ${now})
  `);
  return { companyId, projectId, threadId };
}

async function seedRootRun(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  opts: { reservedCents?: number; billingAgentId?: string | null } = {},
): Promise<{ runId: string; reservationId: string; allocationId: string }> {
  const runId = randomUUID();
  const reservationId = randomUUID();
  const allocationId = randomUUID();
  const now = new Date();
  const reserved = opts.reservedCents ?? 1000;

  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "billing_agent_id", "created_at", "updated_at")
    VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, NULL, 0, 'company_agent', 'enc', 'hash', 'Root', 'deep_work', 'running', 1, 0, 'require_all', NULL, ${opts.billingAgentId ?? null}, ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${scope.companyId}, ${runId}, ${opts.billingAgentId ?? null}, ${reserved}, ${reserved}, 0, 0, '2026-08', 'held', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${allocationId}, ${scope.companyId}, ${reservationId}, ${runId}, ${opts.billingAgentId ?? null}, ${reserved}, 0, 0, 'held', ${now}, ${now})
  `);
  return { runId, reservationId, allocationId };
}

function hashRequestId(id: string): string {
  return createHash('sha256').update(id, 'utf8').digest('hex');
}

function makePricingEntry(
  provider: 'tavily' | 'firecrawl',
  operation: 'search' | 'extract' | 'scrape' | 'structured_extract',
  opts: { conservativeMax?: number; priceNumerator?: string; priceDenominator?: string } = {},
): PricingTableEntry {
  return {
    provider,
    operation,
    pricingTableVersion: '2026-08-v1',
    currency: 'USD',
    unitDefinition: {
      unit: 'credit',
      priceNumerator: opts.priceNumerator ?? '10',
      priceDenominator: opts.priceDenominator ?? '1',
    },
    roundingRule: 'round_half_up',
    conservativeUnknownPriceCents: opts.conservativeMax ?? 50,
  };
}

function makeSource(url: string): NormalizedResearchSource {
  return {
    canonicalUrl: url,
    title: 'Example',
    retrievedAt: new Date().toISOString(),
    injectionRiskLabels: [],
    contentHash: createHash('sha256').update(url, 'utf8').digest('hex'),
    byteCount: 100,
  };
}

async function seedSourceRevision(
  db: AnyDb,
  scope: { companyId: string; projectId: string },
  runId: string,
): Promise<string> {
  const svc = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
  const result = await svc.persistSourceRevision({
    companyId: scope.companyId,
    projectId: scope.projectId,
    runId,
    rootRunId: runId,
    logicalCallId: randomUUID(),
    provider: 'tavily',
    operation: 'search',
    source: makeSource('https://example.com/source-1'),
  });
  return result.sourceRevisionId;
}

// ---------------------------------------------------------------------------
// VAL-RES-064: Research budget preflight
// ---------------------------------------------------------------------------

describe('VAL-RES-064: Research budget preflight', () => {
  it('fails before dispatch when the ceiling cannot cover the conservative estimate', async () => {
    const scope = await seedScope(db, '__mtest__ preflight');
    const run = await seedRootRun(db, scope, { reservedCents: 100 });

    const accounting = new ResearchAttemptAccountingService(db);
    await expect(
      db.drizzle.transaction(async (tx) => accounting.preflight(tx, run.runId, 200)),
    ).rejects.toMatchObject({ status: 409, code: 'BUDGET_UNAVAILABLE' });
  });

  it('passes preflight when the ceiling covers the conservative estimate', async () => {
    const scope = await seedScope(db, '__mtest__ preflight-ok');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const state = await db.drizzle.transaction(async (tx) =>
      accounting.preflight(tx, run.runId, 100),
    );
    expect(state.remainingCents).toBeGreaterThanOrEqual(100);
  });

  it('leaves zero provider attempts/credits and unchanged spend on denial', async () => {
    const scope = await seedScope(db, '__mtest__ preflight-noeffect');
    const run = await seedRootRun(db, scope, { reservedCents: 50 });

    const accounting = new ResearchAttemptAccountingService(db);
    await expect(
      db.drizzle.transaction(async (tx) => accounting.preflight(tx, run.runId, 500)),
    ).rejects.toMatchObject({ code: 'BUDGET_UNAVAILABLE' });

    const attempts = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n" FROM "research_attempts" WHERE "run_id" = ${run.runId}
    `)) as unknown as { n: number }[];
    expect(attempts[0]!.n).toBe(0);

    const [alloc] = (await db.drizzle.execute(sql`
      SELECT "settled_cents", "released_cents" FROM "budget_allocations" WHERE "run_id" = ${run.runId}
    `)) as unknown as { settled_cents: number; released_cents: number }[];
    expect(alloc.settled_cents).toBe(0);
    expect(alloc.released_cents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-065: In-flight budget reservation
// ---------------------------------------------------------------------------

describe('VAL-RES-065: In-flight budget reservation', () => {
  it('reserves an in-flight hold within the allocation', async () => {
    const scope = await seedScope(db, '__mtest__ inflight-ok');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const result = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: randomUUID(),
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 300,
      }),
    );
    expect(result.attemptId).toBeTruthy();
    expect(result.remainingCents).toBe(700);
  });

  it('combined reserved + settled never exceeds the allocation or root hold', async () => {
    const scope = await seedScope(db, '__mtest__ inflight-cap');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = randomUUID();
    // Reserve 600 in-flight.
    await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 600,
      }),
    );
    // A second 500 reservation would exceed the 1000 allocation (600 in-flight + 500 > 1000).
    await expect(
      db.drizzle.transaction(async (tx) =>
        accounting.reserveInFlight(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          runId: run.runId,
          rootRunId: run.runId,
          logicalCallId: randomUUID(),
          attemptOrdinal: 2,
          provider: 'tavily',
          operation: 'search',
          reservedCents: 500,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });

  it('two concurrent calls competing for the same remaining allocation: only fully-covered one dispatches', async () => {
    const scope = await seedScope(db, '__mtest__ inflight-race');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callA = randomUUID();
    const callB = randomUUID();

    // Run two reservations concurrently; both want 700, only one fits.
    const [r1, r2] = await Promise.allSettled([
      db.drizzle.transaction(async (tx) =>
        accounting.reserveInFlight(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          runId: run.runId,
          rootRunId: run.runId,
          logicalCallId: callA,
          attemptOrdinal: 1,
          provider: 'tavily',
          operation: 'search',
          reservedCents: 700,
        }),
      ),
      db.drizzle.transaction(async (tx) =>
        accounting.reserveInFlight(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          runId: run.runId,
          rootRunId: run.runId,
          logicalCallId: callB,
          attemptOrdinal: 1,
          provider: 'tavily',
          operation: 'search',
          reservedCents: 700,
        }),
      ),
    ]);

    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Verify the allocation invariant holds.
    const state = await db.drizzle.transaction(async (tx) =>
      accounting.getAllocationState(tx, run.runId, false),
    );
    expect(state.settledCents + state.releasedCents + state.inFlightCents).toBeLessThanOrEqual(
      state.allocatedCents,
    );
    expect(state.inFlightCents).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-066: Provider credits settled exactly once
// ---------------------------------------------------------------------------

describe('VAL-RES-066: Provider credits settled exactly once', () => {
  it('produces one immutable settlement keyed to the external call id', async () => {
    const scope = await seedScope(db, '__mtest__ settle-once');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const pricing = new ResearchPricingService(db);
    const callId = randomUUID();
    const externalCallId = `ext-${callId}`;

    const entry = makePricingEntry('tavily', 'search', {
      priceNumerator: '10',
      priceDenominator: '1',
    });
    const reportedCredits = 5; // 5 credits * 10 = 50 cents
    const snapshot = await pricing.snapshotPricing(entry, reportedCredits);
    const costCents = convertCreditsToCents(
      reportedCredits,
      entry.unitDefinition,
      entry.roundingRule,
    );

    const attemptId = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 300,
      }),
    );

    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, attemptId.attemptId);
      await accounting.settleAttempt(tx, attemptId.attemptId, {
        externalCallId,
        reportedCredits,
        providerRequestIdHash: hashRequestId('tavily-req-1'),
        pricingSnapshotId: snapshot.id,
        costCents,
      });
    });

    // Replay settlement → returns original, no duplicate.
    const replay = await db.drizzle.transaction(async (tx) =>
      accounting.settleAttempt(tx, attemptId.attemptId, {
        externalCallId,
        reportedCredits,
        providerRequestIdHash: hashRequestId('tavily-req-1'),
        pricingSnapshotId: snapshot.id,
        costCents,
      }),
    );
    expect(replay.replayed).toBe(true);
    expect(replay.costCents).toBe(costCents);

    // Exactly one settlement row.
    const settlements = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n" FROM "budget_settlements" WHERE "external_call_id" = ${externalCallId}
    `)) as unknown as { n: number }[];
    expect(settlements[0]!.n).toBe(1);

    // Spend counters incremented exactly once.
    const [company] = (await db.drizzle.execute(sql`
      SELECT "spent_monthly_cents" FROM "companies" WHERE "id" = ${scope.companyId}
    `)) as unknown as { spent_monthly_cents: number }[];
    expect(company.spent_monthly_cents).toBe(costCents);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-067: Fallback attempts separately charged
// ---------------------------------------------------------------------------

describe('VAL-RES-067: Fallback attempts separately charged', () => {
  it('each charged attempt has its own settlement/request-id hash/credits; logical call counted once', async () => {
    const scope = await seedScope(db, '__mtest__ fallback-separate');
    const run = await seedRootRun(db, scope, { reservedCents: 2000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const pricing = new ResearchPricingService(db);
    const logicalCallId = randomUUID();

    // Attempt 1: tavily, fails (charged 30 cents for the partial call).
    const entry1 = makePricingEntry('tavily', 'search');
    const snap1 = await pricing.snapshotPricing(entry1, 3);
    const cost1 = convertCreditsToCents(3, entry1.unitDefinition, entry1.roundingRule);

    const a1 = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 100,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a1.attemptId);
      await accounting.settleAttempt(tx, a1.attemptId, {
        externalCallId: `ext-${logicalCallId}-1`,
        reportedCredits: 3,
        providerRequestIdHash: hashRequestId('tavily-req-fail'),
        pricingSnapshotId: snap1.id,
        costCents: cost1,
      });
    });

    // Attempt 2: firecrawl fallback, succeeds (charged 50 cents).
    const entry2 = makePricingEntry('firecrawl', 'search');
    const snap2 = await pricing.snapshotPricing(entry2, 5);
    const cost2 = convertCreditsToCents(5, entry2.unitDefinition, entry2.roundingRule);

    const a2 = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId,
        attemptOrdinal: 2,
        provider: 'firecrawl',
        operation: 'search',
        reservedCents: 100,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a2.attemptId);
      await accounting.settleAttempt(tx, a2.attemptId, {
        externalCallId: `ext-${logicalCallId}-2`,
        reportedCredits: 5,
        providerRequestIdHash: hashRequestId('firecrawl-req-ok'),
        pricingSnapshotId: snap2.id,
        costCents: cost2,
      });
    });

    // Two attempt rows under one logical call.
    const attempts = (await db.drizzle.execute(sql`
      SELECT "provider", "attempt_ordinal", "provider_request_id_hash", "settled_cents"
      FROM "research_attempts" WHERE "logical_call_id" = ${logicalCallId}
      ORDER BY "attempt_ordinal"
    `)) as unknown as {
      provider: string;
      attempt_ordinal: number;
      provider_request_id_hash: string;
      settled_cents: number;
    }[];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.provider).toBe('tavily');
    expect(attempts[1]!.provider).toBe('firecrawl');
    expect(attempts[0]!.provider_request_id_hash).not.toBe(attempts[1]!.provider_request_id_hash);

    // Two settlements, one per charged attempt.
    const settlements = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n", COALESCE(SUM("cost_cents"),0)::int AS "total"
      FROM "budget_settlements" WHERE "run_id" = ${run.runId}
    `)) as unknown as { n: number; total: number }[];
    expect(settlements[0]!.n).toBe(2);
    expect(settlements[0]!.total).toBe(cost1 + cost2);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-068: Budget exhaustion blocks fallback
// ---------------------------------------------------------------------------

describe('VAL-RES-068: Budget exhaustion blocks fallback', () => {
  it('does not dispatch fallback without a sufficient new in-flight reservation', async () => {
    const scope = await seedScope(db, '__mtest__ exhaust-fallback');
    const run = await seedRootRun(db, scope, { reservedCents: 400 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = randomUUID();

    // Preferred provider attempt consumes most of the allocation, then fails.
    const a1 = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 350,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a1.attemptId);
      await accounting.markFailed(tx, a1.attemptId, 'PROVIDER_PERMANENT', 'failed');
    });

    // Fallback needs 100 but only 50 remains (400 - 350 released... wait,
    // failed releases the 350). After failure, remaining is 400 again.
    // To test exhaustion, settle a charge instead of failing.
    const callId2 = randomUUID();
    const a2 = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId2,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 350,
      }),
    );
    const pricing = new ResearchPricingService(db);
    const entry = makePricingEntry('tavily', 'search');
    const snap = await pricing.snapshotPricing(entry, 35);
    const cost = convertCreditsToCents(35, entry.unitDefinition, entry.roundingRule);
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a2.attemptId);
      await accounting.settleAttempt(tx, a2.attemptId, {
        externalCallId: `ext-${callId2}-1`,
        reportedCredits: 35,
        pricingSnapshotId: snap.id,
        costCents: cost,
      });
    });

    // Now remaining is 400 - 350 = 50. A fallback needing 100 must be blocked.
    const available = await db.drizzle.transaction(async (tx) =>
      accounting.checkBudgetAvailable(tx, run.runId, 100),
    );
    expect(available).toBe(false);

    await expect(
      db.drizzle.transaction(async (tx) =>
        accounting.reserveInFlight(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          runId: run.runId,
          rootRunId: run.runId,
          logicalCallId: randomUUID(),
          attemptOrdinal: 1,
          provider: 'firecrawl',
          operation: 'search',
          reservedCents: 100,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });

    // No firecrawl attempts were created.
    const fbAttempts = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n" FROM "research_attempts"
      WHERE "run_id" = ${run.runId} AND "provider" = 'firecrawl'
    `)) as unknown as { n: number }[];
    expect(fbAttempts[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-069: Unknown price is not free
// ---------------------------------------------------------------------------

describe('VAL-RES-069: Unknown price is not free', () => {
  it('reserves and charges the configured conservative maximum when price is unknown', async () => {
    const scope = await seedScope(db, '__mtest__ unknown-price');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = randomUUID();
    const conservativeMax = 75;

    // Reserve the conservative maximum (unknown price is never free).
    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'structured_extract',
        reservedCents: conservativeMax,
      }),
    );
    expect(a.remainingCents).toBe(1000 - conservativeMax);

    // Mark unknown: conservatively settle the maximum.
    const result = await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a.attemptId);
      return accounting.markUnknown(tx, a.attemptId, {
        externalCallId: `ext-${callId}-unknown`,
        conservativeMaxCents: conservativeMax,
      });
    });
    expect(result.costCents).toBe(conservativeMax);
    expect(result.replayed).toBe(false);

    // A settlement exists for the conservative amount — never zero.
    const [settlement] = (await db.drizzle.execute(sql`
      SELECT "cost_cents" FROM "budget_settlements" WHERE "external_call_id" = ${`ext-${callId}-unknown`}
    `)) as unknown as { cost_cents: number }[];
    expect(settlement.cost_cents).toBe(conservativeMax);
    expect(settlement.cost_cents).toBeGreaterThan(0);
  });

  it('rejects before dispatch when the conservative maximum cannot be covered', async () => {
    const scope = await seedScope(db, '__mtest__ unknown-price-reject');
    const run = await seedRootRun(db, scope, { reservedCents: 40 });

    const accounting = new ResearchAttemptAccountingService(db);
    await expect(
      db.drizzle.transaction(async (tx) =>
        accounting.reserveInFlight(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          runId: run.runId,
          rootRunId: run.runId,
          logicalCallId: randomUUID(),
          attemptOrdinal: 1,
          provider: 'tavily',
          operation: 'structured_extract',
          reservedCents: 75, // conservative max exceeds allocation
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-070: Unused research budget released
// ---------------------------------------------------------------------------

describe('VAL-RES-070: Unused research budget released', () => {
  it('releases all unused in-flight and allocation amounts on completion while known charges remain settled', async () => {
    const scope = await seedScope(db, '__mtest__ release-completion');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const pricing = new ResearchPricingService(db);
    const callId = randomUUID();

    const entry = makePricingEntry('tavily', 'search');
    const snap = await pricing.snapshotPricing(entry, 4);
    const cost = convertCreditsToCents(4, entry.unitDefinition, entry.roundingRule);

    // Settle one attempt (40 cents), leave another in-flight (cancelled at release).
    const a1 = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 200,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a1.attemptId);
      await accounting.settleAttempt(tx, a1.attemptId, {
        externalCallId: `ext-${callId}-1`,
        reportedCredits: 4,
        pricingSnapshotId: snap.id,
        costCents: cost,
      });
    });

    const a2 = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: randomUUID(),
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 300,
      }),
    );
    await db.drizzle.transaction(async (tx) => accounting.markStarted(tx, a2.attemptId));

    // Release residuals on completion.
    await db.drizzle.transaction(async (tx) =>
      accounting.releaseRunResiduals(tx, scope.companyId, run.runId),
    );

    const state = await db.drizzle.transaction(async (tx) =>
      accounting.getAllocationState(tx, run.runId, false),
    );
    // settled + released <= reserved (allocated).
    expect(state.settledCents + state.releasedCents).toBeLessThanOrEqual(state.allocatedCents);
    expect(state.inFlightCents).toBe(0);
    expect(state.settledCents).toBe(cost);
    // The remaining 960 cents are released.
    expect(state.releasedCents).toBe(1000 - cost);
  });

  it('releases residuals on cancellation while known charges remain settled', async () => {
    const scope = await seedScope(db, '__mtest__ release-cancel');
    const run = await seedRootRun(db, scope, { reservedCents: 500 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = randomUUID();

    // One in-flight attempt, no settlement.
    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 200,
      }),
    );
    await db.drizzle.transaction(async (tx) => accounting.markStarted(tx, a.attemptId));

    await db.drizzle.transaction(async (tx) =>
      accounting.releaseRunResiduals(tx, scope.companyId, run.runId),
    );

    const state = await db.drizzle.transaction(async (tx) =>
      accounting.getAllocationState(tx, run.runId, false),
    );
    expect(state.settledCents).toBe(0);
    expect(state.inFlightCents).toBe(0);
    expect(state.releasedCents).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-110: Unknown paid attempts remain budget safe
// ---------------------------------------------------------------------------

describe('VAL-RES-110: Unknown paid attempts remain budget safe', () => {
  it('records every physical attempt with state; pre-dispatch failure releases its reservation', async () => {
    const scope = await seedScope(db, '__mtest__ predisp-fail');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = randomUUID();

    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 200,
      }),
    );
    // Pre-dispatch failure (still prepared) → release reservation.
    await db.drizzle.transaction(async (tx) => accounting.markFailed(tx, a.attemptId, 'CANCELLED'));

    const [row] = (await db.drizzle.execute(sql`
      SELECT "state", "settled_cents" FROM "research_attempts" WHERE "id" = ${a.attemptId}
    `)) as unknown as { state: string; settled_cents: number }[];
    expect(row.state).toBe('failed');
    expect(row.settled_cents).toBe(0);

    // Reservation released back to remaining.
    const state = await db.drizzle.transaction(async (tx) =>
      accounting.getAllocationState(tx, run.runId, false),
    );
    expect(state.inFlightCents).toBe(0);
    expect(state.remainingCents).toBe(1000);
  });

  it('post-dispatch connection loss preserves unknown, never fabricates zero cost or an id', async () => {
    const scope = await seedScope(db, '__mtest__ unknown-effect');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = randomUUID();
    const conservativeMax = 60;

    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: conservativeMax,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a.attemptId);
      await accounting.markUnknown(tx, a.attemptId, {
        externalCallId: `ext-${callId}-unknown`,
        conservativeMaxCents: conservativeMax,
      });
    });

    const [row] = (await db.drizzle.execute(sql`
      SELECT "state", "settled_cents", "provider_request_id_hash"
      FROM "research_attempts" WHERE "id" = ${a.attemptId}
    `)) as unknown as {
      state: string;
      settled_cents: number;
      provider_request_id_hash: string | null;
    }[];
    expect(row.state).toBe('unknown');
    expect(row.settled_cents).toBe(conservativeMax);
    // No fabricated provider request id hash.
    expect(row.provider_request_id_hash).toBeNull();
  });

  it('a retry reserves separately and starts only when budget covers both uncertain and new attempts', async () => {
    const scope = await seedScope(db, '__mtest__ retry-reserve');
    const run = await seedRootRun(db, scope, { reservedCents: 200 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = randomUUID();
    const conservativeMax = 150;

    // First attempt ends unknown (conservatively charged 150).
    const a1 = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: conservativeMax,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a1.attemptId);
      await accounting.markUnknown(tx, a1.attemptId, {
        externalCallId: `ext-${callId}-1`,
        conservativeMaxCents: conservativeMax,
      });
    });

    // Remaining is 50. A retry needing 100 must be blocked.
    expect(
      await db.drizzle.transaction(async (tx) =>
        accounting.checkBudgetAvailable(tx, run.runId, 100),
      ),
    ).toBe(false);

    await expect(
      db.drizzle.transaction(async (tx) =>
        accounting.reserveInFlight(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          runId: run.runId,
          rootRunId: run.runId,
          logicalCallId: callId,
          attemptOrdinal: 2,
          provider: 'tavily',
          operation: 'search',
          reservedCents: 100,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
  });

  it('recovery does not fabricate a duplicate charge for an already-unknown attempt', async () => {
    const scope = await seedScope(db, '__mtest__ unknown-replay');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = randomUUID();
    const conservativeMax = 70;
    const externalCallId = `ext-${callId}-unknown`;

    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: conservativeMax,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a.attemptId);
      await accounting.markUnknown(tx, a.attemptId, {
        externalCallId,
        conservativeMaxCents: conservativeMax,
      });
    });

    // Recovery replay → same result, no duplicate settlement.
    const replay = await db.drizzle.transaction(async (tx) =>
      accounting.markUnknown(tx, a.attemptId, {
        externalCallId,
        conservativeMaxCents: conservativeMax,
      }),
    );
    expect(replay.replayed).toBe(true);

    const settlements = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n" FROM "budget_settlements" WHERE "external_call_id" = ${externalCallId}
    `)) as unknown as { n: number }[];
    expect(settlements[0]!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-066 (credit conversion) + VAL-RES-120 (recompute)
// ---------------------------------------------------------------------------

describe('Credit conversion and exact-once settlement arithmetic', () => {
  it('converts reported credits through the pricing snapshot to integer cents', async () => {
    const scope = await seedScope(db, '__mtest__ credit-convert');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const pricing = new ResearchPricingService(db);
    const callId = randomUUID();

    // 1 credit = 1/7 cents. 21 credits = 3 cents.
    const entry = makePricingEntry('tavily', 'search', {
      priceNumerator: '1',
      priceDenominator: '7',
    });
    const snap = await pricing.snapshotPricing(entry, 21);
    const cost = convertCreditsToCents(21, entry.unitDefinition, entry.roundingRule);
    expect(cost).toBe(3);

    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 100,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a.attemptId);
      await accounting.settleAttempt(tx, a.attemptId, {
        externalCallId: `ext-${callId}`,
        reportedCredits: 21,
        pricingSnapshotId: snap.id,
        costCents: cost,
      });
    });

    // Recompute from the snapshot matches the stored cents.
    expect(await pricing.verifySnapshot(snap.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-119: Source availability refresh is explicit and nonmutating
// ---------------------------------------------------------------------------

describe('VAL-RES-119: Source availability refresh is explicit and nonmutating', () => {
  it('records an availability check linked to the immutable revision without mutating it', async () => {
    const scope = await seedScope(db, '__mtest__ avail-nonmutating');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const sourceRevisionId = await seedSourceRevision(db, scope, run.runId);

    // Snapshot the revision before the check.
    const before = (await db.drizzle.execute(sql`
      SELECT "content_hash", "byte_count", "status", "retrieved_at"
      FROM "research_source_revisions" WHERE "id" = ${sourceRevisionId}
    `)) as unknown as {
      content_hash: string | null;
      byte_count: number;
      status: string;
      retrieved_at: Date;
    }[];
    expect(before.length).toBe(1);

    const svc = new SourceAvailabilityService(db);
    const result = await svc.recordAvailabilityCheck({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: run.runId,
      rootRunId: run.runId,
      sourceRevisionId,
      logicalCallId: `${run.runId}:availability:1`,
      idempotencyKey: 'avail-key-1',
      status: 'available',
      httpStatus: 200,
    });
    expect(result.replayed).toBe(false);
    expect(result.status).toBe('available');

    // The revision is unchanged.
    const after = (await db.drizzle.execute(sql`
      SELECT "content_hash", "byte_count", "status", "retrieved_at"
      FROM "research_source_revisions" WHERE "id" = ${sourceRevisionId}
    `)) as unknown as {
      content_hash: string | null;
      byte_count: number;
      status: string;
      retrieved_at: Date;
    }[];
    expect(after[0]!.content_hash).toBe(before[0]!.content_hash);
    expect(after[0]!.byte_count).toBe(before[0]!.byte_count);
    expect(after[0]!.status).toBe(before[0]!.status);
    expect(new Date(after[0]!.retrieved_at).toISOString()).toBe(
      new Date(before[0]!.retrieved_at).toISOString(),
    );
  });

  it('is idempotent: a repeated request with the same key returns the original record', async () => {
    const scope = await seedScope(db, '__mtest__ avail-idempotent');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });
    const sourceRevisionId = await seedSourceRevision(db, scope, run.runId);

    const svc = new SourceAvailabilityService(db);
    const input = {
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: run.runId,
      rootRunId: run.runId,
      sourceRevisionId,
      logicalCallId: `${run.runId}:availability:2`,
      idempotencyKey: 'avail-key-2',
      status: 'unavailable' as const,
      httpStatus: 404,
      warning: 'not found',
    };
    const first = await svc.recordAvailabilityCheck(input);
    const second = await svc.recordAvailabilityCheck(input);

    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('unavailable');

    // Only one record.
    const rows = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n" FROM "research_source_availability_checks"
      WHERE "source_revision_id" = ${sourceRevisionId}
    `)) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(1);
  });

  it('returns a non-enumerating 404 for a cross-scope source revision', async () => {
    const scopeA = await seedScope(db, '__mtest__ avail-scopeA');
    const scopeB = await seedScope(db, '__mtest__ avail-scopeB');
    const runA = await seedRootRun(db, scopeA, { reservedCents: 1000 });
    const sourceRevisionId = await seedSourceRevision(db, scopeA, runA.runId);

    const svc = new SourceAvailabilityService(db);
    await expect(
      svc.recordAvailabilityCheck({
        companyId: scopeB.companyId,
        projectId: scopeB.projectId,
        runId: runA.runId,
        rootRunId: runA.runId,
        sourceRevisionId,
        logicalCallId: 'cross',
        idempotencyKey: 'cross-key',
        status: 'available',
      }),
    ).rejects.toMatchObject({ status: 404, code: 'SOURCE_REVISION_NOT_FOUND' });
  });

  it('availability check is separately budgeted via a linked research attempt', async () => {
    const scope = await seedScope(db, '__mtest__ avail-budgeted');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });
    const sourceRevisionId = await seedSourceRevision(db, scope, run.runId);

    const accounting = new ResearchAttemptAccountingService(db);
    const svc = new SourceAvailabilityService(db);
    const callId = `${run.runId}:availability:3`;

    // Reserve a separate in-flight hold for the availability check.
    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'availability',
        operation: 'availability_check',
        reservedCents: 20,
      }),
    );

    const result = await svc.recordAvailabilityCheck({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: run.runId,
      rootRunId: run.runId,
      sourceRevisionId,
      logicalCallId: callId,
      idempotencyKey: 'avail-key-3',
      status: 'available',
      attemptId: a.attemptId,
    });
    expect(result.replayed).toBe(false);

    // The availability check record links to the budgeted attempt.
    const [row] = (await db.drizzle.execute(sql`
      SELECT "attempt_id" FROM "research_source_availability_checks" WHERE "id" = ${result.id}
    `)) as unknown as { attempt_id: string | null }[];
    expect(row.attempt_id).toBe(a.attemptId);
  });

  it('cancellation of the linked attempt releases its in-flight hold without mutating the revision', async () => {
    const scope = await seedScope(db, '__mtest__ avail-cancel');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });
    const sourceRevisionId = await seedSourceRevision(db, scope, run.runId);

    const accounting = new ResearchAttemptAccountingService(db);
    const callId = `${run.runId}:availability:4`;

    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'availability',
        operation: 'availability_check',
        reservedCents: 20,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a.attemptId);
      await accounting.markCancelled(tx, a.attemptId);
    });

    const state = await db.drizzle.transaction(async (tx) =>
      accounting.getAllocationState(tx, run.runId, false),
    );
    expect(state.inFlightCents).toBe(0);

    // The revision is still unchanged.
    const [rev] = (await db.drizzle.execute(sql`
      SELECT "status" FROM "research_source_revisions" WHERE "id" = ${sourceRevisionId}
    `)) as unknown as { status: string }[];
    expect(rev.status).toBe('available');
  });
});

// ---------------------------------------------------------------------------
// Explicit nonmutating availability refresh — no automatic polling side effect
// ---------------------------------------------------------------------------

describe('Availability refresh does not create records automatically', () => {
  it('no availability record exists until an explicit check is recorded', async () => {
    const scope = await seedScope(db, '__mtest__ avail-noauto');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });
    const sourceRevisionId = await seedSourceRevision(db, scope, run.runId);

    const rows = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n" FROM "research_source_availability_checks"
      WHERE "source_revision_id" = ${sourceRevisionId}
    `)) as unknown as { n: number }[];
    expect(rows[0]!.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fix-ut-m5-research-attempt-transaction: SAVEPOINT before INSERT so a
// failed INSERT (FK/check constraint) does not abort the transaction and
// cause the catch-block SELECT to throw RESEARCH_ATTEMPT_CONFLICT when no
// prior attempt exists.
// ---------------------------------------------------------------------------

describe('fix-ut-m5-research-attempt-transaction: reserveInFlight SAVEPOINT', () => {
  it('does not throw RESEARCH_ATTEMPT_CONFLICT when INSERT fails for a non-duplicate reason and no prior attempt exists', async () => {
    const scope = await seedScope(db, '__mtest__ reserve-fk-fail');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);

    // Use a non-existent company_id to trigger a foreign-key violation on
    // INSERT. The allocation lookup succeeds (queries by run_id), but the
    // INSERT fails on the company_id FK constraint. Without the SAVEPOINT
    // fix, the catch-block SELECT runs in an aborted transaction, finds
    // nothing, and incorrectly throws RESEARCH_ATTEMPT_CONFLICT.
    const bogusCompanyId = randomUUID();
    await expect(
      db.drizzle.transaction(async (tx) =>
        accounting.reserveInFlight(tx, {
          companyId: bogusCompanyId,
          projectId: scope.projectId,
          runId: run.runId,
          rootRunId: run.runId,
          logicalCallId: randomUUID(),
          attemptOrdinal: 1,
          provider: 'tavily',
          operation: 'search',
          reservedCents: 100,
        }),
      ),
    ).rejects.not.toMatchObject({ code: 'RESEARCH_ATTEMPT_CONFLICT' });

    // No research attempt was created.
    const attempts = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n" FROM "research_attempts" WHERE "run_id" = ${run.runId}
    `)) as unknown as { n: number }[];
    expect(attempts[0]!.n).toBe(0);
  });

  it('still returns the existing attempt id on a unique-constraint duplicate (idempotent reserve)', async () => {
    const scope = await seedScope(db, '__mtest__ reserve-dup-ok');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const accounting = new ResearchAttemptAccountingService(db);
    const logicalCallId = randomUUID();

    // First reserve succeeds.
    const first = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 200,
      }),
    );

    // Second reserve with the same logical_call_id + ordinal hits the
    // unique constraint and returns the existing attempt (idempotent).
    const second = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 200,
      }),
    );
    expect(second.attemptId).toBe(first.attemptId);

    // Only one attempt row exists.
    const attempts = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS "n" FROM "research_attempts" WHERE "logical_call_id" = ${logicalCallId}
    `)) as unknown as { n: number }[];
    expect(attempts[0]!.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// fix-ut-m5-research-execution-gaps: Date serialization — raw sql`` templates
// must pass ISO 8601 strings, not Date objects that pg may serialize as
// Date.toString() (e.g. 'Tue Aug 25 2026 17:56:56 GMT-0500') which PostgreSQL
// rejects with "time zone 'gmt-0500' not recognized".
// ---------------------------------------------------------------------------

describe('fix-ut-m5-research-execution-gaps: ISO 8601 timestamp serialization', () => {
  it('reserveInFlight stores created_at as a valid ISO 8601 timestamp', async () => {
    const scope = await seedScope(db, '__mtest__ iso-created-at');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const fixedTime = new Date('2026-08-25T17:56:56.000Z');
    const accounting = new ResearchAttemptAccountingService(db, { clock: () => fixedTime });

    const result = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: randomUUID(),
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 100,
      }),
    );

    // Read the stored created_at and verify it matches the injected clock.
    const [row] = (await db.drizzle.execute(sql`
      SELECT "created_at" FROM "research_attempts" WHERE "id" = ${result.attemptId}
    `)) as unknown as { created_at: Date }[];
    expect(row).toBeTruthy();
    const stored = new Date(row.created_at);
    expect(stored.toISOString()).toBe(fixedTime.toISOString());
  });

  it('markStarted stores started_at as a valid ISO 8601 timestamp', async () => {
    const scope = await seedScope(db, '__mtest__ iso-started-at');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const fixedTime = new Date('2026-08-25T17:56:56.000Z');
    const accounting = new ResearchAttemptAccountingService(db, { clock: () => fixedTime });

    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: randomUUID(),
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 100,
      }),
    );
    await db.drizzle.transaction(async (tx) => accounting.markStarted(tx, a.attemptId));

    const [row] = (await db.drizzle.execute(sql`
      SELECT "started_at" FROM "research_attempts" WHERE "id" = ${a.attemptId}
    `)) as unknown as { started_at: Date }[];
    expect(row.started_at).toBeTruthy();
    expect(new Date(row.started_at).toISOString()).toBe(fixedTime.toISOString());
  });

  it('settleAttempt stores settled_at and terminal_at as valid ISO 8601 timestamps', async () => {
    const scope = await seedScope(db, '__mtest__ iso-settled-at');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const fixedTime = new Date('2026-08-25T17:56:56.000Z');
    const accounting = new ResearchAttemptAccountingService(db, { clock: () => fixedTime });

    const callId = randomUUID();
    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 100,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a.attemptId);
      await accounting.settleAttempt(tx, a.attemptId, {
        externalCallId: `ext-${callId}`,
        reportedCredits: 1,
        costCents: 10,
      });
    });

    const [row] = (await db.drizzle.execute(sql`
      SELECT "settled_at", "terminal_at" FROM "research_attempts" WHERE "id" = ${a.attemptId}
    `)) as unknown as { settled_at: Date; terminal_at: Date }[];
    expect(new Date(row.settled_at).toISOString()).toBe(fixedTime.toISOString());
    expect(new Date(row.terminal_at).toISOString()).toBe(fixedTime.toISOString());
  });

  it('markFailed stores terminal_at as a valid ISO 8601 timestamp', async () => {
    const scope = await seedScope(db, '__mtest__ iso-failed-at');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const fixedTime = new Date('2026-08-25T17:56:56.000Z');
    const accounting = new ResearchAttemptAccountingService(db, { clock: () => fixedTime });

    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: randomUUID(),
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 100,
      }),
    );
    await db.drizzle.transaction(async (tx) =>
      accounting.markFailed(tx, a.attemptId, 'PROVIDER_PERMANENT', 'failed'),
    );

    const [row] = (await db.drizzle.execute(sql`
      SELECT "terminal_at" FROM "research_attempts" WHERE "id" = ${a.attemptId}
    `)) as unknown as { terminal_at: Date }[];
    expect(new Date(row.terminal_at).toISOString()).toBe(fixedTime.toISOString());
  });

  it('markUnknown stores settled_at and terminal_at as valid ISO 8601 timestamps', async () => {
    const scope = await seedScope(db, '__mtest__ iso-unknown-at');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const fixedTime = new Date('2026-08-25T17:56:56.000Z');
    const accounting = new ResearchAttemptAccountingService(db, { clock: () => fixedTime });

    const callId = randomUUID();
    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: callId,
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 100,
      }),
    );
    await db.drizzle.transaction(async (tx) => {
      await accounting.markStarted(tx, a.attemptId);
      await accounting.markUnknown(tx, a.attemptId, {
        externalCallId: `ext-${callId}-unknown`,
        conservativeMaxCents: 50,
      });
    });

    const [row] = (await db.drizzle.execute(sql`
      SELECT "settled_at", "terminal_at" FROM "research_attempts" WHERE "id" = ${a.attemptId}
    `)) as unknown as { settled_at: Date; terminal_at: Date }[];
    expect(new Date(row.settled_at).toISOString()).toBe(fixedTime.toISOString());
    expect(new Date(row.terminal_at).toISOString()).toBe(fixedTime.toISOString());
  });

  it('releaseRunResiduals stores terminal_at as a valid ISO 8601 timestamp', async () => {
    const scope = await seedScope(db, '__mtest__ iso-release-at');
    const run = await seedRootRun(db, scope, { reservedCents: 1000 });

    const fixedTime = new Date('2026-08-25T17:56:56.000Z');
    const accounting = new ResearchAttemptAccountingService(db, { clock: () => fixedTime });

    const a = await db.drizzle.transaction(async (tx) =>
      accounting.reserveInFlight(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: run.runId,
        rootRunId: run.runId,
        logicalCallId: randomUUID(),
        attemptOrdinal: 1,
        provider: 'tavily',
        operation: 'search',
        reservedCents: 100,
      }),
    );
    await db.drizzle.transaction(async (tx) => accounting.markStarted(tx, a.attemptId));
    await db.drizzle.transaction(async (tx) =>
      accounting.releaseRunResiduals(tx, scope.companyId, run.runId),
    );

    const [row] = (await db.drizzle.execute(sql`
      SELECT "terminal_at" FROM "research_attempts" WHERE "id" = ${a.attemptId}
    `)) as unknown as { terminal_at: Date }[];
    expect(new Date(row.terminal_at).toISOString()).toBe(fixedTime.toISOString());
  });
});
