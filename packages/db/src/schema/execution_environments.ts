import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { agentExecutions } from './agent_executions.js';

export const executionEnvironments = pgTable(
  'execution_environments',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider').notNull().default('local'),
    status: text('status', {
      enum: ['available', 'leased', 'offline', 'archived'],
    })
      .notNull()
      .default('available'),
    workspacePath: text('workspace_path'),
    branchName: text('branch_name'),
    runtimeUrl: text('runtime_url'),
    leaseOwnerAgentId: text('lease_owner_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    leaseOwnerExecutionId: text('lease_owner_execution_id').references(() => agentExecutions.id, { onDelete: 'set null' }),
    leaseId: text('lease_id'),
    leasedAt: timestamp('leased_at', { mode: 'date', precision: 3, withTimezone: true }),
    leaseHeartbeatAt: timestamp('lease_heartbeat_at', { mode: 'date', precision: 3, withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { mode: 'date', precision: 3, withTimezone: true }),
    leaseBaseSha: text('lease_base_sha'),
    releasedAt: timestamp('released_at', { mode: 'date', precision: 3, withTimezone: true }),
    metadata: jsonb('metadata')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_execution_environments_company').on(table.companyId, table.status),
    index('idx_execution_environments_lease').on(table.leaseOwnerAgentId),
    index('idx_execution_environments_execution').on(table.leaseOwnerExecutionId),
    index('idx_execution_environments_lease_expiry').on(table.companyId, table.status, table.leaseExpiresAt),
  ],
);

export const workspaceLifecycleEvents = pgTable(
  'workspace_lifecycle_events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    // This trail is append-only and must outlive the environment it describes, so the
    // environment id is recorded as a plain value rather than a cascading foreign key.
    // Per-tenant cleanup still happens through the cascading company reference above.
    environmentId: text('environment_id').notNull(),
    leaseId: text('lease_id'),
    eventType: text('event_type', {
      enum: ['created', 'leased', 'released', 'finalized', 'recovered'],
    }).notNull(),
    actorAgentId: text('actor_agent_id').references(() => agents.id, { onDelete: 'set null' }),
    actorExecutionId: text('actor_execution_id').references(() => agentExecutions.id, { onDelete: 'set null' }),
    metadata: jsonb('metadata')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_workspace_lifecycle_events_environment').on(table.environmentId, table.createdAt),
    index('idx_workspace_lifecycle_events_company').on(table.companyId, table.createdAt),
    index('idx_workspace_lifecycle_events_lease').on(table.leaseId),
  ],
);
