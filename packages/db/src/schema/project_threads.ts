import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { agents } from './agents.js';

export const projectThreads = pgTable(
  'project_threads',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    type: text('type', {
      enum: ['conversation', 'plan_review', 'decision_review', 'standup'],
    })
      .notNull()
      .default('conversation'),
    status: text('status', {
      enum: ['active', 'archived'],
    })
      .notNull()
      .default('active'),
    // Clerk user ids are external identities; Eidolon does not keep a local users table.
    createdByUserId: text('created_by_user_id'),
    createdByAgentId: text('created_by_agent_id').references(() => agents.id),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_project_threads_company_project_created').on(
      table.companyId,
      table.projectId,
      table.createdAt,
    ),
    index('idx_project_threads_company_project_status').on(
      table.companyId,
      table.projectId,
      table.status,
    ),
  ],
);
