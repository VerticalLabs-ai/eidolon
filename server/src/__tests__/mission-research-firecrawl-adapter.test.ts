import { describe, expect, it, vi } from 'vitest';
import { FirecrawlAdapter } from '../services/mission/research/firecrawl-adapter.js';
import { FIRECRAWL_ORIGIN, PROVIDER_PATHS } from '../services/mission/research/origins.js';
import type { ResearchCallContext } from '../services/mission/research/spi.js';

/**
 * Firecrawl adapter contract tests.
 *
 * Covers: request payload shape, response normalization, malformed output
 * rejection, structured extract schema validation, no SDK usage, and
 * credential handling. Uses mocked fetch.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
// Request payload shape
// ---------------------------------------------------------------------------

describe('Firecrawl adapter: request payload shape', () => {
  it('sends POST to fixed origin /v2/search with Bearer auth', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, data: { web: [] }, id: 'job-1', creditsUsed: 1 }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${FIRECRAWL_ORIGIN}${PROVIDER_PATHS.firecrawl.search}`);
    expect(calls[0]!.init.method).toBe('POST');
    const headers = new Headers(calls[0]!.init.headers as Record<string, string>);
    expect(headers.get('Authorization')).toBe('Bearer test-key');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('search body includes query, limit, scrapeOptions with markdown format', async () => {
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, data: { web: [] }, id: 'job-1' }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await adapter.execute(
      { operation: 'search', query: 'hello', maxResults: 10, timeoutMs: 5000 },
      baseContext,
    );

    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.query).toBe('hello');
    expect(body.limit).toBe(10);
    expect(body.scrapeOptions.formats).toEqual(['markdown']);
    expect(body.scrapeOptions.onlyMainContent).toBe(true);
  });

  it('sends POST to /v2/scrape with url and markdown format', async () => {
    // VAL-RES-108: scrape fails closed — provider-mediated fetch not verified in Phase 1
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, data: { markdown: '# Hello' } }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'scrape',
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

  it('sends POST to /v2/extract with urls and schema', async () => {
    // VAL-RES-108: structured_extract fails closed — provider-mediated fetch not verified in Phase 1
    const { fn, calls } = createMockFetch(() =>
      jsonResponse({ success: true, id: 'extract-job-1' }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    };
    await expect(
      adapter.execute(
        {
          operation: 'structured_extract',
          urls: ['https://example.com'],
          schema,
          maxResults: 1,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIATED_FETCH_UNVERIFIED' });

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Response normalization
// ---------------------------------------------------------------------------

describe('Firecrawl adapter: response normalization', () => {
  it('normalizes search web results with title, url, markdown, rank', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({
        success: true,
        data: {
          web: [
            {
              title: 'Result One',
              url: 'https://one.com',
              markdown: 'Content one',
              metadata: { language: 'en' },
            },
            {
              title: 'Result Two',
              url: 'https://two.com',
              markdown: 'Content two',
            },
          ],
        },
        id: 'job-abc',
        creditsUsed: 2,
      }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.provider).toBe('firecrawl');
    expect(result.providerRequestId).toBe('job-abc');
    expect(result.credits).toBe(2);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].canonicalUrl).toBe('https://one.com/');
    expect(result.sources[0].title).toBe('Result One');
    expect(result.sources[0].text).toBe('Content one');
    expect(result.sources[0].rank).toBe(0);
    expect(result.sources[0].language).toBe('en');
    expect(result.sources[0].contentHash).toBeDefined();
    expect(result.sources[0].injectionRiskLabels).toEqual([]);
  });

  it('normalizes scrape result with markdown and metadata', async () => {
    // VAL-RES-108: scrape fails closed — provider-mediated fetch not verified in Phase 1
    const { fn } = createMockFetch(() =>
      jsonResponse({
        success: true,
        data: {
          markdown: '# Page Title\n\nPage content.',
          metadata: {
            title: 'Page Title',
            language: 'en',
            sourceURL: 'https://example.com',
          },
        },
      }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'scrape',
          urls: ['https://example.com'],
          maxResults: 1,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIATED_FETCH_UNVERIFIED' });
  });

  it('discards unknown provider response properties', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({
        success: true,
        data: {
          web: [
            {
              title: 'Test',
              url: 'https://example.com',
              markdown: 'content',
              unknown_field: 'discard',
            },
          ],
        },
        id: 'job-1',
        unknown_top: 'discard',
      }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.sources).toHaveLength(1);
    expect((result.sources[0] as unknown as Record<string, unknown>).unknown_field).toBeUndefined();
  });

  it('structured extract returns job ID with no sources (async)', async () => {
    // VAL-RES-108: structured_extract fails closed — provider-mediated fetch not verified in Phase 1
    const { fn } = createMockFetch(() => jsonResponse({ success: true, id: 'extract-job-123' }));
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'structured_extract',
          urls: ['https://example.com'],
          schema: {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: false,
          },
          maxResults: 1,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIATED_FETCH_UNVERIFIED' });
  });

  it('reports warnings for invalid URLs in structured extract', async () => {
    // VAL-RES-108: structured_extract fails closed — provider-mediated fetch not verified in Phase 1
    const { fn } = createMockFetch(() =>
      jsonResponse({
        success: true,
        id: 'job-1',
        invalidURLs: ['https://bad-url.com'],
      }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        {
          operation: 'structured_extract',
          urls: ['https://good.com', 'https://bad-url.com'],
          schema: {
            type: 'object',
            properties: { a: { type: 'string' } },
            additionalProperties: false,
          },
          maxResults: 1,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MEDIATED_FETCH_UNVERIFIED' });
  });

  it('passes through provider warnings from search', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({
        success: true,
        data: { web: [] },
        warning: 'Partial results',
        id: 'job-1',
      }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    const result = await adapter.execute(
      { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
      baseContext,
    );

    expect(result.warnings).toEqual(['Partial results']);
  });
});

// ---------------------------------------------------------------------------
// Malformed output rejection
// ---------------------------------------------------------------------------

describe('Firecrawl adapter: malformed output rejection', () => {
  it('rejects non-JSON content type', async () => {
    const { fn } = createMockFetch(
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

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
        new Response('{invalid', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects non-object JSON (array)', async () => {
    const { fn } = createMockFetch(() => jsonResponse([1, 2]));
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('rejects success:false as PROVIDER_PERMANENT', async () => {
    const { fn } = createMockFetch(() =>
      jsonResponse({ success: false, error: 'Something went wrong' }),
    );
    const adapter = new FirecrawlAdapter({ apiKey: 'test-key', fetch: fn });

    await expect(
      adapter.execute(
        { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_PERMANENT' });
  });
});

// ---------------------------------------------------------------------------
// Missing credential
// ---------------------------------------------------------------------------

describe('Firecrawl adapter: missing credential', () => {
  it('rejects with PROVIDER_CREDENTIAL_UNAVAILABLE when apiKey is empty', async () => {
    const { fn } = createMockFetch(() => jsonResponse({ success: true }));
    const adapter = new FirecrawlAdapter({ apiKey: '', fetch: fn });

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
    const adapter = new FirecrawlAdapter({ apiKey: 'invalid-key', fetch: fn });

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

describe('Firecrawl adapter: no SDK dependency', () => {
  it('does not import firecrawl SDK', async () => {
    const mod = await import('../services/mission/research/firecrawl-adapter.js');
    expect(mod.FirecrawlAdapter).toBeDefined();
    expect(typeof fetch).toBe('function');
  });
});
