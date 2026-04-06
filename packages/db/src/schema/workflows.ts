import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const workflows = sqliteTable('workflows', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id),
  name: text('name').notNull(),
  description: text('description'),
  nodes: text('nodes', { mode: 'json' })
    .notNull()
    .$type<Record<string, unknown>[]>()
    .default([]),
  status: text('status', {
    enum: ['draft', 'active', 'paused', 'archived'],
  })
    .notNull()
    .default('draft'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
