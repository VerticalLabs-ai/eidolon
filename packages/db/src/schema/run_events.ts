import {
  pgTable,
  text,
  bigint,
  integer,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { missionRuns } from './mission_runs.js';
import { runCommands } from './run_commands.js';

/**
 * Append-only ordered event journal.
 *
 * `sequence` is a run-local BIGINT cursor. The writer locks the run,
 * computes `sequence = last_event_sequence + 1`, inserts the event, and
 * updates the run counter in one transaction. Events are factual and never
 * updated or deleted in Phase 1. Payloads are versioned, bounded,
 * secret-redacted, and contain IDs/summaries rather than full prompts or
 * retrieved documents.
 */
export const runEvents = pgTable(
  'run_events',
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
    sequence: bigint('sequence', { mode: 'number' }).notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    payload: jsonb('payload').notNull().$type<Record<string, unknown>>().default({}),
    commandId: text('command_id').references(() => runCommands.id, { onDelete: 'set null' }),
    actorType: text('actor_type', {
      enum: ['user', 'agent', 'system'],
    }),
    actorId: text('actor_id'),
    traceId: text('trace_id'),
    occurredAt: timestamp('occurred_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('uq_run_events_sequence').on(table.runId, table.sequence),
    index('idx_run_events_run_sequence').on(table.runId, table.sequence),
    index('idx_run_events_company_project').on(table.companyId, table.projectId),
  ],
);
