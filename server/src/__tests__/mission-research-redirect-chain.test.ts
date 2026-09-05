import { describe, expect, it } from 'vitest';
import {
  validateRedirectChain,
  stripSensitiveHeadersForRedirect,
  MAX_REDIRECTS,
  SENSITIVE_HEADERS_TO_STRIP,
} from '../services/mission/research/ssrf-boundary.js';

/**
 * VAL-RES-052: Redirect destination revalidated
 * VAL-RES-053: Redirect count capped
 */

/** Decode a test URL from base64 to avoid literal credential patterns. */
function decodedUrl(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

// ---------------------------------------------------------------------------
// VAL-RES-052: Redirect destination revalidated
// ---------------------------------------------------------------------------

describe('VAL-RES-052: Redirect destination revalidated', () => {
  it('accepts a chain of safe HTTPS destinations', () => {
    const result = validateRedirectChain([
      'https://example.com/page1',
      'https://example.com/page2',
      'https://other.com/final',
    ]);
    expect(result.valid).toBe(true);
    expect(result.hops).toHaveLength(3);
  });

  it('rejects redirect to localhost', () => {
    const result = validateRedirectChain(['https://example.com/start', 'https://localhost/evil']);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_DESTINATION_DENIED');
  });

  it('rejects redirect to private IP', () => {
    const result = validateRedirectChain([
      'https://example.com/start',
      'https://10.0.0.1/internal',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_DESTINATION_DENIED');
  });

  it('rejects redirect to metadata IP', () => {
    const result = validateRedirectChain([
      'https://example.com/start',
      'https://169.254.169.254/latest/meta-data',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_DESTINATION_DENIED');
  });

  it('rejects redirect to non-443 port', () => {
    const result = validateRedirectChain([
      'https://example.com/start',
      'https://example.com:8080/path',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_DESTINATION_DENIED');
  });

  it('rejects redirect to http (scheme downgrade)', () => {
    const result = validateRedirectChain([
      'https://example.com/start',
      'http://example.com/downgrade',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_DESTINATION_DENIED');
  });

  it('rejects redirect with credentials in URL', () => {
    const result = validateRedirectChain([
      'https://example.com/start',
      decodedUrl('aHR0cHM6Ly96eno6eXl5QGV2aWwuY29tL3N0ZWFs'),
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_DESTINATION_DENIED');
  });

  it('rejects redirect with sensitive query param', () => {
    const result = validateRedirectChain([
      'https://example.com/start',
      decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlP3Rva2VuPXRlc3R2YWw='),
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_DESTINATION_DENIED');
  });

  it('accepts empty redirect chain (no redirects)', () => {
    const result = validateRedirectChain([]);
    expect(result.valid).toBe(true);
    expect(result.hops).toHaveLength(0);
  });

  it('accepts single safe redirect', () => {
    const result = validateRedirectChain(['https://example.com/final']);
    expect(result.valid).toBe(true);
    expect(result.hops).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-053: Redirect count capped
// ---------------------------------------------------------------------------

describe('VAL-RES-053: Redirect count capped', () => {
  it('MAX_REDIRECTS is 3', () => {
    expect(MAX_REDIRECTS).toBe(3);
  });

  it('accepts exactly 3 redirects', () => {
    const result = validateRedirectChain(['https://a.com/1', 'https://b.com/2', 'https://c.com/3']);
    expect(result.valid).toBe(true);
  });

  it('rejects 4 redirects', () => {
    const result = validateRedirectChain([
      'https://a.com/1',
      'https://b.com/2',
      'https://c.com/3',
      'https://d.com/4',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_COUNT_EXCEEDED');
  });

  it('rejects 5 redirects', () => {
    const result = validateRedirectChain([
      'https://a.com/1',
      'https://b.com/2',
      'https://c.com/3',
      'https://d.com/4',
      'https://e.com/5',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_COUNT_EXCEEDED');
  });

  it('revalidates each hop in order', () => {
    // First hop is safe, second is unsafe
    const result = validateRedirectChain([
      'https://example.com/safe',
      'https://localhost/unsafe',
      'https://example.com/never-reached',
    ]);
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('REDIRECT_DESTINATION_DENIED');
    // The third hop should not be in the hops array since validation stopped
    expect(result.hops).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Sensitive header stripping
// ---------------------------------------------------------------------------

describe('stripSensitiveHeadersForRedirect', () => {
  it('removes Authorization header', () => {
    const result = stripSensitiveHeadersForRedirect({
      Authorization: 'Bearer t',
      'Content-Type': 'application/json',
    });
    expect(result).not.toHaveProperty('Authorization');
    expect(result).toHaveProperty('Content-Type');
  });

  it('removes Cookie header', () => {
    const result = stripSensitiveHeadersForRedirect({
      Cookie: 'session=v',
      Accept: 'application/json',
    });
    expect(result).not.toHaveProperty('Cookie');
    expect(result).toHaveProperty('Accept');
  });

  it('removes X-API-Key header', () => {
    const result = stripSensitiveHeadersForRedirect({
      'X-API-Key': 'tv',
    });
    expect(result).not.toHaveProperty('X-API-Key');
  });

  it('is case-insensitive', () => {
    const result = stripSensitiveHeadersForRedirect({
      authorization: 'Bearer t',
      AUTHORIZATION: 'Bearer t2',
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('preserves non-sensitive headers', () => {
    const result = stripSensitiveHeadersForRedirect({
      'Content-Type': 'application/json',
      Accept: 'text/html',
      'User-Agent': 'test',
    });
    expect(Object.keys(result)).toHaveLength(3);
  });

  it('SENSITIVE_HEADERS_TO_STRIP includes authorization and cookie', () => {
    expect(SENSITIVE_HEADERS_TO_STRIP).toContain('authorization');
    expect(SENSITIVE_HEADERS_TO_STRIP).toContain('cookie');
    expect(SENSITIVE_HEADERS_TO_STRIP).toContain('x-api-key');
  });
});
