/**
 * Closed byte and cardinality bounds for evidence payloads.
 *
 * (VAL-RES-115)
 *
 * Canonical UTF-8 limits:
 * - Exact quote: 4,096 bytes.
 * - Prefix and suffix context: 256 bytes each.
 * - Citations per artifact revision: 500.
 * - Unique sources per run: 100.
 * - Source page records: 50.
 * - Provenance page records: 100.
 * - Aggregate citation/provenance disclosure per artifact revision: 2 MiB.
 *
 * Over-limit commits reject atomically with `EVIDENCE_LIMIT_EXCEEDED`
 * rather than truncating locators. Pagination and export preserve global
 * ordinals and cannot bypass the aggregate limit.
 *
 * This module is pure: it contains no side effects and no persistence. The
 * persistence layer calls it before committing artifact revision + citations
 * + provenance in one transaction; on rejection, nothing is committed.
 */

// ---------------------------------------------------------------------------
// Bounds constants
// ---------------------------------------------------------------------------

export const EVIDENCE_BOUNDS = {
  maxQuoteBytes: 4096,
  maxPrefixBytes: 256,
  maxSuffixBytes: 256,
  maxCitationsPerRevision: 500,
  maxUniqueSourcesPerRun: 100,
  maxSourcePageRecords: 50,
  maxProvenancePageRecords: 100,
  maxAggregateDisclosureBytes: 2 * 1024 * 1024, // 2 MiB
} as const;

/** Stable error code for any over-limit evidence payload. */
export const EVIDENCE_LIMIT_EXCEEDED_CODE = 'EVIDENCE_LIMIT_EXCEEDED';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface EvidenceBoundCheckResult {
  valid: boolean;
  code?: string;
  message?: string;
}

export interface EvidenceBoundsInput {
  /** Number of citations in the artifact revision. */
  citationCount: number;
  /** Number of unique source revisions referenced by the run. */
  uniqueSourceCount: number;
  /** Aggregate citation/provenance disclosure size in UTF-8 bytes. */
  aggregateDisclosureBytes: number;
  /** Per-citation quote/prefix/suffix for per-citation byte checks. */
  citations: Array<{ quote: string; prefix: string; suffix: string }>;
}

export interface EvidenceBoundsValidationResult {
  valid: boolean;
  code?: string;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utf8Bytes(s: string): number {
  return Buffer.from(s, 'utf8').length;
}

function fail(message: string): EvidenceBoundCheckResult {
  return { valid: false, code: EVIDENCE_LIMIT_EXCEEDED_CODE, message };
}

// ---------------------------------------------------------------------------
// Per-citation bounds
// ---------------------------------------------------------------------------

/**
 * Check the per-citation quote/prefix/suffix byte bounds.
 * Each is measured in canonical UTF-8 bytes.
 */
export function checkQuoteBounds(
  quote: string,
  prefix = '',
  suffix = '',
): EvidenceBoundCheckResult {
  if (utf8Bytes(quote) > EVIDENCE_BOUNDS.maxQuoteBytes) {
    return fail(
      `quote is ${utf8Bytes(quote)} bytes, exceeding max ${EVIDENCE_BOUNDS.maxQuoteBytes}`,
    );
  }
  if (utf8Bytes(prefix) > EVIDENCE_BOUNDS.maxPrefixBytes) {
    return fail(
      `prefix is ${utf8Bytes(prefix)} bytes, exceeding max ${EVIDENCE_BOUNDS.maxPrefixBytes}`,
    );
  }
  if (utf8Bytes(suffix) > EVIDENCE_BOUNDS.maxSuffixBytes) {
    return fail(
      `suffix is ${utf8Bytes(suffix)} bytes, exceeding max ${EVIDENCE_BOUNDS.maxSuffixBytes}`,
    );
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Cardinality bounds
// ---------------------------------------------------------------------------

export function checkCitationCount(count: number): EvidenceBoundCheckResult {
  if (count > EVIDENCE_BOUNDS.maxCitationsPerRevision) {
    return fail(
      `citation count ${count} exceeds max ${EVIDENCE_BOUNDS.maxCitationsPerRevision} per revision`,
    );
  }
  return { valid: true };
}

export function checkUniqueSourceCount(count: number): EvidenceBoundCheckResult {
  if (count > EVIDENCE_BOUNDS.maxUniqueSourcesPerRun) {
    return fail(
      `unique source count ${count} exceeds max ${EVIDENCE_BOUNDS.maxUniqueSourcesPerRun} per run`,
    );
  }
  return { valid: true };
}

export function checkAggregateDisclosureBytes(bytes: number): EvidenceBoundCheckResult {
  if (bytes > EVIDENCE_BOUNDS.maxAggregateDisclosureBytes) {
    return fail(
      `aggregate disclosure ${bytes} bytes exceeds max ${EVIDENCE_BOUNDS.maxAggregateDisclosureBytes}`,
    );
  }
  return { valid: true };
}

export type PageKind = 'source' | 'provenance';

export function checkPageBounds(kind: PageKind, recordCount: number): EvidenceBoundCheckResult {
  const max =
    kind === 'source'
      ? EVIDENCE_BOUNDS.maxSourcePageRecords
      : EVIDENCE_BOUNDS.maxProvenancePageRecords;
  if (recordCount > max) {
    return fail(`${kind} page record count ${recordCount} exceeds max ${max}`);
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Atomic aggregate validation
// ---------------------------------------------------------------------------

/**
 * Validate all evidence bounds for a pending artifact-revision commit
 * atomically (VAL-RES-115). Every violation is collected before a single
 * reject decision is returned, so the caller never commits a partially
 * bounded payload. The result carries the stable `EVIDENCE_LIMIT_EXCEEDED`
 * code on any violation.
 */
export function validateEvidenceBounds(input: EvidenceBoundsInput): EvidenceBoundsValidationResult {
  const errors: string[] = [];

  for (let i = 0; i < input.citations.length; i++) {
    const c = input.citations[i];
    const r = checkQuoteBounds(c.quote, c.prefix, c.suffix);
    if (!r.valid && r.message) {
      errors.push(`citation[${i}]: ${r.message}`);
    }
  }

  const cc = checkCitationCount(input.citationCount);
  if (!cc.valid && cc.message) {
    errors.push(cc.message);
  }

  const sc = checkUniqueSourceCount(input.uniqueSourceCount);
  if (!sc.valid && sc.message) {
    errors.push(sc.message);
  }

  const ac = checkAggregateDisclosureBytes(input.aggregateDisclosureBytes);
  if (!ac.valid && ac.message) {
    errors.push(ac.message);
  }

  if (errors.length === 0) {
    return { valid: true, errors: [] };
  }
  return { valid: false, code: EVIDENCE_LIMIT_EXCEEDED_CODE, errors };
}
