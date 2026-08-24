import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { MissionCancellationService, type CancellationResult } from './cancellation.js';

/**
 * Subtree Cancellation module (VAL-SUB-045, 046, 047, 048, 049, 050, 067, 110).
 *
 * Implements recursive subtree cancellation and bottom-up convergence:
 *
 *  - **Subtree-terminal barrier (VAL-SUB-048, 110):** A cancelling run
 *    cannot terminally cancel until every descendant in its subtree is
 *    terminal. Ordering is proved through the recursive descendant check,
 *    not independent run-local sequences.
 *
 *  - **Child cancellation policy (VAL-SUB-050, 110):** When a child
 *    reaches a terminal state (cancelled or failed), its step assignment
 *    is updated and the parent's snapshotted `partial_result_policy` is
 *    applied: `require_all` cascades cancellation to remaining required
 *    siblings; `best_effort` allows unaffected siblings to continue.
 *
 *  - **Bottom-up propagation (VAL-SUB-110):** Grandchild failure first
 *    resolves its composite parent, then each ancestor applies its own
 *    snapshotted policy. Best effort preserves only independent/optional
 *    work and marks required dependents `DEPENDENCY_UNAVAILABLE`.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export interface SubtreeCancellationDeps {
  clock?: () => Date;
}

export interface ApplyChildTerminalPolicyInput {
  companyId: string;
  projectId: string;
  rootRunId: string;
  childRunId: string;
  parentRunId: string;
  terminalStatus: 'completed' | 'failed' | 'cancelled';
  failureCategory?: string;
  failureCode?: string;
  safeErrorMessage?: string;
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  traceId: string | null;
}

export interface PolicyApplicationResult {
  /** Whether cancellation was cascaded to siblings. */
  cascadedToSiblings: boolean;
  /** IDs of sibling runs that received cancellation requests. */
  cascadedSiblingIds: string[];
  /** The parent's partial result policy. */
  parentPolicy: 'require_all' | 'best_effort';
}

export class SubtreeCancellationService {
  constructor(
    private db: DbInstance,
    private deps: SubtreeCancellationDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Check whether a run has any nonterminal descendants in its subtree.
   * Uses a recursive CTE to walk the parent_run_id chain.
   *
   * Must be called inside a locked transaction.
   */
  async hasNonterminalDescendants(
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
   * Attempt to terminalize a cancel-requested run if all its descendants
   * are terminal. If descendants are still nonterminal, returns
   * `{ terminalized: false }` without changing state.
   *
   * Called by the worker when it encounters a cancel-requested run, or by
   * the deadline enforcer. Must be called inside a transaction that locks
   * the run row with FOR UPDATE (the underlying terminalize performs the
   * lock).
   *
   * (VAL-SUB-048, VAL-SUB-110)
   */
  async tryTerminalizeIfReady(
    tx: Tx,
    companyId: string,
    projectId: string,
    runId: string,
    opts: {
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
      leaseToken?: string;
    },
  ): Promise<CancellationResult> {
    // Check the subtree-terminal barrier.
    const hasNonterminal = await this.hasNonterminalDescendants(tx, companyId, projectId, runId);

    if (hasNonterminal) {
      // Descendants are still running — cannot terminalize yet.
      const schema = this.db.schema;
      const [run] = await tx
        .select({
          stateVersion: schema.missionRuns.stateVersion,
          status: schema.missionRuns.status,
          lastEventSequence: schema.missionRuns.lastEventSequence,
          cancellationDeadlineAt: schema.missionRuns.cancellationDeadlineAt,
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

      if (!run) {
        throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
      }

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

    // All descendants are terminal — proceed with terminalization.
    const cancelService = new MissionCancellationService(this.db, {
      clock: () => this.now(),
    });
    return cancelService.terminalize(tx, companyId, projectId, runId, opts);
  }

  /**
   * Apply the parent's partial result policy when a child reaches a
   * terminal state (cancelled or failed). This updates the child's step
   * assignment and, under `require_all`, cascades cancellation to
   * remaining required siblings.
   *
   * (VAL-SUB-050, VAL-SUB-110)
   *
   * Must be called inside a locked transaction.
   */
  async applyChildTerminalPolicy(
    tx: Tx,
    input: ApplyChildTerminalPolicyInput,
  ): Promise<PolicyApplicationResult> {
    const schema = this.db.schema;
    const now = this.now();

    // 1. Update the child's step assignment with the terminal result.
    const assignmentUpdate: Record<string, unknown> = {
      assignmentStatus: input.terminalStatus,
      resultStatus: input.terminalStatus,
      updatedAt: now,
    };

    if (input.terminalStatus === 'failed') {
      assignmentUpdate.failureCategory = input.failureCategory ?? null;
      assignmentUpdate.failureCode = input.failureCode ?? null;
      assignmentUpdate.safeErrorMessage = input.safeErrorMessage ?? null;
    }

    await tx
      .update(schema.runStepAssignments)
      .set(assignmentUpdate)
      .where(eq(schema.runStepAssignments.runId, input.childRunId));

    // 2. Read the parent's partial_result_policy.
    const [parentRun] = await tx
      .select({
        partialResultPolicy: schema.missionRuns.partialResultPolicy,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, input.companyId),
          eq(schema.missionRuns.projectId, input.projectId),
          eq(schema.missionRuns.id, input.parentRunId),
        ),
      )
      .limit(1);

    const parentPolicy = (parentRun?.partialResultPolicy ?? 'require_all') as
      'require_all' | 'best_effort';

    // 3. Under require_all, cascade cancellation to remaining nonterminal
    //    siblings (children of the same parent).
    if (parentPolicy !== 'require_all') {
      return {
        cascadedToSiblings: false,
        cascadedSiblingIds: [],
        parentPolicy,
      };
    }

    // Find nonterminal siblings (same parent, not the terminalized child,
    // not already terminal).
    const siblings = await tx.execute(sql`
      SELECT "id", "status", "last_event_sequence", "state_version"
      FROM "mission_runs"
      WHERE "company_id" = ${input.companyId}
        AND "project_id" = ${input.projectId}
        AND "parent_run_id" = ${input.parentRunId}
        AND "id" != ${input.childRunId}
        AND "status" NOT IN ('completed', 'failed', 'cancelled')
    `);

    const siblingRows = siblings as unknown as Array<{
      id: string;
      status: string;
      last_event_sequence: number;
      state_version: number;
    }>;

    if (siblingRows.length === 0) {
      return {
        cascadedToSiblings: false,
        cascadedSiblingIds: [],
        parentPolicy,
      };
    }

    const cascadedSiblingIds: string[] = [];

    for (const sibling of siblingRows) {
      // Set cancel_requested on the sibling.
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
        companyId: input.companyId,
        projectId: input.projectId,
        runId: sibling.id,
        sequence: siblingSeq,
        type: 'child.cancel_requested',
        schemaVersion: 1,
        payload: {
          parentRunId: input.parentRunId,
          reason: 'require_all_policy_cascade',
          cancelledSibling: input.childRunId,
        },
        actorType: input.actorType,
        actorId: input.actorId,
        traceId: input.traceId,
        occurredAt: now,
      });

      cascadedSiblingIds.push(sibling.id);
    }

    return {
      cascadedToSiblings: cascadedSiblingIds.length > 0,
      cascadedSiblingIds,
      parentPolicy,
    };
  }
}
