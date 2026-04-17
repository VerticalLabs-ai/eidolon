import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const integrations = pgTable(
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
    lastUsedAt: timestamp('last_used_at', { mode: 'date', precision: 3 }),
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_integrations_company').on(table.companyId),
  ],
);
