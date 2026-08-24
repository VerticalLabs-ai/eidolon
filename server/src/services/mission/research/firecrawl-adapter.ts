/**
 * Firecrawl native-fetch research adapter.
 *
 * (architecture.md: Firecrawl Adapter, VAL-RES-006)
 *
 * Uses native `fetch`, server-side credentials, fixed origin
 * `https://api.firecrawl.dev`, and explicit versioned search/scrape/extract
 * paths. Firecrawl supports search, single-page scrape, and structured
 * multi-source extraction.
 *
 * Official documentation consulted at implementation time:
 * - Search: https://docs.firecrawl.dev/api-reference/endpoint/search
 *   (accessed 2026-08-24)
 * - Scrape: https://docs.firecrawl.dev/api-reference/endpoint/scrape
 *   (accessed 2026-08-24)
 * - Extract: https://docs.firecrawl.dev/api-reference/endpoint/extract
 *   (accessed 2026-08-24)
 *
 * Key documented contract facts:
 * - Auth: `Authorization: Bearer <token>` header.
 * - Search body: `query` (required, max 500 chars), `limit` (1–100),
 *   `scrapeOptions` with `formats: ["markdown"]`.
 * - Search response: `success`, `data` {web[], images[], news[]},
 *   `warning`, `id`, `creditsUsed`.
 *   Each web result: title, description, url, markdown, metadata
 *   (title, description, sourceURL, url, statusCode, language).
 * - Scrape body: `url` (required), `formats` (["markdown"]),
 *   `onlyMainContent`, `timeout` (1000–300000 ms).
 * - Scrape response: `success`, `data` {markdown, html, rawHtml, metadata
 *   (title, description, language, sourceURL, url, statusCode, ...), warning}.
 * - Extract body: `urls` (required, glob format), `prompt`, `schema`
 *   (JSON Schema), `showSources`.
 * - Extract response: `success`, `id`, `invalidURLs`.
 *   Note: Extract is ASYNC — returns a job `id` for polling. This adapter
 *   validates the schema and dispatches; polling is handled by the research
 *   service (later feature).
 * - Errors: 400, 402 (payment), 408 (timeout), 429 (rate limit), 500.
 *
 * Adapters never write artifacts or invoke tools. Unknown response
 * properties are discarded, not persisted. Raw HTML is not persisted by
 * default.
 */

import { createHash, randomUUID } from 'node:crypto';
import { FIRECRAWL_ORIGIN, PROVIDER_PATHS } from './origins.js';
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
import { parseRetryAfter } from './retry-after.js';
import {
  isProviderRedirect,
  createProviderRedirectError,
  validateProviderOriginUrl,
} from './ssrf-boundary.js';
import { validateTargetUrl } from './url-policy.js';

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export interface FirecrawlAdapterConfig {
  /** Firecrawl API key (resolved server-side, never logged). */
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

interface FirecrawlSearchWebResult {
  title?: string;
  description?: string;
  url?: string;
  markdown?: string;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    language?: string;
    statusCode?: number;
  };
}

interface FirecrawlSearchResponse {
  success?: boolean;
  data?: {
    web?: FirecrawlSearchWebResult[];
  };
  warning?: string;
  id?: string;
  creditsUsed?: number;
}

interface FirecrawlScrapeResponse {
  success?: boolean;
  data?: {
    markdown?: string;
    metadata?: {
      title?: string;
      description?: string;
      language?: string;
      sourceURL?: string;
      url?: string;
      statusCode?: number;
    };
    warning?: string;
  };
}

