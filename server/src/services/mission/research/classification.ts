/**
 * Error classification for bounded retry and policy-safe fallback.
 *
 * (architecture.md: Provider Fallback and Health, VAL-RES-007 through VAL-RES-012,
 *  VAL-RES-090, VAL-RES-095)
 *
 * Classification is the single source of truth for whether a provider error
 * may be retried within the same provider, whether it may trigger a fallback
 * to the next provider, and whether it is a permanent denial that must never
 * bypass the decision.
 *
 * Rules (from architecture.md):
 * - Retry only: transient network errors, HTTP 408, 429, and 5xx.
 *   At most 3 attempts per provider. Do NOT retry ordinary 4xx, validation
 *   failures, policy denials, cancellation, or oversized/malformed responses.
 * - Fallback only after: retry exhaustion, timeout, quota/throttle, unavailable
 *   credential, malformed provider response, empty results, or open circuit.
 * - Never fall back around: invalid input, unsupported operation, cancellation,
 *   budget exhaustion, policy denial, or authentication failure (401/403).
 * - Non-auth 4xx (PROVIDER_PERMANENT) falls back only when the 'permanent'
 *   category is explicitly configured as safe.
 */

import type { ResearchProviderErrorCode } from './spi.js';

// ---------------------------------------------------------------------------
// Fallback categories
// ---------------------------------------------------------------------------

/**
 * Stable fallback categories. Each maps to one or more error codes.
 * The fallback policy enumerates which categories are permitted.
 */
export type FallbackCategory =
  | 'transient'
  | 'timeout'
  | 'quota'
  | 'rate_limited'
  | 'credential_unavailable'
  | 'malformed'
  | 'empty'
  | 'permanent';

/**
 * The fallback policy determines which error categories may trigger a
 * fallback to the next provider. Categories not in the allowed set cannot
 * trigger fallback.
 *
 * Default allowed categories: transient, timeout, quota, rate_limited,
 * credential_unavailable, malformed, empty.
 * 'permanent' (non-auth 4xx) is NOT in the default set — it must be
 * explicitly configured (VAL-RES-008).
 */
export interface FallbackPolicy {
  allowedFallbackCategories: Set<FallbackCategory>;
}

/** The default fallback policy. */
export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = {
  allowedFallbackCategories: new Set<FallbackCategory>([
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

/** The set of error codes that may be retried within the same provider. */
const RETRYABLE_CODES: ReadonlySet<ResearchProviderErrorCode> = new Set([
  'PROVIDER_TRANSIENT',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
]);

/**
 * Returns true if the error code is retryable within the same provider.
 *
 * Retryable: transient network errors (5xx, network), HTTP 408 (timeout),
 * HTTP 429 (rate limited).
 * NOT retryable: all other codes including quota, malformed, auth failure,
 * invalid input, policy denial, cancellation, budget exhaustion, and
 * empty results.
 */
export function isRetryable(code: ResearchProviderErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

// ---------------------------------------------------------------------------
// Fallback classification (VAL-RES-010, VAL-RES-011, VAL-RES-012, VAL-RES-090)
// ---------------------------------------------------------------------------

/**
 * Maps an error code to its fallback category, or undefined if the code
 * is a permanent denial that can never trigger fallback.
 */
function codeToFallbackCategory(code: ResearchProviderErrorCode): FallbackCategory | undefined {
  switch (code) {
    case 'PROVIDER_TRANSIENT':
      return 'transient';
    case 'PROVIDER_TIMEOUT':
      return 'timeout';
    case 'PROVIDER_QUOTA_EXCEEDED':
      return 'quota';
    case 'PROVIDER_RATE_LIMITED':
      return 'rate_limited';
    case 'PROVIDER_CREDENTIAL_UNAVAILABLE':
      return 'credential_unavailable';
    case 'MALFORMED_RESPONSE':
      return 'malformed';
    case 'RESEARCH_NO_USABLE_SOURCES':
      return 'empty';
    case 'PROVIDER_PERMANENT':
      return 'permanent';
    // Permanent denials — no fallback category.
    case 'INVALID_REQUEST':
    case 'UNSUPPORTED_OPERATION':
    case 'POLICY_DENIED':
    case 'BUDGET_EXHAUSTED':
    case 'CANCELLED':
    case 'PROVIDER_AUTHENTICATION_FAILED':
    case 'MISSING_CREDENTIAL':
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Returns true if the error code may trigger a fallback to the next
 * provider, given the fallback policy.
 *
 * Fallback is permitted only for categories in the policy's allowed set.
 * Permanent denial codes (invalid input, unsupported operation, policy
 * denial, cancellation, budget exhaustion, authentication failure) are
 * never fallback-eligible regardless of policy.
 */
export function isFallbackEligible(
  code: ResearchProviderErrorCode,
  policy: FallbackPolicy,
): boolean {
  const category = codeToFallbackCategory(code);
  if (category === undefined) {
    return false;
  }
  return policy.allowedFallbackCategories.has(category);
}

// ---------------------------------------------------------------------------
// Fallback denial (VAL-RES-012)
// ---------------------------------------------------------------------------

/** The set of error codes that are permanent denials — never trigger fallback. */
const FALLBACK_DENIED_CODES: ReadonlySet<ResearchProviderErrorCode> = new Set([
  'INVALID_REQUEST',
  'UNSUPPORTED_OPERATION',
  'POLICY_DENIED',
  'BUDGET_EXHAUSTED',
  'CANCELLED',
  'PROVIDER_AUTHENTICATION_FAILED',
]);

/**
 * Returns true if the error code is a permanent denial that must never
 * trigger a fallback, regardless of policy.
 *
 * Denied categories: invalid input, unsupported operation, policy denial,
 * budget exhaustion, cancellation, and authentication failure (401/403).
 */
export function isFallbackDenied(code: ResearchProviderErrorCode): boolean {
  return FALLBACK_DENIED_CODES.has(code);
}
