import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const budgetAlerts = sqliteTable('budget_alerts', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id),
  agentId: text('agent_id').references(() => agents.id),
  thresholdPercent: integer('threshold_percent').notNull(),
  triggered: integer('triggered', { mode: 'boolean' }).notNull().default(false),
  triggeredAt: integer('triggered_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