interface FirecrawlExtractResponse {
  success?: boolean;
  id?: string;
  invalidURLs?: string[];
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function normalizeText(text: string | undefined): string | undefined {
  if (!text || typeof text !== 'string') {
    return undefined;
  }
  return text.normalize('NFC').trim();
}

function hashContent(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

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

export class FirecrawlAdapter implements ResearchProvider {
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;

  constructor(config: FirecrawlAdapterConfig) {
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
  }

  supports(operation: ResearchOperation): boolean {
    return isOperationSupported('firecrawl', operation);
  }

  async execute(request: ResearchRequest, context: ResearchCallContext): Promise<ResearchResult> {
    // 1. Capability check — fail before any provider call (VAL-RES-006).
    if (!this.supports(request.operation)) {
      throw getUnsupportedOperationError('firecrawl', request.operation);
    }

    // 2. Credential check (VAL-RES-090: missing credential before dispatch).
    if (!this.apiKey) {
      throw new ResearchProviderError(
        'PROVIDER_CREDENTIAL_UNAVAILABLE',
        'Firecrawl API key is not configured',
        'firecrawl',
        request.operation,
      );
    }

    // 3. Dispatch to the operation handler.
    switch (request.operation) {
      case 'search':
        return this.executeSearch(request, context);
      case 'scrape':
        return this.executeScrape(request, context);
      case 'structured_extract':
        return this.executeStructuredExtract(request, context);
      default:
        // Unreachable — capability check above already rejected this.
        throw getUnsupportedOperationError('firecrawl', request.operation);
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
        'firecrawl',
        'search',
      );
    }

    const limit = Math.min(Math.max(1, request.maxResults), 20);
    const body = {
      query,
      limit,
      scrapeOptions: {
        formats: ['markdown'],
        onlyMainContent: true,
      },
    };

    const response = await this.doFetch(
      PROVIDER_PATHS.firecrawl.search,
      body,
      request.timeoutMs,
      context,
      'search',
    );
    const data = await this.parseResponse<FirecrawlSearchResponse>(response, 'search');

    if (data.success === false) {
      throw new ResearchProviderError(
        'PROVIDER_PERMANENT',
        'Firecrawl search failed',
        'firecrawl',
        'search',
      );
    }

    const sources: NormalizedResearchSource[] = [];
    const webResults = data.data?.web ?? [];
    for (let i = 0; i < webResults.length && i < limit; i++) {
      const result = webResults[i];
      const text = normalizeText(result.markdown ?? result.description);
      if (!result.url) {
        continue;
      }
      // VAL-RES-054: Validate search-result URLs before persistence.
      const urlCheck = validateTargetUrl(result.url);
      if (!urlCheck.valid) {
        continue;
      }
      sources.push({
        canonicalUrl: urlCheck.canonicalUrl ?? result.url,
        title: normalizeText(result.title ?? result.metadata?.title),
        retrievedAt: new Date().toISOString(),
        rank: i,
        text: text ? capText(text) : undefined,
        contentHash: text ? hashContent(capText(text)) : undefined,
        byteCount: text ? Buffer.from(capText(text), 'utf8').length : undefined,
        language: result.metadata?.language,
        providerMetadata: {
          firecrawlJobId: data.id,
        },
        injectionRiskLabels: [],
      });
    }

    const warnings: string[] = [];
    if (data.warning) {
      warnings.push(data.warning);
    }

    return {
      logicalCallId: context.logicalCallId ?? randomUUID(),
      provider: 'firecrawl',
      providerRequestId: data.id,
      credits: data.creditsUsed,
      sources,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Scrape
  // -------------------------------------------------------------------------

  private async executeScrape(
    request: ResearchRequest,
    context: ResearchCallContext,
  ): Promise<ResearchResult> {
    const urls = request.urls;
    if (!urls || urls.length === 0) {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Scrape operation requires at least one URL',
        'firecrawl',
        'scrape',
      );
    }
    if (urls.length > 1) {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Scrape operation supports exactly one URL',
        'firecrawl',
        'scrape',
      );
    }

    // VAL-RES-048/049/050/096: Validate the target URL before sending.
    const urlResult = this.validateSingleTargetUrl(urls[0], 'scrape');

    const body = {
      url: urls[0],
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: Math.min(request.timeoutMs, 30_000),
    };

    const response = await this.doFetch(
      PROVIDER_PATHS.firecrawl.scrape,
      body,
      request.timeoutMs,
      context,
      'scrape',
    );
    const data = await this.parseResponse<FirecrawlScrapeResponse>(response, 'scrape');

    if (data.success === false) {
      throw new ResearchProviderError(
        'PROVIDER_PERMANENT',
        'Firecrawl scrape failed',
        'firecrawl',
        'scrape',
      );
    }

    const sources: NormalizedResearchSource[] = [];
    const markdown = normalizeText(data.data?.markdown);
    const sourceUrl = urlResult.canonicalUrl ?? request.urls?.[0] ?? '';

    sources.push({
      canonicalUrl: sourceUrl,
      title: normalizeText(data.data?.metadata?.title),
      retrievedAt: new Date().toISOString(),
      rank: 0,
      text: markdown ? capText(markdown) : undefined,
      contentHash: markdown ? hashContent(capText(markdown)) : undefined,
      byteCount: markdown ? Buffer.from(capText(markdown), 'utf8').length : undefined,
      language: data.data?.metadata?.language,
      injectionRiskLabels: [],
    });

    const warnings: string[] = [];
    if (data.data?.warning) {
      warnings.push(data.data.warning);
    }

    return {
      logicalCallId: context.logicalCallId ?? randomUUID(),
      provider: 'firecrawl',
      sources,
      warnings,
    };
  }

  // -------------------------------------------------------------------------
  // Structured Extract (async — returns job ID for polling)
  // -------------------------------------------------------------------------

  private async executeStructuredExtract(
    request: ResearchRequest,
    context: ResearchCallContext,
  ): Promise<ResearchResult> {
    const urls = request.urls;
    if (!urls || urls.length === 0) {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Structured extract operation requires at least one URL',
        'firecrawl',
        'structured_extract',
      );
    }
    if (urls.length > 20) {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Structured extract operation supports at most 20 URLs',
        'firecrawl',
        'structured_extract',
      );
    }

