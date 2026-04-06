import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const BudgetPeriod = {
  Daily: 'daily',
  Weekly: 'weekly',
  Monthly: 'monthly',
} as const;

export type BudgetPeriod = (typeof BudgetPeriod)[keyof typeof BudgetPeriod];

export const BudgetPeriodEnum = z.enum(['daily', 'weekly', 'monthly']);

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

export interface BudgetAlert {
  id: string;
  companyId: string;
  agentId: string | null;
  period: BudgetPeriod;
  threshold: number;
  triggered: boolean;
  triggeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  taskId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const BudgetAlertSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid().nullable(),
  period: BudgetPeriodEnum,
  threshold: z.number().min(0).max(100),
  triggered: z.boolean(),
  triggeredAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const CostEventSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(255),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costCents: z.number().nonnegative(),
  createdAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateBudgetAlertInputSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid().nullable().default(null),
  period: BudgetPeriodEnum,
  threshold: z.number().min(0).max(100),
});

export type CreateBudgetAlertInput = z.infer<
  typeof CreateBudgetAlertInputSchema
>;

export const UpdateBudgetAlertInputSchema = z.object({
  period: BudgetPeriodEnum.optional(),
  threshold: z.number().min(0).max(100).optional(),
  triggered: z.boolean().optional(),
});

export type UpdateBudgetAlertInput = z.infer<
  typeof UpdateBudgetAlertInputSchema
>;

export const CreateCostEventInputSchema = z.object({
  companyId: z.string().uuid(),
  agentId: z.string().uuid(),
  taskId: z.string().uuid().nullable().default(null),
  provider: z.string().min(1).max(100),
  model: z.string().min(1).max(255),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costCents: z.number().nonnegative(),
});

export type CreateCostEventInput = z.infer<typeof CreateCostEventInputSchema>;
