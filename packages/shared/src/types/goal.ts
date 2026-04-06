import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const GoalLevel = {
  Mission: 'mission',
  Objective: 'objective',
  KeyResult: 'key_result',
  Initiative: 'initiative',
  Task: 'task',
} as const;

export type GoalLevel = (typeof GoalLevel)[keyof typeof GoalLevel];

export const GoalLevelEnum = z.enum([
  'mission',
  'objective',
  'key_result',
  'initiative',
  'task',
]);

export const GoalStatus = {
  Planned: 'planned',
  Active: 'active',
  Completed: 'completed',
  Abandoned: 'abandoned',
} as const;

export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

export const GoalStatusEnum = z.enum([
  'planned',
  'active',
  'completed',
  'abandoned',
]);

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface Goal {
  id: string;
  companyId: string;
  title: string;
  description: string | null;
  level: GoalLevel;
  status: GoalStatus;
  parentId: string | null;
  ownerAgentId: string | null;
  progress: number;
  targetDate: Date | null;
  metrics: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const GoalSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable(),
  level: GoalLevelEnum,
  status: GoalStatusEnum,
  parentId: z.string().uuid().nullable(),
  ownerAgentId: z.string().uuid().nullable(),
  progress: z.number().min(0).max(100),
  targetDate: z.coerce.date().nullable(),
  metrics: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateGoalInputSchema = z.object({
  companyId: z.string().uuid(),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  level: GoalLevelEnum,
  status: GoalStatusEnum.default('planned'),
  parentId: z.string().uuid().nullable().default(null),
  ownerAgentId: z.string().uuid().nullable().default(null),
  progress: z.number().min(0).max(100).default(0),
  targetDate: z.coerce.date().nullable().default(null),
  metrics: z.record(z.unknown()).default({}),
});

export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;

export const UpdateGoalInputSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(5000).nullable().optional(),
  level: GoalLevelEnum.optional(),
  status: GoalStatusEnum.optional(),
  parentId: z.string().uuid().nullable().optional(),
  ownerAgentId: z.string().uuid().nullable().optional(),
  progress: z.number().min(0).max(100).optional(),
  targetDate: z.coerce.date().nullable().optional(),
  metrics: z.record(z.unknown()).optional(),
});

export type UpdateGoalInput = z.infer<typeof UpdateGoalInputSchema>;
