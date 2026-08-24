/**
 * Closed `EvidenceDocumentV1` schema for citation-bearing artifact content.
 *
 * (VAL-RES-114)
 *
 * Phase 1 citation-bearing content is `EvidenceDocumentV1`: ordered heading,
 * paragraph, list, table, quote, and code blocks containing text spans and
 * inline citation marks `{citationId}` only. Scripts, raw HTML, embeds,
 * style, unknown nodes/marks, and dangling citation IDs are rejected.
 *
 * Canonical serialization preserves block/span/array order with recursively
 * sorted object keys, so two structurally-equal documents with different key
 * insertion order produce identical canonical UTF-8 bytes (stable hashing).
 *
 * Only the `document` artifact type may carry inline citations in Phase 1;
 * other artifact types (`sheet`, `board`, `slide_deck`, `timeline`,
 * `gallery`, `dashboard`, `app`, `code`) cannot receive inline citations.
 *
 * This module is pure: it contains no side effects and no persistence. It is
 * the single source of truth for evidence-document shape validation and
 * canonicalization.
 */

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

export const EVIDENCE_DOCUMENT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Artifact types that may carry inline citations (VAL-RES-114)
// ---------------------------------------------------------------------------

/** All artifact type enum values from packages/db schema. */
export const ARTIFACT_TYPES = [
  'document',
  'sheet',
  'board',
  'slide_deck',
  'timeline',
  'gallery',
  'dashboard',
  'app',
  'code',
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Types permitted to carry inline citation marks. */
const CITATION_BEARING_TYPES: ReadonlySet<ArtifactType> = new Set<ArtifactType>(['document']);

/**
 * Whether a given artifact type may carry inline citations in Phase 1.
 * Unknown type strings return false.
 */
export function isCitationBearingArtifactType(type: string): boolean {
  return CITATION_BEARING_TYPES.has(type as ArtifactType);
}

// ---------------------------------------------------------------------------
// Document model
// ---------------------------------------------------------------------------

/** A text span or inline citation mark within a block. */
export type TextSpan = { type: 'text'; text: string } | { type: 'citation'; citationId: string };

/** Supported block types. */
export type EvidenceBlock =
  | { type: 'heading'; level: number; spans: TextSpan[] }
  | { type: 'paragraph'; spans: TextSpan[] }
  | { type: 'list'; ordered: boolean; items: TextSpan[][] }
  | { type: 'table'; rows: TextSpan[][] }
  | { type: 'quote'; spans: TextSpan[] }
  | { type: 'code'; language?: string; text: string };

/** The closed evidence document. */
export interface EvidenceDocumentV1 {
  schemaVersion: number;
  blocks: EvidenceBlock[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface EvidenceDocumentValidationResult {
  valid: boolean;
  errors: string[];
}

/** Keys allowed on each block type (beyond `type`). */
const ALLOWED_BLOCK_KEYS: Record<string, ReadonlySet<string>> = {
  heading: new Set(['type', 'level', 'spans']),
  paragraph: new Set(['type', 'spans']),
  list: new Set(['type', 'ordered', 'items']),
  table: new Set(['type', 'rows']),
  quote: new Set(['type', 'spans']),
  code: new Set(['type', 'language', 'text']),
};

const ALLOWED_SPAN_KEYS: Record<string, ReadonlySet<string>> = {
  text: new Set(['type', 'text']),
  citation: new Set(['type', 'citationId']),
};

const SUPPORTED_BLOCK_TYPES = new Set(Object.keys(ALLOWED_BLOCK_KEYS));
const SUPPORTED_SPAN_TYPES = new Set(Object.keys(ALLOWED_SPAN_KEYS));

export interface ValidateEvidenceDocumentOptions {
  /**
   * The set of declared citation IDs for this artifact revision. When
   * provided, any citation mark referencing an id not in this set is
   * rejected as dangling (VAL-RES-114).
   */
  declaredCitationIds?: Set<string>;
}

/**
 * Validate an `EvidenceDocumentV1` against the closed schema.
 *
 * Rejects:
 * - Wrong schemaVersion.
 * - Unknown block/span types.
 * - Unexpected keys on any node (html, script, style, embed, onClick, …).
 * - Missing/empty citationId on a citation mark.
 * - Invalid heading level.
 * - Non-array spans/items/rows.
 * - Dangling citation IDs (when `declaredCitationIds` is supplied).
 */
export function validateEvidenceDocument(
  doc: unknown,
  options: ValidateEvidenceDocumentOptions = {},
): EvidenceDocumentValidationResult {
  const errors: string[] = [];
  const push = (msg: string): void => {
    errors.push(msg);
  };

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { valid: false, errors: ['document must be an object'] };
  }

  const d = doc as Record<string, unknown>;
  if (d.schemaVersion !== EVIDENCE_DOCUMENT_SCHEMA_VERSION) {
    push(
      `schemaVersion must be ${EVIDENCE_DOCUMENT_SCHEMA_VERSION}, got ${String(d.schemaVersion)}`,
    );
  }

  const blocks = d.blocks;
  if (!Array.isArray(blocks)) {
    push('blocks must be an array');
    return { valid: false, errors };
  }

  blocks.forEach((block, i) => {
    validateBlock(block, i, options, push);
  });

  return { valid: errors.length === 0, errors };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateBlock(
  block: unknown,
  index: number,
  options: ValidateEvidenceDocumentOptions,
  push: (msg: string) => void,
): void {
  const path = `blocks[${index}]`;
  if (!isPlainObject(block)) {
    push(`${path}: block must be an object`);
    return;
  }
  const type = block.type;
  if (typeof type !== 'string' || !SUPPORTED_BLOCK_TYPES.has(type)) {
    push(`${path}: unsupported block type "${String(type)}"`);
    return;
  }
  const allowed = ALLOWED_BLOCK_KEYS[type];
  for (const key of Object.keys(block)) {
    if (!allowed.has(key)) {
      push(`${path}: unexpected key "${key}" on block type "${type}"`);
    }
  }

  validateTypedBlock(type as string, block, path, options, push);
}

function validateTypedBlock(
  type: string,
  block: Record<string, unknown>,
  path: string,
  options: ValidateEvidenceDocumentOptions,
  push: (msg: string) => void,
): void {
  if (type === 'heading') {
    validateHeadingBlock(block, path, options, push);
  } else if (type === 'paragraph' || type === 'quote') {
    validateSpans(block.spans, `${path}.spans`, options, push);
  } else if (type === 'list') {
    validateListBlock(block, path, options, push);
  } else if (type === 'table') {
    validateTableBlock(block, path, options, push);
  } else if (type === 'code') {
    validateCodeBlock(block, path, push);
  }
}

function validateHeadingBlock(
  block: Record<string, unknown>,
  path: string,
  options: ValidateEvidenceDocumentOptions,
  push: (msg: string) => void,
): void {
  const level = block.level;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) {
    push(`${path}: heading level must be an integer 1-6`);
  }
  validateSpans(block.spans, `${path}.spans`, options, push);
}

function validateListBlock(
  block: Record<string, unknown>,
  path: string,
  options: ValidateEvidenceDocumentOptions,
  push: (msg: string) => void,
): void {
  if (typeof block.ordered !== 'boolean') {
    push(`${path}: list.ordered must be a boolean`);
  }
  const items = block.items;
  if (!Array.isArray(items)) {
    push(`${path}: list.items must be an array`);
    return;
  }
  items.forEach((item, j) => {
    if (!Array.isArray(item)) {
      push(`${path}.items[${j}]: must be an array of spans`);
      return;
    }
    validateSpans(item, `${path}.items[${j}]`, options, push);
  });
}

function validateTableBlock(
  block: Record<string, unknown>,
  path: string,
  options: ValidateEvidenceDocumentOptions,
  push: (msg: string) => void,
): void {
  const rows = block.rows;
  if (!Array.isArray(rows)) {
    push(`${path}: table.rows must be an array`);
    return;
  }
  rows.forEach((row, j) => {
    if (!Array.isArray(row)) {
      push(`${path}.rows[${j}]: must be an array of spans`);
      return;
    }
    validateSpans(row, `${path}.rows[${j}]`, options, push);
  });
}

function validateCodeBlock(
  block: Record<string, unknown>,
  path: string,
  push: (msg: string) => void,
): void {
  if (block.language !== undefined && typeof block.language !== 'string') {
    push(`${path}: code.language must be a string when present`);
  }
  if (typeof block.text !== 'string') {
    push(`${path}: code.text must be a string`);
  }
}

function validateSpans(
  spans: unknown,
  path: string,
  options: ValidateEvidenceDocumentOptions,
  push: (msg: string) => void,
): void {
  if (!Array.isArray(spans)) {
    push(`${path}: must be an array of spans`);
    return;
  }
  spans.forEach((span, i) => {
    const p = `${path}[${i}]`;
    if (!isPlainObject(span)) {
      push(`${p}: span must be an object`);
      return;
    }
    const type = span.type;
    if (typeof type !== 'string' || !SUPPORTED_SPAN_TYPES.has(type)) {
      push(`${p}: unsupported span type "${String(type)}"`);
      return;
    }
    const allowed = ALLOWED_SPAN_KEYS[type];
    for (const key of Object.keys(span)) {
      if (!allowed.has(key)) {
        push(`${p}: unexpected key "${key}" on span type "${type}"`);
      }
    }
    if (type === 'text') {
      if (typeof span.text !== 'string') {
        push(`${p}: text.text must be a string`);
      }
    } else if (type === 'citation') {
      const id = span.citationId;
      if (typeof id !== 'string' || id.length === 0) {
        push(`${p}: citation.citationId must be a non-empty string`);
        return;
      }
      if (options.declaredCitationIds && !options.declaredCitationIds.has(id)) {
        push(`${p}: dangling citation id "${id}" (not in declared set)`);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Canonical serialization (sorted keys, preserved array order)
// ---------------------------------------------------------------------------

/**
 * Recursively sort object keys, preserving array order, then serialize to a
 * canonical UTF-8 string with no inserted whitespace. Two structurally-equal
 * documents with different key insertion order produce identical bytes.
 */
export function canonicalizeEvidenceDocument(doc: EvidenceDocumentV1): string {
  return JSON.stringify(canonicalize(doc));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalize(obj[key]);
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Citation ID extraction (for dangling-id checks and required-citation checks)
// ---------------------------------------------------------------------------

/**
 * Extract all citation IDs referenced by inline citation marks in the
 * document, in reading (document) order. Useful for required-citation and
 * dangling-id validation against the declared set.
 */
export function extractCitationIds(doc: EvidenceDocumentV1): string[] {
  const ids: string[] = [];
  for (const block of doc.blocks) {
    switch (block.type) {
      case 'heading':
      case 'paragraph':
      case 'quote':
        collectFromSpans(block.spans, ids);
        break;
      case 'list':
        for (const item of block.items) {
          collectFromSpans(item, ids);
        }
        break;
      case 'table':
        for (const row of block.rows) {
          collectFromSpans(row, ids);
        }
        break;
      case 'code':
        break;
    }
  }
  return ids;
}

function collectFromSpans(spans: TextSpan[], ids: string[]): void {
  for (const span of spans) {
    if (span.type === 'citation') {
      ids.push(span.citationId);
    }
  }
}
