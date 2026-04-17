import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents';
import { companies } from './companies';
import { tasks } from './tasks';

export const heartbeats = pgTable('heartbeats', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  agentId: text('agent_id')
    .notNull()
    .references(() => agents.id),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id),
  status: text('status', {
    enum: ['running', 'completed', 'failed'],
  }).notNull(),
  taskId: text('task_id').references(() => tasks.id),
  startedAt: timestamp('started_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: timestamp('completed_at', { mode: 'date', precision: 3 }),
  tokenUsage: jsonb('token_usage')
    .notNull()
    .$type<Record<string, unknown>>()
    .default({}),
  error: text('error'),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});
