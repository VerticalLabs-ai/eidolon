import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents.js';
import { tasks } from './tasks.js';

export const agentCollaborations = pgTable(
  'agent_collaborations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull(),
    type: text('type', {
      enum: ['delegation', 'request_help', 'review', 'consensus', 'escalation'],
    })
      .notNull()
      .default('delegation'),
    fromAgentId: text('from_agent_id')
      .notNull()
      .references(() => agents.id),
    toAgentId: text('to_agent_id')
      .notNull()
      .references(() => agents.id),
    taskId: text('task_id').references(() => tasks.id),
    parentCollaborationId: text('parent_collaboration_id'),
    status: text('status', {
      enum: ['pending', 'accepted', 'in_progress', 'completed', 'rejected', 'cancelled'],
    })
      .notNull()
      .default('pending'),
    requestContent: text('request_content').notNull(),
    responseContent: text('response_content'),
    priority: text('priority', {
      enum: ['low', 'medium', 'high', 'critical'],
    })
      .notNull()
      .default('medium'),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3 }),
  },
  (table) => [
    index('idx_agent_collabs_company').on(table.companyId),
    index('idx_agent_collabs_to').on(table.toAgentId, table.status),
  ],
);
