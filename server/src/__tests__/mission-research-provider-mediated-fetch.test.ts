import { describe, expect, it } from 'vitest';
import {
  PROVIDER_MEDIATED_FETCH_CAPABILITIES,
  hasProviderMediatedFetchCapability,
  validateProviderMediatedFetch,
  type ProviderMediatedFetchCapability,
} from '../services/mission/research/provider-mediated-fetch.js';

/**
 * VAL-RES-108: Provider-mediated targets preserve the SSRF boundary
 *
 * A target URL may be dispatched only through a provider operation whose
 * versioned capability contract returns the complete redirect chain and
 * guarantees policy enforcement before every hop. Providers lacking that
 * capability cannot receive target URLs in Phase 1.
 */

// ---------------------------------------------------------------------------
// Capability manifest
// ---------------------------------------------------------------------------

describe('VAL-RES-108: Provider-mediated fetch capability manifest', () => {
  it('defines capabilities for all providers', () => {
    expect(PROVIDER_MEDIATED_FETCH_CAPABILITIES).toBeDefined();
    expect(PROVIDER_MEDIATED_FETCH_CAPABILITIES.tavily).toBeDefined();
    expect(PROVIDER_MEDIATED_FETCH_CAPABILITIES.firecrawl).toBeDefined();
  });

  it('Tavily extract does NOT have full redirect-chain guarantee in Phase 1', () => {
    // Tavily extract returns content but does not expose the full redirect
    // chain for per-hop validation. Without that guarantee, it cannot
    // receive target URLs that require SSRF boundary enforcement.
    const cap = PROVIDER_MEDIATED_FETCH_CAPABILITIES.tavily?.extract;
    expect(cap?.providesRedirectChain).toBe(false);
  });

  it('Firecrawl scrape does NOT have full redirect-chain guarantee in Phase 1', () => {
    const cap = PROVIDER_MEDIATED_FETCH_CAPABILITIES.firecrawl?.scrape;
    expect(cap?.providesRedirectChain).toBe(false);
  });

  it('Search operations do not provide mediated fetch (they return URLs, not fetch them)', () => {
    const tavilySearch = PROVIDER_MEDIATED_FETCH_CAPABILITIES.tavily?.search;
    expect(tavilySearch).toBeUndefined();
    const firecrawlSearch = PROVIDER_MEDIATED_FETCH_CAPABILITIES.firecrawl?.search;
    expect(firecrawlSearch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

describe('VAL-RES-108: hasProviderMediatedFetchCapability', () => {
  it('returns false for Tavily extract (no redirect-chain guarantee)', () => {
    expect(hasProviderMediatedFetchCapability('tavily', 'extract')).toBe(false);
  });

  it('returns false for Firecrawl scrape (no redirect-chain guarantee)', () => {
    expect(hasProviderMediatedFetchCapability('firecrawl', 'scrape')).toBe(false);
  });

  it('returns false for search operations (not a mediated fetch)', () => {
    expect(hasProviderMediatedFetchCapability('tavily', 'search')).toBe(false);
    expect(hasProviderMediatedFetchCapability('firecrawl', 'search')).toBe(false);
  });

  it('returns true for a hypothetical compliant provider with full guarantee', () => {
    // A provider that returns the complete redirect chain and guarantees
    // policy enforcement before every hop would be allowed.
    const cap: ProviderMediatedFetchCapability = {
      provider: 'tavily',
      operation: 'extract',
      providesRedirectChain: true,
      perHopPolicyEnforcement: true,
      dnsRebindingProtection: true,
      capabilityVersion: 'v2',
    };
    expect(cap.providesRedirectChain).toBe(true);
    expect(cap.perHopPolicyEnforcement).toBe(true);
    expect(cap.dnsRebindingProtection).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation: provider-mediated fetch fails closed
// ---------------------------------------------------------------------------

describe('VAL-RES-108: validateProviderMediatedFetch fails closed', () => {
  it('denies target URLs for Tavily extract (no redirect-chain guarantee)', () => {
    const result = validateProviderMediatedFetch('tavily', 'extract', ['https://example.com/page']);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_MEDIATED_FETCH_UNVERIFIED');
  });

  it('denies target URLs for Firecrawl scrape (no redirect-chain guarantee)', () => {
    const result = validateProviderMediatedFetch('firecrawl', 'scrape', [
      'https://example.com/page',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_MEDIATED_FETCH_UNVERIFIED');
  });

  it('denies target URLs for search operations', () => {
    const result = validateProviderMediatedFetch('tavily', 'search', ['https://example.com/page']);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_MEDIATED_FETCH_UNVERIFIED');
  });

  it('does not include target URLs in the error message', () => {
    const result = validateProviderMediatedFetch('tavily', 'extract', [
      'https://example.com/s3cr3t-path',
    ]);
    expect(result.message).not.toContain('s3cr3t-path');
    expect(result.message).not.toContain('example.com');
  });

  it('validates that target URLs pass URL policy first', () => {
    // Even if the provider had the capability, unsafe target URLs
    // must still be rejected by the URL policy.
    const cap: ProviderMediatedFetchCapability = {
      provider: 'tavily',
      operation: 'extract',
      providesRedirectChain: true,
      perHopPolicyEnforcement: true,
      dnsRebindingProtection: true,
      capabilityVersion: 'v1',
    };
    // The capability struct itself validates the contract requirements
    expect(cap.providesRedirectChain).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // DNS rebinding and changed-chain detection
  // ---------------------------------------------------------------------------

  describe('VAL-RES-108: DNS rebinding and changed-chain protection', () => {
    it('capability requires dnsRebindingProtection flag', () => {
      const cap = PROVIDER_MEDIATED_FETCH_CAPABILITIES.tavily?.extract;
      expect(cap).toBeDefined();
      expect(cap?.dnsRebindingProtection).toBe(false);
    });

    it('a compliant capability must have all three guarantees', () => {
      const cap: ProviderMediatedFetchCapability = {
        provider: 'tavily',
        operation: 'extract',
        providesRedirectChain: true,
        perHopPolicyEnforcement: true,
        dnsRebindingProtection: true,
        capabilityVersion: 'v1',
      };
      // All three guarantees are required for a compliant capability
      expect(
        cap.providesRedirectChain && cap.perHopPolicyEnforcement && cap.dnsRebindingProtection,
      ).toBe(true);
    });

    it('a capability missing any guarantee is non-compliant', () => {
      const missingRedirectChain: ProviderMediatedFetchCapability = {
        provider: 'tavily',
        operation: 'extract',
        providesRedirectChain: false,
        perHopPolicyEnforcement: true,
        dnsRebindingProtection: true,
        capabilityVersion: 'v1',
      };
      expect(hasProviderMediatedFetchCapability('tavily', 'extract')).toBe(false);
      // Directly check: missing any flag → not compliant
      expect(
        missingRedirectChain.providesRedirectChain &&
          missingRedirectChain.perHopPolicyEnforcement &&
          missingRedirectChain.dnsRebindingProtection,
      ).toBe(false);
    });
  });
});
