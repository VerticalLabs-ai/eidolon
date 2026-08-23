import { createHash } from 'node:crypto';
import {
  PLATFORM_HARD_CAPS,
  resolveBuiltInMode,
  type BuiltInMode,
  type ModeLimits,
  type ModePolicy,
  type ResolvedMode,
} from './modes.js';
import { AppError } from '../../middleware/error-handler.js';

/**
 * Effective policy resolution for a Mission run.
 *
 * The full deny-biased resolution that intersects platform, company, agent,
 * mode, and user layers is a later feature. This module resolves the mode
 * defaults against platform hard caps and optional user-lowered limits,
 * producing a finite immutable snapshot. User overrides may only lower
 * limits (minimum wins); they can never broaden authority.
 *
 * Custom profiles (VAL-MODEQ-019, VAL-MODEQ-020) are resolved by
 * `resolveCustomPolicy`, which intersects the profile config with platform
 * hard caps and agent policy. A custom profile may only narrow authority;
 * if a declared requirement becomes empty or unsatisfiable, start fails
 * with 422 POLICY_UNSATISFIABLE — never by broadening authority.
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
  /** Agent lifecycle status for eligibility checks. */
  status?: string;
  /** Agent capabilities for required-capability checks. */
  capabilities?: string[];
}

export interface ResolvedPolicy {
  schemaVersion: number;
  /** Built-in mode slug (e.g. "fast") or custom profile slug. */
  sourceProfile: string;
  /** Custom profile row version (null for built-in modes). */
  sourceProfileVersion?: number | null;
  /** Custom profile row ID (null for built-in modes). */
  modeProfileId?: string | null;
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
    sourceProfile: input.mode as string,
    sourceProfileVersion: null,
    modeProfileId: null,
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
 * preserved array order, UTF-8, no whitespace. `undefined` values are
 * stripped from objects so that `{ a: 1, b: undefined }` and `{ a: 1 }`
 * produce the same canonical form. This is the stable basis for content
 * hashing and ensures canonical and convenience routes normalize omitted
 * optional fields identically before hashing.
 */
export function canonicalStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>)
    .sort()
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined);
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
    sourceProfileVersion: policy.sourceProfileVersion ?? null,
    modeProfileId: policy.modeProfileId ?? null,
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

// ---------------------------------------------------------------------------
// Custom profile policy resolution (VAL-MODEQ-019, VAL-MODEQ-020)
// ---------------------------------------------------------------------------

/** Parsed custom profile config shape (matches mode-profile-schema.ts). */
export interface CustomProfileConfig {
  planning?: 'never' | 'when_complex' | 'always';
  approval?: 'never' | 'when_complex' | 'always';
  research?: 'off' | 'allowed' | 'required';
  partialResultPolicy?: 'require_all' | 'best_effort';
  limits?: Partial<ModeLimits>;
  toolAllowlist?: string[];
  domainAllowlist?: string[];
  requiredCapabilities?: string[];
  requiredProvider?: string;
  requiredModel?: string;
}

/** Agent statuses that are eligible for Mission start. */
const ACTIVE_AGENT_STATUSES = new Set(['idle', 'working']);

/**
 * Check initiating-agent eligibility for Mission start.
 *
 * (VAL-MODEQ-123) Start rejects a missing, deleted, foreign-company,
 * unauthorized, inactive, provider-incompatible, or otherwise ineligible
 * initiating agent with scope-safe 404 or POLICY_UNSATISFIABLE, creates no
 * run/reservation/call/card, and ignores or rejects request-supplied
 * billing/executing identities.
 *
 * Returns the validated agent or throws an AppError.
 */
export function checkAgentEligibility(
  agent: AgentPolicyInput & { id: string },
  config?: CustomProfileConfig,
): void {
  // Check agent status: paused/error/offline are inactive.
  if (agent.status && !ACTIVE_AGENT_STATUSES.has(agent.status)) {
    throw new AppError(
      422,
      'POLICY_UNSATISFIABLE',
      'The initiating agent is not available for Mission work.',
    );
  }

  if (config) {
    // Required provider: agent's provider must match.
    if (config.requiredProvider && agent.provider !== config.requiredProvider) {
      throw new AppError(
        422,
        'POLICY_UNSATISFIABLE',
        'The custom mode requires a provider that the initiating agent does not use.',
      );
    }

    // Required model: agent's model must match.
    if (config.requiredModel && agent.model !== config.requiredModel) {
      throw new AppError(
        422,
        'POLICY_UNSATISFIABLE',
        'The custom mode requires a model that the initiating agent does not use.',
      );
    }

    // Required capabilities: agent must possess all required capabilities.
    if (config.requiredCapabilities && config.requiredCapabilities.length > 0) {
      const agentCaps = new Set(agent.capabilities ?? []);
      const missing = config.requiredCapabilities.filter((c) => !agentCaps.has(c));
      if (missing.length > 0) {
        throw new AppError(
          422,
          'POLICY_UNSATISFIABLE',
          'The initiating agent lacks required capabilities for this custom mode.',
        );
      }
    }
  }
}

