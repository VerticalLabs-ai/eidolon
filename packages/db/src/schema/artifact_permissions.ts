import { randomUUID } from 'node:crypto';
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';

/**
 * Per-resource RBAC permissions (M4 — extends Clerk org roles).
 *
 * Each record grants an access level (view|edit|manage) on a specific
 * resource (project|folder|artifact) to a grantee (user|team). The grantee
 * id is a Clerk user id or a local-trusted test user id for `user` grants,
 * or a team id for `team` grants.
 *
 * Permission inheritance: a grant on a project or folder applies to its
 * descendants. A more specific grant (on an artifact) overrides a less
 * specific inherited grant (on a folder or project) for that grantee
 * (VAL-TEAM-013).
 *
 * Company scoping: every permission record is scoped to a company. The
 * permission service validates that the referenced resource belongs to the
 * same company before creating or acting on a record (VAL-TEAM-019).
 * Cascade on company delete.
 *
 * When a team is deleted, the permission service removes all records
 * referencing that team (VAL-TEAM-022).
 */
export const artifactPermissions = pgTable(
  'artifact_permissions',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    granteeType: text('grantee_type').notNull(),
    granteeId: text('grantee_id').notNull(),
    accessLevel: text('access_level').notNull(),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    // CHECK constraints enforce valid enum values at the DB level.
    check('chk_permissions_resource_type', sql`${table.resourceType} IN ('project', 'folder', 'artifact')`),
    check('chk_permissions_grantee_type', sql`${table.granteeType} IN ('user', 'team')`),
    check('chk_permissions_access_level', sql`${table.accessLevel} IN ('view', 'edit', 'manage')`),
    // Lookup indexes.
    index('idx_artifact_permissions_resource').on(table.companyId, table.resourceType, table.resourceId),
    index('idx_artifact_permissions_grantee').on(table.granteeType, table.granteeId),
    // One grant per (resource, grantee) — upsert updates the access level.
    uniqueIndex('uq_artifact_permissions_resource_grantee').on(
      table.companyId,
      table.resourceType,
      table.resourceId,
      table.granteeType,
      table.granteeId,
    ),
  ],
);
