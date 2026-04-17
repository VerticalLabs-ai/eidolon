import { pgTable, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const budgetAlerts = pgTable('budget_alerts', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id),
  agentId: text('agent_id').references(() => agents.id),
  thresholdPercent: integer('threshold_percent').notNull(),
  triggered: boolean('triggered').notNull().default(false),
  triggeredAt: timestamp('triggered_at', { mode: 'date', precision: 3 }),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});
