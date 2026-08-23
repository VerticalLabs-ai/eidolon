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
 * Resolution is deny-biased and deterministic, applying layers in strict
 * precedence order (VAL-MODEQ-035):
 *
 *   1. Platform hard caps
 *   2. Company governance (allowed/denied providers, tools, domains)
 *   3. Initiating-agent policy (provider, model, tools, domains, capabilities, status)
 *   4. Selected mode (built-in or custom profile)
 *   5. User reductions (lower limits, remove tools/domains — never broaden)
 *   6. Approved plan / child allocation (narrow only — later milestone)
 *
 * For sets (tools, domains, providers), use intersection; explicit deny
 * always wins. For maxima (limits), use the minimum non-null value. An
 * empty required intersection fails with 422 POLICY_UNSATISFIABLE, never a
 * permissive fallback (VAL-MODEQ-037). A user may lower limits or remove
 * tools/domains, but can never raise a limit or add a denied tool/domain
 * (VAL-MODEQ-036). An unsatisfiable policy creates no run, reservation,
 * call, or card (VAL-MODEQ-038).
 *
 * Custom profiles (VAL-MODEQ-019, VAL-MODEQ-020, VAL-CROSS-008) are resolved
 * by `resolveCustomPolicy`, which intersects the profile config with
 * platform, company, and agent layers. A custom profile may only narrow
 * authority; if a declared requirement becomes empty or unsatisfiable,
 * start fails with 422 POLICY_UNSATISFIABLE.
 */

export interface UserLimits {
  costCents?: number;
  totalTokens?: number;
  durationSeconds?: number;
  providerCalls?: number;
  steps?: number;
  outputBytes?: number;
}

/**
 * User reductions: a user may LOWER numeric limits and REMOVE tools/domains
 * at start. They can never raise a limit or add a tool/domain
 * (VAL-MODEQ-036). removedTools/removedDomains are subtracted from the
 * effective allowlist after all intersections.
 */
export interface UserReductions extends UserLimits {
  /** Tools the user explicitly removes (narrowing only). */
  removedTools?: string[];
  /** Domains the user explicitly removes (narrowing only). */
  removedDomains?: string[];
}

/**
 * Company governance layer (VAL-MODEQ-035, VAL-CROSS-008).
 *
 * Stored in `companies.settings.missionPolicy`. If an allowed* array is
 * specified, only items in it are permitted (intersection). denied* arrays
 * are explicit deny and always win (subtracted after intersection). An
 * unspecified array means "no restriction at this layer."
 */
