import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const TaskStatus = {
  Backlog: 'backlog',
  Todo: 'todo',
  InProgress: 'in_progress',
  Review: 'review',
  Done: 'done',
  Cancelled: 'cancelled',
  TimedOut: 'timed_out',
} as const;

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskStatusEnum = z.enum([
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
  'cancelled',
  'timed_out',
]);

export const TaskPriority = {
  Critical: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
} as const;

export type TaskPriority = (typeof TaskPriority)[keyof typeof TaskPriority];

export const TaskPriorityEnum = z.enum(['critical', 'high', 'medium', 'low']);

export const TaskType = {
  Epic: 'epic',
  Story: 'story',
  Task: 'task',
  Subtask: 'subtask',
  Bug: 'bug',
} as const;

export type TaskType = (typeof TaskType)[keyof typeof TaskType];

export const TaskTypeEnum = z.enum([
  'epic',
  'story',
  'task',
  'subtask',
  'bug',
]);

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  companyId: string;
  projectId: string | null;
  goalId: string | null;
  parentId: string | null;
  title: string;
  description: string | null;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  taskNumber: number;
  identifier: string;
  dependencies: string[];
  estimatedTokens: number | null;
  actualTokens: number | null;
  tags: string[];
  dueAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const TaskSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  goalId: z.string().uuid().nullable(),
  parentId: z.string().uuid().nullable(),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).nullable(),
  type: TaskTypeEnum,
  status: TaskStatusEnum,
  priority: TaskPriorityEnum,
  assigneeAgentId: z.string().uuid().nullable(),
  createdByAgentId: z.string().uuid().nullable(),
  createdByUserId: z.string().uuid().nullable(),
  taskNumber: z.number().int().positive(),
  identifier: z.string().min(1).max(50),
  dependencies: z.array(z.string().uuid()),
  estimatedTokens: z.number().int().nonnegative().nullable(),
  actualTokens: z.number().int().nonnegative().nullable(),
  tags: z.array(z.string().min(1).max(50)),
  dueAt: z.coerce.date().nullable(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateTaskInputSchema = z.object({
  companyId: z.string().uuid(),
  projectId: z.string().uuid().nullable().default(null),
  goalId: z.string().uuid().nullable().default(null),
  parentId: z.string().uuid().nullable().default(null),
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  type: TaskTypeEnum,
  status: TaskStatusEnum.default('backlog'),
  priority: TaskPriorityEnum.default('medium'),
  assigneeAgentId: z.string().uuid().nullable().default(null),
  createdByAgentId: z.string().uuid().nullable().default(null),
  createdByUserId: z.string().uuid().nullable().default(null),
  dependencies: z.array(z.string().uuid()).default([]),
  estimatedTokens: z.number().int().nonnegative().nullable().default(null),
  tags: z.array(z.string().min(1).max(50)).default([]),
  dueAt: z.coerce.date().nullable().default(null),
});

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(50_000).nullable().optional(),
  type: TaskTypeEnum.optional(),
  status: TaskStatusEnum.optional(),
  priority: TaskPriorityEnum.optional(),
  assigneeAgentId: z.string().uuid().nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  goalId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  dependencies: z.array(z.string().uuid()).optional(),
  estimatedTokens: z.number().int().nonnegative().nullable().optional(),
  actualTokens: z.number().int().nonnegative().nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).optional(),
  dueAt: z.coerce.date().nullable().optional(),
  startedAt: z.coerce.date().nullable().optional(),
  completedAt: z.coerce.date().nullable().optional(),
});

export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;
