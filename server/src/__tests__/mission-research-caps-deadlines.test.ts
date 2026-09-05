import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ReadableStream } from 'node:stream/web';
import { createHash } from 'node:crypto';
import { TavilyAdapter } from '../services/mission/research/tavily-adapter.js';
import {
  validateResearchRequest,
  MAX_QUERY_CODEPOINTS,
  MAX_RESULTS,
  MAX_URL_BATCH,
} from '../services/mission/research/request-validation.js';
import {
  readBoundedResponseBody,
  MAX_RESPONSE_BYTES,
} from '../services/mission/research/bounded-body-reader.js';
import {
  defaultDeadlineForOperation,
  createOperationDeadline,
  DEFAULT_SEARCH_DEADLINE_MS,
  DEFAULT_EXTRACT_DEADLINE_MS,
} from '../services/mission/research/operation-deadline.js';
import {
  AggregateOutputCounter,
  selectSourcesWithinAggregateCap,
  DEFAULT_AGGREGATE_OUTPUT_CAP_BYTES,
} from '../services/mission/research/aggregate-output-cap.js';
import {
  normalizeSourceForPersistence,
  MAX_NORMALIZED_TEXT_BYTES,
} from '../services/mission/research/source-normalization.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Caps and deadlines for research (feature m5-f10).
 *
 * Covers VAL-RES-056 (query/result caps), VAL-RES-057 (provider response
 * body cap), VAL-RES-058 (normalized source cap with truncation metadata),
 * VAL-RES-059 (aggregate output cap), VAL-RES-060 (operation deadline),
 * and VAL-RES-093 (decoded streaming bodies bounded).
 *
 * Exact-boundary research succeeds; one-over query/result/body/source/output
 * or elapsed deadline aborts before partial persistence. Tests exercise
 * decoded chunked bodies, declared sizes, query/result counts, normalized/
 * aggregate bytes, and deterministic clocks.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Repeat a code point n times to build a string of exactly n code points. */
function repeatCodePoints(cp: string, n: number): string {
  return cp.repeat(n);
}

/** Build a NormalizedResearchSource with given text. */
function sourceWith(text: string, url = 'https://example.com/'): NormalizedResearchSource {
  return {
    canonicalUrl: url,
    retrievedAt: '2026-08-24T00:00:00.000Z',
    text,
    injectionRiskLabels: [],
  };
}

/** Build a mock Response whose body is a ReadableStream of UTF-8 chunks. */
function streamingResponse(
  chunks: string[],
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

/** Build a mock Response whose stream emits chunks then stalls (never closes). */
function stallingResponse(
  chunksBeforeStall: string[],
  init?: { status?: number; headers?: Record<string, string> },
): { response: Response; release: () => void } {
  const encoder = new TextEncoder();
  let releaseFn: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunksBeforeStall) {
        controller.enqueue(encoder.encode(chunk));
      }
      // Stall: never close until released.
      releaseFn = () => {
        try {
          controller.close();
        } catch {
          /* already closed/cancelled */
        }
      };
    },
  });
  return {
    response: new Response(stream, {
      status: init?.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    }),
    release: () => releaseFn?.(),
  };
}

/** A fetch responder that returns a fixed Response. */
function fixedFetchResponder(response: Response) {
  const calls: Array<{ url: string | URL | Request; init: RequestInit }> = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return response;
  });
  return { fn, calls };
}

const baseContext = {};

// ---------------------------------------------------------------------------
// VAL-RES-056: Query and result caps
// ---------------------------------------------------------------------------

