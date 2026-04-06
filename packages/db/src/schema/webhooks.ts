import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const webhooks = sqliteTable(
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
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastTriggeredAt: integer('last_triggered_at', { mode: 'timestamp_ms' }),
    triggerCount: integer('trigger_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_webhooks_company').on(table.companyId),
  ],
);
