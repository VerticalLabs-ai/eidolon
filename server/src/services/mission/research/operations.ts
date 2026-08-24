/**
 * Research operation capability matrix.
 *
 * (VAL-RES-006)
 *
 * Each provider supports a closed, explicitly enumerated set of operations.
 * When a provider does not support the requested operation, the request
 * must fail safely as `UNSUPPORTED_OPERATION` before any provider call,
 * without silently translating it into different semantics.
 *
 * Operation mapping (verified against official documentation on 2026-08-24):
 *
 * | Operation            | Tavily  | Firecrawl |
 * |----------------------|---------|-----------|
 * | search               |   ✓     |    ✓      |
 * | extract              |   ✓     |    —      |
 * | scrape               |   —     |    ✓      |
 * | structured_extract   |   —     |    ✓      |
 *
 * - `search`: Relevance-ranked web search.
 * - `extract`: Targeted text extraction from specific URLs (Tavily `/extract`).
 *   Firecrawl's `/v2/extract` is structured extraction (with a schema), not
 *   targeted text extraction, so it maps to `structured_extract` not `extract`.
 * - `scrape`: Single-page scrape returning markdown/text (Firecrawl `/v2/scrape`).
 * - `structured_extract`: Structured multi-source extraction with a JSON Schema
 *   (Firecrawl `/v2/extract`).
 */

import { type ResearchOperation, ResearchProviderError } from './spi.js';
import type { ResearchProviderName } from './origins.js';

// ---------------------------------------------------------------------------
// Operation enumeration
// ---------------------------------------------------------------------------

/** The closed set of research operations. */
export const RESEARCH_OPERATIONS: readonly ResearchOperation[] = [
  'search',
  'extract',
  'scrape',
  'structured_extract',
] as const;

// ---------------------------------------------------------------------------
// Provider capability matrix
// ---------------------------------------------------------------------------

/**
 * The closed capability matrix: which provider supports which operation.
 * This is a compile-time constant derived from official documentation.
 * It cannot be overridden by users, companies, agents, or policy.
 */
export const PROVIDER_OPERATIONS: Record<ResearchProviderName, Set<ResearchOperation>> = {
  tavily: new Set<ResearchOperation>(['search', 'extract']),
  firecrawl: new Set<ResearchOperation>(['search', 'scrape', 'structured_extract']),
} as const;

// ---------------------------------------------------------------------------
// Capability queries
// ---------------------------------------------------------------------------

/** Returns true if `provider` supports `operation`. */
export function isOperationSupported(
  provider: ResearchProviderName,
  operation: ResearchOperation,
): boolean {
  return PROVIDER_OPERATIONS[provider].has(operation);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface CapabilityValidationResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
}

/**
 * Validate that `provider` supports `operation`.
 *
 * Returns `{ valid: true }` when supported. Returns a stable error with
 * code `UNSUPPORTED_OPERATION` when not. The error message names the
 * operation and provider but never suggests translating to a different
 * operation (no semantic translation).
 */
export function validateOperationCapability(
  provider: ResearchProviderName,
  operation: ResearchOperation,
): CapabilityValidationResult {
  if (isOperationSupported(provider, operation)) {
    return { valid: true };
  }
  return {
    valid: false,
    errorCode: 'UNSUPPORTED_OPERATION',
    message: `Provider "${provider}" does not support operation "${operation}"`,
  };
}

/**
 * Get a ResearchProviderError for an unsupported operation.
 *
 * The error message names the operation and provider only. It never
 * suggests an alternative operation (no silent semantic translation).
 */
export function getUnsupportedOperationError(
  provider: ResearchProviderName,
  operation: ResearchOperation,
): ResearchProviderError {
  return new ResearchProviderError(
    'UNSUPPORTED_OPERATION',
    `Provider "${provider}" does not support operation "${operation}"`,
    provider,
    operation,
  );
}
