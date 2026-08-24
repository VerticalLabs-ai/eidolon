import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, closeTestDb } from '../test-utils.js';
import {
  ResearchPricingService,
  convertCreditsToCents,
  recomputeCents,
  computeUnknownPriceCents,
  computePricingSnapshotHash,
  type PricingTableEntry,
  type UnitDefinition,
  type RoundingRule,
} from '../services/mission/research/pricing.js';

/**
 * Research pricing conversion and immutable snapshot tests.
 *
 * VAL-RES-120: Research pricing conversion is immutable and reproducible.
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
// Exact decimal conversion (unit tests)
// ---------------------------------------------------------------------------

describe('Exact decimal conversion (VAL-RES-120)', () => {
  it('converts whole-unit prices exactly', () => {
    // 1 credit = 10 cents. 5 credits = 50 cents.
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '10',
      priceDenominator: '1',
    };
    expect(convertCreditsToCents(5, unit, 'round_half_up')).toBe(50);
  });

  it('converts fractional-unit prices exactly (no floating-point)', () => {
    // 1 credit = 0.5 cents = 1/2. 10 credits = 5 cents.
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '1',
      priceDenominator: '2',
    };
    expect(convertCreditsToCents(10, unit, 'round_half_up')).toBe(5);
  });

  it('converts fractional-unit prices with rounding', () => {
    // 1 credit = 0.3 cents = 3/10. 1 credit → round(3/10) = 0 (floor) or 1 (ceil/round_half_up).
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '3',
      priceDenominator: '10',
    };
    expect(convertCreditsToCents(1, unit, 'floor')).toBe(0);
    expect(convertCreditsToCents(1, unit, 'ceil')).toBe(1);
    // round_half_up: 3/10 = 0.3, 0.3 * 2 = 0.6 < 1, so rounds down to 0.
    expect(convertCreditsToCents(1, unit, 'round_half_up')).toBe(0);
  });

  it('handles large credit counts with exact BigInt arithmetic', () => {
    // 1 credit = 1/7 cents. 7 credits = 1 cent exactly.
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '1',
      priceDenominator: '7',
    };
    expect(convertCreditsToCents(7, unit, 'round_half_up')).toBe(1);
    // 14 credits = 2 cents.
    expect(convertCreditsToCents(14, unit, 'round_half_up')).toBe(2);
    // 3 credits = 3/7 ≈ 0.4286 → floor 0, ceil 1.
    expect(convertCreditsToCents(3, unit, 'floor')).toBe(0);
    expect(convertCreditsToCents(3, unit, 'ceil')).toBe(1);
  });

  it('round_half_up rounds 0.5 up', () => {
    // 1 credit = 1/2 cent. 1 credit = 0.5 → round_half_up = 1.
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '1',
      priceDenominator: '2',
    };
    expect(convertCreditsToCents(1, unit, 'round_half_up')).toBe(1);
    // 3 credits = 1.5 → round_half_up = 2.
    expect(convertCreditsToCents(3, unit, 'round_half_up')).toBe(2);
  });

  it('round_half_even rounds 0.5 to even', () => {
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '1',
      priceDenominator: '2',
    };
    // 1 credit = 0.5 → round to even = 0.
    expect(convertCreditsToCents(1, unit, 'round_half_even')).toBe(0);
    // 3 credits = 1.5 → round to even = 2.
    expect(convertCreditsToCents(3, unit, 'round_half_even')).toBe(2);
    // 5 credits = 2.5 → round to even = 2.
    expect(convertCreditsToCents(5, unit, 'round_half_even')).toBe(2);
  });

  it('floor always rounds down', () => {
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '9',
      priceDenominator: '10',
    };
    // 1 credit = 0.9 → floor 0.
    expect(convertCreditsToCents(1, unit, 'floor')).toBe(0);
    // 2 credits = 1.8 → floor 1.
    expect(convertCreditsToCents(2, unit, 'floor')).toBe(1);
  });

  it('ceil always rounds up', () => {
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '1',
      priceDenominator: '3',
    };
    // 1 credit = 0.333 → ceil 1.
    expect(convertCreditsToCents(1, unit, 'ceil')).toBe(1);
    // 2 credits = 0.667 → ceil 1.
    expect(convertCreditsToCents(2, unit, 'ceil')).toBe(1);
    // 3 credits = 1.0 → ceil 1.
    expect(convertCreditsToCents(3, unit, 'ceil')).toBe(1);
  });

  it('zero credits yield zero cents', () => {
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '10',
      priceDenominator: '1',
    };
    expect(convertCreditsToCents(0, unit, 'round_half_up')).toBe(0);
  });

  it('rejects negative credits', () => {
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '10',
      priceDenominator: '1',
    };
    expect(() => convertCreditsToCents(-1, unit, 'round_half_up')).toThrow();
  });

  it('rejects zero denominator', () => {
    const unit: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '10',
      priceDenominator: '0',
    };
    expect(() => convertCreditsToCents(1, unit, 'round_half_up')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Unknown price (VAL-RES-120: never free)
// ---------------------------------------------------------------------------

describe('Unknown price handling (VAL-RES-120)', () => {
  it('uses conservative maximum when no credits reported', () => {
    const entry: PricingTableEntry = {
      provider: 'tavily',
      operation: 'search',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '1', priceDenominator: '2' },
      roundingRule: 'round_half_up',
      conservativeUnknownPriceCents: 500,
    };
    expect(computeUnknownPriceCents(500, 0, entry.unitDefinition, entry.roundingRule)).toBe(500);
  });

  it('computes normally when credits are reported', () => {
    const entry: PricingTableEntry = {
      provider: 'tavily',
      operation: 'search',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '1', priceDenominator: '2' },
      roundingRule: 'round_half_up',
      conservativeUnknownPriceCents: 500,
    };
    // 10 credits * 0.5 = 5 cents (less than conservative max).
    expect(computeUnknownPriceCents(500, 10, entry.unitDefinition, entry.roundingRule)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Retry/fallback arithmetic (VAL-RES-120)
// ---------------------------------------------------------------------------

describe('Retry/fallback arithmetic (VAL-RES-120)', () => {
  it('sums multiple attempt costs exactly', () => {
    // Provider A: 3 credits at 1/3 cent each = 1 cent.
    const unitA: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '1',
      priceDenominator: '3',
    };
    const costA = convertCreditsToCents(3, unitA, 'round_half_up');

    // Provider B (fallback): 2 credits at 1/2 cent each = 1 cent.
    const unitB: UnitDefinition = {
      unit: 'credit',
      priceNumerator: '1',
      priceDenominator: '2',
    };
    const costB = convertCreditsToCents(2, unitB, 'round_half_up');

    // Total = 2 cents.
    expect(costA + costB).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Content hash integrity
// ---------------------------------------------------------------------------

describe('Content hash integrity', () => {
  it('produces a deterministic SHA-256 hash', () => {
    const input = {
      provider: 'tavily',
      operation: 'search',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '1', priceDenominator: '2' },
      roundingRule: 'round_half_up' as RoundingRule,
      conservativeUnknownPriceCents: 500,
      reportedCredits: 10,
      resultingCents: 5,
    };
    const hash1 = computePricingSnapshotHash(input);
    const hash2 = computePricingSnapshotHash(input);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it('changes when inputs change', () => {
    const base = {
      provider: 'tavily',
      operation: 'search',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '1', priceDenominator: '2' },
      roundingRule: 'round_half_up' as RoundingRule,
      conservativeUnknownPriceCents: 500,
      reportedCredits: 10,
      resultingCents: 5,
    };
    const hash1 = computePricingSnapshotHash(base);
    const hash2 = computePricingSnapshotHash({ ...base, reportedCredits: 11 });
    expect(hash1).not.toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// Immutable pricing snapshots (Postgres integration, VAL-RES-120)
// ---------------------------------------------------------------------------

describe('Immutable pricing snapshots (VAL-RES-120)', () => {
  it('creates a snapshot with reproducible cents', async () => {
    const service = new ResearchPricingService(db, {
      clock: () => new Date('2026-08-24T10:00:00Z'),
    });
    const entry: PricingTableEntry = {
      provider: 'tavily',
      operation: 'search',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '1', priceDenominator: '2' },
      roundingRule: 'round_half_up',
      conservativeUnknownPriceCents: 500,
    };

    const snapshot = await service.snapshotPricing(entry, 10);
    expect(snapshot.resultingCents).toBe(5);
    expect(snapshot.reportedCredits).toBe(10);
    expect(snapshot.contentHash).toHaveLength(64);

    // Recompute from the stored snapshot — must match.
    const verified = await service.verifySnapshot(snapshot.id);
    expect(verified).toBe(true);
  });

  it('later price changes leave historical snapshots unchanged', async () => {
    const service = new ResearchPricingService(db, {
      clock: () => new Date('2026-08-24T10:00:00Z'),
    });

    // v1 pricing: 1 credit = 0.5 cents.
    const entryV1: PricingTableEntry = {
      provider: 'tavily',
      operation: 'search',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '1', priceDenominator: '2' },
      roundingRule: 'round_half_up',
      conservativeUnknownPriceCents: 500,
    };
    const snapshotV1 = await service.snapshotPricing(entryV1, 10);
    expect(snapshotV1.resultingCents).toBe(5);

    // Later, v2 pricing: 1 credit = 1.0 cents.
    const entryV2: PricingTableEntry = {
      ...entryV1,
      pricingTableVersion: 'v2',
      unitDefinition: { unit: 'credit', priceNumerator: '1', priceDenominator: '1' },
    };
    const snapshotV2 = await service.snapshotPricing(entryV2, 10);
    expect(snapshotV2.resultingCents).toBe(10);

    // The v1 snapshot is unchanged.
    const v1Read = await service.getPricingSnapshot(snapshotV1.id);
    expect(v1Read!.resultingCents).toBe(5);
    expect(v1Read!.pricingTableVersion).toBe('v1');
    expect(await service.verifySnapshot(snapshotV1.id)).toBe(true);

    // The v2 snapshot is also reproducible.
    expect(await service.verifySnapshot(snapshotV2.id)).toBe(true);
  });

  it('recompute from snapshot matches stored cents (reproducibility)', async () => {
    const service = new ResearchPricingService(db);
    const entry: PricingTableEntry = {
      provider: 'firecrawl',
      operation: 'scrape',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '3', priceDenominator: '10' },
      roundingRule: 'round_half_up',
      conservativeUnknownPriceCents: 1000,
    };

    // 7 credits at 0.3 cents each = 2.1 → round_half_up = 2.
    const snapshot = await service.snapshotPricing(entry, 7);
    expect(snapshot.resultingCents).toBe(2);

    // Independent recomputation.
    const recomputed = recomputeCents({
      reportedCredits: 7,
      unitDefinition: entry.unitDefinition,
      roundingRule: entry.roundingRule,
    });
    expect(recomputed).toBe(2);
    expect(recomputed).toBe(snapshot.resultingCents);
  });

  it('snapshot rows are immutable (no update path)', async () => {
    const service = new ResearchPricingService(db);
    const entry: PricingTableEntry = {
      provider: 'tavily',
      operation: 'extract',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '5', priceDenominator: '1' },
      roundingRule: 'round_half_up',
      conservativeUnknownPriceCents: 500,
    };

    const snapshot = await service.snapshotPricing(entry, 3);
    expect(snapshot.resultingCents).toBe(15);

    // Verify the row exists and is not modified by a second snapshot.
    const snapshot2 = await service.snapshotPricing(entry, 4);
    expect(snapshot2.resultingCents).toBe(20);

    // First snapshot unchanged.
    const reread = await service.getPricingSnapshot(snapshot.id);
    expect(reread!.resultingCents).toBe(15);
  });

  it('fractional units with exact decimal before rounding', async () => {
    const service = new ResearchPricingService(db);
    // 1 credit = 1/3 cent. 10 credits = 10/3 = 3.333... → round_half_up = 3.
    const entry: PricingTableEntry = {
      provider: 'firecrawl',
      operation: 'structured_extract',
      pricingTableVersion: 'v1',
      currency: 'USD',
      unitDefinition: { unit: 'credit', priceNumerator: '1', priceDenominator: '3' },
      roundingRule: 'round_half_up',
      conservativeUnknownPriceCents: 100,
    };

    const snapshot = await service.snapshotPricing(entry, 10);
    expect(snapshot.resultingCents).toBe(3);
    expect(await service.verifySnapshot(snapshot.id)).toBe(true);
  });
});
