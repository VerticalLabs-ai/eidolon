import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';

/**
 * Tool/external-call invocation ledger.
 *
 * Tool invocations are written to `run_tool_invocations` BEFORE execution
 * with a deterministic key `(run_id, step_key, attempt, tool_id, ordinal)`
 * and a declared replay class. This lets recovery distinguish effects:
 *
 *  - `read_only` may retry safely.
 *  - `idempotent_write` retries only through an adapter idempotency
 *    key/reconciliation read.
 *  - `non_replayable` in `started` or `unknown` NEVER repeats automatically.
 *    Recovery exposes reconciliation or terminal `unknown_effect` failure
 *    with retry guidance (VAL-RUN-086).
 *
 * State transitions: `prepared -> started -> succeeded|failed|cancelled|unknown`.
 * `unknown` is used after lease loss when an irreversible call may have
 * happened but no result was committed.
 */
export const runToolInvocations = pgTable(
  'run_tool_invocations',
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
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    /** Stable step key from the approved plan, or 'root' for root execution. */
    stepKey: text('step_key').notNull(),
    /** Attempt number within the run. */
    attempt: integer('attempt').notNull(),
    /** Exact qualified tool identifier (e.g., 'artifact.create', 'research.search'). */
    toolId: text('tool_id').notNull(),
    /** Ordinal within the same step/attempt/tool (for parallel calls). */
    ordinal: integer('ordinal').notNull().default(0),
    /**
     * Replay class determines how recovery handles re-execution:
     * - `read_only`: safe to retry.
     * - `idempotent_write`: retry via adapter idempotency key.
     * - `non_replayable`: never repeat automatically.
     */
    replayClass: text('replay_class', {
      enum: ['read_only', 'idempotent_write', 'non_replayable'],
    }).notNull(),
    /**
     * Invocation state:
     * - `prepared`: written before execution.
     * - `started`: execution in progress.
     * - `succeeded`: completed successfully.
     * - `failed`: completed with failure.
     * - `cancelled`: aborted before effect.
     * - `unknown`: lease lost during execution; effect may or may not have happened.
     */
    state: text('state', {
      enum: ['prepared', 'started', 'succeeded', 'failed', 'cancelled', 'unknown'],
    }).notNull(),
    /** Safe, sanitized arguments summary (never secrets/prompts). */
    argsSummary: jsonb('args_summary').$type<Record<string, unknown>>(),
    /** Safe result summary when succeeded/failed (never raw provider content). */
    resultSummary: jsonb('result_summary').$type<Record<string, unknown>>(),
    /** Stable logical call ID for effect deduplication. */
    logicalCallId: text('logical_call_id'),
    /** Provider request ID hash (for settlement dedup). */
    providerRequestIdHash: text('provider_request_id_hash'),
    /** External call ID for settlement linkage. */
    externalCallId: text('external_call_id'),
    /** Cost in integer cents if this invocation was charged. */
    costCents: integer('cost_cents').notNull().default(0),
    /** Trace ID for correlation. */
    traceId: text('trace_id'),
    startedAt: timestamp('started_at', { mode: 'date', precision: 3, withTimezone: true }),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_tool_invocations_deterministic').on(
      table.runId,
      table.stepKey,
      table.attempt,
      table.toolId,
      table.ordinal,
    ),
    index('idx_run_tool_invocations_run').on(table.runId, table.state),
    index('idx_run_tool_invocations_company').on(table.companyId, table.runId),
  ],
);
