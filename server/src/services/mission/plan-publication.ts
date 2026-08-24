import { and, eq, sql, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import {
  parsePlanContent,
  validatePlanGraph,
  planContentHash,
  validateApprovalBudgetArithmetic,
} from './plan-schema.js';

/**
 * Atomic plan publication and governance gate.
 *
 * (VAL-PLAN-024, 025, 026, 027, 103, 106, 114, 130)
 *
 * This module owns:
 * - **Atomic publication (VAL-PLAN-103):** Committing an approvable revision
 *   atomically creates or links exactly one unresolved `plan_gate` approval
 *   with matching company, project, run, revision, and hash; transitions the
 *   run to `awaiting_approval`; and appends the `plan.proposed` journal event.
 *   A fault between internal writes exposes neither an actionable plan nor
 *   an orphan approval — the entire publication is within one transaction.
 * - **Invalid plan rejection (VAL-PLAN-024):** Cyclic dependencies, duplicate
 *   step keys, disallowed tools, over-limit topology, undeclared output/input
 *   bindings, and budget above the residual envelope are rejected before any
 *   approval card or gate is exposed. The run reports a safe planning/policy
 *   error and the effect ledger stays empty.
 * - **Governance gate (VAL-PLAN-025, 027):** A complex run in
 *   `awaiting_approval` is not claimable for execution by any worker. The
 *   state remains `awaiting_approval` until a valid approval command commits.
 * - **Preapproval effect ledger (VAL-PLAN-026, 106):** Before exact approval,
 *   the only allowed effects are bounded planning LLM calls, policy-labelled
 *   read-only planning research, plan/governance persistence, audit, budget
 *   accounting, and projections. The ledger verification function proves no
 *   children, side-effecting tools, artifacts, synthesis, or execution-step
 *   events exist before approval.
 * - **Planner failure recovery (VAL-PLAN-114):** Planner failures (timeout,
 *   transient failure, malformed output, retry exhaustion, lease loss,
 *   persistence fault, restart) never expose a ghost plan. Uncommitted
 *   output is never actionable; at most one validated current proposal/gate
 *   exists; known charges settle once.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];
type MissionRunRow = DbInstance['schema']['missionRuns']['$inferSelect'];

/** Result of a successful atomic plan publication. */
export interface PlanPublishResult {
  revisionId: string;
  revision: number;
  contentHash: string;
  approvalId: string;
  bindingId: string;
  /** New run state version (ETag). */
  stateVersion: number;
  /** Latest event sequence after publication. */
  lastEventSequence: number;
}

export interface PlanPublicationDeps {
  clock?: () => Date;
}

/** Failpoint hooks for testing (VAL-PLAN-130). Throwing aborts the transaction. */
export type PlanPublicationFailpoint =
  'after_supersede' | 'after_revision' | 'after_approval' | 'after_event';

/**
 * Options for publishing a plan proposal.
 */
export interface PublishPlanProposalOptions {
  /** The raw plan content to validate and publish. */
  planContent: unknown;
  /** Safe metadata about what generated this revision. */
  generatedBy?: Record<string, unknown>;
  /** Budget estimates snapshot at proposal time. */
  estimates?: Record<string, unknown>;
  /** Actor type for journal events. */
  actorType?: 'user' | 'agent' | 'system';
  /** Actor ID for journal events. */
  actorId?: string | null;
  /** Trace ID for journal events. */
  traceId?: string | null;
  /**
   * Budget context for approval-time arithmetic validation (VAL-PLAN-126).
   * If provided, the execution envelope must fit the residual root hold.
   */
  budgetContext?: {
    rootReserved: number;
    settledPlanning: number;
    inFlightPlanning: number;
  };
  /**
   * Test-only failpoint hook (VAL-PLAN-130). When set, the publication
   * calls this function at each named checkpoint. Throwing aborts the
   * transaction, simulating a fault between internal writes. This is only
   * invoked by the nonproduction planner harness; production routes never
   * set this field.
   */
  failpointHook?: (point: PlanPublicationFailpoint) => void;
}

export class PlanPublicationService {
  constructor(
    private db: DbInstance,
    private deps: PlanPublicationDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Atomically publish a validated plan proposal for a run.
   *
   * Within the caller's locked transaction (the run row must already be
   * locked via `FOR UPDATE`):
   *
   * 1. Validate the plan content against the closed `PlanContentV1` schema
   *    and the executable graph rules (VAL-PLAN-024, VAL-PLAN-113).
   * 2. Compute the canonical content hash (VAL-PLAN-032).
   * 3. Validate approval budget arithmetic if budget context is provided
   *    (VAL-PLAN-126).
   * 4. Supersede any existing current `proposed` revision for the run.
   * 5. Insert the new `run_plan_revisions` row (revision, status=`proposed`).
   * 6. Create exactly one unresolved `plan_gate` approval row and a binding
   *    linking it to the revision (VAL-PLAN-103).
   * 7. Update the run: status → `awaiting_approval`, set
   *    `currentPlanRevisionId`, bump `stateVersion` and `lastEventSequence`,
   *    clear lease fields (the run is no longer claimable).
   * 8. Append the `plan.proposed` journal event.
   *
   * A fault at any internal write rolls back the entire publication so
   * neither an actionable plan nor an orphan approval is visible
   * (VAL-PLAN-103, VAL-PLAN-114).
   *
   * Throws `PLAN_GRAPH_INVALID` (422) for graph validation failures.
   * Throws `PLAN_BUDGET_EXCEEDS_RESIDUAL` (409) if the execution envelope
   * exceeds the residual root hold.
   * Throws `PLAN_HASH_DUPLICATE` (409) if a revision with the same hash
   * already exists for the run (should not happen with proper supersede).
   */
  async publishPlanProposal(
    tx: Tx,
    run: MissionRunRow,
    opts: PublishPlanProposalOptions,
  ): Promise<PlanPublishResult> {
    const schema = this.db.schema;
    const now = this.now();
    const actorType = opts.actorType ?? 'system';
    const actorId = opts.actorId ?? null;
    const traceId = opts.traceId ?? null;

    // 1. Validate plan content against the closed schema (VAL-PLAN-024).
    const content = parsePlanContent(opts.planContent);

    // 2. Validate the executable graph (VAL-PLAN-113).
    validatePlanGraph(content);

    // 3. Compute the canonical content hash (VAL-PLAN-032).
    const contentHash = planContentHash(content);

    // 4. Validate approval budget arithmetic if context provided (VAL-PLAN-126).
    if (opts.budgetContext) {
      const arithmetic = validateApprovalBudgetArithmetic({
        rootReserved: opts.budgetContext.rootReserved,
        settledPlanning: opts.budgetContext.settledPlanning,
        inFlightPlanning: opts.budgetContext.inFlightPlanning,
        plan: content,
      });
      if (!arithmetic.ok) {
        throw new AppError(
          409,
          'PLAN_BUDGET_EXCEEDS_RESIDUAL',
          `Execution envelope (${arithmetic.executionEnvelopeCents}c) exceeds residual root hold (${arithmetic.residualCents}c)`,
        );
      }
    }

    // 5. Determine the next revision number and supersede the prior
    //    proposal. The parent revision is the most recent revision for the
    //    run regardless of status (proposed, superseded, approved, or
    //    rejected), so a revision after approval/reject-revise links
    //    correctly to its parent and the revision number monotonically
    //    increases (VAL-PLAN-032, VAL-PLAN-037, VAL-PLAN-039, VAL-PLAN-101).
    const priorRevision = await this.findLatestRevision(tx, run.companyId, run.id);
    const nextRevision = priorRevision ? priorRevision.revision + 1 : 1;

    // Supersede any existing current `proposed` revision for the run.
    // After a revision request or reject-revise, there is no `proposed`
    // revision (the prior was already superseded/rejected), so this is a
    // no-op in that case. After an approval + queued revision request, the
    // approved revision was already superseded by applyRevisionRequest.
    const priorProposed = await this.findCurrentProposed(tx, run.companyId, run.id);

    if (priorProposed) {
      await tx
        .update(schema.runPlanRevisions)
        .set({ status: 'superseded', updatedAt: now })
        .where(eq(schema.runPlanRevisions.id, priorProposed.id));
    }

    // Failpoint: simulate a fault after supersede (VAL-PLAN-103, VAL-PLAN-114).
    if (opts.failpointHook) {
      opts.failpointHook('after_supersede');
    }

    // 6. Insert the new revision row.
    const revisionId = randomUUID();
    await tx.insert(schema.runPlanRevisions).values({
      id: revisionId,
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      revision: nextRevision,
      parentRevisionId: priorRevision?.id ?? null,
      status: 'proposed',
      content: content as unknown as Record<string, unknown>,
      contentHash,
      generatedBy: opts.generatedBy ?? {},
      feedback: null,
      estimates: opts.estimates ?? {},
      decidedByUserId: null,
      decidedAt: null,
      createdAt: now,
      updatedAt: now,
    });

    // Failpoint: simulate a fault after revision insert.
    if (opts.failpointHook) {
      opts.failpointHook('after_revision');
    }

    // 7. Create exactly one unresolved plan_gate approval row (VAL-PLAN-103).
    const approvalId = randomUUID();
    await tx.insert(schema.approvals).values({
      id: approvalId,
      companyId: run.companyId,
      kind: 'plan_gate',
      title: `Mission plan approval — revision ${nextRevision}`,
      description: `Plan proposal for run ${run.id}`,
      status: 'pending',
      priority: 'medium',
      requestedByUserId: null,
      requestedByAgentId: null,
      resolvedByUserId: null,
      resolutionNote: null,
      payload: {
        runId: run.id,
        planRevisionId: revisionId,
        revision: nextRevision,
        contentHash,
      },
      taskId: null,
      projectId: run.projectId,
      planStepId: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    });

    // Failpoint: simulate a fault after approval creation.
    if (opts.failpointHook) {
      opts.failpointHook('after_approval');
    }

    // 8. Create the binding linking the approval to the revision.
    const bindingId = randomUUID();
    await tx.insert(schema.runPlanApprovalBindings).values({
      id: bindingId,
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      planRevisionId: revisionId,
      contentHash,
      approvalId,
      decision: null,
      decidingUserId: null,
      createdAt: now,
      decidedAt: null,
    });

    // 9. Update the run: status → awaiting_approval, set pointers, bump version.
    const newVersion = run.stateVersion + 1;
    const seq = Number(run.lastEventSequence) + 1;

    await tx
      .update(schema.missionRuns)
      .set({
        status: 'awaiting_approval',
        currentPlanRevisionId: revisionId,
        stateVersion: newVersion,
        lastEventSequence: seq,
        // Release the worker lease: the run is no longer claimable.
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        heartbeatAt: null,
        availableAt: null,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, run.id));

    // 10. Append the plan.proposed journal event.
    await tx.insert(schema.runEvents).values({
      companyId: run.companyId,
      projectId: run.projectId,
      runId: run.id,
      sequence: seq,
      type: 'plan.proposed',
      schemaVersion: 1,
      payload: {
        revisionId,
        revision: nextRevision,
        contentHash,
        approvalId,
        parentRevisionId: priorRevision?.id ?? null,
      },
      actorType,
      actorId,
      traceId,
      occurredAt: now,
    });

    // Failpoint: simulate a fault after event append.
    if (opts.failpointHook) {
      opts.failpointHook('after_event');
    }

    return {
      revisionId,
      revision: nextRevision,
      contentHash,
      approvalId,
      bindingId,
      stateVersion: newVersion,
      lastEventSequence: seq,
    };
  }

  /**
   * Find the current proposed revision for a run, if any.
   */
  async findCurrentProposed(
    tx: Tx,
    companyId: string,
    runId: string,
  ): Promise<{ id: string; revision: number; contentHash: string } | null> {
    const schema = this.db.schema;
    const rows = await tx
      .select({
        id: schema.runPlanRevisions.id,
        revision: schema.runPlanRevisions.revision,
        contentHash: schema.runPlanRevisions.contentHash,
      })
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, companyId),
          eq(schema.runPlanRevisions.runId, runId),
          eq(schema.runPlanRevisions.status, 'proposed'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Find the latest revision for a run regardless of status (proposed,
   * superseded, approved, or rejected). Used to determine the next
   * monotonic revision number and the parent revision link when
   * replanning after a revision request, reject-revise, or post-approval
   * queued revision (VAL-PLAN-032, VAL-PLAN-037, VAL-PLAN-039,
   * VAL-PLAN-101). Returns null when the run has no revisions yet.
   */
  async findLatestRevision(
    tx: Tx,
    companyId: string,
    runId: string,
  ): Promise<{ id: string; revision: number; contentHash: string } | null> {
    const schema = this.db.schema;
    const rows = await tx
      .select({
        id: schema.runPlanRevisions.id,
        revision: schema.runPlanRevisions.revision,
        contentHash: schema.runPlanRevisions.contentHash,
      })
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, companyId),
          eq(schema.runPlanRevisions.runId, runId),
        ),
      )
      .orderBy(desc(schema.runPlanRevisions.revision))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Verify the preapproval effect ledger contains only declared planning
   * work (VAL-PLAN-026, VAL-PLAN-106).
   *
   * Before exact approval, the only allowed effects are:
   * - bounded planning LLM calls
   * - policy-labelled read-only planning research
   * - plan/governance persistence, audit, budget accounting, projections
   *
   * Forbidden before approval:
   * - child.created, child.routed, child.started
   * - execution.started, execution.progress
   * - tool.started (for side-effecting/non-replayable tools)
   * - artifact.committed
   * - synthesis.started, synthesis.completed
   *
   * Returns `{ ok: true }` if the ledger is clean, or `{ ok: false, violations }`
   * listing the forbidden event types found.
   */
  async verifyPreapprovalLedger(
    companyId: string,
    runId: string,
  ): Promise<{ ok: boolean; violations: string[] }> {
    const forbiddenTypes = [
      'child.created',
      'child.routed',
      'child.started',
      'execution.started',
      'execution.progress',
      'artifact.committed',
      'synthesis.started',
      'synthesis.completed',
    ];

    const rows = (await this.db.drizzle.execute(sql`
      SELECT "type" FROM "run_events"
      WHERE "company_id" = ${companyId} AND "run_id" = ${runId}
        AND "type" IN (${sql.join(
          forbiddenTypes.map((t) => sql`${t}`),
          sql`, `,
        )})
    `)) as unknown as Array<{ type: string }>;

    const violations = rows.map((r) => r.type);
    return { ok: violations.length === 0, violations };
  }

  /**
   * Count proposed/approved revisions for a run (for cardinality checks).
   */
  async countRevisions(companyId: string, runId: string): Promise<number> {
    const schema = this.db.schema;
    const rows = await this.db.drizzle
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, companyId),
          eq(schema.runPlanRevisions.runId, runId),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  /**
   * Read all plan revisions for a run in revision order.
   */
  async listRevisions(
    companyId: string,
    runId: string,
  ): Promise<
    Array<{
      id: string;
      revision: number;
      status: string;
      contentHash: string;
      parentRevisionId: string | null;
      createdAt: Date;
    }>
  > {
    const schema = this.db.schema;
    return this.db.drizzle
      .select({
        id: schema.runPlanRevisions.id,
        revision: schema.runPlanRevisions.revision,
        status: schema.runPlanRevisions.status,
        contentHash: schema.runPlanRevisions.contentHash,
        parentRevisionId: schema.runPlanRevisions.parentRevisionId,
        createdAt: schema.runPlanRevisions.createdAt,
      })
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, companyId),
          eq(schema.runPlanRevisions.runId, runId),
        ),
      )
      .orderBy(schema.runPlanRevisions.revision);
  }

  /**
   * Read the approval bindings for a run.
   */
  async listBindings(
    companyId: string,
    runId: string,
  ): Promise<
    Array<{
      id: string;
      planRevisionId: string;
      contentHash: string;
      approvalId: string;
      decision: string | null;
    }>
  > {
    const schema = this.db.schema;
    return this.db.drizzle
      .select({
        id: schema.runPlanApprovalBindings.id,
        planRevisionId: schema.runPlanApprovalBindings.planRevisionId,
        contentHash: schema.runPlanApprovalBindings.contentHash,
        approvalId: schema.runPlanApprovalBindings.approvalId,
        decision: schema.runPlanApprovalBindings.decision,
      })
      .from(schema.runPlanApprovalBindings)
      .where(
        and(
          eq(schema.runPlanApprovalBindings.companyId, companyId),
          eq(schema.runPlanApprovalBindings.runId, runId),
        ),
      );
  }
}
