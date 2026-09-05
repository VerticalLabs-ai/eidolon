import { describe, expect, it, vi } from 'vitest';
import { executeWithRetry, type RetryConfig } from '../services/mission/research/retry.js';
import {
  ResearchProviderError,
  type ResearchResult,
  type ResearchCallContext,
  type ResearchOperation,
} from '../services/mission/research/spi.js';
import type { ResearchProviderName } from '../services/mission/research/origins.js';

/**
 * Retry executor tests.
 *
 * VAL-RES-007: Retryable provider failure — at most 3 attempts with bounded delay.
 * VAL-RES-008: Non-retryable — one attempt, no retry.
 * VAL-RES-009: Retry-After bounded — honored within deadlines, capped.
 * VAL-RES-090: Auth failure — one non-retried attempt.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeError(
  code: ResearchProviderError['code'],
  provider: ResearchProviderName = 'tavily',
  operation: ResearchOperation = 'search',
  retryAfterMs?: number,
): ResearchProviderError {
  return new ResearchProviderError(
    code,
    `test ${code}`,
    provider,
    operation,
    undefined,
    retryAfterMs,
  );
}

function makeSuccessResult(provider: ResearchProviderName = 'tavily'): ResearchResult {
  return {
    logicalCallId: 'call-1',
    provider,
    sources: [],
    warnings: [],
  };
}

const noSleepConfig: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  sleep: vi.fn(async () => {}),
  random: () => 0.5,
};

const baseContext: ResearchCallContext = {};

// ---------------------------------------------------------------------------
// Retryable errors (VAL-RES-007)
// ---------------------------------------------------------------------------

describe('Retry executor: retryable errors', () => {
  it('retries PROVIDER_TRANSIENT up to 3 attempts then succeeds', async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 3) {
        throw makeError('PROVIDER_TRANSIENT');
      }
      return makeSuccessResult();
    });

    const result = await executeWithRetry(fn, noSleepConfig, baseContext);
    expect(result).toEqual(makeSuccessResult());
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('retries PROVIDER_TIMEOUT (HTTP 408)', async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        throw makeError('PROVIDER_TIMEOUT');
      }
      return makeSuccessResult();
    });

    const result = await executeWithRetry(fn, noSleepConfig, baseContext);
    expect(result).toEqual(makeSuccessResult());
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries PROVIDER_RATE_LIMITED (HTTP 429)', async () => {
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        throw makeError('PROVIDER_RATE_LIMITED');
      }
      return makeSuccessResult();
    });

    const result = await executeWithRetry(fn, noSleepConfig, baseContext);
    expect(result).toEqual(makeSuccessResult());
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts when all fail with retryable error', async () => {
    const fn = vi.fn(async () => {
      throw makeError('PROVIDER_TRANSIENT');
    });

    await expect(executeWithRetry(fn, noSleepConfig, baseContext)).rejects.toMatchObject({
      code: 'PROVIDER_TRANSIENT',
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry more than maxAttempts even if error is retryable', async () => {
    const fn = vi.fn(async () => {
      throw makeError('PROVIDER_RATE_LIMITED');
    });

    await expect(executeWithRetry(fn, noSleepConfig, baseContext)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Non-retryable errors (VAL-RES-008, VAL-RES-090)
// ---------------------------------------------------------------------------

describe('Retry executor: non-retryable errors', () => {
  const nonRetryableCodes: ResearchProviderError['code'][] = [
    'PROVIDER_QUOTA_EXCEEDED',
    'PROVIDER_PERMANENT',
    'PROVIDER_AUTHENTICATION_FAILED',
    'PROVIDER_CREDENTIAL_UNAVAILABLE',
    'INVALID_REQUEST',
    'UNSUPPORTED_OPERATION',
    'MALFORMED_RESPONSE',
    'POLICY_DENIED',
    'BUDGET_EXHAUSTED',
    'CANCELLED',
    'RESEARCH_NO_USABLE_SOURCES',
  ];

  for (const code of nonRetryableCodes) {
    it(`does NOT retry ${code} — exactly one attempt`, async () => {
      const fn = vi.fn(async () => {
        throw makeError(code);
      });

      await expect(executeWithRetry(fn, noSleepConfig, baseContext)).rejects.toMatchObject({
        code,
      });
      expect(fn).toHaveBeenCalledTimes(1);
    });
  }
});

// ---------------------------------------------------------------------------
// Retry-After honoring (VAL-RES-009)
// ---------------------------------------------------------------------------

describe('Retry executor: Retry-After honoring', () => {
  it('honors retryAfterMs from the error instead of exponential backoff', async () => {
    const sleepFn = vi.fn(async () => {});
    const config: RetryConfig = { ...noSleepConfig, sleep: sleepFn };

    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        throw makeError('PROVIDER_RATE_LIMITED', 'tavily', 'search', 3_000);
      }
      return makeSuccessResult();
    });

    await executeWithRetry(fn, config, baseContext);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect((sleepFn.mock.calls[0] as unknown[])[0]).toBe(3_000);
  });

  it('caps retryAfterMs at maxDelayMs', async () => {
    const sleepFn = vi.fn(async () => {});
    const config: RetryConfig = { ...noSleepConfig, sleep: sleepFn, maxDelayMs: 2_000 };

    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        throw makeError('PROVIDER_RATE_LIMITED', 'tavily', 'search', 10_000);
      }
      return makeSuccessResult();
    });

    await executeWithRetry(fn, config, baseContext);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect((sleepFn.mock.calls[0] as unknown[])[0]).toBe(2_000);
  });

  it('uses exponential backoff when no retryAfterMs is present', async () => {
    const sleepFn = vi.fn(async () => {});
    const config: RetryConfig = {
      maxAttempts: 3,
      baseDelayMs: 500,
      maxDelayMs: 5_000,
      sleep: sleepFn,
      random: () => 0.5, // full-jitter: delay = random * min(base * 2^attempt, max)
    };

    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 3) {
        throw makeError('PROVIDER_TRANSIENT');
      }
      return makeSuccessResult();
    });

    await executeWithRetry(fn, config, baseContext);
    // Attempt 1 fails → sleep before attempt 2: random * min(500 * 2^0, 5000) = 0.5 * 500 = 250
    // Attempt 2 fails → sleep before attempt 3: random * min(500 * 2^1, 5000) = 0.5 * 1000 = 500
    expect((sleepFn.mock.calls[0] as unknown[])[0]).toBe(250);
    expect((sleepFn.mock.calls[1] as unknown[])[0]).toBe(500);
  });

  it('uses exponential backoff when retryAfterMs is undefined', async () => {
    const sleepFn = vi.fn(async () => {});
    const config: RetryConfig = { ...noSleepConfig, sleep: sleepFn };

    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        throw makeError('PROVIDER_TRANSIENT');
      } // no retryAfterMs
      return makeSuccessResult();
    });

    await executeWithRetry(fn, config, baseContext);
    // exponential backoff used: random * min(500 * 2^0, 5000) = 0.5 * 500 = 250
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect((sleepFn.mock.calls[0] as unknown[])[0]).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Cancellation (VAL-RES-012)
// ---------------------------------------------------------------------------

describe('Retry executor: cancellation', () => {
  it('does not retry CANCELLED — one attempt, rethrows immediately', async () => {
    const fn = vi.fn(async () => {
      throw makeError('CANCELLED');
    });

    await expect(executeWithRetry(fn, noSleepConfig, baseContext)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts before first attempt when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const context: ResearchCallContext = { signal: controller.signal };

    const fn = vi.fn(async () => {
      throw makeError('PROVIDER_TRANSIENT');
    });

    await expect(executeWithRetry(fn, noSleepConfig, context)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    // Signal checked before first attempt → fn never called
    expect(fn).toHaveBeenCalledTimes(0);
  });

  it('aborts retry sleep when signal aborts during sleep', async () => {
    const controller = new AbortController();
    const context: ResearchCallContext = { signal: controller.signal };

    const sleepFn = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      // Simulate the signal aborting during sleep
      controller.abort();
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
    });

    const config: RetryConfig = { ...noSleepConfig, sleep: sleepFn };
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        throw makeError('PROVIDER_TRANSIENT');
      }
      return makeSuccessResult();
    });

    await expect(executeWithRetry(fn, config, context)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// First-attempt success
// ---------------------------------------------------------------------------

describe('Retry executor: first-attempt success', () => {
  it('returns immediately on first success — one attempt, no sleep', async () => {
    const sleepFn = vi.fn(async () => {});
    const fn = vi.fn(async () => makeSuccessResult());

    const result = await executeWithRetry(fn, { ...noSleepConfig, sleep: sleepFn }, baseContext);
    expect(result).toEqual(makeSuccessResult());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });
});
