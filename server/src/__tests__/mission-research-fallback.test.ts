import { describe, expect, it, vi } from 'vitest';
import { executeWithFallback, type FallbackEntry } from '../services/mission/research/fallback.js';
import {
  ResearchProviderError,
  type ResearchProvider,
  type ResearchRequest,
  type ResearchResult,
  type ResearchCallContext,
} from '../services/mission/research/spi.js';
import { DEFAULT_FALLBACK_POLICY } from '../services/mission/research/classification.js';
import type { RetryConfig } from '../services/mission/research/retry.js';
import type { ResearchProviderName } from '../services/mission/research/origins.js';

/**
 * Fallback coordinator tests.
 *
 * VAL-RES-010: Provider timeout fallback — first provider aborts at deadline, fallback attempted.
 * VAL-RES-011: Provider quota fallback — preferred reports quota, fallback used.
 * VAL-RES-012: Fallback denial categories — invalid input, policy, cancellation, budget,
 *              unsupported operation never invoke fallback.
 * VAL-RES-090: Missing/invalid credential — credential unavailable falls back (if configured),
 *              auth failure (401/403) never falls back.
 * VAL-RES-095: Empty provider success — no usable sources falls back (if configured).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noSleepConfig: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  sleep: vi.fn(async () => {}),
  random: () => 0.5,
};

function makeProvider(
  name: ResearchProviderName,
  behavior:
    | 'success'
    | 'empty'
    | 'timeout'
    | 'quota'
    | 'transient'
    | 'auth'
    | 'credential'
    | 'permanent'
    | 'invalid'
    | 'policy'
    | 'budget'
    | 'cancelled'
    | 'unsupported'
    | ResearchProviderError,
): ResearchProvider {
  const error: ResearchProviderError =
    typeof behavior === 'string'
      ? new ResearchProviderError(
          behavior === 'timeout'
            ? 'PROVIDER_TIMEOUT'
            : behavior === 'quota'
              ? 'PROVIDER_QUOTA_EXCEEDED'
              : behavior === 'transient'
                ? 'PROVIDER_TRANSIENT'
                : behavior === 'auth'
                  ? 'PROVIDER_AUTHENTICATION_FAILED'
                  : behavior === 'credential'
                    ? 'PROVIDER_CREDENTIAL_UNAVAILABLE'
                    : behavior === 'permanent'
                      ? 'PROVIDER_PERMANENT'
                      : behavior === 'invalid'
                        ? 'INVALID_REQUEST'
                        : behavior === 'policy'
                          ? 'POLICY_DENIED'
                          : behavior === 'budget'
                            ? 'BUDGET_EXHAUSTED'
                            : behavior === 'cancelled'
                              ? 'CANCELLED'
                              : behavior === 'unsupported'
                                ? 'UNSUPPORTED_OPERATION'
                                : 'PROVIDER_TRANSIENT',
          `test ${behavior}`,
          name,
          'search',
        )
      : behavior;

  return {
    supports: () => true,
    execute: vi.fn(async (): Promise<ResearchResult> => {
      if (behavior === 'success') {
        return {
          logicalCallId: 'call-1',
          provider: name,
          sources: [
            {
              canonicalUrl: 'https://example.com',
              retrievedAt: new Date().toISOString(),
              rank: 0,
              injectionRiskLabels: [],
            },
          ],
          warnings: [],
        };
      }
      if (behavior === 'empty') {
        return {
          logicalCallId: 'call-1',
          provider: name,
          sources: [],
          warnings: [],
        };
      }
      throw error;
    }),
  };
}

function makeRequest(): ResearchRequest {
  return { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 };
}

const baseContext: ResearchCallContext = {};

function makeEntries(primary: ResearchProvider, fallback?: ResearchProvider): FallbackEntry[] {
  const entries: FallbackEntry[] = [{ provider: primary, name: 'tavily' }];
  if (fallback) {
    entries.push({ provider: fallback, name: 'firecrawl' });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Timeout fallback (VAL-RES-010)
// ---------------------------------------------------------------------------

describe('Fallback coordinator: timeout fallback', () => {
  it('falls back to next provider when primary times out (after retry exhaustion)', async () => {
    const primary = makeProvider('tavily', 'timeout');
    const fallback = makeProvider('firecrawl', 'success');
    const entries = makeEntries(primary, fallback);

    const result = await executeWithFallback(
      makeRequest(),
      entries,
      { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
      baseContext,
    );

    expect(result.provider).toBe('firecrawl');
    // PROVIDER_TIMEOUT is retryable (HTTP 408) → 3 attempts before fallback
    expect(primary.execute).toHaveBeenCalledTimes(3);
    expect(fallback.execute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Quota fallback (VAL-RES-011)
// ---------------------------------------------------------------------------

describe('Fallback coordinator: quota fallback', () => {
  it('falls back when primary reports quota exhaustion', async () => {
    const primary = makeProvider('tavily', 'quota');
    const fallback = makeProvider('firecrawl', 'success');
    const entries = makeEntries(primary, fallback);

    const result = await executeWithFallback(
      makeRequest(),
      entries,
      { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
      baseContext,
    );

    expect(result.provider).toBe('firecrawl');
    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(fallback.execute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Credential availability fallback (VAL-RES-090)
// ---------------------------------------------------------------------------

describe('Fallback coordinator: credential availability', () => {
  it('falls back when primary has no credential (PROVIDER_CREDENTIAL_UNAVAILABLE)', async () => {
    const primary = makeProvider('tavily', 'credential');
    const fallback = makeProvider('firecrawl', 'success');
    const entries = makeEntries(primary, fallback);

    const result = await executeWithFallback(
      makeRequest(),
      entries,
      { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
      baseContext,
    );

    expect(result.provider).toBe('firecrawl');
    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(fallback.execute).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back when primary returns 401 (PROVIDER_AUTHENTICATION_FAILED)', async () => {
    const primary = makeProvider('tavily', 'auth');
    const fallback = makeProvider('firecrawl', 'success');
    const entries = makeEntries(primary, fallback);

    await expect(
      executeWithFallback(
        makeRequest(),
        entries,
        { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTHENTICATION_FAILED' });

    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(fallback.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Empty results fallback (VAL-RES-095)
// ---------------------------------------------------------------------------

describe('Fallback coordinator: empty results', () => {
  it('falls back when primary returns no usable sources', async () => {
    const primary = makeProvider('tavily', 'empty');
    const fallback = makeProvider('firecrawl', 'success');
    const entries = makeEntries(primary, fallback);

    const result = await executeWithFallback(
      makeRequest(),
      entries,
      { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
      baseContext,
    );

    expect(result.provider).toBe('firecrawl');
    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(fallback.execute).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back for empty results when policy excludes empty category', async () => {
    const primary = makeProvider('tavily', 'empty');
    const fallback = makeProvider('firecrawl', 'success');
    const entries = makeEntries(primary, fallback);

    const policy = {
      allowedFallbackCategories: new Set([
        'transient',
        'timeout',
        'quota',
        'rate_limited',
        'credential_unavailable',
        'malformed',
      ] as const),
    };

    await expect(
      executeWithFallback(
        makeRequest(),
        entries,
        { fallbackPolicy: policy, retryConfig: noSleepConfig },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'RESEARCH_NO_USABLE_SOURCES' });

    expect(fallback.execute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fallback denial categories (VAL-RES-012)
// ---------------------------------------------------------------------------

describe('Fallback coordinator: denial categories never fall back', () => {
  const denialCases: Array<{
    name: string;
    behavior: 'invalid' | 'policy' | 'budget' | 'cancelled' | 'unsupported';
  }> = [
    { name: 'INVALID_REQUEST (invalid input)', behavior: 'invalid' },
    { name: 'POLICY_DENIED (policy denial)', behavior: 'policy' },
    { name: 'BUDGET_EXHAUSTED (budget)', behavior: 'budget' },
    { name: 'CANCELLED (cancellation)', behavior: 'cancelled' },
    { name: 'UNSUPPORTED_OPERATION (unsupported)', behavior: 'unsupported' },
  ];

  for (const { name, behavior } of denialCases) {
    it(`does NOT fall back for ${name}`, async () => {
      const primary = makeProvider('tavily', behavior);
      const fallback = makeProvider('firecrawl', 'success');
      const entries = makeEntries(primary, fallback);

      await expect(
        executeWithFallback(
          makeRequest(),
          entries,
          { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
          baseContext,
        ),
      ).rejects.toMatchObject({
        code:
          behavior === 'invalid'
            ? 'INVALID_REQUEST'
            : behavior === 'policy'
              ? 'POLICY_DENIED'
              : behavior === 'budget'
                ? 'BUDGET_EXHAUSTED'
                : behavior === 'cancelled'
                  ? 'CANCELLED'
                  : 'UNSUPPORTED_OPERATION',
      });

      expect(primary.execute).toHaveBeenCalledTimes(1);
      expect(fallback.execute).not.toHaveBeenCalled();
    });
  }
});

// ---------------------------------------------------------------------------
// Retry exhaustion then fallback (VAL-RES-007 + fallback)
// ---------------------------------------------------------------------------

describe('Fallback coordinator: retry exhaustion then fallback', () => {
  it('retries primary 3 times, then falls back to second provider', async () => {
    const primary: ResearchProvider = {
      supports: () => true,
      execute: vi.fn(async () => {
        throw new ResearchProviderError('PROVIDER_TRANSIENT', 'transient', 'tavily', 'search');
      }),
    };
    const fallback = makeProvider('firecrawl', 'success');
    const entries = makeEntries(primary, fallback);

    const result = await executeWithFallback(
      makeRequest(),
      entries,
      { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
      baseContext,
    );

    expect(result.provider).toBe('firecrawl');
    expect(primary.execute).toHaveBeenCalledTimes(3);
    expect(fallback.execute).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// No fallback configured
// ---------------------------------------------------------------------------

describe('Fallback coordinator: no fallback configured', () => {
  it('returns result when primary succeeds with no fallback', async () => {
    const primary = makeProvider('tavily', 'success');
    const entries = makeEntries(primary);

    const result = await executeWithFallback(
      makeRequest(),
      entries,
      { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
      baseContext,
    );

    expect(result.provider).toBe('tavily');
    expect(result.sources).toHaveLength(1);
  });

  it('throws when primary fails with no fallback', async () => {
    const primary = makeProvider('tavily', 'timeout');
    const entries = makeEntries(primary);

    await expect(
      executeWithFallback(
        makeRequest(),
        entries,
        { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  });
});

// ---------------------------------------------------------------------------
// All providers fail
// ---------------------------------------------------------------------------

describe('Fallback coordinator: all providers fail', () => {
  it('throws last error when all providers fail', async () => {
    const primary = makeProvider('tavily', 'timeout');
    const fallback = makeProvider('firecrawl', 'timeout');
    const entries = makeEntries(primary, fallback);

    await expect(
      executeWithFallback(
        makeRequest(),
        entries,
        { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
        baseContext,
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });

    // PROVIDER_TIMEOUT is retryable → 3 attempts each
    expect(primary.execute).toHaveBeenCalledTimes(3);
    expect(fallback.execute).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Logical call ID preserved across fallback (VAL-RES-011)
// ---------------------------------------------------------------------------

describe('Fallback coordinator: logical call identity', () => {
  it('preserves logicalCallId across fallback attempts', async () => {
    const primary = makeProvider('tavily', 'timeout');
    const fallback: ResearchProvider = {
      supports: () => true,
      execute: vi.fn(async (_req, ctx): Promise<ResearchResult> => {
        return {
          logicalCallId: ctx.logicalCallId ?? 'generated',
          provider: 'firecrawl' as const,
          sources: [
            {
              canonicalUrl: 'https://example.com',
              retrievedAt: new Date().toISOString(),
              rank: 0,
              injectionRiskLabels: [],
            },
          ],
          warnings: [],
        };
      }),
    };
    const entries = makeEntries(primary, fallback);

    const result = await executeWithFallback(
      makeRequest(),
      entries,
      { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
      { logicalCallId: 'shared-call-id' },
    );

    expect(result.logicalCallId).toBe('shared-call-id');
  });
});
