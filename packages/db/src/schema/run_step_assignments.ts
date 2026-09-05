import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { runPlanRevisions } from './run_plan_revisions.js';
import { runPolicySnapshots } from './run_policy_snapshots.js';

/**
 * `run_step_assignments` binds one approved plan step to one child run.
 *
 * (VAL-SUB-002, VAL-SUB-003, VAL-SUB-005)
 *
 * Created by the topology materializer after plan approval, each non-root
 * executable topology node produces exactly one child run and one step
 * assignment linked to that node, parent node, child ordinal, approved
 * revision, and content hash. The assignment records routing requirements,
 * selected agent/routing kind, budget allocation, dependency state, and
 * result status.
 *
 * Unique constraints:
 * - One assignment per (root_run_id, step_key): a nonterminal retry reuses
 *   the existing child run, never creating a second child for the same
 *   approved step (VAL-SUB-005).
 * - One assignment per run_id: each child run maps to exactly one step
 *   (VAL-SUB-002).
 *
 * The assignment_status tracks the shell lifecycle:
 * - `pending_dependencies`: the step has unresolved required dependencies
 *   and starts no routing or effect (VAL-SUB-003).
 * - `pending_routing`: dependencies are resolved and the shell is ready for
 *   routing (selected by m4-f02/m4-f03).
 * - `routed`: an agent has been selected and an immutable child execution
 *   policy committed (m4-f03).
 * - `queued` / `running` / `synthesizing`: execution lifecycle.
 * - `completed` / `failed` / `cancelled`: terminal states.
 */
export const runStepAssignments = pgTable(
  'run_step_assignments',
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
    /** The root run of the tree (same as mission_runs.root_run_id). */
    rootRunId: text('root_run_id').notNull(),
    /** The parent run of this child (the run that owns the parent step). */
    parentRunId: text('parent_run_id').notNull(),
    /** The child run created for this step. */
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    /** The approved plan step key this assignment binds. */
    stepKey: text('step_key').notNull(),
    /** The parent step key (nullable for root-level children). */
    parentStepKey: text('parent_step_key'),
    /** Sibling-unique ordinal under the parent step. */
    childOrdinal: integer('child_ordinal'),
    /** Node kind from the plan step ('root' | 'child'). */
    nodeKind: text('node_kind').notNull(),
    /** The approved plan revision that authorizes this step. */
    approvedPlanRevisionId: text('approved_plan_revision_id')
      .notNull()
      .references(() => runPlanRevisions.id, { onDelete: 'cascade' }),
    /** The exact content hash of the approved plan revision. */
    approvedContentHash: text('approved_content_hash').notNull(),
    /** Assignment lifecycle status (see module doc). */
    assignmentStatus: text('assignment_status', {
      enum: [
        'pending_dependencies',
        'pending_routing',
        'routed',
        'queued',
        'running',
        'synthesizing',
        'completed',
        'failed',
        'cancelled',
      ],
    })
      .notNull()
      .default('pending_dependencies'),
    /** Routing kind selected by the router ('company_agent' | 'ephemeral'). */
    routingKind: text('routing_kind', {
      enum: ['company_agent', 'ephemeral'],
    }),
    /** Routing requirements snapshot from the approved plan step. */
    routingRequirements: jsonb('routing_requirements'),
    /** Selected executing agent (null for ephemeral or pre-routing). */
    executingAgentId: text('executing_agent_id'),
    /** Billing agent identity for cost attribution. */
    billingAgentId: text('billing_agent_id'),
    /** Budget allocation under the root reservation. */
    budgetAllocationId: text('budget_allocation_id'),
    /** Result status once the child reaches a terminal state. */
    resultStatus: text('result_status', {
      enum: ['completed', 'failed', 'cancelled', 'dependency_unavailable'],
    }),
    /** Result revision reference (for completed children). */
    resultRevision: text('result_revision'),
    /** Result content hash (for completed children). */
    resultHash: text('result_hash'),
    /** Failure category (for failed children). */
    failureCategory: text('failure_category'),
    /** Failure code (for failed children). */
    failureCode: text('failure_code'),
    /** Safe error message (for failed children). */
    safeErrorMessage: text('safe_error_message'),
    /**
     * Immutable child execution-policy snapshot committed at routing time
     * (VAL-SUB-087, VAL-SUB-108). Null before routing; set once when the
     * child is routed and never changed. The child run's policy_snapshot_id
     * is also updated to point to this snapshot.
     */
    childPolicySnapshotId: text('child_policy_snapshot_id').references(
      () => runPolicySnapshots.id,
      { onDelete: 'set null' },
    ),
    /** Canonical content hash of the child policy snapshot (VAL-SUB-087). */
    childPolicyContentHash: text('child_policy_content_hash'),
    /**
     * Whether the agent admission slot is currently held (VAL-SUB-086).
     * Set to true when routing atomically reserves one agent admission
     * slot; set to false when the slot is released on terminalization or
     * pre-start failure. This is the authoritative capacity reservation
     * flag — concurrent routers check this under a row lock.
     */
    admissionSlotHeld: boolean('admission_slot_held').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_step_assignments_company_id').on(table.companyId, table.id),
    // One assignment per (root_run_id, step_key) — no second child per step.
    uniqueIndex('uq_run_step_assignments_root_step').on(table.rootRunId, table.stepKey),
    // One assignment per run_id — each child run maps to exactly one step.
    uniqueIndex('uq_run_step_assignments_run').on(table.runId),
    index('idx_run_step_assignments_root').on(table.rootRunId),
    index('idx_run_step_assignments_parent').on(table.parentRunId),
    index('idx_run_step_assignments_company_project').on(table.companyId, table.projectId),
  ],
);
