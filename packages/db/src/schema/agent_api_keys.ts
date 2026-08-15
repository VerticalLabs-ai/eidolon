import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';

/**
 * Agent API keys — scoped bearer credentials for agent authentication.
 *
 * API keys allow agents (or other programmatic clients) to authenticate
 * against company-scoped endpoints without a Clerk session. The raw key
 * (`eid_live_<random>`) is returned only once on creation; only its SHA-256
 * hex hash is stored in `keyHash`. The `keyPrefix` stores the first 10
 * characters for display purposes.
 *
 * Keys are role-scoped (default `member`) and company-scoped. Revocation is
 * a soft delete via `revokedAt`. Optional expiry via `expiresAt`.
 *
 * `agentId` is an optional binding to a specific agent. On agent delete, the
 * key is unbound (set to null) rather than removed.
 *
 * Cascade on company delete so keys are removed when a company is deleted.
 */
export const agentApiKeys = pgTable(
  'agent_api_keys',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] })
      .notNull()
      .default('member'),
    lastUsedAt: timestamp('last_used_at', { mode: 'date', precision: 3 }),
    expiresAt: timestamp('expires_at', { mode: 'date', precision: 3 }),
    createdByUserId: text('created_by_user_id').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    revokedAt: timestamp('revoked_at', { mode: 'date', precision: 3 }),
  },
  (table) => [
    uniqueIndex('uq_agent_api_keys_hash').on(table.keyHash),
    index('idx_agent_api_keys_company_active')
      .on(table.companyId)
      .where(sql`${table.revokedAt} IS NULL`),
  ],
);
