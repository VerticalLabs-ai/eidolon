import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';

/**
 * Test users created in `local_trusted` auth mode for validation.
 *
 * In `local_trusted` mode the only real user is `dev-user-000`, so user
 * mentions are always self-mentions (correctly skipped). This table stores
 * additional test users created via the `POST /api/auth/local-trusted/create-test-user`
 * endpoint so validators can mention a second user, check their inbox, and
 * capture `thread.mention` WS events.
 *
 * Only available when `AUTH_MODE=local_trusted`.
 */
export const testUsers = pgTable(
  'test_users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    email: text('email').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_test_users_company').on(table.companyId),
    uniqueIndex('uq_test_users_company_email').on(table.companyId, table.email),
  ],
);
