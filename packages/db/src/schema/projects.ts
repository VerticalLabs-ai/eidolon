import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const projects = pgTable('projects', {
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
  createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});
