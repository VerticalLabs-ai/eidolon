import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFeatureEnabled } from '../services/feature-flags.js';

describe('feature flags', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps absent, disabled, and malformed flags off', () => {
    expect(isFeatureEnabled('new-runtime', 'company-1')).toBe(false);

    vi.stubEnv('EIDOLON_FEATURE_FLAGS', '{"new-runtime":{"enabled":false}}');
    expect(isFeatureEnabled('new-runtime', 'company-1')).toBe(false);

    vi.stubEnv('EIDOLON_FEATURE_FLAGS', 'not-json');
    expect(isFeatureEnabled('new-runtime', 'company-1')).toBe(false);
  });

  it('enables a flag globally or deterministically by percentage', () => {
    vi.stubEnv('EIDOLON_FEATURE_FLAGS', '{"new-runtime":{"enabled":true}}');
    expect(isFeatureEnabled('new-runtime')).toBe(true);

    vi.stubEnv('EIDOLON_FEATURE_FLAGS', '{"new-runtime":{"enabled":true,"rolloutPercentage":50}}');
    expect(isFeatureEnabled('new-runtime', 'company-1')).toBe(
      isFeatureEnabled('new-runtime', 'company-1'),
    );
    expect(isFeatureEnabled('new-runtime')).toBe(false);
  });
});
