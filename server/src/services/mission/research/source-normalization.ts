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
import { canonicalizeUrl } from './url-policy.js';

// ---------------------------------------------------------------------------
// Normalization version (VAL-RES-112)
// ---------------------------------------------------------------------------

/**
 * The normalization algorithm version. Stored on every source revision row.
 * Bump this when `normalizeText`, `boundMetadata`, or the hash inputs change
 * in a way that would produce different bytes for the same logical content.
 *
 * Version 2 adds: HTML entity decoding, horizontal whitespace to ASCII space,
 * newline collapse (>2 to 2), tracking-key stripping for URL dedup, and
 * Unicode scalar value offset conversion.
 *
 * Version 3 aligns TRACKING_QUERY_KEYS to the 7 documented keys in
 * VAL-RES-019 (utm_source, utm_medium, utm_campaign, utm_term, utm_content,
 * gclid, fbclid) and re-canonicalizes the URL after stripping tracking keys
 * via canonicalizeUrl so that non-tracking query parameters retain
 * encodeURIComponent encoding (spaces as %20, not +), preserving URL dedup
 * for URLs with spaces in non-tracking query parameters.
 */
export const SOURCE_NORMALIZATION_VERSION = 3;

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
 * Named HTML entities to decode during normalization.
 * Covers the standard entities most commonly found in scraped web content.
 */
const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00A0',
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  laquo: '\u00AB',
  raquo: '\u00BB',
  deg: '\u00B0',
  plusmn: '\u00B1',
  times: '\u00D7',
  divide: '\u00F7',
  euro: '\u20AC',
  pound: '\u00A3',
  cent: '\u00A2',
  sect: '\u00A7',
  para: '\u00B6',
  middot: '\u00B7',
  bull: '\u2022',
  dagger: '\u2020',
  Dagger: '\u2021',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',
  infin: '\u221E',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
};

/**
 * Decode standard HTML entities in text:
 * - Named entities: &amp; &lt; &gt; &quot; &apos; &nbsp; etc.
 * - Numeric decimal: &#123;
 * - Numeric hex: &#x7B; or &#X7B;
 *
 * Unknown named entities are left unchanged (fail-safe).
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:[a-zA-Z]+|#\d+|#[xX][0-9a-fA-F]+);/g, (match) => {
    const body = match.slice(1, -1); // strip & and ;
    if (body.startsWith('#')) {
      // Numeric entity
      let codePoint: number;
      if (body[1] === 'x' || body[1] === 'X') {
        codePoint = parseInt(body.slice(2), 16);
      } else {
        codePoint = parseInt(body.slice(1), 10);
      }
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match; // invalid, leave as-is
      }
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match; // invalid code point, leave as-is
      }
    }
    // Named entity
    const decoded = HTML_ENTITIES[body];
    return decoded !== undefined ? decoded : match;
  });
}

/**
 * Characters considered horizontal whitespace that should be converted to
 * ASCII space (0x20). Excludes LF (newline) which is handled separately.
 */
// eslint-disable-next-line no-control-regex -- intentional: tab, vtab, formfeed are whitespace targets
const HORIZONTAL_WHITESPACE = /[\t\u000B\u000C\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\uFEFF]/g;

/**
 * Normalize text deterministically:
 * - Unicode NFC normalization.
 * - Strip a leading UTF-8 BOM.
 * - Normalize CRLF and CR line endings to LF.
 * - Decode standard HTML entities (&amp; → &, &#39; → ', etc.).
 * - Convert horizontal whitespace (tab, non-breaking space, etc.) to
 *   ASCII space (0x20). Runs of ASCII spaces are preserved (content-preserving).
 * - Collapse runs of 3+ newlines to exactly 2 newlines.
 *
 * Internal ASCII whitespace runs are preserved (content-preserving); only
 * non-ASCII horizontal whitespace characters are canonicalized to ASCII space.
 */
export function normalizeText(raw: string): string {
  let text = raw.normalize('NFC');
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  text = decodeHtmlEntities(text);
  text = text.replace(HORIZONTAL_WHITESPACE, ' ');
  // Collapse 3+ consecutive newlines to exactly 2.
  text = text.replace(/\n{3,}/g, '\n\n');
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

// ---------------------------------------------------------------------------
// Tracking query keys (VAL-RES-019 URL dedup)
// ---------------------------------------------------------------------------

/**
 * Case-insensitive set of tracking/analytics query parameter keys that are
 * stripped before computing the canonical URL hash for deduplication
 * (VAL-RES-019). Only the 7 documented tracking keys are stripped; other
 * query parameters are preserved because they may identify content.
 */
export const TRACKING_QUERY_KEYS: readonly string[] = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
];

function isTrackingQueryKey(key: string): boolean {
  return TRACKING_QUERY_KEYS.includes(key.toLowerCase());
}

