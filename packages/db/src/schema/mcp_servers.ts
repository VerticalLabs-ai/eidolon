import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies';

export const mcpServers = sqliteTable(
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
    args: text('args', { mode: 'json' })
      .notNull()
      .$type<string[]>()
      .default([]),
    env: text('env', { mode: 'json' })
      .notNull()
      .$type<Record<string, string>>()
      .default({}),
    url: text('url'),
    status: text('status', {
      enum: ['connected', 'disconnected', 'error'],
    })
      .notNull()
      .default('disconnected'),
    availableTools: text('available_tools', { mode: 'json' })
      .notNull()
      .$type<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>>()
      .default([]),
    availableResources: text('available_resources', { mode: 'json' })
      .notNull()
      .$type<Array<{ uri: string; name: string; description?: string; mimeType?: string }>>()
      .default([]),
    lastConnectedAt: integer('last_connected_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_mcp_servers_company').on(table.companyId),
  ],
);
