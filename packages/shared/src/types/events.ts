import { z } from 'zod';
import type { AgentStatus } from './agent.js';
import type { TaskStatus, TaskPriority } from './task.js';
import type { WorkflowNodeStatus } from './workflow.js';
import { AgentStatusEnum } from './agent.js';
import { TaskStatusEnum, TaskPriorityEnum } from './task.js';
import { WorkflowNodeStatusEnum } from './workflow.js';

// ---------------------------------------------------------------------------
// Event type discriminator
// ---------------------------------------------------------------------------

export const ServerEventType = {
  AgentStatusChanged: 'agent.status_changed',
  TaskUpdated: 'task.updated',
  TaskCreated: 'task.created',
  MessageNew: 'message.new',
  BudgetAlert: 'budget.alert',
  Heartbeat: 'heartbeat',
  WorkflowStepCompleted: 'workflow.step_completed',
} as const;

export type ServerEventType =
  (typeof ServerEventType)[keyof typeof ServerEventType];

// ---------------------------------------------------------------------------
// Typed payloads
// ---------------------------------------------------------------------------

export interface AgentStatusChangedPayload {
  agentId: string;
  companyId: string;
  previousStatus: AgentStatus;
  newStatus: AgentStatus;
  reason: string | null;
  timestamp: Date;
}

export interface TaskUpdatedPayload {
  taskId: string;
  companyId: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  updatedBy: string;
  timestamp: Date;
}

export interface TaskCreatedPayload {
  taskId: string;
  companyId: string;
  title: string;
  type: string;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  createdBy: string;
  timestamp: Date;
}

export interface MessageNewPayload {
  messageId: string;
  companyId: string;
  fromAgentId: string;
  toAgentId: string;
  type: string;
  subject: string;
  threadId: string | null;
  timestamp: Date;
}

export interface BudgetAlertPayload {
  alertId: string;
  companyId: string;
  agentId: string | null;
  threshold: number;
  currentUtilization: number;
  period: string;
  timestamp: Date;
}

export interface HeartbeatPayload {
  serverTime: Date;
  connectedClients: number;
}

export interface WorkflowStepCompletedPayload {
  workflowId: string;
  companyId: string;
  nodeId: string;
  taskId: string;
  status: WorkflowNodeStatus;
  nextNodes: string[];
  timestamp: Date;
}

// ---------------------------------------------------------------------------
// Discriminated union for all server events
// ---------------------------------------------------------------------------

export type ServerEvent =
  | {
      type: typeof ServerEventType.AgentStatusChanged;
      payload: AgentStatusChangedPayload;
    }
  | {
      type: typeof ServerEventType.TaskUpdated;
      payload: TaskUpdatedPayload;
    }
  | {
      type: typeof ServerEventType.TaskCreated;
      payload: TaskCreatedPayload;
    }
  | {
      type: typeof ServerEventType.MessageNew;
      payload: MessageNewPayload;
    }
  | {
      type: typeof ServerEventType.BudgetAlert;
      payload: BudgetAlertPayload;
    }
  | {
      type: typeof ServerEventType.Heartbeat;
      payload: HeartbeatPayload;
    }
  | {
      type: typeof ServerEventType.WorkflowStepCompleted;
      payload: WorkflowStepCompletedPayload;
    };

// ---------------------------------------------------------------------------
// Zod schemas for runtime validation of incoming events
// ---------------------------------------------------------------------------

export const AgentStatusChangedPayloadSchema = z.object({
  agentId: z.string().uuid(),
  companyId: z.string().uuid(),
  previousStatus: AgentStatusEnum,
  newStatus: AgentStatusEnum,
  reason: z.string().max(1000).nullable(),
  timestamp: z.coerce.date(),
});

export const TaskUpdatedPayloadSchema = z.object({
  taskId: z.string().uuid(),
  companyId: z.string().uuid(),
  changes: z.record(
    z.object({ from: z.unknown(), to: z.unknown() }),
  ),
  updatedBy: z.string().uuid(),
  timestamp: z.coerce.date(),
});

export const TaskCreatedPayloadSchema = z.object({
  taskId: z.string().uuid(),
  companyId: z.string().uuid(),
  title: z.string(),
  type: z.string(),
  status: TaskStatusEnum,
  priority: TaskPriorityEnum,
  assigneeAgentId: z.string().uuid().nullable(),
  createdBy: z.string().uuid(),
  timestamp: z.coerce.date(),
});

export const MessageNewPayloadSchema = z.object({
  messageId: z.string().uuid(),
  companyId: z.string().uuid(),
  fromAgentId: z.string().uuid(),
  toAgentId: z.string().uuid(),
  type: z.string(),
  subject: z.string(),
  threadId: z.string().uuid().nullable(),
  timestamp: z.coerce.date(),
});

export const BudgetAlertPayloadSchema = z.object({
  alertId: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  threshold: z.number().min(0).max(100),
  currentUtilization: z.number().min(0),
  period: z.string(),
  timestamp: z.coerce.date(),
});

export const HeartbeatPayloadSchema = z.object({
  serverTime: z.coerce.date(),
  connectedClients: z.number().int().nonnegative(),
});

export const WorkflowStepCompletedPayloadSchema = z.object({
  workflowId: z.string().uuid(),
  companyId: z.string().uuid(),
  nodeId: z.string().uuid(),
  taskId: z.string().uuid(),
  status: WorkflowNodeStatusEnum,
  nextNodes: z.array(z.string().uuid()),
  timestamp: z.coerce.date(),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('agent.status_changed'),
    payload: AgentStatusChangedPayloadSchema,
  }),
  z.object({
    type: z.literal('task.updated'),
    payload: TaskUpdatedPayloadSchema,
  }),
  z.object({
    type: z.literal('task.created'),
    payload: TaskCreatedPayloadSchema,
  }),
  z.object({
    type: z.literal('message.new'),
    payload: MessageNewPayloadSchema,
  }),
  z.object({
    type: z.literal('budget.alert'),
    payload: BudgetAlertPayloadSchema,
  }),
  z.object({
    type: z.literal('heartbeat'),
    payload: HeartbeatPayloadSchema,
  }),
  z.object({
    type: z.literal('workflow.step_completed'),
    payload: WorkflowStepCompletedPayloadSchema,
  }),
]);
