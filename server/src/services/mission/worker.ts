import { randomUUID } from 'node:crypto';
import { RENEWAL_INTERVAL_MS, type Claim, type RunCoordinator } from './coordinator.js';
import logger from '../../utils/logger.js';

/**
 * OrchestrationWorker — the polling loop, lease renewal, and graceful
 * shutdown.
 *
 * The worker is a separate Node process with no HTTP port. It connects to
 * the same Postgres and claims eligible runs via the RunCoordinator.
 *
 * Polling:
 *  - The worker polls every `pollIntervalMs` (default 2 seconds) by calling
 *    `claimNext`. This is the safety net: even if Postgres LISTEN/NOTIFY
 *    wake hints are missed, the bounded periodic polling claims and
 *    advances the same run without resubmission or a new run ID
 *    (VAL-RUN-121).
 *
 * Lease renewal:
 *  - While processing a run, the worker renews the lease every
 *    `renewalIntervalMs` (default 10 seconds). If renewal fails (lease
 *    expired or stolen), the worker aborts its active work and stops
 *    processing that run.
 *
 * Graceful shutdown (VAL-RUN-127):
 *  - `stop()` sets a shutdown flag that prevents new claims.
 *  - Active calls are aborted via AbortController.
 *  - A bounded fenced commit window allows in-progress transactions to
 *    complete (e.g., a completion commit that already started).
 *  - The lease is released so a replacement worker can recover the run
 *    after lease expiry.
 *  - The process exits without orphaning or falsely terminalizing work.
 */

export interface WorkerDeps {
  coordinator: RunCoordinator;
  /** Worker identifier. Default: auto-generated. */
  workerId?: string;
  /** Polling interval (ms). Default: 2000. */
  pollIntervalMs?: number;
  /** Lease renewal interval (ms). Default: 10000. */
  renewalIntervalMs?: number;
  /**
   * Bounded fenced commit window after shutdown signal (ms).
   * Default: 5000.
   */
  shutdownCommitWindowMs?: number;
  /**
   * The actual processing function. Receives the claim and an AbortSignal
   * that fires on shutdown or lease loss. The function should check the
   * signal and abort cancellable work.
   */
  advance: (claim: Claim, signal: AbortSignal) => Promise<void>;
  /**
   * Optional periodic sweep called at the beginning of each poll cycle,
   * before attempting to claim a run. Used to wire the kill-switch
   * `sweepAllDisabled` sweep into the worker poll loop so disabled
   * companies are handled without a separate cron process. Errors are
   * caught and logged — the worker continues polling after a sweep
   * failure.
   */
  sweep?: () => Promise<void>;
  /**
   * Optional bounded periodic cancellation-deadline sweep called at the
   * beginning of each poll cycle, throttled to {@link deadlineSweepIntervalMs}.
   * Used to wire the kill-switch `enforceDeadlines` /
   * `terminalizeForDeadlineExpiry` logic into the worker tick so
   * cancel-requested nonterminal runs and queued children whose
   * `cancellationDeadlineAt` has passed converge to terminal without a
   * separate cron process (VAL-CROSS-058, VAL-RUN-109, VAL-SUB-096).
   *
   * Unlike {@link sweep} (which runs every poll for responsive kill-switch
   * cancellation), this is throttled to a bounded interval because
   * `enforceDeadlines` performs several full-table scans and running it
   * every poll would add avoidable load. Errors are caught and logged —
   * the worker continues polling after a deadline-sweep failure.
   */
  deadlineSweep?: () => Promise<void>;
  /**
   * Bounded interval for the {@link deadlineSweep} in milliseconds. The
   * deadline sweep runs at most once per interval. Default: 10000 (10s,
   * within the 10–15s convergence bound).
   */
  deadlineSweepIntervalMs?: number;
  /**
   * Optional periodic heartbeat called at the beginning of each poll cycle
   * (after the sweep, before claiming) so the snapshot service can derive
   * `queueHealth` from the most recent heartbeat age (VAL-RUN-088). Errors
   * are caught and logged — the worker continues polling after a heartbeat
   * write failure.
   */
  heartbeat?: () => Promise<void>;
}

