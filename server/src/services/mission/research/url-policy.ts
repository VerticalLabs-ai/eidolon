/**
 * Target URL validation and canonicalization for SSRF prevention.
 *
 * (architecture.md: Network/SSRF policy, VAL-RES-048, VAL-RES-049,
 *  VAL-RES-096, VAL-CROSS-035)
 *
 * This module enforces the shared target URL policy before sending URLs
 * to a provider and before any direct retrieval. It is the single source
 * of truth for URL-level SSRF checks so that provider adapters cannot drift.
 *
 * Rules:
 * - Absolute `https:` URLs only (reject http, file, ftp, data, javascript,
 *   protocol-relative, and any non-https scheme).
 * - Effective port must be 443 (default or explicit). Reject non-443 ports.
 * - No userinfo (credentials) in the URL.
 * - No fragment.
 * - No localhost, single-label local host, or `.local` domain.
 * - No sensitive credential-bearing query parameters.
 * - IDN hostnames are normalized (punycode encoded for canonical form).
 * - IP-literal hostnames that are in blocked ranges (loopback, private,
 *   link-local, metadata, CGNAT, etc.) are rejected at the URL level
 *   without DNS resolution.
 */

import * as net from 'node:net';
import { isBlockedAddress } from './address-policy.js';

// ---------------------------------------------------------------------------
// Sensitive query keys (VAL-RES-096)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive set of sensitive query parameter keys whose presence
 * denies a target URL. Values are never persisted or echoed in errors.
 */
export const SENSITIVE_QUERY_KEYS: readonly string[] = [
  'token',
  'access_token',
  'api_key',
  'apikey',
  'key',
  'secret',
  'signature',
  'sig',
];

/** AWS Signature V4 parameter prefix (case-insensitive). */
const SENSITIVE_QUERY_PREFIX = 'x-amz-';

/**
 * Returns true if the query parameter key is sensitive (case-insensitive).
 * Sensitive keys: token, access_token, api_key, apikey, key, secret,
 * signature, sig, and any key starting with x-amz-.
 */
export function isSensitiveQueryKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_QUERY_KEYS.includes(lower)) {
    return true;
  }
  return lower.startsWith(SENSITIVE_QUERY_PREFIX);
}

// ---------------------------------------------------------------------------
// Blocked hostnames (URL-level, before DNS resolution)
// ---------------------------------------------------------------------------

/** Top-level domains blocked at the URL level. */
const BLOCKED_TLDS = new Set(['.local']);

/**
 * Returns true if the hostname is blocked at the URL level (before DNS).
 * Blocked: localhost, single-label hostnames, `.local` TLD, and IP-literal
 * addresses in blocked ranges (loopback, private, link-local, metadata, etc.).
 */
function isBlockedHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  // IP-literal hostnames: check directly without DNS resolution.
  if (net.isIP(lower) !== 0) {
    return isBlockedAddress(lower);
  }

  // Strip trailing dot(s) (DNS root label) to prevent bypasses like
  // "localhost." which would otherwise pass the single-label check.
  const normalized = lower.replace(/\.+$/, '');

  // localhost
  if (normalized === 'localhost') {
    return true;
  }

  // .local TLD
  for (const tld of BLOCKED_TLDS) {
    if (normalized.endsWith(tld)) {
      return true;
    }
  }

  // Single-label hostname (no dots) — local intranet names
  if (!normalized.includes('.')) {
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export type UrlValidationErrorCode =
  | 'URL_PARSE_ERROR'
  | 'URL_SCHEME_DENIED'
  | 'URL_CREDENTIALS_DENIED'
  | 'URL_PORT_DENIED'
  | 'URL_FRAGMENT_DENIED'
  | 'URL_HOST_DENIED'
  | 'URL_SENSITIVE_QUERY_DENIED';

export interface UrlValidationResult {
  valid: boolean;
  errorCode?: UrlValidationErrorCode;
  /** Safe message that never includes credentials or sensitive values. */
  message?: string;
  /** The canonical URL if valid. */
  canonicalUrl?: string;
  /** The parsed hostname (lowercase, punycode if IDN). */
  hostname?: string;
}

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

export interface CanonicalizeResult {
  canonical: string | null;
  hostname?: string;
}

/**
 * Canonicalize a URL: normalize scheme to lowercase, remove default port 443,
 * remove dot-segments, and encode IDN hostnames as punycode.
 *
 * Returns `{ canonical: null }` if the URL cannot be parsed.
 */
export function canonicalizeUrl(raw: string): CanonicalizeResult {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { canonical: null };
  }

  // Normalize hostname to lowercase. URL constructor already does this
  // for ASCII; for IDN, the hostname stays as-is in Node's URL.
  const hostname = parsed.hostname.toLowerCase();

  // Remove default port 443 for https.
  let port = parsed.port;
  if (parsed.protocol === 'https:' && port === '443') {
    port = '';
  }

  // Remove dot segments from pathname.
  const pathname = removeDotSegments(parsed.pathname);

  // Reconstruct canonical URL.
  const hostPart = port ? `${hostname}:${port}` : hostname;
  const canonical = `${parsed.protocol}//${hostPart}${pathname}${parsed.search}`;
  return { canonical, hostname };
}

