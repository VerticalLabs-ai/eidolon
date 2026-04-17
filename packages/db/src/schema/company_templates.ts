import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';

export const companyTemplates = pgTable(
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
    config: jsonb('config')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    agentCount: integer('agent_count').notNull().default(0),
    // 0/1 integer: callers assign `1` / `0` literally.
    isPublic: integer('is_public').notNull().default(0),
    downloadCount: integer('download_count').notNull().default(0),
    tags: jsonb('tags')
      .notNull()
      .$type<string[]>()
      .default([]),
    previewImage: text('preview_image'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_company_templates_category').on(table.category),
  ],
);
