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
import { parseRetryAfter } from './retry-after.js';
import {
  isProviderRedirect,
  createProviderRedirectError,
  validateProviderOriginUrl,
} from './ssrf-boundary.js';
import { validateTargetUrl } from './url-policy.js';
import { validateProviderMediatedFetch } from './provider-mediated-fetch.js';
import { detectInjectionRisk, redactSecrets } from './content-isolation.js';
import { validateResearchRequest } from './request-validation.js';
import { readBoundedResponseBody } from './bounded-body-reader.js';
import { createOperationDeadline } from './operation-deadline.js';

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
  /**
   * Optional externally-provided deadline AbortSignal (test seam). When
   * supplied, the adapter uses this signal as the operation deadline
   * instead of creating its own. Production leaves this undefined and the
   * adapter creates a deadline from the request timeout and operation
   * defaults (15s search / 30s extract).
   */
  deadlineSignal?: AbortSignal;
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
  private readonly deadlineSignal?: AbortSignal;

  constructor(config: TavilyAdapterConfig) {
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? fetch;
    this.deadlineSignal = config.deadlineSignal;
  }

  supports(operation: ResearchOperation): boolean {
    return isOperationSupported('tavily', operation);
  }

  async execute(request: ResearchRequest, context: ResearchCallContext): Promise<ResearchResult> {
    // 1. Capability check — fail before any provider call (VAL-RES-006).
    if (!this.supports(request.operation)) {
      throw getUnsupportedOperationError('tavily', request.operation);
    }

    // 2. Credential check (VAL-RES-090: missing credential before dispatch).
    if (!this.apiKey) {
      throw new ResearchProviderError(
        'PROVIDER_CREDENTIAL_UNAVAILABLE',
        'Tavily API key is not configured',
        'tavily',
        request.operation,
      );
    }

    // 3. Shared request validation (VAL-RES-056): query/result/URL caps,
    //    finite timeout, supported operation — before any network work.
    const validation = validateResearchRequest(
      request,
      (op) => isOperationSupported('tavily', op),
      'tavily',
    );
    if (!validation.ok) {
      throw validation.error;
    }

    // 4. Operation deadline (VAL-RES-060, VAL-RES-093): covers DNS/connect,
    //    upload, headers, decoded body streaming, parsing, normalization.
    //    15s search / 30s extract, bounded by the request timeout.
    const deadline =
      this.deadlineSignal !== undefined
        ? { signal: this.deadlineSignal, clear() {} }
        : createOperationDeadline(request.operation, request.timeoutMs);

    try {
      // 5. Dispatch to the operation handler.
      switch (request.operation) {
        case 'search':
          return await this.executeSearch(request, context, deadline.signal);
        case 'extract':
          return await this.executeExtract(request, context, deadline.signal);
        default:
          // Unreachable — capability check above already rejected this.
          throw getUnsupportedOperationError('tavily', request.operation);
      }
    } finally {
      deadline.clear();
    }
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  private async executeSearch(
    request: ResearchRequest,
    context: ResearchCallContext,
    deadlineSignal: AbortSignal,
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

    // Validation (VAL-RES-056) already guaranteed 1–20; clamp defensively.
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
      context,
      'search',
      deadlineSignal,
    );
    const data = await this.parseResponse<TavilySearchResponse>(response, 'search', deadlineSignal);

    const sources: NormalizedResearchSource[] = [];
    const results = Array.isArray(data.results) ? data.results : [];
    for (let i = 0; i < results.length && i < maxResults; i++) {
      const result = results[i];
      const text = normalizeText(result.content);
      if (!result.url) {
        continue;
      }
      // VAL-RES-054: Validate search-result URLs before persistence.
      // Unsafe URLs are excluded; discovery alone never authorizes use.
      const urlCheck = validateTargetUrl(result.url);
      if (!urlCheck.valid) {
        continue;
      }
      // VAL-RES-044/046: Isolate hostile content. Redact secrets and
      // detect injection-risk patterns before persisting source text.
      const { redacted } = redactSecrets(text);
      const safeText = redacted ? capText(redacted) : undefined;
      sources.push({
        canonicalUrl: urlCheck.canonicalUrl ?? result.url,
        title: normalizeText(result.title),
        retrievedAt: new Date().toISOString(),
        rank: i,
        score: typeof result.score === 'number' ? result.score : undefined,
        text: safeText,
        contentHash: safeText ? hashContent(safeText) : undefined,
        byteCount: safeText ? Buffer.from(safeText, 'utf8').length : undefined,
        injectionRiskLabels: detectInjectionRisk(safeText),
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
    deadlineSignal: AbortSignal,
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
    // Validation (VAL-RES-056) already guaranteed ≤ 20; the explicit
    // check is retained as a fail-closed guard.
    if (urls.length > 20) {
      throw new ResearchProviderError(
        'INVALID_REQUEST',
        'Extract operation supports at most 20 URLs',
        'tavily',
        'extract',
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
          'tavily',
          'extract',
        );
      }
    }

    // VAL-RES-108: Provider-mediated fetch capability enforcement.
    // Fail closed if the provider cannot verify the complete redirect
    // chain and per-hop SSRF enforcement for target URLs. In Phase 1,
    // Tavily extract lacks this capability, so the operation is denied
    // before dispatch rather than sending target URLs to the provider.
    this.assertMediatedFetch('extract', urls);

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
      context,
      'extract',
      deadlineSignal,
    );
    const data = await this.parseResponse<TavilyExtractResponse>(
      response,
      'extract',
      deadlineSignal,
    );

    const sources: NormalizedResearchSource[] = [];
    const results = Array.isArray(data.results) ? data.results : [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const text = normalizeText(result.raw_content);
      if (!result.url) {
        continue;
      }
      // VAL-RES-054: Validate extract-result URLs before persistence.
      const urlCheck = validateTargetUrl(result.url);
      if (!urlCheck.valid) {
        continue;
      }
      // VAL-RES-044/046: Isolate hostile content. Redact secrets and
      // detect injection-risk patterns before persisting source text.
      const { redacted } = redactSecrets(text);
      const safeText = redacted ? capText(redacted) : undefined;
      sources.push({
        canonicalUrl: urlCheck.canonicalUrl ?? result.url,
        retrievedAt: new Date().toISOString(),
        rank: i,
        text: safeText,
        contentHash: safeText ? hashContent(safeText) : undefined,
        byteCount: safeText ? Buffer.from(safeText, 'utf8').length : undefined,
        injectionRiskLabels: detectInjectionRisk(safeText),
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
  // Provider-mediated fetch enforcement (VAL-RES-108)
  // -------------------------------------------------------------------------

  /**
   * Assert that the provider operation has a compliant mediated-fetch
   * capability before dispatching target URLs. Fails closed with
   * PROVIDER_MEDIATED_FETCH_UNVERIFIED if the capability is unverified.
   */
  private assertMediatedFetch(operation: ResearchOperation, urls: string[]): void {
    const result = validateProviderMediatedFetch('tavily', operation, urls);
    if (!result.valid) {
      throw new ResearchProviderError(
        result.errorCode ?? 'PROVIDER_MEDIATED_FETCH_UNVERIFIED',
        result.message ?? 'Provider-mediated fetch not verified',
        'tavily',
        operation,
      );
    }
  }

  // -------------------------------------------------------------------------
  // HTTP execution (bounded, abortable)
  // -------------------------------------------------------------------------

  private async doFetch(
    path: string,
    body: Record<string, unknown>,
    context: ResearchCallContext,
    operation: ResearchOperation,
    deadlineSignal: AbortSignal,
  ): Promise<Response> {
    const url = `${TAVILY_ORIGIN}${path}`;

    // Validate that the URL matches the fixed provider origin and
    // allowlisted path (VAL-RES-055). This is a compile-time constant
    // check that prevents any runtime override.
    const originCheck = validateProviderOriginUrl(url, 'tavily', operation);
    if (!originCheck.valid) {
      throw new ResearchProviderError(
        'POLICY_DENIED',
        originCheck.message ?? 'Provider origin validation failed',
        'tavily',
        operation,
      );
    }

    // VAL-RES-060/093: the operation deadline covers DNS/connect, upload,
    // headers, and decoded body streaming. Combine it with the caller's
    // cancellation signal into one abort source.
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (deadlineSignal.aborted || context.signal?.aborted) {
      throw new ResearchProviderError(
        'CANCELLED',
        'Research call cancelled before dispatch',
        'tavily',
        operation,
      );
    }
    deadlineSignal.addEventListener('abort', abort, { once: true });
    context.signal?.addEventListener('abort', abort, { once: true });

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
          provider: 'tavily',
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
        // Distinguish cancellation from deadline timeout.
        if (context.signal?.aborted) {
          throw new ResearchProviderError(
            'CANCELLED',
            'Research call cancelled',
            'tavily',
            operation,
          );
        }
        throw new ResearchProviderError(
          'PROVIDER_TIMEOUT',
          'Tavily request timed out',
          'tavily',
          operation,
        );
      }
      // Network error.
      throw new ResearchProviderError(
        'PROVIDER_TRANSIENT',
        'Tavily network error',
        'tavily',
        operation,
      );
    } finally {
      deadlineSignal.removeEventListener('abort', abort);
      context.signal?.removeEventListener('abort', abort);
    }
  }

  // -------------------------------------------------------------------------
  // HTTP status check (extracted to reduce doFetch complexity)
  // -------------------------------------------------------------------------

  private checkHttpStatus(response: Response, operation: ResearchOperation): void {
    // VAL-RES-090: 401/403 → PROVIDER_AUTHENTICATION_FAILED (non-retried, non-fallback).
    if (response.status === 401 || response.status === 403) {
      throw new ResearchProviderError(
        'PROVIDER_AUTHENTICATION_FAILED',
        'Tavily authentication failed',
        'tavily',
        operation,
        response.status,
      );
    }
    if (response.status === 408) {
      throw new ResearchProviderError(
        'PROVIDER_TIMEOUT',
        'Tavily request timed out',
        'tavily',
        operation,
        408,
      );
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), new Date(), 5_000);
      throw new ResearchProviderError(
        'PROVIDER_RATE_LIMITED',
        'Tavily rate limit exceeded',
        'tavily',
        operation,
        429,
        retryAfterMs ?? undefined,
      );
    }
    if (response.status === 432 || response.status === 433) {
      throw new ResearchProviderError(
        'PROVIDER_QUOTA_EXCEEDED',
        'Tavily quota exceeded',
        'tavily',
        operation,
        response.status,
      );
    }
    if (response.status >= 500) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), new Date(), 5_000);
      throw new ResearchProviderError(
        'PROVIDER_TRANSIENT',
        'Tavily server error',
        'tavily',
        operation,
        response.status,
        retryAfterMs ?? undefined,
      );
    }
    if (response.status >= 400) {
      throw new ResearchProviderError(
        'PROVIDER_PERMANENT',
        'Tavily request rejected',
        'tavily',
        operation,
        response.status,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Response parsing (bounded, schema-validated)
  // -------------------------------------------------------------------------

  private async parseResponse<T>(
    response: Response,
    operation: ResearchOperation,
    deadlineSignal: AbortSignal,
  ): Promise<T> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Tavily returned non-JSON content type',
        'tavily',
        operation,
      );
    }

    // VAL-RES-057/093: stream and count decoded bytes rather than calling
    // an unbounded body reader. Aborts at 5 MiB or when the deadline fires.
    const text = await readBoundedResponseBody(
      response,
      operation,
      'tavily',
      undefined,
      deadlineSignal,
    );

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Tavily returned malformed JSON',
        'tavily',
        operation,
      );
    }

    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new ResearchProviderError(
        'MALFORMED_RESPONSE',
        'Tavily response is not a JSON object',
        'tavily',
        operation,
      );
    }

    return data as T;
  }
}
