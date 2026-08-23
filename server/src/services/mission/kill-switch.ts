import { eq, sql, and, isNull, isNotNull, lte } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { isFeatureEnabled } from '../feature-flags.js';
import { MissionCancellationService } from './cancellation.js';

/**
 * Mission Kill Switch module (VAL-CROSS-055, VAL-CROSS-056, VAL-CROSS-090,
 * VAL-CROSS-098, VAL-RUN-087, VAL-RUN-102).
 *
 * The kill switch is the persisted Mission rollout safety mechanism. When
 * the `missionAgentIntelligence` feature flag is disabled (absent, malformed,
 * or explicitly off), the system must:
 *
 *  1. Deny new starts and all non-cancel mutations (enforced by the API
 *     routes, which exempt cancel).
 *  2. Preserve authorized reads (GET/list/replay/stream) and cancellation.
 *  3. Request cancellation for every nonterminal run.
 *  4. Prevent new worker claims and post-switch output commits (the
 *     cancellation request on a run makes it ineligible for claiming, and
 *     completion refuses when cancelRequestedAt is set).
 *  5. Leave terminal history visible and unchanged.
 *
 * Re-enabling the flag does NOT resume cancelled runs — they remain
 * terminal and immutable. Only an explicit user retry creates new work.
 *
 * Abandoned runs (after API/worker loss) are recovered by
 * {@link MissionKillSwitchService.enforceDeadlines}, which finds runs past
 * their persisted cancellation deadline or computed root deadline and
 * terminalizes them, releasing residual budget and fencing stale work.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface KillSwitchDeps {
  clock?: () => Date;
}

export interface SweepCompanyResult {
  /** Number of nonterminal runs that received a cancellation request. */
  cancelledRuns: number;
}

export interface SweepAllDisabledResult {
  /** Number of companies swept. */
  sweptCompanies: number;
  /** Total number of nonterminal runs cancelled. */
  cancelledRuns: number;
}

export interface EnforceDeadlinesResult {
  /** Number of runs terminalized by deadline enforcement. */
  terminalized: number;
}

