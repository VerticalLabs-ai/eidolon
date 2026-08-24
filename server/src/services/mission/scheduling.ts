import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../../types.js';
import { PLATFORM_HARD_CAPS } from './modes.js';
import { AppError } from '../../middleware/error-handler.js';

/**
 * SchedulingService — manages child execution running permits
 * (VAL-SUB-109).
 *
 * Each routed child acquires root_running and parent_running permits
 * immediately before active work (transitioning from queued to running) and
 * releases them idempotently on terminalization or awaiting_input.
 *
 * Invariants:
 * - Dependency-pending shells reserve no agent or running slot.
 * - Ready routing atomically reserves one agent admission slot and child
 *   allocation (owned by AgentRouter).
 * - Root running permits: at most 4 running descendants (platform hard cap)
 *   and <= the root policy fan-out.
 * - Parent running permits: at most the parent policy fan-out running
 *   children per parent.
 * - An assigned child resumes from awaiting_input only after reacquiring
 *   permits for the same agent within its absolute deadline and never
 *   reroutes.
 * - Cancellation, failure, lease loss, deadline, and recovery cannot leak
 *   or double-release permits (release is idempotent).
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export interface SchedulingDeps {
  clock?: () => Date;
  /**
   * Optional deterministic-test seam invoked after the held-permit count
   * checks pass and before permit rows are inserted. Production never sets
   * this. It lets concurrency regression tests force two workers to reach
   * the count simultaneously so a missing FOR UPDATE fence reliably
   * over-acquires (VAL-SUB-109).
   */
  onAfterPermitCount?: () => Promise<void>;
}

/** Context for acquiring running permits. */
export interface AcquirePermitsContext {
  companyId: string;
  projectId: string;
  rootRunId: string;
  parentRunId: string;
  runId: string;
  /** Root policy fan-out limit. */
  rootFanOut: number;
  /** Parent policy fan-out limit. */
  parentFanOut: number;
}

/** Result of acquiring permits. */
export interface AcquirePermitsResult {
  rootPermitId: string;
  parentPermitId: string;
}

export class SchedulingService {
  constructor(
    private db: DbInstance,
    private deps: SchedulingDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Atomically acquire root_running and parent_running permits for a child
   * run immediately before active work (VAL-SUB-109).
   *
   * Checks:
   * - Root running count < PLATFORM_HARD_CAPS.descendants (4) and < rootFanOut
   * - Parent running count < parentFanOut
   *
   * Both permits are inserted in the same transaction. If either limit is
   * exceeded, throws 409 LIMIT_EXCEEDED and inserts no permits.
   *
   * Must be called inside a locked transaction.
   */
  async acquireRunningPermits(tx: Tx, ctx: AcquirePermitsContext): Promise<AcquirePermitsResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Acquire a FOR UPDATE lock on the root run (and parent run) before
    // counting held permits (VAL-SUB-109). Without this fence, two
    // concurrent workers can both read 0 held permits from a plain SELECT
    // and both insert, over-acquiring beyond the platform fan-out hard cap.
    // The row lock serializes the count+insert critical section: the second
    // worker blocks until the first commits, then sees the updated count.
    await this.lockRootAndParent(tx, ctx);

    // Count held root_running permits for this root run.
    const [rootCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runSchedulingPermits)
      .where(
        and(
          eq(schema.runSchedulingPermits.rootRunId, ctx.rootRunId),
          eq(schema.runSchedulingPermits.permitKind, 'root_running'),
          eq(schema.runSchedulingPermits.status, 'held'),
        ),
      );

    const rootRunning = rootCount?.count ?? 0;
    const rootLimit = Math.min(PLATFORM_HARD_CAPS.fanOut, ctx.rootFanOut);
    if (rootRunning >= rootLimit) {
      throw new AppError(
        409,
        'LIMIT_EXCEEDED',
        `Root running permit limit reached (${rootRunning}/${rootLimit}).`,
      );
    }

    // Count held parent_running permits for this parent run.
    const [parentCount] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runSchedulingPermits)
      .where(
        and(
          eq(schema.runSchedulingPermits.parentRunId, ctx.parentRunId),
          eq(schema.runSchedulingPermits.permitKind, 'parent_running'),
          eq(schema.runSchedulingPermits.status, 'held'),
        ),
      );

    const parentRunning = parentCount?.count ?? 0;
    const parentLimit = ctx.parentFanOut;
    if (parentRunning >= parentLimit) {
      throw new AppError(
        409,
        'LIMIT_EXCEEDED',
        `Parent running permit limit reached (${parentRunning}/${parentLimit}).`,
      );
    }

    // Deterministic-test seam: pause after both count checks pass so
    // concurrent workers overlap before inserting (VAL-SUB-109). No-op in
    // production.
    if (this.deps.onAfterPermitCount) {
      await this.deps.onAfterPermitCount();
    }

    // Check if permits already exist (idempotent reacquire after
    // awaiting_input, or first acquire).
    const existing = await tx
      .select({
        id: schema.runSchedulingPermits.id,
        permitKind: schema.runSchedulingPermits.permitKind,
        status: schema.runSchedulingPermits.status,
      })
      .from(schema.runSchedulingPermits)
      .where(eq(schema.runSchedulingPermits.runId, ctx.runId));

    const heldPermits = existing.filter((e) => e.status === 'held');
    if (heldPermits.length >= 2) {
      // Already held — return existing IDs (idempotent).
      const root = heldPermits.find((p) => p.permitKind === 'root_running');
      const parent = heldPermits.find((p) => p.permitKind === 'parent_running');
      return {
        rootPermitId: root?.id ?? heldPermits[0].id,
        parentPermitId: parent?.id ?? heldPermits[1].id,
      };
    }