export interface CompanyPolicyInput {
  /** If specified, only these providers are allowed. */
  allowedProviders?: string[];
  /** If specified, only these tools are allowed. */
  allowedTools?: string[];
  /** If specified, only these domains are allowed. */
  allowedDomains?: string[];
  /** Explicitly denied tools — always win over any allow. */
  deniedTools?: string[];
  /** Explicitly denied domains — always win over any allow. */
  deniedDomains?: string[];
  /** Company-level limit overrides (may only lower). */
  limits?: Partial<ModeLimits>;
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
 * Intersect multiple arrays, treating `undefined` as "all allowed" (no
 * restriction at that layer). Returns the intersection of all specified
 * arrays, preserving the order of the first specified array. If no arrays
 * are specified, returns `base`.
 *
 * This is the set-intersection law for deny-biased resolution: each layer
 * may only narrow, never broaden (VAL-MODEQ-035).
 */
function intersectAllowlists(base: string[], ...layers: (string[] | undefined)[]): string[] {
  let result = base;
  for (const layer of layers) {
    if (layer !== undefined && layer.length > 0) {
      const allowed = new Set(layer);
      result = result.filter((item) => allowed.has(item));
    }
  }
  return result;
}

/**
 * Remove explicitly denied items from an allowlist. Explicit deny always
 * wins over any allow (VAL-MODEQ-035).
 */
function applyDeny(allowlist: string[], denied?: string[]): string[] {
  if (!denied || denied.length === 0) {
    return allowlist;
  }
  const deniedSet = new Set(denied);
  return allowlist.filter((item) => !deniedSet.has(item));
}

/**
 * Resolve the effective policy for a built-in mode run.
 *
 * Applies the full deny-biased precedence: platform caps → company
 * governance → agent policy → mode → user reductions (VAL-MODEQ-035).
 * Sets intersect; explicit deny wins; maxima take the minimum. An empty
 * required intersection (provider) fails with 422 POLICY_UNSATISFIABLE
 * (VAL-MODEQ-037). User reductions may only lower limits or remove
 * tools/domains — never broaden (VAL-MODEQ-036).
 *
 * @param input.mode - The selected built-in mode.
 * @param input.agent - The initiating agent's policy (provider, model, tools, domains, status, capabilities).
 * @param input.company - Company governance (allowed/denied providers, tools, domains).
 * @param input.userReductions - User reductions (lower limits, remove tools/domains).
 */
export function resolvePolicy(input: {
  mode: BuiltInMode;
  agent?: AgentPolicyInput;
  company?: CompanyPolicyInput;
  userReductions?: UserReductions;
  /** @deprecated use userReductions — kept for backward compatibility. */
  userLimits?: UserLimits;
}): ResolvedPolicy {
  const { resolvedMode, policy } = resolveBuiltInMode(input.mode);
  const agent = input.agent;
  const company = input.company;
  const reductions: UserReductions = input.userReductions ?? input.userLimits ?? {};

  // --- Provider / model resolution (VAL-MODEQ-035, VAL-MODEQ-037) ---
  const provider = agent?.provider ?? 'anthropic';
  const model = agent?.model ?? 'claude-sonnet-4-6';

  // Company governance: if allowedProviders is specified, the agent's
  // provider must be in it. An empty intersection is unsatisfiable.
  if (company?.allowedProviders && company.allowedProviders.length > 0) {
    if (!company.allowedProviders.includes(provider)) {
      throw new AppError(
        422,
        'POLICY_UNSATISFIABLE',
        'The initiating agent uses a provider that is not allowed by company governance.',
      );
    }
  }

  // --- Tool allowlist resolution (intersection + explicit deny) ---
  // Layer order: agent tools → company allowedTools → company deniedTools → user removedTools.
  let toolAllowlist = intersectAllowlists(agent?.toolAllowlist ?? [], company?.allowedTools);
  toolAllowlist = applyDeny(toolAllowlist, company?.deniedTools);
  toolAllowlist = applyDeny(toolAllowlist, reductions.removedTools);

  // --- Domain allowlist resolution (intersection + explicit deny) ---
  let domainAllowlist = intersectAllowlists(agent?.domainAllowlist ?? [], company?.allowedDomains);
  domainAllowlist = applyDeny(domainAllowlist, company?.deniedDomains);
  domainAllowlist = applyDeny(domainAllowlist, reductions.removedDomains);

  // --- Limits resolution (minimum wins across all layers) ---
  // Start with mode defaults, apply platform caps, then company limits,
  // then user reductions. Each layer may only lower.
  const modeLimits = policy.limits;
  const platformCapped: ModeLimits = {
    steps: modeLimits.steps,
    durationSeconds: Math.min(modeLimits.durationSeconds, PLATFORM_HARD_CAPS.durationSeconds),
    providerCalls: Math.min(modeLimits.providerCalls, PLATFORM_HARD_CAPS.providerCalls),
    totalTokens: Math.min(modeLimits.totalTokens, PLATFORM_HARD_CAPS.totalTokens),
    outputBytes: Math.min(modeLimits.outputBytes, PLATFORM_HARD_CAPS.outputBytes),
    costCents: Math.min(modeLimits.costCents, PLATFORM_HARD_CAPS.costCents),
    depth: Math.min(modeLimits.depth, PLATFORM_HARD_CAPS.depth),
    fanOut: Math.min(modeLimits.fanOut, PLATFORM_HARD_CAPS.fanOut),
    descendants: Math.min(modeLimits.descendants, PLATFORM_HARD_CAPS.descendants),
  };

  // Company limits (may only lower).
  const companyLimits = company?.limits ?? {};
  const companyCapped: ModeLimits = {
    steps: minFinite(platformCapped.steps, companyLimits.steps),
    durationSeconds: minFinite(platformCapped.durationSeconds, companyLimits.durationSeconds),
    providerCalls: minFinite(platformCapped.providerCalls, companyLimits.providerCalls),
    totalTokens: minFinite(platformCapped.totalTokens, companyLimits.totalTokens),
    outputBytes: minFinite(platformCapped.outputBytes, companyLimits.outputBytes),
    costCents: minFinite(platformCapped.costCents, companyLimits.costCents),
    depth: minFinite(platformCapped.depth, companyLimits.depth),
    fanOut: minFinite(platformCapped.fanOut, companyLimits.fanOut),
    descendants: minFinite(platformCapped.descendants, companyLimits.descendants),
  };

  // User reductions (may only lower).
  const limits: ModeLimits = {
    steps: minFinite(companyCapped.steps, reductions.steps),
    durationSeconds: minFinite(companyCapped.durationSeconds, reductions.durationSeconds),
    providerCalls: minFinite(companyCapped.providerCalls, reductions.providerCalls),
    totalTokens: minFinite(companyCapped.totalTokens, reductions.totalTokens),
    outputBytes: minFinite(companyCapped.outputBytes, reductions.outputBytes),
    costCents: minFinite(companyCapped.costCents, reductions.costCents),
    depth: companyCapped.depth,
    fanOut: companyCapped.fanOut,
    descendants: companyCapped.descendants,
  };

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
    toolAllowlist,
    domainAllowlist,
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
 * The profile config is intersected with platform hard caps, company
 * governance, and agent policy. For sets (tools, domains), use intersection
 * — explicit deny wins. For maxima (limits), use the minimum non-null value.
 * An empty required intersection fails with 422 POLICY_UNSATISFIABLE, never
 * a permissive fallback (VAL-MODEQ-037, VAL-CROSS-008).
 *
 * (VAL-MODEQ-019: ineligible custom mode denies start; VAL-MODEQ-020:
 * custom mode can only narrow — never broaden authority; VAL-CROSS-008:
 * custom mode narrows policy, unsatisfiable fails closed.)
 */
export function resolveCustomPolicy(input: {
  profileSlug: string;
  profileVersion: number;
  profileId: string;
  config: CustomProfileConfig;
  agent?: AgentPolicyInput;
  company?: CompanyPolicyInput;
  userReductions?: UserReductions;
  /** @deprecated use userReductions — kept for backward compatibility. */
  userLimits?: UserLimits;
}): ResolvedPolicy {
  const { config, agent, company } = input;
  const reductions: UserReductions = input.userReductions ?? input.userLimits ?? {};

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

  const provider = agent?.provider ?? 'anthropic';
  const model = agent?.model ?? 'claude-sonnet-4-6';

  // --- Provider governance (VAL-MODEQ-035, VAL-MODEQ-037) ---
  // Company governance: if allowedProviders is specified, the provider
  // must be in it. Also check against custom profile's requiredProvider.
  if (company?.allowedProviders && company.allowedProviders.length > 0) {
    if (!company.allowedProviders.includes(provider)) {
      throw new AppError(
        422,
        'POLICY_UNSATISFIABLE',
        'The initiating agent uses a provider that is not allowed by company governance.',
      );
    }
  }

  // Apply platform hard caps to the profile's limits. The profile limits
  // are optional; for unspecified limits, use platform hard caps as the
  // base (the most permissive allowed value).
  const profileLimits = config.limits ?? {};
  const platformCapped: ModeLimits = {
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

  // Company limits (may only lower).
  const companyLimits = company?.limits ?? {};
  const companyCapped: ModeLimits = {
    steps: minFinite(platformCapped.steps, companyLimits.steps),
    durationSeconds: minFinite(platformCapped.durationSeconds, companyLimits.durationSeconds),
    providerCalls: minFinite(platformCapped.providerCalls, companyLimits.providerCalls),
    totalTokens: minFinite(platformCapped.totalTokens, companyLimits.totalTokens),
    outputBytes: minFinite(platformCapped.outputBytes, companyLimits.outputBytes),
    costCents: minFinite(platformCapped.costCents, companyLimits.costCents),
    depth: minFinite(platformCapped.depth, companyLimits.depth),
    fanOut: minFinite(platformCapped.fanOut, companyLimits.fanOut),
    descendants: minFinite(platformCapped.descendants, companyLimits.descendants),
  };

  // User reductions (may only lower).
  const limits: ModeLimits = {
    steps: minFinite(companyCapped.steps, reductions.steps),
    durationSeconds: minFinite(companyCapped.durationSeconds, reductions.durationSeconds),
    providerCalls: minFinite(companyCapped.providerCalls, reductions.providerCalls),
    totalTokens: minFinite(companyCapped.totalTokens, reductions.totalTokens),
    outputBytes: minFinite(companyCapped.outputBytes, reductions.outputBytes),
    costCents: minFinite(companyCapped.costCents, reductions.costCents),
    depth: companyCapped.depth,
    fanOut: companyCapped.fanOut,
    descendants: companyCapped.descendants,
  };

  // --- Tool allowlist resolution (VAL-MODEQ-035, VAL-MODEQ-037) ---
  // Layer order: profile tools ∩ agent tools ∩ company allowedTools,
  // then remove company deniedTools and user removedTools.
  let toolAllowlist: string[];
  if (config.toolAllowlist && config.toolAllowlist.length > 0) {
    // Profile specifies tools: intersect profile ∩ agent ∩ company.
    toolAllowlist = intersectAllowlists(
      config.toolAllowlist,
      agent?.toolAllowlist,
      company?.allowedTools,
    );
    // If the profile requires tools but the intersection is empty, the
    // profile's tool requirements are unsatisfiable.
    if (toolAllowlist.length === 0) {
      throw new AppError(
        422,
        'POLICY_UNSATISFIABLE',
        'The custom mode requires tools that are not available after policy intersection.',
      );
    }
  } else {
    // Profile doesn't specify tools: inherit agent tools ∩ company.
    toolAllowlist = intersectAllowlists(agent?.toolAllowlist ?? [], company?.allowedTools);
  }
  // Apply explicit deny (company deniedTools, user removedTools).
  toolAllowlist = applyDeny(toolAllowlist, company?.deniedTools);
  toolAllowlist = applyDeny(toolAllowlist, reductions.removedTools);

  // --- Domain allowlist resolution ---
  let domainAllowlist: string[];
  if (config.domainAllowlist && config.domainAllowlist.length > 0) {
    domainAllowlist = intersectAllowlists(
      config.domainAllowlist,
      agent?.domainAllowlist,
      company?.allowedDomains,
    );
  } else {
    domainAllowlist = intersectAllowlists(agent?.domainAllowlist ?? [], company?.allowedDomains);
  }
  domainAllowlist = applyDeny(domainAllowlist, company?.deniedDomains);
  domainAllowlist = applyDeny(domainAllowlist, reductions.removedDomains);

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

// ---------------------------------------------------------------------------
// Policy preview (VAL-MODEQ-126)
// ---------------------------------------------------------------------------

/**
 * Preview key inputs: the complete set of values that determine the
 * effective policy. Changing any of these invalidates a cached preview
 * (VAL-MODEQ-126).
 */
export interface PreviewKeyInputs {
  companyId: string;
  projectId: string;
  projectThreadId: string;
  initiatingAgentId: string | null;
  /** Classifier inputs: request text hash and context hash. */
  requestTextHash: string;
  contextHash: string;
  /** Profile identity: mode slug and (for custom) profile ID/version. */
  mode: string;
  modeProfileId: string | null;
  modeProfileVersion: number | null;
  /** User reductions hash. */
  reductionsHash: string;
}

/**
 * Compute a deterministic preview key from all policy-resolution inputs.
 * The preview key is a lowercase SHA-256 hex hash. Changing any input
 * produces a different key, invalidating any cached preview
 * (VAL-MODEQ-126).
 */
export function computePreviewKey(inputs: PreviewKeyInputs): string {
  return canonicalHash({
    companyId: inputs.companyId,
    projectId: inputs.projectId,
    projectThreadId: inputs.projectThreadId,
    initiatingAgentId: inputs.initiatingAgentId,
    requestTextHash: inputs.requestTextHash,
    contextHash: inputs.contextHash,
    mode: inputs.mode,
    modeProfileId: inputs.modeProfileId,
    modeProfileVersion: inputs.modeProfileVersion,
    reductionsHash: inputs.reductionsHash,
  });
}

/**
 * A policy preview summary. This is a PREVIEW, not authority — start
 * re-resolves the effective policy transactionally. The run card displays
 * the actual narrowed snapshot if it differs (VAL-MODEQ-126).
 */
export interface PolicyPreview {
  /** Labelled as a preview — never authority. */
  kind: 'preview';
  /** Deterministic key; changing any input invalidates it. */
  previewKey: string;
  resolvedMode: ResolvedMode;
  provider: string;
  model: string;
  toolAllowlist: string[];
  domainAllowlist: string[];
  limits: ModeLimits;
  /** The content hash of the previewed effective policy. */
  policyContentHash: string;
}

/**
 * Compute a policy preview for a start request. The preview is keyed by
 * all resolution inputs so changing any input invalidates it. Start always
 * re-resolves transactionally — the preview can never authorize a stale
 * policy (VAL-MODEQ-126).
 */
export function previewPolicy(policy: ResolvedPolicy, keyInputs: PreviewKeyInputs): PolicyPreview {
  return {
    kind: 'preview',
    previewKey: computePreviewKey(keyInputs),
    resolvedMode: policy.resolvedMode,
    provider: policy.provider,
    model: policy.model,
    toolAllowlist: policy.toolAllowlist,
    domainAllowlist: policy.domainAllowlist,
    limits: policy.limits,
    policyContentHash: policyContentHash(policy),
  };
}

export type { ModePolicy };
