import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';

/**
 * Immutable command ingress ledger.
 *
 * Every mutation is a durable command. Start uses
 * `(company_id, project_id, idempotency_key)` because no run exists yet; run
 * commands use `(company_id, run_id, idempotency_key)`. Identical key plus
 * identical request hash returns the original response; the same key with
 * different content returns 409 IDEMPOTENCY_KEY_REUSED. A rejected command
 * remains audited but cannot change run state.
 */
export const runCommands = pgTable(
  'run_commands',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => missionRuns.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: [
        'run.start',
        'questions.answer',
        'plan.revision_request',
        'plan.approve',
        'plan.reject',
        'run.cancel',
        'run.retry',
      ],
    }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    // Encrypted/redacted payload. Encryption-at-rest hardening is a later
    // feature; the column exists now so the aggregate contract is complete.
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>(),
    actorType: text('actor_type', {
      enum: ['user', 'agent', 'system'],
    }).notNull(),
    actorId: text('actor_id'),
    expectedStateVersion: integer('expected_state_version'),
    status: text('status', {
      enum: ['received', 'applied', 'rejected'],
    })
      .notNull()
      .default('received'),
    resultStatusCode: integer('result_status_code'),
    resultBody: jsonb('result_body').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    appliedAt: timestamp('applied_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    // Start idempotency: no run exists yet, so scope by project.
    uniqueIndex('uq_run_commands_start_idempotency').on(
      table.companyId,
      table.projectId,
      table.idempotencyKey,
    ),
    // Run-command idempotency: scope by run.
    uniqueIndex('uq_run_commands_run_idempotency').on(
      table.companyId,
      table.runId,
      table.idempotencyKey,
    ),
    index('idx_run_commands_run_created').on(table.runId, table.createdAt),
  ],
);
