import {
  pgTable,
  text,
  integer,
  doublePrecision,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';

export const agents = pgTable(
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
    // Schema default is intentionally lagging behind the app-level default set
    // in agents route (CreateAgentBody.model). We keep this stable and rely on
    // Zod at the API boundary to apply the current preferred model.
    model: text('model').notNull().default('claude-sonnet-4-6'),
    status: text('status', {
      enum: ['idle', 'working', 'paused', 'error', 'offline'],
    })
      .notNull()
      .default('idle'),
    reportsTo: text('reports_to').references((): any => agents.id),
    capabilities: jsonb('capabilities')
      .notNull()
      .$type<string[]>()
      .default([]),
    systemPrompt: text('system_prompt'),
    apiKeyEncrypted: text('api_key_encrypted'),
    apiKeyProvider: text('api_key_provider'),
    instructions: text('instructions'),
    instructionsFormat: text('instructions_format').default('markdown'),
    temperature: doublePrecision('temperature').default(0.7),
    maxTokens: integer('max_tokens').default(4096),
    toolsEnabled: jsonb('tools_enabled')
      .notNull()
      .$type<string[]>()
      .default([]),
    allowedDomains: jsonb('allowed_domains')
      .notNull()
      .$type<string[]>()
      .default([]),
    maxConcurrentTasks: integer('max_concurrent_tasks').notNull().default(1),
    heartbeatIntervalSeconds: integer('heartbeat_interval_seconds').notNull().default(300),
    executionTimeoutSeconds: integer('execution_timeout_seconds').notNull().default(600),
    // 0/1 integer: route handlers and scheduler literally check `=== 1`.
    autoAssignTasks: integer('auto_assign_tasks').notNull().default(0),
    defaultEnvironmentId: text('default_environment_id'),
    budgetMonthlyCents: integer('budget_monthly_cents').notNull().default(0),
    spentMonthlyCents: integer('spent_monthly_cents').notNull().default(0),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { mode: 'date', precision: 3 }),
    config: jsonb('config')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    metadata: jsonb('metadata')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    permissions: jsonb('permissions')
      .notNull()
      .$type<string[]>()
      .default([]),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agents_company_status').on(table.companyId, table.status),
  ],
);
