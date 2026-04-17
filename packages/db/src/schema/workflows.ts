import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const workflows = pgTable('workflows', {
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
  createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});
