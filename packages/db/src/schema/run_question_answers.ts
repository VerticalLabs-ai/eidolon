import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { runQuestionSets } from './run_question_sets.js';
import { runQuestions } from './run_questions.js';

/**
 * Immutable answer record for a question in a question set.
 *
 * `run_question_answers` is immutable and keyed by
 * `(question_set_id, question_id, answer_revision)`. A later correction
 * while the set remains open supersedes the prior answer by creating a new
 * revision. Submission is all-or-nothing: a valid submission records all
 * supplied answers in one transaction, closes the set, and resumes the run.
 * An invalid submission applies nothing (VAL-MODEQ-063).
 *
 * Once execution resumes, answers cannot be edited silently; a subsequent
 * change requires an explicit plan revision while awaiting approval or
 * cancellation and retry as a new run (VAL-MODEQ-069).
 *
 * The `content_hash` is a lowercase SHA-256 hex of the canonical answer
 * value, enabling exact-context resume by stable reference and hash
 * (VAL-MODEQ-067). The `value` column stores the canonical validated
 * answer value as bounded JSONB.
 */
export const runQuestionAnswers = pgTable(
  'run_question_answers',
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
    questionId: text('question_id')
      .notNull()
      .references(() => runQuestions.id, { onDelete: 'cascade' }),
    /** Stable question key (denormalized for stable reference). */
    questionKey: text('question_key').notNull(),
    /**
     * Answer revision within this question. Starts at 1 for the first
     * submission. A correction while the set is open creates a new revision.
     */
    answerRevision: integer('answer_revision').notNull().default(1),
    /**
     * Canonical validated answer value (JSONB). `null` distinguishes an
     * omitted optional question from an explicitly submitted null-like
     * value. For optional questions that were omitted, no answer row is
     * created at all (VAL-MODEQ-056).
     */
    value: jsonb('value').$type<unknown>(),
    /**
     * Lowercase SHA-256 hex of the canonical answer value. When `value` is
     * null (omitted optional), the hash is of the canonical `null`
     * representation. Used for exact-context resume (VAL-MODEQ-067).
     */
    contentHash: text('content_hash').notNull(),
    /** Attribution: who submitted this answer. */
    actorType: text('actor_type', {
      enum: ['user', 'agent', 'system'],
    }).notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_question_answers_company_id').on(table.companyId, table.id),
    uniqueIndex('uq_run_question_answers_set_q_rev').on(
      table.questionSetId,
      table.questionId,
      table.answerRevision,
    ),
    index('idx_run_question_answers_set').on(table.questionSetId, table.questionKey),
    index('idx_run_question_answers_run').on(table.runId),
  ],
);
