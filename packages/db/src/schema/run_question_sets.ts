import { pgTable, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';

/**
 * Authoritative question-set record.
 *
 * A run exposes at most one open question set at a time
 * (VAL-MODEQ-130). Its `current_question_set_id` pointer on
 * `mission_runs` identifies the current set. Replacement atomically
 * invalidates the old set with a safe reason, emits invalidation before
 * the new request, and never exposes two actionable sets.
 *
 * `ordinal` is per-run and starts at 1. `version` starts at 1 and is
 * incremented only when the authoritative definition/state changes
 * (VAL-MODEQ-075). The maximum of 3 sets per run counts all created
 * answered and invalidated sets (VAL-MODEQ-059).
 *
 * States: `open` → `answered` | `invalidated`. An invalidated set cannot
 * accept answers (VAL-MODEQ-076). Once execution resumes, answers cannot
 * be edited silently (VAL-MODEQ-069).
 */
export const runQuestionSets = pgTable(
  'run_question_sets',
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
    /** Per-run monotonic ordinal, starting at 1. */
    ordinal: integer('ordinal').notNull(),
    /**
     * Monotonic integer version beginning at 1, incremented only when
     * the authoritative definition/state changes (VAL-MODEQ-075).
     */
    version: integer('version').notNull().default(1),
    status: text('status', {
      enum: ['open', 'answered', 'invalidated'],
    })
      .notNull()
      .default('open'),
    /**
     * Safe reason for invalidation: `replaced`, `deadline_expired`,
     * `cancelled`, or null when the set is open/answered.
     */
    invalidationReason: text('invalidation_reason'),
    /** Hash of the prompt context that produced this set. */
    promptContextHash: text('prompt_context_hash'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    answeredAt: timestamp('answered_at', { mode: 'date', precision: 3, withTimezone: true }),
    invalidatedAt: timestamp('invalidated_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_run_question_sets_company_id').on(table.companyId, table.id),
    uniqueIndex('uq_run_question_sets_run_ordinal').on(table.runId, table.ordinal),
    index('idx_run_question_sets_run').on(table.runId, table.ordinal),
    index('idx_run_question_sets_company_project').on(table.companyId, table.projectId),
  ],
);
