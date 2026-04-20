import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents.js';

export const agentMemories = pgTable(
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
    tags: jsonb('tags')
      .notNull()
      .$type<string[]>()
      .default([]),
    expiresAt: timestamp('expires_at', { mode: 'date', precision: 3 }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_memories_agent').on(table.agentId, table.createdAt),
    index('idx_agent_memories_company').on(table.companyId, table.agentId),
  ],
);
