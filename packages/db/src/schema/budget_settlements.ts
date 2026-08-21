import { pgTable, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { missionRuns } from './mission_runs.js';
import { budgetReservations } from './budget_reservations.js';
import { budgetAllocations } from './budget_allocations.js';

/**
 * Immutable exact charges for Mission budget settlement.
 *
 * Each settlement belongs to one run allocation and one root reservation.
 * Unique `external_call_id` prevents double-charge on replay/recovery.
 * Settlement and updates to `companies.spent_monthly_cents`,
 * `agents.spent_monthly_cents`, and a compatibility `cost_events` row
 * happen in one transaction (VAL-RUN-123).
 */
export const budgetSettlements = pgTable(
  'budget_settlements',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    rootReservationId: text('root_reservation_id')
      .notNull()
      .references(() => budgetReservations.id, { onDelete: 'cascade' }),
    allocationId: text('allocation_id')
      .notNull()
      .references(() => budgetAllocations.id, { onDelete: 'cascade' }),
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    billingAgentId: text('billing_agent_id').references(() => agents.id),
    /** Deterministic or provider-supplied unique external call id. */
    externalCallId: text('external_call_id').notNull(),
    /** Provider or research operation label (e.g. 'anthropic', 'tavily'). */
    provider: text('provider').notNull(),
    model: text('model'),
    /** Research operation type if not an LLM call (e.g. 'search', 'extract'). */
    operation: text('operation'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    credits: integer('credits').notNull().default(0),
    costCents: integer('cost_cents').notNull(),
    /** SHA-256 hash of the provider request id for correlation. */
    providerRequestIdHash: text('provider_request_id_hash'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_budget_settlements_external_call').on(table.externalCallId),
    index('idx_budget_settlements_run').on(table.runId),
    index('idx_budget_settlements_allocation').on(table.allocationId),
  ],
);
