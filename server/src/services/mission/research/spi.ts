/**
 * Provider-neutral ResearchProvider SPI.
 *
 * (architecture.md: ResearchProvider SPI, VAL-RES-006)
 *
 * The internal seam is deliberately small. Tavily and Firecrawl adapters
 * implement this interface. Adapters are limited to:
 *   - request translation (mapping ResearchRequest → provider-specific body)
 *   - bounded execution (native fetch against the fixed origin with timeout/abort)
 *   - schema validation (validating provider responses against expected shape)
 *   - normalization (translating provider results → NormalizedResearchSource)
 *
 * Adapters NEVER:
 *   - write artifacts
 *   - invoke tools
 *   - accept unbounded schemas
 *   - override provider origins
 *   - bypass the shared security boundary
 */

import type { ResearchProviderName } from './origins.js';

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type ResearchOperation = 'search' | 'extract' | 'scrape' | 'structured_extract';

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface ResearchRequest {
  /** The operation to perform. */
  operation: ResearchOperation;
  /** Search query (required for `search`, optional for `extract`). */
  query?: string;
  /** Target URLs (required for `extract`, `scrape`, `structured_extract`). */
  urls?: string[];
  /**
   * Structured extraction schema (required for `structured_extract`).
   * Must be pre-validated against StructuredExtractSchemaV1.
   */
  schema?: Record<string, unknown>;
  /** Maximum number of results to return (1–20). */
  maxResults: number;
  /** Operation timeout in milliseconds. */
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Normalized source
// ---------------------------------------------------------------------------

/** Common injection-risk labels applied to retrieved content. */
export type InjectionRiskLabel =
  | 'instruction_override'
  | 'tool_invocation'
  | 'secret_exfiltration'
  | 'external_link'
  | 'encoded_payload';

/** A normalized, provider-independent research source. */
export interface NormalizedResearchSource {
  /** Canonical HTTPS URL of the source. */
  canonicalUrl: string;
  /** Source title (bounded). */
  title?: string;
  /** Source author (bounded). */
  author?: string;
  /** Published timestamp (ISO 8601 UTC if available). */
  publishedAt?: string;
  /** Provider-assigned rank (0-based). */
  rank?: number;
  /** Provider-assigned relevance score (0–1). */
  score?: number;
  /** Retrieval timestamp (ISO 8601 UTC). */
  retrievedAt: string;
  /** MIME type of the retrieved content if known. */
  mimeType?: string;
  /** Language code if known. */
  language?: string;
  /** Bounded normalized text or excerpt (at most 1 MiB). */
  text?: string;
  /** SHA-256 hash of the normalized text (lowercase hex). */
  contentHash?: string;
  /** Byte count of the normalized text. */
  byteCount?: number;
  /** Frozen allowlisted provider metadata. */
  providerMetadata?: Record<string, unknown>;
  /** Injection-risk labels detected in the content. */
  injectionRiskLabels: InjectionRiskLabel[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ResearchResult {
  /** Deterministic logical call ID (separate from immutable physical attempt IDs). */
  logicalCallId: string;
  /** Which provider produced this result. */
  provider: ResearchProviderName;
  /** Provider-assigned request ID (raw, used for hashing before durable storage). */
  providerRequestId?: string;
  /** Provider-reported credits used (if available). */
  credits?: number;
  /** Normalized sources. */
  sources: NormalizedResearchSource[];
  /** Non-fatal warnings (bounded, safe). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Call context
// ---------------------------------------------------------------------------

/**
 * Context passed to adapter executions.
 *
 * Production origins and policy decisions remain closed. Tests may inject
 * transport, DNS, clocks, and randomness through this context, but they
 * cannot set production origins or disable policy.
 */
export interface ResearchCallContext {
  /** Optional AbortSignal for caller cancellation / deadline / lease loss. */
  signal?: AbortSignal;
  /** Optional logical call ID (generated if not provided). */
  logicalCallId?: string;
}

// ---------------------------------------------------------------------------
// Provider error
// ---------------------------------------------------------------------------

/** Stable error codes for research provider failures. */
export type ResearchProviderErrorCode =
  | 'UNSUPPORTED_OPERATION'
  | 'INVALID_REQUEST'
  | 'MISSING_CREDENTIAL'
  | 'PROVIDER_CREDENTIAL_UNAVAILABLE'
  | 'PROVIDER_AUTHENTICATION_FAILED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TRANSIENT'
  | 'PROVIDER_PERMANENT'
  | 'MALFORMED_RESPONSE'
  | 'POLICY_DENIED'
  | 'PROVIDER_MEDIATED_FETCH_UNVERIFIED'
  | 'BUDGET_EXHAUSTED'
  | 'CANCELLED'
  | 'RESEARCH_NO_USABLE_SOURCES';

export class ResearchProviderError extends Error {
  constructor(
    public readonly code: ResearchProviderErrorCode,
    message: string,
    public readonly provider: ResearchProviderName,
    public readonly operation: ResearchOperation,
    public readonly statusCode?: number,
    /**
     * Parsed Retry-After value in milliseconds (from HTTP 429/503 responses).
     * Used by the retry executor to honor bounded Retry-After delays.
     */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ResearchProviderError';
  }
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

/**
 * The provider-neutral ResearchProvider SPI.
 *
 * Adapters implement this interface. They translate a ResearchRequest into
 * a provider-specific HTTP call, execute it with native fetch against the
 * fixed origin, validate the response, and normalize results.
 */
export interface ResearchProvider {
  /** Returns true if this provider supports the given operation. */
  supports(operation: ResearchOperation): boolean;

  /**
   * Execute a research request.
   *
   * Throws ResearchProviderError on failure. Never writes artifacts or
   * invokes tools.
   */
  execute(request: ResearchRequest, context: ResearchCallContext): Promise<ResearchResult>;
}

// ---------------------------------------------------------------------------
// Injectable fetch type
// ---------------------------------------------------------------------------

/**
 * A fetch function type that matches the native `fetch` signature.
 * Tests inject a mock; production uses the global `fetch`.
 */
export type FetchFn = typeof fetch;
