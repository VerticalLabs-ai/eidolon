import { pgTable, text, timestamp, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';

/**
 * Local-trusted sessions with a mutable org role (M8 enterprise security).
 *
 * VAL-SEC-011 requires that when a user's role is downgraded or they are
 * removed from a company, their EXISTING session can no longer perform
 * now-disallowed operations on the next request without re-authentication.
 *
 * In `local_trusted` mode the only real user is `dev-user-000` and the org
 * role is normally injected via the `X-Eidolon-Test-Org-Role` header. That
 * header is caller-controlled, so it cannot model a server-side downgrade of
 * a live session. This table provides a server-side, mutable session token:
 *
 *  - A test creates a session via `POST /api/auth/local-trusted/create-session`
 *    with a starting role and receives a `sessionId`.
 *  - Requests pass `X-Eidolon-Test-Session-Id: <sessionId>`; the auth
 *    middleware looks up the session and uses its stored role (overriding the
 *    header). If `active=false` the request is rejected with 401.
 *  - A downgrade (`POST .../members/:userId/role`) or removal
 *    (`DELETE .../members/:userId`) updates/revokes the session row, so the
 *    SAME session token yields the downgraded role (or 401) on the next
 *    request — modeling live session invalidation on privilege loss.
 *
 * Only available when `AUTH_MODE=local_trusted`. In Clerk mode, session
 * invalidation on role change is handled by Clerk's session token refresh.
 */
export const localTrustedSessions = pgTable(
  'local_trusted_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] })
      .notNull()
      .default('member'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_local_trusted_sessions_company_user').on(table.companyId, table.userId),
    index('idx_local_trusted_sessions_user').on(table.userId),
  ],
);
