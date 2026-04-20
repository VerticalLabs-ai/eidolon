import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';

export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    title: text('title').notNull(),
    content: text('content').notNull(),
    contentType: text('content_type').notNull().default('markdown'),
    source: text('source').default('manual'),
    sourceUrl: text('source_url'),
    tags: jsonb('tags').notNull().$type<string[]>().default([]),
    metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default({}),
    chunkCount: integer('chunk_count').notNull().default(0),
    embeddingStatus: text('embedding_status').notNull().default('pending'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_knowledge_docs_company').on(table.companyId),
  ],
);

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    documentId: text('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    companyId: text('company_id').notNull(),
    chunkIndex: integer('chunk_index').notNull(),
    content: text('content').notNull(),
    tokenCount: integer('token_count').notNull().default(0),
    metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default({}),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_knowledge_chunks_doc').on(table.documentId),
    index('idx_knowledge_chunks_company').on(table.companyId),
  ],
);
