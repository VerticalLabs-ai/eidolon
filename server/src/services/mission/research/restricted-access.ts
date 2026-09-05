/**
 * Restricted source content access policy (VAL-RES-078, VAL-RES-118).
 *
 * Phase 1 product and API source reads expose only summaries and bounded
 * citation quote windows. Every attempted full-document content read is
 * denied. Server-side locator verification remains available only to
 * authorized service/test probes.
 *
 * Hash, ciphertext, quote hash, canonical URL hash, source/revision IDs,
 * and search/pagination parameters cannot act as alternate content or
 * equality oracles. Only scoped authorized service methods decrypt bounded
 * fields; denied, cross-company, cross-project, viewer-restricted, timing,
 * and malformed-hash requests return uniform safe results, and every
 * restricted administrative read is audited.
 */

import { decrypt } from '../../crypto.js';
import { AppError } from '../../../middleware/error-handler.js';
import type { ScopedResource } from './scope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A research source revision record with encrypted restricted fields.
 * This is the shape that persistence code will store; the restricted-access
 * module reads from it to produce safe summaries or authorized bounded views.
 */
export interface SourceRevisionRecord extends ScopedResource {
  type: 'source_revision';
  source_revision_id: string;
  run_id: string;
  canonical_url: string;
  content_hash: string;
  normalized_text_encrypted: string;
  title_encrypted?: string;
  byte_count: number;
  mime_type_encrypted?: string;
  language_encrypted?: string;
  retrieved_at: string;
  rank: number;
  status: string;
}

/**
 * A citation record with encrypted quote text.
 */
export interface CitationRecord extends ScopedResource {
  type: 'citation';
  citation_id: string;
  source_revision_id: string;
  quote_exact_encrypted: string;
  quote_prefix_encrypted?: string;
  quote_suffix_encrypted?: string;
  quote_hash: string;
  canonical_url: string;
  ordinal: number;
}

/**
 * An authorized service context for restricted reads. Only service-role
 * contexts (not API routes or client requests) may decrypt bounded fields
 * for locator verification.
 */
export interface AuthorizedServiceContext {
  /**
   * The role of the caller. Only recognized service roles
   * (`research_service`, `locator_verifier`, `test_probe`) are authorized
   * to decrypt restricted fields. Any other value (e.g. `api_route`,
   * `client`) is denied.
   */
  serviceRole: string;
  companyId: string;
  projectId: string;
  actorId: string;
}

/**
 * A locator verification request: the exact quote and character offsets
 * into the normalized source revision text.
 */
export interface LocatorVerificationRequest {
  quote: string;
  charStart: number;
  charEnd: number;
}

/**
 * Result of a locator verification.
 */
export interface LocatorVerificationResult {
  verified: boolean;
  /** The source revision ID that was verified. */
  sourceRevisionId: string;
  /** The canonical URL of the verified source. */
  canonicalUrl: string;
}

/**
 * An audit entry for a restricted administrative read.
 */
