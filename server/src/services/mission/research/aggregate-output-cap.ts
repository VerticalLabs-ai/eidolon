/**
 * Aggregate persisted-output cap for research (VAL-RES-059).
 *
 * Enforces the snapshotted run-policy aggregate output cap so the research
 * service stops accepting further output at the cap and terminates or
 * completes partially according to policy without exceeding the counter.
 *
 * Architecture hard cap: 10 MiB aggregate persisted output, with a tighter
 * per-run policy possibly lowering it. This module is pure and
 * deterministic; the research orchestration service (a later feature) uses
 * it to gate source persistence. Per-source normalization (1 MiB each) is
 * enforced separately in `source-normalization.ts`.
 */

import type { NormalizedResearchSource } from './spi.js';
import { normalizeSourceForPersistence } from './source-normalization.js';

// ---------------------------------------------------------------------------
// Cap
// ---------------------------------------------------------------------------

/** Default aggregate persisted-output cap (10 MiB). */
export const DEFAULT_AGGREGATE_OUTPUT_CAP_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Counter
// ---------------------------------------------------------------------------

/**
 * A bounded, in-memory counter for aggregate persisted output bytes.
 *
 * `tryAdd` is conservative: it only adds bytes that fit within the cap and
 * returns false otherwise (without adding). `wouldExceed` is a pure probe.
 * The counter never exceeds `capBytes`.
 */
export class AggregateOutputCounter {
  private _totalBytes = 0;
  readonly capBytes: number;

  constructor(capBytes: number) {
    if (!Number.isFinite(capBytes) || capBytes < 0) {
      throw new RangeError('capBytes must be a finite non-negative number');
    }
    this.capBytes = Math.floor(capBytes);
  }

  /** Total bytes accepted so far. */
  get totalBytes(): number {
    return this._totalBytes;
  }

  /** Remaining bytes before the cap. */
  get remainingBytes(): number {
    return Math.max(0, this.capBytes - this._totalBytes);
  }

  /** Returns true if adding `bytes` would exceed the cap. */
  wouldExceed(bytes: number): boolean {
    return this._totalBytes + bytes > this.capBytes;
  }

  /**
   * Try to add `bytes` to the counter. Returns true if the bytes fit
   * within the cap (and the counter is updated), false otherwise (the
   * counter is unchanged). A zero or negative argument always succeeds.
   */
  tryAdd(bytes: number): boolean {
    if (bytes <= 0) {
      return true;
    }
    if (this.wouldExceed(bytes)) {
      return false;
    }
    this._totalBytes += bytes;
    return true;
  }

  /** Throw if adding `bytes` would exceed the cap (counter unchanged). */
  assertWithinCap(bytes: number): void {
    if (this.wouldExceed(bytes)) {
      throw new Error(
        `aggregate persisted output ${this._totalBytes + bytes} bytes would exceed cap ${this.capBytes}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Source selection within the aggregate cap
// ---------------------------------------------------------------------------

export interface AggregateSelectionResult {
  /** Sources accepted within the aggregate cap (in input order). */
  accepted: NormalizedResearchSource[];
  /** Sources excluded because they would exceed the aggregate cap. */
  excluded: NormalizedResearchSource[];
  /** Total accepted persisted bytes (≤ cap). */
  totalBytes: number;
  /** The snapshotted cap in bytes. */
  capBytes: number;
}

/**
 * Select sources for persistence up to the aggregate output cap, in order.
 *
 * Each source's persisted byte count is the normalized text byte count
 * (capped to 1 MiB per source by `normalizeSourceForPersistence`). Sources
 * that would exceed the aggregate cap are excluded, not truncated, so the
 * run terminates or completes partially according to policy without
 * exceeding the counter.
 */
export function selectSourcesWithinAggregateCap(
  sources: readonly NormalizedResearchSource[],
  capBytes: number,
): AggregateSelectionResult {
  const counter = new AggregateOutputCounter(capBytes);
  const accepted: NormalizedResearchSource[] = [];
  const excluded: NormalizedResearchSource[] = [];

  for (const source of sources) {
    const rec = normalizeSourceForPersistence(source);
    const bytes = rec.byteCount;
    if (counter.tryAdd(bytes)) {
      accepted.push(source);
    } else {
      excluded.push(source);
    }
  }

  return {
    accepted,
    excluded,
    totalBytes: counter.totalBytes,
    capBytes: counter.capBytes,
  };
}
