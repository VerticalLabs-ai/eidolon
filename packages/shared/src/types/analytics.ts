import { z } from 'zod';

// ---------------------------------------------------------------------------
// Agent-level metrics
// ---------------------------------------------------------------------------

export interface AgentMetrics {
  agentId: string;
  companyId: string;
  period: string;
  tasksCompleted: number;
  tasksInProgress: number;
  tasksFailed: number;
  avgCompletionTimeMs: number;
  tokenUsage: {
    input: number;
    output: number;
    total: number;
  };
  costCents: number;
  efficiency: number;
  uptimePercent: number;
  messagesReceived: number;
  messagesSent: number;
  errorCount: number;
  lastCalculatedAt: Date;
}

export const AgentMetricsSchema = z.object({
  agentId: z.string().uuid(),
  companyId: z.string().uuid(),
  period: z.string().min(1),
  tasksCompleted: z.number().int().nonnegative(),
  tasksInProgress: z.number().int().nonnegative(),
  tasksFailed: z.number().int().nonnegative(),
  avgCompletionTimeMs: z.number().nonnegative(),
  tokenUsage: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  costCents: z.number().nonnegative(),
  efficiency: z.number().min(0).max(100),
  uptimePercent: z.number().min(0).max(100),
  messagesReceived: z.number().int().nonnegative(),
  messagesSent: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  lastCalculatedAt: z.coerce.date(),
});

// ---------------------------------------------------------------------------
// Company-level metrics
// ---------------------------------------------------------------------------

export interface CompanyMetrics {
  companyId: string;
  period: string;
  totalAgents: number;
  activeAgents: number;
  idleAgents: number;
  errorAgents: number;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  blockedTasks: number;
  totalCostCents: number;
  budgetUtilization: number;
  totalTokensUsed: number;
  avgTaskCompletionTimeMs: number;
  goalsCompleted: number;
  goalsInProgress: number;
  workflowsActive: number;
  workflowsCompleted: number;
  lastCalculatedAt: Date;
}

export const CompanyMetricsSchema = z.object({
  companyId: z.string().uuid(),
  period: z.string().min(1),
  totalAgents: z.number().int().nonnegative(),
  activeAgents: z.number().int().nonnegative(),
  idleAgents: z.number().int().nonnegative(),
  errorAgents: z.number().int().nonnegative(),
  totalTasks: z.number().int().nonnegative(),
  completedTasks: z.number().int().nonnegative(),
  inProgressTasks: z.number().int().nonnegative(),
  blockedTasks: z.number().int().nonnegative(),
  totalCostCents: z.number().nonnegative(),
  budgetUtilization: z.number().min(0).max(100),
  totalTokensUsed: z.number().int().nonnegative(),
  avgTaskCompletionTimeMs: z.number().nonnegative(),
  goalsCompleted: z.number().int().nonnegative(),
  goalsInProgress: z.number().int().nonnegative(),
  workflowsActive: z.number().int().nonnegative(),
  workflowsCompleted: z.number().int().nonnegative(),
  lastCalculatedAt: z.coerce.date(),
});
