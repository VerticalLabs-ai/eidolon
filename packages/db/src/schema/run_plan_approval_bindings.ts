import { pgTable, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
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
 * - Unique approved binding per run: at most one binding with
 *   `decision = 'approved'` per run (enforced via partial unique index).
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
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    decidedAt: timestamp('decided_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_run_plan_approval_bindings_company_id').on(table.companyId, table.id),
    uniqueIndex('uq_run_plan_approval_bindings_approval_id').on(table.approvalId),
    // At most one approved binding per run (VAL-PLAN-103, VAL-PLAN-102).
    uniqueIndex('uq_run_plan_approval_bindings_run_approved')
      .on(table.runId)
      .where(sql`"decision" = 'approved'`),
    index('idx_run_plan_approval_bindings_run').on(table.runId),
    index('idx_run_plan_approval_bindings_revision').on(table.planRevisionId),
  ],
);