export class MissionKillSwitchService {
  constructor(
    private db: DbInstance,
    private deps: KillSwitchDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Sweep a single company: request cancellation for every nonterminal
   * run. Non-lease states are terminalized immediately by the cancellation
   * service. Lease states receive a cancel request and bounded deadline;
   * they are terminalized by {@link enforceDeadlines} when the deadline
   * passes.
   *
   * This method does NOT check the feature flag — the caller decides when
   * to sweep. Use {@link sweepAllDisabled} for the flag-aware sweep.
   */
  async sweepCompany(companyId: string): Promise<SweepCompanyResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Find all nonterminal runs for this company.
    const nonterminalRuns = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        companyId: schema.missionRuns.companyId,
        projectId: schema.missionRuns.projectId,
        status: schema.missionRuns.status,
        stateVersion: schema.missionRuns.stateVersion,
        lastEventSequence: schema.missionRuns.lastEventSequence,
        cancelRequestedAt: schema.missionRuns.cancelRequestedAt,
      })
      .from(schema.missionRuns)
      .where(
        and(eq(schema.missionRuns.companyId, companyId), isNull(schema.missionRuns.terminalAt)),
      );

    let cancelledRuns = 0;

    for (const run of nonterminalRuns) {
      // Skip runs that already have a cancellation request.
      if (run.cancelRequestedAt !== null) {
        continue;
      }

      await this.requestCancellationForRun(run, now);
      cancelledRuns++;
    }

    return { cancelledRuns };
  }

  /**
   * Sweep all companies that have nonterminal runs and whose
   * `missionAgentIntelligence` flag is disabled. This is the main
   * kill-switch entry point for the worker's periodic poll.
   */
  async sweepAllDisabled(): Promise<SweepAllDisabledResult> {
    // Find all distinct companies with nonterminal runs.
    const companies = (await this.db.drizzle.execute(sql`
      SELECT DISTINCT "company_id" FROM "mission_runs"
      WHERE "terminal_at" IS NULL
    `)) as unknown as Array<{ company_id: string }>;

    let sweptCompanies = 0;
    let cancelledRuns = 0;

    for (const { company_id: companyId } of companies) {
      // Check the feature flag for this company.
      if (isFeatureEnabled('missionAgentIntelligence', companyId)) {
        continue;
      }

      // Flag is disabled — sweep this company.
      const result = await this.sweepCompany(companyId);
      if (result.cancelledRuns > 0) {
        sweptCompanies++;
        cancelledRuns += result.cancelledRuns;
      }
    }

    return { sweptCompanies, cancelledRuns };
  }

  /**
   * Enforce persisted deadlines: find runs that have passed their
   * cancellation deadline or computed root deadline and terminalize them.
   *
   * This handles abandoned runs after API/worker loss (VAL-CROSS-098):
   *  - Runs with `cancel_requested_at` set and `cancellation_deadline_at`
   *    past the current time are terminalized to `cancelled`.
   *  - Runs without a cancellation request whose computed root deadline
   *    (createdAt + policy.limits.durationSeconds) has passed are first
   *    given a cancellation request, then terminalized.
   *
   * Budget is released during terminalization. Stale leases are fenced
   * (the lease is cleared during terminalization, so a stale worker
   * cannot commit afterward).
   */
  async enforceDeadlines(): Promise<EnforceDeadlinesResult> {
    const now = this.now();
    let terminalized = 0;

    // 1. Terminalize runs with a passed cancellation deadline.
    terminalized += await this.enforceCancellationDeadlines(now);

    // 2. Handle runs without a cancellation request whose root deadline
    //    has passed (abandoned runs).
    terminalized += await this.enforceRootDeadlines(now);

    return { terminalized };
  }

  // -- internal: cancellation deadline enforcement --------------------------

  /**
   * Find runs with `cancel_requested_at` set, `cancellation_deadline_at`
   * past the current time, and not yet terminal. Terminalize each.
   */
  private async enforceCancellationDeadlines(now: Date): Promise<number> {
    const schema = this.db.schema;

    const expiredRuns = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        companyId: schema.missionRuns.companyId,
        projectId: schema.missionRuns.projectId,
      })
      .from(schema.missionRuns)
      .where(
        and(
          isNotNull(schema.missionRuns.cancelRequestedAt),
          isNotNull(schema.missionRuns.cancellationDeadlineAt),
          lte(schema.missionRuns.cancellationDeadlineAt, now),
          isNull(schema.missionRuns.terminalAt),
        ),
      );

    let count = 0;
    const cancelService = new MissionCancellationService(this.db, { clock: () => now });

    for (const run of expiredRuns) {
      try {
        await this.db.drizzle.transaction(async (tx) => {
          await cancelService.terminalize(tx, run.companyId, run.projectId, run.id, {
            actorType: 'system',
            actorId: null,
            traceId: null,
          });
        });
        count++;
      } catch (err) {
        // If the run was already terminalized by a concurrent operation,
        // that's acceptable — it's still terminal.
        if (err instanceof AppError && err.code === 'LEASE_NOT_HELD') {
          // A fenced worker still holds the lease; skip — the worker
          // will terminalize when it observes the cancellation.
          continue;
        }
        // If it's an INVALID_RUN_STATE (no cancel request — shouldn't
        // happen given our query), skip.
        if (err instanceof AppError && err.code === 'INVALID_RUN_STATE') {
          continue;
        }
        throw err;
      }
    }

    return count;
  }

  /**
   * Find runs without a cancellation request whose computed root deadline
   * has passed. Request cancellation for each, then terminalize.
   */
  private async enforceRootDeadlines(now: Date): Promise<number> {
    const schema = this.db.schema;

    // Find nonterminal runs without a cancellation request.
    const abandonedRuns = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        companyId: schema.missionRuns.companyId,
        projectId: schema.missionRuns.projectId,
        rootRunId: schema.missionRuns.rootRunId,
        createdAt: schema.missionRuns.createdAt,
        policySnapshotId: schema.missionRuns.policySnapshotId,
        status: schema.missionRuns.status,
        stateVersion: schema.missionRuns.stateVersion,
        lastEventSequence: schema.missionRuns.lastEventSequence,
        cancelRequestedAt: schema.missionRuns.cancelRequestedAt,
      })
      .from(schema.missionRuns)
      .where(
        and(isNull(schema.missionRuns.terminalAt), isNull(schema.missionRuns.cancelRequestedAt)),
      );

    let count = 0;
    const cancelService = new MissionCancellationService(this.db, { clock: () => now });

    for (const run of abandonedRuns) {
      // Compute the root deadline: createdAt + durationSeconds from policy.
      const durationSeconds = await this.readDurationSeconds(run.policySnapshotId);
      const rootDeadline = new Date(run.createdAt.getTime() + durationSeconds * 1000);

      if (rootDeadline > now) {
        continue; // Root deadline hasn't passed yet.
      }

      // The root deadline has passed. Request cancellation and terminalize.
      try {
        await this.db.drizzle.transaction(async (tx) => {
          // Lock the run.
          const [locked] = await tx
            .select()
            .from(schema.missionRuns)
            .where(eq(schema.missionRuns.id, run.id))
            .for('update')
            .limit(1);

          if (!locked || TERMINAL_STATUSES.has(locked.status)) {
            return; // Already terminal.
          }

          if (locked.cancelRequestedAt !== null) {
            // Cancellation was requested since our query. Check if the
            // deadline has passed and terminalize.
            if (locked.cancellationDeadlineAt && locked.cancellationDeadlineAt <= now) {
              await cancelService.terminalize(tx, run.companyId, run.projectId, run.id, {
                actorType: 'system',
                actorId: null,
                traceId: null,
                fromVersion: locked.stateVersion,
                fromSequence: Number(locked.lastEventSequence),
              });
              count++;
            }
            return;
          }

          // VAL-MODEQ-150: When the absolute Mission deadline expires in
          // awaiting_input, fail the run with category `limit` and code
          // `TIME_LIMIT` and invalidate the open question set with
          // `deadline_expired`. This is a terminalization transaction, not
          // a cancellation — the run did not get cancelled, it ran out of
          // time while waiting for human input.
          if (locked.status === 'awaiting_input') {
            const { MissionQuestionPublicationService } = await import('./question-publication.js');
            const pubService = new MissionQuestionPublicationService(this.db, {
              clock: () => now,
            });
            await pubService.terminalizeForDeadlineExpiry(tx, locked, {
              actorType: 'system',
              actorId: null,
              traceId: null,
            });
            count++;
            return;
          }

          // Request cancellation (sets the deadline).
          const cancelResult = await cancelService.requestCancellation(tx, locked, {
            companyId: run.companyId,
            projectId: run.projectId,
            runId: run.id,
            actorType: 'system',
            actorId: null,
            traceId: null,
          });

          // For non-lease states, requestCancellation already terminalized.
          if (cancelResult.terminalized) {
            count++;
            return;
          }

          // For lease states, the cancellation deadline was just set to
          // min(rootDeadline, now + 60s). Since rootDeadline <= now, the
          // deadline is in the past. Terminalize immediately.
          if (
            cancelResult.cancellationDeadlineAt &&
            new Date(cancelResult.cancellationDeadlineAt) <= now
          ) {
            await cancelService.terminalize(tx, run.companyId, run.projectId, run.id, {
              actorType: 'system',
              actorId: null,
              traceId: null,
              fromVersion: cancelResult.stateVersion,
              fromSequence: cancelResult.lastEventSequence,
            });
            count++;
          }
        });
      } catch (err) {
        if (
          err instanceof AppError &&
          (err.code === 'LEASE_NOT_HELD' || err.code === 'INVALID_RUN_STATE')
        ) {
          continue;
        }
        throw err;
      }
    }

    return count;
  }

  // -- internal: request cancellation for a run -----------------------------

  /**
   * Request cancellation for a single run. Delegates to
   * {@link MissionCancellationService.requestCancellation} inside a locked
   * transaction.
   */
  private async requestCancellationForRun(
    run: {
      id: string;
      companyId: string;
      projectId: string;
      status: string;
      stateVersion: number;
      lastEventSequence: unknown;
    },
    now: Date,
  ): Promise<void> {
    const schema = this.db.schema;
    const cancelService = new MissionCancellationService(this.db, { clock: () => now });

    try {
      await this.db.drizzle.transaction(async (tx) => {
        // Lock the run.
        const [locked] = await tx
          .select()
          .from(schema.missionRuns)
          .where(
            and(
              eq(schema.missionRuns.companyId, run.companyId),
              eq(schema.missionRuns.projectId, run.projectId),
              eq(schema.missionRuns.id, run.id),
            ),
          )
          .for('update')
          .limit(1);

        if (!locked || TERMINAL_STATUSES.has(locked.status)) {
          return; // Already terminal.
        }

        if (locked.cancelRequestedAt !== null) {
          return; // Already has a cancellation request.
        }

        await cancelService.requestCancellation(tx, locked, {
          companyId: run.companyId,
          projectId: run.projectId,
          runId: run.id,
          actorType: 'system',
          actorId: null,
          traceId: null,
        });
      });
    } catch (err) {
      // A fenced worker still holds the lease — the cancel request was
      // recorded but the run wasn't terminalized. That's acceptable: the
      // worker will observe the cancellation or the deadline will fire.
      if (err instanceof AppError && err.code === 'LEASE_NOT_HELD') {
        return;
      }
      throw err;
    }
  }

  // -- internal: read duration from policy snapshot --------------------------

  private async readDurationSeconds(policySnapshotId: string | null): Promise<number> {
    if (!policySnapshotId) {
      return 3600; // Default to 60 minutes.
    }
    const schema = this.db.schema;
    const [policy] = await this.db.drizzle
      .select({ limits: schema.runPolicySnapshots.limits })
      .from(schema.runPolicySnapshots)
      .where(eq(schema.runPolicySnapshots.id, policySnapshotId))
      .limit(1);
    if (!policy) {
      return 3600;
    }
    const limits = policy.limits as Record<string, number>;
    return limits.durationSeconds ?? 3600;
  }
}
