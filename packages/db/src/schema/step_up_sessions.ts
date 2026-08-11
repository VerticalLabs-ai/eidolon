import { pgTable, text, timestamp, boolean, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

/**
 * Step-up re-authentication sessions (M8 enterprise security).
 *
 * When a user completes an MFA challenge (or re-verifies credentials) for a
 * sensitive operation, a step-up session is granted with a bounded validity
 * window (`expiresAt`). Sensitive handlers check for a valid (not expired,
 * not revoked) session matching the required `scope` before proceeding.
 *
 * Scopes are coarse-grained sensitive-operation categories:
 *  - `company_delete`           — hard-deleting a company
 *  - `artifact_permanent_delete`— permanently deleting an artifact (vs soft)
 *  - `artifact_transfer`        — transferring artifact ownership
 *  - `sensitive_action`         — generic MFA-gated sensitive action
 *
 * The window is enforced by `expiresAt`; `revokedAt` allows early invalidation.
 */
export const stepUpSessions = pgTable(
  'step_up_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    companyId: text('company_id'),
    scope: text('scope').notNull(),
    grantedAt: timestamp('granted_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: timestamp('expires_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date', precision: 3, withTimezone: true }),
    consumed: boolean('consumed').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_step_up_sessions_user_scope').on(table.userId, table.scope, table.expiresAt),
    index('idx_step_up_sessions_company').on(table.companyId),
  ],
);
