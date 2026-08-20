import { createHash } from 'node:crypto';
import {
  PLATFORM_HARD_CAPS,
  resolveBuiltInMode,
  type BuiltInMode,
  type ModeLimits,
  type ModePolicy,
  type ResolvedMode,
} from './modes.js';

/**
 * Effective policy resolution for a Mission run.
 *
 * The full deny-biased resolution that intersects platform, company, agent,
 * mode, and user layers is a later feature. This module resolves the mode
 * defaults against platform hard caps and optional user-lowered limits,
 * producing a finite immutable snapshot. User overrides may only lower
 * limits (minimum wins); they can never broaden authority.
 */

export interface UserLimits {
  costCents?: number;
  totalTokens?: number;
  durationSeconds?: number;
  providerCalls?: number;
  steps?: number;
  outputBytes?: number;
}

export interface AgentPolicyInput {
  provider: string;
  adapterId?: string;
  model: string;
  toolAllowlist: string[];
  domainAllowlist: string[];
}

export interface ResolvedPolicy {
  schemaVersion: number;
  sourceProfile: BuiltInMode;
  provider: string;
  adapterId: string | null;
  model: string;
  reasoningDepth: string | null;
  systemPromptHash: string | null;
  instructionHash: string | null;
  toolAllowlist: string[];
  domainAllowlist: string[];
  researchPolicy: Record<string, unknown>;
  planningPolicy: Record<string, unknown>;
  approvalPolicy: Record<string, unknown>;
  fallbackPolicy: Record<string, unknown>;
  partialResultPolicy: 'require_all' | 'best_effort';
  limits: ModeLimits;
  resolvedMode: ResolvedMode;
}

/** Minimum of two finite positive values, ignoring undefined. */
function minFinite(base: number, override?: number): number {
  if (override === undefined || Number.isNaN(override)) {
    return base;
  }
  return Math.min(base, override);
}

/**
 * Resolve the effective policy for a run. Platform caps and mode defaults
 * are intersected; user overrides may only lower numeric limits.
 */
export function resolvePolicy(input: {
  mode: BuiltInMode;
  agent?: AgentPolicyInput;
  userLimits?: UserLimits;
}): ResolvedPolicy {
  const { resolvedMode, policy } = resolveBuiltInMode(input.mode);

  // Apply platform hard caps (minimum wins) to the mode's limits.
  const capped: ModeLimits = {
    steps: policy.limits.steps,
    durationSeconds: Math.min(policy.limits.durationSeconds, PLATFORM_HARD_CAPS.durationSeconds),
    providerCalls: Math.min(policy.limits.providerCalls, PLATFORM_HARD_CAPS.providerCalls),
    totalTokens: Math.min(policy.limits.totalTokens, PLATFORM_HARD_CAPS.totalTokens),
    outputBytes: Math.min(policy.limits.outputBytes, PLATFORM_HARD_CAPS.outputBytes),
    costCents: Math.min(policy.limits.costCents, PLATFORM_HARD_CAPS.costCents),
    depth: Math.min(policy.limits.depth, PLATFORM_HARD_CAPS.depth),
    fanOut: Math.min(policy.limits.fanOut, PLATFORM_HARD_CAPS.fanOut),
    descendants: Math.min(policy.limits.descendants, PLATFORM_HARD_CAPS.descendants),
  };

  // User overrides may only lower limits.
  const limits: ModeLimits = {
    steps: minFinite(capped.steps, input.userLimits?.steps),
    durationSeconds: minFinite(capped.durationSeconds, input.userLimits?.durationSeconds),
    providerCalls: minFinite(capped.providerCalls, input.userLimits?.providerCalls),
    totalTokens: minFinite(capped.totalTokens, input.userLimits?.totalTokens),
    outputBytes: minFinite(capped.outputBytes, input.userLimits?.outputBytes),
    costCents: minFinite(capped.costCents, input.userLimits?.costCents),
    depth: capped.depth,
    fanOut: capped.fanOut,
    descendants: capped.descendants,
  };

  const agent = input.agent;
  const provider = agent?.provider ?? 'anthropic';
  const model = agent?.model ?? 'claude-sonnet-4-6';

  return {
    schemaVersion: 1,
    sourceProfile: input.mode,
    provider,
    adapterId: agent?.adapterId ?? null,
    model,
    reasoningDepth: null,
    systemPromptHash: null,
    instructionHash: null,
    toolAllowlist: agent?.toolAllowlist ?? [],
    domainAllowlist: agent?.domainAllowlist ?? [],
    researchPolicy: { access: policy.research },
    planningPolicy: { strategy: policy.planning },
    approvalPolicy: { strategy: policy.approval },
    fallbackPolicy: {},
    partialResultPolicy: policy.partialResultPolicy,
    limits,
    resolvedMode,
  };
}

/**
 * Canonical JSON serialization: recursively lexicographically sorted keys,
 * preserved array order, UTF-8, no whitespace. This is the stable basis for
 * content hashing.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`,
  );
  return `{${entries.join(',')}}`;
}

/** Lowercase SHA-256 hex of the canonical UTF-8 serialization of a value. */
export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalStringify(value), 'utf8').digest('hex');
}

/** The canonical hash of a resolved policy snapshot. */
export function policyContentHash(policy: ResolvedPolicy): string {
  return canonicalHash({
    schemaVersion: policy.schemaVersion,
    sourceProfile: policy.sourceProfile,
    provider: policy.provider,
    adapterId: policy.adapterId,
    model: policy.model,
    reasoningDepth: policy.reasoningDepth,
    systemPromptHash: policy.systemPromptHash,
    instructionHash: policy.instructionHash,
    toolAllowlist: policy.toolAllowlist,
    domainAllowlist: policy.domainAllowlist,
    researchPolicy: policy.researchPolicy,
    planningPolicy: policy.planningPolicy,
    approvalPolicy: policy.approvalPolicy,
    fallbackPolicy: policy.fallbackPolicy,
    partialResultPolicy: policy.partialResultPolicy,
    limits: policy.limits,
    resolvedMode: policy.resolvedMode,
  });
}

/** The canonical hash of a start request envelope. */
export function requestContentHash(envelope: unknown): string {
  return canonicalHash(envelope);
}

export type { ModePolicy };
