import { pgTable, text, bigint, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';

/**
 * Root-local descendant progress mirror records.
 *
 * (VAL-SUB-058, VAL-SUB-092, VAL-SUB-112)
 *
 * Each row records that a descendant source event was mirrored to the root
 * run journal as a `descendant.progressed` event. The unique constraint on
 * `(root_run_id, descendant_run_id, source_sequence)` prevents duplicate
 * mirrors and cycles — a mirror is only ever created from an authoritative
 * local descendant event, never from another mirror.
 *
 * The per-descendant watermark (MAX(source_sequence)) tracks how far
 * mirroring has progressed for each descendant. Root synthesis and
 * terminalization must wait for all relevant terminal watermarks before
 * proceeding (VAL-SUB-092, VAL-SUB-112).
 *
 * No post-terminal mirror is legal: once the root run is terminal, no
 * further descendant mirrors may be appended to the root journal.
 */
export const runDescendantMirrors = pgTable(
  'run_descendant_mirrors',
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
    rootRunId: text('root_run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    descendantRunId: text('descendant_run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    /** The run-local sequence of the source event on the descendant run. */
    sourceSequence: bigint('source_sequence', { mode: 'number' }).notNull(),
    /** The type of the source event (e.g. `child.started`, `run.completed`). */
    sourceEventType: text('source_event_type').notNull(),
    /** The root run journal sequence where the mirror event was emitted. */
    rootEventSequence: bigint('root_event_sequence', { mode: 'number' }).notNull(),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_descendant_mirrors_root_desc_source').on(
      table.rootRunId,
      table.descendantRunId,
      table.sourceSequence,
    ),
    index('idx_run_descendant_mirrors_root_desc').on(table.rootRunId, table.descendantRunId),
    index('idx_run_descendant_mirrors_company_project').on(table.companyId, table.projectId),
  ],
);
