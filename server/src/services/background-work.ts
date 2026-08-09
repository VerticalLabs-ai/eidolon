/**
 * Background work tracker — a test-visible drain hook for fire-and-forget
 * follow-up writes.
 *
 * Problem: several routes respond to the client before their fire-and-forget
 * follow-up writes (mention dispatch, queued-mention cancellation, activity
 * logging, co-edit flush) complete. Two consequences:
 *   (1) A client can observe a 200 before the follow-up write lands, and any
 *       error in that background work is only console.error'd — it never
 *       surfaces to the caller or to monitoring.
 *   (2) It deadlocks the test suite: resetTestDb()'s TRUNCATE ... RESTART
 *       IDENTITY CASCADE takes ACCESS EXCLUSIVE on every table at once and
 *       deadlocks against these in-flight background writes.
 *
 * Solution: every fire-and-forget background write is registered with this
 * tracker via `backgroundWork.fire(promise)`. Tests (and the afterEach hook
 * in test-setup.ts) call `await backgroundWork.drain()` to deterministically
 * await all in-flight background completion instead of sleeping a fixed
 * delay. Errors are logged with context, not silently swallowed.
 *
 * The tracker is a module-level singleton so it is shared across all route
 * handlers within a single server process (and per Vitest fork).
 */

import logger from '../utils/logger.js';

interface TrackedWork {
  promise: Promise<unknown>;
  label: string;
  startedAt: number;
}

class BackgroundWorkTracker {
  private pending = new Map<Promise<unknown>, TrackedWork>();
  private seq = 0;

  /**
   * Track a background promise. Errors are logged with the provided label
   * and re-thrown so the caller's `.catch` (if any) also runs. The promise
   * is removed from the pending set once settled.
   */
  track<T>(promise: Promise<T>, label: string): Promise<T> {
    const id = ++this.seq;
    const startedAt = Date.now();

    // Wrap the promise to log errors with context before re-throwing.
    const wrapped = promise.then(
      (value) => value,
      (err) => {
        const elapsed = Date.now() - startedAt;
        logger.error(
          { err, workId: id, label, elapsedMs: elapsed },
          'Background work failed',
        );
        throw err;
      },
    );

    this.pending.set(wrapped, { promise: wrapped, label, startedAt });

    // Clean up on settle — use .then with both handlers to avoid creating
    // an unhandled rejection from a .finally() promise. Both handlers
    // return undefined so the cleanup promise always resolves.
    wrapped.then(
      () => { this.pending.delete(wrapped); },
      () => { this.pending.delete(wrapped); },
    );

    return wrapped;
  }

  /**
   * Fire-and-forget: track a background promise and swallow its error (the
   * error is already logged in `track`). Use this for routes that respond
   * before the follow-up write completes and don't need to surface the
   * error to the caller.
   */
  fire(promise: Promise<unknown>, label: string): void {
    this.track(promise, label).catch(() => {
      // Error already logged in track(); swallow so unhandledRejection
      // doesn't fire.
    });
  }

  /**
   * Await all in-flight background work to complete. Tests call this instead
   * of sleeping a fixed delay. Returns once the pending set is empty.
   *
   * If a background promise never settles (e.g. a hung agent dispatch), this
   * would hang. In practice, background work in tests completes quickly
   * (agent dispatches fail fast without API keys, activity inserts are
   * single-row writes). The afterEach drain in test-setup.ts is a safety net
   * — tests that need to assert state should drain explicitly.
   */
  async drain(): Promise<void> {
    // Snapshot the current pending promises. New work added during drain
    // is picked up on the next iteration.
    while (this.pending.size > 0) {
      const promises = [...this.pending.keys()];
      await Promise.allSettled(promises);
    }
  }

  /** Number of in-flight background operations. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Clear the pending set without awaiting. Used in afterEach as a last-resort
   * reset if drain() is not called. Does NOT cancel the underlying promises —
   * they will still settle (and log errors if they fail), but they are no
   * longer tracked.
   */
  reset(): void {
    this.pending.clear();
  }
}

export const backgroundWork = new BackgroundWorkTracker();
