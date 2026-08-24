import {
  pgTable,
  text,
  integer,
  bigint,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { runPlanRevisions } from './run_plan_revisions.js';

/**
 * Immutable synthesis manifest records for composite runs.
 *
 * (VAL-SUB-051, 052, 053, 054, 064, 065, 066, 111)
 *
 * Each composite run commits exactly one synthesis manifest when its
 * direct children have all reached terminal states. The manifest is
 * ordered by direct-child ordinal/step key and contains only accepted
 * result revision/hash or a typed unavailable reason for each direct
 * child. A parent consumes only direct-child committed results, never
 * bypassing a composite to read grandchildren (VAL-SUB-111).
 *
 * Exactly-once synthesis is enforced by a unique constraint on the
 * deterministic key `(run_id, approved_plan_revision_id,
 * approved_content_hash, synthesis_ordinal)` (VAL-SUB-065, 111).
 * Concurrent settlement/recovery may commit exactly one ordered input
 * manifest, synthesis result, cost settlement, completion event, and
 * terminal outcome for that composite.
 *
 * The manifest status tracks the synthesis lifecycle:
 * - `started`: synthesis has begun (synthesis.started emitted).
 * - `completed`: synthesis result committed and run terminalized.
 * - `failed`: synthesis could not complete (e.g. require_all failure).
 */
export const runSynthesisManifests = pgTable(
  'run_synthesis_manifests',
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
    /** The composite/parent run that owns this synthesis. */
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    /** The root run of the tree. */
    rootRunId: text('root_run_id').notNull(),
    /** The approved plan revision that authorizes this synthesis. */
    approvedPlanRevisionId: text('approved_plan_revision_id')
      .notNull()
      .references(() => runPlanRevisions.id, { onDelete: 'cascade' }),
    /** The exact content hash of the approved plan revision. */
    approvedContentHash: text('approved_content_hash').notNull(),
    /**
     * Synthesis ordinal (always 1 in Phase 1 — one synthesis per composite).
     * Part of the exactly-once deterministic key.
     */
    synthesisOrdinal: integer('synthesis_ordinal').notNull().default(1),
    /**
     * Ordered immutable synthesis manifest: array of entries keyed by
     * direct-child ordinal/step key, each containing accepted result
     * revision/hash or a typed unavailable reason.
     *
     * Entry shape:
     * { stepKey, childOrdinal, childRunId, resultStatus,
     *   resultRevision?, resultHash?,
     *   unavailableReason? }
     *
     * `unavailableReason` is one of: `failed`, `cancelled`,
     * `dependency_unavailable`, `missing`.
     */
    manifest: jsonb('manifest').notNull(),
    /** Canonical SHA-256 hash of the manifest content. */
    manifestHash: text('manifest_hash').notNull(),
    /** Committed synthesis result (set on completion). */
    synthesisResult: jsonb('synthesis_result'),
    /** Whether the synthesis disclosed gaps (best_effort with failures). */
    disclosedGaps: jsonb('disclosed_gaps'),
    /** Synthesis lifecycle status. */
    status: text('status', {
      enum: ['started', 'completed', 'failed'],
    })
      .notNull()
      .default('started'),
    /** Failure category (for failed synthesis). */
    failureCategory: text('failure_category'),
    /** Failure code (for failed synthesis). */
    failureCode: text('failure_code'),
    /** Safe error message (for failed synthesis). */
    safeErrorMessage: text('safe_error_message'),
    /** The run-local event sequence of the synthesis.started event. */
    startedEventSequence: bigint('started_event_sequence', { mode: 'number' }),
    /** The run-local event sequence of the synthesis.completed event. */
    completedEventSequence: bigint('completed_event_sequence', { mode: 'number' }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    uniqueIndex('uq_run_synthesis_manifests_company_id').on(table.companyId, table.id),
    // Exactly-once: one manifest per (run, revision, hash, ordinal).
    uniqueIndex('uq_run_synthesis_manifests_key').on(
      table.runId,
      table.approvedPlanRevisionId,
      table.approvedContentHash,
      table.synthesisOrdinal,
    ),
    index('idx_run_synthesis_manifests_run').on(table.runId),
    index('idx_run_synthesis_manifests_root').on(table.rootRunId),
    index('idx_run_synthesis_manifests_company_project').on(table.companyId, table.projectId),
  ],
);
