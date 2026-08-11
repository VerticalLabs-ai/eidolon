import { randomUUID } from 'node:crypto';
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

/**
 * M7 — Meetings pipeline.
 *
 * A meeting is a first-class entity DISTINCT from agent execution transcripts
 * (task_thread_items execution log payloads). It is project-scoped and
 * company-isolated, carries a pasted (or transcribed) transcript, a
 * transcript-grounded summary, and a set of action items that become REAL
 * tasks in the existing task system (linked back via the `meeting_tasks` join
 * table — bidirectional: meeting→tasks and task→meeting).
 */
export const meetingStatusEnum = pgEnum('meeting_status', [
  'active',
  'archived',
  'deleted',
]);

export const meetings = pgTable(
  'meetings',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    title: text('title').notNull(),
    // Raw transcript text (pasted or transcribed from audio — stretch).
    transcript: text('transcript'),
    // Transcript-grounded summary produced by the summarize pipeline.
    summary: text('summary'),
    summaryGeneratedAt: timestamp('summary_generated_at', {
      mode: 'date',
      precision: 3,
      withTimezone: true,
    }),
    summaryGeneratedByAgentId: text('summary_generated_by_agent_id').references(
      () => agents.id,
    ),
    // When the meeting took place (optional — user-supplied or inferred).
    occurredAt: timestamp('occurred_at', { mode: 'date', precision: 3, withTimezone: true }),
    status: meetingStatusEnum('status').notNull().default('active'),
    createdByUserId: text('created_by_user_id'),
    createdByAgentId: text('created_by_agent_id').references(() => agents.id),
    // Freeform metadata (e.g. attendees list parsed from transcript, source kind).
    metadata: jsonb('metadata')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    index('idx_meetings_company_status_updated').on(
      table.companyId,
      table.status,
      table.updatedAt,
    ),
    index('idx_meetings_company_project').on(table.companyId, table.projectId),
    check('chk_meetings_title_nonempty', sql`length(btrim(${table.title})) > 0`),
  ],
);

/**
 * Join table linking a meeting to the real tasks produced by its action-item
 * extraction. Bidirectional: meeting → tasks (action items) and task →
 * meeting (origin). Both FKs cascade on delete so archiving a meeting does
 * not strand the tasks (the task survives; the link is removed). A unique
 * constraint prevents duplicate links between the same meeting and task.
 */
export const meetingTasks = pgTable(
  'meeting_tasks',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    meetingId: text('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_meeting_tasks_meeting_task').on(table.meetingId, table.taskId),
    index('idx_meeting_tasks_meeting').on(table.meetingId),
    index('idx_meeting_tasks_task').on(table.taskId),
    index('idx_meeting_tasks_company').on(table.companyId),
  ],
);
