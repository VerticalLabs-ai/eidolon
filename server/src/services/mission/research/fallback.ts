/**
 * Policy-safe fallback coordinator for research provider execution.
 *
 * (architecture.md: Provider Fallback and Health, VAL-RES-010, VAL-RES-011,
 *  VAL-RES-012, VAL-RES-090, VAL-RES-095)
 *
 * Orchestrates provider execution with bounded retry per provider and
 * policy-safe fallback between providers. The coordinator:
 *
 * - Tries each provider in order with bounded retry (via executeWithRetry).
 * - Falls back to the next provider only when the error is fallback-eligible
 *   per the policy (transient after retry exhaustion, timeout, quota,
 *   credential unavailable, malformed, empty results).
 * - NEVER falls back for permanent denials: invalid input, unsupported
 *   operation, policy denial, cancellation, budget exhaustion, or
 *   authentication failure (401/403).
 * - Preserves one logical call ID across all provider attempts.
 * - Handles empty provider success (HTTP 200 with no usable sources) as
 *   a fallback-eligible condition (RESEARCH_NO_USABLE_SOURCES).
 *
 * The fallback policy is not injectable from user/company/agent/mode
 * configuration — it is a closed, server-enforced decision. Tests may
 * inject transport, sleep, and randomness, but cannot override policy
 * decisions or production origins.
 */

import { randomUUID } from 'node:crypto';
import {
  type ResearchProvider,
  type ResearchRequest,
  type ResearchResult,
  type ResearchCallContext,
  ResearchProviderError,
} from './spi.js';
import type { ResearchProviderName } from './origins.js';
import { isFallbackEligible, isFallbackDenied, type FallbackPolicy } from './classification.js';
import { executeWithRetry, type RetryConfig, DEFAULT_RETRY_CONFIG } from './retry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A provider entry in the fallback chain. */
export interface FallbackEntry {
  /** The provider adapter. */
  provider: ResearchProvider;
  /** The provider name (for error reporting and result attribution). */
  name: ResearchProviderName;
}

/** Configuration for the fallback coordinator. */
export interface FallbackConfig {
  /** The fallback policy (which categories may trigger fallback). */
  fallbackPolicy: FallbackPolicy;
  /** Retry configuration per provider. */
  retryConfig?: RetryConfig;
  /**
   * Optional hooks for audit/event emission (VAL-CROSS-033).
   * The coordinator calls these at provider-attempt, fallback,
   * success, and failure points. Hooks must not throw or block;
   * errors from hooks are swallowed to avoid disrupting execution.
   */
  hooks?: FallbackHooks;
}

/**
 * Audit hooks for the fallback coordinator (VAL-CROSS-033).
 *
 * These hooks let the caller emit ordered run-journal events for
 * provider attempts, fallbacks, successes, and failures without
 * coupling the coordinator to the database. The coordinator calls
 * them at well-defined points in the execution sequence. Hooks are
 * async so the caller can persist events durably before execution
 * continues. Hook errors are swallowed to avoid disrupting execution.
 */
