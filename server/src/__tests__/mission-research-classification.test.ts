import { describe, expect, it } from 'vitest';
import {
  isRetryable,
  isFallbackEligible,
  isFallbackDenied,
  type FallbackPolicy,
} from '../services/mission/research/classification.js';
import type { ResearchProviderErrorCode } from '../services/mission/research/spi.js';

/**
 * Error classification tests.
 *
 * VAL-RES-007: Retryable provider failure (transient, 408, 429, 5xx retry)
 * VAL-RES-008: Non-retryable provider failure (non-auth 4xx — one attempt)
 * VAL-RES-012: Fallback denial categories (invalid input, policy, cancellation, budget, unsupported)
 * VAL-RES-090: Missing/invalid credential semantics (credential unavailable vs auth failed)
 * VAL-RES-095: Empty provider success (no usable sources)
 */

const defaultPolicy: FallbackPolicy = {
  allowedFallbackCategories: new Set([
    'transient',
    'timeout',
    'quota',
    'rate_limited',
    'credential_unavailable',
    'malformed',
    'empty',
  ]),
};

// ---------------------------------------------------------------------------
// Retry classification (VAL-RES-007)
// ---------------------------------------------------------------------------

describe('Error classification: retryable', () => {
  it('retries PROVIDER_TRANSIENT (network errors, 5xx)', () => {
    expect(isRetryable('PROVIDER_TRANSIENT')).toBe(true);
  });

  it('retries PROVIDER_TIMEOUT (HTTP 408)', () => {
    expect(isRetryable('PROVIDER_TIMEOUT')).toBe(true);
  });

  it('retries PROVIDER_RATE_LIMITED (HTTP 429)', () => {
    expect(isRetryable('PROVIDER_RATE_LIMITED')).toBe(true);
  });

  it('does NOT retry PROVIDER_QUOTA_EXCEEDED', () => {
    expect(isRetryable('PROVIDER_QUOTA_EXCEEDED')).toBe(false);
  });

  it('does NOT retry PROVIDER_PERMANENT (non-auth 4xx)', () => {
    expect(isRetryable('PROVIDER_PERMANENT')).toBe(false);
  });

  it('does NOT retry PROVIDER_AUTHENTICATION_FAILED (401/403)', () => {
    expect(isRetryable('PROVIDER_AUTHENTICATION_FAILED')).toBe(false);
  });

  it('does NOT retry PROVIDER_CREDENTIAL_UNAVAILABLE (missing credential)', () => {
    expect(isRetryable('PROVIDER_CREDENTIAL_UNAVAILABLE')).toBe(false);
  });

  it('does NOT retry INVALID_REQUEST', () => {
    expect(isRetryable('INVALID_REQUEST')).toBe(false);
  });

  it('does NOT retry UNSUPPORTED_OPERATION', () => {
    expect(isRetryable('UNSUPPORTED_OPERATION')).toBe(false);
  });

  it('does NOT retry MALFORMED_RESPONSE', () => {
    expect(isRetryable('MALFORMED_RESPONSE')).toBe(false);
  });

  it('does NOT retry POLICY_DENIED', () => {
    expect(isRetryable('POLICY_DENIED')).toBe(false);
  });

  it('does NOT retry BUDGET_EXHAUSTED', () => {
    expect(isRetryable('BUDGET_EXHAUSTED')).toBe(false);
  });

  it('does NOT retry CANCELLED', () => {
    expect(isRetryable('CANCELLED')).toBe(false);
  });

  it('does NOT retry RESEARCH_NO_USABLE_SOURCES', () => {
    expect(isRetryable('RESEARCH_NO_USABLE_SOURCES')).toBe(false);
  });

  it('does NOT retry MISSING_CREDENTIAL (legacy code)', () => {
    expect(isRetryable('MISSING_CREDENTIAL')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fallback classification (VAL-RES-010, VAL-RES-011, VAL-RES-012)
// ---------------------------------------------------------------------------

describe('Error classification: fallback eligible', () => {
  it('allows fallback for PROVIDER_TRANSIENT after retry exhaustion', () => {
    expect(isFallbackEligible('PROVIDER_TRANSIENT', defaultPolicy)).toBe(true);
  });

  it('allows fallback for PROVIDER_TIMEOUT', () => {
    expect(isFallbackEligible('PROVIDER_TIMEOUT', defaultPolicy)).toBe(true);
  });

  it('allows fallback for PROVIDER_QUOTA_EXCEEDED', () => {
    expect(isFallbackEligible('PROVIDER_QUOTA_EXCEEDED', defaultPolicy)).toBe(true);
  });

  it('allows fallback for PROVIDER_RATE_LIMITED', () => {
    expect(isFallbackEligible('PROVIDER_RATE_LIMITED', defaultPolicy)).toBe(true);
  });

  it('allows fallback for PROVIDER_CREDENTIAL_UNAVAILABLE', () => {
    expect(isFallbackEligible('PROVIDER_CREDENTIAL_UNAVAILABLE', defaultPolicy)).toBe(true);
  });

  it('allows fallback for MALFORMED_RESPONSE', () => {
    expect(isFallbackEligible('MALFORMED_RESPONSE', defaultPolicy)).toBe(true);
  });

  it('allows fallback for RESEARCH_NO_USABLE_SOURCES', () => {
    expect(isFallbackEligible('RESEARCH_NO_USABLE_SOURCES', defaultPolicy)).toBe(true);
  });

  it('does NOT allow fallback for PROVIDER_AUTHENTICATION_FAILED (VAL-RES-090)', () => {
    expect(isFallbackEligible('PROVIDER_AUTHENTICATION_FAILED', defaultPolicy)).toBe(false);
  });

  it('does NOT allow fallback for INVALID_REQUEST (VAL-RES-012)', () => {
    expect(isFallbackEligible('INVALID_REQUEST', defaultPolicy)).toBe(false);
  });

  it('does NOT allow fallback for UNSUPPORTED_OPERATION (VAL-RES-012)', () => {
    expect(isFallbackEligible('UNSUPPORTED_OPERATION', defaultPolicy)).toBe(false);
  });

  it('does NOT allow fallback for POLICY_DENIED (VAL-RES-012)', () => {
    expect(isFallbackEligible('POLICY_DENIED', defaultPolicy)).toBe(false);
  });

  it('does NOT allow fallback for BUDGET_EXHAUSTED (VAL-RES-012)', () => {
    expect(isFallbackEligible('BUDGET_EXHAUSTED', defaultPolicy)).toBe(false);
  });

  it('does NOT allow fallback for CANCELLED (VAL-RES-012)', () => {
    expect(isFallbackEligible('CANCELLED', defaultPolicy)).toBe(false);
  });

  it('does NOT allow fallback for PROVIDER_PERMANENT by default (VAL-RES-008)', () => {
    expect(isFallbackEligible('PROVIDER_PERMANENT', defaultPolicy)).toBe(false);
  });

  it('allows fallback for PROVIDER_PERMANENT only when explicitly configured', () => {
    const policy: FallbackPolicy = {
      ...defaultPolicy,
      allowedFallbackCategories: new Set([...defaultPolicy.allowedFallbackCategories, 'permanent']),
    };
    expect(isFallbackEligible('PROVIDER_PERMANENT', policy)).toBe(true);
  });

  it('does NOT allow fallback when policy has empty allowed set', () => {
    const emptyPolicy: FallbackPolicy = {
      allowedFallbackCategories: new Set(),
    };
    expect(isFallbackEligible('PROVIDER_TRANSIENT', emptyPolicy)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fallback denial (VAL-RES-012)
// ---------------------------------------------------------------------------

describe('Error classification: fallback denied', () => {
  const deniedCodes: ResearchProviderErrorCode[] = [
    'INVALID_REQUEST',
    'UNSUPPORTED_OPERATION',
    'POLICY_DENIED',
    'BUDGET_EXHAUSTED',
    'CANCELLED',
    'PROVIDER_AUTHENTICATION_FAILED',
  ];

  for (const code of deniedCodes) {
    it(`denies fallback for ${code}`, () => {
      expect(isFallbackDenied(code)).toBe(true);
    });
  }

  it('does NOT deny fallback for PROVIDER_TRANSIENT', () => {
    expect(isFallbackDenied('PROVIDER_TRANSIENT')).toBe(false);
  });

  it('does NOT deny fallback for PROVIDER_TIMEOUT', () => {
    expect(isFallbackDenied('PROVIDER_TIMEOUT')).toBe(false);
  });

  it('does NOT deny fallback for PROVIDER_QUOTA_EXCEEDED', () => {
    expect(isFallbackDenied('PROVIDER_QUOTA_EXCEEDED')).toBe(false);
  });

  it('does NOT deny fallback for PROVIDER_CREDENTIAL_UNAVAILABLE', () => {
    expect(isFallbackDenied('PROVIDER_CREDENTIAL_UNAVAILABLE')).toBe(false);
  });

  it('does NOT deny fallback for MALFORMED_RESPONSE', () => {
    expect(isFallbackDenied('MALFORMED_RESPONSE')).toBe(false);
  });

  it('does NOT deny fallback for RESEARCH_NO_USABLE_SOURCES', () => {
    expect(isFallbackDenied('RESEARCH_NO_USABLE_SOURCES')).toBe(false);
  });
});
