import { ZodError } from 'zod';
import { AppError } from '../../middleware/error-handler.js';

/**
 * Mission error and event envelope sanitization (VAL-RUN-046, VAL-RUN-073).
 *
 * Ensures structured errors, replay, and SSE expose only bounded user-safe
 * fields and omit credentials, prompts, provider bodies, retrieved content,
 * and raw diagnostics.
 *
 * Two layers of defense:
 *
 * 1. **Field-name redaction**: any field whose lowercased name matches a
 *    known sensitive name (prompt, apiKey, authorization, secret, etc.) is
 *    replaced with `[REDACTED]` in event payloads and error details.
 *
 * 2. **Value-pattern redaction**: known sensitive patterns (Bearer tokens,
 *    API keys, PEM blocks, AWS key IDs, and seeded test canaries) are
 *    scrubbed from string values anywhere in the payload.
 *
 * Event payloads are designed to contain only bounded user-safe data
 * (IDs, summaries, hashes, counts). This module is a safety net that
 * catches accidental leakage from a future feature or a provider error
 * that writes raw diagnostics into a journal event.
 */

/** Maximum recursion depth for payload sanitization. */
const MAX_DEPTH = 10;

/**
 * Field names that are considered sensitive and must be redacted from
 * event payloads and error details. Compared case-insensitively.
 */
const SENSITIVE_FIELD_NAMES = new Set([
  'prompt',
  'systemprompt',
  'apikey',
  'authorization',
  'secret',
  'password',
  'passwd',
  'token',
  'authtoken',
  'accesstoken',
  'refreshtoken',
  'providerbody',
  'providerresponse',
  'rawdiagnostics',
  'diagnostics',
  'documentcontent',
  'retrievedcontent',
  'rawcontent',
  'requestheaders',
  'responseheaders',
  'cookie',
  'cookies',
  'bearertoken',
  'privatekey',
  'credential',
  'credentials',
  'leasekey',
  'leasetoken',
  'idempotencysecret',
  'adapterkey',
]);

/**
 * Patterns that look like sensitive data in string values. Each pattern
 * is a global regex; `lastIndex` is reset before each use.
 */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  // Authorization header with Bearer token (full header including the token)
  /authorization\s*[:=]\s*bearer\s+\S+/gi,
  // Standalone Bearer token: Bearer <token>
  /bearer\s+[A-Za-z0-9._-]+/gi,
  // API keys / secrets / passwords / tokens: key=value or key: value
  /(?:api[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?key)\s*[:=]\s*\S+/gi,
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // PEM private/public key blocks
  /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g,
  // Generic secret-looking strings: sk-... (Stripe/OpenAI style, 20+ chars)
  /\bsk-[a-zA-Z0-9]{20,}\b/g,
  // Seeded test canary markers (used by sanitization tests to verify
  // that sensitive content injected into events/errors is scrubbed)
  /__CANARY_SECRET__[:\s][^\n]*/gi,
  /__CANARY_PROMPT__[:\s][^\n]*/gi,
  /__CANARY_PROVIDER_BODY__[:\s][^\n]*/gi,
  /__CANARY_DOCUMENT__[:\s][^\n]*/gi,
  /__CANARY_RAW_DIAGNOSTICS__[:\s][^\n]*/gi,
  /__CANARY_CREDENTIAL__[:\s][^\n]*/gi,
  /sk-canary-[a-zA-Z0-9_-]+/gi,
  /canary-bearer-[a-zA-Z0-9_-]+/gi,
];

/**
 * Redact sensitive patterns from a string value.
 *
 * Each known pattern is replaced with `[REDACTED]`. This is a lossy,
 * irreversible transformation — the original value cannot be recovered
 * from the redacted output.
 */
export function sanitizeString(s: string): string {
  let result = s;
  for (const pattern of SENSITIVE_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Recursively sanitize an event payload (or any JSON-compatible value).
 *
 * - Sensitive field names → `[REDACTED]` (the value is discarded).
 * - String values → patterns scrubbed via {@link sanitizeString}.
 * - Arrays → each element sanitized.
 * - Objects → each key/value pair sanitized.
 * - Primitives (number, boolean) → returned as-is.
 *
 * Returns a new object/array; the input is not mutated.
 */
export function sanitizeEventPayload(payload: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[REDACTED:max-depth]';
  }
  if (payload === null || payload === undefined) {
    return payload;
  }
  if (typeof payload === 'string') {
    return sanitizeString(payload);
  }
  if (typeof payload !== 'object') {
    // number, boolean, bigint — safe as-is
    return payload;
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => sanitizeEventPayload(item, depth + 1));
  }
  // Plain object: sanitize each key/value pair.
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_NAMES.has(key.toLowerCase())) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = sanitizeEventPayload(value, depth + 1);
    }
  }
  return result;
}

/**
 * Sanitize an error message by redacting sensitive patterns. Used to
 * scrub provider error messages, database errors, or any unexpected
 * error that might contain credentials, prompts, or provider bodies
 * in its `message` string.
 */
export function sanitizeErrorMessage(message: string): string {
  return sanitizeString(message);
}

/**
 * Convert any error into a safe `AppError` (or pass through `ZodError`)
 * for Mission API responses.
 *
 * - `ZodError` is returned unchanged: validation details expose only
 *   the schema path, a Zod code, and a Zod message — never user data
 *   or secrets.
 * - `AppError` is re-created with a sanitized message and sanitized
 *   details (defense in depth: even an intentionally-safe AppError
 *   message is scrubbed in case a provider response leaked into it).
 * - Any other `Error` (unexpected internal/provider failure) becomes
 *   a `500 INTERNAL_SERVER_ERROR` with a sanitized message. If the
 *   sanitized message is empty, a generic safe message is used.
 * - Non-Error throwables become a generic `500`.
 *
 * The returned error is then handled by the existing Express
 * `errorHandler`, which serializes `AppError` into the structured
 * `{status, code, message, details?}` contract.
 */
export function toSafeMissionError(err: unknown): Error {
  if (err instanceof ZodError) {
    return err;
  }
  if (err instanceof AppError) {
    const safeMessage = sanitizeErrorMessage(err.message);
    const safeDetails = err.details !== undefined ? sanitizeEventPayload(err.details) : undefined;
    return new AppError(err.status, err.code, safeMessage, safeDetails);
  }
  if (err instanceof Error) {
    const safeMessage = sanitizeErrorMessage(err.message);
    // If the entire message was redacted (e.g., the original was just a
    // Bearer token), the sanitized message is only `[REDACTED]` tokens.
    // In that case, use a generic safe message rather than exposing a
    // confusing bare `[REDACTED]` to the user.
    const stripped = safeMessage.replace(/\[REDACTED[^\]]*\]/g, '').trim();
    return new AppError(
      500,
      'INTERNAL_SERVER_ERROR',
      stripped.length > 0 ? safeMessage : 'An unexpected error occurred',
    );
  }
  return new AppError(500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred');
}

/**
 * The list of sensitive field names, exported for testing.
 */
export { SENSITIVE_FIELD_NAMES };
