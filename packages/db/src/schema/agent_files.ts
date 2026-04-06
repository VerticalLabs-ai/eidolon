import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const agentFiles = sqliteTable(
  'agent_files',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    agentId: text('agent_id').references(() => agents.id),
    name: text('name').notNull(),
    path: text('path').notNull(),
    mimeType: text('mime_type').notNull().default('text/plain'),
    sizeBytes: integer('size_bytes').notNull().default(0),
    content: text('content'),
    storageType: text('storage_type').notNull().default('inline'),
    parentId: text('parent_id'),
    isDirectory: integer('is_directory', { mode: 'boolean' }).notNull().default(false),
    taskId: text('task_id'),
    executionId: text('execution_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_files_agent').on(table.agentId),
    index('idx_agent_files_company').on(table.companyId),
  ],
);
