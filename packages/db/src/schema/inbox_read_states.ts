import { sqliteTable, text, integer, uniqueIndex, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

/**
 * Per-user read state for inbox items.
 *
 * Each row marks that a specific user has read a specific composite item id
 * (e.g. "approval:<uuid>", "collaboration:<uuid>", "activity:<uuid>") inside
 * a particular company. The `(userId, companyId, itemId)` uniqueness lets
 * the /inbox route left-join this table and expose `readAt` per item.
 */
export const inboxReadStates = sqliteTable(
  'inbox_read_states',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    userId: text('user_id').notNull(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    itemId: text('item_id').notNull(),
    readAt: integer('read_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_inbox_read_states_user_company_item').on(
      table.userId,
      table.companyId,
      table.itemId,
    ),
    index('idx_inbox_read_states_user_company').on(
      table.userId,
      table.companyId,
    ),
  ],
);
