/**
 * Artifact locator validation and resolution.
 *
 * (VAL-RES-026)
 *
 * Each citation must resolve to the exact artifact version and a valid JSON
 * pointer or block/range where its inline citation mark appears. A locator
 * targeting another version or an absent block is rejected atomically — no
 * partial artifact/citation rows are committed on rejection.
 *
 * An `ArtifactLocator` is `{artifactVersion, jsonPointer?, blockId?, start?,
 * end?}` and refers to the exact `artifact_revisions` row whose version
 * equals `artifactVersion`. Two resolution modes:
 *
 *  - `jsonPointer`: a RFC 6901 JSON Pointer into the artifact revision's
 *    `content` document. It must point at a citation span
 *    (`{type:'citation', citationId}`). Optional `start`/`end` may bound a
 *    range of spans within the same array.
 *  - `blockId`: a block carrying a `blockId` field that contains at least one
 *    citation span.
 *
 * This module is pure: it contains no side effects and no persistence. The
 * artifact revision `content` is supplied by the caller (the persistence
 * layer loads the exact revision and decrypts it before calling).
 */

// ---------------------------------------------------------------------------
// Locator model
// ---------------------------------------------------------------------------

export interface ArtifactLocator {
  /** Exact artifact revision version the citation is bound to. */
  artifactVersion: number;
  /** RFC 6901 JSON Pointer into the revision's content document. */
  jsonPointer?: string;
  /** Block id naming a block containing the inline citation mark. */
  blockId?: string;
  /** Optional inclusive start index for a range within a pointed array. */
  start?: number;
  /** Optional exclusive end index for a range within a pointed array. */
  end?: number;
}

// ---------------------------------------------------------------------------
// Validation result
// ---------------------------------------------------------------------------

export interface ArtifactLocatorValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// JSON Pointer (RFC 6901 subset)
// ---------------------------------------------------------------------------

/** Unsafe prototype-pollution keys rejected in JSON Pointer tokens. */
const UNSAFE_POINTER_TOKENS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Resolve a RFC 6901 JSON Pointer against a JSON document. Returns the
 * targeted value or `undefined` when the path does not exist.
 *
 * Supports `""` (whole document), `/foo`, `/foo/0`, and `/-` is not used
 * (no append semantics). Escapes `~1` → `/` and `~0` → `~`. Unsafe
 * prototype-pollution keys (`__proto__`, `prototype`, `constructor`) are
 * rejected and resolve to `undefined`.
 */
