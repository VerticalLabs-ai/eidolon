import { timestamp } from 'drizzle-orm/pg-core';

/**
 * Fresh audit columns for each table. The factory is intentionally invoked by
 * every schema declaration because Drizzle column builders cannot be shared
 * between tables.
 */
export function auditTimestamps() {
  return {
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  };
}
