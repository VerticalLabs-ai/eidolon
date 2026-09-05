/**
 * Health classification: which provider errors affect shared circuit health.
 *
 * (VAL-RES-109)
 *
 * Shared provider/operation health counts ONLY classified provider-wide
 * transport, 5xx, and malformed-service failures. Tenant-specific failures
 * never increment the global threshold or affect another company.
 *
 * Provider-wide (increments shared health):
 *   - PROVIDER_TRANSIENT  — network/transport errors, HTTP 5xx (the provider
 *     itself is degraded or unreachable for everyone).
 *   - MALFORMED_RESPONSE  — the provider returned a structurally invalid
 *     response (malformed-service; the provider is broken for everyone).
 *
 * Tenant-specific (does NOT increment shared health):
 *   - PROVIDER_CREDENTIAL_UNAVAILABLE — missing/disabled/invalid tenant
 *     credential; other tenants with valid credentials are unaffected.
 *   - PROVIDER_AUTHENTICATION_FAILED — 401/403; tenant credential problem.
 *   - PROVIDER_QUOTA_EXCEEDED — tenant quota exhausted.
 *   - PROVIDER_RATE_LIMITED — tenant-specific 429.
 *   - PROVIDER_TIMEOUT — 408; borderline, but a timeout is not necessarily
 *     provider-wide (could be a slow query, large page, or tenant-specific
 *     load). Classified as tenant-specific so one tenant's slow extraction
 *     cannot open the circuit for everyone.
 *   - INVALID_REQUEST, UNSUPPORTED_OPERATION, POLICY_DENIED — input/policy
 *     rejection; caller error, not provider health.
 *   - BUDGET_EXHAUSTED — budget denial; not a provider failure.
 *   - CANCELLED — user cancellation; not a provider failure.
 *   - RESEARCH_NO_USABLE_SOURCES — empty results; not a provider failure.
 *   - MISSING_CREDENTIAL — configuration error; not provider-wide.
 *   - PROVIDER_PERMANENT — non-auth 4xx; caller-side, not provider-wide.
 */

import type { ResearchProviderErrorCode } from './spi.js';

// ---------------------------------------------------------------------------
// Provider-wide failure codes (increment shared health)
// ---------------------------------------------------------------------------

/** Error codes that represent provider-wide degradation. */
const PROVIDER_WIDE_FAILURE_CODES: ReadonlySet<ResearchProviderErrorCode> = new Set([
  'PROVIDER_TRANSIENT',
  'MALFORMED_RESPONSE',
]);

/**
 * Returns true if the error code represents a provider-wide failure that
 * should increment the shared circuit-breaker health threshold.
 *
 * Provider-wide: transport/5xx (PROVIDER_TRANSIENT) and malformed-service
 * (MALFORMED_RESPONSE). These signal that the provider itself is degraded
 * for all tenants.
 *
 * All other codes are tenant-specific or caller-side errors that must NOT
 * poison shared health (VAL-RES-109).
 */
export function isProviderWideFailure(code: ResearchProviderErrorCode): boolean {
  return PROVIDER_WIDE_FAILURE_CODES.has(code);
}

/**
 * Returns true if the error code is tenant-specific and must NOT increment
 * the shared circuit-breaker health threshold.
 *
 * This is the complement of `isProviderWideFailure`. Tenant-specific
 * failures include: missing/disabled/invalid credentials, 401/403,
 * tenant quota/429, timeout, policy/input/URL rejection, cancellation,
 * budget denial, and empty results.
 */
export function isTenantSpecificFailure(code: ResearchProviderErrorCode): boolean {
  return !isProviderWideFailure(code);
}
