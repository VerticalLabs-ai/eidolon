import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';

/**
 * Company membership — the authorization source of truth.
 *
 * Replaces Clerk organization membership for access control. Each row links
 * a user (Clerk user id or `dev-user-000` in local_trusted) to a company
 * with a specific role. The `requirePermission` middleware queries this
 * table to resolve the user's role for a given company.
 *
 * Cascade on company delete so memberships are removed when a company is
 * deleted.
 */
export const companyMembers = pgTable(
  'company_members',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull(),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_company_members_company_user').on(table.companyId, table.userId),
    index('idx_company_members_user').on(table.userId),
  ],
);
