import { pgTable, text, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { tasks } from './tasks.js';
import { agents } from './agents.js';
import { projectPlans, projectPlanSteps } from './project_plans.js';

export const projectOutcomes = pgTable(
  'project_outcomes',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['document', 'pull_request', 'audit', 'review', 'delivery_summary'],
    }).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: ['pending', 'completed', 'failed'] })
      .notNull()
      .default('pending'),
    referenceUrl: text('reference_url'),
    referenceId: text('reference_id'),
    taskId: text('task_id').references(() => tasks.id),
    planId: text('plan_id').references(() => projectPlans.id),
    planStepId: text('plan_step_id').references(() => projectPlanSteps.id),
    metadata: jsonb('metadata').notNull().$type<Record<string, unknown>>().default({}),
    createdByUserId: text('created_by_user_id'),
    createdByAgentId: text('created_by_agent_id').references(() => agents.id),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_project_outcomes_company_project_type_status').on(
      table.companyId,
      table.projectId,
      table.type,
      table.status,
    ),
    index('idx_project_outcomes_company_project_created').on(
      table.companyId,
      table.projectId,
      table.createdAt,
    ),
  ],
);
