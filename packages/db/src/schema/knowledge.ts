import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const knowledgeDocuments = sqliteTable(
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
    tags: text('tags', { mode: 'json' }).notNull().$type<string[]>().default([]),
    metadata: text('metadata', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
    chunkCount: integer('chunk_count').notNull().default(0),
    embeddingStatus: text('embedding_status').notNull().default('pending'),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_knowledge_docs_company').on(table.companyId),
  ],
);

export const knowledgeChunks = sqliteTable(
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
    metadata: text('metadata', { mode: 'json' }).notNull().$type<Record<string, unknown>>().default({}),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_knowledge_chunks_doc').on(table.documentId),
    index('idx_knowledge_chunks_company').on(table.companyId),
  ],
);
