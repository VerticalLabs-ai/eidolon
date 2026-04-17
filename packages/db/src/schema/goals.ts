import { pgTable, text, integer, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const goals = pgTable('goals', {
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
  targetDate: timestamp('target_date', { mode: 'date', precision: 3 }),
  metrics: jsonb('metrics')
    .notNull()
    .$type<Record<string, unknown>>()
    .default({}),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});
