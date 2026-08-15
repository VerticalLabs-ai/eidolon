import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';

/**
 * Company invitations — pending access grants that activate on signup.
 *
 * An owner or admin invites a user by email. The invitation is created with
 * `status='pending'` and a 7-day expiry. When the invited user signs up via
 * Clerk, the `user.created` webhook matches the email to pending invitations
 * and creates `company_members` rows with the invited role.
 *
 * The partial unique index on `(company_id, email) WHERE status = 'pending'`
 * prevents duplicate pending invitations for the same email per company.
 *
 * Cascade on company delete so invitations are removed when a company is
 * deleted.
 */
export const companyInvitations = pgTable(
  'company_invitations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull(),
    status: text('status', {
      enum: ['pending', 'accepted', 'revoked', 'expired'],
    })
      .notNull()
      .default('pending'),
    invitedByUserId: text('invited_by_user_id').notNull(),
    acceptedByUserId: text('accepted_by_user_id'),
    acceptedAt: timestamp('accepted_at', { mode: 'date', precision: 3 }),
    expiresAt: timestamp('expires_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_company_invitations_pending_company_email')
      .on(table.companyId, table.email)
      .where(sql`${table.status} = 'pending'`),
    index('idx_company_invitations_pending_email')
      .on(table.email)
      .where(sql`${table.status} = 'pending'`),
  ],
);
