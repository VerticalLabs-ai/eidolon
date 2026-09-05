import { and, eq, inArray } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * Mission Recovery module (VAL-RUN-083, VAL-RUN-084, VAL-RUN-085,
 * VAL-RUN-086, VAL-CROSS-050, VAL-CROSS-051).
 *
 * Recovery distinguishes effects:
 *
 *  - pure planning/synthesis and read-only research may be safely reissued
 *    under a deterministic logical call ID;
 *  - each paid provider attempt is separately settled if charge evidence
 *    exists;
 *  - artifact/project/thread projections use deterministic idempotency keys;
 *  - tool invocations are written to `run_tool_invocations` before
 *    execution with a deterministic key and a declared replay class;
 *  - `read_only` may retry; `idempotent_write` retries only through an
 *    adapter idempotency key/reconciliation read; `non_replayable` in
 *    `started`/`unknown` never repeats automatically;
 *  - Unknown non-replayable calls require reconciliation or fail the run;
 *    they are never blindly repeated.
 *
 * When a worker claims a run with an expired lease (recovery), the
 * {@link MissionRecoveryService.checkNonReplayableEffects} method is called
 * to check for non-replayable tool invocations in `started` or `unknown`
 * state. If found, the run is failed with `unknown_effect` failure category
 * and retry guidance. The invocation is NEVER repeated.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface RecoveryDeps {
  clock?: () => Date;
}

export interface NonReplayableEffectResult {
  /** Whether a non-replayable effect was found in an unresolved state. */
  found: boolean;
  /** The invocation IDs that were in an unresolved state (if found). */
  invocationIds: string[];
  /** The tool IDs that were in an unresolved state (if found). */
  toolIds: string[];
}

export interface RecoveryResult {
  /** Whether the run was terminalized due to unknown effects. */
  terminalized: boolean;
  /** Run status after recovery check. */
  status: string;
  /** New state version (ETag). */
  stateVersion: number;
  /** Latest event sequence after the operation. */
  lastEventSequence: number;
  /** Details about non-replayable effects found, if any. */
  effects: NonReplayableEffectResult;
  /** Failure category if terminalized. */
  failureCategory: string | null;
  /** Safe failure code if terminalized. */
  failureCode: string | null;
}

