import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';
import { tasks } from './tasks';

export const costEvents = sqliteTable('cost_events', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  taskId: text('task_id').references(() => tasks.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costCents: integer('cost_cents').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
