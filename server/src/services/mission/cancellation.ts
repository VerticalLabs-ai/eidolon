import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { BudgetService } from './budget.js';

/**
 * Mission Cancellation module (VAL-RUN-117, VAL-RUN-136).
 *
 * Cancellation is cooperative but real. The command atomically records
 * request time/actor, computes a bounded convergence deadline, cascades
 * cancellation requests to descendants, and emits events. For non-lease
 * states (no active worker), the run is terminalized immediately in the
 * same transaction. For lease states, the worker observes the cancellation
 * and calls {@link MissionCancellationService.terminalize} to complete the
 * transition. The deadline ensures convergence even if the worker is
 * unavailable.
 *
 * Terminalization:
 *  - Transitions the run to `cancelled`, sets `terminal_at`.
 *  - Releases residual budget via {@link BudgetService.release}.
 *  - Emits `run.cancelled` and `budget.released` journal events.
 *  - Cascades to nonterminal descendants.
 *
 * The cancellation deadline is no later than the earlier of the root run
 * deadline and 60 seconds after `cancel_requested_at` (VAL-RUN-136).
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

/** Maximum convergence window after a cancellation request (60 seconds). */
const CANCELLATION_WINDOW_MS = 60_000;

/** States with no active worker lease — cancellation terminalizes immediately. */
const NON_LEASE_STATES = new Set(['draft', 'awaiting_input', 'planning', 'awaiting_approval']);

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export interface CancellationDeps {
  clock?: () => Date;
}

export interface RequestCancellationInput {
  companyId: string;
  projectId: string;
  runId: string;
  /** Actor requesting the cancellation. */
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  traceId?: string | null;
}

export interface CancellationResult {
  /** HTTP status: 202 for nonterminal, 200 for already-terminal. */
  statusCode: number;
  /** New state version (ETag). */
  stateVersion: number;
  /** Whether the run was terminalized in this transaction. */
  terminalized: boolean;
  /** Run status after the operation. */
  status: string;
  /** Cancellation deadline ISO string, or null if already terminal. */
  cancellationDeadlineAt: string | null;
  /** Latest event sequence after the operation. */
  lastEventSequence: number;
}

/**
 * Compute the bounded cancellation deadline.
 *
 * `cancellationDeadlineAt = min(rootDeadline, cancelRequestedAt + 60s)`
 * where `rootDeadline = rootRun.createdAt + rootPolicy.limits.durationSeconds * 1000`.
 */
export function computeCancellationDeadline(
  cancelRequestedAt: Date,
  rootCreatedAt: Date,
  rootDurationSeconds: number,
): Date {
  const cancelPlusWindow = new Date(cancelRequestedAt.getTime() + CANCELLATION_WINDOW_MS);
  const rootDeadline = new Date(rootCreatedAt.getTime() + rootDurationSeconds * 1000);
  return rootDeadline < cancelPlusWindow ? rootDeadline : cancelPlusWindow;
}

export class MissionCancellationService {
  constructor(
    private db: DbInstance,
    private deps: CancellationDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Request cancellation of a run. Records the cancel request, computes the
   * bounded deadline, cascades to descendants, and for non-lease states
   * terminalizes immediately. Must be called inside a locked transaction
   * where the run row is already locked via `FOR UPDATE`.
   */
  async requestCancellation(
    tx: Tx,
    run: MissionRunRow,
    input: RequestCancellationInput,
  ): Promise<CancellationResult> {
    const schema = this.db.schema;
    const now = this.now();
    const traceId = input.traceId ?? null;

    // Compute the root deadline from the root run's policy snapshot.
    const rootRun = await this.loadRootRun(tx, run.companyId, run.projectId, run.rootRunId);
    const rootDurationSeconds = await this.readDurationSeconds(tx, rootRun);
    const deadline = computeCancellationDeadline(now, rootRun.createdAt, rootDurationSeconds);

    // Record the cancel request on the run.
    const newVersion = run.stateVersion + 1;
    const seq = Number(run.lastEventSequence) + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        cancelRequestedAt: now,
        cancelRequestedBy: input.actorId,
        cancellationDeadlineAt: deadline,
        stateVersion: newVersion,
        lastEventSequence: seq,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // Emit run.cancel_requested event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'run.cancel_requested',
      schemaVersion: 1,
      payload: {
        requestedBy: input.actorId,
        cancellationDeadlineAt: deadline.toISOString(),
      },
      actorType: input.actorType,
      actorId: input.actorId,
      traceId,
      occurredAt: now,
    });

