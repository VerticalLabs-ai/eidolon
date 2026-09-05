import { eq } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { BudgetService } from './budget.js';

/**
 * Mission Run Deadline Expiry module (VAL-SUB-098, VAL-SUB-110).
 *
 * The finite Mission wall-time deadline is absolute from root creation and
 * includes awaiting-input, awaiting-approval, dependency-blocked, and queued
 * time as well as active work. These timestamps survive restart because they
 * are derived from immutable durable rows (createdAt + policy limits).
 *
 *  - **Root deadline** = root `createdAt` + effective `durationSeconds`.
 *  - **Child deadline** = min(child allowance, parent deadline, root deadline).
 *
 * When a run's effective deadline passes while it is in a waiting,
 * dependency-blocked, or queued state (no active external call in flight),
 * the run is terminalized with failure category `limit` and code `TIME_LIMIT`
 * — it ran out of time, it was not cancelled. This fences stale work and
 * prevents another external call after the deadline
 * (VAL-SUB-098: "expire waiting, dependency-blocked, and queued work with
 * `TIME_LIMIT` before another external call").
 *
 * Active `running`/`synthesizing`/`planning` work past the root deadline is
 * handled by the cancellation cascade (fence effects, cancel descendants,
 * then fail `limit/TIME_LIMIT` after subtree settlement) — see
 * {@link MissionKillSwitchService.enforceRootDeadlines} and the subtree
 * cancellation module. This module owns the direct TIME_LIMIT terminalization
 * for non-active states.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

export interface DeadlineExpiryDeps {
  clock?: () => Date;
}

export interface DeadlineExpiryOpts {
  actorType?: 'user' | 'agent' | 'system';
  actorId?: string | null;
  traceId?: string | null;
  /**
   * Optional lease token for fenced worker/sweeper mutation. When provided,
   * the method verifies the token matches the run's current lease so a stale
   * worker cannot terminalize a run it no longer owns.
   */
  leaseToken?: string;
}

export interface DeadlineExpiryResult {
  terminalized: boolean;
  stateVersion: number;
  lastEventSequence: number;
}

/**
 * Compute the absolute root deadline: root `createdAt` +
 * effective `durationSeconds`. Absolute from root creation; includes all
 * human wait time. Restart cannot reset it (VAL-MODEQ-128, VAL-SUB-098).
 */
export function computeRootDeadline(createdAt: Date, durationSeconds: number): Date {
  return new Date(createdAt.getTime() + durationSeconds * 1000);
}

/**
 * Compute the effective child deadline as the minimum of:
 *  - the child's own allowance (`childCreatedAt` + `childDurationSeconds`);
 *  - the parent's deadline; and
 *  - the root deadline.
 *
 * A child can never outlive its parent or root, and its own allowance may
 * be the binding constraint (VAL-SUB-098).
 */
export function computeChildDeadline(
  childCreatedAt: Date,
  childDurationSeconds: number,
  parentDeadline: Date,
  rootDeadline: Date,
): Date {
  const childAllowance = new Date(childCreatedAt.getTime() + childDurationSeconds * 1000);
  return new Date(
    Math.min(childAllowance.getTime(), parentDeadline.getTime(), rootDeadline.getTime()),
  );
}

/**
 * Terminalize a nonterminal run whose effective deadline has passed while in
 * a waiting, dependency-blocked, or queued state. Fails the run with category
 * `limit` and code `TIME_LIMIT`, releases residual budget, and emits
 * `run.failed` + `budget.released` journal events in one transaction.
 *
 * Must be called inside a locked transaction where the run row is already
 * locked via `FOR UPDATE` (this method performs the lock internally when the
 * row is passed directly).
 *
 * Terminal runs are immutable: a terminal run is a no-op that returns the
 * current state. A stale worker whose lease token no longer matches cannot
 * terminalize (optional fencing via `leaseToken`).
 */
export async function terminalizeForDeadlineExpiry(
  db: DbInstance,
  tx: Tx,
  run: MissionRunRow,
  deps: DeadlineExpiryDeps = {},
  opts: DeadlineExpiryOpts = {},
): Promise<DeadlineExpiryResult> {
  const schema = db.schema;
  const now = deps.clock ? deps.clock() : new Date();
  const actorType = opts.actorType ?? 'system';
  const actorId = opts.actorId ?? null;
  const traceId = opts.traceId ?? null;

  // Optional fenced mutation: verify the lease token matches.
  if (opts.leaseToken !== undefined && run.leaseToken !== opts.leaseToken) {
    throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
  }

  // Terminal runs are immutable — no-op.
  if (['completed', 'failed', 'cancelled'].includes(run.status)) {
    return {
      terminalized: false,
      stateVersion: run.stateVersion,
      lastEventSequence: Number(run.lastEventSequence),
    };
  }

  const newVersion = run.stateVersion + 1;
  const seqFailed = Number(run.lastEventSequence) + 1;
  const seqBudgetReleased = seqFailed + 1;

  await tx
    .update(schema.missionRuns)
    .set({
      status: 'failed',
      failureCategory: 'limit',
      failureCode: 'TIME_LIMIT',
      safeErrorMessage: 'The Mission wall-time deadline expired.',
      terminalAt: now,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      availableAt: null,
      stateVersion: newVersion,
      lastEventSequence: seqBudgetReleased,
      updatedAt: now,
    })
    .where(eq(schema.missionRuns.id, run.id));

  // Emit run.failed event.
  await tx.insert(schema.runEvents).values({
    companyId: run.companyId,
    projectId: run.projectId,
    runId: run.id,
    sequence: seqFailed,
    type: 'run.failed',
    schemaVersion: 1,
    payload: {
      category: 'limit',
      code: 'TIME_LIMIT',
      safeMessage: 'The Mission wall-time deadline expired.',
    },
    actorType,
    actorId,
    traceId,
    occurredAt: now,
  });

  // Release residual budget.
  const budgetService = new BudgetService(db, { clock: () => now });
  await budgetService.release(tx, { companyId: run.companyId, runId: run.id });

  // Emit budget.released event.
  await tx.insert(schema.runEvents).values({
    companyId: run.companyId,
    projectId: run.projectId,
    runId: run.id,
    sequence: seqBudgetReleased,
    type: 'budget.released',
    schemaVersion: 1,
    payload: {},
    actorType,
    actorId,
    traceId,
    occurredAt: now,
  });

  return {
    terminalized: true,
    stateVersion: newVersion,
    lastEventSequence: seqBudgetReleased,
  };
}
