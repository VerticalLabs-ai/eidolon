import { pgTable, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { missionRuns } from './mission_runs.js';
import { budgetReservations } from './budget_reservations.js';

/**
 * Per-run/billing-agent allocation under a root reservation.
 *
 * One active allocation per run. Allocations cannot exceed the root hold.
 * Ephemeral children charge the inherited billing agent. Settlement and
 * release happen in the same transaction as legacy accounting projections.
 */
export const budgetAllocations = pgTable(
  'budget_allocations',
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
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    billingAgentId: text('billing_agent_id').references(() => agents.id),
    allocatedCents: integer('allocated_cents').notNull(),
    settledCents: integer('settled_cents').notNull().default(0),
    releasedCents: integer('released_cents').notNull().default(0),
    status: text('status', {
      enum: ['held', 'partially_settled', 'settled', 'released'],
    })
      .notNull()
      .default('held'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_budget_allocations_run').on(table.runId),
    index('idx_budget_allocations_root').on(table.rootReservationId),
  ],
);
