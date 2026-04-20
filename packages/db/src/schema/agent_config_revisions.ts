import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents.js';

export const agentConfigRevisions = pgTable(
  'agent_config_revisions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    changedBy: text('changed_by'),
    changedKeys: jsonb('changed_keys')
      .notNull()
      .$type<string[]>()
      .default([]),
    beforeConfig: jsonb('before_config')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    afterConfig: jsonb('after_config')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_config_revisions_agent').on(table.agentId, table.createdAt),
  ],
);