/**
 * Resolve the effective policy for a custom profile run.
 *
 * The profile config is intersected with platform hard caps and agent
 * policy. For sets (tools, domains), use intersection — explicit deny wins.
 * For maxima (limits), use the minimum non-null value. An empty required
 * intersection fails with 422 POLICY_UNSATISFIABLE, never a permissive
 * fallback.
 *
 * (VAL-MODEQ-019: ineligible custom mode denies start; VAL-MODEQ-020:
 * custom mode can only narrow — never broaden authority.)
 */
export function resolveCustomPolicy(input: {
  profileSlug: string;
  profileVersion: number;
  profileId: string;
  config: CustomProfileConfig;
  agent?: AgentPolicyInput;
  userLimits?: UserLimits;
}): ResolvedPolicy {
  const { config, agent } = input;

  // Check agent eligibility against the profile's required fields.
  if (agent) {
    checkAgentEligibility(
      { ...agent, id: input.profileId } as AgentPolicyInput & { id: string },
      config,
    );
  }

  // Resolve policy fields from the profile config, defaulting to the
  // most conservative built-in (deep_work) defaults for unspecified fields.
  const planning = config.planning ?? 'always';
  const approval = config.approval ?? 'always';
  const research = config.research ?? 'off';
  const partialResultPolicy = config.partialResultPolicy ?? 'require_all';

  // Apply platform hard caps to the profile's limits. The profile limits
  // are optional; for unspecified limits, use platform hard caps as the
  // base (the most permissive allowed value).
  const profileLimits = config.limits ?? {};
  const capped: ModeLimits = {
    steps: Math.min(
      profileLimits.steps ?? PLATFORM_HARD_CAPS.providerCalls,
      PLATFORM_HARD_CAPS.providerCalls,
    ),
    durationSeconds: Math.min(
      profileLimits.durationSeconds ?? PLATFORM_HARD_CAPS.durationSeconds,
      PLATFORM_HARD_CAPS.durationSeconds,
    ),
    providerCalls: Math.min(
      profileLimits.providerCalls ?? PLATFORM_HARD_CAPS.providerCalls,
      PLATFORM_HARD_CAPS.providerCalls,
    ),
    totalTokens: Math.min(
      profileLimits.totalTokens ?? PLATFORM_HARD_CAPS.totalTokens,
      PLATFORM_HARD_CAPS.totalTokens,
    ),
    outputBytes: Math.min(
      profileLimits.outputBytes ?? PLATFORM_HARD_CAPS.outputBytes,
      PLATFORM_HARD_CAPS.outputBytes,
    ),
    costCents: Math.min(
      profileLimits.costCents ?? PLATFORM_HARD_CAPS.costCents,
      PLATFORM_HARD_CAPS.costCents,
    ),
    depth: Math.min(profileLimits.depth ?? PLATFORM_HARD_CAPS.depth, PLATFORM_HARD_CAPS.depth),
    fanOut: Math.min(profileLimits.fanOut ?? PLATFORM_HARD_CAPS.fanOut, PLATFORM_HARD_CAPS.fanOut),
    descendants: Math.min(
      profileLimits.descendants ?? PLATFORM_HARD_CAPS.descendants,
      PLATFORM_HARD_CAPS.descendants,
    ),
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

  // Intersect tool allowlists: profile ∩ agent (empty if either is empty
  // and the other is specified). If the profile specifies tools, the agent
  // must have them; intersection. If the profile doesn't specify tools,
  // inherit the agent's tools.
  let toolAllowlist: string[];
  if (config.toolAllowlist && config.toolAllowlist.length > 0) {
    const agentTools = new Set(agent?.toolAllowlist ?? []);
    toolAllowlist = config.toolAllowlist.filter((t) => agentTools.has(t));
    // If the profile requires tools but the intersection is empty, the
    // profile's tool requirements are unsatisfiable.
    if (toolAllowlist.length === 0) {
      throw new AppError(
        422,
        'POLICY_UNSATISFIABLE',
        'The custom mode requires tools that the initiating agent does not have.',
      );
    }
  } else {
    toolAllowlist = agent?.toolAllowlist ?? [];
  }

  // Intersect domain allowlists similarly.
  let domainAllowlist: string[];
  if (config.domainAllowlist && config.domainAllowlist.length > 0) {
    const agentDomains = new Set(agent?.domainAllowlist ?? []);
    domainAllowlist = config.domainAllowlist.filter((d) => agentDomains.has(d));
  } else {
    domainAllowlist = agent?.domainAllowlist ?? [];
  }

  const provider = agent?.provider ?? 'anthropic';
  const model = agent?.model ?? 'claude-sonnet-4-6';

  return {
    schemaVersion: 1,
    sourceProfile: input.profileSlug,
    sourceProfileVersion: input.profileVersion,
    modeProfileId: input.profileId,
    provider,
    adapterId: agent?.adapterId ?? null,
    model,
    reasoningDepth: null,
    systemPromptHash: null,
    instructionHash: null,
    toolAllowlist,
    domainAllowlist,
    researchPolicy: { access: research },
    planningPolicy: { strategy: planning },
    approvalPolicy: { strategy: approval },
    fallbackPolicy: {},
    partialResultPolicy,
    limits,
    resolvedMode: 'custom',
  };
}

export type { ModePolicy };
