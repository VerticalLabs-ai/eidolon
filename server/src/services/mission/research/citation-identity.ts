/**
 * Citation identity and locator resolution (VAL-RES-097, VAL-RES-113).
 *
 * A citation binds to the EXACT immutable source revision and artifact
 * revision it was created against. It never silently retargets a newer
 * source or artifact revision — a later edit either preserves a citation at
 * a verified-unchanged locator (writing a new revision-bound citation row)
 * or marks it not-carried-forward (architecture: citations never silently
 * move to a newer source).
 *
 * Repeated quotes require an unambiguous locator (VAL-RES-097): when the
 * exact quote occurs more than once in the normalized source text, the
 * citation must supply a character-offset locator that pins exactly one
 * occurrence. Without it, the citation is rejected as ambiguous.
 *
 * Frozen display metadata (VAL-RES-113): the citation captures a snapshot
 * of the source's display metadata (title, author, canonical URL, retrieval
 * time, provider) at creation time, so a historical citation view shows the
 * metadata frozen at citation time rather than the current source metadata.
 */

import {
  computeQuoteHash,
  normalizeText,
  utf16ToScalarOffset,
  scalarToUtf16Offset,
} from './source-normalization.js';

// ---------------------------------------------------------------------------
// Locator
// ---------------------------------------------------------------------------

/**
 * A character-offset locator into the normalized source revision text.
 * Offsets refer to the normalized text (NFC, LF) of the exact
 * `research_source_revision` and are expressed in Unicode scalar values
 * (not UTF-16 code units). Astral characters (emoji, etc.) count as 1
 * scalar value, not 2 UTF-16 code units.
 */
export interface CitationLocator {
  /** Inclusive start offset (Unicode scalar values into the normalized text). */
  charStart: number;
  /** Exclusive end offset (Unicode scalar values). */
  charEnd: number;
  /** Optional section/anchor label. */
  section?: string;
}

// ---------------------------------------------------------------------------
// Locator resolution (VAL-RES-097)
// ---------------------------------------------------------------------------

export type QuoteLocatorResultKind = 'unique' | 'located' | 'ambiguous' | 'rejected';

export interface QuoteLocatorResult {
  kind: QuoteLocatorResultKind;
  reason?: string;
  charStart?: number;
  charEnd?: number;
  /** Number of occurrences of the quote in the normalized text. */
  occurrences?: number;
}

/**
 * Find all occurrence offsets of `needle` in `haystack`.
 * Returns the start index of each occurrence.
 */
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
 * Resolve a quote against the normalized source text and an optional locator
 * (VAL-RES-097).
 *
 * - If the quote occurs exactly once, it is `unique` and a locator is optional.
 * - If the quote occurs more than once, a locator is REQUIRED. The locator
 *   must match the quote at the given offsets; otherwise the citation is
 *   `rejected`. A repeated quote without a locator is `ambiguous`.
 * - If the quote does not occur at all, the citation is `rejected` with
 *   `QUOTE_NOT_FOUND`.
 *
 * Both the source text and the quote are normalized (NFC, LF) before matching
 * so that equivalent representations match.
 */
export function resolveQuoteLocator(
  normalizedSourceText: string,
  quote: string,
  locator?: CitationLocator,
): QuoteLocatorResult {
  const text = normalizeText(normalizedSourceText);
  const needle = normalizeText(quote);

  if (needle.length === 0) {
    return { kind: 'rejected', reason: 'QUOTE_EMPTY' };
  }

  const occurrences = findAllOccurrences(text, needle);

  if (occurrences.length === 0) {
    return { kind: 'rejected', reason: 'QUOTE_NOT_FOUND', occurrences: 0 };
  }

  // Validate the locator range if provided.
  if (locator) {
    // Input offsets are Unicode scalar values; convert to UTF-16 for internal matching.
    const utf16Start = scalarToUtf16Offset(text, locator.charStart);
    const utf16End = scalarToUtf16Offset(text, locator.charEnd);
    // Compute the scalar-value text length for range checking.
    const scalarTextLength = utf16ToScalarOffset(text, text.length);
    if (
      !Number.isInteger(locator.charStart) ||
      !Number.isInteger(locator.charEnd) ||
      locator.charStart < 0 ||
      locator.charEnd <= locator.charStart ||
      locator.charEnd > scalarTextLength
    ) {
      return { kind: 'rejected', reason: 'LOCATOR_INVALID', occurrences: occurrences.length };
    }
    const slice = text.slice(utf16Start, utf16End);
    if (slice !== needle) {
      return {
        kind: 'rejected',
        reason: 'LOCATOR_QUOTE_MISMATCH',
        occurrences: occurrences.length,
      };
    }
    return {
      kind: 'located',
      charStart: locator.charStart,
      charEnd: locator.charEnd,
      occurrences: occurrences.length,
    };
  }

  if (occurrences.length === 1) {
    return {
      kind: 'unique',
      charStart: utf16ToScalarOffset(text, occurrences[0]),
      charEnd: utf16ToScalarOffset(text, occurrences[0] + needle.length),
      occurrences: 1,
    };
  }

  return {
    kind: 'ambiguous',
    reason: 'AMBIGUOUS_QUOTE_LOCATOR_REQUIRED',
    occurrences: occurrences.length,
  };
}

