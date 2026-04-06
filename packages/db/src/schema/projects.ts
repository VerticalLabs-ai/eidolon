import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const projects = sqliteTable('projects', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status', {
    enum: ['planning', 'active', 'completed', 'archived'],
  })
    .notNull()
    .default('planning'),
  repoUrl: text('repo_url'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