    // VAL-RES-048/049/050/096: Validate each target URL before sending
    // to the provider. Unsafe URLs are rejected before provider invocation.
    for (const rawUrl of urls) {
      const urlResult = validateTargetUrl(rawUrl);
      if (!urlResult.valid) {
        throw new ResearchProviderError(
          'POLICY_DENIED',
          urlResult.message ?? 'Target URL rejected by SSRF policy',
          'firecrawl',
          'structured_extract',
        );
      }
    }

    const schema = request.schema;
    if (!schema || typeof schema !== 'object') {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Structured extract operation requires a schema',
        'firecrawl',
        'structured_extract',
      );
    }

    const body = {
      urls,
      schema,
      showSources: true,
    };

    const response = await this.doFetch(
      PROVIDER_PATHS.firecrawl.structured_extract,
      body,
      request.timeoutMs,
      context,
      'structured_extract',
    );
    const data = await this.parseResponse<FirecrawlExtractResponse>(response, 'structured_extract');

    if (data.success === false) {
      throw new ResearchProviderError(
        'PROVIDER_PERMANENT',
        'Firecrawl structured extract failed',
        'firecrawl',
        'structured_extract',
      );
    }

    // Firecrawl extract is async — returns a job ID. The research service
    // (later feature) handles polling and result retrieval. This adapter
    // returns the job ID as a providerRequestId with no sources yet.
    const warnings: string[] = [];
    if (data.invalidURLs && data.invalidURLs.length > 0) {
      warnings.push(`${data.invalidURLs.length} invalid URL(s) excluded`);
    }

    return {
      logicalCallId: context.logicalCallId ?? randomUUID(),
      provider: 'firecrawl',
      providerRequestId: data.id,
      sources: [],
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
    operation: ResearchOperation,
  ): Promise<Response> {
    const url = `${FIRECRAWL_ORIGIN}${path}`;

    // Validate that the URL matches the fixed provider origin and
    // allowlisted path (VAL-RES-055). This is a compile-time constant
    // check that prevents any runtime override.
    const originCheck = validateProviderOriginUrl(url, 'firecrawl', operation);
    if (!originCheck.valid) {
      throw new ResearchProviderError(
        'POLICY_DENIED',
        originCheck.message ?? 'Provider origin validation failed',
        'firecrawl',
        operation,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(timeoutMs, 30_000));

    if (context.signal) {
      if (context.signal.aborted) {
        clearTimeout(timeout);
        throw new ResearchProviderError(
          'CANCELLED',
          'Research call cancelled before dispatch',
          'firecrawl',
          operation,
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
        // VAL-RES-092: Never follow redirects from provider origin.
        // Any 3xx is a policy denial; no credential header is forwarded.
        redirect: 'manual',
      });

      // VAL-RES-092: Provider redirects cannot forward credentials.
      // Any 3xx from the provider origin is denied.
      if (isProviderRedirect(response.status)) {
        throw createProviderRedirectError({
          statusCode: response.status,
          provider: 'firecrawl',
          operation,
          location: response.headers.get('location') ?? undefined,
        });
      }

      this.checkHttpStatus(response, operation);
      return response;
    } catch (err) {
      if (err instanceof ResearchProviderError) {
        throw err;
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        if (context.signal?.aborted) {
          throw new ResearchProviderError(
            'CANCELLED',
            'Research call cancelled',
            'firecrawl',
            operation,
          );
        }
        throw new ResearchProviderError(
          'PROVIDER_TIMEOUT',
          'Firecrawl request timed out',
          'firecrawl',
          operation,
        );
      }
      throw new ResearchProviderError(
        'PROVIDER_TRANSIENT',
        'Firecrawl network error',
        'firecrawl',
        operation,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // -------------------------------------------------------------------------
  // Target URL validation (extracted to reduce method complexity)
  // -------------------------------------------------------------------------

  private validateSingleTargetUrl(
    rawUrl: string,
    operation: ResearchOperation,
  ): { valid: boolean; canonicalUrl?: string } {
    const result = validateTargetUrl(rawUrl);
    if (!result.valid) {
      throw new ResearchProviderError(
        'POLICY_DENIED',
        result.message ?? 'Target URL rejected by SSRF policy',
        'firecrawl',
        operation,
      );
    }
    return { valid: true, canonicalUrl: result.canonicalUrl };
  }

  // -------------------------------------------------------------------------
  // HTTP status check (extracted to reduce doFetch complexity)
  // -------------------------------------------------------------------------

  private checkHttpStatus(response: Response, operation: ResearchOperation): void {
    // VAL-RES-090: 401/403 → PROVIDER_AUTHENTICATION_FAILED (non-retried, non-fallback).
    if (response.status === 401 || response.status === 403) {
      throw new ResearchProviderError(
        'PROVIDER_AUTHENTICATION_FAILED',
        'Firecrawl authentication failed',
        'firecrawl',
        operation,
        response.status,
      );
    }
    if (response.status === 402) {
      throw new ResearchProviderError(
        'PROVIDER_QUOTA_EXCEEDED',
        'Firecrawl payment required',
        'firecrawl',
        operation,
        402,
      );
    }
    if (response.status === 408) {
      throw new ResearchProviderError(
        'PROVIDER_TIMEOUT',
        'Firecrawl request timed out',
        'firecrawl',
        operation,
        408,
      );
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), new Date(), 5_000);
      throw new ResearchProviderError(
        'PROVIDER_RATE_LIMITED',
        'Firecrawl rate limit exceeded',
        'firecrawl',
        operation,
        429,
        retryAfterMs ?? undefined,
      );
    }
    if (response.status >= 500) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), new Date(), 5_000);
      throw new ResearchProviderError(
        'PROVIDER_TRANSIENT',
        'Firecrawl server error',
        'firecrawl',
        operation,
        response.status,
        retryAfterMs ?? undefined,
      );
    }
    if (response.status >= 400) {
      throw new ResearchProviderError(
        'PROVIDER_PERMANENT',
        'Firecrawl request rejected',
        'firecrawl',
        operation,
        response.status,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Response parsing (bounded, schema-validated)
  // -------------------------------------------------------------------------

  private async parseResponse<T>(response: Response, operation: ResearchOperation): Promise<T> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Firecrawl returned non-JSON content type',
        'firecrawl',
        operation,
      );
    }

    const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Firecrawl response exceeds maximum size',
        'firecrawl',
        operation,
      );
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Failed to read Firecrawl response body',
        'firecrawl',
        operation,
      );
    }

    if (Buffer.from(text, 'utf8').length > MAX_RESPONSE_BYTES) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Firecrawl response exceeds maximum size',
        'firecrawl',
        operation,
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Firecrawl returned malformed JSON',
        'firecrawl',
        operation,
      );
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Firecrawl response is not a JSON object',
        'firecrawl',
        operation,
      );
    }

    return data as T;
  }
}
