import { and, eq } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { BudgetService } from './budget.js';

/**
 * Mission Completion module (VAL-CROSS-059, VAL-RUN-041, VAL-RUN-042,
 * VAL-RUN-043).
 *
 * Completion is the other side of the terminal race. When a worker finishes
 * processing, it calls {@link MissionCompletionService.completeRun} to
 * transition the run to `completed`. This method locks the run row with
 * `FOR UPDATE` and checks whether cancellation already won the lock:
 *
 *  - If the run is already terminal (completed/failed/cancelled), the call
 *    is a no-op that returns the current terminal snapshot (VAL-RUN-043).
 *  - If `cancelRequestedAt` is set (cancellation won the lock first), the
 *    call refuses with `409 INVALID_RUN_STATE` — no result, artifact link, or
 *    completion event commits afterward (VAL-RUN-041).
 *  - Otherwise, the run transitions to `completed`, `terminal_at` is set,
 *    a `run.completed` event is appended, and residual budget is released.
 *
 * The loser of the race (whichever did not acquire the lock first) observes
 * the terminal state and performs no transition (VAL-CROSS-059).
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface CompletionDeps {
  clock?: () => Date;
}

export interface CompletionResult {
  /** HTTP status: 200 for already-terminal, 200 for newly completed. */
  statusCode: number;
  /** New state version (ETag). */
  stateVersion: number;
  /** Whether the run was terminalized (completed) in this transaction. */
  terminalized: boolean;
  /** Run status after the operation. */
  status: string;
  /** Latest event sequence after the operation. */
  lastEventSequence: number;
}

export class MissionCompletionService {
  constructor(
    private db: DbInstance,
    private deps: CompletionDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Complete a run. Must be called inside a transaction that locks the run
   * row with `FOR UPDATE` (this method performs the lock internally).
   *
   * If cancellation already won the run lock (cancelRequestedAt is set and
   * the run is not yet terminal), this method refuses with
   * `409 INVALID_RUN_STATE` — no completion event or output commits
   * (VAL-RUN-041).
   *
   * If the run is already terminal, this is a no-op that returns the
   * current snapshot (VAL-RUN-043).
   */
  async completeRun(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
    opts: {
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
    } = {},
  ): Promise<CompletionResult> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = opts.actorType ?? 'system';
    const actorId = opts.actorId ?? null;
    const traceId = opts.traceId ?? null;

    // Lock the run row.
    const [run] = await tx
      .select()
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
          eq(schema.missionRuns.id, runId),
        ),
      )
      .for('update')
      .limit(1);

    if (!run) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    // Terminal runs are immutable — no-op (VAL-RUN-043).
    if (TERMINAL_STATUSES.has(run.status)) {
      return {
        statusCode: 200,
        stateVersion: run.stateVersion,
        terminalized: false,
        status: run.status,
        lastEventSequence: Number(run.lastEventSequence),
      };
    }

    // If cancellation was already requested, cancellation wins the race.
    // Refuse to complete — no result, artifact link, or completion event
    // commits afterward (VAL-RUN-041).
    if (run.cancelRequestedAt !== null) {
      throw new AppError(
        409,
        'INVALID_RUN_STATE',
        'Cannot complete a run with a pending cancellation request',
      );
    }

    // Transition to completed.
    const newVersion = run.stateVersion + 1;
    const seq = Number(run.lastEventSequence) + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'completed',
        terminalAt: now,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: null,
        stateVersion: newVersion,
        lastEventSequence: seq,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // Emit run.completed event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'run.completed',
      schemaVersion: 1,
      payload: {},
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Release residual budget.
    const budgetService = new BudgetService(this.db, { clock: () => now });
    await budgetService.release(tx, { companyId: run.companyId, runId: run.id });

    // Emit budget.released event.
    const budgetSeq = seq + 1;
    await tx
      .update(schema.missionRuns)
      .set({ lastEventSequence: budgetSeq, updatedAt: now })
      .where(eq(schema.missionRuns.id, run.id));

    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: budgetSeq,
      type: 'budget.released',
      schemaVersion: 1,
      payload: {},
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    return {
      statusCode: 200,
      stateVersion: budgetSeq > newVersion ? budgetSeq : newVersion,
      terminalized: true,
      status: 'completed',
      lastEventSequence: budgetSeq,
    };
  }
}
