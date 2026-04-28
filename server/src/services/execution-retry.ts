export const EXECUTION_RETRY_BASE_DELAY_MS = 10_000;
export const EXECUTION_RETRY_MAX_BACKOFF_MS = 300_000;
export const EXECUTION_CONTINUATION_RETRY_DELAY_MS = 1_000;
export const EXECUTION_RETRY_JITTER_MIN = 0.5;
export const EXECUTION_RETRY_JITTER_MAX = 1.5;

export function retryDelayForAttempt(attempt: number): number {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const exponent = Math.min(normalizedAttempt - 1, 16);
  const baseDelay = Math.min(
    EXECUTION_RETRY_BASE_DELAY_MS * 2 ** exponent,
    EXECUTION_RETRY_MAX_BACKOFF_MS,
  );
  const jitterFactor =
    EXECUTION_RETRY_JITTER_MIN +
    Math.random() * (EXECUTION_RETRY_JITTER_MAX - EXECUTION_RETRY_JITTER_MIN);
  return Math.min(
    Math.floor(baseDelay * jitterFactor),
    EXECUTION_RETRY_MAX_BACKOFF_MS,
  );
}

export function retryDueAt(now: Date, attempt: number): Date {
  return new Date(now.getTime() + retryDelayForAttempt(attempt));
}

export function continuationRetryDueAt(now: Date): Date {
  return new Date(now.getTime() + EXECUTION_CONTINUATION_RETRY_DELAY_MS);
}
