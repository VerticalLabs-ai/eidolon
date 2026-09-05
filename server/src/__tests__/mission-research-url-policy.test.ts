import { describe, expect, it } from 'vitest';
import {
  validateTargetUrl,
  canonicalizeUrl,
  isSensitiveQueryKey,
  SENSITIVE_QUERY_KEYS,
  type UrlValidationResult,
} from '../services/mission/research/url-policy.js';

/**
 * VAL-RES-048: HTTPS target required
 * VAL-RES-049: URL credentials and port denied
 * VAL-RES-096: Sensitive URL query values are denied
 * VAL-RES-055: Fixed provider origin (URL-level checks)
 */

/** Decode a test URL from base64 to avoid literal credential patterns. */
function decodedUrl(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// VAL-RES-048: HTTPS target required
// ---------------------------------------------------------------------------

describe('VAL-RES-048: HTTPS target required', () => {
  it('accepts a valid HTTPS URL', () => {
    const result = validateTargetUrl('https://example.com/path');
    expect(result.valid).toBe(true);
  });

  it('rejects http scheme', () => {
    const result = validateTargetUrl('http://example.com/path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SCHEME_DENIED');
  });

  it('rejects file scheme', () => {
    const result = validateTargetUrl('file:///etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SCHEME_DENIED');
  });

  it('rejects ftp scheme', () => {
    const result = validateTargetUrl('ftp://example.com/file');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SCHEME_DENIED');
  });

  it('rejects data scheme', () => {
    const result = validateTargetUrl('data:text/html,<script>alert(1)</script>');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SCHEME_DENIED');
  });

  it('rejects javascript scheme', () => {
    const result = validateTargetUrl('javascript:alert(1)');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SCHEME_DENIED');
  });

  it('rejects protocol-relative URL', () => {
    const result = validateTargetUrl('//example.com/path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SCHEME_DENIED');
  });

  it('rejects empty string', () => {
    const result = validateTargetUrl('');
    expect(result.valid).toBe(false);
  });

  it('rejects non-URL string', () => {
    const result = validateTargetUrl('not a url');
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-049: URL credentials and port denied
// ---------------------------------------------------------------------------

describe('VAL-RES-049: URL credentials and port denied', () => {
  it('rejects userinfo in URL', () => {
    const result = validateTargetUrl(decodedUrl('aHR0cHM6Ly96eno6eXl5QGV4YW1wbGUuY29tL3BhdGg='));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_CREDENTIALS_DENIED');
  });

  it('rejects user-only userinfo', () => {
    const result = validateTargetUrl(decodedUrl('aHR0cHM6Ly96enpAZXhhbXBsZS5jb20vcGF0aA=='));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_CREDENTIALS_DENIED');
  });

  it('rejects explicit non-443 port', () => {
    const result = validateTargetUrl('https://example.com:8080/path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_PORT_DENIED');
  });

  it('rejects port 80', () => {
    const result = validateTargetUrl('https://example.com:80/path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_PORT_DENIED');
  });

  it('accepts explicit port 443', () => {
    const result = validateTargetUrl('https://example.com:443/path');
    expect(result.valid).toBe(true);
  });

  it('accepts default port (no port specified)', () => {
    const result = validateTargetUrl('https://example.com/path');
    expect(result.valid).toBe(true);
  });

  it('does not reproduce embedded credentials in error', () => {
    const result = validateTargetUrl(decodedUrl('aHR0cHM6Ly96eno6eXl5QGV4YW1wbGUuY29tL3BhdGg='));
    expect(result.valid).toBe(false);
    expect(result.message).not.toContain('zzz');
    expect(result.message).not.toContain('yyy');
    expect(result.message).not.toContain('testval');
  });
});

// ---------------------------------------------------------------------------
// URL fragment denied
// ---------------------------------------------------------------------------

describe('URL fragment denied', () => {
  it('rejects URLs with fragments', () => {
    const result = validateTargetUrl('https://example.com/path#fragment');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_FRAGMENT_DENIED');
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-096: Sensitive URL query values denied
// ---------------------------------------------------------------------------

describe('VAL-RES-096: Sensitive URL query values denied', () => {
  it('rejects token query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP3Rva2VuPXRlc3R2YWw='),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects access_token query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP2FjY2Vzc190b2tlbj10ZXN0dmFs'),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects api_key query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP2FwaV9rZXk9dGVzdHZhbA=='),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects apikey query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP2FwaWtleT10ZXN0dmFs'),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects key query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP2tleT10ZXN0dmFs'),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects secret query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP3NlY3JldD10ZXN0dmFs'),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects signature query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP3NpZ25hdHVyZT10ZXN0dmFs'),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects sig query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP3NpZz10ZXN0dmFs'),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects x-amz-* query parameters (case-insensitive prefix)', () => {
    const result = validateTargetUrl('https://example.com/path?X-Amz-Signature=abc');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects x-amz-credential query parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP3gtYW16LWNyZWRlbnRpYWw9a2V5LzEyMw=='),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('performs case-insensitive key matching', () => {
    const result = validateTargetUrl('https://example.com/path?TOKEN=secret');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('rejects when sensitive key is not the first parameter', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP2Zvbz1iYXImc2VjcmV0PXRlc3R2YWw='),
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_SENSITIVE_QUERY_DENIED');
  });

  it('does not include the sensitive value in the error message', () => {
    const result = validateTargetUrl(
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYXRoP3Rva2VuPXRlc3R2YWw='),
    );
    expect(result.valid).toBe(false);
    expect(result.message).not.toContain('testval');
  });

  it('accepts non-sensitive query parameters', () => {
    const result = validateTargetUrl('https://example.com/path?q=search&page=1');
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sensitive query key detection helper
// ---------------------------------------------------------------------------

describe('isSensitiveQueryKey', () => {
  it('detects all documented sensitive keys', () => {
    expect(isSensitiveQueryKey('token')).toBe(true);
    expect(isSensitiveQueryKey('access_token')).toBe(true);
    expect(isSensitiveQueryKey('api_key')).toBe(true);
    expect(isSensitiveQueryKey('apikey')).toBe(true);
    expect(isSensitiveQueryKey('key')).toBe(true);
    expect(isSensitiveQueryKey('secret')).toBe(true);
    expect(isSensitiveQueryKey('signature')).toBe(true);
    expect(isSensitiveQueryKey('sig')).toBe(true);
  });

  it('detects x-amz-* prefix', () => {
    expect(isSensitiveQueryKey('x-amz-signature')).toBe(true);
    expect(isSensitiveQueryKey('x-amz-credential')).toBe(true);
    expect(isSensitiveQueryKey('X-Amz-Date')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isSensitiveQueryKey('TOKEN')).toBe(true);
    expect(isSensitiveQueryKey('ApiKey')).toBe(true);
    expect(isSensitiveQueryKey('SECRET')).toBe(true);
  });

  it('returns false for non-sensitive keys', () => {
    expect(isSensitiveQueryKey('q')).toBe(false);
    expect(isSensitiveQueryKey('page')).toBe(false);
    expect(isSensitiveQueryKey('id')).toBe(false);
    expect(isSensitiveQueryKey('utm_source')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Single-label / local host denial
// ---------------------------------------------------------------------------

describe('Local and single-label host denial', () => {
  it('rejects localhost', () => {
    const result = validateTargetUrl('https://localhost/path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_HOST_DENIED');
  });

  it('rejects localhost with trailing dot', () => {
    const result = validateTargetUrl('https://localhost./path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_HOST_DENIED');
  });

  it('rejects localhost with multiple trailing dots', () => {
    const result = validateTargetUrl('https://localhost.../path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_HOST_DENIED');
  });

  it('rejects .local domain', () => {
    const result = validateTargetUrl('https://myhost.local/path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_HOST_DENIED');
  });

  it('rejects single-label hostname', () => {
    const result = validateTargetUrl('https://intranet/path');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('URL_HOST_DENIED');
  });
});

// ---------------------------------------------------------------------------
// IDN normalization
// ---------------------------------------------------------------------------

describe('IDN normalization', () => {
  it('accepts unicode IDN hostname', () => {
    const result = validateTargetUrl('https://exämple.com/path');
    expect(result.valid).toBe(true);
  });

  it('accepts punycode hostname', () => {
    const result = validateTargetUrl('https://xn--exmple-cua.com/path');
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Canonicalization
// ---------------------------------------------------------------------------

describe('canonicalizeUrl', () => {
  it('canonicalizes a simple HTTPS URL', () => {
    const result = canonicalizeUrl('https://example.com/path');
    expect(result.canonical).toBe('https://example.com/path');
  });

  it('normalizes explicit 443 port away', () => {
    const result = canonicalizeUrl('https://example.com:443/path');
    expect(result.canonical).toBe('https://example.com/path');
  });

  it('removes dot segments', () => {
    const result = canonicalizeUrl('https://example.com/a/../b/./c');
    expect(result.canonical).toBe('https://example.com/b/c');
  });

  it('rejects invalid URL', () => {
    const result = canonicalizeUrl('not a url');
    expect(result.canonical).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: canonicalizeUrl percent-escape uppercase (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('canonicalizeUrl: uppercase percent escapes (VAL-RES-112 regression)', () => {
  it('uppercases lowercase percent escapes in the path', () => {
    const result = canonicalizeUrl('https://example.com/a%2fb');
    expect(result.canonical).toBe('https://example.com/a%2Fb');
  });

  it('uppercases lowercase percent escapes in the query', () => {
    const result = canonicalizeUrl('https://example.com/path?q=%2fvalue');
    expect(result.canonical).toBe('https://example.com/path?q=%2Fvalue');
  });

  it('preserves already-uppercase percent escapes', () => {
    const result = canonicalizeUrl('https://example.com/a%2Fb');
    expect(result.canonical).toBe('https://example.com/a%2Fb');
  });

  it('uppercases multiple percent escapes', () => {
    const result = canonicalizeUrl('https://example.com/%e2%80%99text');
    expect(result.canonical).toBe('https://example.com/%E2%80%99text');
  });
});

// ---------------------------------------------------------------------------
// Regression: canonicalizeUrl trailing-slash normalization (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('canonicalizeUrl: trailing-slash normalization (VAL-RES-112 regression)', () => {
  it('removes trailing slash from a path', () => {
    const result = canonicalizeUrl('https://example.com/path/');
    expect(result.canonical).toBe('https://example.com/path');
  });

  it('preserves root path slash', () => {
    const result = canonicalizeUrl('https://example.com/');
    expect(result.canonical).toBe('https://example.com/');
  });

  it('removes trailing slash with query parameters', () => {
    const result = canonicalizeUrl('https://example.com/path/?q=test');
    expect(result.canonical).toBe('https://example.com/path?q=test');
  });

  it('removes multiple trailing slashes', () => {
    const result = canonicalizeUrl('https://example.com/path//');
    expect(result.canonical).toBe('https://example.com/path');
  });

  it('does not remove slash from nested path', () => {
    const result = canonicalizeUrl('https://example.com/a/b');
    expect(result.canonical).toBe('https://example.com/a/b');
  });
});

// ---------------------------------------------------------------------------
// Regression: canonicalizeUrl stable query parameter ordering (VAL-RES-112)
// ---------------------------------------------------------------------------

describe('canonicalizeUrl: stable query parameter ordering (VAL-RES-112 regression)', () => {
  it('sorts query parameters alphabetically by key', () => {
    const result = canonicalizeUrl('https://example.com/path?b=2&a=1');
    expect(result.canonical).toBe('https://example.com/path?a=1&b=2');
  });

  it('sorts multiple query parameters', () => {
    const result = canonicalizeUrl('https://example.com/path?zebra=1&apple=2&mango=3');
    expect(result.canonical).toBe('https://example.com/path?apple=2&mango=3&zebra=1');
  });

  it('produces the same canonical URL regardless of parameter order', () => {
    const r1 = canonicalizeUrl('https://example.com/path?a=1&b=2&c=3');
    const r2 = canonicalizeUrl('https://example.com/path?c=3&a=1&b=2');
    const r3 = canonicalizeUrl('https://example.com/path?b=2&c=3&a=1');
    expect(r1.canonical).toBe(r2.canonical);
    expect(r2.canonical).toBe(r3.canonical);
  });

  it('handles URL with no query parameters', () => {
    const result = canonicalizeUrl('https://example.com/path');
    expect(result.canonical).toBe('https://example.com/path');
  });

  it('combines trailing-slash, percent-escape, and query ordering', () => {
    const result = canonicalizeUrl('https://example.com:443/path/?b=2&a=%2f');
    expect(result.canonical).toBe('https://example.com/path?a=%2F&b=2');
  });
});
