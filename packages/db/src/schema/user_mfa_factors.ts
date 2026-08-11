import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

/**
 * MFA factors enrolled by a user (M8 enterprise security).
 *
 * `userId` is the application user id. In `local_trusted` mode this is
 * `dev-user-000` or a created test user id. In Clerk mode this is the Clerk
 * user id. Factors are account-scoped (not company-scoped) — MFA protects
 * the user's identity across companies — so `companyId` is nullable and
 * only populated when a factor was enrolled from a company security surface.
 *
 * The TOTP `secret` is stored base32-encoded. In production this should be
 * encrypted at rest (M8 encryption hardening); in dev/validation it is stored
 * as-is so the verify path is deterministic and testable without a key vault.
 */
export const userMfaFactors = pgTable(
  'user_mfa_factors',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    companyId: text('company_id'),
    type: text('type', { enum: ['totp'] }).notNull().default('totp'),
    secret: text('secret').notNull(),
    label: text('label'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_user_mfa_factors_user').on(table.userId, table.status),
    uniqueIndex('uq_user_mfa_factors_user_secret').on(table.userId, table.secret),
  ],
);
