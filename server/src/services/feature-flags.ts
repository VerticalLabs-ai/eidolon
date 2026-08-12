import { createHash } from 'node:crypto';

export type FeatureFlagConfig = {
  enabled?: boolean;
  rolloutPercentage?: number;
};

type FeatureFlagMap = Record<string, FeatureFlagConfig>;

function parseFeatureFlags(value = process.env.EIDOLON_FEATURE_FLAGS): FeatureFlagMap {
  if (!value?.trim()) {return {};}

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {return {};}
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
  if (!config?.enabled) {return false;}

  const percentage = config.rolloutPercentage;
  if (percentage === undefined || percentage >= 100) {return true;}
  if (!subject || percentage <= 0) {return false;}

  return stableBucket(flag, subject) < percentage;
}
