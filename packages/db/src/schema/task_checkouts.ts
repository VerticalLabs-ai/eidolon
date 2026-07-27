import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { tasks } from './tasks.js';
import { agentExecutions } from './agent_executions.js';

export const taskCheckouts = pgTable(
  'task_checkouts',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    executionId: text('execution_id')
      .notNull()
      .references(() => agentExecutions.id),
    source: text('source', {
      enum: ['api', 'agent_executor', 'agentic_loop', 'routine'],
    }).notNull(),
    status: text('status', {
      enum: ['active', 'released'],
    })
      .notNull()
      .default('active'),
    idempotencyKey: text('idempotency_key').notNull(),
    claimedAt: timestamp('claimed_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    releasedAt: timestamp('released_at', { mode: 'date', precision: 3, withTimezone: true }),
    releaseReason: text('release_reason'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_task_checkouts_active_task')
      .on(table.companyId, table.taskId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('uq_task_checkouts_idempotency').on(
      table.companyId,
      table.taskId,
      table.idempotencyKey,
    ),
    uniqueIndex('uq_task_checkouts_execution').on(table.executionId),
    index('idx_task_checkouts_agent').on(table.companyId, table.agentId, table.status),
  ],
);
