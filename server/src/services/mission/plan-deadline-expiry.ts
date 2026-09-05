import { and, eq } from 'drizzle-orm';
import type { DbInstance } from '../../types.js';
import { BudgetService } from './budget.js';

/**
 * Root-deadline expiry terminalization for a run awaiting approval
 * (VAL-PLAN-115).
 *
 * The root hold remains valid only through the immutable
 * `rootDeadlineAt`; there is no separate approval TTL. When a sweeper
 * crosses that deadline while the run awaits a human decision, this
 * function atomically:
 *
 *  - Fails the run with category `limit` and code `TIME_LIMIT`.
 *  - Closes the governance gate as `expired_without_decision` by
 *    resolving the pending approval as `cancelled` (the binding's
 *    `decision` remains null, and the revision status remains
 *    `proposed`, so the derived gate outcome is
 *    `expired_without_decision`).
 *  - Releases residual budget.
 *  - Emits `run.failed` + `budget.released` journal events.
 *  - Leaves only new-run retry as a recovery path.
 *
 * Approval at/after expiry returns `409 INVALID_RUN_STATE` because the
 * run is no longer in `awaiting_approval` (it is `failed`). A
 * pre-deadline budget shortfall leaves the gate open for a lower-budget
 * revision (handled by `BudgetService.earmarkApproval` returning
 * `BUDGET_UNAVAILABLE` without terminalizing).
 *
 * Must be called inside a locked transaction where the run row is
 * already locked via `FOR UPDATE`.
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
}

export interface DeadlineExpiryResult {
  terminalized: boolean;
  stateVersion: number;
  lastEventSequence: number;
}

/**
 * Terminalize a run whose root deadline has expired while in
 * `awaiting_approval`.
 */
export async function terminalizeForApprovalDeadlineExpiry(
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

  // Resolve the pending approval as cancelled (gate closed without
  // decision). The binding's decision stays null and the revision
  // status stays 'proposed', so the derived gate outcome is
  // 'expired_without_decision' (VAL-PLAN-121).
  const currentRevisionId = run.currentPlanRevisionId;
  if (currentRevisionId) {
    const [binding] = await tx
      .select()
      .from(schema.runPlanApprovalBindings)
      .where(
        and(
          eq(schema.runPlanApprovalBindings.companyId, run.companyId),
          eq(schema.runPlanApprovalBindings.runId, run.id),
          eq(schema.runPlanApprovalBindings.planRevisionId, currentRevisionId),
        ),
      )
      .limit(1);
    if (binding) {
      await tx
        .update(schema.approvals)
        .set({
          status: 'cancelled',
          resolvedAt: now,
          updatedAt: now,
        })
        .where(eq(schema.approvals.id, binding.approvalId));
    }
  }

  // Fail the run with category `limit` and code `TIME_LIMIT`.
  const newVersion = run.stateVersion + 1;
  const seqFailed = Number(run.lastEventSequence) + 1;
  const seqBudgetReleased = seqFailed + 1;

  await tx
    .update(schema.missionRuns)
    .set({
      status: 'failed',
      failureCategory: 'limit',
      failureCode: 'TIME_LIMIT',
      safeErrorMessage: 'The Mission wall-time deadline expired while awaiting approval.',
      terminalAt: now,
      leaseOwner: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      availableAt: null,
      // currentPlanRevisionId is intentionally NOT cleared so the gate
      // outcome can be derived as expired_without_decision.
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
      safeMessage: 'The Mission wall-time deadline expired while awaiting approval.',
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
