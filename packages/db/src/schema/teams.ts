import { randomUUID } from 'node:crypto';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { companies } from './companies.js';

/**
 * Teams — groups of company members that can be granted per-resource
 * permissions collectively. A team belongs to exactly one company
 * (cascade on company delete). Deleting a team removes (or invalidates)
 * all permission records granted to that team (handled by the permission
 * service — VAL-TEAM-022).
 */
export const teams = pgTable(
  'teams',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_teams_company').on(table.companyId),
  ],
);

/**
 * Team membership — associates a user with a team. A user can belong to
 * multiple teams. `userId` is a free-form text id (Clerk user id or
 * local-trusted test user id). Cascade on team delete so all memberships
 * are removed when a team is deleted (VAL-TEAM-022).
 *
 * The unique index on (team_id, user_id) prevents duplicate assignments
 * (VAL-TEAM-002).
 */
export const teamMembers = pgTable(
  'team_members',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_team_members_team').on(table.teamId),
    index('idx_team_members_user').on(table.userId),
    uniqueIndex('uq_team_members_team_user').on(table.teamId, table.userId),
  ],
);
