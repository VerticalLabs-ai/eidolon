import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const CompanyStatus = {
  Active: 'active',
  Paused: 'paused',
  Archived: 'archived',
} as const;

export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];

export const CompanyStatusEnum = z.enum(['active', 'paused', 'archived']);

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface Company {
  id: string;
  name: string;
  description: string | null;
  mission: string | null;
  status: CompanyStatus;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  settings: Record<string, unknown>;
  brandColor: string | null;
  logoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const CompanySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().max(2000).nullable(),
  mission: z.string().max(2000).nullable(),
  status: CompanyStatusEnum,
  budgetMonthlyCents: z.number().int().nonnegative(),
  spentMonthlyCents: z.number().int().nonnegative(),
  settings: z.record(z.unknown()).default({}),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color')
    .nullable(),
  logoUrl: z.string().url().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateCompanyInputSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  mission: z.string().max(2000).optional(),
  status: CompanyStatusEnum.default('active'),
  budgetMonthlyCents: z.number().int().nonnegative().default(0),
  settings: z.record(z.unknown()).default({}),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color')
    .optional(),
  logoUrl: z.string().url().optional(),
});

export type CreateCompanyInput = z.infer<typeof CreateCompanyInputSchema>;

export const UpdateCompanyInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
  mission: z.string().max(2000).nullable().optional(),
  status: CompanyStatusEnum.optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
  settings: z.record(z.unknown()).optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color')
    .nullable()
    .optional(),
  logoUrl: z.string().url().nullable().optional(),
});

export type UpdateCompanyInput = z.infer<typeof UpdateCompanyInputSchema>;
