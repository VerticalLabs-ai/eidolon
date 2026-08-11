import { randomUUID } from 'node:crypto';
import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { companies } from './companies.js';
import { projects } from './projects.js';

/**
 * Self-referential folder tree for organizing artifacts.
 *
 * - `companyId` is immutable and scopes every folder operation.
 * - `projectId` is nullable: null = company-level folder; non-null = project
 *   folder. A folder and its descendants share the same companyId; projectId
 *   is set at create and preserved (a folder tree lives within one scope).
 * - `parentId` is self-referential and nullable: null = top-level folder.
 *   `ON DELETE SET NULL` is a safety net only — the folder service relocates
 *   children to the deleted folder's parent before removing the row, so the
 *   FK never fires in normal operation.
 * - Name uniqueness is enforced case-insensitively within the same parent
 *   (see `uq_artifact_folders_company_project_parent_name`). Top-level
 *   folders (parentId null) are grouped under a synthetic root token so the
 *   unique index treats NULL parents as a single bucket.
 */
export const artifactFolders = pgTable(
  'artifact_folders',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_artifact_folders_company').on(table.companyId),
    index('idx_artifact_folders_company_project').on(table.companyId, table.projectId),
    index('idx_artifact_folders_parent').on(table.parentId),
    // Case-insensitive name uniqueness within the same parent bucket.
    // NULL parentId values are coalesced to a synthetic root token so that
    // top-level folders under the same company/project are uniqueness-checked
    // against each other (Postgres treats NULLs as distinct in unique indexes).
    uniqueIndex('uq_artifact_folders_company_project_parent_name')
      .on(table.companyId, sql`COALESCE(${table.projectId}, '<none>')`, sql`COALESCE(${table.parentId}, '<root>')`, sql`lower(${table.name})`),
  ],
);

// Self-referential FK is declared via raw SQL in the migration (Drizzle's
// references() cannot reference the table being defined). See migration 0021.
