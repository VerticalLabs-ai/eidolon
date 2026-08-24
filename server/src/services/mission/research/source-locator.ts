/**
 * Source locator validation and exact quote integrity.
 *
 * (VAL-RES-024, VAL-RES-025)
 *
 * A web citation's source locator binds the exact quote to a position in the
 * normalized text of one exact immutable `research_source_revision`. The
 * locator carries: canonical URL, exact quote, prefix context, suffix
 * context, optional section label, and character offsets (`charStart`,
 * `charEnd`) into the normalized text.
 *
 * `validateSourceLocator` rejects invalid, out-of-range, contradictory, or
 * ambiguous locators atomically — every error is collected before a single
 * reject decision, so a caller never commits a partially-validated citation.
 *
 * `verifyQuoteIntegrity` confirms the exact quote occurs in the normalized
 * source text and that its SHA-256 quote hash matches. This is the
 * server-side locator probe used by VAL-RES-024; Phase 1 exposes no
 * full-document API.
 *
 * This module is pure: it contains no side effects and no persistence.
 */

import { computeQuoteHash, normalizeText } from './source-normalization.js';

// ---------------------------------------------------------------------------
// Bounds (VAL-RES-115 prefix/suffix byte limits)
// ---------------------------------------------------------------------------

/** Maximum prefix context, in canonical UTF-8 bytes. */
export const MAX_PREFIX_BYTES = 256;
/** Maximum suffix context, in canonical UTF-8 bytes. */
export const MAX_SUFFIX_BYTES = 256;

// ---------------------------------------------------------------------------
// Locator model
// ---------------------------------------------------------------------------

/**
 * A normalized source locator for a web citation.
 *
 * Offsets refer to the normalized text (NFC, LF) of the exact
 * `research_source_revision`. The exact quote and prefix/suffix context are
 * mandatory for unambiguous verification; `section` is optional.
 */
export interface SourceLocator {
  canonicalUrl: string;
  quote: string;
  /** Text immediately preceding the quote (normalized). */
  prefix: string;
  /** Text immediately following the quote (normalized). */
  suffix: string;
  section?: string;
  /** Inclusive start offset into the normalized source text. */
  charStart?: number;
  /** Exclusive end offset into the normalized source text. */
  charEnd?: number;
}

// ---------------------------------------------------------------------------
// Quote integrity (VAL-RES-024)
// ---------------------------------------------------------------------------

export interface QuoteIntegrityResult {
  valid: boolean;
  reason?: string;
  quoteHashMatches: boolean;
  charStart?: number;
  charEnd?: number;
  occurrences: number;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) {
    return [];
  }
  const indices: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) {
      break;
    }
    indices.push(idx);
    from = idx + 1;
  }
  return indices;
}

/**
 * Verify quote integrity (VAL-RES-024): the exact quote occurs in the
 * normalized source text and its SHA-256 quote hash matches the stored hash.
 *
 * Both the source text and the quote are normalized (NFC, LF) before
 * matching. When the quote is unique, the matched range is returned. When it
 * is repeated, the caller must supply offsets via `validateSourceLocator`.
 */
export function verifyQuoteIntegrity(
  normalizedSourceText: string,
  quote: string,
  storedQuoteHash: string,
): QuoteIntegrityResult {
  const text = normalizeText(normalizedSourceText);
  const needle = normalizeText(quote);

  if (needle.length === 0) {
    return { valid: false, reason: 'QUOTE_EMPTY', quoteHashMatches: false, occurrences: 0 };
  }

  // Hash check first: the stored hash must match a recomputed hash of the
  // normalized quote.
  const recomputed = computeQuoteHash(needle);
  const quoteHashMatches = recomputed === storedQuoteHash;

  const occurrences = findAllOccurrences(text, needle);
  if (occurrences.length === 0) {
    return {
      valid: false,
      reason: 'QUOTE_NOT_FOUND',
      quoteHashMatches,
      occurrences: 0,
    };
  }
  if (!quoteHashMatches) {
    return {
      valid: false,
      reason: 'QUOTE_HASH_MISMATCH',
      quoteHashMatches: false,
      occurrences: occurrences.length,
    };
  }

  if (occurrences.length === 1) {
    return {
      valid: true,
      quoteHashMatches: true,
      charStart: occurrences[0],
      charEnd: occurrences[0] + needle.length,
      occurrences: 1,
    };
  }

  // Repeated quote: valid hash + present, but ambiguous without offsets.
  return {
    valid: true,
    quoteHashMatches: true,
    occurrences: occurrences.length,
  };
}

// ---------------------------------------------------------------------------
// Source locator validation (VAL-RES-025)
// ---------------------------------------------------------------------------

export interface SourceLocatorValidationResult {
  valid: boolean;
  errors: string[];
  charStart?: number;
  charEnd?: number;
  occurrences: number;
}

