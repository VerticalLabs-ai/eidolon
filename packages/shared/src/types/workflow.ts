import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const WorkflowStatus = {
  Draft: 'draft',
  Active: 'active',
  Paused: 'paused',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type WorkflowStatus =
  (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

export const WorkflowStatusEnum = z.enum([
  'draft',
  'active',
  'paused',
  'completed',
  'failed',
]);

export const WorkflowNodeStatus = {
  Pending: 'pending',
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Skipped: 'skipped',
} as const;

export type WorkflowNodeStatus =
  (typeof WorkflowNodeStatus)[keyof typeof WorkflowNodeStatus];

export const WorkflowNodeStatusEnum = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
]);

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface WorkflowNode {
  id: string;
  taskId: string;
  dependsOn: string[];
  status: WorkflowNodeStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
}

export interface Workflow {
  id: string;
  companyId: string;
  name: string;
  description: string | null;
  nodes: WorkflowNode[];
  status: WorkflowStatus;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const WorkflowNodeSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  dependsOn: z.array(z.string().uuid()),
  status: WorkflowNodeStatusEnum,
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  error: z.string().max(5000).nullable(),
});

export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable(),
  nodes: z.array(WorkflowNodeSchema),
  status: WorkflowStatusEnum,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateWorkflowNodeInputSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  dependsOn: z.array(z.string().uuid()).default([]),
});

export type CreateWorkflowNodeInput = z.infer<
  typeof CreateWorkflowNodeInputSchema
>;

export const CreateWorkflowInputSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  nodes: z.array(CreateWorkflowNodeInputSchema).min(1),
  status: WorkflowStatusEnum.default('draft'),
});

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

export const UpdateWorkflowInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  status: WorkflowStatusEnum.optional(),
  nodes: z.array(CreateWorkflowNodeInputSchema).optional(),
});

export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowInputSchema>;