describe('VAL-RES-056: query and result caps (shared validation)', () => {
  const supports = (op: string) => op === 'search' || op === 'extract';

  it('accepts a query at exactly 4,000 code points', () => {
    const result = validateResearchRequest(
      {
        operation: 'search',
        query: repeatCodePoints('a', MAX_QUERY_CODEPOINTS),
        maxResults: 10,
        timeoutMs: 5000,
      },
      supports,
      'tavily',
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a query one code point over 4,000', () => {
    const result = validateResearchRequest(
      {
        operation: 'search',
        query: repeatCodePoints('a', MAX_QUERY_CODEPOINTS + 1),
        maxResults: 10,
        timeoutMs: 5000,
      },
      supports,
      'tavily',
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_REQUEST');
  });

  it('counts Unicode code points, not UTF-16 code units', () => {
    // '😀' is 1 code point but 2 UTF-16 code units.
    const query = repeatCodePoints('😀', MAX_QUERY_CODEPOINTS);
    expect([...query].length).toBe(MAX_QUERY_CODEPOINTS);
    expect(query.length).toBe(MAX_QUERY_CODEPOINTS * 2);
    const result = validateResearchRequest(
      { operation: 'search', query, maxResults: 10, timeoutMs: 5000 },
      supports,
      'tavily',
    );
    expect(result.ok).toBe(true);
  });

  it('accepts maxResults at exactly 20 and rejects 21', () => {
    expect(
      validateResearchRequest(
        { operation: 'search', query: 'q', maxResults: MAX_RESULTS, timeoutMs: 5000 },
        supports,
        'tavily',
      ).ok,
    ).toBe(true);
    expect(
      validateResearchRequest(
        { operation: 'search', query: 'q', maxResults: MAX_RESULTS + 1, timeoutMs: 5000 },
        supports,
        'tavily',
      ).ok,
    ).toBe(false);
  });

  it('rejects maxResults below 1', () => {
    const result = validateResearchRequest(
      { operation: 'search', query: 'q', maxResults: 0, timeoutMs: 5000 },
      supports,
      'tavily',
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_REQUEST');
  });

  it('accepts a URL batch at exactly 20 and rejects 21', () => {
    const urls = Array.from({ length: MAX_URL_BATCH }, (_, i) => `https://example.com/${i}`);
    expect(
      validateResearchRequest(
        { operation: 'extract', urls, maxResults: 1, timeoutMs: 5000 },
        supports,
        'tavily',
      ).ok,
    ).toBe(true);
    const over = [...urls, 'https://example.com/extra'];
    expect(
      validateResearchRequest(
        { operation: 'extract', urls: over, maxResults: 1, timeoutMs: 5000 },
        supports,
        'tavily',
      ).ok,
    ).toBe(false);
  });

  it('rejects a non-finite timeout', () => {
    const result = validateResearchRequest(
      { operation: 'search', query: 'q', maxResults: 10, timeoutMs: Number.POSITIVE_INFINITY },
      supports,
      'tavily',
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('INVALID_REQUEST');
  });

  it('rejects an unsupported operation', () => {
    const result = validateResearchRequest(
      { operation: 'scrape', urls: ['https://example.com'], maxResults: 1, timeoutMs: 5000 },
      supports,
      'tavily',
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('UNSUPPORTED_OPERATION');
  });

  it('adapter rejects an oversized query before any fetch (no dispatch)', async () => {
    const { fn, calls } = fixedFetchResponder(
      streamingResponse(['{"results":[],"request_id":"r"}']),
    );
    const adapter = new TavilyAdapter({ apiKey: 'k', fetch: fn });
    await expect(
      adapter.execute(
        {
          operation: 'search',
          query: repeatCodePoints('a', MAX_QUERY_CODEPOINTS + 1),
          maxResults: 5,
          timeoutMs: 5000,
        },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toHaveLength(0);
  });

  it('adapter rejects maxResults over 20 before any fetch (no silent dispatch)', async () => {
    const { fn, calls } = fixedFetchResponder(
      streamingResponse(['{"results":[],"request_id":"r"}']),
    );
    const adapter = new TavilyAdapter({ apiKey: 'k', fetch: fn });
    await expect(
      adapter.execute(
        { operation: 'search', query: 'q', maxResults: 21, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(calls).toHaveLength(0);
  });

  it('adapter accepts exact-boundary query and maxResults and succeeds', async () => {
    const { fn } = fixedFetchResponder(
      streamingResponse([
        '{"results":[{"url":"https://example.com","content":"x"}],"request_id":"r"}',
      ]),
    );
    const adapter = new TavilyAdapter({ apiKey: 'k', fetch: fn });
    const result = await adapter.execute(
      {
        operation: 'search',
        query: repeatCodePoints('a', MAX_QUERY_CODEPOINTS),
        maxResults: 20,
        timeoutMs: 5000,
      },
      baseContext,
    );
    expect(result.sources).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-057: Provider response body cap (5 MiB)
// ---------------------------------------------------------------------------

describe('VAL-RES-057: provider response body cap (5 MiB)', () => {
  it('readBoundedResponseBody aborts when decoded body exceeds 5 MiB', async () => {
    // One chunk of 5 MiB + 1 byte over the cap.
    const over = 'x'.repeat(MAX_RESPONSE_BYTES + 1);
    const response = streamingResponse([over]);
    await expect(readBoundedResponseBody(response, 'search', 'tavily')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('readBoundedResponseBody aborts a chunked body without Content-Length', async () => {
    // Many small chunks totaling > 5 MiB, no Content-Length header.
    const chunk = 'x'.repeat(64 * 1024);
    const chunks: string[] = [];
    for (let i = 0; i <= Math.ceil(MAX_RESPONSE_BYTES / chunk.length) + 1; i++) {
      chunks.push(chunk);
    }
    const response = streamingResponse(chunks, { headers: {} });
    // Remove content-type to ensure no Content-Length dependency; keep JSON type.
    response.headers.delete('content-length');
    await expect(readBoundedResponseBody(response, 'search', 'tavily')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });

  it('readBoundedResponseBody accepts a body at exactly 5 MiB', async () => {
    const exact = 'x'.repeat(MAX_RESPONSE_BYTES);
    const response = streamingResponse([exact]);
    const text = await readBoundedResponseBody(response, 'search', 'tavily');
    expect(Buffer.byteLength(text, 'utf8')).toBe(MAX_RESPONSE_BYTES);
  });

  it('adapter aborts an oversized provider response and persists no sources', async () => {
    const huge = 'x'.repeat(MAX_RESPONSE_BYTES + 1024);
    // Wrap as a JSON-shaped string so it parses but is far over the cap.
    // readBoundedResponseBody aborts before JSON.parse runs.
    const body = `{"results":[],"big":"${huge}"}`;
    const response = streamingResponse([body]);
    const { fn } = fixedFetchResponder(response);
    const adapter = new TavilyAdapter({ apiKey: 'k', fetch: fn });
    await expect(
      adapter.execute(
        { operation: 'search', query: 'q', maxResults: 5, timeoutMs: 5000 },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-093: Decoded streaming bodies are bounded
// ---------------------------------------------------------------------------

describe('VAL-RES-093: decoded streaming bodies are bounded', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts a header-then-stall response at the deadline, persisting no partial body', async () => {
    // A small header chunk, then the stream stalls (never closes).
    const { response } = stallingResponse(['{"partial":']);
    const { fn } = fixedFetchResponder(response);
    const adapter = new TavilyAdapter({ apiKey: 'k', fetch: fn });

    // Use a short, deterministic deadline (search default scaled down via timeoutMs).
    const exec = adapter.execute(
      { operation: 'search', query: 'q', maxResults: 5, timeoutMs: 50 },
      baseContext,
    );
    // Attach the rejection handler before advancing timers to avoid an
    // unhandled rejection between timer flush and assertion.
    const assertion = expect(exec).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    // Advance fake timers past the deadline (50ms) plus tolerance.
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
  });

  it('aborts decoded chunked data above 5 MiB without persisting a partial body', async () => {
    // Emulate decoded (decompressed) chunks totaling > 5 MiB.
    const chunk = 'y'.repeat(256 * 1024);
    const chunks: string[] = [];
    for (let i = 0; i < Math.ceil(MAX_RESPONSE_BYTES / chunk.length) + 2; i++) {
      chunks.push(chunk);
    }
    const response = streamingResponse(chunks);
    await expect(readBoundedResponseBody(response, 'scrape', 'firecrawl')).rejects.toMatchObject({
      code: 'MALFORMED_RESPONSE',
    });
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-058: Normalized source cap (1 MiB) with truncation metadata
// ---------------------------------------------------------------------------

describe('VAL-RES-058: normalized source cap (1 MiB) with truncation metadata', () => {
  it('bounds normalized text to at most 1 MiB UTF-8 bytes', () => {
    const big = 'x'.repeat(MAX_NORMALIZED_TEXT_BYTES + 4096);
    const rec = normalizeSourceForPersistence(sourceWith(big));
    expect(rec.byteCount).toBeLessThanOrEqual(MAX_NORMALIZED_TEXT_BYTES);
    expect(Buffer.byteLength(rec.normalizedText ?? '', 'utf8')).toBeLessThanOrEqual(
      MAX_NORMALIZED_TEXT_BYTES,
    );
  });

  it('records truncated=true when text was truncated', () => {
    const big = 'x'.repeat(MAX_NORMALIZED_TEXT_BYTES + 1);
    const rec = normalizeSourceForPersistence(sourceWith(big));
    expect(rec.truncated).toBe(true);
  });

  it('records truncated=false for text within the cap', () => {
    const rec = normalizeSourceForPersistence(sourceWith('small text'));
    expect(rec.truncated).toBe(false);
  });

  it('records truncated=false at exactly the 1 MiB boundary', () => {
    const exact = 'x'.repeat(MAX_NORMALIZED_TEXT_BYTES);
    const rec = normalizeSourceForPersistence(sourceWith(exact));
    expect(rec.byteCount).toBe(MAX_NORMALIZED_TEXT_BYTES);
    expect(rec.truncated).toBe(false);
  });

  it('content hash is computed over the bounded (truncated) text, not the original', () => {
    const big = 'x'.repeat(MAX_NORMALIZED_TEXT_BYTES + 10);
    const rec = normalizeSourceForPersistence(sourceWith(big));
    const expectedHash = createHash('sha256')
      .update(rec.normalizedText ?? '', 'utf8')
      .digest('hex');
    expect(rec.contentHash).toBe(expectedHash);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-059: Aggregate output cap
// ---------------------------------------------------------------------------

describe('VAL-RES-059: aggregate output cap', () => {
  it('default aggregate cap is 10 MiB', () => {
    expect(DEFAULT_AGGREGATE_OUTPUT_CAP_BYTES).toBe(10 * 1024 * 1024);
  });

  it('stops accepting output once the snapshotted cap is reached', () => {
    const counter = new AggregateOutputCounter(DEFAULT_AGGREGATE_OUTPUT_CAP_BYTES);
    const sourceBytes = 2 * 1024 * 1024; // 2 MiB each
    let added = 0;
    for (let i = 0; i < 10; i++) {
      if (counter.tryAdd(sourceBytes)) {
        added++;
      }
    }
    // 10 MiB / 2 MiB = 5 accepted; the 6th would exceed.
    expect(added).toBe(5);
    expect(counter.totalBytes).toBe(DEFAULT_AGGREGATE_OUTPUT_CAP_BYTES);
    expect(counter.wouldExceed(sourceBytes)).toBe(true);
  });

  it('selectSourcesWithinAggregateCap accepts sources up to the cap and excludes the rest', () => {
    const cap = 3 * 1024 * 1024;
    const sources: NormalizedResearchSource[] = [
      sourceWith('a'.repeat(1024 * 1024)),
      sourceWith('b'.repeat(1024 * 1024)),
      sourceWith('c'.repeat(1024 * 1024)),
      sourceWith('d'.repeat(1024 * 1024)), // over cap
    ];
    const { accepted, excluded, totalBytes } = selectSourcesWithinAggregateCap(sources, cap);
    expect(accepted).toHaveLength(3);
    expect(excluded).toHaveLength(1);
    expect(totalBytes).toBeLessThanOrEqual(cap);
  });

  it('never exceeds the counter even with many small sources', () => {
    const cap = 1024;
    const counter = new AggregateOutputCounter(cap);
    let total = 0;
    for (let i = 0; i < 2000; i++) {
      if (counter.tryAdd(10)) {
        total += 10;
      }
    }
    expect(total).toBeLessThanOrEqual(cap);
    expect(counter.totalBytes).toBeLessThanOrEqual(cap);
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-060: Operation deadline
// ---------------------------------------------------------------------------

describe('VAL-RES-060: operation deadline', () => {
  it('search default deadline is 15s, extract/scrape is 30s', () => {
    expect(DEFAULT_SEARCH_DEADLINE_MS).toBe(15_000);
    expect(DEFAULT_EXTRACT_DEADLINE_MS).toBe(30_000);
    expect(defaultDeadlineForOperation('search')).toBe(15_000);
    expect(defaultDeadlineForOperation('extract')).toBe(30_000);
    expect(defaultDeadlineForOperation('scrape')).toBe(30_000);
    expect(defaultDeadlineForOperation('structured_extract')).toBe(30_000);
  });

  it('deadline is the minimum of timeout, default, and remaining run time', () => {
    // timeout below default → timeout wins.
    const d = createOperationDeadline('search', 5_000, 60_000);
    expect(d.deadlineMs).toBe(5_000);
    d.clear();
    // remaining run time below timeout → remaining wins.
    const d2 = createOperationDeadline('search', 30_000, 3_000);
    expect(d2.deadlineMs).toBe(3_000);
    d2.clear();
    // default below timeout and no remaining → default wins.
    const d3 = createOperationDeadline('search', 60_000);
    expect(d3.deadlineMs).toBe(15_000);
    d3.clear();
  });

  it('deadline aborts a stalled operation within tolerance (deterministic clock)', async () => {
    vi.useFakeTimers();
    try {
      const deadline = createOperationDeadline('search', 100);
      const { response } = stallingResponse(['{"partial":']);
      const { fn } = fixedFetchResponder(response);
      const adapter = new TavilyAdapter({
        apiKey: 'k',
        fetch: fn,
        deadlineSignal: deadline.signal,
      });
      const exec = adapter.execute(
        { operation: 'search', query: 'q', maxResults: 5, timeoutMs: 100 },
        baseContext,
      );
      const assertion = expect(exec).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(2000);
      await assertion;
      deadline.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('extract deadline (30s) is longer than search (15s) and both cover full operation', () => {
    const search = createOperationDeadline('search', 60_000);
    const extract = createOperationDeadline('extract', 60_000);
    expect(extract.deadlineMs).toBeGreaterThan(search.deadlineMs);
    search.clear();
    extract.clear();
  });
});
