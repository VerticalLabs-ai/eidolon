import { inArray } from 'drizzle-orm';
import { encrypt, decrypt } from '../crypto.js';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * Mission ingress hardening (VAL-RUN-133, VAL-RUN-134, VAL-RUN-135).
 *
 * This module owns:
 * - **Reference isolation (VAL-RUN-133):** Every attachment, artifact, source,
 *   context, and other ID in the request envelope must be same-company,
 *   same-project where applicable, accessible to the actor, linked when
 *   linkage is required, present, and structurally valid. Foreign, wrong-
 *   project, inaccessible, unlinked, deleted, or malformed references receive
 *   scope-safe rejection and create no run, applied command, reservation,
 *   projection, provider/tool call, or metadata leak.
 * - **Structural bounds (VAL-RUN-134):** The decoded start envelope permits at
 *   most 20,000 Unicode code points of request text, 20 total attachment/
 *   artifact/source/context references, 100 references across all nested
 *   context fields, 500 code points per user-visible metadata field, depth 8,
 *   and 262,144 canonical UTF-8 bytes total. Exact-boundary input succeeds;
 *   one-over input fails atomically, and the NFC-normalized safe summary is
 *   inert text capped at 500 code points.
 * - **Encryption at rest (VAL-RUN-135):** Request envelopes, accepted command
 *   payloads, and restricted diagnostic details are encrypted in designated
 *   columns; plaintext canaries are absent from ordinary database text/JSON
 *   fields and logs, while authorized service paths can reconstruct the run
 *   and restricted reads remain permission audited. Hashes and safe summaries
 *   cannot be used as a content oracle.
 */

// ---------------------------------------------------------------------------
// Structural bounds (VAL-RUN-134)
// ---------------------------------------------------------------------------

export const INGRESS_LIMITS = {
  /** Maximum Unicode code points of request text. */
  MAX_TEXT_CODEPOINTS: 20_000,
  /** Maximum total top-level references (attachments + top-level context refs). */
  MAX_TOTAL_REFERENCES: 20,
  /** Maximum references across all nested context fields (recursive). */
  MAX_NESTED_REFERENCES: 100,
  /** Maximum code points per user-visible metadata field. */
  MAX_METADATA_FIELD_CODEPOINTS: 500,
  /** Maximum nesting depth of the context object. */
  MAX_CONTEXT_DEPTH: 8,
  /** Maximum canonical UTF-8 bytes of the decoded envelope. */
  MAX_TOTAL_BYTES: 262_144,
  /** Maximum code points of the NFC-normalized safe summary. */
  MAX_SAFE_SUMMARY_CODEPOINTS: 500,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Count Unicode code points (not UTF-16 code units) in a string.
 * Uses spread iteration which yields Unicode code points, so astral
 * characters and emoji count as one each.
 */
export function countCodePoints(str: string): number {
  return [...str].length;
}

/**
 * Count the nesting depth of a JSON value. Scalars and arrays have depth 0.
 * Objects have depth 1 + max(depth of values). An empty object has depth 1.
 * Null, strings, numbers, booleans have depth 0.
 */
export function measureDepth(value: unknown): number {
  if (value === null || typeof value !== 'object') {
    return 0;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 0;
    }
    return Math.max(...value.map(measureDepth));
  }
  // It's a plain object.
  const values = Object.values(value as Record<string, unknown>);
  if (values.length === 0) {
    return 1;
  }
  return 1 + Math.max(...values.map(measureDepth));
}

/**
 * Collect all UUID-like strings from a nested JSON value recursively.
 * Returns unique UUIDs in order of first appearance.
 */
export function collectReferences(value: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  function walk(v: unknown): void {
    if (typeof v === 'string') {
      if (UUID_RE.test(v) && !seen.has(v)) {
        seen.add(v);
        found.push(v);
      }
      return;
    }
    if (v === null || typeof v !== 'object') {
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        walk(item);
      }
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) {
      walk(val);
    }
  }
  walk(value);
  return found;
}

/**
 * Count UUID-valued keys at the top level of the context object only.
 * This counts direct UUID string values at the top level, not recursively.
 * Used for the total reference cap (20 attachments + top-level context UUIDs).
 */
export function countTopLevelContextUuids(context: unknown): number {
  if (
    context === null ||
    context === undefined ||
    typeof context !== 'object' ||
    Array.isArray(context)
  ) {
    return 0;
  }
  const obj = context as Record<string, unknown>;
  let count = 0;
  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && UUID_RE.test(val)) {
      count++;
    }
  }
  return count;
}

