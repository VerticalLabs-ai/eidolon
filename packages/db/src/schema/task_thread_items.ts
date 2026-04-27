import { pgTable, text, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { tasks } from './tasks.js';
import { approvals } from './approvals.js';
import { agentExecutions } from './agent_executions.js';

export const taskThreadItems = pgTable(
  'task_thread_items',
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
    kind: text('kind', {
      enum: ['comment', 'interaction', 'decision', 'approval_link', 'execution_event'],
    })
      .notNull()
      .default('comment'),
    // Clerk user ids are external identities; Eidolon does not keep a local users table.
    authorUserId: text('author_user_id'),
    authorAgentId: text('author_agent_id').references(() => agents.id),
    content: text('content'),
    payload: jsonb('payload')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    interactionType: text('interaction_type', {
      enum: ['suggested_tasks', 'confirmation', 'form'],
    }),
    status: text('status', {
      enum: ['pending', 'accepted', 'rejected', 'answered', 'linked'],
    })
      .notNull()
      .default('pending'),
    idempotencyKey: text('idempotency_key'),
    // No cascade: task thread rows are audit records and should retain linked approval rows.
    relatedApprovalId: text('related_approval_id').references(() => approvals.id),
    // No cascade: execution evidence should remain available through the thread audit trail.
    relatedExecutionId: text('related_execution_id').references(() => agentExecutions.id),
    resolvedByUserId: text('resolved_by_user_id'),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: timestamp('resolved_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    index('idx_task_thread_items_task').on(table.companyId, table.taskId, table.createdAt),
    index('idx_task_thread_items_status').on(table.companyId, table.status),
    index('idx_task_thread_items_payload').using('gin', table.payload),
    uniqueIndex('uq_task_thread_items_idempotency').on(
      table.companyId,
      table.taskId,
      table.idempotencyKey,
    ),
  ],
);
