import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { projectThreads } from './project_threads.js';
import { agents } from './agents.js';
import { runPolicySnapshots } from './run_policy_snapshots.js';

/**
 * Authoritative Mission run record.
 *
 * Postgres is the system of record; the browser, EventBus, and WebSocket
 * messages are projections. Every tenant-owned row carries `company_id`.
 * Terminal statuses (`completed`, `failed`, `cancelled`) are immutable at
 * the module interface; retry creates a new run linked by `retry_of_run_id`.
 *
 * Columns referencing not-yet-existing tables (question sets, plan revisions)
 * are nullable text without FK constraints; later migrations add those
 * tables and their FK constraints. This keeps the column contract complete
 * while the schema stays additive and forward-only.
 */
export const missionRuns = pgTable(
  'mission_runs',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    projectThreadId: text('project_thread_id')
      .notNull()
      .references(() => projectThreads.id, { onDelete: 'cascade' }),
    // Root points to self after insert; parent/retry are same-company. FK to
    // self is added in the migration to avoid a circular module reference.
    rootRunId: text('root_run_id').notNull(),
    parentRunId: text('parent_run_id'),
    retryOfRunId: text('retry_of_run_id'),
    depth: integer('depth').notNull().default(0),
    childOrdinal: integer('child_ordinal'),
    initiatingUserId: text('initiating_user_id'),
    initiatingAgentId: text('initiating_agent_id').references(() => agents.id),
    executingAgentId: text('executing_agent_id').references(() => agents.id),
    billingAgentId: text('billing_agent_id').references(() => agents.id),
    routingKind: text('routing_kind', {
      enum: ['company_agent', 'ephemeral'],
    })
      .notNull()
      .default('company_agent'),
    // Encrypted/redactable structured request envelope. Encryption-at-rest
    // hardening is a later feature; the column exists now so the aggregate
    // contract is complete.
    requestEnvelope: jsonb('request_envelope').notNull().$type<Record<string, unknown>>(),
    requestContentHash: text('request_content_hash').notNull(),
    // Nullable text; FK to mode_profiles added when that table is created.
    modeProfileId: text('mode_profile_id'),
    resolvedMode: text('resolved_mode', {
      enum: ['fast', 'deep_work', 'analyst', 'auto', 'custom'],
    }).notNull(),
    policySnapshotId: text('policy_snapshot_id').references(() => runPolicySnapshots.id),
    status: text('status', {
      enum: [
        'draft',
        'awaiting_input',
        'planning',
        'awaiting_approval',
        'queued',
        'running',
        'synthesizing',
        'completed',
        'failed',
        'cancelled',
      ],
    })
      .notNull()
      .default('draft'),
    stateVersion: integer('state_version').notNull().default(1),
    lastEventSequence: bigint('last_event_sequence', { mode: 'number' }).notNull().default(0),
    waitingFromStatus: text('waiting_from_status', {
      enum: ['planning', 'running'],
    }),
    // Nullable text; FKs added when question/plan tables are created.
    currentQuestionSetId: text('current_question_set_id'),
    currentPlanRevisionId: text('current_plan_revision_id'),
    approvedPlanRevisionId: text('approved_plan_revision_id'),
    partialResultPolicy: text('partial_result_policy', {
      enum: ['require_all', 'best_effort'],
    })
      .notNull()
      .default('require_all'),
    availableAt: timestamp('available_at', { mode: 'date', precision: 3, withTimezone: true }),
    leaseOwner: text('lease_owner'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }),
    heartbeatAt: timestamp('heartbeat_at', { mode: 'date', precision: 3, withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    providerCallCount: integer('provider_call_count').notNull().default(0),
    descendantCount: integer('descendant_count').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    outputBytes: integer('output_bytes').notNull().default(0),
    actualCostCents: integer('actual_cost_cents').notNull().default(0),
    cancelRequestedAt: timestamp('cancel_requested_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }),
    cancelRequestedBy: text('cancel_requested_by'),
    failureCategory: text('failure_category'),
    failureCode: text('failure_code'),
    safeErrorMessage: text('safe_error_message'),
    startedAt: timestamp('started_at', { mode: 'date', precision: 3, withTimezone: true }),
    terminalAt: timestamp('terminal_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_mission_runs_company_id').on(table.companyId, table.id),
    uniqueIndex('uq_mission_runs_parent_ordinal').on(table.parentRunId, table.childOrdinal),
    index('idx_mission_runs_company_project_created').on(
      table.companyId,
      table.projectId,
      table.createdAt,
    ),
    index('idx_mission_runs_status_scope').on(table.companyId, table.projectId, table.status),
    // Partial claim index for worker-eligible nonterminal states whose lease
    // is null or expired. Workers scan this with FOR UPDATE SKIP LOCKED.
    index('idx_mission_runs_claim').on(table.status, table.availableAt, table.leaseExpiresAt),
  ],
);
