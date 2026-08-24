/**
 * Deterministic, versioned source normalization for research evidence
 * (VAL-RES-019, VAL-RES-020, VAL-RES-021, VAL-RES-098, VAL-RES-112).
 *
 * This module is pure: it contains no side effects and no persistence. It is
 * the single source of truth for turning a provider-normalized
 * `NormalizedResearchSource` into the canonical, hashed, bounded record that
 * the persistence layer deduplicates on. Hashes are computed over the
 * normalized UTF-8 bytes so that identical content produces identical hashes
 * across calls, processes, and restarts.
 *
 * Dedup invariants (enforced by the persistence service, computed here):
 * - Canonical URL dedup (VAL-RES-019): `canonicalUrlHash` is SHA-256 of the
 *   canonical URL. The persistence layer dedups by
 *   `(company_id, canonical_url_hash)`.
 * - Content-hash dedup (VAL-RES-020): `contentHash` is SHA-256 of the
 *   normalized text. The persistence layer reuses an existing revision with
 *   the same `(source_id, content_hash)` instead of creating a duplicate.
 * - Changed source revision (VAL-RES-021): different normalized text →
 *   different `contentHash` → a new immutable revision row.
 * - Tenant-local dedup (VAL-RES-022): dedup is keyed by `company_id`; the
 *   hashes themselves are global, but two companies with the same URL get
 *   independent source-identity rows.
 *
 * Source metadata is normalized and bounded (VAL-RES-098): display metadata
 * is NFC-normalized and capped to finite maximums before persistence.
 *
 * Normalization is versioned (VAL-RES-112): `SOURCE_NORMALIZATION_VERSION`
 * is stored on every revision row. A change to the normalization algorithm
 * bumps the version, and re-normalization of the same content under a new
 * version produces a new revision (the old revision remains immutable).
 */

import { createHash } from 'node:crypto';
import type { NormalizedResearchSource } from './spi.js';

// ---------------------------------------------------------------------------
// Normalization version (VAL-RES-112)
// ---------------------------------------------------------------------------

/**
 * The normalization algorithm version. Stored on every source revision row.
 * Bump this when `normalizeText`, `boundMetadata`, or the hash inputs change
 * in a way that would produce different bytes for the same logical content.
 */
export const SOURCE_NORMALIZATION_VERSION = 1;

// ---------------------------------------------------------------------------
// Bounded maximums (VAL-RES-098)
// ---------------------------------------------------------------------------

export const MAX_TITLE_CHARS = 500;
export const MAX_AUTHOR_CHARS = 200;
export const MAX_MIME_TYPE_CHARS = 100;
export const MAX_LANGUAGE_CHARS = 10;
/** Maximum normalized source text size, in UTF-8 bytes (1 MiB). */
export const MAX_NORMALIZED_TEXT_BYTES = 1_048_576;

// ---------------------------------------------------------------------------
// Text normalization (deterministic, content-preserving)
// ---------------------------------------------------------------------------

/**
 * Normalize text deterministically:
 * - Unicode NFC normalization.
 * - Strip a leading UTF-8 BOM.
 * - Normalize CRLF and CR line endings to LF.
 *
 * Internal whitespace is preserved (content-preserving); collapsing it would
 * alter the source text and break quote verification.
 */
export function normalizeText(raw: string): string {
  let text = raw.normalize('NFC');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return text;
}

// ---------------------------------------------------------------------------
// Hashing (deterministic, lowercase SHA-256 hex)
// ---------------------------------------------------------------------------

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * SHA-256 hash of the normalized text's UTF-8 bytes (lowercase hex).
 * Callers must pass already-normalized text, or the raw text (which is
 * normalized here before hashing).
 */
export function computeContentHash(normalizedOrRawText: string): string {
  // Normalize defensively so the hash is always over the canonical form.
  return sha256Hex(normalizeText(normalizedOrRawText));
}

/**
 * SHA-256 hash of the canonical URL (lowercase hex). The URL is treated as
 * already-canonical (produced by the URL policy); it is NOT re-canonicalized
 * here to avoid masking adapter drift — persistence callers must pass the
 * canonical URL from the normalized source.
 */
export function computeCanonicalUrlHash(canonicalUrl: string): string {
  return sha256Hex(canonicalUrl);
}

/**
 * SHA-256 hash of the exact normalized quote (lowercase hex). Used for
 * citation identity and quote verification (VAL-RES-097).
 */
export function computeQuoteHash(exactQuote: string): string {
  return sha256Hex(normalizeText(exactQuote));
}

// ---------------------------------------------------------------------------
// Metadata bounding (VAL-RES-098)
// ---------------------------------------------------------------------------

export interface BoundedMetadata {
  title?: string;
  author?: string;
  mimeType?: string;
  language?: string;
  publishedAt?: string;
}

function capString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const nfc = value.normalize('NFC');
  return nfc.length > max ? nfc.slice(0, max) : nfc;
}

/**
 * Normalize and bound source display metadata (VAL-RES-098).
 *
 * - Strings are NFC-normalized and capped to finite maximums.
 * - Non-string values are dropped.
 * - `publishedAt` is validated as a finite ISO 8601 timestamp; invalid
 *   values are dropped rather than persisted.
 */