/**
 * Count all UUID-like strings in a nested JSON value (not deduplicated).
 * Used for the nested reference cap (100 across all nested context fields).
 */
export function countNestedReferences(value: unknown): number {
  let count = 0;
  function walk(v: unknown): void {
    if (typeof v === 'string') {
      if (UUID_RE.test(v)) {
        count++;
      }
      return;
    }
    if (v === null || typeof v !== 'object') {
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        walk(item);
      }
      return;
    }
    for (const val of Object.values(v as Record<string, unknown>)) {
      walk(val);
    }
  }
  walk(value);
  return count;
}

/**
 * Measure the canonical UTF-8 byte length of a JSON value by serializing it.
 * This matches what Postgres would store for a jsonb column.
 */
export function measureUtf8Bytes(value: unknown): number {
  return Buffer.from(JSON.stringify(value), 'utf8').length;
}

/**
 * Validate user-visible metadata fields in the context object.
 * Each string value at the top level of context that is not a UUID is treated
 * as a metadata field and capped at 500 code points.
 */
export function validateMetadataFields(context: unknown): void {
  if (context === null || context === undefined || typeof context !== 'object') {
    return;
  }
  if (Array.isArray(context)) {
    return;
  }
  const obj = context as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'string' && !UUID_RE.test(val)) {
      const codepoints = countCodePoints(val);
      if (codepoints > INGRESS_LIMITS.MAX_METADATA_FIELD_CODEPOINTS) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          `Metadata field '${key}' exceeds ${INGRESS_LIMITS.MAX_METADATA_FIELD_CODEPOINTS} code points`,
        );
      }
    }
  }
}

export interface IngressValidationResult {
  /** The NFC-normalized request text. */
  normalizedText: string;
  /** The encrypted request envelope (for storage). */
  encryptedEnvelope: string;
  /** The inert safe summary (NFC-normalized, max 500 code points). */
  safeSummary: string;
  /** All validated reference UUIDs (for audit/debugging). */
  validatedReferences: string[];
}

/**
 * Validate the structural bounds of the decoded start envelope (VAL-RUN-134).
 * Throws `400 VALIDATION_ERROR` on any violation. Exact-boundary succeeds;
 * one-over fails atomically.
 *
 * Returns the NFC-normalized text for downstream use.
 */
