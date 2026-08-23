import {
  pgTable,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';

/**
 * Company-defined custom Mission mode profiles.
 *
 * Built-in modes (fast, deep_work, analyst, auto) are code-owned, versioned
 * constants in `server/src/services/mission/modes.ts` and are NOT editable
 * rows. Custom profiles may only narrow company/platform policy — they can
 * never broaden authority.
 *
 * Administration is versioned (optimistic concurrency via `version`), authorized
 * (`company.settings.update` permission, owner/admin only), and attributable
 * (creator/updater user IDs + activity log entries). Profile deletion and soft
 * deletion are NOT Phase 1 operations; `disabled` (enabled=false) is the sole
 * unavailable lifecycle.
 *
 * `config` stores the closed, bounded, inert profile payload validated by
 * `server/src/services/mission/mode-profile-schema.ts`. Private instructions
 * are stored server-side only and never appear in selector responses.
 */
export const modeProfiles = pgTable(
  'mode_profiles',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** Unique within the company. Slug: [a-z0-9][a-z0-9-]{0,63}. */
    slug: text('slug').notNull(),
    /** Display name, 1–100 Unicode code points. */
    name: text('name').notNull(),
    /** Description, at most 1,000 Unicode code points. */
    description: text('description'),
    /** Sole lifecycle control: true = selectable, false = hidden/unusable. */
    enabled: boolean('enabled').notNull().default(true),
    /** Closed, bounded, inert profile configuration (validated Zod JSONB). */
    config: jsonb('config').notNull().$type<Record<string, unknown>>().default({}),
    /** Optimistic concurrency version; incremented on every update. */
    version: integer('version').notNull().default(1),
    /** Creating user ID (authenticated actor, never from request body). */
    createdBy: text('created_by'),
    /** Last updating user ID (authenticated actor, never from request body). */
    updatedBy: text('updated_by'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_mode_profiles_company_slug').on(table.companyId, table.slug),
    index('idx_mode_profiles_company_enabled').on(table.companyId, table.enabled),
  ],
);
