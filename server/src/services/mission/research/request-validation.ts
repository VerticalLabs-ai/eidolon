/**
 * Shared research request validation (VAL-RES-056).
 *
 * The single, centralized security boundary for research request shape,
 * enforced before budget reservation or network work. Provider adapters
 * call this at the top of `execute()` so validation cannot drift between
 * Tavily and Firecrawl.
 *
 * Caps (architecture.md: Network/SSRF policy):
 * - query length at most 4,000 Unicode code points (counted as spread
 *   code points, not UTF-16 code units, matching the rest of the codebase);
 * - at most 20 URLs per batch;
 * - at most 20 results (`maxResults` 1–20);
 * - finite positive timeout;
 * - a supported provider operation.
 *
 * Over-limit requests fail validation with `INVALID_REQUEST` (or
 * `UNSUPPORTED_OPERATION`) before dispatch — they are never silently
 * dispatched at the oversized value. Exact-boundary values succeed.
 */

import { type ResearchRequest, type ResearchOperation, ResearchProviderError } from './spi.js';
import type { ResearchProviderName } from './origins.js';

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

/** Maximum query length in Unicode code points. */
export const MAX_QUERY_CODEPOINTS = 4_000;
/** Maximum number of results (`maxResults`). */
export const MAX_RESULTS = 20;
/** Maximum number of target URLs per batch. */
export const MAX_URL_BATCH = 20;

/** Operations that require target URLs. */
const URL_OPERATIONS: ReadonlySet<ResearchOperation> = new Set([
  'extract',
  'scrape',
  'structured_extract',
]);

/** Operations that require a query. */
const QUERY_REQUIRED_OPERATIONS: ReadonlySet<ResearchOperation> = new Set(['search']);

// ---------------------------------------------------------------------------
// Code-point counting (matches codebase convention)
// ---------------------------------------------------------------------------

/** Count Unicode code points (not UTF-16 code units). */
function countCodePoints(s: string): number {
  return [...s].length;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ResearchRequestValidationResult {
  ok: boolean;
  error?: ResearchProviderError;
}

/**
 * Validate a research request shape before any provider call.
 *
 * @param request The research request.
 * @param supports Provider capability predicate `(operation) => boolean`.
 * @param provider Provider name (for error attribution).
 * @returns `{ ok: true }` when valid, or `{ ok: false, error }`.
 */
export function validateResearchRequest(
  request: ResearchRequest,
  supports: (operation: ResearchOperation) => boolean,
  provider: ResearchProviderName,
): ResearchRequestValidationResult {
  const op = request.operation;

  // 1. Supported provider operation (closed capability matrix).
  if (!supports(op)) {
    return {
      ok: false,
      error: new ResearchProviderError(
        'UNSUPPORTED_OPERATION',
        `Provider "${provider}" does not support operation "${op}"`,
        provider,
        op,
      ),
    };
  }

  // 2. Finite positive timeout.
  if (
    typeof request.timeoutMs !== 'number' ||
    !Number.isFinite(request.timeoutMs) ||
    request.timeoutMs <= 0
  ) {
    return {
      ok: false,
      error: new ResearchProviderError(
        'INVALID_REQUEST',
        'Research request requires a finite positive timeout',
        provider,
        op,
      ),
    };
  }

  // 3. maxResults 1–20.
  if (
    !Number.isInteger(request.maxResults) ||
    request.maxResults < 1 ||
    request.maxResults > MAX_RESULTS
  ) {
    return {
      ok: false,
      error: new ResearchProviderError(
        'INVALID_REQUEST',
        `maxResults must be an integer between 1 and ${MAX_RESULTS}`,
        provider,
        op,
      ),
    };
  }

  // 4. Query caps (search requires a query; any present query is capped).
  if (QUERY_REQUIRED_OPERATIONS.has(op)) {
    const query = request.query;
    if (typeof query !== 'string' || query.trim().length === 0) {
      return {
        ok: false,
        error: new ResearchProviderError(
          'INVALID_REQUEST',
          `${op} operation requires a non-empty query`,
          provider,
          op,
        ),
      };
    }
    if (countCodePoints(query) > MAX_QUERY_CODEPOINTS) {
      return {
        ok: false,
        error: new ResearchProviderError(
          'INVALID_REQUEST',
          `query exceeds ${MAX_QUERY_CODEPOINTS} Unicode code points`,
          provider,
          op,
        ),
      };
    }
  } else if (typeof request.query === 'string' && request.query.length > 0) {
    // Optional query present on a non-search operation — still cap it.
    if (countCodePoints(request.query) > MAX_QUERY_CODEPOINTS) {
      return {
        ok: false,
        error: new ResearchProviderError(
          'INVALID_REQUEST',
          `query exceeds ${MAX_QUERY_CODEPOINTS} Unicode code points`,
          provider,
          op,
        ),
      };
    }
  }

  // 5. URL-batch caps for URL-based operations.
  if (URL_OPERATIONS.has(op)) {
    const urls = request.urls;
    if (!Array.isArray(urls) || urls.length === 0) {
      return {
        ok: false,
        error: new ResearchProviderError(
          'INVALID_REQUEST',
          `${op} operation requires at least one URL`,
          provider,
          op,
        ),
      };
    }
    if (urls.length > MAX_URL_BATCH) {
      return {
        ok: false,
        error: new ResearchProviderError(
          'INVALID_REQUEST',
          `${op} operation supports at most ${MAX_URL_BATCH} URLs`,
          provider,
          op,
        ),
      };
    }
  }

  return { ok: true };
}