    // Cascade cancellation to nonterminal descendants.
    await this.cascadeToDescendants(tx, run, now, deadline, input, traceId);

    // Terminalize immediately if there is no active worker lease.
    // Non-lease states (draft, awaiting_input, planning, awaiting_approval)
    // never have a lease. Lease states (queued, running, synthesizing)
    // without an active lease also have no worker to observe the
    // cancellation, so they are terminalized immediately
    // (VAL-SUB-046, VAL-SUB-050).
    const hasActiveLease =
      run.leaseOwner !== null && run.leaseExpiresAt !== null && run.leaseExpiresAt > now;
    if (!hasActiveLease) {
      const result = await this.terminalize(tx, run.companyId, run.projectId, run.id, {
        actorType: input.actorType,
        actorId: input.actorId,
        traceId,
        fromVersion: newVersion,
        fromSequence: seq,
      });

      // VAL-SUB-050: If this is a child run that was terminalized, apply
      // the parent's snapshotted partial_result_policy. Under require_all,
      // cascade cancellation to remaining required siblings. Under
      // best_effort, allow siblings to continue.
      if (result.terminalized && run.parentRunId !== null && run.parentRunId !== run.id) {
        await this.applyParentPolicyOnChildTerminal(
          tx,
          run.companyId,
          run.projectId,
          run.id,
          run.parentRunId,
          run.rootRunId,
          'cancelled',
          input,
          traceId,
        );
      }

      return { ...result, statusCode: 202 };
    }

