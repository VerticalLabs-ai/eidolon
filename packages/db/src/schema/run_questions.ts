import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { runQuestionSets } from './run_question_sets.js';

/**
 * Authoritative question definition within a question set.
 *
 * Each question has a stable `question_key` (unique within the set), an
 * `order` for stable rendering, a `type` from the closed enum, a label,
 * optional help text, a `required` flag, an optional default, and
 * type-specific `options` and `validation` stored as bounded JSONB.
 *
 * Definitions are immutable once persisted. The closed schema is enforced
 * by `question-schema.ts` before persistence (VAL-MODEQ-136).
 */
export const runQuestions = pgTable(
  'run_questions',
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
    questionSetId: text('question_set_id')
      .notNull()
      .references(() => runQuestionSets.id, { onDelete: 'cascade' }),
    /** Stable key, unique within the set (1–128 printable ASCII). */
    questionKey: text('question_key').notNull(),
    /** Render order within the set (0-based). */
    order: integer('order').notNull(),
    /** Closed question type enum. */
    type: text('type', {
      enum: ['boolean', 'single_choice', 'multiple_choice', 'text', 'number', 'scale', 'ordering'],
    }).notNull(),
    /** Human-readable label (1–500 Unicode code points). */
    label: text('label').notNull(),
    /** Optional help text (0–2,000 Unicode code points). */
    help: text('help'),
    /** Whether the question must be answered. */
    required: integer('required').notNull().default(0),
    /**
     * Optional default value (stored as JSONB). Must pass the same answer
     * validator as a submitted answer (VAL-MODEQ-136).
     */
    defaultValue: jsonb('default_value').$type<unknown>(),
    /**
     * Options array for choice/ordering types (JSONB). Each item is
     * `{ key, label }`. Null for non-choice types.
     */
    options: jsonb('options').$type<unknown[]>(),
    /**
     * Type-specific validation rules (JSONB). Bounded to depth 6 and
     * 16,384 canonical UTF-8 bytes (VAL-MODEQ-138).
     */
    validation: jsonb('validation').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_questions_company_id').on(table.companyId, table.id),
    uniqueIndex('uq_run_questions_set_key').on(table.questionSetId, table.questionKey),
    index('idx_run_questions_set_order').on(table.questionSetId, table.order),
    index('idx_run_questions_run').on(table.runId),
  ],
);
