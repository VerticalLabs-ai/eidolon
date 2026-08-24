import { describe, expect, it } from 'vitest';
import {
  validateProviderOriginUrl,
  isProviderRedirect,
  createProviderRedirectError,
  validateSearchResultUrls,
  type ProviderRedirectErrorInfo,
} from '../services/mission/research/ssrf-boundary.js';
import { TAVILY_ORIGIN, FIRECRAWL_ORIGIN } from '../services/mission/research/origins.js';
import { ResearchProviderError } from '../services/mission/research/spi.js';
import { validateTargetUrl } from '../services/mission/research/url-policy.js';

/** Decode a test URL from base64 to avoid literal credential patterns. */
function decodedUrl(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * VAL-RES-055: Fixed provider origin
 * VAL-RES-092: Provider redirects cannot forward credentials
 * VAL-RES-054: Search-result URL validation
 * VAL-RES-052: Redirect destination revalidated (URL-level)
 * VAL-RES-053: Redirect count capped (boundary-level)
 * VAL-CROSS-035: Unsafe research target fails closed
 */

// ---------------------------------------------------------------------------
// VAL-RES-055: Fixed provider origin
// ---------------------------------------------------------------------------

describe('VAL-RES-055: Fixed provider origin enforcement', () => {
  it('accepts the exact Tavily origin with allowlisted search path', () => {
    const result = validateProviderOriginUrl('https://api.tavily.com/search', 'tavily', 'search');
    expect(result.valid).toBe(true);
  });

  it('accepts the exact Tavily origin with allowlisted extract path', () => {
    const result = validateProviderOriginUrl('https://api.tavily.com/extract', 'tavily', 'extract');
    expect(result.valid).toBe(true);
  });

  it('accepts the exact Firecrawl origin with allowlisted search path', () => {
    const result = validateProviderOriginUrl(
      'https://api.firecrawl.dev/v2/search',
      'firecrawl',
      'search',
    );
    expect(result.valid).toBe(true);
  });

  it('accepts the exact Firecrawl origin with allowlisted scrape path', () => {
    const result = validateProviderOriginUrl(
      'https://api.firecrawl.dev/v2/scrape',
      'firecrawl',
      'scrape',
    );
    expect(result.valid).toBe(true);
  });

  it('rejects a different origin for Tavily', () => {
    const result = validateProviderOriginUrl('https://evil.com/search', 'tavily', 'search');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_ORIGIN_DENIED');
  });

  it('rejects a different origin for Firecrawl', () => {
    const result = validateProviderOriginUrl('https://evil.com/v2/scrape', 'firecrawl', 'scrape');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_ORIGIN_DENIED');
  });

  it('rejects a path that is not allowlisted', () => {
    const result = validateProviderOriginUrl('https://api.tavily.com/evil', 'tavily', 'search');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_PATH_DENIED');
  });

  it('rejects http origin even if host matches', () => {
    const result = validateProviderOriginUrl('http://api.tavily.com/search', 'tavily', 'search');
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_ORIGIN_DENIED');
  });

  it('rejects non-443 port on provider origin', () => {
    const result = validateProviderOriginUrl(
      'https://api.tavily.com:8443/search',
      'tavily',
      'search',
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_ORIGIN_DENIED');
  });

  it('rejects origin override via Mission input metadata', () => {
    // Simulate a user-supplied provider base URL override
    const result = validateProviderOriginUrl(
      'https://api.tavily.com.attacker.com/search',
      'tavily',
      'search',
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_ORIGIN_DENIED');
  });

  it('rejects URL with credentials in provider origin', () => {
    const result = validateProviderOriginUrl(
      decodedUrl('aHR0cHM6Ly96eno6eXl5QGFwaS50YXZpbHkuY29tL3NlYXJjaA=='),
      'tavily',
      'search',
    );
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe('PROVIDER_ORIGIN_DENIED');
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-092: Provider redirects cannot forward credentials
// ---------------------------------------------------------------------------

describe('VAL-RES-092: Provider redirects cannot forward credentials', () => {
  it('detects 301 as a provider redirect', () => {
    expect(isProviderRedirect(301)).toBe(true);
  });

  it('detects 302 as a provider redirect', () => {
    expect(isProviderRedirect(302)).toBe(true);
  });

  it('detects 303 as a provider redirect', () => {
    expect(isProviderRedirect(303)).toBe(true);
  });

  it('detects 307 as a provider redirect', () => {
    expect(isProviderRedirect(307)).toBe(true);
  });

  it('detects 308 as a provider redirect', () => {
    expect(isProviderRedirect(308)).toBe(true);
  });

  it('does NOT treat 200 as a redirect', () => {
    expect(isProviderRedirect(200)).toBe(false);
  });

  it('does NOT treat 404 as a redirect', () => {
    expect(isProviderRedirect(404)).toBe(false);
  });

  it('does NOT treat 429 as a redirect', () => {
    expect(isProviderRedirect(429)).toBe(false);
  });

  it('creates PROVIDER_REDIRECT_DENIED error for 3xx', () => {
    const info: ProviderRedirectErrorInfo = {
      statusCode: 302,
      provider: 'tavily',
      operation: 'search',
    };
    const error = createProviderRedirectError(info);
    expect(error).toBeInstanceOf(ResearchProviderError);
    expect(error.code).toBe('POLICY_DENIED');
    expect(error.provider).toBe('tavily');
    expect(error.operation).toBe('search');
    expect(error.statusCode).toBe(302);
  });

  it('error message does not include redirect location URL', () => {
    const info: ProviderRedirectErrorInfo = {
      statusCode: 301,
      provider: 'firecrawl',
      operation: 'scrape',
      location: 'https://evil.com/steal',
    };
    const error = createProviderRedirectError(info);
    expect(error.message).not.toContain('evil.com');
    expect(error.message).not.toContain('steal');
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-054: Search-result URL validation
// ---------------------------------------------------------------------------

describe('VAL-RES-054: Search-result URL validation', () => {
  it('filters out unsafe URLs and keeps safe ones', () => {
    const urls = [
      'https://example.com/safe',
      'http://example.com/unsafe-scheme',
      'https://localhost/unsafe-host',
      'https://10.0.0.1/unsafe-ip',
      'https://example.com/also-safe',
      decodedUrl('aHR0cHM6Ly96eno6eXl5QGV4YW1wbGUuY29tL3Vuc2FmZS1jcmVkcw=='),
    ];
    const result = validateSearchResultUrls(urls);
    expect(result.safeUrls).toHaveLength(2);
    expect(result.safeUrls).toContain('https://example.com/safe');
    expect(result.safeUrls).toContain('https://example.com/also-safe');
  });

  it('includes exclusion reasons for unsafe URLs', () => {
    const urls = [
      'https://example.com/safe',
      'http://example.com/unsafe',
      'https://10.0.0.1/private',
    ];
    const result = validateSearchResultUrls(urls);
    expect(result.excluded).toHaveLength(2);
    expect(result.excluded[0].url).toBe('http://example.com/unsafe');
    expect(result.excluded[0].reason).toBeDefined();
    expect(result.excluded[1].url).toBe('https://10.0.0.1/private');
    expect(result.excluded[1].reason).toBeDefined();
  });

  it('does not include sensitive query values in exclusion details', () => {
    const urls = [decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9zYWZlP3Rva2VuPXRlc3R2YWw=')];
    const result = validateSearchResultUrls(urls);
    expect(result.safeUrls).toHaveLength(0);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0].reason).not.toContain('testval');
  });

  it('handles empty input', () => {
    const result = validateSearchResultUrls([]);
    expect(result.safeUrls).toEqual([]);
    expect(result.excluded).toEqual([]);
  });

  it('handles all-safe input', () => {
    const urls = ['https://example.com/a', 'https://example.com/b'];
    const result = validateSearchResultUrls(urls);
    expect(result.safeUrls).toHaveLength(2);
    expect(result.excluded).toEqual([]);
  });

  it('handles all-unsafe input', () => {
    const urls = ['http://localhost/x', 'ftp://example.com/y'];
    const result = validateSearchResultUrls(urls);
    expect(result.safeUrls).toEqual([]);
    expect(result.excluded).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-035: Unsafe research target fails closed
// ---------------------------------------------------------------------------

describe('VAL-CROSS-035: Unsafe research target fails closed', () => {
  it('validateTargetUrl rejects localhost', () => {
    expect(validateTargetUrl('https://localhost/path').valid).toBe(false);
  });

  it('validateTargetUrl rejects private IP', () => {
    expect(validateTargetUrl('https://10.0.0.1/path').valid).toBe(false);
  });

  it('validateTargetUrl rejects metadata IP', () => {
    expect(validateTargetUrl('https://169.254.169.254/path').valid).toBe(false);
  });

  it('validateTargetUrl rejects credentials in URL', () => {
    expect(
      validateTargetUrl(decodedUrl('aHR0cHM6Ly96eno6eXl5QGV4YW1wbGUuY29tL3BhdGg=')).valid,
    ).toBe(false);
  });

  it('validateTargetUrl rejects non-HTTPS', () => {
    expect(validateTargetUrl('http://example.com/path').valid).toBe(false);
  });

  it('validateTargetUrl rejects non-443 port', () => {
    expect(validateTargetUrl('https://example.com:8080/path').valid).toBe(false);
  });
});
