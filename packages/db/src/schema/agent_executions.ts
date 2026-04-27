import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

export const agentExecutions = pgTable(
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
    startedAt: timestamp('started_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3 }),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costCents: integer('cost_cents').notNull().default(0),
    modelUsed: text('model_used'),
    provider: text('provider'),
    summary: text('summary'),
    error: text('error'),
    livenessStatus: text('liveness_status', {
      enum: ['healthy', 'silent', 'stalled', 'recovering', 'recovered'],
    })
      .notNull()
      .default('healthy'),
    lastUsefulAction: text('last_useful_action'),
    nextActionHint: text('next_action_hint'),
    continuationAttempts: integer('continuation_attempts').notNull().default(0),
    lastContinuationAt: timestamp('last_continuation_at', { mode: 'date', precision: 3 }),
    watchdogLastCheckedAt: timestamp('watchdog_last_checked_at', { mode: 'date', precision: 3 }),
    recoveryTaskId: text('recovery_task_id').references(() => tasks.id, { onDelete: 'set null' }),
    log: jsonb('log')
      .notNull()
      .$type<
        Array<{
          timestamp: string;
          level: string;
          message: string;
          // Optional structured fields used by the Observe/Think/Act/Reflect
          // transcript view. Older entries without these still render as a
          // flat log line.
          phase?: 'observe' | 'think' | 'act' | 'reflect';
          iteration?: number;
          content?: string;
          toolCalls?: Array<{
            tool: string;
            serverId?: string;
            args: Record<string, unknown>;
            result: string;
          }>;
        }>
      >()
      .default([]),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_executions_company').on(table.companyId, table.agentId, table.createdAt),
    index('idx_agent_executions_liveness').on(table.companyId, table.livenessStatus, table.watchdogLastCheckedAt),
  ],
);
