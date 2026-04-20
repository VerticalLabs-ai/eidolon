import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

/**
 * Approvals are first-class governance objects that gate specific mutations
 * (budget changes, agent terminations, custom reviews). An approval is
 * created in 'pending' state, then resolved by a board-authorized user.
 *
 * Optional `taskId` ties an approval to a single task when the approval is a
 * "review this work product" request. Multi-task links will move to an
 * issue_approvals join table if/when that pattern emerges.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    kind: text('kind', {
      enum: ['budget_change', 'agent_termination', 'task_review', 'custom'],
    })
      .notNull()
      .default('custom'),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    priority: text('priority', {
      enum: ['critical', 'high', 'medium', 'low'],
    })
      .notNull()
      .default('medium'),
    requestedByUserId: text('requested_by_user_id'),
    requestedByAgentId: text('requested_by_agent_id').references(() => agents.id),
    resolvedByUserId: text('resolved_by_user_id'),
    resolutionNote: text('resolution_note'),
    payload: jsonb('payload')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    taskId: text('task_id').references(() => tasks.id),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: timestamp('resolved_at', { mode: 'date', precision: 3 }),
  },
  (table) => [
    index('idx_approvals_company_status').on(table.companyId, table.status),
    index('idx_approvals_task').on(table.taskId),
  ],
);

export const approvalComments = pgTable(
  'approval_comments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvals.id),
    authorUserId: text('author_user_id'),
    authorAgentId: text('author_agent_id').references(() => agents.id),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_approval_comments_approval').on(table.approvalId, table.createdAt),
  ],
);
