import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const agents = sqliteTable(
  'agents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    role: text('role', {
      enum: ['ceo', 'cto', 'cfo', 'engineer', 'designer', 'marketer', 'sales', 'support', 'hr', 'custom'],
    }).notNull(),
    title: text('title'),
    provider: text('provider', {
      enum: ['anthropic', 'openai', 'google', 'local'],
    })
      .notNull()
      .default('anthropic'),
    model: text('model').notNull().default('claude-sonnet-4-6'),
    status: text('status', {
      enum: ['idle', 'working', 'paused', 'error', 'offline'],
    })
      .notNull()
      .default('idle'),
    reportsTo: text('reports_to').references((): any => agents.id),
    capabilities: text('capabilities', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    systemPrompt: text('system_prompt'),
    apiKeyEncrypted: text('api_key_encrypted'),
    apiKeyProvider: text('api_key_provider'),
    instructions: text('instructions'),
    instructionsFormat: text('instructions_format').default('markdown'),
    temperature: real('temperature').default(0.7),
    maxTokens: integer('max_tokens').default(4096),
    toolsEnabled: text('tools_enabled', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    allowedDomains: text('allowed_domains', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    maxConcurrentTasks: integer('max_concurrent_tasks').notNull().default(1),
    heartbeatIntervalSeconds: integer('heartbeat_interval_seconds').notNull().default(300),
    executionTimeoutSeconds: integer('execution_timeout_seconds').notNull().default(600),
    autoAssignTasks: integer('auto_assign_tasks').notNull().default(0),
    budgetMonthlyCents: integer('budget_monthly_cents').notNull().default(0),
    spentMonthlyCents: integer('spent_monthly_cents').notNull().default(0),
    lastHeartbeatAt: integer('last_heartbeat_at', { mode: 'timestamp_ms' }),
    config: text('config', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    metadata: text('metadata', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    permissions: text('permissions', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agents_company_status').on(table.companyId, table.status),
  ],
);
