/**
 * Immutable research pricing snapshots and exact decimal conversion.
 *
 * (architecture.md: Budget, VAL-RES-120)
 *
 * Each paid provider attempt snapshots the pricing table/version, currency,
 * unit definition, integer-cent rounding rule, conservative unknown-price
 * amount, reported credits/units, and resulting cents. Settlements recompute
 * from the snapshot, not current prices; later price changes leave history
 * unchanged.
 *
 * Fractional units and retry/fallback arithmetic use exact decimal
 * conversion before the declared rounding step. The unit definition stores
 * the price as an exact rational (numerator/denominator) so conversion is
 * reproducible without floating-point. All arithmetic uses BigInt to
 * preserve exact integer precision.
 */

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DbInstance } from '../../../types.js';
import type { ResearchOperation } from './spi.js';
import type { ResearchProviderName } from './origins.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Integer-cent rounding rules. */
export type RoundingRule = 'round_half_up' | 'round_half_even' | 'floor' | 'ceil';

/**
 * Unit definition: the price per unit as an exact rational.
 *
 * `priceNumerator` and `priceDenominator` are non-negative integer strings
 * (decimal digits only). The price per unit in cents is
 * `priceNumerator / priceDenominator`. Stored as strings to preserve
 * BigInt precision in JSON.
 */
export interface UnitDefinition {
  /** The unit name (e.g. 'credit', 'page', 'request'). */
  unit: string;
  /** Price numerator (integer string). */
  priceNumerator: string;
  /** Price denominator (integer string, > 0). */
  priceDenominator: string;
}

/** A pricing table: provider/operation → unit definition + conservative max. */
export interface PricingTableEntry {
  provider: ResearchProviderName;
  operation: ResearchOperation;
  /** Immutable pricing table version identifier. */
  pricingTableVersion: string;
  currency: string;
  unitDefinition: UnitDefinition;
  roundingRule: RoundingRule;
  /** Conservative unknown-price amount in integer cents. */
  conservativeUnknownPriceCents: number;
}

/** Injectable dependencies. */
export interface PricingDeps {
  clock?: () => Date;
}

