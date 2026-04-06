import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const goals = sqliteTable('goals', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id),
  title: text('title').notNull(),
  description: text('description'),
  level: text('level', {
    enum: ['company', 'department', 'team', 'individual'],
  })
    .notNull()
    .default('company'),
  status: text('status', {
    enum: ['draft', 'active', 'completed', 'cancelled'],
  })
    .notNull()
    .default('draft'),
  parentId: text('parent_id').references((): any => goals.id),
  ownerAgentId: text('owner_agent_id').references(() => agents.id),
  progress: integer('progress').notNull().default(0),
  targetDate: integer('target_date', { mode: 'timestamp_ms' }),
  metrics: text('metrics', { mode: 'json' })
    .notNull()
    .$type<Record<string, unknown>>()
    .default({}),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
