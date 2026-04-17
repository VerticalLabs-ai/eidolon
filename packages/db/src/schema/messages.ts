import { pgTable, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';
import { agents } from './agents';

export const messages = pgTable('messages', {
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
  readAt: timestamp('read_at', { mode: 'date', precision: 3 }),
  createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
    .notNull()
    .$defaultFn(() => new Date()),
});
