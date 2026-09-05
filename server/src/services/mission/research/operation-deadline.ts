/**
 * Operation deadline for research provider calls (VAL-RES-060, VAL-RES-093).
 *
 * Combines caller cancellation, run deadline, and per-operation timeout
 * into a single `AbortSignal` whose deadline covers DNS/connect, upload,
 * headers, decoded body streaming, parsing, and normalization. Defaults:
 * 15 seconds for search, 30 seconds for extraction/scrape, further bounded
 * by remaining run time. Aborts by the deadline or a tighter remaining
 * limit, within 1 second local transport tolerance.
 */

import type { ResearchOperation } from './spi.js';

// ---------------------------------------------------------------------------
// Default deadlines
// ---------------------------------------------------------------------------

/** Default search deadline (15s). */
export const DEFAULT_SEARCH_DEADLINE_MS = 15_000;
/** Default extract/scrape/structured-extract deadline (30s). */
export const DEFAULT_EXTRACT_DEADLINE_MS = 30_000;

/** Operations that use the longer (30s) extract/scrape deadline. */
const LONG_DEADLINE_OPERATIONS: ReadonlySet<ResearchOperation> = new Set([
  'extract',
  'scrape',
  'structured_extract',
]);

/**
 * The default deadline for an operation: 15s for search, 30s for
 * extract/scrape/structured_extract.
 */
export function defaultDeadlineForOperation(operation: ResearchOperation): number {
  return LONG_DEADLINE_OPERATIONS.has(operation)
    ? DEFAULT_EXTRACT_DEADLINE_MS
    : DEFAULT_SEARCH_DEADLINE_MS;
}

// ---------------------------------------------------------------------------
// Operation deadline
// ---------------------------------------------------------------------------

export interface OperationDeadline {
  /** The AbortSignal to pass to fetch / body readers / await checkpoints. */
  signal: AbortSignal;
  /** The resolved deadline in milliseconds. */
  deadlineMs: number;
  /** Release the underlying timer. Call when the operation completes. */
  clear(): void;
}

/**
 * Create an operation deadline `AbortSignal`.
 *
 * The deadline is `min(timeoutMs, defaultDeadlineForOperation(operation),
 * remainingRunMs)` when `remainingRunMs` is provided, otherwise
 * `min(timeoutMs, defaultDeadlineForOperation(operation))`.
 *
 * Timers are real `setTimeout` calls; tests drive them deterministically
 * with vitest fake timers. Production origins and policy are not
 * configurable through this seam.
 *
 * @param operation The research operation.
 * @param timeoutMs The per-request timeout (already validated finite > 0).
 * @param remainingRunMs Optional remaining run time bound.
 */
export function createOperationDeadline(
  operation: ResearchOperation,
  timeoutMs: number,
  remainingRunMs?: number,
): OperationDeadline {
  const defaultDeadline = defaultDeadlineForOperation(operation);
  let deadlineMs = Math.min(timeoutMs, defaultDeadline);
  if (remainingRunMs !== undefined && Number.isFinite(remainingRunMs)) {
    deadlineMs = Math.min(deadlineMs, remainingRunMs);
  }
  // Always at least 1ms.
  deadlineMs = Math.max(1, Math.floor(deadlineMs));

  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), deadlineMs);

  return {
    signal: controller.signal,
    deadlineMs,
    clear() {
      clearTimeout(handle);
    },
  };
}
