import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

export const activityLog = sqliteTable('activity_log', {
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
  metadata: text('metadata', { mode: 'json' })
    .notNull()
    .$type<Record<string, unknown>>()
    .default({}),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
