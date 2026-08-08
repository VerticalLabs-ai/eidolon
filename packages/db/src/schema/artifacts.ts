import { randomUUID } from 'node:crypto';
import {
  check,
  index,
  integer,
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

export const artifactTypeEnum = pgEnum('artifact_type', [
  'document',
  'sheet',
  'board',
  'slide_deck',
  'timeline',
  'gallery',
  'dashboard',
  'app',
  'code',
]);

export const artifactStatusEnum = pgEnum('artifact_status', ['active', 'archived', 'deleted']);
export const artifactEditSourceEnum = pgEnum('artifact_edit_source', ['user', 'agent', 'system']);

export const artifacts = pgTable(
  'artifacts',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    // Reserved for the M4 folder model. It is intentionally nullable and
    // unconstrained until artifact_folders exists.
    folderId: text('folder_id'),
    type: artifactTypeEnum('type').notNull(),
    title: text('title').notNull(),
    content: jsonb('content').notNull().default({}).$type<Record<string, unknown>>(),
    contentSchemaVersion: integer('content_schema_version').notNull().default(1),
    status: artifactStatusEnum('status').notNull().default('active'),
    createdByUserId: text('created_by_user_id'),
    createdByAgentId: text('created_by_agent_id').references(() => agents.id),
    lastEditedByUserId: text('last_edited_by_user_id'),
    lastEditedByAgentId: text('last_edited_by_agent_id').references(() => agents.id),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp('deleted_at', { mode: 'date', precision: 3, withTimezone: true }),
  },
  (table) => [
    index('idx_artifacts_company_status_updated').on(table.companyId, table.status, table.updatedAt),
    index('idx_artifacts_company_project').on(table.companyId, table.projectId),
    index('idx_artifacts_company_type').on(table.companyId, table.type),
    check('chk_artifacts_version_positive', sql`${table.version} > 0`),
    check('chk_artifacts_schema_version_positive', sql`${table.contentSchemaVersion} > 0`),
  ],
);

export const artifactRevisions = pgTable(
  'artifact_revisions',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: jsonb('content').notNull().$type<Record<string, unknown>>(),
    editedByUserId: text('edited_by_user_id'),
    editedByAgentId: text('edited_by_agent_id').references(() => agents.id),
    editSource: artifactEditSourceEnum('edit_source').notNull(),
    message: text('message'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_artifact_revisions_artifact_version').on(table.artifactId, table.version),
    index('idx_artifact_revisions_artifact_created').on(table.artifactId, table.createdAt),
    check('chk_artifact_revisions_version_positive', sql`${table.version} > 0`),
  ],
);
