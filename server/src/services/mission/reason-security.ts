import { encrypt, decrypt } from '../crypto.js';
import { AppError } from '../../middleware/error-handler.js';

/**
 * Cancellation reason security (VAL-RUN-138).
 *
 * A user-confirmed cancellation requires a reason that is:
 *  - NFC-normalized without semantic trimming (whitespace is preserved);
 *  - 1–2,000 Unicode code points (counted as spread code points, not
 *    UTF-16 code units, so emoji and astral characters count as one each);
 *  - encrypted at rest in the command history payload;
 *  - never included in broad events, activity, or planner context;
 *  - scanned for credential/header canaries which are irreversibly redacted
 *    before persistence.
 */

const MAX_REASON_CODEPOINTS = 2000;
const MIN_REASON_CODEPOINTS = 1;

/**
 * Patterns that look like credentials, API keys, authorization headers, or
 * PEM key blocks. Matches are irreversibly replaced with `[REDACTED]` before
 * the reason is persisted, emitted, or logged.
 */
const CANARY_PATTERNS: RegExp[] = [
  // Authorization header with Bearer token (full header including the token)
  /authorization\s*[:=]\s*bearer\s+\S+/gi,
  // Standalone Bearer token: Bearer <token>
  /bearer\s+[A-Za-z0-9._-]+/gi,
  // API keys / secrets / passwords / tokens: key=value or key: value
  /(?:api[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?key)\s*[:=]\s*\S+/gi,
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
];

/** Scan PEM delimiters once; repeated opening headers cannot cause backtracking. */
function redactPemBlocks(text: string): { redacted: string; hadCanaries: boolean } {
  const chunks: string[] = [];
  let start: number | null = null;
  let cursor = 0;
  for (const match of text.matchAll(/-----(BEGIN|END) [A-Z ]{1,64}-----/g)) {
    if (match[1] === 'BEGIN' && start === null) {
      start = match.index;
    } else if (match[1] === 'END' && start !== null) {
      chunks.push(text.slice(cursor, start), '[REDACTED]');
      cursor = match.index + match[0].length;
      start = null;
    }
  }
  if (start !== null) {
    // An incomplete pasted key is still sensitive; redact through the end.
    chunks.push(text.slice(cursor, start), '[REDACTED]');
    cursor = text.length;
  }
  const hadCanaries = chunks.length > 0;
  chunks.push(text.slice(cursor));
  return { redacted: chunks.join(''), hadCanaries };
}

/**
 * Normalize a reason string to Unicode NFC form without semantic trimming.
 * Whitespace (including leading/trailing) is preserved.
 */
export function normalizeReason(raw: string): string {
  return raw.normalize('NFC');
}

/**
 * Validate that a normalized reason has 1–2,000 Unicode code points.
 * Throws `400 VALIDATION_ERROR` on violation.
 */
export function validateReason(normalized: string): void {
  const codepoints = [...normalized].length;
  if (codepoints < MIN_REASON_CODEPOINTS || codepoints > MAX_REASON_CODEPOINTS) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Cancellation reason must be ${MIN_REASON_CODEPOINTS}–${MAX_REASON_CODEPOINTS} Unicode code points`,
    );
  }
}

/**
 * Irreversibly redact credential/header canary patterns from a reason string.
 * Returns the redacted string and whether any canaries were found.
 */
export function redactCanaries(reason: string): { redacted: string; hadCanaries: boolean } {
  let { redacted, hadCanaries } = redactPemBlocks(reason);
  for (const pattern of CANARY_PATTERNS) {
    // Reset lastIndex for global regexes.
    pattern.lastIndex = 0;
    if (pattern.test(redacted)) {
      hadCanaries = true;
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
  }
  return { redacted, hadCanaries };
}

/**
 * Encrypt a reason string for storage at rest using AES-256-GCM.
 */
export function encryptReason(reason: string): string {
  return encrypt(reason);
}

/**
 * Decrypt a reason string that was encrypted by `encryptReason`.
 */
export function decryptReason(encrypted: string): string {
  return decrypt(encrypted);
}

/**
 * Full processing pipeline for a raw cancellation reason:
 * normalize → validate → redact canaries → encrypt.
 * Returns the encrypted reason (for storage) and the redacted plaintext
 * (for hashing/idempotency).
 */
export function processReason(raw: string): { encrypted: string; redactedPlaintext: string } {
  const normalized = normalizeReason(raw);
  validateReason(normalized);
  const { redacted } = redactCanaries(normalized);
  // Re-validate after redaction in case redaction shortened below minimum.
  validateReason(redacted);
  const encrypted = encryptReason(redacted);
  return { encrypted, redactedPlaintext: redacted };
}
