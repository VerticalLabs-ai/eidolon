import { pgTable, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { agents } from './agents.js';

export const projectThreads = pgTable(
  'project_threads',
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
    title: text('title').notNull(),
    type: text('type', {
      enum: ['conversation', 'plan_review', 'decision_review', 'standup'],
    })
      .notNull()
      .default('conversation'),
    status: text('status', {
      enum: ['active', 'archived'],
    })
      .notNull()
      .default('active'),
    // Clerk user ids are external identities; Eidolon does not keep a local users table.
    createdByUserId: text('created_by_user_id'),
    createdByAgentId: text('created_by_agent_id').references(() => agents.id),
    /**
     * Whether this thread is a Mission child subthread projection
     * (VAL-SUB-007, VAL-SUB-102). Mission subthreads are read-only
     * projections: generic thread/message/item mutations return 409
     * `MISSION_SUBTHREAD_READ_ONLY`. They are excluded from default thread
     * lists unless `includeMissionSubthreads=true`.
     */
    isMissionSubthread: boolean('is_mission_subthread').default(false),
    /**
     * The Mission run ID this subthread projects (VAL-SUB-007). Null for
     * regular (non-Mission) threads. Used to link a child run to its
     * dedicated subthread and to enforce company/project isolation
     * (VAL-SUB-043). Plain text without a Drizzle `.references()` to avoid
     * a circular import with `mission_runs.ts`; the FK constraint is
     * declared in the migration SQL.
     */
    missionRunId: text('mission_run_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_project_threads_company_project_created').on(
      table.companyId,
      table.projectId,
      table.createdAt,
    ),
    index('idx_project_threads_company_project_status').on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    index('idx_project_threads_mission_run').on(table.missionRunId),
  ],
);