export class MissionRecoveryService {
  constructor(
    private db: DbInstance,
    private deps: RecoveryDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Check for non-replayable tool invocations in an unresolved state
   * (`prepared`, `started`, or `unknown`) and, if found, fail the run with
   * `unknown_effect` failure category and retry guidance (VAL-RUN-086).
   *
   * This method is called by the worker after claiming a run via recovery
   * (expired lease). It must be called BEFORE any re-execution attempt.
   *
   * The invocation is NEVER repeated. Recovery either:
   *  1. Fails the run with `unknown_effect` if any non-replayable invocation
   *     is in an unresolved state, or
   *  2. Returns without terminalizing if no non-replayable effects are found
   *     (the worker may safely proceed with re-execution of replay-safe
   *     effects).
   *
   * This method is fenced by the lease token: a stale worker whose lease
   * was stolen by another worker cannot terminalize the run
   * (VAL-RUN-085).
   */
  async checkNonReplayableEffects(input: {
    companyId: string;
    projectId: string;
    runId: string;
    /** Lease token for fenced mutation. */
    leaseToken: string;
    traceId?: string | null;
    actorType?: 'user' | 'agent' | 'system';
    actorId?: string | null;
  }): Promise<RecoveryResult> {
    const { companyId, projectId, runId, leaseToken } = input;
    const traceId = input.traceId ?? null;
    const actorType = input.actorType ?? 'system';
    const actorId = input.actorId ?? null;

    return this.db.drizzle.transaction(async (tx) => {
      // Lock the run row.
      const run = await this.lockRun(tx, companyId, projectId, runId);

      // Fenced mutation: verify the lease token matches.
      if (run.leaseToken !== leaseToken) {
        throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
      }

      // Terminal runs are immutable — no-op.
      if (TERMINAL_STATUSES.has(run.status)) {
        return {
          terminalized: false,
          status: run.status,
          stateVersion: run.stateVersion,
          lastEventSequence: Number(run.lastEventSequence),
          effects: { found: false, invocationIds: [], toolIds: [] },
          failureCategory: run.failureCategory,
          failureCode: run.failureCode,
        };
      }

      // Check for non-replayable invocations in unresolved states.
      const effects = await this.findUnresolvedNonReplayable(tx, runId);

      if (!effects.found) {
        // No non-replayable effects in unresolved state — safe to proceed.
        return {
          terminalized: false,
          status: run.status,
          stateVersion: run.stateVersion,
          lastEventSequence: Number(run.lastEventSequence),
          effects,
          failureCategory: run.failureCategory,
          failureCode: run.failureCode,
        };
      }

      // Mark unresolved non-replayable invocations as `unknown`.
      await this.markInvocationsUnknown(tx, runId, effects.invocationIds);

      // Fail the run with `unknown_effect` failure category.
      return this.failRunWithUnknownEffect(tx, run, {
        effects,
        traceId,
        actorType,
        actorId,
      });
    });
  }

  /**
   * Mark non-replayable tool invocations as `unknown` when their state is
   * `prepared` or `started` at recovery time. This records that an
   * irreversible call may have happened but no result was committed
   * (architecture: Tool/external call state).
   */
  async markUnresolvedAsUnknown(input: {
    companyId: string;
    projectId: string;
    runId: string;
    /** Lease token for fenced mutation. */
    leaseToken: string;
  }): Promise<{ marked: number }> {
    return this.db.drizzle.transaction(async (tx) => {
      // Lock the run and verify lease.
      const run = await this.lockRun(tx, input.companyId, input.projectId, input.runId);
      if (run.leaseToken !== input.leaseToken) {
        throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
      }

      const invocations = await this.findUnresolvedNonReplayable(tx, input.runId);
      if (invocations.found) {
        await this.markInvocationsUnknown(tx, input.runId, invocations.invocationIds);
      }
      return { marked: invocations.invocationIds.length };
    });
  }

  // -- internal helpers -----------------------------------------------------

  private async findUnresolvedNonReplayable(
    tx: Tx,
    runId: string,
  ): Promise<NonReplayableEffectResult> {
    const schema = this.db.schema;
    const rows = await tx
      .select({
        id: schema.runToolInvocations.id,
        toolId: schema.runToolInvocations.toolId,
        state: schema.runToolInvocations.state,
      })
      .from(schema.runToolInvocations)
      .where(
        and(
          eq(schema.runToolInvocations.runId, runId),
          eq(schema.runToolInvocations.replayClass, 'non_replayable'),
          inArray(schema.runToolInvocations.state, ['prepared', 'started', 'unknown']),
        ),
      );

    if (rows.length === 0) {
      return { found: false, invocationIds: [], toolIds: [] };
    }

    return {
      found: true,
      invocationIds: rows.map((r) => r.id),
      toolIds: rows.map((r) => r.toolId),
    };
  }

  private async markInvocationsUnknown(
    tx: Tx,
    runId: string,
    invocationIds: string[],
  ): Promise<void> {
    const schema = this.db.schema;
    const now = this.now();
    for (const id of invocationIds) {
      await tx
        .update(schema.runToolInvocations)
        .set({
          state: 'unknown',
          updatedAt: now,
        })
        .where(eq(schema.runToolInvocations.id, id));
    }
  }

  private async failRunWithUnknownEffect(
    tx: Tx,
    run: MissionRunRow,
    ctx: {
      effects: NonReplayableEffectResult;
      traceId: string | null;
      actorType: 'user' | 'agent' | 'system';
      actorId: string | null;
    },
  ): Promise<RecoveryResult> {
    const schema = this.db.schema;
    const now = this.now();
    const newVersion = run.stateVersion + 1;
    const seq = Number(run.lastEventSequence) + 1;

    const safeMessage =
      'A non-replayable operation was interrupted and may or may not have completed. ' +
      'The run was stopped to prevent duplicate effects. Retry the mission to start fresh.';

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'failed',
        terminalAt: now,
        failureCategory: 'unknown_effect',
        failureCode: 'NON_REPLAYABLE_UNRESOLVED',
        safeErrorMessage: safeMessage,
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

    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'run.failed',
      schemaVersion: 1,
      payload: {
        category: 'unknown_effect',
        code: 'NON_REPLAYABLE_UNRESOLVED',
        safeMessage,
        toolIds: ctx.effects.toolIds,
        invocationCount: ctx.effects.invocationIds.length,
        retryGuidance:
          'Retry the mission to start a fresh run. The interrupted operation was not repeated to prevent duplicate effects.',
      },
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      traceId: ctx.traceId,
      occurredAt: now,
    });

    // Release residual budget.
    const { BudgetService } = await import('./budget.js');
    const budgetService = new BudgetService(this.db, { clock: () => now });
    await budgetService.release(tx, { companyId: run.companyId, runId: run.id });

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
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      traceId: ctx.traceId,
      occurredAt: now,
    });

    return {
      terminalized: true,
      status: 'failed',
      stateVersion: budgetSeq > newVersion ? budgetSeq : newVersion,
      lastEventSequence: budgetSeq,
      effects: ctx.effects,
      failureCategory: 'unknown_effect',
      failureCode: 'NON_REPLAYABLE_UNRESOLVED',
    };
  }

  private async lockRun(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<MissionRunRow> {
    const schema = this.db.schema;
    const [row] = await tx
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
    if (!row) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }
    return row;
  }
}
