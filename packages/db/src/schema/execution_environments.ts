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
      .references(() => companies.id),
    name: text('name').notNull(),
    provider: text('provider', { enum: ['local'] }).notNull().default('local'),
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
    leasedAt: timestamp('leased_at', { mode: 'date', precision: 3 }),
    releasedAt: timestamp('released_at', { mode: 'date', precision: 3 }),
    metadata: jsonb('metadata')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_execution_environments_company').on(table.companyId, table.status),
    index('idx_execution_environments_lease').on(table.leaseOwnerAgentId),
  ],
);
