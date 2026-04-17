import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const tasks = pgTable(
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
      enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'cancelled', 'timed_out'],
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
    dependencies: jsonb('dependencies')
      .notNull()
      .$type<string[]>()
      .default([]),
    estimatedTokens: integer('estimated_tokens'),
    actualTokens: integer('actual_tokens'),
    tags: jsonb('tags')
      .notNull()
      .$type<string[]>()
      .default([]),
    dueAt: timestamp('due_at', { mode: 'date', precision: 3 }),
    startedAt: timestamp('started_at', { mode: 'date', precision: 3 }),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3 }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_tasks_company_status').on(table.companyId, table.status),
    index('idx_tasks_company_assignee').on(table.companyId, table.assigneeAgentId),
  ],
);
