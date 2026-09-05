import { pgTable, text, integer, timestamp, uniqueIndex, index, jsonb } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

/**
 * Immutable research pricing snapshots per provider attempt.
 *
 * (architecture.md: Budget, VAL-RES-120)
 *
 * Each attempt snapshots the pricing table/version, currency, unit definition,
 * integer-cent rounding rule, conservative unknown-price amount, reported
 * credits/units, and resulting cents. Settlements recompute from the
 * snapshot, not current prices; later price changes leave history unchanged.
 *
 * Fractional units and retry/fallback arithmetic use exact decimal conversion
 * before the declared rounding step. The `unit_definition` stores the price
 * as an exact rational (numerator/denominator) so conversion is reproducible
 * without floating-point.
 *
 * This table is immutable: rows are never updated or deleted. A pricing
 * snapshot is written once per paid provider attempt and referenced by the
 * settlement. Replay/recovery recomputes cents from the snapshot and
 * confirms the stored value.
 *
 * Privacy: this table holds pricing data only — no tenant queries, URLs,
 * source text, user IDs, or credentials.
 */
export const researchPricingSnapshots = pgTable(
  'research_pricing_snapshots',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    /** Provider name (e.g. 'tavily', 'firecrawl'). */
    provider: text('provider').notNull(),
    /** Research operation (e.g. 'search', 'extract', 'scrape'). */
    operation: text('operation').notNull(),
    /** Pricing table version (immutable identifier). */
    pricingTableVersion: text('pricing_table_version').notNull(),
    /** Currency code (e.g. 'USD'). */
    currency: text('currency').notNull().default('USD'),
    /**
     * Unit definition as exact rational price:
     * `{ unit: 'credit', priceNumerator: string, priceDenominator: string }`
     * where price per unit = numerator / denominator cents.
     * Stored as strings to preserve exact integer precision (BigInt-safe).
     */
    unitDefinition: jsonb('unit_definition').notNull(),
    /**
     * Integer-cent rounding rule:
     * 'round_half_up' | 'round_half_even' | 'floor' | 'ceil'.
     */
    roundingRule: text('rounding_rule').notNull().default('round_half_up'),
    /**
     * Conservative unknown-price amount in integer cents. Used when the
     * provider price is unknown — never treat unknown as free.
     */
    conservativeUnknownPriceCents: integer('conservative_unknown_price_cents').notNull(),
    /** Provider-reported credits/units consumed by the attempt. */
    reportedCredits: integer('reported_credits').notNull().default(0),
    /** Resulting integer cents after exact decimal conversion + rounding. */
    resultingCents: integer('resulting_cents').notNull(),
    /** SHA-256 content hash of the snapshot for integrity verification. */
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_research_pricing_snapshots_id').on(table.id),
    index('idx_research_pricing_snapshots_provider_operation').on(table.provider, table.operation),
    index('idx_research_pricing_snapshots_hash').on(table.contentHash),
  ],
);
