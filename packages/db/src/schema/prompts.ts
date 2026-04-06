import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

export const promptTemplates = sqliteTable(
  'prompt_templates',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id'),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category', {
      enum: ['general', 'engineering', 'marketing', 'leadership', 'support', 'design', 'analytics'],
    })
      .notNull()
      .default('general'),
    content: text('content').notNull(),
    variables: text('variables', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    version: integer('version').notNull().default(1),
    isGlobal: integer('is_global').notNull().default(0),
    usageCount: integer('usage_count').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_prompt_templates_company').on(table.companyId),
  ],
);

export const promptVersions = sqliteTable(
  'prompt_versions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    templateId: text('template_id')
      .notNull()
      .references(() => promptTemplates.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    changeNote: text('change_note'),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_prompt_versions_template').on(table.templateId),
  ],
);
