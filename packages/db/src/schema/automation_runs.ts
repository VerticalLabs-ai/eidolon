import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { tasks } from './tasks.js';
import { agentExecutions } from './agent_executions.js';

export const automationRuns = pgTable(
  'automation_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    automationType: text('automation_type', {
      enum: ['routine', 'workflow', 'webhook'],
    })
      .notNull(),
    automationId: text('automation_id').notNull(),
    automationName: text('automation_name').notNull(),
    triggerType: text('trigger_type', {
      enum: ['manual', 'webhook', 'schedule', 'event', 'api'],
    })
      .notNull(),
    triggerPayload: jsonb('trigger_payload')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    status: text('status', {
      enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    executionId: text('execution_id').references(() => agentExecutions.id, { onDelete: 'set null' }),
    sessionId: text('session_id'),
    messageId: text('message_id'),
    outcome: text('outcome'),
    error: text('error'),
    startedAt: timestamp('started_at', { mode: 'date', precision: 3, withTimezone: true }),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_automation_runs_company_project_status_created').on(
      table.companyId,
      table.projectId,
      table.status,
      table.createdAt,
    ),
    index('idx_automation_runs_company_type_id_created').on(
      table.companyId,
      table.automationType,
      table.automationId,
      table.createdAt,
    ),
  ],
);
