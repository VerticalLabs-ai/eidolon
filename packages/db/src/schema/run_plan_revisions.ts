import { pgTable, text, integer, jsonb, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';

/**
 * Immutable plan revision record.
 *
 * Stores one immutable revision of a Mission plan content proposal. Rows are
 * never updated in place except for the status transition
 * (`proposed` → `superseded` | `approved` | `rejected`), which is itself
 * transactional and recorded via journal events. The `content` JSONB holds
 * the validated `PlanContentV1`; `content_hash` is the lowercase SHA-256 of
 * the canonical authority fields (VAL-PLAN-032, VAL-PLAN-124).
 *
 * Cardinality invariants (VAL-PLAN-103, VAL-PLAN-114):
 * - Unique `(run_id, revision)` prevents duplicate revision numbers.
 * - Unique `(run_id, content_hash)` prevents duplicate proposals.
 * - At most one `proposed` or `approved` revision is current per run; the
 *   plan-publication service supersedes the prior proposal atomically.
 *
 * States: `proposed` → `superseded` | `approved` | `rejected`. Approved
 * content is immutable (VAL-PLAN-031). A revision request produces a new
 * proposed revision (VAL-PLAN-037).
 */
export const runPlanRevisions = pgTable(
  'run_plan_revisions',
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
    /** Per-run monotonic revision number, starting at 1. */
    revision: integer('revision').notNull(),
    /** Parent revision (the superseded proposal), or null for the first. */
    parentRevisionId: text('parent_revision_id'),
    status: text('status', {
      enum: ['proposed', 'superseded', 'approved', 'rejected'],
    })
      .notNull()
      .default('proposed'),
    /** Validated PlanContentV1 (NFC-normalized, graph-valid). */
    content: jsonb('content').notNull(),
    /** Lowercase SHA-256 hex of canonical authority fields. */
    contentHash: text('content_hash').notNull(),
    /**
     * Safe metadata about what generated this revision: actor type, model,
     * planner version, etc. Never secrets, prompts, or retrieved content.
     */
    generatedBy: jsonb('generated_by').$type<Record<string, unknown>>().default({}),
    /**
     * Revision/rejection feedback (NFC-normalized, encrypted at rest by the
     * command layer). Null for initial proposals.
     */
    feedback: text('feedback'),
    /** Budget estimates snapshot at proposal time. */
    estimates: jsonb('estimates').$type<Record<string, unknown>>().default({}),
    /** User who decided (approved/rejected) this revision, if applicable. */
    decidedByUserId: text('decided_by_user_id'),
    decidedAt: timestamp('decided_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_plan_revisions_company_id').on(table.companyId, table.id),
    uniqueIndex('uq_run_plan_revisions_run_revision').on(table.runId, table.revision),
    uniqueIndex('uq_run_plan_revisions_run_hash').on(table.runId, table.contentHash),
    index('idx_run_plan_revisions_run_revision').on(table.runId, table.revision),
    index('idx_run_plan_revisions_company_project').on(table.companyId, table.projectId),
  ],
);
