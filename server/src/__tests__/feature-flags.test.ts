import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  evaluateFeatureFlags,
  FEATURE_FLAG_NAMES,
  isFeatureEnabled,
} from '../services/feature-flags.js';
import { requireFeatureFlag } from '../middleware/feature-flags.js';

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

  it('declares Phase 2 flags and keeps them fail-closed by default', () => {
    expect(FEATURE_FLAG_NAMES).toEqual(
      expect.arrayContaining(['missionPolish', 'agentCustomization', 'artifactEditing']),
    );

    const evaluated = evaluateFeatureFlags('company-1');
    expect(evaluated.missionPolish).toBe(false);
    expect(evaluated.agentCustomization).toBe(false);
    expect(evaluated.artifactEditing).toBe(false);
  });

  it('requires missionAgentIntelligence before enabling any Phase 2 flag', () => {
    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({
        missionPolish: { enabled: true },
        agentCustomization: { enabled: true },
        artifactEditing: { enabled: true },
      }),
    );

    expect(isFeatureEnabled('missionPolish', 'company-1')).toBe(false);
    expect(isFeatureEnabled('agentCustomization', 'company-1')).toBe(false);
    expect(isFeatureEnabled('artifactEditing', 'company-1')).toBe(false);

    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({
        missionAgentIntelligence: { enabled: true },
        missionPolish: { enabled: true },
        agentCustomization: { enabled: true },
        artifactEditing: { enabled: true },
      }),
    );

    expect(isFeatureEnabled('missionPolish', 'company-1')).toBe(true);
    expect(isFeatureEnabled('agentCustomization', 'company-1')).toBe(true);
    expect(isFeatureEnabled('artifactEditing', 'company-1')).toBe(true);
  });

  it('keeps Phase 2 rollout assignments independent while honoring the parent gate', () => {
    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({
        missionAgentIntelligence: { enabled: true },
        missionPolish: { enabled: true, rolloutPercentage: 0 },
        agentCustomization: { enabled: true },
        artifactEditing: { enabled: false },
      }),
    );

    expect(isFeatureEnabled('missionPolish', 'company-1')).toBe(false);
    expect(isFeatureEnabled('agentCustomization', 'company-1')).toBe(true);
    expect(isFeatureEnabled('artifactEditing', 'company-1')).toBe(false);
  });

  it('provides route middleware that gates new routes by company flag state', () => {
    const next = vi.fn();
    const request = { params: { companyId: 'company-1' } } as never;

    requireFeatureFlag('missionPolish')(request, {} as never, next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ status: 404 }));

    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({
        missionAgentIntelligence: { enabled: true },
        missionPolish: { enabled: true },
      }),
    );
    next.mockClear();

    requireFeatureFlag('missionPolish')(request, {} as never, next);
    expect(next).toHaveBeenCalledWith();
  });
});
