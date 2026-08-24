import { pgTable, text, integer, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { researchSourceRevisions } from './research_sources.js';
import { researchAttempts } from './research_attempts.js';

/**
 * Source availability check records — explicit, nonmutating availability
 * refresh linked to an immutable source revision.
 *
 * (architecture.md: VAL-RES-119)
 *
 * `POST .../source-revisions/:sourceRevisionId/availability-checks` is an
 * authorized, idempotent, separately budgeted and cancellable logical call
 * under current URL/network policy. It appends availability metadata linked
 * to the immutable revision but NEVER mutates the source revision,
 * citation, artifact, or original retrieval. No automatic polling occurs.
 *
 * Forward-only and additive: one new table. No changes to existing enums
 * or constraints.
 */
export const researchSourceAvailabilityChecks = pgTable(
  'research_source_availability_checks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    rootRunId: text('root_run_id').notNull(),
    sourceRevisionId: text('source_revision_id')
      .notNull()
      .references(() => researchSourceRevisions.id, { onDelete: 'cascade' }),
    /** Deterministic logical call ID for the availability-check call. */
    logicalCallId: text('logical_call_id').notNull(),
    /** The budgeted research attempt backing this availability check. */
    attemptId: text('attempt_id').references(() => researchAttempts.id, {
      onDelete: 'set null',
    }),
    /** The canonical URL that was checked. */
    checkedUrl: text('checked_url').notNull(),
    /** available | unavailable | unknown. */
    status: text('status').notNull(),
    httpStatus: integer('http_status'),
    /** Bounded safe warning/reason (no credentials, no body). */
    warning: text('warning'),
    /** Idempotency key for the check (bounded safe characters). */
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_availability_checks_revision_key').on(
      table.sourceRevisionId,
      table.idempotencyKey,
    ),
    index('idx_availability_checks_run').on(table.runId),
    index('idx_availability_checks_revision').on(table.sourceRevisionId),
  ],
);
