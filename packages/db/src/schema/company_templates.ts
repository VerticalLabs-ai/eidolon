import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';

export const companyTemplates = sqliteTable(
  'company_templates',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category', {
      enum: ['general', 'software', 'marketing', 'ecommerce', 'consulting', 'content'],
    })
      .notNull()
      .default('general'),
    author: text('author'),
    version: text('version').notNull().default('1.0.0'),
    config: text('config', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    agentCount: integer('agent_count').notNull().default(0),
    isPublic: integer('is_public').notNull().default(0),
    downloadCount: integer('download_count').notNull().default(0),
    tags: text('tags', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    previewImage: text('preview_image'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_company_templates_category').on(table.category),
  ],
);
