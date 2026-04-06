import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents';
import { companies } from './companies';
import { tasks } from './tasks';

export const heartbeats = sqliteTable('heartbeats', {
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
  startedAt: integer('started_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
  tokenUsage: text('token_usage', { mode: 'json' })
    .notNull()
    .$type<Record<string, unknown>>()
    .default({}),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
