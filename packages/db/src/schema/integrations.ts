import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';

export const integrations = pgTable(
  'integrations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    config: text('config').notNull().default('{}'),
    credentialsEncrypted: text('credentials_encrypted'),
    status: text('status').notNull().default('active'),
    healthStatus: text('health_status', {
      enum: ['healthy', 'degraded', 'error', 'unknown'],
    })
      .notNull()
      .default('unknown'),
    lastHealthCheckAt: timestamp('last_health_check_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }),
    healthError: text('health_error'),
    healthCheckMethod: text('health_check_method'),
    lastUsedAt: timestamp('last_used_at', { mode: 'date', precision: 3 }),
    usageCount: integer('usage_count').notNull().default(0),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_integrations_company').on(table.companyId),
    index('idx_integrations_company_project').on(table.companyId, table.projectId),
    index('idx_integrations_company_health').on(table.companyId, table.healthStatus),
  ],
);
