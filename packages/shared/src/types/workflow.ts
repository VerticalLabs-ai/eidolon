import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Workflow lifecycle status. Aligned with the route contract in
 * server/src/routes/workflows.ts and the DB schema in
 * packages/db/src/schema/workflows.ts.
 */
export const WorkflowStatus = {
  Draft: 'draft',
  Active: 'active',
  Paused: 'paused',
  Archived: 'archived',
} as const;

export type WorkflowStatus =
  (typeof WorkflowStatus)[keyof typeof WorkflowStatus];

export const WorkflowStatusEnum = z.enum([
  'draft',
  'active',
  'paused',
  'archived',
]);

/**
 * The type of a workflow node. Aligned with the route contract.
 */
export const WorkflowNodeType = {
  Task: 'task',
  Decision: 'decision',
  Trigger: 'trigger',
  Action: 'action',
} as const;

export type WorkflowNodeType =
  (typeof WorkflowNodeType)[keyof typeof WorkflowNodeType];

export const WorkflowNodeTypeEnum = z.enum([
  'task',
  'decision',
  'trigger',
  'action',
]);

/**
 * Execution status of an individual workflow node.
 */
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

/**
 * A single node in a workflow DAG. Stored as JSON in the `nodes` column.
 * Aligned with the route-local WorkflowNode contract.
 */
export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  label: string;
  agentId?: string;
  taskId?: string;
  config: Record<string, unknown>;
  status: WorkflowNodeStatus;
  dependsOn: string[];
}

/**
 * A workflow definition. The `projectId` field is nullable — workflows may be
 * company-scoped (null) or project-scoped.
 */
export interface Workflow {
  id: string;
  companyId: string;
  projectId: string | null;
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
  id: z.string().min(1),
  type: WorkflowNodeTypeEnum,
  label: z.string().min(1).max(255),
  agentId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  config: z.record(z.unknown()).default({}),
  status: WorkflowNodeStatusEnum.default('pending'),
  dependsOn: z.array(z.string()).default([]),
});

export const WorkflowSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  name: z.string().min(1).max(255),
  description: z.string().max(5000).nullable(),
  nodes: z.array(WorkflowNodeSchema),
  status: WorkflowStatusEnum,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateWorkflowNodeInputSchema = z.object({
  id: z.string().min(1),
  type: WorkflowNodeTypeEnum,
  label: z.string().min(1).max(255),
  agentId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  config: z.record(z.unknown()).default({}),
  status: WorkflowNodeStatusEnum.default('pending'),
  dependsOn: z.array(z.string()).default([]),
});

export type CreateWorkflowNodeInput = z.infer<
  typeof CreateWorkflowNodeInputSchema
>;

export const CreateWorkflowInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional(),
  status: WorkflowStatusEnum.default('draft'),
  nodes: z.array(WorkflowNodeSchema).default([]),
  projectId: z.string().uuid().nullable().optional(),
});

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

export const UpdateWorkflowInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: WorkflowStatusEnum.optional(),
  nodes: z.array(WorkflowNodeSchema).optional(),
});

export type UpdateWorkflowInput = z.infer<typeof UpdateWorkflowInputSchema>;

export const UpdateNodeInputSchema = z.object({
  status: WorkflowNodeStatusEnum,
  config: z.record(z.unknown()).optional(),
});

export type UpdateNodeInput = z.infer<typeof UpdateNodeInputSchema>;
