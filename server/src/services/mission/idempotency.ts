import { AppError } from '../../middleware/error-handler.js';
import { canonicalHash } from './policy.js';

/**
 * Shared idempotency-key validation and command request hashing.
 *
 * Every Mission mutation requires an `Idempotency-Key` header. This module is
 * the single source of truth for the key syntax/length contract and for the
 * canonical hash of a run-scoped command's logical content, so that the
 * canonical command endpoint and every convenience route share one
 * idempotency namespace and one replay/conflict behavior.
 */

/**
 * Validate the `Idempotency-Key` header: 1-128 safe characters, no control
 * characters, no leading/trailing whitespace. Missing or invalid →
 * `400 VALIDATION_ERROR`. Returns the validated key.
 *
 * This is enforced BEFORE any command, state, event, budget, or output
 * change (VAL-RUN-114).
 */
export function validateIdempotencyKey(raw: string | undefined): string {
  if (!raw || raw.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required');
  }
  const key = raw;
  if (key.length > 128) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key must be at most 128 characters');
  }
  if (key !== key.trim()) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key must not have leading or trailing whitespace',
    );
  }
  // eslint-disable-next-line no-control-regex -- intentional: reject control chars
  if (/[\u0000-\u001F\u007F]/.test(key)) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Idempotency-Key must not contain control characters',
    );
  }
  return key;
}

/**
 * Normalize a command body by recursively stripping `undefined` values so
 * that omitted optional fields produce the same canonical form regardless
 * of whether the key is present with `undefined` or absent entirely. This
 * ensures canonical and convenience routes normalize omitted optional
 * fields identically before hashing.
 */
export function normalizeCommandBody(body: unknown): Record<string, unknown> {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined) {
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const nested = normalizeCommandBody(value);
      // Only include the nested object if it has keys after normalization.
      if (Object.keys(nested).length > 0) {
        result[key] = nested;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * The canonical SHA-256 hash of a run-scoped command's logical content
 * `{type, body}`. The canonical and convenience routes map to the same
 * logical `{type, body}` shape, so identical logical content produces the
 * same hash and replays; changed discriminated content under the same key
 * returns `409 IDEMPOTENCY_KEY_REUSED` (VAL-RUN-115).
 *
 * The body is normalized (undefined values stripped) before hashing so that
 * omitted optional fields produce the same hash across routes.
 */
export function commandRequestHash(type: string, body: unknown): string {
  const normalized = normalizeCommandBody(body);
  return canonicalHash({ type, body: normalized });
}
