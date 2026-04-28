import { sql } from 'drizzle-orm';
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
    startedAt: timestamp('started_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3, withTimezone: true }),
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
    retryAttempt: integer('retry_attempt').notNull().default(0),
    retryStatus: text('retry_status', {
      // `released` is reserved for orchestration claims that are explicitly
      // dropped because their task or execution is no longer eligible to retry.
      enum: ['none', 'scheduled', 'retrying', 'exhausted', 'released'],
    })
      .notNull()
      .default('none'),
    retryDueAt: timestamp('retry_due_at', { mode: 'date', precision: 3, withTimezone: true }),
    failureCategory: text('failure_category'),
    lastEventAt: timestamp('last_event_at', { mode: 'date', precision: 3, withTimezone: true }),
    executionMode: text('execution_mode', {
      enum: ['single', 'agentic-loop', 'manual', 'recovery'],
    })
      .notNull()
      .default('single'),
    // FK is created in the migration after execution_environments exists; keeping
    // this scalar here avoids a circular module import because environments also
    // reference agent_executions for lease ownership.
    environmentId: text('environment_id'),
    lastUsefulAction: text('last_useful_action'),
    nextActionHint: text('next_action_hint'),
    continuationAttempts: integer('continuation_attempts').notNull().default(0),
    lastContinuationAt: timestamp('last_continuation_at', { mode: 'date', precision: 3, withTimezone: true }),
    watchdogLastCheckedAt: timestamp('watchdog_last_checked_at', { mode: 'date', precision: 3, withTimezone: true }),
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
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_agent_executions_company').on(table.companyId, table.agentId, table.createdAt),
    index('idx_agent_executions_liveness').on(table.companyId, table.livenessStatus, table.watchdogLastCheckedAt),
    index('idx_agent_executions_retry')
      .on(table.companyId, table.retryStatus, table.retryDueAt)
      .where(sql`${table.retryStatus} IN ('scheduled', 'retrying')`),
    index('idx_agent_executions_environment').on(table.environmentId),
  ],
);
