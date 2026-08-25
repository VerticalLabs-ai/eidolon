/**
 * Provider-mediated fetch capability enforcement for SSRF boundary.
 *
 * (architecture.md: Network/SSRF policy, VAL-RES-108, VAL-CROSS-035)
 *
 * A target URL may be dispatched only through a provider operation whose
 * versioned capability contract:
 *   1. Returns the complete redirect chain for every hop.
 *   2. Guarantees policy enforcement before every hop (scheme, port, DNS,
 *      redirect revalidation).
 *   3. Protects against DNS rebinding and redirect chains changed between
 *      preflight and dispatch.
 *
 * Providers lacking that capability cannot receive target URLs in Phase 1.
 * If a provider cannot meet this boundary, the operation must fail closed
 * rather than dispatch. A safe-looking final URL alone never passes.
 *
 * In Phase 1, neither Tavily nor Firecrawl exposes the full redirect chain
 * for per-hop validation through their REST API. Therefore, extract/scrape
 * operations that pass target URLs to providers are denied until a
 * compliant capability is verified. Search operations are not mediated
 * fetches (they return URLs, not fetch them).
 */

import type { ResearchProviderName } from './origins.js';
import type { ResearchOperation, ResearchProviderErrorCode } from './spi.js';

// ---------------------------------------------------------------------------
// Capability contract
// ---------------------------------------------------------------------------

/**
 * Declares whether a provider operation can safely receive target URLs
 * while preserving the SSRF boundary.
 */
export interface ProviderMediatedFetchCapability {
  /** The provider name. */
  provider: ResearchProviderName;
  /** The operation that fetches target URLs. */
  operation: ResearchOperation;
  /**
   * Whether the provider returns the complete redirect chain so that
   * every hop can be validated by the adapter.
   */
  providesRedirectChain: boolean;
  /**
   * Whether the provider guarantees policy enforcement (scheme, port,
   * DNS, redirect) before every hop.
   */
  perHopPolicyEnforcement: boolean;
  /**
   * Whether the provider protects against DNS rebinding and redirect
   * chains changed between preflight and dispatch.
   */
  dnsRebindingProtection: boolean;
  /** Versioned capability contract identifier. */
  capabilityVersion: string;
}

// ---------------------------------------------------------------------------
// Phase 1 capability manifest
// ---------------------------------------------------------------------------

/**
 * The Phase 1 capability manifest. Neither Tavily nor Firecrawl exposes
 * the full redirect chain for per-hop validation through their REST API.
 *
 * This is deliberately conservative: providers are treated as non-compliant
 * until proven otherwise. When a future provider API version exposes the
 * complete redirect chain with per-hop enforcement, this manifest can be
 * updated with a versioned capability entry.
 */
export const PROVIDER_MEDIATED_FETCH_CAPABILITIES: Partial<
  Record<ResearchProviderName, Partial<Record<ResearchOperation, ProviderMediatedFetchCapability>>>
> = {
  tavily: {
    extract: {
      provider: 'tavily',
      operation: 'extract',
      providesRedirectChain: false,
      perHopPolicyEnforcement: false,
      dnsRebindingProtection: false,
      capabilityVersion: 'v1',
    },
  },
  firecrawl: {
    scrape: {
      provider: 'firecrawl',
      operation: 'scrape',
      providesRedirectChain: false,
      perHopPolicyEnforcement: false,
      dnsRebindingProtection: false,
      capabilityVersion: 'v1',
    },
    structured_extract: {
      provider: 'firecrawl',
      operation: 'structured_extract',
      providesRedirectChain: false,
      perHopPolicyEnforcement: false,
      dnsRebindingProtection: false,
      capabilityVersion: 'v1',
    },
  },
};

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

/**
 * Returns true if the provider operation has a compliant mediated-fetch
 * capability (all three guarantees: redirect chain, per-hop enforcement,
 * DNS rebinding protection).
 *
 * Search operations are never mediated fetches.
 */
export function hasProviderMediatedFetchCapability(
  provider: ResearchProviderName,
  operation: ResearchOperation,
): boolean {
  const cap = PROVIDER_MEDIATED_FETCH_CAPABILITIES[provider]?.[operation];
  if (!cap) {
    return false;
  }
  return cap.providesRedirectChain && cap.perHopPolicyEnforcement && cap.dnsRebindingProtection;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ProviderMediatedFetchValidationResult {
  valid: boolean;
  errorCode?: ResearchProviderErrorCode;
  /** Safe message that never includes target URLs. */
  message?: string;
}

/**
 * Validate that a provider operation can safely receive target URLs while
 * preserving the SSRF boundary.
 *
 * If the provider operation lacks a compliant mediated-fetch capability,
 * the validation fails closed with `PROVIDER_MEDIATED_FETCH_UNVERIFIED`.
 * The error message never includes target URLs.
 */
export function validateProviderMediatedFetch(
  provider: ResearchProviderName,
  operation: ResearchOperation,
  _targetUrls: string[],
): ProviderMediatedFetchValidationResult {
  // The target URLs parameter is reserved for future use when a compliant
  // provider validates per-URL redirect chains. In Phase 1, no provider
  // has the required capability, so the check always fails closed.
  void _targetUrls;
  if (hasProviderMediatedFetchCapability(provider, operation)) {
    return { valid: true };
  }

  return {
    valid: false,
    errorCode: 'PROVIDER_MEDIATED_FETCH_UNVERIFIED',
    message: `Provider "${provider}" operation "${operation}" cannot verify the complete redirect chain and per-hop SSRF enforcement for target URLs`,
  };
}
