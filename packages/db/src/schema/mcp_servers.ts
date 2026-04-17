import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    name: text('name').notNull(),
    transport: text('transport', {
      enum: ['stdio', 'sse', 'streamable-http'],
    })
      .notNull()
      .default('stdio'),
    command: text('command'),
    args: jsonb('args')
      .notNull()
      .$type<string[]>()
      .default([]),
    env: jsonb('env')
      .notNull()
      .$type<Record<string, string>>()
      .default({}),
    url: text('url'),
    status: text('status', {
      enum: ['connected', 'disconnected', 'error'],
    })
      .notNull()
      .default('disconnected'),
    availableTools: jsonb('available_tools')
      .notNull()
      .$type<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>()
      .default([]),
    availableResources: jsonb('available_resources')
      .notNull()
      .$type<Array<{ uri: string; name: string; description?: string; mimeType?: string }>>()
      .default([]),
    lastConnectedAt: timestamp('last_connected_at', { mode: 'date', precision: 3 }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_mcp_servers_company').on(table.companyId),
  ],
);
