import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents';

export const agentConfigRevisions = sqliteTable(
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
    changedKeys: text('changed_keys', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    beforeConfig: text('before_config', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    afterConfig: text('after_config', { mode: 'json' })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_config_revisions_agent').on(table.agentId, table.createdAt),
  ],
);
