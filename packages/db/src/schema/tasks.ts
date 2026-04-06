import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    projectId: text('project_id'),
    goalId: text('goal_id'),
    parentId: text('parent_id').references((): any => tasks.id),
    title: text('title').notNull(),
    description: text('description'),
    type: text('type', {
      enum: ['feature', 'bug', 'chore', 'spike', 'epic'],
    })
      .notNull()
      .default('feature'),
    status: text('status', {
      enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled'],
    })
      .notNull()
      .default('backlog'),
    priority: text('priority', {
      enum: ['critical', 'high', 'medium', 'low'],
    })
      .notNull()
      .default('medium'),
    assigneeAgentId: text('assignee_agent_id').references(() => agents.id),
    createdByAgentId: text('created_by_agent_id'),
    createdByUserId: text('created_by_user_id'),
    taskNumber: integer('task_number'),
    identifier: text('identifier'),
    dependencies: text('dependencies', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    estimatedTokens: integer('estimated_tokens'),
    actualTokens: integer('actual_tokens'),
    tags: text('tags', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    dueAt: integer('due_at', { mode: 'timestamp_ms' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_tasks_company_status').on(table.companyId, table.status),
    index('idx_tasks_company_assignee').on(table.companyId, table.assigneeAgentId),
  ],
);
