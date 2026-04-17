import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

export const activityLog = pgTable('activity_log', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  companyId: text('company_id').notNull(),
  actorType: text('actor_type', {
    enum: ['agent', 'user', 'system'],
  }).notNull(),
  actorId: text('actor_id'),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  description: text('description'),
  metadata: jsonb('metadata')
    .notNull()
    .$type<Record<string, unknown>>()
    .default({}),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});
