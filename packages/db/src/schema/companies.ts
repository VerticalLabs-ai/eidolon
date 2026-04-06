import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

export const companies = sqliteTable('companies', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  name: text('name').notNull(),
  description: text('description'),
  mission: text('mission'),
  status: text('status', { enum: ['active', 'paused', 'archived'] })
    .notNull()
    .default('active'),
  budgetMonthlyCents: integer('budget_monthly_cents').notNull().default(0),
  spentMonthlyCents: integer('spent_monthly_cents').notNull().default(0),
  settings: text('settings', { mode: 'json' })
    .notNull()
    .$type<Record<string, unknown>>()
    .default({}),
  brandColor: text('brand_color'),
  logoUrl: text('logo_url'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});
