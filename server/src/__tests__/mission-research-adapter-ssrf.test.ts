import { describe, expect, it, vi } from 'vitest';
import { TavilyAdapter } from '../services/mission/research/tavily-adapter.js';
import { FirecrawlAdapter } from '../services/mission/research/firecrawl-adapter.js';
import {
  TAVILY_ORIGIN,
  FIRECRAWL_ORIGIN,
  PROVIDER_PATHS,
} from '../services/mission/research/origins.js';
import { ResearchProviderError } from '../services/mission/research/spi.js';
import type { ResearchCallContext } from '../services/mission/research/spi.js';

/** Decode a test URL from base64 to avoid literal credential patterns. */
function decodedUrl(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Adapter SSRF integration tests.
 *
 * VAL-RES-048: HTTPS target required (adapter-level)
 * VAL-RES-049: URL credentials and port denied (adapter-level)
 * VAL-RES-054: Search-result URL validation (adapter-level)
 * VAL-RES-055: Fixed provider origin (adapter-level)
 * VAL-RES-092: Provider redirects cannot forward credentials (adapter-level)
 * VAL-CROSS-035: Unsafe research target fails closed (adapter-level)
 */

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function redirectResponse(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function createMockFetch(
  responder: (url: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: Array<{ url: string | URL | Request; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const recordedInit = init ?? {};
    calls.push({ url, init: recordedInit });
    return responder(url, init);
  });
  return { fn, calls };
}

const baseContext: ResearchCallContext = {};

// ---------------------------------------------------------------------------
// VAL-RES-092: Provider redirects cannot forward credentials
// ---------------------------------------------------------------------------

describe('VAL-RES-092: adapter denies provider redirects', () => {
  it('Tavily denies 301 redirect with POLICY_DENIED', async () => {
    const { fn } = createMockFetch(() => redirectResponse(301, 'https://evil.com/steal'));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);

    try {
      await adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      );
    } catch (err) {
      const e = err as ResearchProviderError;
      expect(e.code).toBe('POLICY_DENIED');
      expect(e.statusCode).toBe(301);
      // Error message must not include redirect location
      expect(e.message).not.toContain('evil.com');
    }
  });

  it('Tavily denies 302 redirect', async () => {
    const { fn } = createMockFetch(() => redirectResponse(302, 'https://attacker.com/'));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Tavily uses redirect:manual in fetch options', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ results: [], request_id: 'r1', usage: { credits: 0 } }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(calls[0]?.init.redirect).toBe('manual');
  });

  it('Firecrawl denies 301 redirect with POLICY_DENIED', async () => {
    const { fn } = createMockFetch(() => redirectResponse(301, 'https://evil.com/'));
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    try {
      await adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const e = err as ResearchProviderError;
      expect(e.code).toBe('POLICY_DENIED');
      expect(e.statusCode).toBe(301);
      expect(e.message).not.toContain('evil.com');
    }
  });

  it('Firecrawl uses redirect:manual in fetch options', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({
        success: true,
        data: { web: [] },
        id: 'job-1',
        creditsUsed: 0,
      }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(calls[0]?.init.redirect).toBe('manual');
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-055: Fixed provider origin (adapter-level)
// ---------------------------------------------------------------------------

describe('VAL-RES-055: adapter uses fixed provider origin', () => {
  it('Tavily sends request to exact fixed origin + path', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ results: [], request_id: 'r1', usage: { credits: 0 } }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(calls[0]?.url).toBe(`${TAVILY_ORIGIN}${PROVIDER_PATHS.tavily.search}`);
  });

  it('Firecrawl sends request to exact fixed origin + path', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, data: { web: [] }, id: 'j1', creditsUsed: 0 }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(calls[0]?.url).toBe(`${FIRECRAWL_ORIGIN}${PROVIDER_PATHS.firecrawl.search}`);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-048/049/050: Unsafe target URLs rejected by adapter
// ---------------------------------------------------------------------------

describe('VAL-CROSS-035: adapter rejects unsafe target URLs', () => {
  it('Tavily extract rejects http URL', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'extract', urls: ['http://example.com/page'], maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Tavily extract rejects localhost URL', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'extract', urls: ['https://localhost/page'], maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Tavily extract rejects private IP URL', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'extract', urls: ['https://10.0.0.1/page'], maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Tavily extract rejects metadata IP URL', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'extract',
          urls: ['https://169.254.169.254/path'],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Tavily extract rejects credentials in URL', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    try {
      await adapter.execute(
        {
          operation: 'extract',
          urls: [decodedUrl('aHR0cHM6Ly96eno6eXl5QGV4YW1wbGUuY29tL3BhZ2U=')],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const e = err as ResearchProviderError;
      expect(e.code).toBe('POLICY_DENIED');
      // Credential canary must not appear in error message
      expect(e.message).not.toContain('zzz');
      expect(e.message).not.toContain('yyy');
    }
  });

  it('Tavily extract rejects non-443 port', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'extract',
          urls: ['https://example.com:8080/page'],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Firecrawl scrape rejects http URL', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({ success: true, data: { markdown: 'text' } }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'scrape', urls: ['http://example.com/page'], maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Firecrawl scrape rejects localhost', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({ success: true, data: { markdown: 'text' } }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'scrape', urls: ['https://localhost/page'], maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Firecrawl scrape rejects private IP', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({ success: true, data: { markdown: 'text' } }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'scrape', urls: ['https://192.168.1.1/page'], maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Firecrawl structured_extract rejects localhost', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({ success: true, id: 'job-1', invalidURLs: [] }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'structured_extract',
          urls: ['https://localhost/page'],
          schema: { type: 'object', properties: { name: { type: 'string' } } },
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-054: Search-result URL validation (adapter-level)
// ---------------------------------------------------------------------------

describe('VAL-RES-054: adapter filters unsafe search results', () => {
  it('Tavily excludes unsafe search result URLs', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({
        results: [
          { title: 'Safe', url: 'https://example.com/safe', content: 'safe content', score: 0.9 },
          { title: 'Unsafe', url: 'http://localhost/evil', content: 'evil', score: 0.8 },
          { title: 'Private', url: 'https://10.0.0.1/secret', content: 'secret', score: 0.7 },
        ],
        request_id: 'r1',
        usage: { credits: 1 },
      }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 10, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].canonicalUrl).toBe('https://example.com/safe');
  });

  it('Firecrawl excludes unsafe search result URLs', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({
        success: true,
        data: {
          web: [
            { title: 'Safe', url: 'https://example.com/safe', markdown: 'safe' },
            { title: 'Unsafe', url: 'http://localhost/evil', markdown: 'evil' },
          ],
        },
        id: 'job-1',
        creditsUsed: 1,
      }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 10, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].canonicalUrl).toBe('https://example.com/safe');
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-108: Adapter enforces provider-mediated fetch (fail-closed)
// ---------------------------------------------------------------------------

describe('VAL-RES-108: adapter enforces provider-mediated fetch', () => {
  it('Tavily extract fails closed with PROVIDER_MEDIATED_FETCH_UNVERIFIED before dispatch', async () => {
    const { fn, calls } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    try {
      await adapter.execute(
        {
          operation: 'extract',
          urls: ['https://example.com/page'],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const e = err as ResearchProviderError;
      expect(e.code).toBe('PROVIDER_MEDIATED_FETCH_UNVERIFIED');
      // Provider must not be called
      expect(calls).toHaveLength(0);
    }
  });

  it('Firecrawl scrape fails closed with PROVIDER_MEDIATED_FETCH_UNVERIFIED before dispatch', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, data: { markdown: 'text' } }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    try {
      await adapter.execute(
        {
          operation: 'scrape',
          urls: ['https://example.com/page'],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const e = err as ResearchProviderError;
      expect(e.code).toBe('PROVIDER_MEDIATED_FETCH_UNVERIFIED');
      expect(calls).toHaveLength(0);
    }
  });

  it('Firecrawl structured_extract fails closed with PROVIDER_MEDIATED_FETCH_UNVERIFIED before dispatch', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, id: 'job-1', invalidURLs: [] }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    try {
      await adapter.execute(
        {
          operation: 'structured_extract',
          urls: ['https://example.com/page'],
          schema: { type: 'object', properties: { name: { type: 'string' } } },
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const e = err as ResearchProviderError;
      expect(e.code).toBe('PROVIDER_MEDIATED_FETCH_UNVERIFIED');
      expect(calls).toHaveLength(0);
    }
  });

  it('Tavily search still succeeds (search is not a mediated fetch)', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ results: [], request_id: 'r1', usage: { credits: 0 } }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.provider).toBe('tavily');
    expect(calls).toHaveLength(1);
  });

  it('Firecrawl search still succeeds (search is not a mediated fetch)', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, data: { web: [] }, id: 'job-1', creditsUsed: 0 }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.provider).toBe('firecrawl');
    expect(calls).toHaveLength(1);
  });

  it('Tavily extract validates target URL before mediated fetch check', async () => {
    const { fn, calls } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    // Unsafe URL is rejected by validateTargetUrl before mediated fetch check
    try {
      await adapter.execute(
        {
          operation: 'extract',
          urls: ['http://localhost/page'],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const e = err as ResearchProviderError;
      expect(e.code).toBe('POLICY_DENIED');
      expect(calls).toHaveLength(0);
    }
  });

  it('Firecrawl scrape validates target URL before mediated fetch check', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, data: { markdown: 'text' } }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    try {
      await adapter.execute(
        {
          operation: 'scrape',
          urls: ['http://localhost/page'],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      );
      expect.fail('Should have thrown');
    } catch (err) {
      const e = err as ResearchProviderError;
      expect(e.code).toBe('POLICY_DENIED');
      expect(calls).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-096: Sensitive query values denied (adapter-level)
// ---------------------------------------------------------------------------

describe('VAL-RES-096: adapter denies sensitive query in target URLs', () => {
  it('Tavily extract rejects URL with token query param', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ results: [], request_id: 'r1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'extract',
          urls: [decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlP3Rva2VuPXRlc3R2YWw=')],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });

  it('Firecrawl scrape rejects URL with api_key query param', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({ success: true, data: { markdown: 'text' } }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'scrape',
          urls: [decodedUrl('aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdlP2FwaV9rZXk9dGVzdHZhbA==')],
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toThrow(ResearchProviderError);
  });
});
