import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const secrets = sqliteTable(
  'secrets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    valueEncrypted: text('value_encrypted').notNull(),
    provider: text('provider').notNull().default('local'),
    description: text('description'),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_secrets_company_name').on(table.companyId, table.name),
  ],
);