/**
 * Remove dot-segments from a path per RFC 3986 section 5.2.4.
 */
function removeDotSegments(path: string): string {
  const input = path;
  const output: string[] = [];

  let i = 0;
  while (i < input.length) {
    if (input.startsWith('/./', i) || input.slice(i) === '/.') {
      i += 2;
      continue;
    }
    if (input.startsWith('/../', i) || input.slice(i) === '/..') {
      // Remove last segment from output.
      while (output.length > 0 && output[output.length - 1] === '/') {
        output.pop();
      }
      while (output.length > 0 && output[output.length - 1] !== '/') {
        output.pop();
      }
      i += 3;
      continue;
    }
    if (input[i] === '/') {
      output.push('/');
      i++;
      // Collect the next segment.
      let seg = '';
      while (i < input.length && input[i] !== '/') {
        seg += input[i];
        i++;
      }
      if (seg) {
        output.push(seg);
      }
    } else {
      // Leading segment without slash.
      let seg = '';
      while (i < input.length && input[i] !== '/') {
        seg += input[i];
        i++;
      }
      output.push(seg);
    }
  }

  let result = output.join('');
  if (result.length === 0) {
    result = '/';
  }
  // Ensure path starts with /.
  if (!result.startsWith('/')) {
    result = '/' + result;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Target URL validation
// ---------------------------------------------------------------------------

/**
 * Validate a target URL against the SSRF URL policy.
 *
 * Checks (in order):
 * 1. Parseable as an absolute URL.
 * 2. Scheme is `https`.
 * 3. No userinfo (credentials).
 * 4. Port is 443 (default or explicit).
 * 5. No fragment.
 * 6. Hostname is not localhost, single-label, or .local.
 * 7. No sensitive query parameters.
 *
 * Does NOT perform DNS resolution — use `address-policy.ts` for that.
 *
 * Error messages never include credentials or sensitive query values.
 */
export function validateTargetUrl(raw: string): UrlValidationResult {
  // Protocol-relative URLs (//example.com) lack a scheme and are blocked.
  if (raw.startsWith('//')) {
    return {
      valid: false,
      errorCode: 'URL_SCHEME_DENIED',
      message: 'Target URL must use the https scheme',
    };
  }

  if (!raw.toLowerCase().startsWith('https://')) {
    return {
      valid: false,
      errorCode: 'URL_SCHEME_DENIED',
      message: 'Target URL must use the https scheme',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      valid: false,
      errorCode: 'URL_PARSE_ERROR',
      message: 'Target URL is not a valid absolute URL',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      errorCode: 'URL_SCHEME_DENIED',
      message: 'Target URL must use the https scheme',
    };
  }

  // Userinfo / credentials
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      errorCode: 'URL_CREDENTIALS_DENIED',
      message: 'Target URL must not contain credentials',
    };
  }

  // Port
  if (parsed.port && parsed.port !== '443') {
    return {
      valid: false,
      errorCode: 'URL_PORT_DENIED',
      message: 'Target URL must use port 443',
    };
  }

  // Fragment
  if (parsed.hash) {
    return {
      valid: false,
      errorCode: 'URL_FRAGMENT_DENIED',
      message: 'Target URL must not contain a fragment',
    };
  }

  // Hostname
  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedHostname(hostname)) {
    return {
      valid: false,
      errorCode: 'URL_HOST_DENIED',
      message: 'Target URL hostname is blocked',
    };
  }

  // Sensitive query parameters
  let sensitiveKey: string | null = null;
  for (const key of parsed.searchParams.keys()) {
    if (isSensitiveQueryKey(key)) {
      sensitiveKey = key.toLowerCase();
      break;
    }
  }
  if (sensitiveKey) {
    return {
      valid: false,
      errorCode: 'URL_SENSITIVE_QUERY_DENIED',
      message: `Target URL contains a sensitive query parameter`,
      // Do NOT include the parameter value.
    };
  }

  // Canonicalize
  const { canonical } = canonicalizeUrl(raw);
  return {
    valid: true,
    canonicalUrl: canonical ?? raw,
    hostname,
  };
}
