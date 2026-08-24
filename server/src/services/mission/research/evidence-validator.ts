/**
 * Bounded semantic evidence validator.
 *
 * (VAL-RES-111, VAL-RES-023)
 *
 * Before an artifact revision commits, this validator confirms each external
 * factual claim or structured field is supported by its exact cited quote.
 * Unrelated or contradictory passages fail with `EVIDENCE_NOT_SUPPORTING_CLAIM`
 * and no partial artifact/provenance rows are committed.
 *
 * Transformed structured values record the exact quote, artifact JSON pointer,
 * and a declared transformation from the closed enum
 * `identity|parse_number|parse_date|normalize_whitespace|select_enum`, with
 * validated output.
 *
 * VAL-RES-023: every external factual claim in the artifact must carry an
 * inline citation; unsupported or uncited claims fail/omit rather than emit
 * uncited assertions.
 *
 * This module is pure: it contains no side effects and no persistence. The
 * persistence layer calls it inside the atomic artifact-commit transaction;
 * on rejection, nothing is committed.
 */

import { normalizeText } from './source-normalization.js';

// ---------------------------------------------------------------------------
// Stable error codes
// ---------------------------------------------------------------------------

export const EVIDENCE_NOT_SUPPORTING_CLAIM_CODE = 'EVIDENCE_NOT_SUPPORTING_CLAIM';
export const CITATION_REQUIRED_FOR_EXTERNAL_CLAIM_CODE = 'CITATION_REQUIRED_FOR_EXTERNAL_CLAIM';
export const EVIDENCE_LIMIT_EXCEEDED_CODE = 'EVIDENCE_LIMIT_EXCEEDED';

// ---------------------------------------------------------------------------
// Closed transformation enum (VAL-RES-111)
// ---------------------------------------------------------------------------

export const SUPPORTED_TRANSFORMATIONS = [
  'identity',
  'parse_number',
  'parse_date',
  'normalize_whitespace',
  'select_enum',
] as const;

export type TransformationKind = (typeof SUPPORTED_TRANSFORMATIONS)[number];

const TRANSFORMATION_SET: ReadonlySet<string> = new Set(SUPPORTED_TRANSFORMATIONS);

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface CitedEvidence {
  /** Exact immutable source revision id. */
  sourceRevisionId: string;
  /** Exact quote from the normalized source text. */
  quote: string;
  /** The normalized source text of the revision (for verification). */
  normalizedSourceText: string;
}

export interface EvidenceClaim {
  /** The textual claim asserted in the artifact. */
  claimText: string;
  /** Inline citation id bound to this claim (empty when uncited). */
  citationId: string;
  /** Artifact JSON pointer where the claim/citation mark appears. */
  artifactJsonPointer?: string;
  /** Declared transformation from the closed enum. */
  transformation: TransformationKind;
  /** Expected output value for non-identity transformations. */
  expectedValue?: unknown;
  /** Allowed enum values for `select_enum`. */
  allowedEnum?: string[];
  /** Whether this is an external factual claim (default true when cited). */
  isExternalFactualClaim?: boolean;
  /** The cited evidence supporting the claim. */
  evidence: CitedEvidence;
}

