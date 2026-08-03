import { pgTable, text, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { agents } from './agents.js';
import { projectPlans, projectPlanSteps } from './project_plans.js';

export const projectDecisions = pgTable(
  'project_decisions',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', {
      enum: ['pending', 'approved', 'rejected', 'superseded'],
    }).notNull().default('pending'),
    decidedByUserId: text('decided_by_user_id'),
    decidedAt: timestamp('decided_at', { mode: 'date', precision: 3, withTimezone: true }),
    rationale: text('rationale'),
    planId: text('plan_id').references(() => projectPlans.id),
    planStepId: text('plan_step_id').references(() => projectPlanSteps.id),
    supersededById: text('superseded_by_id'),
    createdByUserId: text('created_by_user_id'),
    createdByAgentId: text('created_by_agent_id').references(() => agents.id),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_project_decisions_company_project_status').on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    index('idx_project_decisions_company_project_created').on(
      table.companyId,
      table.projectId,
      table.createdAt,
    ),
    index('idx_project_decisions_plan').on(table.planId),
  ],
);
