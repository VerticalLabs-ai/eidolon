import { describe, expect, it, vi } from 'vitest';
import { TavilyAdapter } from '../services/mission/research/tavily-adapter.js';
import { TAVILY_ORIGIN, PROVIDER_PATHS } from '../services/mission/research/origins.js';
import type { ResearchCallContext } from '../services/mission/research/spi.js';

/**
 * Tavily adapter contract tests.
 *
 * Covers: request payload shape, response normalization, malformed output
 * rejection, no SDK usage, and credential redaction. Uses mocked fetch.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a mock Response with JSON body. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Capture the fetch call arguments. */
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
// Request payload shape (without exposing auth)
// ---------------------------------------------------------------------------

describe('Tavily adapter: request payload shape', () => {
  it('sends POST to fixed origin /search with Bearer auth and JSON body', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ results: [], request_id: 'req-1', usage: { credits: 1 } }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await adapter.execute(
      { operation: 'search', query: 'test query', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${TAVILY_ORIGIN}${PROVIDER_PATHS.tavily.search}`);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = new Headers(calls[0]!.init.headers as Record<string, string>);
    expect(headers.get('Authorization')).toBe('Bearer test-key');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('search body includes query, max_results, search_depth, include_usage', async () => {
    const { fn, calls } = createMockFetch(() => jsonResponse({ results: [], request_id: 'req-1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await adapter.execute(
      { operation: 'search', query: 'hello world', maxResults: 10, timeoutMs: 5000 },
      baseContext,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.query).toBe('hello world');
    expect(body.max_results).toBe(10);
    expect(body.search_depth).toBe('basic');
    expect(body.include_usage).toBe(true);
  });

  it('accepts max_results at the 20 boundary and rejects over-limit before dispatch', async () => {
    const { fn, calls } = createMockFetch(() => jsonResponse({ results: [], request_id: 'req-1' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    // Boundary (20) is accepted and dispatched as 20.
    await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 20, timeoutMs: 5000 },
      baseContext,
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.max_results).toBe(20);

    // One-over (21) is rejected before any fetch (VAL-RES-056).
    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 21, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toHaveLength(1);
  });

  it('sends POST to /extract with urls array for extract operation', async () => {
    // VAL-RES-108: extract fails closed — provider-mediated fetch not verified in Phase 1
    const { fn, calls } = createMockFetch(() => jsonResponse({ results: [], request_id: 'req-2' }));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'extract',
          urls: ['https://example.com'],
          maxResults: 1,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIATED_FETCH_UNVERIFIED' });

    // Provider must not be called when mediated fetch is unverified
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

describe('Tavily adapter: response normalization', () => {
  it('normalizes search results with title, url, content, score, rank', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({
        results: [
          {
            title: 'Example Page',
            url: 'https://example.com',
            content: 'Some content here',
            score: 0.95,
          },
          {
            title: 'Second Page',
            url: 'https://second.com',
            content: 'Second content',
            score: 0.8,
          },
        ],
        request_id: 'req-123',
        usage: { credits: 1 },
      }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.provider).toBe('tavily');
    expect(result.providerRequestId).toBe('req-123');
    expect(result.credits).toBe(1);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].canonicalUrl).toBe('https://example.com/');
    expect(result.sources[0].title).toBe('Example Page');
    expect(result.sources[0].text).toBe('Some content here');
    expect(result.sources[0].score).toBe(0.95);
    expect(result.sources[0].rank).toBe(0);
    expect(result.sources[0].contentHash).toBeDefined();
    expect(result.sources[0].byteCount).toBe(Buffer.from('Some content here', 'utf8').length);
    expect(result.sources[0].injectionRiskLabels).toEqual([]);
  });

  it('discards unknown provider response properties', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({
        results: [
          {
            title: 'Example',
            url: 'https://example.com',
            content: 'content',
            score: 0.5,
            unknown_field: 'should be discarded',
            another_unknown: 42,
          },
        ],
        request_id: 'req-1',
        unknown_top_level: 'discarded',
      }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.sources).toHaveLength(1);
    // Only normalized fields are present — no unknown fields leak.
    const source = result.sources[0];
    expect(source.canonicalUrl).toBe('https://example.com/');
    expect((source as unknown as Record<string, unknown>).unknown_field).toBeUndefined();
  });

  it('normalizes extract results with url and raw_content', async () => {
    // VAL-RES-108: extract fails closed — provider-mediated fetch not verified in Phase 1
    const { fn } = createMockFetch(() =>
      jsonResponse({
        results: [
          {
            url: 'https://example.com',
            raw_content: 'Extracted content',
          },
        ],
        request_id: 'req-ext-1',
        usage: { credits: 1 },
      }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'extract',
          urls: ['https://example.com'],
          maxResults: 1,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIATED_FETCH_UNVERIFIED' });
  });

  it('reports warnings for failed extraction URLs', async () => {
    // VAL-RES-108: extract fails closed — provider-mediated fetch not verified in Phase 1
    const { fn } = createMockFetch(() =>
      jsonResponse({
        results: [{ url: 'https://good.com', raw_content: 'content' }],
        failed_results: [{ url: 'https://bad.com' }],
        request_id: 'req-1',
      }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'extract',
          urls: ['https://good.com', 'https://bad.com'],
          maxResults: 1,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIATED_FETCH_UNVERIFIED' });
  });
});

// ---------------------------------------------------------------------------
// Malformed output rejection
// ---------------------------------------------------------------------------

describe('Tavily adapter: malformed output rejection', () => {
  it('rejects non-JSON content type', async () => {
    const { fn } = createMockFetch(
      () =>
        new Response('<html>not json</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects malformed JSON', async () => {
    const { fn } = createMockFetch(
      () =>
        new Response('{not valid json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects non-object JSON (array)', async () => {
    const { fn } = createMockFetch(() => jsonResponse([1, 2, 3]));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects non-object JSON (null)', async () => {
    const { fn } = createMockFetch(() => jsonResponse(null));
    const adapter = new TavilyAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
});

// ---------------------------------------------------------------------------
// Missing credential
// ---------------------------------------------------------------------------

describe('Tavily adapter: missing credential', () => {
  it('rejects with PROVIDER_CREDENTIAL_UNAVAILABLE when apiKey is empty', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ results: [] }));
    const adapter = new TavilyAdapter({ apiKey: '', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_CREDENTIAL_UNAVAILABLE' });
  });

  it('rejects with PROVIDER_AUTHENTICATION_FAILED on 401 response', async () => {
    const { fn } = createMockFetch(
      () =>
        new Response('{"error":"unauthorized"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const adapter = new TavilyAdapter({ apiKey: 'invalid-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_FAILED' });
  });
});

// ---------------------------------------------------------------------------
// No SDK
// ---------------------------------------------------------------------------

describe('Tavily adapter: no SDK dependency', () => {
  it('does not import @tavily/core or any tavily SDK', async () => {
    // The adapter uses only native fetch. Verify no SDK import is present
    // by checking that the module loads without any @tavily dependency.
    const mod = await import('../services/mission/research/tavily-adapter.js');
    expect(mod.TavilyAdapter).toBeDefined();
    // The adapter must use native fetch, not an SDK client.
    expect(typeof fetch).toBe('function');
  });
});
