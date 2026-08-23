/**
 * Built-in Mission mode definitions (code-owned, versioned constants).
 *
 * Custom company profiles are a later feature; built-ins are the only source of
 * mode defaults in Phase 1 milestone 1. The full deny-biased resolution that
 * intersects platform/company/agent/mode/user layers is a later feature; this
 * module supplies the mode's own defaults and platform hard caps.
 */

export type BuiltInMode = 'fast' | 'deep_work' | 'analyst' | 'auto';

/** All selectable Mission modes, including company-defined custom profiles. */
export type MissionMode = BuiltInMode | 'custom';

export type ResolvedMode = 'fast' | 'deep_work' | 'analyst' | 'custom';

/** Numeric limits snapshot for one run. All values are finite integers. */
export interface ModeLimits {
  steps: number;
  durationSeconds: number;
  providerCalls: number;
  totalTokens: number;
  outputBytes: number;
  costCents: number;
  depth: number;
  fanOut: number;
  descendants: number;
}

export interface ModePolicy {
  mode: BuiltInMode;
  planning: 'never' | 'when_complex' | 'always';
  approval: 'never' | 'when_complex' | 'always';
  research: 'off' | 'allowed' | 'required';
  partialResultPolicy: 'require_all' | 'best_effort';
  limits: ModeLimits;
}

/** Platform hard caps. Deployment configuration may lower, never raise, these. */
export const PLATFORM_HARD_CAPS = {
  depth: 2,
  fanOut: 4,
  descendants: 16,
  durationSeconds: 3600, // 60 minutes
  providerCalls: 64,
  totalTokens: 500_000,
  outputBytes: 10 * 1024 * 1024, // 10 MiB
  perSourceBytes: 1024 * 1024, // 1 MiB
  costCents: 10_000,
} as const;

const FAST_LIMITS: ModeLimits = {
  steps: 4,
  durationSeconds: 300,
  providerCalls: 6,
  totalTokens: 32_000,
  outputBytes: 1024 * 1024,
  costCents: 500,
  depth: 0,
  fanOut: 0,
  descendants: 0,
};

const DEEP_WORK_LIMITS: ModeLimits = {
  steps: 12,
  durationSeconds: 2700,
  providerCalls: 48,
  totalTokens: 300_000,
  outputBytes: 8 * 1024 * 1024,
  costCents: 5000,
  depth: 2,
  fanOut: 4,
  descendants: 12,
};

const ANALYST_LIMITS: ModeLimits = {
  steps: 10,
  durationSeconds: 2700,
  providerCalls: 48,
  totalTokens: 250_000,
  outputBytes: 8 * 1024 * 1024,
  costCents: 5000,
  depth: 2,
  fanOut: 3,
  descendants: 10,
};

export const BUILT_IN_MODES: Record<BuiltInMode, ModePolicy> = {
  fast: {
    mode: 'fast',
    planning: 'when_complex',
    approval: 'when_complex',
    research: 'off',
    partialResultPolicy: 'require_all',
    limits: FAST_LIMITS,
  },
  deep_work: {
    mode: 'deep_work',
    planning: 'always',
    approval: 'always',
    research: 'allowed',
    partialResultPolicy: 'require_all',
    limits: DEEP_WORK_LIMITS,
  },
  analyst: {
    mode: 'analyst',
    planning: 'always',
    approval: 'always',
    research: 'required',
    partialResultPolicy: 'require_all',
    limits: ANALYST_LIMITS,
  },
  // Auto resolves to a concrete mode before snapshot. The deterministic
  // complexity classifier is a later feature; for milestone 1 Auto resolves
  // to the most conservative concrete mode (fast) so the snapshot is finite
  // and honest about the provisional resolution.
  auto: {
    mode: 'auto',
    planning: 'when_complex',
    approval: 'when_complex',
    research: 'off',
    partialResultPolicy: 'require_all',
    limits: FAST_LIMITS,
  },
};

/**
 * Resolve a selected mode to a concrete mode + policy. Auto is provisionally
 * resolved to `fast` until the M2 classifier replaces this function.
 */
export function resolveBuiltInMode(mode: BuiltInMode): {
  resolvedMode: ResolvedMode;
  policy: ModePolicy;
} {
  const policy = BUILT_IN_MODES[mode];
  const resolvedMode: ResolvedMode = mode === 'auto' ? 'fast' : mode;
  return { resolvedMode, policy };
}
