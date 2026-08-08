import { sql } from 'drizzle-orm';
import { pgTable, text, jsonb, timestamp, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { tasks } from './tasks.js';
import { approvals } from './approvals.js';
import { agentExecutions } from './agent_executions.js';
import { projects } from './projects.js';
import { projectThreads } from './project_threads.js';

export const taskThreadItems = pgTable(
  'task_thread_items',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    // Thread items are audit records. Keep task/company FK deletion as NO ACTION
    // so operators cannot silently remove task history by deleting a parent row.
    // Made nullable in VER-514: items may belong to either a task thread or a project thread.
    taskId: text('task_id').references(() => tasks.id),
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
    mentions: jsonb('mentions')
      .notNull()
      .$type<Array<{ entityType: 'agent' | 'user'; entityId: string; label: string }>>()
      .default([]),
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
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    // Project-level threads (VER-514). Exactly one of taskId or projectThreadId must be set.
    projectThreadId: text('project_thread_id').references(() => projectThreads.id, {
      onDelete: 'cascade',
    }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    index('idx_task_thread_items_task').on(table.companyId, table.taskId, table.createdAt),
    index('idx_task_thread_items_status').on(table.companyId, table.status),
    index('idx_task_thread_items_company_project').on(table.companyId, table.projectId, table.createdAt),
    index('idx_task_thread_items_project_thread').on(
      table.companyId,
      table.projectThreadId,
      table.createdAt,
    ),
    index('idx_task_thread_items_payload').using('gin', table.payload),
    uniqueIndex('uq_task_thread_items_idempotency').on(
      table.companyId,
      table.taskId,
      table.idempotencyKey,
    ).where(sql`${table.idempotencyKey} IS NOT NULL`),
    check(
      'chk_task_thread_items_task_or_project',
      sql`("task_id" IS NOT NULL) <> ("project_thread_id" IS NOT NULL)`,
    ),
  ],
);
