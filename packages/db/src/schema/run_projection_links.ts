import { pgTable, text, bigint, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';

/**
 * Projection link registry.
 *
 * Tracks every idempotent projection from an authoritative Mission run to a
 * mutable surface (project thread items, activity log, etc.). Each link
 * carries a deterministic `surface_key` so replay/repair converges once:
 * a duplicate insert is a no-op, not a second row.
 *
 * Projection links are **not** authority. They record that a projection
 * happened; the authoritative state lives in `mission_runs` and `run_events`.
 * A projection failure records a retryable error here and in the journal
 * (`projection.failed`); repair updates the status and emits
 * `projection.repaired` (VAL-CROSS-075, VAL-RUN-099, VAL-RUN-100).
 */
export const runProjectionLinks = pgTable(
  'run_projection_links',
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
    /** Projection surface: 'thread_item', 'activity_log', etc. */
    surface: text('surface').notNull(),
    /** ID of the projected row in the target surface table. */
    surfaceId: text('surface_id').notNull(),
    /** Deterministic key for idempotent dedup: `${surface}:${eventSequence}`
     *  or `${surface}:${eventSequence}:${subKey}`. */
    surfaceKey: text('surface_key').notNull(),
    /** The run event type that triggered this projection. */
    eventType: text('event_type'),
    /** The run event sequence that triggered this projection. */
    eventSequence: bigint('event_sequence', { mode: 'number' }),
    /** 'active' (projected), 'failed' (projection error, retryable),
     *  'repaired' (failure was repaired). */
    status: text('status', {
      enum: ['active', 'failed', 'repaired'],
    })
      .notNull()
      .default('active'),
    /** Safe error message when status='failed'. */
    errorMessage: text('error_message'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_projection_links_surface_key').on(
      table.companyId,
      table.runId,
      table.surface,
      table.surfaceKey,
    ),
    index('idx_run_projection_links_run').on(table.runId, table.surface),
    index('idx_run_projection_links_status').on(table.companyId, table.runId, table.status),
  ],
);