    // If permits exist but are released (reacquire after awaiting_input),
    // update them back to held. This maintains one lifecycle per permit —
    // no duplicate rows (VAL-SUB-109).
    const releasedPermits = existing.filter((e) => e.status === 'released');
    if (releasedPermits.length >= 2) {
      // Reactivate existing released permits.
      await tx
        .update(schema.runSchedulingPermits)
        .set({
          status: 'held',
          acquiredAt: now,
          releasedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.runSchedulingPermits.runId, ctx.runId),
            eq(schema.runSchedulingPermits.status, 'released'),
          ),
        );

      const root = releasedPermits.find((p) => p.permitKind === 'root_running');
      const parent = releasedPermits.find((p) => p.permitKind === 'parent_running');
      return {
        rootPermitId: root?.id ?? releasedPermits[0].id,
        parentPermitId: parent?.id ?? releasedPermits[1].id,
      };
    }

    // Insert root_running permit.
    const rootPermitId = randomUUID();
    await tx.insert(schema.runSchedulingPermits).values({
      id: rootPermitId,
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      rootRunId: ctx.rootRunId,
      parentRunId: ctx.parentRunId,
      runId: ctx.runId,
      permitKind: 'root_running',
      status: 'held',
      acquiredAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Insert parent_running permit.
    const parentPermitId = randomUUID();
    await tx.insert(schema.runSchedulingPermits).values({
      id: parentPermitId,
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      rootRunId: ctx.rootRunId,
      parentRunId: ctx.parentRunId,
      runId: ctx.runId,
      permitKind: 'parent_running',
      status: 'held',
      acquiredAt: now,
      createdAt: now,
      updatedAt: now,
    });

    return { rootPermitId, parentPermitId };
  }

  /**
   * Acquire a `FOR UPDATE` lock on the root run and parent run before
   * counting held permits (VAL-SUB-109). Lock order is root-then-parent,
   * mirroring BudgetService.allocateChild and AgentRouter.routeChild, to
   * avoid deadlocks. Re-locking the same row (root === parent) within one
   * transaction is a no-op. Must be called inside a transaction.
   */
  private async lockRootAndParent(tx: Tx, ctx: AcquirePermitsContext): Promise<void> {
    const schema = this.db.schema;

    const [rootRun] = await tx
      .select()
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, ctx.companyId),
          eq(schema.missionRuns.id, ctx.rootRunId),
        ),
      )
      .for('update')
      .limit(1);

    if (!rootRun) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Root run not found.');
    }

    if (ctx.parentRunId !== ctx.rootRunId) {
      const [parentRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(
          and(
            eq(schema.missionRuns.companyId, ctx.companyId),
            eq(schema.missionRuns.id, ctx.parentRunId),
          ),
        )
        .for('update')
        .limit(1);

      if (!parentRun) {
        throw new AppError(404, 'RUN_NOT_FOUND', 'Parent run not found.');
      }
    }
  }

  /**
   * Idempotently release all held permits for a run (VAL-SUB-109).
   *
   * Called on terminalization (completed/failed/cancelled) or when a child
   * transitions to awaiting_input. Release is idempotent: if permits are
   * already released, this is a no-op. Cancellation, failure, lease loss,
   * deadline, and recovery cannot leak or double-release permits.
   *
   * Must be called inside a transaction.
   */
  async releasePermits(tx: Tx, runId: string): Promise<{ released: number }> {
    const schema = this.db.schema;
    const now = this.now();

    // Find held permits for this run.
    const heldPermits = await tx
      .select({ id: schema.runSchedulingPermits.id })
      .from(schema.runSchedulingPermits)
      .where(
        and(
          eq(schema.runSchedulingPermits.runId, runId),
          eq(schema.runSchedulingPermits.status, 'held'),
        ),
      );

    if (heldPermits.length === 0) {
      return { released: 0 };
    }

    // Release all held permits.
    await tx
      .update(schema.runSchedulingPermits)
      .set({
        status: 'released',
        releasedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.runSchedulingPermits.runId, runId),
          eq(schema.runSchedulingPermits.status, 'held'),
        ),
      );

    return { released: heldPermits.length };
  }

  /**
   * Reacquire permits for a child resuming from awaiting_input
   * (VAL-SUB-109).
   *
   * An assigned child resumes only after reacquiring permits for the same
   * agent within its absolute deadline and never reroutes. This method
   * first releases any stale held permits (shouldn't exist, but defensive),
   * then acquires fresh permits subject to the same limits.
   *
   * Must be called inside a locked transaction.
   */
  async reacquirePermits(tx: Tx, ctx: AcquirePermitsContext): Promise<AcquirePermitsResult> {
    // Release any existing permits first (defensive — should be released
    // when the child entered awaiting_input).
    await this.releasePermits(tx, ctx.runId);

    // Acquire fresh permits.
    return this.acquireRunningPermits(tx, ctx);
  }

  /**
   * Count held permits of a specific kind for a root run.
   */
  async countHeldPermits(
    runner: Tx | DbInstance['drizzle'],
    rootRunId: string,
    permitKind: 'root_running' | 'parent_running',
  ): Promise<number> {
    const schema = this.db.schema;
    const [row] = await runner
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runSchedulingPermits)
      .where(
        and(
          eq(schema.runSchedulingPermits.rootRunId, rootRunId),
          eq(schema.runSchedulingPermits.permitKind, permitKind),
          eq(schema.runSchedulingPermits.status, 'held'),
        ),
      );
    return row?.count ?? 0;
  }

  /**
   * Get all permits for a run (for inspection/testing).
   */
  async getPermitsForRun(runId: string) {
    const schema = this.db.schema;
    return this.db.drizzle
      .select()
      .from(schema.runSchedulingPermits)
      .where(eq(schema.runSchedulingPermits.runId, runId));
  }
}
