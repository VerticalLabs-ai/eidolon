import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

export const costEvents = pgTable('cost_events', {
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
  createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});