function utf8Bytes(s: string): number {
  return Buffer.from(s, 'utf8').length;
}

/**
 * Validate a source locator against the normalized source text (VAL-RES-025).
 *
 * All checks run before a single reject decision is returned, so the result
 * is atomic: a caller never commits a partially-validated citation. The
 * validator confirms:
 *
 * - `canonicalUrl` is a non-empty string.
 * - `quote` is non-empty and within byte bounds.
 * - `prefix`/`suffix` are within 256-byte bounds.
 * - The quote occurs in the normalized source text.
 * - When the quote is repeated, offsets are required and must bracket exactly
 *   one occurrence (unambiguous). Without offsets a repeated quote is
 *   rejected as ambiguous.
 * - Offsets (when supplied) are in range, `start < end`, and the slice at
 *   `[start, end)` equals the normalized quote (no mismatch).
 * - Prefix context matches the text immediately before `charStart`.
 * - Suffix context matches the text immediately after `charEnd`.
 */
export function validateSourceLocator(
  normalizedSourceText: string,
  locator: SourceLocator,
): SourceLocatorValidationResult {
  const errors: string[] = [];
  const text = normalizeText(normalizedSourceText);
  const needle = normalizeText(locator.quote);

  validateLocatorFields(locator, needle, errors);
  if (errors.length > 0) {
    return { valid: false, errors, occurrences: 0 };
  }

  const occurrences = findAllOccurrences(text, needle);
  if (occurrences.length === 0) {
    errors.push('QUOTE_NOT_FOUND: quote does not occur in normalized source text');
    return { valid: false, errors, occurrences: 0 };
  }

  const hasOffsets = typeof locator.charStart === 'number' && typeof locator.charEnd === 'number';

  if (occurrences.length > 1 && !hasOffsets) {
    errors.push('AMBIGUOUS_QUOTE_LOCATOR_REQUIRED: repeated quote requires charStart/charEnd');
    return { valid: false, errors, occurrences: occurrences.length };
  }

  let charStart: number;
  let charEnd: number;

  if (hasOffsets) {
    const resolved = resolveOffsets(
      text,
      needle,
      locator.charStart as number,
      locator.charEnd as number,
      errors,
    );
    if (!resolved) {
      return { valid: false, errors, occurrences: occurrences.length };
    }
    charStart = resolved.charStart;
    charEnd = resolved.charEnd;
  } else {
    charStart = occurrences[0];
    charEnd = occurrences[0] + needle.length;
  }

  validateContext(text, locator.prefix, locator.suffix, charStart, charEnd, errors);

  if (errors.length > 0) {
    return { valid: false, errors, occurrences: occurrences.length };
  }
  return { valid: true, errors: [], charStart, charEnd, occurrences: occurrences.length };
}

function validateLocatorFields(locator: SourceLocator, needle: string, errors: string[]): void {
  if (typeof locator.canonicalUrl !== 'string' || locator.canonicalUrl.length === 0) {
    errors.push('canonicalUrl is required');
  }
  if (needle.length === 0) {
    errors.push('quote must not be empty');
  }
  const prefix = typeof locator.prefix === 'string' ? locator.prefix : '';
  const suffix = typeof locator.suffix === 'string' ? locator.suffix : '';
  if (utf8Bytes(prefix) > MAX_PREFIX_BYTES) {
    errors.push(`prefix exceeds ${MAX_PREFIX_BYTES} bytes`);
  }
  if (utf8Bytes(suffix) > MAX_SUFFIX_BYTES) {
    errors.push(`suffix exceeds ${MAX_SUFFIX_BYTES} bytes`);
  }
}

function resolveOffsets(
  text: string,
  needle: string,
  start: number,
  end: number,
  errors: string[],
): { charStart: number; charEnd: number } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    errors.push('charStart/charEnd must be integers');
    return null;
  }
  if (start < 0 || end > text.length) {
    errors.push('charStart/charEnd out of range');
    return null;
  }
  if (end <= start) {
    errors.push('charStart must be less than charEnd');
    return null;
  }
  if (text.slice(start, end) !== needle) {
    errors.push('LOCATOR_QUOTE_MISMATCH: offsets do not bracket the quote');
    return null;
  }
  return { charStart: start, charEnd: end };
}

function validateContext(
  text: string,
  prefix: string,
  suffix: string,
  charStart: number,
  charEnd: number,
  errors: string[],
): void {
  if (prefix && prefix.length > 0) {
    const preceding = text.slice(Math.max(0, charStart - prefix.length), charStart);
    if (preceding !== prefix) {
      errors.push('LOCATOR_PREFIX_MISMATCH: prefix does not match text before the quote');
    }
  }
  if (suffix && suffix.length > 0) {
    const following = text.slice(charEnd, charEnd + suffix.length);
    if (following !== suffix) {
      errors.push('LOCATOR_SUFFIX_MISMATCH: suffix does not match text after the quote');
    }
  }
}
