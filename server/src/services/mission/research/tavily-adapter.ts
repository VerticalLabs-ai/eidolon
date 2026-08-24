/**
 * Tavily native-fetch research adapter.
 *
 * (architecture.md: Tavily Adapter, VAL-RES-006)
 *
 * Uses native `fetch`, server-side credentials, fixed origin
 * `https://api.tavily.com`, and an explicit allowlist of versioned
 * search/extract paths. Tavily is preferred for relevance-ranked search
 * and targeted extraction.
 *
 * Official documentation consulted at implementation time:
 * - Search: https://docs.tavily.com/documentation/api-reference/endpoint/search
 *   (accessed 2026-08-24)
 * - Extract: https://docs.tavily.com/documentation/api-reference/endpoint/extract
 *   (accessed 2026-08-24)
 *
 * Key documented contract facts:
 * - Auth: `Authorization: Bearer <token>` header.
 * - Search body: `query` (required), `max_results` (0–20), `search_depth`,
 *   `topic`, `include_answer`, `include_raw_content`, `include_usage`.
 * - Search response: `query`, `answer`, `results[]` (title, url, content,
 *   score, raw_content, favicon, id), `response_time`, `usage` {credits},
 *   `request_id`.
 * - Extract body: `urls` (string or array, max 20), `query`, `extract_depth`,
 *   `format` (markdown/text), `timeout` (1–60s), `include_usage`.
 * - Extract response: `results[]` (url, raw_content, images, favicon),
 *   `failed_results[]`, `response_time`, `usage` {credits}, `request_id`.
 * - Errors: 400, 401, 429, 432 (plan limit), 433 (payg limit), 500.
 *
 * Adapters never write artifacts or invoke tools. Unknown response
 * properties are discarded, not persisted.
 */

import { createHash, randomUUID } from 'node:crypto';
import { TAVILY_ORIGIN, PROVIDER_PATHS } from './origins.js';
import {
  type ResearchProvider,
  type ResearchRequest,
  type ResearchResult,
  type ResearchCallContext,
  type NormalizedResearchSource,
  type ResearchOperation,
  type FetchFn,
  ResearchProviderError,
} from './spi.js';
import { isOperationSupported, getUnsupportedOperationError } from './operations.js';

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export interface TavilyAdapterConfig {
  /** Tavily API key (resolved server-side, never logged). */
  apiKey: string;
  /**
   * Injectable fetch function for deterministic tests. Production uses
   * the global `fetch`. Tests may inject a mock but cannot override the
   * fixed origin or disable policy.
   */
  fetch?: FetchFn;
}

// ---------------------------------------------------------------------------
// Response type fragments (only the fields we normalize)
// ---------------------------------------------------------------------------

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
  id?: string;
}

interface TavilySearchResponse {
  query?: string;
  results?: TavilySearchResult[];
  response_time?: number;
  usage?: { credits?: number };
  request_id?: string;
}

