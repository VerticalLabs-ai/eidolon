import { pgTable, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';

export const agentFiles = pgTable(
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
    isDirectory: boolean('is_directory').notNull().default(false),
    taskId: text('task_id'),
    executionId: text('execution_id'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_files_agent').on(table.agentId),
    index('idx_agent_files_company').on(table.companyId),
  ],
);
