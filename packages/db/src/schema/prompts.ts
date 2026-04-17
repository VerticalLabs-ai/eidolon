import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

export const promptTemplates = pgTable(
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
    variables: jsonb('variables')
      .notNull()
      .$type<string[]>()
      .default([]),
    version: integer('version').notNull().default(1),
    // 0/1 integer: route handlers compare with `eq(..., 1)` and assign 1/0.
    isGlobal: integer('is_global').notNull().default(0),
    usageCount: integer('usage_count').notNull().default(0),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_prompt_templates_company').on(table.companyId),
  ],
);

export const promptVersions = pgTable(
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
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_prompt_versions_template').on(table.templateId),
  ],
);
