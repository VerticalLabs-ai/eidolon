import { pgTable, text, boolean, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';

/**
 * `run_scheduling_permits` tracks root_running and parent_running permits
 * for child execution (VAL-SUB-109).
 *
 * Each routed child acquires both permits immediately before active work
 * (transitioning from queued to running) and releases them idempotently on
 * terminalization or awaiting_input. An assigned child resumes from
 * awaiting_input only after reacquiring permits for the same agent within
 * its absolute deadline and never reroutes.
 *
 * Unique (run_id, permit_kind) ensures one of each kind per run — no
 * double-acquire or double-release. Cancellation, failure, lease loss,
 * deadline, and recovery cannot leak or double-release permits because
 * release is idempotent (status transitions held→released once).
 *
 * Root running permits enforce at most 4 running descendants (platform hard
 * cap) and the root policy fan-out. Parent running permits enforce at most
 * the parent policy fan-out running children per parent.
 */
export const runSchedulingPermits = pgTable(
  'run_scheduling_permits',
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
    rootRunId: text('root_run_id').notNull(),
    parentRunId: text('parent_run_id').notNull(),
    runId: text('run_id')
      .notNull()
      .references(() => missionRuns.id, { onDelete: 'cascade' }),
    /** 'root_running' or 'parent_running'. */
    permitKind: text('permit_kind', {
      enum: ['root_running', 'parent_running'],
    }).notNull(),
    /** 'held' or 'released'. */
    status: text('status', {
      enum: ['held', 'released'],
    })
      .notNull()
      .default('held'),
    acquiredAt: timestamp('acquired_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    releasedAt: timestamp('released_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_scheduling_permits_company_id').on(table.companyId, table.id),
    // One of each kind per run — no double-acquire.
    uniqueIndex('uq_run_scheduling_permits_run_kind').on(table.runId, table.permitKind),
    index('idx_run_scheduling_permits_root_kind_status').on(
      table.rootRunId,
      table.permitKind,
      table.status,
    ),
    index('idx_run_scheduling_permits_parent_kind_status').on(
      table.parentRunId,
      table.permitKind,
      table.status,
    ),
    index('idx_run_scheduling_permits_company_project').on(table.companyId, table.projectId),
  ],
);