export interface FallbackHooks {
  /** Called before each physical provider attempt (including retries). */
  onProviderAttempt?: (info: {
    provider: ResearchProviderName;
    attempt: number;
    isFallback: boolean;
  }) => Promise<void>;
  /** Called when falling back from one provider to the next. */
  onProviderFallback?: (info: {
    fromProvider: ResearchProviderName;
    toProvider: ResearchProviderName;
    reason: string;
  }) => Promise<void>;
  /** Called when a provider attempt succeeds. */
  onProviderSuccess?: (info: { provider: ResearchProviderName }) => Promise<void>;
  /** Called when a provider fails permanently (no more fallback). */
  onProviderFailure?: (info: {
    provider: ResearchProviderName;
    code: string;
    message: string;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Empty results detection (VAL-RES-095)
// ---------------------------------------------------------------------------

/**
 * Check whether a successful provider result has no usable sources.
 * Returns a RESEARCH_NO_USABLE_SOURCES error if so, null otherwise.
 */
function checkEmptyResult(
  result: ResearchResult,
  provider: ResearchProviderName,
  operation: ResearchRequest['operation'],
): ResearchProviderError | null {
  if (result.sources.length === 0) {
    return new ResearchProviderError(
      'RESEARCH_NO_USABLE_SOURCES',
      `Provider ${provider} returned no usable sources for ${operation}`,
      provider,
      operation,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fallback coordinator
// ---------------------------------------------------------------------------

/**
 * Execute a research request with bounded retry and policy-safe fallback.
 *
 * Tries each provider in order. For each provider, applies bounded retry
 * (via executeWithRetry). If a provider fails with a fallback-eligible
 * error, falls back to the next provider. If a provider fails with a
 * permanent denial (invalid input, policy, cancellation, budget,
 * unsupported, auth failure), the error is thrown immediately without
 * fallback.
 *
 * If a provider succeeds but returns no usable sources (empty results),
 * the coordinator treats this as a fallback-eligible condition and
 * tries the next provider if the policy allows.
 *
 * @param request The research request.
 * @param providers Ordered list of provider entries (primary first).
 * @param config Fallback and retry configuration.
 * @param context Research call context (signal, logicalCallId).
 * @returns The result from the first successful provider.
 * @throws ResearchProviderError on failure.
 */
/** Safely call an async hook, swallowing errors (VAL-CROSS-033). */
async function safeHook(fn: (() => Promise<void>) | undefined): Promise<void> {
  if (!fn) {
    return;
  }
  try {
    await fn();
  } catch {
    // Hooks must never disrupt execution.
  }
}

/** Emit a provider attempt hook (VAL-CROSS-033). */
async function emitAttemptHook(
  hooks: FallbackHooks | undefined,
  provider: ResearchProviderName,
  attempt: number,
  isFallback: boolean,
): Promise<void> {
  await safeHook(
    hooks?.onProviderAttempt
      ? () => hooks.onProviderAttempt!({ provider, attempt, isFallback })
      : undefined,
  );
}

/** Emit a provider fallback hook (VAL-CROSS-033). */
async function emitFallbackHook(
  hooks: FallbackHooks | undefined,
  fromProvider: ResearchProviderName,
  toProvider: ResearchProviderName,
  reason: string,
): Promise<void> {
  await safeHook(
    hooks?.onProviderFallback
      ? () => hooks.onProviderFallback!({ fromProvider, toProvider, reason })
      : undefined,
  );
}

/** Emit a provider failure hook (VAL-CROSS-033). */
async function emitFailureHook(
  hooks: FallbackHooks | undefined,
  provider: ResearchProviderName,
  code: string,
  message: string,
): Promise<void> {
  await safeHook(
    hooks?.onProviderFailure
      ? () => hooks.onProviderFailure!({ provider, code, message })
      : undefined,
  );
}

/** Emit a provider success hook (VAL-CROSS-033). */
async function emitSuccessHook(
  hooks: FallbackHooks | undefined,
  provider: ResearchProviderName,
): Promise<void> {
  await safeHook(
    hooks?.onProviderSuccess ? () => hooks.onProviderSuccess!({ provider }) : undefined,
  );
}

export async function executeWithFallback(
  request: ResearchRequest,
  providers: FallbackEntry[],
  config: FallbackConfig,
  context: ResearchCallContext,
): Promise<ResearchResult> {
  const retryConfig = config.retryConfig ?? DEFAULT_RETRY_CONFIG;
  const hooks = config.hooks;
  const logicalCallId = context.logicalCallId ?? randomUUID();

  let lastError: ResearchProviderError | null = null;

  for (let i = 0; i < providers.length; i++) {
    const entry = providers[i]!;
    const isLast = i === providers.length - 1;
    const isFallback = i > 0;

    // Cancellation fence (VAL-RES-061, VAL-RES-094): check the caller's
    // AbortSignal before each provider attempt. If cancellation arrived
    // between providers (during a fallback gap), no further provider
    // attempt or fallback may start. This is complementary to the
    // per-attempt check inside executeWithRetry.
    if (context.signal?.aborted) {
      throw new ResearchProviderError(
        'CANCELLED',
        'Research call cancelled before provider attempt',
        entry.name,
        request.operation,
      );
    }

    // Build a context with the shared logical call ID.
    const providerContext: ResearchCallContext = {
      ...context,
      logicalCallId,
    };

    // Track attempt count for this provider for audit hooks.
    let providerAttemptCount = 0;

    try {
      const result = await executeWithRetry(
        async () => {
          providerAttemptCount++;
          await emitAttemptHook(hooks, entry.name, providerAttemptCount, isFallback);
          return entry.provider.execute(request, providerContext);
        },
        retryConfig,
        providerContext,
      );

      // Check for empty results (VAL-RES-095).
      const emptyError = checkEmptyResult(result, entry.name, request.operation);
      if (emptyError) {
        lastError = emptyError;
        // Only fall back if the empty category is allowed by policy.
        if (!isFallbackEligible('RESEARCH_NO_USABLE_SOURCES', config.fallbackPolicy)) {
          await emitFailureHook(hooks, entry.name, emptyError.code, emptyError.message);
          throw emptyError;
        }
        if (isLast) {
          await emitFailureHook(hooks, entry.name, emptyError.code, emptyError.message);
          throw emptyError;
        }
        // Emit fallback hook and fall back to the next provider.
        const nextEntry = providers[i + 1]!;
        await emitFallbackHook(hooks, entry.name, nextEntry.name, emptyError.code);
        continue;
      }

      // Success — emit hook and return the result.
      await emitSuccessHook(hooks, entry.name);
      return result;
    } catch (err) {
      if (err instanceof ResearchProviderError) {
        lastError = err;

        // Permanent denial — never fall back (VAL-RES-012).
        if (isFallbackDenied(err.code)) {
          await emitFailureHook(hooks, entry.name, err.code, err.message);
          throw err;
        }

        // Check if this error is fallback-eligible per policy.
        if (!isFallbackEligible(err.code, config.fallbackPolicy)) {
          await emitFailureHook(hooks, entry.name, err.code, err.message);
          throw err;
        }

        if (isLast) {
          await emitFailureHook(hooks, entry.name, err.code, err.message);
          throw err;
        }

        // Emit fallback hook and fall back to the next provider.
        const nextEntry = providers[i + 1]!;
        await emitFallbackHook(hooks, entry.name, nextEntry.name, err.code);
        continue;
      }

      // Unexpected non-provider error — throw immediately.
      throw err;
    }
  }

  // All providers exhausted — throw the last error.
  if (lastError) {
    throw lastError;
  }

  // Should be unreachable — no providers given.
  throw new ResearchProviderError(
    'PROVIDER_PERMANENT',
    'No research providers configured',
    'tavily',
    request.operation,
  );
}
