/**
 * Bounded retry executor for research provider attempts.
 *
 * (architecture.md: Provider Fallback and Health, VAL-RES-007, VAL-RES-008,
 *  VAL-RES-009)
 *
 * Retries only transient network errors, HTTP 408 (timeout), and HTTP 429
 * (rate limited). Uses at most 3 attempts per provider with full-jitter
 * exponential delay starting at 500 ms and capped at 5 seconds, honoring
 * a bounded Retry-After value when present.
 *
 * Does NOT retry: ordinary 4xx, validation failures, policy denials,
 * cancellation, budget exhaustion, malformed responses, quota exhaustion,
 * credential unavailability, authentication failure, or empty results.
 * Those errors are thrown immediately after one attempt.
 */

import { isRetryable } from './classification.js';
import { ResearchProviderError, type ResearchCallContext } from './spi.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the retry executor. All values are injectable for tests. */
export interface RetryConfig {
  /** Maximum attempts per provider (default 3). */
  maxAttempts: number;
  /** Base delay in milliseconds for exponential backoff (default 500). */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds (default 5_000). */
  maxDelayMs: number;
  /**
   * Injectable sleep function. Production uses a real timer-based sleep
   * that respects AbortSignal. Tests inject an instant no-op.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Injectable random function for full-jitter (default Math.random). */
  random?: () => number;
}

/** Default retry configuration (3 attempts, 500ms base, 5s cap). */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
};

// ---------------------------------------------------------------------------
// Default sleep (real timer, abortable)
// ---------------------------------------------------------------------------

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Full-jitter exponential backoff
// ---------------------------------------------------------------------------

/**
 * Compute the full-jitter exponential backoff delay.
 *
 * Full-jitter: delay = random * min(baseDelay * 2^(attempt-1), maxDelay)
 *
 * @param attempt The attempt number that just failed (1-based).
 * @param config Retry configuration.
 */
function computeBackoffDelay(attempt: number, config: RetryConfig): number {
  const random = config.random ?? Math.random;
  const exponential = config.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(exponential, config.maxDelayMs);
  return Math.floor(random() * capped);
}

// ---------------------------------------------------------------------------
// Retry executor
// ---------------------------------------------------------------------------

/**
 * Execute a function with bounded retry.
 *
 * Retries only retryable errors (PROVIDER_TRANSIENT, PROVIDER_TIMEOUT,
 * PROVIDER_RATE_LIMITED). Non-retryable errors are thrown immediately.
 *
 * Honors a bounded Retry-After value from the error when present, falling
 * back to full-jitter exponential backoff otherwise.
 *
 * Checks for cancellation before each retry and converts AbortError to
 * CANCELLED.
 *
 * @param fn The function to execute (one provider attempt).
 * @param config Retry configuration.
 * @param context Research call context (signal for cancellation).
 * @returns The result of `fn` on success.
 * @throws ResearchProviderError on failure after exhausting retries.
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  context: ResearchCallContext,
): Promise<T> {
  const sleepFn = config.sleep ?? defaultSleep;
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    // Check cancellation before each attempt.
    if (context.signal?.aborted) {
      throw new ResearchProviderError(
        'CANCELLED',
        'Research call cancelled before attempt',
        'tavily', // provider/operation are unknown at this layer
        'search',
      );
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // If it's not a ResearchProviderError, wrap it as transient.
      if (!(err instanceof ResearchProviderError)) {
        // Non-provider errors (unexpected) — don't retry, rethrow.
        throw err;
      }

      // If not retryable, throw immediately (one attempt).
      if (!isRetryable(err.code)) {
        throw err;
      }

      // If this was the last attempt, throw the error.
      if (attempt >= config.maxAttempts) {
        throw err;
      }

      // Compute delay: honor Retry-After if present, else exponential backoff.
      const delayMs =
        err.retryAfterMs !== undefined && err.retryAfterMs > 0
          ? Math.min(err.retryAfterMs, config.maxDelayMs)
          : computeBackoffDelay(attempt, config);

      // Sleep before the next attempt, respecting cancellation.
      try {
        await sleepFn(delayMs, context.signal);
      } catch {
        // Sleep was aborted — cancellation wins.
        throw new ResearchProviderError(
          'CANCELLED',
          'Research call cancelled during retry delay',
          err.provider,
          err.operation,
        );
      }
    }
  }

  // Unreachable — the loop either returns or throws.
  throw lastError;
}
