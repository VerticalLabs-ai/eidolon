/**
 * Shared SSRF security boundary for research provider calls.
 *
 * (architecture.md: Network/SSRF policy, VAL-RES-052, VAL-RES-053,
 *  VAL-RES-054, VAL-RES-055, VAL-RES-092, VAL-CROSS-035)
 *
 * This module is the single, centralized enforcement point for:
 * - Fixed provider origin validation (no user/config override).
 * - Provider-origin redirect denial (3xx from Tavily/Firecrawl → denied,
 *   no credential forwarding).
 * - Search-result URL validation (unsafe results excluded before persistence).
 * - Redirect chain validation (max 3, revalidate every hop, reject downgrade).
 *
 * It combines URL-level checks (url-policy.ts) and DNS/IP-level checks
 * (address-policy.ts) into one boundary so that provider adapters cannot
 * drift. Tests may inject transport, DNS, clocks, and randomness, but
 * production origins and policy decisions remain closed.
 */

import { PROVIDER_ORIGINS, PROVIDER_PATHS, type ResearchProviderName } from './origins.js';
import { type ResearchOperation, ResearchProviderError } from './spi.js';
import { validateTargetUrl, type UrlValidationResult } from './url-policy.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of redirects to follow (VAL-RES-053). */
export const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// VAL-RES-055: Fixed provider origin validation
// ---------------------------------------------------------------------------

export type ProviderOriginErrorCode = 'PROVIDER_ORIGIN_DENIED' | 'PROVIDER_PATH_DENIED';

export interface ProviderOriginValidationResult {
  valid: boolean;
  errorCode?: ProviderOriginErrorCode;
  message?: string;
}

/**
 * Validate that a URL matches the fixed provider origin and an allowlisted
 * operation path. This prevents origin, protocol, host, port, or path
 * overrides from Mission input, mode configuration, or request metadata.
 *
 * The URL must be an exact match for:
 *   `{PROVIDER_ORIGIN}{PROVIDER_PATH[provider][operation]}`
 *
 * No query parameters, fragments, or userinfo are permitted on provider
 * API calls.
 */