/**
 * Strip tracking/analytics query parameters from a canonical URL before
 * computing the dedup hash (VAL-RES-019). Only the 7 documented tracking
 * keys (utm_source, utm_medium, utm_campaign, utm_term, utm_content, gclid,
 * fbclid) are stripped; other query parameters are preserved because they
 * may identify content.
 *
 * After stripping, the result is re-canonicalized via `canonicalizeUrl` so
 * that non-tracking query parameters retain encodeURIComponent encoding
 * (spaces as %20, not +). This ensures the canonical URL hash matches the
 * hash of the same URL that went through the URL policy's canonicalization,
 * preserving URL dedup for URLs with spaces in non-tracking query parameters.
 *
 * Returns the URL with tracking parameters removed. Non-tracking parameters
 * are preserved.
 */
export function stripTrackingKeys(canonicalUrl: string): string {
  try {
    const parsed = new URL(canonicalUrl);
    if (parsed.searchParams.size === 0) {
      return canonicalUrl;
    }
    const trackingKeys: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      if (isTrackingQueryKey(key)) {
        trackingKeys.push(key);
      }
    }
    if (trackingKeys.length === 0) {
      return canonicalUrl;
    }
    for (const key of trackingKeys) {
      parsed.searchParams.delete(key);
    }
    // Re-canonicalize the result to preserve encodeURIComponent encoding
    // (spaces as %20, not +) and stable parameter ordering, matching the
    // output of the URL policy's canonicalizeUrl (VAL-RES-019).
    const reCanonicalized = canonicalizeUrl(parsed.toString());
    return reCanonicalized.canonical ?? canonicalUrl;
  } catch {
    // If URL parsing fails, return as-is (the caller should pass a valid URL).
    return canonicalUrl;
  }
}

/**
 * SHA-256 hash of the canonical URL with tracking keys stripped (lowercase hex).
 * The URL is treated as already-canonical (produced by the URL policy);
 * tracking/analytics parameters are removed before hashing so that the same
 * page with different tracking tags produces the same dedup hash (VAL-RES-019).
 */
export function computeCanonicalUrlHash(canonicalUrl: string): string {
  return sha256Hex(stripTrackingKeys(canonicalUrl));
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

// ---------------------------------------------------------------------------
// Unicode scalar value offset conversion (VAL-RES-112)
// ---------------------------------------------------------------------------

/**
 * Convert a UTF-16 code unit offset to a Unicode scalar value offset.
 *
 * JavaScript strings use UTF-16 code units. Astral characters (code points
 * above U+FFFF) are represented as surrogate pairs (2 UTF-16 code units)
 * but count as 1 Unicode scalar value. This function counts the number of
 * surrogate pairs before `utf16Offset` and subtracts them, yielding the
 * scalar value offset.
 *
 * Example: text = "😀test" (😀 is U+1F600, a surrogate pair)
 *   utf16Offset 0 → scalar 0
 *   utf16Offset 2 → scalar 1 (after the emoji)
 *   utf16Offset 3 → scalar 2
 */
export function utf16ToScalarOffset(text: string, utf16Offset: number): number {
  let surrogatePairs = 0;
  for (let i = 0; i < utf16Offset; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      // High surrogate — check if the next code unit is a low surrogate
      if (i + 1 < text.length) {
        const next = text.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          surrogatePairs++;
          i++; // Skip the low surrogate in the counting loop
        }
      }
    }
  }
  return utf16Offset - surrogatePairs;
}

/**
 * Convert a Unicode scalar value offset to a UTF-16 code unit offset.
 *
 * This is the inverse of `utf16ToScalarOffset`. It walks the string counting
 * scalar values until reaching `scalarOffset`, tracking the corresponding
 * UTF-16 code unit position.
 */
export function scalarToUtf16Offset(text: string, scalarOffset: number): number {
  let utf16Offset = 0;
  let scalarCount = 0;
  while (utf16Offset < text.length && scalarCount < scalarOffset) {
    const code = text.charCodeAt(utf16Offset);
    if (code >= 0xd800 && code <= 0xdbff && utf16Offset + 1 < text.length) {
      const next = text.charCodeAt(utf16Offset + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // Surrogate pair: 2 UTF-16 units = 1 scalar value
        utf16Offset += 2;
      } else {
        utf16Offset += 1;
      }
    } else {
      utf16Offset += 1;
    }
    scalarCount++;
  }
  return utf16Offset;
}

/**
 * Convert a UTF-16 code unit length to a Unicode scalar value length.
 * This is `utf16ToScalarOffset(text, utf16Start + utf16Length) - utf16ToScalarOffset(text, utf16Start)`.
 */
export function utf16ToScalarLength(text: string, utf16Start: number, utf16Length: number): number {
  return (
    utf16ToScalarOffset(text, utf16Start + utf16Length) - utf16ToScalarOffset(text, utf16Start)
  );
}