// ---------------------------------------------------------------------------
// Citation identity
// ---------------------------------------------------------------------------

/**
 * The identity of a citation, bound to an exact immutable source revision
 * and artifact revision. This is the canonical shape the persistence layer
 * stores (after encrypting restricted fields).
 */
export interface CitationIdentity {
  companyId: string;
  projectId: string;
  runId: string;
  /** Exact immutable source revision the citation is bound to. */
  sourceRevisionId: string;
  artifactId: string;
  /** Exact immutable artifact revision the citation is bound to. */
  artifactRevisionId: string;
  /** Stable ordinal within the artifact revision. */
  ordinal: number;
  /** Exact quote text (normalized). */
  quote: string;
  /** SHA-256 hash of the exact normalized quote (lowercase hex). */
  quoteHash: string;
  /** Resolved locator offsets in Unicode scalar values (required when the quote is repeated). */
  charStart?: number;
  charEnd?: number;
  section?: string;
  /** Frozen display metadata captured at citation creation (VAL-RES-113). */
  frozenTitle?: string;
  frozenAuthor?: string;
  frozenCanonicalUrl: string;
  frozenRetrievedAt: string;
  frozenProvider: string;
  frozenContentHash?: string;
}

export interface CreateCitationIdentityInput {
  companyId: string;
  projectId: string;
  runId: string;
  sourceRevisionId: string;
  artifactId: string;
  artifactRevisionId: string;
  ordinal: number;
  quote: string;
  /** Optional locator; required when the quote is repeated in the source. */
  locator?: CitationLocator;
  /** The normalized source text, required only when a locator is provided. */
  normalizedSourceText?: string;
  /** Frozen display metadata (VAL-RES-113). */
  frozenTitle?: string;
  frozenAuthor?: string;
  frozenCanonicalUrl: string;
  frozenRetrievedAt: string;
  frozenProvider: string;
  frozenContentHash?: string;
}

/**
 * Create a citation identity bound to the exact source and artifact revisions
 * (VAL-RES-097, VAL-RES-113).
 *
 * Throws when:
 * - The quote is empty.
 * - The source or artifact revision id is missing.
 * - The ordinal is negative.
 * - The quote is repeated in the source and no locator (or an invalid
 *   locator) is provided.
 */
export function createCitationIdentity(input: CreateCitationIdentityInput): CitationIdentity {
  if (!input.sourceRevisionId) {
    throw new Error('sourceRevisionId is required');
  }
  if (!input.artifactRevisionId) {
    throw new Error('artifactRevisionId is required');
  }
  if (!input.artifactId) {
    throw new Error('artifactId is required');
  }
  if (!input.frozenCanonicalUrl) {
    throw new Error('frozenCanonicalUrl is required');
  }
  if (!input.frozenRetrievedAt) {
    throw new Error('frozenRetrievedAt is required');
  }
  if (!input.frozenProvider) {
    throw new Error('frozenProvider is required');
  }

  const normalizedQuote = normalizeText(input.quote);
  if (normalizedQuote.length === 0) {
    throw new Error('quote must not be empty');
  }
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw new Error('ordinal must be a non-negative integer');
  }

  // Resolve the locator when source text is available. When a locator is
  // provided but no source text, we trust the caller-supplied offsets
  // (the persistence layer re-verifies against the stored revision).
  let charStart: number | undefined;
  let charEnd: number | undefined;
  let section: string | undefined;

  if (input.normalizedSourceText !== undefined) {
    const resolved = resolveQuoteLocator(input.normalizedSourceText, input.quote, input.locator);
    if (resolved.kind === 'rejected') {
      throw new Error(`Citation quote rejected: ${resolved.reason}`);
    }
    if (resolved.kind === 'ambiguous') {
      throw new Error(`Citation ambiguous: ${resolved.reason}`);
    }
    charStart = resolved.charStart;
    charEnd = resolved.charEnd;
    section = input.locator?.section;
  } else if (input.locator) {
    charStart = input.locator.charStart;
    charEnd = input.locator.charEnd;
    section = input.locator.section;
  } else {
    // No source text and no locator: uniqueness cannot be proven here.
    // Fail closed — the citation cannot be created without either a
    // verified-unique quote (requires source text) or an explicit locator.
    throw new Error('Citation ambiguous: AMBIGUOUS_QUOTE_LOCATOR_REQUIRED');
  }

  return {
    companyId: input.companyId,
    projectId: input.projectId,
    runId: input.runId,
    sourceRevisionId: input.sourceRevisionId,
    artifactId: input.artifactId,
    artifactRevisionId: input.artifactRevisionId,
    ordinal: input.ordinal,
    quote: normalizedQuote,
    quoteHash: computeQuoteHash(normalizedQuote),
    charStart,
    charEnd,
    section,
    frozenTitle: input.frozenTitle,
    frozenAuthor: input.frozenAuthor,
    frozenCanonicalUrl: input.frozenCanonicalUrl,
    frozenRetrievedAt: input.frozenRetrievedAt,
    frozenProvider: input.frozenProvider,
    frozenContentHash: input.frozenContentHash,
  };
}
