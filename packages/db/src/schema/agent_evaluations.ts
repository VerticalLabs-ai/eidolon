import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { agents } from './agents';

export const agentEvaluations = pgTable(
  'agent_evaluations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    executionId: text('execution_id'),
    taskId: text('task_id'),
    qualityScore: integer('quality_score'),
    speedScore: integer('speed_score'),
    costEfficiencyScore: integer('cost_efficiency_score'),
    overallScore: integer('overall_score'),
    evaluator: text('evaluator').notNull().default('system'),
    feedback: text('feedback'),
    metrics: jsonb('metrics')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3 })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('idx_agent_evaluations_agent').on(table.agentId, table.createdAt),
    index('idx_agent_evaluations_company').on(table.companyId),
  ],
);
