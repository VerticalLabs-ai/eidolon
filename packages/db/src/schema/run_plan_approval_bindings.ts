import { pgTable, text, boolean, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { runPlanRevisions } from './run_plan_revisions.js';
import { approvals } from './approvals.js';

/**
 * Plan approval binding — links an approvable plan revision to a governance
 * approval record.
 *
 * Committing an approvable revision atomically creates or links exactly one
 * unresolved `plan_gate` approval with matching company, project, run,
 * revision, and hash (VAL-PLAN-103). A fault between internal writes
 * exposes neither an actionable plan nor an orphan approval.
 *
 * Cardinality invariants:
 * - Unique `approval_id`: one binding per approval row.
 * - At most one current execution authorization per run: enforced via a
 *   partial unique index on `(run_id) WHERE is_current_authorization = true`
 *   (VAL-PLAN-102, VAL-PLAN-121). Any number of historical approved
 *   bindings may coexist with the single current authorization; historical
 *   bindings are immutable and never deleted or rewritten.
 * - Approval is valid only if the binding's revision ID and content hash
 *   match the run's current revision while the run lock is held
 *   (VAL-PLAN-029, VAL-PLAN-030).
 */
export const runPlanApprovalBindings = pgTable(
  'run_plan_approval_bindings',
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
    planRevisionId: text('plan_revision_id')
      .notNull()
      .references(() => runPlanRevisions.id, { onDelete: 'cascade' }),
    /** Exact content hash at binding time (must match revision hash). */
    contentHash: text('content_hash').notNull(),
    /** FK to the approvals row (kind = 'plan_gate'). Unique per binding. */
    approvalId: text('approval_id')
      .notNull()
      .references(() => approvals.id),
    /** Decision recorded when the approval is resolved: approved or rejected. */
    decision: text('decision', {
      enum: ['approved', 'rejected'],
    }),
    decidingUserId: text('deciding_user_id'),
    /**
     * Whether this binding is the run's current execution authorization
     * (VAL-PLAN-102, VAL-PLAN-121). At most one binding per run may carry
     * this flag (enforced via partial unique index). Historical approved
     * bindings retain `decision = 'approved'` but have this flag cleared
     * when a later revision is approved or when a post-approval revision
     * request revokes execution eligibility. The immutable decision record
     * itself is never deleted or rewritten.
     */
    isCurrentAuthorization: boolean('is_current_authorization').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    decidedAt: timestamp('decided_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_run_plan_approval_bindings_company_id').on(table.companyId, table.id),
    uniqueIndex('uq_run_plan_approval_bindings_approval_id').on(table.approvalId),
    // At most one current execution authorization per run. Historical
    // approved bindings coexist with the single current authorization
    // (VAL-PLAN-102, VAL-PLAN-121).
    uniqueIndex('uq_run_plan_approval_bindings_run_current')
      .on(table.runId)
      .where(sql`"is_current_authorization" = true`),
    index('idx_run_plan_approval_bindings_run').on(table.runId),
    index('idx_run_plan_approval_bindings_revision').on(table.planRevisionId),
  ],
);
