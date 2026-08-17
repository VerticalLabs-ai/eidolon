import { createHash } from 'node:crypto';

export type FeatureFlagConfig = {
  enabled?: boolean;
  rolloutPercentage?: number;
};

type FeatureFlagMap = Record<string, FeatureFlagConfig>;

function parseFeatureFlags(value = process.env.EIDOLON_FEATURE_FLAGS): FeatureFlagMap {
  if (!value?.trim()) {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed as FeatureFlagMap;
  } catch {
    return {};
  }
}

function stableBucket(flag: string, subject: string): number {
  const digest = createHash('sha256').update(`${flag}:${subject}`).digest();
  return digest.readUInt32BE(0) % 100;
}

export function isFeatureEnabled(flag: string, subject?: string): boolean {
  const config = parseFeatureFlags()[flag];
  if (!config?.enabled) {
    return false;
  }

  const percentage = config.rolloutPercentage;
  if (percentage === undefined || percentage >= 100) {
    return true;
  }
  if (!subject || percentage <= 0) {
    return false;
  }

  return stableBucket(flag, subject) < percentage;
}

/**
 * Flags this build knows about.
 *
 * The registry exists so a flag can be evaluated for a client without echoing
 * `EIDOLON_FEATURE_FLAGS` back to it. The variable is operator configuration: it
 * may hold flag names for unreleased work, and its `rolloutPercentage` values
 * describe the whole population rather than the caller. Clients therefore see
 * declared names with a boolean outcome and nothing else.
 *
 * Every flag defaults to off. An absent, malformed, or unparseable
 * configuration leaves it off, so a broken value fails closed.
 */
export const FEATURE_FLAGS = {
  analyticsAgentsBatched:
    'Compute the agent analytics response in one aggregate query instead of one query per agent.',
} as const;

export type FeatureFlagName = keyof typeof FEATURE_FLAGS;

export const FEATURE_FLAG_NAMES = Object.keys(FEATURE_FLAGS) as FeatureFlagName[];

/** Evaluate every declared flag for one subject. Undeclared flags are omitted. */
export function evaluateFeatureFlags(subject?: string): Record<FeatureFlagName, boolean> {
  const evaluated = {} as Record<FeatureFlagName, boolean>;
  for (const name of FEATURE_FLAG_NAMES) {
    evaluated[name] = isFeatureEnabled(name, subject);
  }
  return evaluated;
}
