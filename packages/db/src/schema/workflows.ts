import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';

export const workflows = pgTable(
  'workflows',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    description: text('description'),
    nodes: jsonb('nodes')
      .notNull()
      .$type<Record<string, unknown>[]>()
      .default([]),
    status: text('status', {
      enum: ['draft', 'active', 'paused', 'archived'],
    })
      .notNull()
      .default('draft'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_workflows_company_project').on(table.companyId, table.projectId, table.createdAt),
  ],
);
