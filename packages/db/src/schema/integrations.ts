import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const integrations = sqliteTable(
  'integrations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    config: text('config').notNull().default('{}'),
    credentialsEncrypted: text('credentials_encrypted'),
    status: text('status').notNull().default('active'),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_integrations_company').on(table.companyId),
  ],
);