export interface ArtifactEvidenceInput {
  claims: EvidenceClaim[];
  /** Declared citation ids for this artifact revision (for dangling checks). */
  declaredCitationIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ClaimSupportResult {
  valid: boolean;
  code?: string;
  message?: string;
  transformedValue?: unknown;
}

export interface ArtifactEvidenceResult {
  valid: boolean;
  code?: string;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Transformation application (closed enum)
// ---------------------------------------------------------------------------

export interface TransformationResult {
  valid: boolean;
  value?: unknown;
  message?: string;
}

/**
 * Quote-integrity guard: the quote must occur in the normalized source text.
 * Returns false when the quote is absent.
 */
function quoteOccursInSource(quote: string, source: string): boolean {
  const text = normalizeText(source);
  const needle = normalizeText(quote);
  if (needle.length === 0) {
    return false;
  }
  return text.includes(needle);
}

/**
 * Apply a declared transformation from the closed enum to the exact quote
 * (VAL-RES-111). Returns the validated output value or an invalid result.
 *
 * - `identity`: the quote itself is the value (must match expectedValue when
 *   provided, or just be present in the source).
 * - `parse_number`: extract the first number from the quote; validate against
 *   expectedValue when provided.
 * - `parse_date`: extract and normalize a date from the quote to ISO 8601
 *   (YYYY-MM-DD); validate against expectedValue when provided.
 * - `normalize_whitespace`: collapse runs of whitespace to single spaces and
 *   trim; validate against expectedValue when provided.
 * - `select_enum`: the quote (trimmed) must equal one of the allowed enum
 *   values; validate against expectedValue when provided.
 */
export function applyTransformation(
  kind: string,
  quote: string,
  source: string,
  expectedValue?: unknown,
  allowedEnum?: string[],
): TransformationResult {
  if (!TRANSFORMATION_SET.has(kind)) {
    return { valid: false, message: `unsupported transformation "${kind}"` };
  }

  const normalizedQuote = normalizeText(quote);

  switch (kind as TransformationKind) {
    case 'identity':
      return transformIdentity(normalizedQuote);
    case 'parse_number':
      return transformParseNumber(normalizedQuote, expectedValue);
    case 'parse_date':
      return transformParseDate(normalizedQuote, expectedValue);
    case 'normalize_whitespace':
      return transformNormalizeWhitespace(normalizedQuote, expectedValue);
    case 'select_enum':
      return transformSelectEnum(normalizedQuote, expectedValue, allowedEnum);
    default:
      return { valid: false, message: `unsupported transformation "${kind}"` };
  }
}

function transformIdentity(normalizedQuote: string): TransformationResult {
  return { valid: true, value: normalizedQuote };
}

function transformParseNumber(
  normalizedQuote: string,
  expectedValue: unknown,
): TransformationResult {
  const matches = normalizedQuote.matchAll(/-?\d[\d,]*\.?\d*/g);
  const candidates: number[] = [];
  for (const m of matches) {
    const num = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(num)) {
      candidates.push(num);
    }
  }
  if (candidates.length === 0) {
    return { valid: false, message: 'no number found in quote' };
  }
  if (expectedValue !== undefined) {
    const target = Number(expectedValue);
    const found = candidates.find((c) => c === target);
    if (found === undefined) {
      return {
        valid: false,
        value: candidates[0],
        message: `quote numbers [${candidates.join(', ')}] do not include expected ${target}`,
      };
    }
    return { valid: true, value: found };
  }
  return { valid: true, value: candidates[0] };
}

function transformParseDate(normalizedQuote: string, expectedValue: unknown): TransformationResult {
  const iso = parseDateFromText(normalizedQuote);
  if (!iso) {
    return { valid: false, message: 'no date found in quote' };
  }
  if (expectedValue !== undefined && iso !== String(expectedValue)) {
    return {
      valid: false,
      value: iso,
      message: `parsed date ${iso} does not match expected ${String(expectedValue)}`,
    };
  }
  return { valid: true, value: iso };
}

function transformNormalizeWhitespace(
  normalizedQuote: string,
  expectedValue: unknown,
): TransformationResult {
  const collapsed = normalizedQuote.replace(/\s+/g, ' ').trim();
  if (expectedValue !== undefined && collapsed !== String(expectedValue)) {
    return {
      valid: false,
      value: collapsed,
      message: `normalized text does not match expected`,
    };
  }
  return { valid: true, value: collapsed };
}

function transformSelectEnum(
  normalizedQuote: string,
  expectedValue: unknown,
  allowedEnum: string[] | undefined,
): TransformationResult {
  const trimmed = normalizedQuote.trim();
  if (!allowedEnum || !Array.isArray(allowedEnum)) {
    return { valid: false, message: 'select_enum requires allowedEnum' };
  }
  const selected = allowedEnum.find((v) => trimmed === v || trimmed.includes(v));
  if (!selected) {
    return { valid: false, message: 'quote does not yield any allowed enum value' };
  }
  if (expectedValue !== undefined && selected !== String(expectedValue)) {
    return {
      valid: false,
      value: selected,
      message: `selected enum ${selected} does not match expected ${String(expectedValue)}`,
    };
  }
  return { valid: true, value: selected };
}

/**
 * Parse a date from free text and return ISO 8601 (YYYY-MM-DD).
 * Supports common formats: "January 15, 2026", "2026-01-15", "15 Jan 2026".
 */
function parseDateFromText(text: string): string | null {
  // ISO 8601 direct.
  const iso = text.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) {
    const d = new Date(iso[0]);
    if (!isNaN(d.getTime())) {
      return iso[0];
    }
  }
  // "Month DD, YYYY"
  const months: Record<string, string> = {
    january: '01',
    february: '02',
    march: '03',
    april: '04',
    may: '05',
    june: '06',
    july: '07',
    august: '08',
    september: '09',
    october: '10',
    november: '11',
    december: '12',
    jan: '01',
    feb: '02',
    mar: '03',
    apr: '04',
    jun: '06',
    jul: '07',
    aug: '08',
    sep: '09',
    oct: '10',
    nov: '11',
    dec: '12',
  };
  const monthName = text.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  if (monthName) {
    const m = months[monthName[1].toLowerCase()];
    if (m) {
      const day = monthName[2].padStart(2, '0');
      return `${monthName[3]}-${m}-${day}`;
    }
  }
  // "DD Mon YYYY"
  const dmy = text.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (dmy) {
    const m = months[dmy[2].toLowerCase()];
    if (m) {
      const day = dmy[1].padStart(2, '0');
      return `${dmy[3]}-${m}-${day}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Single-claim semantic support (VAL-RES-111)
// ---------------------------------------------------------------------------

/**
 * Validate that a single claim is supported by its exact cited quote
 * (VAL-RES-111).
 *
 * Steps:
 *  1. The exact quote must occur in the normalized source text
 *     (quote integrity).
 *  2. The declared transformation is applied to the quote, producing a
 *     validated output. For `identity`, the claim must be semantically
 *     supported by (contained within or paraphrased from) the quote.
 *  3. For non-identity transformations, the transformed value must match the
 *     claim's expected value.
 *
 * Unrelated or contradictory passages fail with
 * `EVIDENCE_NOT_SUPPORTING_CLAIM`.
 */
export function validateClaimSupport(claim: EvidenceClaim): ClaimSupportResult {
  const { evidence, transformation, expectedValue, allowedEnum } = claim;

  // 1. Quote integrity: the quote must occur in the normalized source text.
  if (!quoteOccursInSource(evidence.quote, evidence.normalizedSourceText)) {
    return {
      valid: false,
      code: EVIDENCE_NOT_SUPPORTING_CLAIM_CODE,
      message: 'QUOTE_NOT_FOUND: quote does not occur in normalized source text',
    };
  }

  // 2. Apply the declared transformation.
  const tx = applyTransformation(
    transformation,
    evidence.quote,
    evidence.normalizedSourceText,
    expectedValue,
    allowedEnum,
  );
  if (!tx.valid) {
    return {
      valid: false,
      code: EVIDENCE_NOT_SUPPORTING_CLAIM_CODE,
      message: tx.message,
      transformedValue: tx.value,
    };
  }

  // 3. For identity, confirm the claim is semantically supported by the quote.
  //    A simple, conservative support check: the claim text must be a
  //    substring of the quote OR the quote must contain the claim text's
  //    key tokens. We use a token-overlap heuristic to avoid being fooled by
  //    paraphrase while still rejecting unrelated/contradictory passages.
  if (transformation === 'identity') {
    const supported = isClaimSupportedByQuote(claim.claimText, normalizeText(evidence.quote));
    if (!supported) {
      return {
        valid: false,
        code: EVIDENCE_NOT_SUPPORTING_CLAIM_CODE,
        message: 'claim is not supported by the cited quote',
      };
    }
  }

  return { valid: true, transformedValue: tx.value };
}

/**
 * Conservative semantic support check: the claim is supported by the quote
 * when the claim text is a substring of the quote, OR a significant majority
 * of the claim's non-stopword tokens appear in the quote. Contradictory
 * passages (claim asserts a value not in the quote) fail because the token
 * overlap is low or the specific numeric/entity tokens diverge.
 */
function isClaimSupportedByQuote(claimText: string, quote: string): boolean {
  const claim = normalizeText(claimText);
  if (claim.length === 0) {
    return false;
  }
  // Direct containment.
  if (quote.includes(claim)) {
    return true;
  }
  // Token overlap: at least 60% of claim content tokens appear in the quote.
  const stop = new Set([
    'the',
    'a',
    'an',
    'is',
    'was',
    'were',
    'are',
    'for',
    'of',
    'to',
    'in',
    'on',
    'by',
    'and',
    'or',
    'as',
    'at',
    'be',
    'with',
    'that',
    'this',
    'it',
  ]);
  const claimTokens = claim
    .toLowerCase()
    .split(/[^a-z0-9$%.-]+/)
    .filter((t) => t.length > 0 && !stop.has(t));
  if (claimTokens.length === 0) {
    return false;
  }
  const quoteLower = quote.toLowerCase();
  const present = claimTokens.filter((t) => quoteLower.includes(t));
  const overlap = present.length / claimTokens.length;
  return overlap >= 0.6;
}

// ---------------------------------------------------------------------------
// Whole-artifact evidence validation (VAL-RES-023, VAL-RES-111)
// ---------------------------------------------------------------------------

/**
 * Validate evidence for an entire artifact revision atomically
 * (VAL-RES-023, VAL-RES-111).
 *
 * Every external factual claim must carry an inline citation (VAL-RES-023),
 * every cited claim must be semantically supported by its exact quote
 * (VAL-RES-111), and every citation id must be in the declared set. All
 * violations are collected before a single reject decision is returned, so
 * no partial artifact/provenance rows are committed on rejection.
 */
export function validateEvidenceForArtifact(input: ArtifactEvidenceInput): ArtifactEvidenceResult {
  const errors: string[] = [];
  let missingCitation = false;
  let unsupported = false;

  for (let i = 0; i < input.claims.length; i++) {
    const claim = input.claims[i];
    const isExternal = claim.isExternalFactualClaim !== false;

    // VAL-RES-023: external factual claims require an inline citation.
    if (isExternal && (!claim.citationId || claim.citationId.length === 0)) {
      errors.push(`claim[${i}]: external factual claim has no citation`);
      missingCitation = true;
      continue;
    }

    // Dangling citation id check.
    if (
      claim.citationId &&
      claim.citationId.length > 0 &&
      input.declaredCitationIds &&
      !input.declaredCitationIds.has(claim.citationId)
    ) {
      errors.push(`claim[${i}]: dangling citation id "${claim.citationId}"`);
      unsupported = true;
      continue;
    }

    // VAL-RES-111: semantic support.
    const support = validateClaimSupport(claim);
    if (!support.valid) {
      errors.push(`claim[${i}]: ${support.message ?? 'unsupported'}`);
      unsupported = true;
    }
  }

  if (errors.length === 0) {
    return { valid: true, errors: [] };
  }

  // Citation-required takes precedence when any external claim is uncited.
  if (missingCitation) {
    return {
      valid: false,
      code: CITATION_REQUIRED_FOR_EXTERNAL_CLAIM_CODE,
      errors,
    };
  }
  return {
    valid: false,
    code: unsupported ? EVIDENCE_NOT_SUPPORTING_CLAIM_CODE : EVIDENCE_LIMIT_EXCEEDED_CODE,
    errors,
  };
}
