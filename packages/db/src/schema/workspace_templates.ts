import { randomUUID } from 'node:crypto';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { artifacts } from './artifacts.js';
import { artifactTypeEnum } from './artifacts.js';

/**
 * Project templates — a reusable snapshot of a project (artifacts + context +
 * settings + folder structure) that can be cloned into a new project.
 *
 * - `companyId` scopes the template to a company (cascade on company delete).
 * - `projectId` references the source project for audit only. It is
 *   `ON DELETE SET NULL` so deleting the source project does not delete the
 *   template (templates are independent snapshots, per VAL-TEMPLATE-004/013).
 * - `snapshot` is a deep JSONB copy of the project's settings, folders, and
 *   artifacts captured at save time. Editing the original project does not
 *   mutate this snapshot (VAL-TEMPLATE-004/012).
 */
export const projectTemplates = pgTable(
  'project_templates',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    snapshot: jsonb('snapshot').notNull().$type<Record<string, unknown>>(),
    artifactCount: integer('artifact_count').notNull().default(0),
    folderCount: integer('folder_count').notNull().default(0),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_project_templates_company').on(table.companyId),
  ],
);

/**
 * Artifact templates — a reusable snapshot of a single artifact's type +
 * content that can be cloned into a new artifact.
 *
 * - `companyId` scopes the template (cascade on company delete).
 * - `artifactId` references the source artifact for audit only. It is
 *   `ON DELETE SET NULL` so deleting the source artifact does not delete the
 *   template (templates are independent snapshots, per VAL-TEMPLATE-007/013).
 * - `content` is a deep JSONB copy of the artifact's content captured at save
 *   time (VAL-TEMPLATE-005/007/012).
 */
export const artifactTemplates = pgTable(
  'artifact_templates',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    type: artifactTypeEnum('type').notNull(),
    content: jsonb('content').notNull().$type<Record<string, unknown>>(),
    contentSchemaVersion: integer('content_schema_version').notNull().default(1),
    artifactId: text('artifact_id').references(() => artifacts.id, { onDelete: 'set null' }),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_artifact_templates_company').on(table.companyId),
    index('idx_artifact_templates_company_type').on(table.companyId, table.type),
  ],
);

/**
 * Idempotency ledger for create-project-from-template.
 *
 * When a client supplies an `idempotencyKey`, the (companyId, templateId,
 * idempotencyKey) tuple is recorded here alongside the created project id.
 * A retry with the same key returns the existing project instead of creating
 * a duplicate (VAL-TEMPLATE-010). The unique index guarantees exactly one
 * project per key even under concurrent retries.
 *
 * `projectId` is `ON DELETE CASCADE` so deleting the cloned project removes
 * the ledger row (a future retry would then create a fresh project).
 */
export const projectTemplateClones = pgTable(
  'project_template_clones',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
    templateId: text('template_id').notNull().references(() => projectTemplates.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('uq_project_template_clones_company_template_key').on(
      table.companyId,
      table.templateId,
      table.idempotencyKey,
    ),
  ],
);
