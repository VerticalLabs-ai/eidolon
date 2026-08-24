import { pgTable, text, integer, timestamp, uniqueIndex, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { budgetAllocations } from './budget_allocations.js';
import { researchPricingSnapshots } from './research_pricing_snapshots.js';

/**
 * Per-physical-attempt accounting for research provider calls.
 *
 * (architecture.md: Budget, VAL-RES-064, VAL-RES-065, VAL-RES-066,
 *  VAL-RES-067, VAL-RES-068, VAL-RES-069, VAL-RES-070, VAL-RES-110,
 *  VAL-RES-120)
 *
 * Each row is one physical provider attempt. The state machine is
 * `prepared -> started -> succeeded | failed | cancelled | unknown`.
 *
 * In-flight budget is tracked per attempt: `reserved_cents` is the
 * conservative hold reserved before dispatch. The sum of
 * `reserved_cents` over active in-flight states (`prepared`, `started`)
 * plus the allocation's `settled_cents` and `released_cents` must never
 * exceed `allocated_cents`. Settlement is exactly-once through the
 * BudgetService keyed by `external_call_id`.
 *
 * `unknown` records a post-dispatch connection loss where usage/request ID
 * is absent; the snapshotted conservative maximum is settled and no
 * fabricated ID or zero cost is ever recorded (VAL-RES-110).
 *
 * Forward-only and additive: one new table. No changes to existing enums
 * or constraints.
 */
export const researchAttempts = pgTable(
  'research_attempts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    rootRunId: text('root_run_id').notNull(),
    allocationId: text('allocation_id')
      .notNull()
      .references(() => budgetAllocations.id, { onDelete: 'cascade' }),
    /** Deterministic logical call ID (shared across fallback attempts). */
    logicalCallId: text('logical_call_id').notNull(),
    /** Per-logical-call physical attempt ordinal (1-based). */
    attemptOrdinal: integer('attempt_ordinal').notNull(),
    provider: text('provider').notNull(),
    operation: text('operation').notNull(),
    /** prepared | started | succeeded | failed | cancelled | unknown. */
    state: text('state').notNull().default('prepared'),
    /** Conservative in-flight hold reserved before dispatch (integer cents). */
    reservedCents: integer('reserved_cents').notNull(),
    /** Actual settled charge (integer cents). 0 until settled. */
    settledCents: integer('settled_cents').notNull().default(0),
    /** Linked immutable pricing snapshot (VAL-RES-120). */
    pricingSnapshotId: text('pricing_snapshot_id').references(() => researchPricingSnapshots.id, {
      onDelete: 'set null',
    }),
    /** Unique external call id used for exactly-once settlement. */
    externalCallId: text('external_call_id'),
    /** SHA-256 hash of the provider request id (lowercase hex). */
    providerRequestIdHash: text('provider_request_id_hash'),
    /** Provider-reported credits/units consumed. */
    reportedCredits: integer('reported_credits').notNull().default(0),
    /** Stable failure code for failed/cancelled/unknown attempts. */
    failureCode: text('failure_code'),
    safeErrorMessage: text('safe_error_message'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    startedAt: timestamp('started_at', { mode: 'date', precision: 3, withTimezone: true }),
    settledAt: timestamp('settled_at', { mode: 'date', precision: 3, withTimezone: true }),
    terminalAt: timestamp('terminal_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_research_attempts_logical_ordinal').on(
      table.logicalCallId,
      table.attemptOrdinal,
    ),
    index('idx_research_attempts_run').on(table.runId),
    index('idx_research_attempts_allocation').on(table.allocationId),
    index('idx_research_attempts_logical_call').on(table.logicalCallId),
    index('idx_research_attempts_state').on(table.state),
    check('chk_research_attempts_reserved_nonneg', sql`${table.reservedCents} >= 0`),
    check('chk_research_attempts_settled_nonneg', sql`${table.settledCents} >= 0`),
    check('chk_research_attempts_ordinal_positive', sql`${table.attemptOrdinal} > 0`),
  ],
);
