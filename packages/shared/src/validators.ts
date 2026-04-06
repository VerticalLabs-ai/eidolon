/**
 * Centralized re-export of all Zod validation schemas used across the Eidolon
 * monorepo. Consumers can import any schema from `@eidolon/shared` directly,
 * but this module groups them for convenience when you need multiple schemas
 * in one place (e.g. an API route handler that validates several payloads).
 */

// ---------------------------------------------------------------------------
// Company validators
// ---------------------------------------------------------------------------
export {
  CompanySchema,
  CompanyStatusEnum,
  CreateCompanyInputSchema,
  UpdateCompanyInputSchema,
} from './types/company.js';

// ---------------------------------------------------------------------------
// Agent validators
// ---------------------------------------------------------------------------
export {
  AgentSchema,
  AgentStatusEnum,
  AgentRoleEnum,
  AgentProviderEnum,
  CreateAgentInputSchema,
  UpdateAgentInputSchema,
} from './types/agent.js';

// ---------------------------------------------------------------------------
// Task validators
// ---------------------------------------------------------------------------
export {
  TaskSchema,
  TaskStatusEnum,
  TaskPriorityEnum,
  TaskTypeEnum,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
} from './types/task.js';

// ---------------------------------------------------------------------------
// Goal validators
// ---------------------------------------------------------------------------
export {
  GoalSchema,
  GoalLevelEnum,
  GoalStatusEnum,
  CreateGoalInputSchema,
  UpdateGoalInputSchema,
} from './types/goal.js';

// ---------------------------------------------------------------------------
// Workflow validators
// ---------------------------------------------------------------------------
export {
  WorkflowSchema,
  WorkflowNodeSchema,
  WorkflowStatusEnum,
  WorkflowNodeStatusEnum,
  CreateWorkflowInputSchema,
  CreateWorkflowNodeInputSchema,
  UpdateWorkflowInputSchema,
} from './types/workflow.js';

// ---------------------------------------------------------------------------
// Message validators
// ---------------------------------------------------------------------------
export {
  MessageSchema,
  MessageTypeEnum,
  CreateMessageInputSchema,
} from './types/message.js';

// ---------------------------------------------------------------------------
// Budget validators
// ---------------------------------------------------------------------------
export {
  BudgetAlertSchema,
  BudgetPeriodEnum,
  CostEventSchema,
  CreateBudgetAlertInputSchema,
  UpdateBudgetAlertInputSchema,
  CreateCostEventInputSchema,
} from './types/budget.js';

// ---------------------------------------------------------------------------
// Analytics validators
// ---------------------------------------------------------------------------
export {
  AgentMetricsSchema,
  CompanyMetricsSchema,
} from './types/analytics.js';

// ---------------------------------------------------------------------------
// Event validators
// ---------------------------------------------------------------------------
export {
  ServerEventSchema,
  AgentStatusChangedPayloadSchema,
  TaskUpdatedPayloadSchema,
  TaskCreatedPayloadSchema,
  MessageNewPayloadSchema,
  BudgetAlertPayloadSchema,
  HeartbeatPayloadSchema,
  WorkflowStepCompletedPayloadSchema,
} from './types/events.js';

// ---------------------------------------------------------------------------
// Common helpers
// ---------------------------------------------------------------------------

import { z } from 'zod';

/** Validates a UUID v4 string. */
export const UuidSchema = z.string().uuid();

/** Validates pagination parameters. */
export const PaginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type PaginationInput = z.infer<typeof PaginationSchema>;

/** Validates sort direction. */
export const SortDirectionSchema = z.enum(['asc', 'desc']).default('desc');

export type SortDirection = z.infer<typeof SortDirectionSchema>;

/** Validates a date range filter. */
export const DateRangeSchema = z
  .object({
    from: z.coerce.date(),
    to: z.coerce.date(),
  })
  .refine((data) => data.from <= data.to, {
    message: '"from" date must be before or equal to "to" date',
  });

export type DateRange = z.infer<typeof DateRangeSchema>;