interface TavilyExtractResult {
  url?: string;
  raw_content?: string;
  favicon?: string;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: Array<{ url?: string }>;
  response_time?: number;
  usage?: { credits?: number };
  request_id?: string;
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

/** Normalize text: trim, collapse whitespace, NFC. */
function normalizeText(text: string | undefined): string | undefined {
  if (!text || typeof text !== 'string') {
    return undefined;
  }
  return text.normalize('NFC').trim();
}

/** Compute SHA-256 content hash (lowercase hex). */
function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Cap text at 1 MiB. */
const MAX_SOURCE_BYTES = 1024 * 1024;

function capText(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_SOURCE_BYTES) {
    return text;
  }
  return buf.subarray(0, MAX_SOURCE_BYTES).toString('utf8');
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class TavilyAdapter implements ResearchProvider {
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(config: TavilyAdapterConfig) {
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  supports(operation: ResearchOperation): boolean {
    return isOperationSupported('tavily', operation);
  }

  async execute(request: ResearchRequest, context: ResearchCallContext): Promise<ResearchResult> {
    // 1. Capability check — fail before any provider call (VAL-RES-006).
    if (!this.supports(request.operation)) {
      throw getUnsupportedOperationError('tavily', request.operation);
    }

    // 2. Credential check.
    if (!this.apiKey) {
      throw new ResearchProviderError(
        'MISSING_CREDENTIAL',
        'Tavily API key is not configured',
        'tavily',
        request.operation,
      );
    }

    // 3. Dispatch to the operation handler.
    switch (request.operation) {
      case 'search':
        return this.executeSearch(request, context);
      case 'extract':
        return this.executeExtract(request, context);
      default:
        // Unreachable — capability check above already rejected this.
        throw getUnsupportedOperationError('tavily', request.operation);
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  private async executeSearch(
    request: ResearchRequest,
    context: ResearchCallContext,
  ): Promise<ResearchResult> {
    const query = request.query;
    if (!query || query.trim().length === 0) {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Search operation requires a non-empty query',
        'tavily',
        'search',
      );
    }

    const maxResults = Math.min(Math.max(1, request.maxResults), 20);
    const body = {
      query,
      max_results: maxResults,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      include_usage: true,
    };

    const response = await this.doFetch(
      PROVIDER_PATHS.tavily.search,
      body,
      request.timeoutMs,
      context,
    );
    const data = await this.parseResponse<TavilySearchResponse>(response);

    const sources: NormalizedResearchSource[] = [];
    const results = Array.isArray(data.results) ? data.results : [];
    for (let i = 0; i < results.length && i < maxResults; i++) {
      const result = results[i];
      const text = normalizeText(result.content);
      if (!result.url) {
        continue;
      }
      sources.push({
        canonicalUrl: result.url,
        title: normalizeText(result.title),
        retrievedAt: new Date().toISOString(),
        rank: i,
        score: typeof result.score === 'number' ? result.score : undefined,
        text: text ? capText(text) : undefined,
        contentHash: text ? hashContent(capText(text)) : undefined,
        byteCount: text ? Buffer.from(capText(text), 'utf8').length : undefined,
        injectionRiskLabels: [],
      });
    }

    return {
      logicalCallId: context.logicalCallId ?? randomUUID(),
      provider: 'tavily',
      providerRequestId: data.request_id,
      credits: data.usage?.credits,
      sources,
      warnings: [],
    };
  }

  // -------------------------------------------------------------------------
  // Extract (targeted text extraction from URLs)
  // -------------------------------------------------------------------------

  private async executeExtract(
    request: ResearchRequest,
    context: ResearchCallContext,
  ): Promise<ResearchResult> {
    const urls = request.urls;
    if (!urls || urls.length === 0) {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Extract operation requires at least one URL',
        'tavily',
        'extract',
      );
    }
    if (urls.length > 20) {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Extract operation supports at most 20 URLs',
        'tavily',
        'extract',
      );
    }

    const body = {
      urls,
      format: 'markdown',
      extract_depth: 'basic',
      include_usage: true,
      ...(request.query ? { query: request.query } : {}),
    };

    const response = await this.doFetch(
      PROVIDER_PATHS.tavily.extract,
      body,
      request.timeoutMs,
      context,
    );
    const data = await this.parseResponse<TavilyExtractResponse>(response);

    const sources: NormalizedResearchSource[] = [];
    const results = Array.isArray(data.results) ? data.results : [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const text = normalizeText(result.raw_content);
      if (!result.url) {
        continue;
      }
      sources.push({
        canonicalUrl: result.url,
        retrievedAt: new Date().toISOString(),
        rank: i,
        text: text ? capText(text) : undefined,
        contentHash: text ? hashContent(capText(text)) : undefined,
        byteCount: text ? Buffer.from(capText(text), 'utf8').length : undefined,
        injectionRiskLabels: [],
      });
    }

    const warnings: string[] = [];
    const failed = Array.isArray(data.failed_results) ? data.failed_results : [];
    if (failed.length > 0) {
      warnings.push(`${failed.length} URL(s) failed extraction`);
    }

    return {
      logicalCallId: context.logicalCallId ?? randomUUID(),
      provider: 'tavily',
      providerRequestId: data.request_id,
      credits: data.usage?.credits,
      sources,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // HTTP execution (bounded, abortable)
  // -------------------------------------------------------------------------

  private async doFetch(
    path: string,
    body: Record<string, unknown>,
    timeoutMs: number,
    context: ResearchCallContext,
  ): Promise<Response> {
    const url = `${TAVILY_ORIGIN}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 30_000));

    // Combine caller signal with timeout signal.
    if (context.signal) {
      if (context.signal.aborted) {
        clearTimeout(timeout);
        throw new ResearchProviderError(
          'CANCELLED',
          'Research call cancelled before dispatch',
          'tavily',
          'search',
        );
      }
      context.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 401) {
        throw new ResearchProviderError(
          'MISSING_CREDENTIAL',
          'Tavily authentication failed',
          'tavily',
          'search',
          401,
        );
      }
      if (response.status === 429) {
        throw new ResearchProviderError(
          'PROVIDER_RATE_LIMITED',
          'Tavily rate limit exceeded',
          'tavily',
          'search',
          429,
        );
      }
      if (response.status === 432 || response.status === 433) {
        throw new ResearchProviderError(
          'PROVIDER_QUOTA_EXCEEDED',
          'Tavily quota exceeded',
          'tavily',
          'search',
          response.status,
        );
      }
      if (response.status >= 500) {
        throw new ResearchProviderError(
          'PROVIDER_TRANSIENT',
          'Tavily server error',
          'tavily',
          'search',
          response.status,
        );
      }
      if (response.status >= 400) {
        throw new ResearchProviderError(
          'PROVIDER_PERMANENT',
          'Tavily request rejected',
          'tavily',
          'search',
          response.status,
        );
      }

      return response;
    } catch (err) {
      if (err instanceof ResearchProviderError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ResearchProviderError(
          'PROVIDER_TIMEOUT',
          'Tavily request timed out or was aborted',
          'tavily',
          'search',
        );
      }
      // Network error.
      throw new ResearchProviderError(
        'PROVIDER_TRANSIENT',
        'Tavily network error',
        'tavily',
        'search',
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // -------------------------------------------------------------------------
  // Response parsing (bounded, schema-validated)
  // -------------------------------------------------------------------------

  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Tavily returned non-JSON content type',
        'tavily',
        'search',
      );
    }

    // Cap response body at 5 MiB.
    const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Tavily response exceeds maximum size',
        'tavily',
        'search',
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Failed to read Tavily response body',
        'tavily',
        'search',
      );
    }

    if (Buffer.from(text, 'utf8').length > MAX_RESPONSE_BYTES) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Tavily response exceeds maximum size',
        'tavily',
        'search',
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Tavily returned malformed JSON',
        'tavily',
        'search',
      );
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Tavily response is not a JSON object',
        'tavily',
        'search',
      );
    }

    return data as T;
  }
}