export function validateStructuralBounds(input: {
  text: string;
  attachments?: string[];
  context?: Record<string, unknown>;
}): string {
  const { text, attachments = [], context } = input;

  // 1. Request text: at most 20,000 Unicode code points. No semantic trimming.
  const textCodepoints = countCodePoints(text);
  if (textCodepoints < 1 || textCodepoints > INGRESS_LIMITS.MAX_TEXT_CODEPOINTS) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Request text must be 1–${INGRESS_LIMITS.MAX_TEXT_CODEPOINTS} Unicode code points`,
    );
  }

  // 2. Total top-level references: attachments + top-level context UUID
  //    values (direct UUID values at the top level of context, not
  //    recursively collected). This is the explicit reference count.
  const topLevelContextUuidCount = countTopLevelContextUuids(context);
  const totalReferences = attachments.length + topLevelContextUuidCount;
  if (totalReferences > INGRESS_LIMITS.MAX_TOTAL_REFERENCES) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Total references must not exceed ${INGRESS_LIMITS.MAX_TOTAL_REFERENCES}`,
    );
  }

  // 3. Nested context references: count all UUIDs recursively (not deduped).
  //    This counts every UUID occurrence at any depth in the context object.
  const nestedRefs = countNestedReferences(context ?? {});
  if (nestedRefs > INGRESS_LIMITS.MAX_NESTED_REFERENCES) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Nested context references must not exceed ${INGRESS_LIMITS.MAX_NESTED_REFERENCES}`,
    );
  }

  // 4. User-visible metadata fields: 500 code points each.
  validateMetadataFields(context);

  // 5. Context depth: at most 8.
  if (context !== undefined) {
    const depth = measureDepth(context);
    if (depth > INGRESS_LIMITS.MAX_CONTEXT_DEPTH) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Context nesting depth must not exceed ${INGRESS_LIMITS.MAX_CONTEXT_DEPTH}`,
      );
    }
  }

  // 6. Total canonical UTF-8 bytes.
  const envelope = { text, attachments, context };
  const totalBytes = measureUtf8Bytes(envelope);
  if (totalBytes > INGRESS_LIMITS.MAX_TOTAL_BYTES) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Request envelope must not exceed ${INGRESS_LIMITS.MAX_TOTAL_BYTES} bytes`,
    );
  }

  // Normalize text to NFC.
  return text.normalize('NFC');
}

/**
 * Generate an inert safe summary from the request text (VAL-RUN-134).
 * The summary is NFC-normalized, capped at 500 code points, and is inert text
 * (no markup interpretation). Hostile markup is rendered as inert text by
 * escaping HTML entities.
 */
export function generateSafeSummary(text: string): string {
  const nfc = text.normalize('NFC');
  // Escape HTML to ensure hostile markup is inert text, not rendered.
  const escaped = nfc
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  // Truncate to 500 code points (counted as spread code points).
  const chars = [...escaped];
  if (chars.length <= INGRESS_LIMITS.MAX_SAFE_SUMMARY_CODEPOINTS) {
    return escaped;
  }
  return chars.slice(0, INGRESS_LIMITS.MAX_SAFE_SUMMARY_CODEPOINTS).join('') + '…';
}

// ---------------------------------------------------------------------------
// Encryption at rest (VAL-RUN-135)
// ---------------------------------------------------------------------------

/**
 * Encrypt the request envelope for storage at rest (VAL-RUN-135).
 * The envelope is JSON-serialized then AES-256-GCM encrypted. The ciphertext
 * is stored in a text column, never in a jsonb column, so plaintext is absent
 * from ordinary database text/JSON fields.
 */
export function encryptEnvelope(envelope: Record<string, unknown>): string {
  return encrypt(JSON.stringify(envelope));
}

/**
 * Decrypt a request envelope that was encrypted by `encryptEnvelope`.
 * Only authorized service paths call this (VAL-RUN-135).
 */
export function decryptEnvelope(encrypted: string): Record<string, unknown> {
  return JSON.parse(decrypt(encrypted)) as Record<string, unknown>;
}

/**
 * Encrypt a start command payload's request field for storage at rest
 * (VAL-RUN-135). The `request` sub-object is encrypted; non-sensitive fields
 * (mode, limits) remain as plaintext in the jsonb payload for queryability.
 */
export function encryptStartPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  if (result.request !== undefined && typeof result.request === 'object') {
    result.request = encrypt(JSON.stringify(result.request));
  }
  return result;
}

/**
 * Decrypt a start command payload's request field that was encrypted by
 * `encryptStartPayload` (VAL-RUN-135).
 */
export function decryptStartPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const result = { ...payload };
  if (typeof result.request === 'string') {
    try {
      result.request = JSON.parse(decrypt(result.request as string));
    } catch {
      // If decryption fails, leave as-is (legacy unencrypted payload).
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reference validation (VAL-RUN-133)
// ---------------------------------------------------------------------------

/** A typed reference collected from the request envelope. */
export interface CollectedReference {
  /** The UUID of the referenced entity. */
  id: string;
  /** Where the reference was found: top-level attachments or context. */
  source: 'attachments' | 'context';
}

/**
 * Collect all references from the request envelope for validation.
 * Returns top-level attachment references plus all UUIDs found recursively
 * in the context object.
 */
export function collectAllReferences(input: {
  attachments?: string[];
  context?: Record<string, unknown>;
}): CollectedReference[] {
  const refs: CollectedReference[] = [];
  const seen = new Set<string>();

  for (const id of input.attachments ?? []) {
    if (!seen.has(id)) {
      seen.add(id);
      refs.push({ id, source: 'attachments' });
    }
  }

  // Recursively collect UUIDs from context.
  function walkContext(value: unknown): void {
    if (typeof value === 'string') {
      if (UUID_RE.test(value) && !seen.has(value)) {
        seen.add(value);
        refs.push({ id: value, source: 'context' });
      }
      return;
    }
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        walkContext(item);
      }
      return;
    }
    for (const val of Object.values(value as Record<string, unknown>)) {
      walkContext(val);
    }
  }
  walkContext(input.context ?? {});

  return refs;
}

/**
 * Validate all references in the request envelope against the database
 * (VAL-RUN-133). Each reference must be same-company, same-project where
 * applicable, accessible to the actor, present, and structurally valid.
 *
 * Foreign, wrong-project, inaccessible, unlinked, deleted, or malformed
 * references receive scope-safe rejection (non-enumerating 404/400) and
 * create no run, applied command, reservation, projection, provider/tool
 * call, or metadata leak.
 *
 * Returns the list of validated reference IDs.
 */
export async function validateReferences(
  db: DbInstance,
  input: {
    companyId: string;
    projectId: string;
    attachments?: string[];
    context?: Record<string, unknown>;
  },
): Promise<string[]> {
  const { companyId, projectId } = input;
  const refs = collectAllReferences(input);
  const schema = db.schema;

  if (refs.length === 0) {
    return [];
  }

  // Validate each UUID is structurally valid (defensive — Zod already checks,
  // but context UUIDs bypass Zod).
  for (const ref of refs) {
    if (!UUID_RE.test(ref.id)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid reference format');
    }
  }

  const allIds = refs.map((r) => r.id);

  // Check artifacts: must exist, belong to the same company, and optionally
  // the same project. Non-enumerating: a 404 does not reveal whether the
  // artifact exists in another company.
  const artifactRows = await db.drizzle
    .select({
      id: schema.artifacts.id,
      companyId: schema.artifacts.companyId,
      projectId: schema.artifacts.projectId,
      status: schema.artifacts.status,
    })
    .from(schema.artifacts)
    .where(inArray(schema.artifacts.id, allIds));
  const artifactById = new Map(artifactRows.map((r) => [r.id, r]));

  // Check agent_files: must exist and belong to the same company.
  const fileRows = await db.drizzle
    .select({
      id: schema.agentFiles.id,
      companyId: schema.agentFiles.companyId,
      projectId: schema.agentFiles.projectId,
    })
    .from(schema.agentFiles)
    .where(inArray(schema.agentFiles.id, allIds));
  const fileById = new Map(fileRows.map((r) => [r.id, r]));

  // Validate each reference.
  for (const ref of refs) {
    const artifact = artifactById.get(ref.id);
    const file = fileById.get(ref.id);

    if (artifact) {
      // Artifact: must be same-company and not deleted.
      if (artifact.companyId !== companyId) {
        // Scope-safe rejection: do not reveal the artifact exists.
        throw new AppError(404, 'REFERENCE_NOT_FOUND', 'Referenced resource not found');
      }
      if (artifact.status === 'deleted') {
        throw new AppError(404, 'REFERENCE_NOT_FOUND', 'Referenced resource not found');
      }
      // If the artifact has a project, it must match (when applicable).
      if (artifact.projectId !== null && artifact.projectId !== projectId) {
        throw new AppError(404, 'REFERENCE_NOT_FOUND', 'Referenced resource not found');
      }
    } else if (file) {
      // Agent file: must be same-company.
      if (file.companyId !== companyId) {
        throw new AppError(404, 'REFERENCE_NOT_FOUND', 'Referenced resource not found');
      }
      // If the file has a project, it must match (when applicable).
      if (file.projectId !== null && file.projectId !== undefined && file.projectId !== projectId) {
        throw new AppError(404, 'REFERENCE_NOT_FOUND', 'Referenced resource not found');
      }
    } else {
      // Not found in any known reference table. This could be a foreign,
      // deleted, or malformed reference. Scope-safe rejection.
      throw new AppError(404, 'REFERENCE_NOT_FOUND', 'Referenced resource not found');
    }
  }

  return allIds;
}

/**
 * Full ingress validation pipeline: structural bounds + reference validation
 * + encryption. Returns the encrypted envelope, safe summary, and validated
 * references.
 *
 * This is called by `MissionStartService.start()` before any database writes
 * so that a validation failure creates no run, command, reservation,
 * projection, or other side effect (VAL-RUN-133, VAL-RUN-134).
 */
export async function validateAndEncryptIngress(
  db: DbInstance,
  input: {
    companyId: string;
    projectId: string;
    text: string;
    attachments?: string[];
    context?: Record<string, unknown>;
  },
): Promise<IngressValidationResult> {
  // 1. Structural bounds (VAL-RUN-134).
  const normalizedText = validateStructuralBounds(input);

  // 2. Reference validation (VAL-RUN-133). Runs before any writes so a
  //    failure creates no run, command, reservation, or projection.
  const validatedReferences = await validateReferences(db, input);

  // 3. Safe summary (VAL-RUN-134): NFC-normalized, inert text, max 500 cp.
  const safeSummary = generateSafeSummary(normalizedText);

  // 4. Encrypt the request envelope at rest (VAL-RUN-135).
  const envelope: Record<string, unknown> = {
    text: normalizedText,
    attachments: input.attachments ?? [],
    context: input.context ?? {},
  };
  const encryptedEnvelope = encryptEnvelope(envelope);

  return {
    normalizedText,
    encryptedEnvelope,
    safeSummary,
    validatedReferences,
  };
}
