import { pgTable, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';

export const webhooks = pgTable(
  'webhooks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    secret: text('secret').notNull(),
    targetAgentId: text('target_agent_id').references(() => agents.id),
    eventType: text('event_type').notNull().default('task.create'),
    enabled: boolean('enabled').notNull().default(true),
    lastTriggeredAt: timestamp('last_triggered_at', { mode: 'date', precision: 3 }),
    triggerCount: integer('trigger_count').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_webhooks_company').on(table.companyId),
  ],
);