export class OrchestrationWorker {
  readonly workerId: string;
  private readonly coordinator: RunCoordinator;
  private readonly pollIntervalMs: number;
  private readonly renewalIntervalMs: number;
  private readonly shutdownCommitWindowMs: number;
  private readonly advanceFn: (claim: Claim, signal: AbortSignal) => Promise<void>;
  private readonly sweepFn: (() => Promise<void>) | null;
  private readonly deadlineSweepFn: (() => Promise<void>) | null;
  private readonly deadlineSweepIntervalMs: number;
  private readonly heartbeatFn: (() => Promise<void>) | null;

  private shuttingDown = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private renewalTimer: ReturnType<typeof setTimeout> | null = null;
  private currentAbort: AbortController | null = null;
  private currentClaim: Claim | null = null;
  private processing = false;
  /**
   * Wall-clock milliseconds of the last {@link deadlineSweepFn} invocation.
   * `null` means the sweep has not run yet, so the first poll runs it
   * immediately (prompt convergence for already-expired deadlines).
   */
  private lastDeadlineSweepAt: number | null = null;

  constructor(deps: WorkerDeps) {
    this.coordinator = deps.coordinator;
    this.workerId = deps.workerId ?? `worker-${randomUUID().slice(0, 8)}`;
    this.pollIntervalMs = deps.pollIntervalMs ?? 2000;
    this.renewalIntervalMs = deps.renewalIntervalMs ?? RENEWAL_INTERVAL_MS;
    this.shutdownCommitWindowMs = deps.shutdownCommitWindowMs ?? 5000;
    this.advanceFn = deps.advance;
    this.sweepFn = deps.sweep ?? null;
    this.deadlineSweepFn = deps.deadlineSweep ?? null;
    this.deadlineSweepIntervalMs = deps.deadlineSweepIntervalMs ?? 10000;
    this.heartbeatFn = deps.heartbeat ?? null;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  get isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Start the polling loop. Returns immediately; the loop runs
   * asynchronously until `stop()` is called.
   */
  async start(): Promise<void> {
    this.schedulePoll(0);
  }

  /**
   * Graceful shutdown (VAL-RUN-127):
   *
   * 1. Set shutdown flag → prevents new claims.
   * 2. Stop the renewal loop and cancel the poll timer.
   * 3. Capture the current claim (before aborting, since the abort may
   *    cause the poll loop to clear currentClaim).
   * 4. Abort active calls via AbortController.
   * 5. Wait for the bounded fenced commit window for in-progress
   *    transactions to complete.
   * 6. Release the captured lease so a replacement worker can recover.
   */
  async stop(): Promise<void> {
    this.shuttingDown = true;

    // Cancel the poll timer so no new claims are attempted.
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Stop the renewal loop first so it doesn't interfere.
    this.stopRenewalLoop();

    // Capture the current claim before aborting (the abort may cause
    // the poll loop to clear currentClaim).
    const claimToRelease = this.currentClaim;

    // Abort active work.
    if (this.currentAbort) {
      this.currentAbort.abort();
    }

    // Wait for the bounded commit window for in-progress work.
    if (this.processing) {
      await this.waitForCommitWindow();
    }

    // Release the lease if still held.
    if (claimToRelease) {
      try {
        await this.coordinator.release(claimToRelease);
      } catch {
        // Lease may already be lost; that's acceptable during shutdown.
      }
    }
  }

  private waitForCommitWindow(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.shutdownCommitWindowMs);
      // Also resolve when processing finishes (whichever comes first).
      const check = setInterval(() => {
        if (!this.processing) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 10);
      setTimeout(() => clearInterval(check), this.shutdownCommitWindowMs + 1000);
    });
  }

  private schedulePoll(delayMs?: number): void {
    if (this.shuttingDown) {
      return;
    }
    const delay = delayMs ?? this.pollIntervalMs;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    if (this.shuttingDown || this.processing) {
      this.schedulePoll();
      return;
    }

    // Run the periodic sweep (kill-switch + deadline enforcement) before
    // attempting to claim. Errors are caught so the worker continues
    // polling after a sweep failure.
    if (this.sweepFn) {
      try {
        await this.sweepFn();
      } catch {
        // Sweep failure is non-fatal — the next poll cycle will retry.
      }
    }

    // Record a worker heartbeat so the snapshot service can derive
    // queueHealth from the most recent heartbeat age (VAL-RUN-088).
    // Errors are caught so a heartbeat write failure does not stop the
    // worker from claiming and advancing runs.
    if (this.heartbeatFn) {
      try {
        await this.heartbeatFn();
      } catch {
        // Heartbeat failure is non-fatal — the next poll cycle will retry.
      }
    }

    // Bounded cancellation-deadline sweep (VAL-CROSS-058, VAL-RUN-109,
    // VAL-SUB-096). Throttled to `deadlineSweepIntervalMs` so the
    // expensive `enforceDeadlines` full-table scans run at a bounded
    // interval (every 10–15s in production) rather than every poll. The
    // first poll runs it immediately so already-expired deadlines
    // converge promptly. Errors are caught so the worker continues
    // polling after a deadline-sweep failure.
    if (this.deadlineSweepFn) {
      const nowMs = Date.now();
      if (
        this.lastDeadlineSweepAt === null ||
        nowMs - this.lastDeadlineSweepAt >= this.deadlineSweepIntervalMs
      ) {
        this.lastDeadlineSweepAt = nowMs;
        try {
          await this.deadlineSweepFn();
        } catch (err) {
          // Deadline-sweep failure is non-fatal — the next interval will
          // retry. Keep the timestamp so we don't retry-burst every poll.
          // Log non-LEASE_NOT_HELD/INVALID_RUN_STATE errors so future
          // collisions and unexpected failures are visible rather than
          // silently swallowed (fix-ut-m4-cascade-sequence-collision).
          this.logDeadlineSweepError(err);
        }
      }
    }

    if (this.shuttingDown) {
      this.schedulePoll();
      return;
    }

    try {
      const claim = await this.coordinator.claimNext(this.workerId);
      if (!claim) {
        this.schedulePoll();
        return;
      }

      this.currentClaim = claim;
      this.processing = true;
      this.currentAbort = new AbortController();

      // Start the lease renewal loop.
      this.startRenewalLoop(claim);

      try {
        await this.advanceFn(claim, this.currentAbort.signal);
      } catch {
        // If the advance function threw (e.g., aborted), release the lease
        // so another worker can recover the run.
        // Only release if we still hold the lease.
        if (!this.shuttingDown) {
          try {
            await this.coordinator.release(claim);
          } catch {
            // Lease may have been lost; acceptable.
          }
        }
      } finally {
        this.stopRenewalLoop();
        this.currentClaim = null;
        this.currentAbort = null;
        this.processing = false;
      }
    } catch {
      // Claim failed — schedule next poll.
    }

    this.schedulePoll();
  }

  /**
   * Log a deadline-sweep error unless it is an expected concurrency
   * outcome (LEASE_NOT_HELD or INVALID_RUN_STATE). Those are silently
   * skipped because they indicate a fenced worker or a race that the
   * next interval will resolve. All other errors are logged at error
   * level so future sequence collisions and unexpected failures are
   * visible rather than silently swallowed.
   * (fix-ut-m4-cascade-sequence-collision)
   */
  private logDeadlineSweepError(err: unknown): void {
    const code = (err as { code?: string }).code;
    if (code === 'LEASE_NOT_HELD' || code === 'INVALID_RUN_STATE') {
      return;
    }
    logger.error(
      { err, workerId: this.workerId },
      'deadline-sweep error (non-fatal, will retry next interval)',
    );
  }

  private startRenewalLoop(claim: Claim): void {
    const renew = async (): Promise<void> => {
      if (this.shuttingDown || !this.currentClaim) {
        return;
      }
      try {
        const renewed = await this.coordinator.renew(claim);
        this.currentClaim = renewed;
      } catch {
        // Lease lost — abort active work.
        if (this.currentAbort) {
          this.currentAbort.abort();
        }
        return;
      }
      if (!this.shuttingDown && this.currentClaim) {
        this.renewalTimer = setTimeout(renew, this.renewalIntervalMs);
      }
    };

    this.renewalTimer = setTimeout(renew, this.renewalIntervalMs);
  }

  private stopRenewalLoop(): void {
    if (this.renewalTimer) {
      clearTimeout(this.renewalTimer);
      this.renewalTimer = null;
    }
  }
}
