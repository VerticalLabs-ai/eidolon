import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { agents } from './agents.js';
import { projects } from './projects.js';

export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    fromAgentId: text('from_agent_id')
      .notNull()
      .references(() => agents.id),
    toAgentId: text('to_agent_id')
      .notNull()
      .references(() => agents.id),
    type: text('type', {
      enum: ['directive', 'report', 'question', 'response', 'notification'],
    })
      .notNull()
      .default('directive'),
    subject: text('subject'),
    content: text('content').notNull(),
    metadata: jsonb('metadata')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    threadId: text('thread_id'),
    parentMessageId: text('parent_message_id').references((): any => messages.id),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    readAt: timestamp('read_at', { mode: 'date', precision: 3 }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_messages_company_project').on(table.companyId, table.projectId, table.createdAt),
  ],
);