/** Result of a pricing snapshot creation. */
export interface PricingSnapshotResult {
  id: string;
  provider: ResearchProviderName;
  operation: ResearchOperation;
  pricingTableVersion: string;
  currency: string;
  unitDefinition: UnitDefinition;
  roundingRule: RoundingRule;
  conservativeUnknownPriceCents: number;
  reportedCredits: number;
  resultingCents: number;
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Exact decimal conversion (no floating-point)
// ---------------------------------------------------------------------------

/**
 * Parse a non-negative decimal integer string into a BigInt.
 * Throws on invalid input.
 */
function parseBigInt(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid non-negative integer string: "${value}"`);
  }
  return BigInt(value);
}

/**
 * Apply the declared rounding rule to a BigInt rational value.
 *
 * @param numerator The raw numerator (credits * priceNumerator).
 * @param denominator The denominator (priceDenominator).
 * @param rule The rounding rule.
 * @returns The rounded integer as a regular number.
 */
function applyRounding(numerator: bigint, denominator: bigint, rule: RoundingRule): number {
  if (denominator === 0n) {
    throw new Error('Denominator is zero');
  }

  switch (rule) {
    case 'floor':
      return Number(numerator / denominator);
    case 'ceil': {
      const quotient = numerator / denominator;
      const remainder = numerator % denominator;
      return Number(remainder > 0n ? quotient + 1n : quotient);
    }
    case 'round_half_up': {
      // Compute floor(numerator / denominator) and the remainder.
      const quotient = numerator / denominator;
      const remainder = numerator % denominator;
      // Compare remainder * 2 with denominator for half-up.
      const doubled = remainder * 2n;
      return Number(doubled >= denominator ? quotient + 1n : quotient);
    }
    case 'round_half_even': {
      const quotient = numerator / denominator;
      const remainder = numerator % denominator;
      const doubled = remainder * 2n;
      if (doubled > denominator) {
        return Number(quotient + 1n);
      }
      if (doubled < denominator) {
        return Number(quotient);
      }
      // Exact half: round to even.
      return Number(quotient % 2n === 0n ? quotient : quotient + 1n);
    }
    default:
      throw new Error(`Unknown rounding rule: "${rule}"`);
  }
}

/**
 * Convert reported credits/units to integer cents using an exact rational
 * unit definition and the declared rounding rule.
 *
 * The formula is: `cents = round(credits * priceNumerator / priceDenominator)`.
 * All arithmetic uses BigInt — no floating-point at any step.
 *
 * @param credits The number of credits/units consumed.
 * @param unitDefinition The exact rational price per unit.
 * @param rule The integer-cent rounding rule.
 * @returns The resulting integer cents.
 */
export function convertCreditsToCents(
  credits: number,
  unitDefinition: UnitDefinition,
  rule: RoundingRule,
): number {
  if (credits < 0) {
    throw new Error('Credits must be non-negative');
  }
  const creditsBig = BigInt(credits);
  const numerator = parseBigInt(unitDefinition.priceNumerator);
  const denominator = parseBigInt(unitDefinition.priceDenominator);
  if (denominator === 0n) {
    throw new Error('Unit definition denominator is zero');
  }
  const rawNumerator = creditsBig * numerator;
  return applyRounding(rawNumerator, denominator, rule);
}

/**
 * Recompute the resulting cents from a snapshot's stored inputs.
 *
 * This is used by settlement replay/recovery to verify that the stored
 * `resulting_cents` matches a fresh computation from the immutable snapshot.
 *
 * @param snapshot The stored snapshot inputs.
 * @returns The recomputed integer cents.
 */
export function recomputeCents(snapshot: {
  reportedCredits: number;
  unitDefinition: UnitDefinition;
  roundingRule: RoundingRule;
}): number {
  return convertCreditsToCents(
    snapshot.reportedCredits,
    snapshot.unitDefinition,
    snapshot.roundingRule,
  );
}

/**
 * Compute the conservative cost for an unknown-price attempt.
 *
 * Unknown price is never free: use the configured conservative maximum.
 *
 * @param conservativeUnknownPriceCents The configured conservative max.
 * @param credits The reported credits (if any).
 * @param unitDefinition The unit definition.
 * @param rule The rounding rule.
 * @returns The conservative integer cents.
 */
export function computeUnknownPriceCents(
  conservativeUnknownPriceCents: number,
  credits: number,
  unitDefinition: UnitDefinition,
  rule: RoundingRule,
): number {
  // If credits are reported, compute normally; the conservative max is the
  // fallback when no usage data is available.
  if (credits > 0) {
    return convertCreditsToCents(credits, unitDefinition, rule);
  }
  return conservativeUnknownPriceCents;
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 content hash for a pricing snapshot.
 *
 * The hash covers: provider, operation, pricingTableVersion, currency,
 * unitDefinition (sorted keys), roundingRule, conservativeUnknownPriceCents,
 * reportedCredits, resultingCents. This makes the snapshot integrity-verifiable
 * and deduplication-safe.
 */
export function computePricingSnapshotHash(input: {
  provider: string;
  operation: string;
  pricingTableVersion: string;
  currency: string;
  unitDefinition: UnitDefinition;
  roundingRule: RoundingRule;
  conservativeUnknownPriceCents: number;
  reportedCredits: number;
  resultingCents: number;
}): string {
  const canonical = JSON.stringify({
    provider: input.provider,
    operation: input.operation,
    pricingTableVersion: input.pricingTableVersion,
    currency: input.currency,
    unitDefinition: {
      unit: input.unitDefinition.unit,
      priceNumerator: input.unitDefinition.priceNumerator,
      priceDenominator: input.unitDefinition.priceDenominator,
    },
    roundingRule: input.roundingRule,
    conservativeUnknownPriceCents: input.conservativeUnknownPriceCents,
    reportedCredits: input.reportedCredits,
    resultingCents: input.resultingCents,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Research pricing snapshot service.
 *
 * Creates immutable pricing snapshot rows for each paid provider attempt.
 * Settlements reference the snapshot and recompute cents from it, not from
 * current prices.
 */
export class ResearchPricingService {
  private readonly clock: () => Date;

  constructor(
    private db: DbInstance,
    deps: PricingDeps = {},
  ) {
    this.clock = deps.clock ?? (() => new Date());
  }

  /**
   * Create an immutable pricing snapshot for a provider attempt.
   *
   * The snapshot records the pricing table, unit definition, rounding rule,
   * conservative unknown-price amount, reported credits, and resulting cents.
   * The resulting cents are computed via exact decimal conversion.
   *
   * @param entry The pricing table entry for this provider/operation.
   * @param reportedCredits The provider-reported credits/units consumed.
   * @returns The created snapshot result.
   */
  async snapshotPricing(
    entry: PricingTableEntry,
    reportedCredits: number,
  ): Promise<PricingSnapshotResult> {
    const schema = this.db.schema;
    const now = this.clock();

    const resultingCents = convertCreditsToCents(
      reportedCredits,
      entry.unitDefinition,
      entry.roundingRule,
    );

    const contentHash = computePricingSnapshotHash({
      provider: entry.provider,
      operation: entry.operation,
      pricingTableVersion: entry.pricingTableVersion,
      currency: entry.currency,
      unitDefinition: entry.unitDefinition,
      roundingRule: entry.roundingRule,
      conservativeUnknownPriceCents: entry.conservativeUnknownPriceCents,
      reportedCredits,
      resultingCents,
    });

    const [row] = await this.db.drizzle
      .insert(schema.researchPricingSnapshots)
      .values({
        provider: entry.provider,
        operation: entry.operation,
        pricingTableVersion: entry.pricingTableVersion,
        currency: entry.currency,
        unitDefinition: entry.unitDefinition,
        roundingRule: entry.roundingRule,
        conservativeUnknownPriceCents: entry.conservativeUnknownPriceCents,
        reportedCredits,
        resultingCents,
        contentHash,
        createdAt: now,
      })
      .returning();

    return {
      id: row!.id,
      provider: row!.provider as ResearchProviderName,
      operation: row!.operation as ResearchOperation,
      pricingTableVersion: row!.pricingTableVersion,
      currency: row!.currency,
      unitDefinition: row!.unitDefinition as UnitDefinition,
      roundingRule: row!.roundingRule as RoundingRule,
      conservativeUnknownPriceCents: row!.conservativeUnknownPriceCents,
      reportedCredits: row!.reportedCredits,
      resultingCents: row!.resultingCents,
      contentHash: row!.contentHash,
    };
  }

  /**
   * Retrieve a pricing snapshot by ID for recomputation/verification.
   */
  async getPricingSnapshot(snapshotId: string): Promise<PricingSnapshotResult | null> {
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
      .select()
      .from(schema.researchPricingSnapshots)
      .where(eq(schema.researchPricingSnapshots.id, snapshotId))
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      provider: row.provider as ResearchProviderName,
      operation: row.operation as ResearchOperation,
      pricingTableVersion: row.pricingTableVersion,
      currency: row.currency,
      unitDefinition: row.unitDefinition as UnitDefinition,
      roundingRule: row.roundingRule as RoundingRule,
      conservativeUnknownPriceCents: row.conservativeUnknownPriceCents,
      reportedCredits: row.reportedCredits,
      resultingCents: row.resultingCents,
      contentHash: row.contentHash,
    };
  }

  /**
   * Verify that a stored snapshot's resulting cents matches a fresh
   * recomputation from its immutable inputs.
   *
   * @returns true if the recomputed cents match the stored cents.
   */
  async verifySnapshot(snapshotId: string): Promise<boolean> {
    const snapshot = await this.getPricingSnapshot(snapshotId);
    if (!snapshot) {
      return false;
    }

    const recomputed = recomputeCents({
      reportedCredits: snapshot.reportedCredits,
      unitDefinition: snapshot.unitDefinition,
      roundingRule: snapshot.roundingRule,
    });

    return recomputed === snapshot.resultingCents;
  }

  /**
   * Compute the conservative cost for an unknown-price attempt.
   * Unknown price is never free (VAL-RES-120).
   */
  computeUnknownPrice(entry: PricingTableEntry, reportedCredits: number): number {
    return computeUnknownPriceCents(
      entry.conservativeUnknownPriceCents,
      reportedCredits,
      entry.unitDefinition,
      entry.roundingRule,
    );
  }
}