function resolveJsonPointer(pointer: string, doc: unknown): unknown {
  if (pointer === '') {
    return doc;
  }
  if (!pointer.startsWith('/')) {
    return undefined;
  }
  const parts = pointer.slice(1).split('/');
  let current: unknown = doc;
  for (const raw of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (UNSAFE_POINTER_TOKENS.has(token)) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const idx = Number(token);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        return undefined;
      }
      current = current[idx];
    } else if (typeof current === 'object' && !Array.isArray(current)) {
      current = (current as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return current;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCitationSpan(v: unknown): boolean {
  return isPlainObject(v) && v.type === 'citation' && typeof v.citationId === 'string';
}

/**
 * Whether a block (object) contains at least one citation span in any of its
 * span-bearing fields (spans, items, rows).
 */
function blockContainsCitation(block: unknown): boolean {
  if (!isPlainObject(block)) {
    return false;
  }
  const spans = block.spans;
  if (Array.isArray(spans) && spans.some(isCitationSpan)) {
    return true;
  }
  const items = block.items;
  if (Array.isArray(items)) {
    for (const item of items) {
      if (Array.isArray(item) && item.some(isCitationSpan)) {
        return true;
      }
    }
  }
  const rows = block.rows;
  if (Array.isArray(rows)) {
    for (const row of rows) {
      if (Array.isArray(row) && row.some(isCitationSpan)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate an artifact locator against the exact artifact revision's content
 * (VAL-RES-026).
 *
 * @param locator - The locator to validate.
 * @param actualVersion - The version of the artifact revision being bound.
 * @param content - The decrypted content document of that exact revision.
 */
export function validateArtifactLocator(
  locator: ArtifactLocator,
  actualVersion: number,
  content: unknown,
): ArtifactLocatorValidationResult {
  const errors: string[] = [];

  if (
    typeof locator.artifactVersion !== 'number' ||
    !Number.isInteger(locator.artifactVersion) ||
    locator.artifactVersion < 1
  ) {
    errors.push('artifactVersion must be a positive integer');
    return { valid: false, errors };
  }

  if (locator.artifactVersion !== actualVersion) {
    errors.push(
      `artifactVersion ${locator.artifactVersion} does not match exact revision version ${actualVersion}`,
    );
    return { valid: false, errors };
  }

  const hasPointer = typeof locator.jsonPointer === 'string' && locator.jsonPointer.length > 0;
  const hasBlockId = typeof locator.blockId === 'string' && locator.blockId.length > 0;

  if (!hasPointer && !hasBlockId) {
    errors.push('either jsonPointer or blockId is required');
    return { valid: false, errors };
  }

  if (hasPointer) {
    return validatePointerLocator(locator.jsonPointer as string, locator, content);
  }
  return validateBlockIdLocator(locator.blockId as string, content);
}

function validatePointerLocator(
  pointer: string,
  locator: ArtifactLocator,
  content: unknown,
): ArtifactLocatorValidationResult {
  const errors: string[] = [];
  if (!pointer.startsWith('/')) {
    errors.push('jsonPointer must start with "/"');
    return { valid: false, errors };
  }
  const target = resolveJsonPointer(pointer, content);

  if (target === undefined) {
    errors.push('jsonPointer does not resolve to an existing node');
    return { valid: false, errors };
  }

  // Range bounds: when start/end are supplied, the pointer must target an
  // array and the citation span must lie within [start, end).
  if (locator.start !== undefined || locator.end !== undefined) {
    return validateRangeLocator(target, locator.start, locator.end, errors);
  }

  if (isCitationSpan(target)) {
    return { valid: true, errors: [] };
  }
  errors.push('jsonPointer does not point at a citation span');
  return { valid: false, errors };
}

function validateRangeLocator(
  target: unknown,
  start: unknown,
  end: unknown,
  errors: string[],
): ArtifactLocatorValidationResult {
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start
  ) {
    errors.push('start/end must be integers with start < end');
    return { valid: false, errors };
  }
  if (!Array.isArray(target)) {
    errors.push('jsonPointer with start/end must target an array');
    return { valid: false, errors };
  }
  if (end > target.length) {
    errors.push('end exceeds array length');
    return { valid: false, errors };
  }
  const slice = target.slice(start as number, end as number);
  if (!slice.some(isCitationSpan)) {
    errors.push('range [start,end) does not contain a citation span');
    return { valid: false, errors };
  }
  return { valid: errors.length === 0, errors };
}

function validateBlockIdLocator(
  blockId: string,
  content: unknown,
): ArtifactLocatorValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(content) || !Array.isArray(content.blocks)) {
    errors.push('content is not an evidence document');
    return { valid: false, errors };
  }
  const block = content.blocks.find((b: unknown) => isPlainObject(b) && b.blockId === blockId);
  if (!block) {
    errors.push(`blockId "${blockId}" not found in document`);
    return { valid: false, errors };
  }
  if (!blockContainsCitation(block)) {
    errors.push(`blockId "${blockId}" does not contain a citation span`);
    return { valid: false, errors };
  }
  return { valid: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an artifact locator to the citation span it points at, or null
 * when the locator is invalid. Used by deep-link and provenance drawer
 * navigation (VAL-RES-026 positive resolution).
 */
export function resolveArtifactLocator(
  locator: ArtifactLocator,
  actualVersion: number,
  content: unknown,
): { type: 'citation'; citationId: string } | null {
  const result = validateArtifactLocator(locator, actualVersion, content);
  if (!result.valid) {
    return null;
  }
  if (typeof locator.jsonPointer === 'string' && locator.jsonPointer.length > 0) {
    if (locator.start !== undefined && locator.end !== undefined) {
      const arr = resolveJsonPointer(locator.jsonPointer, content);
      if (Array.isArray(arr)) {
        const span = arr.slice(locator.start, locator.end).find(isCitationSpan);
        return (span as { type: 'citation'; citationId: string }) ?? null;
      }
      return null;
    }
    const target = resolveJsonPointer(locator.jsonPointer, content);
    return isCitationSpan(target) ? (target as { type: 'citation'; citationId: string }) : null;
  }
  // blockId mode: return the first citation span in the block.
  if (isPlainObject(content) && Array.isArray(content.blocks) && locator.blockId) {
    const block = content.blocks.find(
      (b: unknown) => isPlainObject(b) && b.blockId === locator.blockId,
    );
    if (isPlainObject(block)) {
      if (Array.isArray(block.spans)) {
        const span = block.spans.find(isCitationSpan);
        if (span) {
          return span as { type: 'citation'; citationId: string };
        }
      }
    }
  }
  return null;
}
