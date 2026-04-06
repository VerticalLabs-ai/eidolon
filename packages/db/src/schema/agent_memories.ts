import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents';

export const agentMemories = sqliteTable(
  'agent_memories',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    memoryType: text('memory_type', {
      enum: ['observation', 'decision', 'preference', 'fact', 'lesson'],
    })
      .notNull()
      .default('observation'),
    content: text('content').notNull(),
    importance: integer('importance').notNull().default(5),
    sourceTaskId: text('source_task_id'),
    sourceExecutionId: text('source_execution_id'),
    tags: text('tags', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_memories_agent').on(table.agentId, table.createdAt),
    index('idx_agent_memories_company').on(table.companyId, table.agentId),
  ],
);
