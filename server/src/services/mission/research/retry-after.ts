/**
 * Retry-After header parsing.
 *
 * (VAL-RES-009: Retry-After bounded)
 *
 * Parses the HTTP `Retry-After` header in both delta-seconds and HTTP-date
 * forms (RFC 7231 §7.1.3). Returns the delay in milliseconds, capped at
 * `maxDelayMs`, or `null` when the header is absent, malformed, negative,
 * or a past date (in which case the caller should use bounded local backoff).
 *
 * Excessive values are capped to `maxDelayMs` so a malicious or
 * misconfigured provider cannot create an unbounded wait.
 */

/**
 * Parse a Retry-After header value.
 *
 * @param header The raw header value (or null/undefined if absent).
 * @param now The current time (injectable for deterministic tests).
 * @param maxDelayMs The maximum delay in milliseconds (cap).
 * @returns The delay in milliseconds (0 ≤ result ≤ maxDelayMs), or null
 *          if the header is absent/malformed/negative/past.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  now: Date,
  maxDelayMs: number,
): number | null {
  if (!header || header.trim().length === 0) {
    return null;
  }

  const trimmed = header.trim();

  // Try delta-seconds form (non-negative integer).
  if (/^\d+$/.test(trimmed)) {
    const seconds = parseInt(trimmed, 10);
    if (seconds < 0) {
      return null;
    }
    const delayMs = seconds * 1000;
    return Math.min(delayMs, maxDelayMs);
  }

  // Try HTTP-date form (RFC 7231 IMF-fixdate).
  const parsed = new Date(trimmed);
  if (isNaN(parsed.getTime())) {
    return null;
  }

  const delayMs = parsed.getTime() - now.getTime();
  if (delayMs <= 0) {
    // Past or exactly now — use local backoff instead.
    return null;
  }

  return Math.min(delayMs, maxDelayMs);
}
