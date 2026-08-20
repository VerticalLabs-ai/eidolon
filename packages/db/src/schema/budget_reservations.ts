import { pgTable, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { missionRuns } from './mission_runs.js';

/**
 * One root company hold per root Mission run.
 *
 * The root hold protects the company once; child allocations do not
 * double-reserve company funds. `settled + released <= reserved` is enforced
 * by the budget module and a database check. Monetary values are integer
 * cents; no floating-point budget decisions.
 */
export const budgetReservations = pgTable(
  'budget_reservations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    billingAgentId: text('billing_agent_id').references(() => agents.id),
    requestedCents: integer('requested_cents').notNull(),
    reservedCents: integer('reserved_cents').notNull(),
    settledCents: integer('settled_cents').notNull().default(0),
    releasedCents: integer('released_cents').notNull().default(0),
    // Billing period key (e.g. "YYYY-MM") for monthly headroom accounting.
    periodKey: text('period_key').notNull(),
    status: text('status', {
      enum: ['held', 'partially_settled', 'settled', 'released'],
    })
      .notNull()
      .default('held'),
    expiresAt: timestamp('expires_at', { mode: 'date', precision: 3, withTimezone: true }),
    terminalAt: timestamp('terminal_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_budget_reservations_run').on(table.runId),
    index('idx_budget_reservations_company_period').on(table.companyId, table.periodKey),
  ],
);