    // For lease states with an active lease, the worker will terminalize
    // when it observes the cancellation. Return 202 with the deadline.
    return {
      statusCode: 202,
      stateVersion: newVersion,
      terminalized: false,
      status: run.status,
      cancellationDeadlineAt: deadline.toISOString(),
      lastEventSequence: seq,
    };
  }

  /**
   * Terminalize a cancel-requested run. Transitions to `cancelled`, releases
   * residual budget, and emits `run.cancelled` + `budget.released` events.
   * Called by the worker when it observes the cancellation, or by a
   * deadline enforcer. Idempotent: a terminal run is a no-op.
   */
  async terminalize(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
    opts: {
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
      /** Internal: version/sequence after requestCancellation, to avoid a re-read. */
      fromVersion?: number;
      fromSequence?: number;
      /**
       * Lease token for fenced worker mutations. When provided, verifies
       * the token matches the run's current lease (VAL-RUN-119, VAL-RUN-120).
       */
      leaseToken?: string;
    },
  ): Promise<CancellationResult> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = opts.actorType ?? 'system';
    const actorId = opts.actorId ?? null;
    const traceId = opts.traceId ?? null;

    // Lock the run.
    const run = await this.lockRun(tx, companyId, projectId, runId);

    // Fenced mutation: verify lease token when provided (worker path).
    if (opts.leaseToken !== undefined && run.leaseToken !== opts.leaseToken) {
      throw new AppError(409, 'LEASE_NOT_HELD', 'Lease is no longer held by this worker');
    }

    // Terminal runs are immutable.
    if (TERMINAL_STATUSES.has(run.status)) {
      return {
        statusCode: 200,
        stateVersion: run.stateVersion,
        terminalized: false,
        status: run.status,
        cancellationDeadlineAt: run.cancellationDeadlineAt
          ? run.cancellationDeadlineAt.toISOString()
          : null,
        lastEventSequence: Number(run.lastEventSequence),
      };
    }

    // Only terminalize if cancellation was requested.
    if (run.cancelRequestedAt === null) {
      throw new AppError(
        409,
        'INVALID_RUN_STATE',
        'Cannot terminalize a run without a cancellation request',
      );
    }

    // Subtree-terminal barrier (VAL-SUB-048, VAL-SUB-110):
    // A cancelling run cannot terminally cancel until every descendant
    // in its subtree is terminal. If nonterminal descendants exist, return
    // without terminalizing — the worker or deadline enforcer will retry
    // via tryTerminalizeIfReady once descendants settle.
    const hasNonterminal = await this.checkNonterminalDescendants(
      tx,
      run.companyId,
      run.projectId,
      run.id,
    );
    if (hasNonterminal) {
      return {
        statusCode: 200,
        stateVersion: run.stateVersion,
        terminalized: false,
        status: run.status,
        cancellationDeadlineAt: run.cancellationDeadlineAt
          ? run.cancellationDeadlineAt.toISOString()
          : null,
        lastEventSequence: Number(run.lastEventSequence),
      };
    }

    const baseVersion = opts.fromVersion ?? run.stateVersion;
    let baseSeq = opts.fromSequence ?? Number(run.lastEventSequence);

    // Invalidate any open question set before terminalizing (VAL-MODEQ-142,
    // VAL-MODEQ-150). The invalidation event is emitted before the
    // cancelled transition so ordered replay shows closure of the set
    // before the run closes.
    if (run.currentQuestionSetId) {
      const { MissionQuestionPublicationService } = await import('./question-publication.js');
      const pubService = new MissionQuestionPublicationService(this.db, { clock: () => now });
      const invResult = await pubService.invalidateOpenSet(tx, run, 'cancelled', {
        actorType,
        actorId,
        traceId,
        baseSequence: baseSeq + 1,
      });
      if (invResult.invalidated) {
        baseSeq = invResult.eventSequence!;
      }
    }

    // Close the governance gate as `cancelled_without_decision` when the
    // run is cancelled while a plan proposal is still open (VAL-PLAN-109,
    // VAL-PLAN-121). The binding's `decision` stays null and the revision
    // status stays `proposed`, so the derived gate outcome is
    // `cancelled_without_decision`. The approval row is resolved as
    // `cancelled` so it no longer appears pending.
    if (run.currentPlanRevisionId) {
      const [binding] = await tx
        .select()
        .from(schema.runPlanApprovalBindings)
        .where(
          and(
            eq(schema.runPlanApprovalBindings.companyId, run.companyId),
            eq(schema.runPlanApprovalBindings.runId, run.id),
            eq(schema.runPlanApprovalBindings.planRevisionId, run.currentPlanRevisionId),
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

    const newVersion = baseVersion + 1;
    const seq = baseSeq + 1;

    // Transition to cancelled.
    await tx
      .update(schema.missionRuns)
      .set({
        status: 'cancelled',
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

    // Emit run.cancelled event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'run.cancelled',
      schemaVersion: 1,
      payload: {
        cancellationDeadlineAt: run.cancellationDeadlineAt
          ? run.cancellationDeadlineAt.toISOString()
          : null,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Release residual budget.
    const budgetService = new BudgetService(this.db, { clock: () => now });
    await budgetService.release(tx, { companyId: run.companyId, runId: run.id });

    // VAL-SUB-050, 051, 064, 065, 111: For non-root (child) runs, update the
    // step assignment with the cancelled result and propagate the parent's
    // partial-result policy. Under require_all, this cascades cancellation
    // to remaining required siblings. Under best_effort, siblings continue.
    if (run.parentRunId !== null && run.parentRunId !== run.id) {
      await this.applyParentPolicyOnChildTerminal(
        tx,
        run.companyId,
        run.projectId,
        run.id,
        run.parentRunId,
        run.rootRunId,
        'cancelled',
        { actorType, actorId, traceId } as RequestCancellationInput,
        traceId,
      );
    }

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
      status: 'cancelled',
      cancellationDeadlineAt: run.cancellationDeadlineAt
        ? run.cancellationDeadlineAt.toISOString()
        : null,
      lastEventSequence: budgetSeq,
    };
  }

  // -- helpers --------------------------------------------------------------

  /**
   * Cascade cancellation to all nonterminal descendants. Sets
   * `cancel_requested_at`, `cancel_requested_by`, and
   * `cancellation_deadline_at` on every nonterminal descendant in one
   * recursive CTE transaction, and emits `child.cancel_requested` events.
   */
  private async cascadeToDescendants(
    tx: Tx,
    run: MissionRunRow,
    now: Date,
    deadline: Date,
    input: RequestCancellationInput,
    traceId: string | null,
  ): Promise<void> {
    const schema = this.db.schema;

    // Find all nonterminal descendants (children, grandchildren, etc.).
    // Use a recursive CTE to walk the parent_run_id chain.
    const descendants = await tx.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT "id", "company_id", "project_id", "status", "last_event_sequence", "state_version"
        FROM "mission_runs"
        WHERE "company_id" = ${run.companyId}
          AND "project_id" = ${run.projectId}
          AND "parent_run_id" = ${run.id}
          AND "status" NOT IN ('completed', 'failed', 'cancelled')
        UNION ALL
        SELECT c."id", c."company_id", c."project_id", c."status", c."last_event_sequence", c."state_version"
        FROM "mission_runs" c
        INNER JOIN descendants d ON c."parent_run_id" = d."id"
        WHERE c."company_id" = ${run.companyId}
          AND c."project_id" = ${run.projectId}
          AND c."status" NOT IN ('completed', 'failed', 'cancelled')
      )
      SELECT * FROM descendants
    `);

    const rows = descendants as unknown as Array<{
      id: string;
      company_id: string;
      project_id: string;
      status: string;
      last_event_sequence: number;
      state_version: number;
    }>;

    if (rows.length === 0) {
      return;
    }

    for (const child of rows) {
      const childSeq = child.last_event_sequence + 1;
      const childVersion = child.state_version + 1;

      // Set cancel_requested on the descendant.
      await tx
        .update(schema.missionRuns)
        .set({
          cancelRequestedAt: now,
          cancelRequestedBy: input.actorId,
          cancellationDeadlineAt: deadline,
          stateVersion: childVersion,
          lastEventSequence: childSeq,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, child.id));

      await tx.insert(schema.runEvents).values({
        companyId: child.company_id,
        projectId: child.project_id,
        runId: child.id,
        sequence: childSeq,
        type: 'child.cancel_requested',
        schemaVersion: 1,
        payload: {
          parentRunId: run.id,
          cancellationDeadlineAt: deadline.toISOString(),
        },
        actorType: input.actorType,
        actorId: input.actorId,
        traceId,
        occurredAt: now,
      });

      // VAL-SUB-046: Queued children must lose execution eligibility,
      // release their lease/allocation, and never emit child.started.
      // For non-lease-state descendants (draft, awaiting_input, planning,
      // awaiting_approval), terminalize immediately — they have no active
      // worker to observe the cancellation (VAL-SUB-045).
      if (NON_LEASE_STATES.has(child.status)) {
        // Terminalize the non-lease-state child immediately.
        await this.terminalize(tx, child.company_id, child.project_id, child.id, {
          actorType: input.actorType,
          actorId: input.actorId,
          traceId,
          fromVersion: childVersion,
          fromSequence: childSeq,
        });
      } else if (child.status === 'queued') {
        // Queued child: clear lease (if any), remove execution eligibility,
        // and release budget allocation (VAL-SUB-046).
        await tx
          .update(schema.missionRuns)
          .set({
            leaseOwner: null,
            leaseToken: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            availableAt: null,
            updatedAt: now,
          })
          .where(eq(schema.missionRuns.id, child.id));

        // Release the child's budget allocation.
        const budgetService = new BudgetService(this.db, { clock: () => now });
        await budgetService.release(tx, {
          companyId: child.company_id,
          runId: child.id,
        });
      }
      // Running/synthesizing children: the worker will observe
      // cancel_requested at bounded checkpoints and terminalize
      // (VAL-SUB-047).
    }
  }

  /**
   * Check whether a run has any nonterminal descendants in its subtree.
   * Uses a recursive CTE to walk the parent_run_id chain.
   * (VAL-SUB-048, VAL-SUB-110)
   *
   * Must be called inside a locked transaction.
   */
  private async checkNonterminalDescendants(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<boolean> {
    const result = await tx.execute(sql`
      WITH RECURSIVE descendants AS (
        SELECT "id", "status"
        FROM "mission_runs"
        WHERE "company_id" = ${companyId}
          AND "project_id" = ${projectId}
          AND "parent_run_id" = ${runId}
          AND "status" NOT IN ('completed', 'failed', 'cancelled')
        UNION ALL
        SELECT c."id", c."status"
        FROM "mission_runs" c
        INNER JOIN descendants d ON c."parent_run_id" = d."id"
        WHERE c."company_id" = ${companyId}
          AND c."project_id" = ${projectId}
          AND c."status" NOT IN ('completed', 'failed', 'cancelled')
      )
      SELECT count(*)::int AS cnt FROM descendants
    `);

    const rows = result as unknown as Array<{ cnt: number }>;
    return rows.length > 0 && Number(rows[0]!.cnt) > 0;
  }

  /**
   * Apply the parent's partial_result_policy when a child reaches a
   * terminal state. Under `require_all`, cascade cancellation to
   * remaining nonterminal siblings. Under `best_effort`, allow siblings
   * to continue. Also updates the child's step assignment with the
   * terminal result (VAL-SUB-050, VAL-SUB-110).
   *
   * Must be called inside a locked transaction.
   */
  private async applyParentPolicyOnChildTerminal(
    tx: Tx,
    companyId: string,
    projectId: string,
    childRunId: string,
    parentRunId: string,
    rootRunId: string,
    terminalStatus: 'completed' | 'failed' | 'cancelled',
    input: RequestCancellationInput,
    traceId: string | null,
  ): Promise<void> {
    const schema = this.db.schema;
    const now = this.now();

    // 1. Update the child's step assignment.
    await tx
      .update(schema.runStepAssignments)
      .set({
        assignmentStatus: terminalStatus,
        resultStatus: terminalStatus,
        updatedAt: now,
      })
      .where(eq(schema.runStepAssignments.runId, childRunId));

    // 2. Read the parent's partial_result_policy.
    const [parentRun] = await tx
      .select({
        partialResultPolicy: schema.missionRuns.partialResultPolicy,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
          eq(schema.missionRuns.id, parentRunId),
        ),
      )
      .limit(1);

    const parentPolicy = (parentRun?.partialResultPolicy ?? 'require_all') as
      'require_all' | 'best_effort';

    // 3. Under require_all, cascade cancellation to remaining nonterminal
    //    siblings. Under best_effort, allow siblings to continue.
    if (parentPolicy !== 'require_all') {
      return;
    }

    const siblings = await tx.execute(sql`
      SELECT "id", "status", "last_event_sequence", "state_version"
      FROM "mission_runs"
      WHERE "company_id" = ${companyId}
        AND "project_id" = ${projectId}
        AND "parent_run_id" = ${parentRunId}
        AND "id" != ${childRunId}
        AND "status" NOT IN ('completed', 'failed', 'cancelled')
    `);

    const siblingRows = siblings as unknown as Array<{
      id: string;
      status: string;
      last_event_sequence: number;
      state_version: number;
    }>;

    for (const sibling of siblingRows) {
      const siblingSeq = sibling.last_event_sequence + 1;
      const siblingVersion = sibling.state_version + 1;

      await tx
        .update(schema.missionRuns)
        .set({
          cancelRequestedAt: now,
          cancelRequestedBy: input.actorId,
          cancellationDeadlineAt: new Date(now.getTime() + 60_000),
          stateVersion: siblingVersion,
          lastEventSequence: siblingSeq,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, sibling.id));

      await tx.insert(schema.runEvents).values({
        companyId,
        projectId,
        runId: sibling.id,
        sequence: siblingSeq,
        type: 'child.cancel_requested',
        schemaVersion: 1,
        payload: {
          parentRunId,
          reason: 'require_all_policy_cascade',
          cancelledSibling: childRunId,
        },
        actorType: input.actorType,
        actorId: input.actorId,
        traceId,
        occurredAt: now,
      });

      // Terminalize the sibling immediately if it has no active lease.
      const hasActiveLease = await this.checkActiveLease(tx, companyId, projectId, sibling.id, now);
      if (!hasActiveLease) {
        await this.terminalize(tx, companyId, projectId, sibling.id, {
          actorType: input.actorType,
          actorId: input.actorId,
          traceId,
          fromVersion: siblingVersion,
          fromSequence: siblingSeq,
        });
      }
    }
  }

  /**
   * Check whether a run has an active (non-expired) lease.
   */
  private async checkActiveLease(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
    now: Date,
  ): Promise<boolean> {
    const schema = this.db.schema;
    const [run] = await tx
      .select({
        leaseOwner: schema.missionRuns.leaseOwner,
        leaseExpiresAt: schema.missionRuns.leaseExpiresAt,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
          eq(schema.missionRuns.id, runId),
        ),
      )
      .limit(1);
    return (
      run?.leaseOwner !== null &&
      run?.leaseOwner !== undefined &&
      run?.leaseExpiresAt !== null &&
      run.leaseExpiresAt > now
    );
  }

  private async loadRootRun(
    tx: Tx,
    companyId: string,
    projectId: string,
    rootRunId: string,
  ): Promise<MissionRunRow> {
    const schema = this.db.schema;
    const [row] = await tx
      .select()
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
          eq(schema.missionRuns.id, rootRunId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError(404, 'RUN_NOT_FOUND', 'Root run not found');
    }
    return row;
  }

  private async readDurationSeconds(tx: Tx, run: MissionRunRow): Promise<number> {
    const schema = this.db.schema;
    if (!run.policySnapshotId) {
      // Default to 60 minutes if no policy snapshot (should not happen).
      return 3600;
    }
    const [policy] = await tx
      .select({ limits: schema.runPolicySnapshots.limits })
      .from(schema.runPolicySnapshots)
      .where(eq(schema.runPolicySnapshots.id, run.policySnapshotId))
      .limit(1);
    if (!policy) {
      return 3600;
    }
    const limits = policy.limits as Record<string, number>;
    return limits.durationSeconds ?? 3600;
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
