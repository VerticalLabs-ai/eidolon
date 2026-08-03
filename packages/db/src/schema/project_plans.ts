import { pgTable, text, integer, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { companies } from './companies.js';
import { projects } from './projects.js';
import { tasks } from './tasks.js';
import { agents } from './agents.js';
import { approvals } from './approvals.js';

export const projectPlans = pgTable(
  'project_plans',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    companyId: text('company_id').notNull().references(() => companies.id),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', {
      enum: ['draft', 'active', 'completed', 'cancelled'],
    }).notNull().default('draft'),
    progress: integer('progress').notNull().default(0),
    taskId: text('task_id').references(() => tasks.id),
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
    index('idx_project_plans_company_project_status').on(
      table.companyId,
      table.projectId,
      table.status,
    ),
    index('idx_project_plans_company_project_created').on(
      table.companyId,
      table.projectId,
      table.createdAt,
    ),
  ],
);

export const projectPlanSteps = pgTable(
  'project_plan_steps',
  {
    id: text('id').primaryKey().$defaultFn(() => randomUUID()),
    planId: text('plan_id')
      .notNull()
      .references(() => projectPlans.id, { onDelete: 'cascade' }),
    companyId: text('company_id').notNull().references(() => companies.id),
    title: text('title').notNull(),
    description: text('description'),
    stepOrder: integer('step_order').notNull(),
    stepType: text('step_type', {
      enum: ['action', 'review_gate', 'permission_gate'],
    }).notNull().default('action'),
    status: text('status', {
      enum: ['pending', 'in_progress', 'completed', 'blocked', 'skipped'],
    }).notNull().default('pending'),
    gateApprovalId: text('gate_approval_id').references(() => approvals.id),
    gateConfig: jsonb('gate_config')
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    completedByUserId: text('completed_by_user_id'),
    completedByAgentId: text('completed_by_agent_id').references(() => agents.id),
    completedAt: timestamp('completed_at', { mode: 'date', precision: 3, withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date', precision: 3, withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('idx_project_plan_steps_plan_order').on(table.planId, table.stepOrder),
    index('idx_project_plan_steps_company_gate').on(table.companyId, table.gateApprovalId),
  ],
);