export function boundMetadata(input: {
  title?: unknown;
  author?: unknown;
  mimeType?: unknown;
  language?: unknown;
  publishedAt?: unknown;
}): BoundedMetadata {
  const result: BoundedMetadata = {};
  const title = capString(input.title, MAX_TITLE_CHARS);
  if (title) {
    result.title = title;
  }
  const author = capString(input.author, MAX_AUTHOR_CHARS);
  if (author) {
    result.author = author;
  }
  const mimeType = capString(input.mimeType, MAX_MIME_TYPE_CHARS);
  if (mimeType) {
    result.mimeType = mimeType;
  }
  const language = capString(input.language, MAX_LANGUAGE_CHARS);
  if (language) {
    result.language = language;
  }

  if (typeof input.publishedAt === 'string') {
    const ts = Date.parse(input.publishedAt);
    if (Number.isFinite(ts)) {
      result.publishedAt = input.publishedAt.normalize('NFC');
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Persistence record (VAL-RES-019, 020, 098, 112)
// ---------------------------------------------------------------------------

/**
 * The canonical, hashed, bounded record produced from a
 * `NormalizedResearchSource`. This is the shape the persistence service
 * stores (after encrypting restricted fields via the encryption manifest).
 */
export interface NormalizedSourcePersistenceRecord {
  /** Normalization algorithm version (VAL-RES-112). */
  normalizationVersion: number;
  /** Canonical HTTPS URL. */
  canonicalUrl: string;
  /** SHA-256 of the canonical URL (lowercase hex). */
  canonicalUrlHash: string;
  /** Registered domain extracted from the canonical URL host. */
  originDomain: string;
  /** SHA-256 of the normalized text (lowercase hex), or undefined when no text. */
  contentHash?: string;
  /** Normalized text (NFC, LF), capped to 1 MiB UTF-8 bytes. */
  normalizedText?: string;
  /** Byte count of the normalized text (UTF-8). */
  byteCount: number;
  /**
   * True when the original text exceeded 1 MiB and was deterministically
   * truncated (VAL-RES-058). Persisted as truncation metadata so consumers
   * know the retained text is a bounded prefix; no citation may point
   * outside the retained text.
   */
  truncated: boolean;
  /** Bounded display metadata (VAL-RES-098). */
  title?: string;
  author?: string;
  mimeType?: string;
  language?: string;
  publishedAt?: string;
  /** Provider-assigned rank. */
  rank?: number;
  /** Provider-assigned relevance score. */
  score?: number;
  /** Retrieval timestamp (ISO 8601 UTC). */
  retrievedAt: string;
  /** Injection-risk labels. */
  injectionRiskLabels: NormalizedResearchSource['injectionRiskLabels'];
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) {
    return text;
  }
  // Trim by characters until within the byte budget, never splitting a
  // code point (String slice operates on UTF-16 code units; for BMP text
  // this is exact, and astral chars are conservatively kept whole by
  // checking byte length after each trim).
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), 'utf8') > maxBytes) {
    end -= 1;
  }
  return text.slice(0, end);
}

function originDomainFrom(canonicalUrl: string): string {
  try {
    return new URL(canonicalUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Transform a provider-normalized `NormalizedResearchSource` into the
 * canonical, deterministic, bounded persistence record.
 *
 * This is the single function the persistence service calls before writing a
 * source revision. It is pure and deterministic: the same input always
 * produces the same record, so dedup hashes are stable across restarts.
 */
export function normalizeSourceForPersistence(
  source: NormalizedResearchSource,
): NormalizedSourcePersistenceRecord {
  const meta = boundMetadata({
    title: source.title,
    author: source.author,
    mimeType: source.mimeType,
    language: source.language,
    publishedAt: source.publishedAt,
  });

  const normalizedText = source.text !== undefined ? normalizeText(source.text) : undefined;
  const originalByteCount =
    normalizedText !== undefined ? Buffer.byteLength(normalizedText, 'utf8') : 0;
  const cappedText =
    normalizedText !== undefined
      ? truncateToBytes(normalizedText, MAX_NORMALIZED_TEXT_BYTES)
      : undefined;
  const truncated = cappedText !== undefined && originalByteCount > MAX_NORMALIZED_TEXT_BYTES;
  const contentHash = cappedText !== undefined ? sha256Hex(cappedText) : undefined;
  const byteCount = cappedText !== undefined ? Buffer.byteLength(cappedText, 'utf8') : 0;

  return {
    normalizationVersion: SOURCE_NORMALIZATION_VERSION,
    canonicalUrl: source.canonicalUrl,
    canonicalUrlHash: computeCanonicalUrlHash(source.canonicalUrl),
    originDomain: originDomainFrom(source.canonicalUrl),
    contentHash,
    normalizedText: cappedText,
    byteCount,
    truncated,
    title: meta.title,
    author: meta.author,
    mimeType: meta.mimeType,
    language: meta.language,
    publishedAt: meta.publishedAt,
    rank: source.rank,
    score: source.score,
    retrievedAt: source.retrievedAt,
    injectionRiskLabels: source.injectionRiskLabels,
  };
}
