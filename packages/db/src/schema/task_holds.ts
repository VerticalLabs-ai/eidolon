import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { tasks } from './tasks.js';

export const taskHolds = pgTable(
  'task_holds',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    action: text('action', { enum: ['pause', 'cancel'] }).notNull(),
    status: text('status', { enum: ['active', 'restored'] })
      .notNull()
      .default('active'),
    previousStatus: text('previous_status'),
    reason: text('reason'),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    resolvedAt: timestamp('resolved_at', { mode: 'date', precision: 3 }),
  },
  (table) => [
    index('idx_task_holds_company_task').on(table.companyId, table.taskId),
    index('idx_task_holds_active').on(table.companyId, table.status),
    uniqueIndex('uq_task_holds_active_action').on(
      table.companyId,
      table.taskId,
      table.action,
      table.status,
    ),
  ],
);
