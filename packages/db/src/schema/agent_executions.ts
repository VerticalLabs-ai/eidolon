import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents';
import { tasks } from './tasks';

export const agentExecutions = sqliteTable(
  'agent_executions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    taskId: text('task_id').references(() => tasks.id),
    status: text('status', {
      enum: ['running', 'completed', 'failed', 'cancelled'],
    })
      .notNull()
      .default('running'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costCents: integer('cost_cents').notNull().default(0),
    modelUsed: text('model_used'),
    provider: text('provider'),
    summary: text('summary'),
    error: text('error'),
    log: text('log', { mode: 'json' })
      .notNull()
      .$type<Array<{ timestamp: string; level: string; message: string }>>()
      .default([]),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_executions_company').on(table.companyId, table.agentId, table.createdAt),
  ],
);