export interface AuditEntry {
  action: 'restricted_read';
  actorId: string;
  companyId: string;
  projectId: string;
  sourceRevisionId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum character length of a citation quote window. Quote windows are
 * bounded to prevent full-document content disclosure through citation reads.
 */
export const MAX_CITATION_QUOTE_WINDOW_CHARS = 500;

/**
 * Maximum prefix/suffix context characters around a citation quote.
 */
const MAX_QUOTE_CONTEXT_CHARS = 100;

// ---------------------------------------------------------------------------
// Source summary (VAL-RES-078)
// ---------------------------------------------------------------------------

/**
 * A public-safe source summary. Contains only non-restricted fields.
 */
export interface SourceSummary {
  source_revision_id: string;
  run_id: string;
  canonical_url: string;
  content_hash: string;
  byte_count: number;
  retrieved_at: string;
  rank: number;
  status: string;
  companyId: string;
  projectId: string;
}

/**
 * Build a public-safe source summary from a source revision record.
 *
 * Exposes only safe fields: IDs, hashes, counts, timestamps, canonical URL,
 * and status. Full document content (normalized_text) and display metadata
 * (title, author, MIME, language) are NOT included.
 *
 * @param record - The source revision record with encrypted restricted fields.
 * @param options - Optional. `includeFullContent: true` is ALWAYS denied.
 */
export function buildSourceSummary(
  record: SourceRevisionRecord,
  options?: { includeFullContent?: boolean },
): SourceSummary {
  // Full-content reads are always denied, regardless of options.
  if (options?.includeFullContent) {
    throw new AppError(
      403,
      'RESTRICTED_CONTENT_DENIED',
      'Full document content access is not permitted',
    );
  }

  return {
    source_revision_id: record.source_revision_id,
    run_id: record.run_id,
    canonical_url: record.canonical_url,
    content_hash: record.content_hash,
    byte_count: record.byte_count,
    retrieved_at: record.retrieved_at,
    rank: record.rank,
    status: record.status,
    companyId: record.companyId,
    projectId: record.projectId ?? '',
  };
}

// ---------------------------------------------------------------------------
// Citation quote window (VAL-RES-078)
// ---------------------------------------------------------------------------

/**
 * A bounded citation quote window. Contains the exact quote, bounded
 * prefix/suffix context, hash, canonical URL, and ordinal — but never
 * the full document content.
 */
export interface CitationQuoteWindow {
  citation_id: string;
  source_revision_id: string;
  quote_exact: string;
  quote_prefix: string;
  quote_suffix: string;
  quote_hash: string;
  canonical_url: string;
  ordinal: number;
}

function capString(text: string | undefined, max: number): string {
  if (!text) {
    return '';
  }
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Build a bounded citation quote window from a citation record.
 *
 * The exact quote, prefix, and suffix are decrypted from the citation's
 * encrypted fields and capped to bounded maximums. Full document content
 * is never exposed.
 */
export function buildCitationQuoteWindow(citation: CitationRecord): CitationQuoteWindow {
  let quoteExact: string;
  let quotePrefix = '';
  let quoteSuffix = '';

  try {
    quoteExact = decrypt(citation.quote_exact_encrypted);
  } catch {
    quoteExact = '';
  }
  if (citation.quote_prefix_encrypted) {
    try {
      quotePrefix = decrypt(citation.quote_prefix_encrypted);
    } catch {
      quotePrefix = '';
    }
  }
  if (citation.quote_suffix_encrypted) {
    try {
      quoteSuffix = decrypt(citation.quote_suffix_encrypted);
    } catch {
      quoteSuffix = '';
    }
  }

  // Cap each component to bounded maximums.
  quoteExact = capString(quoteExact, MAX_CITATION_QUOTE_WINDOW_CHARS);
  quotePrefix = capString(quotePrefix, MAX_QUOTE_CONTEXT_CHARS);
  quoteSuffix = capString(quoteSuffix, MAX_QUOTE_CONTEXT_CHARS);

  return {
    citation_id: citation.citation_id,
    source_revision_id: citation.source_revision_id,
    quote_exact: quoteExact,
    quote_prefix: quotePrefix,
    quote_suffix: quoteSuffix,
    quote_hash: citation.quote_hash,
    canonical_url: citation.canonical_url,
    ordinal: citation.ordinal,
  };
}

// ---------------------------------------------------------------------------
// Authorized service access (VAL-RES-118)
// ---------------------------------------------------------------------------

/**
 * Check whether a service context is authorized to access restricted fields
 * of a source revision. The context must:
 *  - Have a recognized service role (not an API/client role).
 *  - Be in the same company as the resource.
 *  - Be in the same project as the resource (when resource is project-scoped).
 */
export function isAuthorizedServiceContext(
  ctx: AuthorizedServiceContext,
  record: SourceRevisionRecord | CitationRecord,
): boolean {
  // Must be a service role.
  if (
    ctx.serviceRole !== 'research_service' &&
    ctx.serviceRole !== 'locator_verifier' &&
    ctx.serviceRole !== 'test_probe'
  ) {
    return false;
  }

  // Company scope check.
  if (ctx.companyId !== record.companyId) {
    return false;
  }

  // Project scope check (when resource has a project).
  if (record.projectId !== null && record.projectId !== undefined) {
    if (ctx.projectId !== record.projectId) {
      return false;
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Locator verification (VAL-RES-118)
// ---------------------------------------------------------------------------

/**
 * Verify that a quote and character offsets match the normalized text of
 * a source revision. This is a server-side operation available only to
 * authorized service/test probe contexts.
 *
 * The decrypted content is never returned — only a boolean `verified` result.
 * Every call is audited (when an auditLog is provided).
 *
 * @param ctx - The authorized service context.
 * @param record - The source revision record with encrypted normalized text.
 * @param locator - The quote and character offsets to verify.
 * @param options - Optional audit log to record the restricted read.
 */
export function verifyLocator(
  ctx: AuthorizedServiceContext,
  record: SourceRevisionRecord,
  locator: LocatorVerificationRequest,
  options?: { auditLog?: AuditEntry[] },
): LocatorVerificationResult {
  // 1. Authorization check.
  if (!isAuthorizedServiceContext(ctx, record)) {
    throw new AppError(
      403,
      'RESTRICTED_CONTENT_DENIED',
      'Not authorized to access restricted content',
    );
  }

  // 2. Audit the restricted read (before decrypting, so the audit entry
  //    is recorded even if verification fails).
  if (options?.auditLog) {
    options.auditLog.push({
      action: 'restricted_read',
      actorId: ctx.actorId,
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      sourceRevisionId: record.source_revision_id,
      timestamp: new Date().toISOString(),
    });
  }

  // 3. Decrypt the normalized text.
  let normalizedText: string;
  try {
    normalizedText = decrypt(record.normalized_text_encrypted);
  } catch {
    // Cannot decrypt — verification fails.
    return {
      verified: false,
      sourceRevisionId: record.source_revision_id,
      canonicalUrl: record.canonical_url,
    };
  }

  // 4. Verify the quote matches the text at the given offsets.
  const { quote, charStart, charEnd } = locator;
  if (charStart < 0 || charEnd > normalizedText.length || charStart >= charEnd) {
    return {
      verified: false,
      sourceRevisionId: record.source_revision_id,
      canonicalUrl: record.canonical_url,
    };
  }

  const textAtOffset = normalizedText.slice(charStart, charEnd);
  const verified = textAtOffset === quote;

  return {
    verified,
    sourceRevisionId: record.source_revision_id,
    canonicalUrl: record.canonical_url,
  };
}

// ---------------------------------------------------------------------------
// Content oracle prevention (VAL-RES-118)
// ---------------------------------------------------------------------------

/**
 * Fields that, when provided alone, are attempts to use hashes/IDs/ciphertext
 * as content or equality oracles. Any request containing only these fields
 * (without an authorized service context) must be denied.
 */
const ORACLE_INDICATOR_FIELDS = new Set([
  'content_hash',
  'quote_hash',
  'canonical_url_hash',
  'provider_request_id_hash',
  'source_revision_id',
  'citation_id',
  'ciphertext',
  'search',
  'page',
  'query_hash',
]);

/**
 * Assert that a set of query parameters is not attempting to use hashes,
 * ciphertext, IDs, or search/pagination parameters as a content or equality
 * oracle.
 *
 * This function is called by API routes when a request provides only
 * hash/ID/ciphertext/search parameters without an authorized service context.
 * It throws `403 RESTRICTED_CONTENT_DENIED` to prevent oracle attacks.
 *
 * @param params - The query/request parameters to check.
 */
export function assertNotContentOracle(params: Record<string, unknown>): void {
  // If all provided keys are oracle indicators, deny.
  const keys = Object.keys(params);
  if (keys.length === 0) {
    return;
  }
  const allOracleIndicators = keys.every((k) => ORACLE_INDICATOR_FIELDS.has(k));
  if (allOracleIndicators) {
    throw new AppError(
      403,
      'RESTRICTED_CONTENT_DENIED',
      'Parameters cannot be used to access or compare restricted content',
    );
  }
}

/**
 * Audit a restricted read operation. This is a standalone helper for
 * service code that performs restricted reads outside of `verifyLocator`.
 */
export function auditRestrictedRead(
  ctx: AuthorizedServiceContext,
  resource: { sourceRevisionId?: string; citationId?: string },
  auditLog: AuditEntry[],
): void {
  auditLog.push({
    action: 'restricted_read',
    actorId: ctx.actorId,
    companyId: ctx.companyId,
    projectId: ctx.projectId,
    sourceRevisionId: resource.sourceRevisionId ?? 'unknown',
    timestamp: new Date().toISOString(),
  });
}
