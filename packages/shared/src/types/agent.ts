import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const AgentStatus = {
  Idle: 'idle',
  Working: 'working',
  Paused: 'paused',
  Error: 'error',
  Terminated: 'terminated',
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export const AgentStatusEnum = z.enum([
  'idle',
  'working',
  'paused',
  'error',
  'terminated',
]);

export const AgentRole = {
  Ceo: 'ceo',
  Cto: 'cto',
  Engineer: 'engineer',
  Designer: 'designer',
  Marketer: 'marketer',
  Analyst: 'analyst',
  Support: 'support',
  Custom: 'custom',
} as const;

export type AgentRole = (typeof AgentRole)[keyof typeof AgentRole];

export const AgentRoleEnum = z.enum([
  'ceo',
  'cto',
  'engineer',
  'designer',
  'marketer',
  'analyst',
  'support',
  'custom',
]);

export const AgentProvider = {
  Anthropic: 'anthropic',
  OpenAI: 'openai',
  Google: 'google',
  Local: 'local',
  Custom: 'custom',
} as const;

export type AgentProvider = (typeof AgentProvider)[keyof typeof AgentProvider];

export const AgentProviderEnum = z.enum([
  'anthropic',
  'openai',
  'google',
  'local',
  'custom',
]);

// ---------------------------------------------------------------------------
// Core interface
// ---------------------------------------------------------------------------

export interface Agent {
  id: string;
  companyId: string;
  name: string;
  role: AgentRole;
  title: string;
  provider: AgentProvider;
  model: string;
  status: AgentStatus;
  reportsTo: string | null;
  capabilities: string[];
  systemPrompt: string;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  lastHeartbeatAt: Date | null;
  config: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const AgentSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  name: z.string().min(1).max(255),
  role: AgentRoleEnum,
  title: z.string().min(1).max(255),
  provider: AgentProviderEnum,
  model: z.string().min(1).max(255),
  status: AgentStatusEnum,
  reportsTo: z.string().uuid().nullable(),
  capabilities: z.array(z.string().min(1).max(100)),
  systemPrompt: z.string().min(1).max(50_000),
  budgetMonthlyCents: z.number().int().nonnegative(),
  spentMonthlyCents: z.number().int().nonnegative(),
  lastHeartbeatAt: z.coerce.date().nullable(),
  config: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Create / Update DTOs
// ---------------------------------------------------------------------------

export const CreateAgentInputSchema = z.object({
  companyId: z.string().uuid(),
  name: z.string().min(1).max(255),
  role: AgentRoleEnum,
  title: z.string().min(1).max(255),
  provider: AgentProviderEnum,
  model: z.string().min(1).max(255),
  status: AgentStatusEnum.default('idle'),
  reportsTo: z.string().uuid().nullable().default(null),
  capabilities: z.array(z.string().min(1).max(100)).default([]),
  systemPrompt: z.string().min(1).max(50_000),
  budgetMonthlyCents: z.number().int().nonnegative().default(0),
  config: z.record(z.unknown()).default({}),
  metadata: z.record(z.unknown()).default({}),
});

export type CreateAgentInput = z.infer<typeof CreateAgentInputSchema>;

export const UpdateAgentInputSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  role: AgentRoleEnum.optional(),
  title: z.string().min(1).max(255).optional(),
  provider: AgentProviderEnum.optional(),
  model: z.string().min(1).max(255).optional(),
  status: AgentStatusEnum.optional(),
  reportsTo: z.string().uuid().nullable().optional(),
  capabilities: z.array(z.string().min(1).max(100)).optional(),
  systemPrompt: z.string().min(1).max(50_000).optional(),
  budgetMonthlyCents: z.number().int().nonnegative().optional(),
  config: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>;