export function validateProviderOriginUrl(
  url: string,
  provider: ResearchProviderName,
  operation: ResearchOperation,
): ProviderOriginValidationResult {
  const expectedOrigin = PROVIDER_ORIGINS[provider];
  const expectedPath = PROVIDER_PATHS[provider][operation];
  if (!expectedPath) {
    return {
      valid: false,
      errorCode: 'PROVIDER_PATH_DENIED',
      message: `No allowlisted path for provider "${provider}" operation "${operation}"`,
    };
  }

  // Parse the supplied URL for strict comparison.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      valid: false,
      errorCode: 'PROVIDER_ORIGIN_DENIED',
      message: 'Provider URL is not valid',
    };
  }

  // Check scheme is https.
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      errorCode: 'PROVIDER_ORIGIN_DENIED',
      message: 'Provider origin must use https',
    };
  }

  // Check no userinfo.
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      errorCode: 'PROVIDER_ORIGIN_DENIED',
      message: 'Provider origin must not contain credentials',
    };
  }

  // Check no fragment.
  if (parsed.hash) {
    return {
      valid: false,
      errorCode: 'PROVIDER_ORIGIN_DENIED',
      message: 'Provider origin must not contain a fragment',
    };
  }

  // Check no query on provider API calls.
  if (parsed.search) {
    return {
      valid: false,
      errorCode: 'PROVIDER_PATH_DENIED',
      message: 'Provider API path must not include query parameters',
    };
  }

  // Check port is 443 (default or explicit).
  if (parsed.port && parsed.port !== '443') {
    return {
      valid: false,
      errorCode: 'PROVIDER_ORIGIN_DENIED',
      message: 'Provider origin must use port 443',
    };
  }

  // Check hostname matches exactly.
  const expectedParsed = new URL(expectedOrigin);
  if (parsed.hostname.toLowerCase() !== expectedParsed.hostname.toLowerCase()) {
    return {
      valid: false,
      errorCode: 'PROVIDER_ORIGIN_DENIED',
      message: 'Provider origin does not match the fixed configured origin',
    };
  }

  // Check pathname matches exactly (allowlisted path).
  if (parsed.pathname !== expectedPath) {
    return {
      valid: false,
      errorCode: 'PROVIDER_PATH_DENIED',
      message: 'Provider path is not in the allowlisted operation paths',
    };
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// VAL-RES-092: Provider redirects cannot forward credentials
// ---------------------------------------------------------------------------

/** HTTP status codes that indicate a redirect. */
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/**
 * Returns true if the HTTP status code is a redirect (3xx).
 */
export function isProviderRedirect(statusCode: number): boolean {
  return REDIRECT_STATUS_CODES.has(statusCode);
}

/** Information for creating a provider redirect denied error. */
export interface ProviderRedirectErrorInfo {
  statusCode: number;
  provider: ResearchProviderName;
  operation: ResearchOperation;
  /** The redirect Location header value (never included in the error message). */
  location?: string;
}

/**
 * Create a `PROVIDER_REDIRECT_DENIED` error for a 3xx response from a
 * provider origin. Provider API requests must not follow redirects;
 * any 3xx is a policy denial. No credential header is forwarded.
 *
 * The error message never includes the redirect location URL.
 */
export function createProviderRedirectError(
  info: ProviderRedirectErrorInfo,
): ResearchProviderError {
  return new ResearchProviderError(
    'POLICY_DENIED',
    `Provider "${info.provider}" returned a redirect (status ${info.statusCode}) which is denied by policy`,
    info.provider,
    info.operation,
    info.statusCode,
  );
}

// ---------------------------------------------------------------------------
// VAL-RES-054: Search-result URL validation
// ---------------------------------------------------------------------------

export interface SearchResultUrlExclusion {
  /** The original URL that was excluded. */
  url: string;
  /** Safe reason code (never includes sensitive values from the URL). */
  reason: string;
}

export interface SearchResultUrlValidationResult {
  /** URLs that passed validation (canonicalized). */
  safeUrls: string[];
  /** URLs that were excluded with safe reason codes. */
  excluded: SearchResultUrlExclusion[];
}

/**
 * Validate a list of search-result URLs before persistence or later use.
 *
 * Unsafe URLs (non-HTTPS, credentials, blocked hosts, sensitive query
 * parameters, etc.) are excluded. Safe URLs are canonicalized and returned.
 * Discovery alone never authorizes a follow-up fetch.
 *
 * Exclusion reasons never include sensitive values (credentials, query
 * parameter values) from the original URL.
 */
export function validateSearchResultUrls(urls: string[]): SearchResultUrlValidationResult {
  const safeUrls: string[] = [];
  const excluded: SearchResultUrlExclusion[] = [];

  for (const raw of urls) {
    const result = validateTargetUrl(raw);
    if (result.valid && result.canonicalUrl) {
      safeUrls.push(result.canonicalUrl);
    } else {
      excluded.push({
        url: raw,
        reason: result.errorCode ?? 'URL_REJECTED',
      });
    }
  }

  return { safeUrls, excluded };
}

// ---------------------------------------------------------------------------
// VAL-RES-052 / VAL-RES-053: Redirect chain validation
// ---------------------------------------------------------------------------

export type RedirectValidationErrorCode = 'REDIRECT_COUNT_EXCEEDED' | 'REDIRECT_DESTINATION_DENIED';

export interface RedirectHop {
  /** The URL of this hop (after redirect). */
  url: string;
  /** The URL validation result for this hop. */
  validation: UrlValidationResult;
}

export interface RedirectChainValidationResult {
  valid: boolean;
  errorCode?: RedirectValidationErrorCode;
  message?: string;
  /** The validated hops in order. */
  hops: RedirectHop[];
}

/**
 * Validate a redirect chain. Each destination is revalidated against the
 * target URL policy. The chain is capped at MAX_REDIRECTS (3) hops.
 *
 * This validates the URL-level safety of each hop. DNS-level validation
 * must be performed separately by the caller using `resolveAndValidate`
 * for each hop's hostname (with DNS rebinding prevention by pinning the
 * resolved address).
 *
 * The caller must strip all sensitive headers (Authorization, Cookie, etc.)
 * before following any redirect. Provider-origin redirects are denied
 * entirely by `createProviderRedirectError`.
 */
export function validateRedirectChain(redirectUrls: string[]): RedirectChainValidationResult {
  if (redirectUrls.length > MAX_REDIRECTS) {
    return {
      valid: false,
      errorCode: 'REDIRECT_COUNT_EXCEEDED',
      message: `Redirect chain exceeds maximum of ${MAX_REDIRECTS} redirects`,
      hops: [],
    };
  }

  const hops: RedirectHop[] = [];
  for (const url of redirectUrls) {
    const validation = validateTargetUrl(url);
    hops.push({ url, validation });
    if (!validation.valid) {
      return {
        valid: false,
        errorCode: 'REDIRECT_DESTINATION_DENIED',
        message: validation.message ?? 'Redirect destination is not a safe target',
        hops,
      };
    }
  }

  return { valid: true, hops };
}

// ---------------------------------------------------------------------------
// Sensitive headers that must never be forwarded across origins
// ---------------------------------------------------------------------------

/**
 * Headers that must be stripped before following any redirect across
 * origins. Provider authorization, cookies, and other sensitive headers
 * must never be forwarded to a redirect destination.
 */
export const SENSITIVE_HEADERS_TO_STRIP: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
];

/**
 * Returns the set of headers to send to a redirect destination.
 * All sensitive headers are stripped.
 */
export function stripSensitiveHeadersForRedirect(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!SENSITIVE_HEADERS_TO_STRIP.includes(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}
