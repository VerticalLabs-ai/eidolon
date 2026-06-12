import { pgTable, text, integer, boolean, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { tasks } from './tasks.js';
import { agentExecutions } from './agent_executions.js';
import { executionEnvironments } from './execution_environments.js';
import { mcpServers } from './mcp_servers.js';

export const agentRuntimeSessions = pgTable(
  'agent_runtime_sessions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    executionId: text('execution_id').references(() => agentExecutions.id, { onDelete: 'set null' }),
    environmentId: text('environment_id').references(() => executionEnvironments.id, { onDelete: 'set null' }),
    runId: text('run_id').notNull(),
    adapterId: text('adapter_id').notNull(),
    adapterConfig: jsonb('adapter_config')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    mode: text('mode', {
      enum: ['on_demand', 'scheduled', 'continuous', 'manual', 'recovery'],
    })
      .notNull()
      .default('on_demand'),
    status: text('status', {
      enum: ['queued', 'running', 'cancelling', 'cancelled', 'finalizing', 'finalized', 'completed', 'failed'],
    })
      .notNull()
      .default('queued'),
    resumeState: jsonb('resume_state')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    transcript: jsonb('transcript')
      .notNull()
      .$type<Array<Record<string, unknown>>>()
      .default([]),
    cancellationReason: text('cancellation_reason'),
    finalizeRequired: boolean('finalize_required').notNull().default(true),
    finalizedAt: timestamp('finalized_at', { mode: 'date', precision: 3, withTimezone: true }),
    startedAt: timestamp('started_at', { mode: 'date', precision: 3, withTimezone: true }),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_agent_runtime_sessions_run_id').on(table.runId),
    index('idx_agent_runtime_sessions_company_status').on(table.companyId, table.status),
    index('idx_agent_runtime_sessions_agent').on(table.agentId, table.createdAt),
    index('idx_agent_runtime_sessions_environment').on(table.environmentId),
  ],
);

export const mcpToolCalls = pgTable(
  'mcp_tool_calls',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    serverId: text('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => agentRuntimeSessions.id, { onDelete: 'set null' }),
    executionId: text('execution_id').references(() => agentExecutions.id, { onDelete: 'set null' }),
    toolName: text('tool_name').notNull(),
    arguments: jsonb('arguments')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    status: text('status', { enum: ['started', 'succeeded', 'failed'] })
      .notNull()
      .default('started'),
    isError: boolean('is_error').notNull().default(false),
    error: text('error'),
    startedAt: timestamp('started_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    index('idx_mcp_tool_calls_company').on(table.companyId, table.startedAt),
    index('idx_mcp_tool_calls_session').on(table.sessionId, table.startedAt),
    index('idx_mcp_tool_calls_server').on(table.serverId, table.startedAt),
  ],
);

export const companySkills = pgTable(
  'company_skills',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    version: text('version').notNull().default('1.0.0'),
    source: text('source').notNull().default('manual'),
    provenance: text('provenance', {
      enum: ['bundled', 'catalog', 'runtime', 'adapter', 'github', 'manual'],
    })
      .notNull()
      .default('manual'),
    trustLevel: text('trust_level', {
      enum: ['markdown_only', 'assets', 'scripts_executables'],
    })
      .notNull()
      .default('markdown_only'),
    entrypoint: text('entrypoint'),
    content: text('content').notNull(),
    metadata: jsonb('metadata')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    tags: jsonb('tags')
      .notNull()
      .$type<string[]>()
      .default([]),
    installedByUserId: text('installed_by_user_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_company_skills_name_version').on(table.companyId, table.name, table.version),
    index('idx_company_skills_company').on(table.companyId, table.name),
  ],
);

export const agentSkills = pgTable(
  'agent_skills',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    skillId: text('skill_id')
      .notNull()
      .references(() => companySkills.id, { onDelete: 'cascade' }),
    syncStatus: text('sync_status', {
      enum: ['pending', 'synced', 'failed', 'disabled'],
    })
      .notNull()
      .default('pending'),
    materializedPath: text('materialized_path'),
    lastSyncedAt: timestamp('last_synced_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_agent_skills_agent_skill').on(table.agentId, table.skillId),
    index('idx_agent_skills_company_agent').on(table.companyId, table.agentId),
  ],
);

export const routines = pgTable(
  'routines',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    mode: text('mode', {
      enum: ['scheduled', 'continuous', 'on_demand'],
    })
      .notNull()
      .default('scheduled'),
    jarvisMode: text('jarvis_mode', {
      enum: ['daily_briefing', 'monitoring', 'research', 'follow_up', 'custom'],
    })
      .notNull()
      .default('custom'),
    schedule: text('schedule'),
    prompt: text('prompt').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    variables: jsonb('variables')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    workspacePolicy: jsonb('workspace_policy')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    lastTriggeredAt: timestamp('last_triggered_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_routines_company_enabled').on(table.companyId, table.enabled),
    index('idx_routines_agent').on(table.agentId),
  ],
);
