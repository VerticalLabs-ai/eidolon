import { and, asc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../../types.js';
import {
  appendProjectionJournalEvent,
  type ProjectableEvent,
  type ProjectionDeps,
} from './projection.js';
import { parsePlanContent, type PlanContent } from './plan-schema.js';

/**
 * Plan Governance Projection module
 * (VAL-PLAN-060, 061, 062, 063, 064, 066, 098, 099, 119, 127).
 *
 * Idempotently projects plan governance events (plan.proposed, plan.approved,
 * plan.rejected, plan.revision_requested) to mutable governance surfaces:
 *
 * - **project_plan**: One `project_plans` row per approved plan revision,
 *   linked via `run_projection_links` with a deterministic
 *   `surface_key = project_plan:{revisionId}`. The plan title and description
 *   derive from the approved revision content; the status tracks the run's
 *   governance state (active after approval, cancelled after rejection/cancel).
 * - **project_plan_step**: Ordered `project_plan_steps` per approved plan
 *   revision, one per plan step, with deterministic
 *   `surface_key = project_plan_step:{revisionId}:{stepKey}`. Step order,
 *   title, and description derive from the immutable approved revision.
 * - **plan_approval**: The authoritative `approvals` row is created/resolved
 *   in the locked transaction (plan-publication.ts / plan-decision.ts). This
 *   projection tracks the approval link in `run_projection_links` for dedup
 *   and repair visibility, with `surface_key = plan_approval:{revisionId}`.
 *
 * ### Invariants
 *
 * - **Idempotent mapping**: Each approval/plan/inbox record maps once to
 *   run/revision/hash. A duplicate projection is a no-op (the deterministic
 *   `surface_key` and unique index prevent duplicate rows). Repair converges
 *   to one logical item per surface (VAL-PLAN-066).
 * - **Projection failure cannot authorize execution**: A failed or absent
 *   projection does not queue the run or create a binding. The run
 *   transitions to `queued` only via the authoritative `applyApprove` in
 *   plan-decision.ts, which writes the binding and transitions the run in
 *   the locked transaction. Projections happen AFTER the transaction commits
 *   and are non-authoritative (VAL-PLAN-098).
 * - **Mutable projections cannot change execution**: Mission execution reads
 *   the immutable approved revision from `run_plan_revisions`, not the
 *   mutable `project_plans` projection. Editing a projected `project_plans`
 *   row does not alter the Mission's approved revision or hash
 *   (VAL-PLAN-099).
 * - **Revision replaces stale projections**: A revision request supersedes
 *   the old approval (cancelled in the authoritative transaction) and marks
 *   the old project_plans projection as superseded. The new proposal appears
 *   once with its new revision/hash (VAL-PLAN-064).
 * - **Convergence or lag declaration**: The governance projection status
 *   read ({@link readGovernanceStatus}) exposes whether each surface has
 *   converged (active link) or is lagging (failed/missing link). A stale
 *   surface is non-actionable — the authoritative run/revision/hash remains
 *   the source of truth (VAL-PLAN-119).
 * - **Recipient revocation**: The inbox derives actionable items from live
 *   pending `approvals` rows. Permission is checked at command time
 *   (`mission.approve`), not at projection time. A committed historical
 *   approval remains valid after actor downgrade; role/membership changes
 *   idempotently update who sees actionable controls because the inbox route
 *   reads live data (VAL-PLAN-127).
 */

/** Plan governance projection surfaces. */
export type PlanGovernanceSurface = 'project_plan' | 'project_plan_step' | 'plan_approval';

/** Whether a run event type is a plan governance event that should be projected. */
export function isPlanGovernanceProjectable(eventType: string): boolean {
  return (
    eventType === 'plan.proposed' ||
    eventType === 'plan.approved' ||
    eventType === 'plan.rejected' ||
    eventType === 'plan.revision_requested'
  );
}

export interface PlanGovernanceProjectionDeps extends ProjectionDeps {
  /**
   * Test-only failpoint: when set, the projection calls this function at
   * each named checkpoint. Throwing simulates a projection failure (the
   * failure is caught and recorded as a retryable error, not re-thrown).
   */
  failpointHook?: (point: PlanGovernanceFailpoint) => void;
}

export type PlanGovernanceFailpoint =
  | 'before_project_plan'
  | 'after_project_plan'
  | 'before_plan_steps'
  | 'after_plan_steps'
  | 'before_approval_link'
  | 'after_approval_link';

export interface PlanGovernanceRepairInput {
  companyId: string;
  projectId: string;
  runId: string;
  surface: PlanGovernanceSurface;
  traceId?: string | null;
}

export interface PlanGovernanceRepairResult {
  repaired: boolean;
  surfaceId: string | null;
}

/** Status of a single governance projection surface. */
export interface GovernanceSurfaceStatus {
  surface: PlanGovernanceSurface | 'thread_item' | 'activity_log';
  /** 'active' (converged), 'failed' (lagging, retryable), 'repaired', 'missing' (no link yet). */
  status: 'active' | 'failed' | 'repaired' | 'missing';
  /** Number of projection links for this surface. */
  linkCount: number;
  /** Latest event sequence projected for this surface, or null if none. */
  latestProjectedSequence: number | null;
  /** Safe error message if status='failed'. */
  errorMessage: string | null;
}

/** Governance projection convergence status for a run. */
export interface GovernanceProjectionStatus {
  runId: string;
  runStatus: string;
  /** Latest committed event sequence. */
  latestEventSequence: number;
  /** Latest plan revision ID, or null if no plan. */
  currentPlanRevisionId: string | null;
  /** Latest plan content hash, or null if no plan. */
  currentPlanContentHash: string | null;
  /** Per-surface convergence status. */
  surfaces: GovernanceSurfaceStatus[];
  /** Whether all governance surfaces have converged (no missing/failed links). */
  converged: boolean;
  /** Whether any surface is lagging (failed or missing). */
  lagging: boolean;
}

/**
 * Idempotently project a plan governance event to mutable governance
 * surfaces. Called after the authoritative transaction commits.
 *
 * Projection failures are caught and recorded as retryable errors — they
 * never roll back the authoritative state and never authorize execution.
 */
export async function projectPlanGovernanceEvent(
  db: DbInstance,
  event: ProjectableEvent,
  deps: PlanGovernanceProjectionDeps = {},
): Promise<void> {
  const now = deps.clock ? deps.clock() : new Date();
  const service = new MissionPlanGovernanceProjectionService(db, deps);

  if (event.type === 'plan.proposed') {
    try {
      await service.projectProposedPlan(event, now);
    } catch (err) {
      await service.recordFailure(event, 'plan_approval', err, now);
    }
  } else if (event.type === 'plan.approved') {
    try {
      await service.projectApprovedPlan(event, now);
    } catch (err) {
      await service.recordFailure(event, 'project_plan', err, now);
    }
  } else if (event.type === 'plan.rejected') {
    try {
      await service.projectRejectedPlan(event, now);
    } catch (err) {
      await service.recordFailure(event, 'plan_approval', err, now);
    }
  } else if (event.type === 'plan.revision_requested') {
    try {
      await service.projectRevisionRequested(event, now);
    } catch (err) {
      await service.recordFailure(event, 'plan_approval', err, now);
    }
  }
}

export class MissionPlanGovernanceProjectionService {
  constructor(
    private db: DbInstance,
    private deps: PlanGovernanceProjectionDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Project a plan.proposed event: track the approval link idempotently.
   * The authoritative approval row was already created in the locked
   * transaction (plan-publication.ts). This projection records the link
   * in run_projection_links so repair can reconcile and the convergence
   * status read can verify the surface has converged (VAL-PLAN-060).
   */
  async projectProposedPlan(event: ProjectableEvent, now: Date): Promise<void> {
    const schema = this.db.schema;
    const payload = event.payload;
    const revisionId = payload.revisionId as string;
    const approvalId = payload.approvalId as string;
    const surfaceKey = `plan_approval:${revisionId}`;

    // Check for an existing link — idempotent dedup.
    const [existing] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'plan_approval'),
          eq(schema.runProjectionLinks.surfaceKey, surfaceKey),
        ),
      )
      .limit(1);

    if (existing && existing.status === 'active') {
      return; // Already projected — no-op.
    }

    if (this.deps.failpointHook) {
      this.deps.failpointHook('before_approval_link');
    }

    if (existing) {
      // Update the failed link to active.
      await this.db.drizzle
        .update(schema.runProjectionLinks)
        .set({
          surfaceId: approvalId,
          status: 'active',
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.runProjectionLinks.id, existing.id));
    } else {
      await this.db.drizzle.insert(schema.runProjectionLinks).values({
        companyId: event.companyId,
        projectId: event.projectId,
        runId: event.runId,
        surface: 'plan_approval',
        surfaceId: approvalId,
        surfaceKey,
        eventType: event.type,
        eventSequence: event.sequence,
        status: 'active',
        traceId: event.traceId,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (this.deps.failpointHook) {
      this.deps.failpointHook('after_approval_link');
    }
  }

  /**
   * Project a plan.approved event: create one project_plans row and
   * ordered project_plan_steps from the immutable approved revision,
   * idempotently. Also track the approval link as resolved (VAL-PLAN-061).
   */
  async projectApprovedPlan(event: ProjectableEvent, now: Date): Promise<void> {
    const schema = this.db.schema;
    const payload = event.payload;
    const revisionId = payload.revisionId as string;
    const approvalId = payload.approvalId as string;
    const contentHash = payload.contentHash as string;

    // 1. Track the approval link as resolved (idempotent).
    await this.upsertApprovalLink(event, revisionId, approvalId, now);

    if (this.deps.failpointHook) {
      this.deps.failpointHook('before_project_plan');
    }

    // 2. Load the approved revision content to derive plan/steps.
    const [revision] = await this.db.drizzle
      .select()
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, event.companyId),
          eq(schema.runPlanRevisions.id, revisionId),
        ),
      )
      .limit(1);

    if (!revision) {
      throw new Error(`Approved revision ${revisionId} not found for projection`);
    }

    const planContent = parsePlanContent(revision.content);

    // 3. Create or update the project_plans row (idempotent via link).
    const planSurfaceKey = `project_plan:${revisionId}`;
    const [existingPlan] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'project_plan'),
          eq(schema.runProjectionLinks.surfaceKey, planSurfaceKey),
        ),
      )
      .limit(1);

    let planId: string;
    if (existingPlan && existingPlan.status === 'active') {
      // Already projected — no-op (idempotent).
      return;
    }

    if (existingPlan) {
      // Repair a failed link: re-use the existing plan ID if the surface
      // row still exists, otherwise create a new one.
      planId = existingPlan.surfaceId;
      // Verify the plan row still exists.
      const [planRow] = await this.db.drizzle
        .select({ id: schema.projectPlans.id })
        .from(schema.projectPlans)
        .where(eq(schema.projectPlans.id, planId))
        .limit(1);
      if (!planRow) {
        planId = randomUUID();
        await this.createProjectPlan(event, planId, planContent, revisionId, contentHash, now);
      }
      // Mark the link as active.
      await this.db.drizzle
        .update(schema.runProjectionLinks)
        .set({ surfaceId: planId, status: 'active', errorMessage: null, updatedAt: now })
        .where(eq(schema.runProjectionLinks.id, existingPlan.id));
    } else {
      planId = randomUUID();
      await this.createProjectPlan(event, planId, planContent, revisionId, contentHash, now);
      await this.db.drizzle.insert(schema.runProjectionLinks).values({
        companyId: event.companyId,
        projectId: event.projectId,
        runId: event.runId,
        surface: 'project_plan',
        surfaceId: planId,
        surfaceKey: planSurfaceKey,
        eventType: event.type,
        eventSequence: event.sequence,
        status: 'active',
        traceId: event.traceId,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (this.deps.failpointHook) {
      this.deps.failpointHook('after_project_plan');
    }

    // 4. Create ordered project_plan_steps (idempotent via links).
    if (this.deps.failpointHook) {
      this.deps.failpointHook('before_plan_steps');
    }

    for (let i = 0; i < planContent.steps.length; i++) {
      const step = planContent.steps[i];
      const stepSurfaceKey = `project_plan_step:${revisionId}:${step.stepKey}`;
      const [existingStep] = await this.db.drizzle
        .select()
        .from(schema.runProjectionLinks)
        .where(
          and(
            eq(schema.runProjectionLinks.companyId, event.companyId),
            eq(schema.runProjectionLinks.runId, event.runId),
            eq(schema.runProjectionLinks.surface, 'project_plan_step'),
            eq(schema.runProjectionLinks.surfaceKey, stepSurfaceKey),
          ),
        )
        .limit(1);

      if (existingStep && existingStep.status === 'active') {
        continue; // Idempotent — already projected.
      }

      const stepId = randomUUID();
      await this.db.drizzle.insert(schema.projectPlanSteps).values({
        id: stepId,
        planId,
        companyId: event.companyId,
        title: step.title,
        description: step.description ?? null,
        stepOrder: i,
        stepType: 'action',
        status: 'pending',
        gateConfig: {
          runId: event.runId,
          planRevisionId: revisionId,
          stepKey: step.stepKey,
          contentHash,
        },
        createdAt: now,
        updatedAt: now,
      });

      if (existingStep) {
        await this.db.drizzle
          .update(schema.runProjectionLinks)
          .set({ surfaceId: stepId, status: 'active', errorMessage: null, updatedAt: now })
          .where(eq(schema.runProjectionLinks.id, existingStep.id));
      } else {
        await this.db.drizzle.insert(schema.runProjectionLinks).values({
          companyId: event.companyId,
          projectId: event.projectId,
          runId: event.runId,
          surface: 'project_plan_step',
          surfaceId: stepId,
          surfaceKey: stepSurfaceKey,
          eventType: event.type,
          eventSequence: event.sequence,
          status: 'active',
          traceId: event.traceId,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    if (this.deps.failpointHook) {
      this.deps.failpointHook('after_plan_steps');
    }
  }

  /**
   * Project a plan.rejected event: mark any existing project_plans
   * projection as cancelled (if one was created — only for post-approval
   * rejection, which is not a normal flow but defensive). The authoritative
   * approval row was already resolved as rejected in the locked transaction.
   * Track the approval link as resolved (VAL-PLAN-063).
   */
  async projectRejectedPlan(event: ProjectableEvent, now: Date): Promise<void> {
    const schema = this.db.schema;
    const payload = event.payload;
    const revisionId = payload.revisionId as string;
    const approvalId = payload.approvalId as string;

    // Track the approval link as resolved (idempotent).
    await this.upsertApprovalLink(event, revisionId, approvalId, now);

    // If there's an existing project_plans projection for this revision
    // (post-approval rejection edge case), mark it as cancelled.
    const planSurfaceKey = `project_plan:${revisionId}`;
    const [existingPlan] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'project_plan'),
          eq(schema.runProjectionLinks.surfaceKey, planSurfaceKey),
        ),
      )
      .limit(1);

    if (existingPlan && existingPlan.status === 'active') {
      await this.db.drizzle
        .update(schema.projectPlans)
        .set({ status: 'cancelled', updatedAt: now })
        .where(eq(schema.projectPlans.id, existingPlan.surfaceId));
    }
  }

  /**
   * Project a plan.revision_requested event: supersede any existing
   * project_plans projection and mark the old approval link as superseded.
   * The authoritative approval row was already cancelled and the revision
   * superseded in the locked transaction (VAL-PLAN-064).
   */
  async projectRevisionRequested(event: ProjectableEvent, now: Date): Promise<void> {
    const schema = this.db.schema;
    const payload = event.payload;
    const revisionId = payload.revisionId as string;

    // The approval was already cancelled in the authoritative transaction.
    // The approval link remains active (it records the historical
    // approval) — no mutation needed here.

    // If there's an existing project_plans projection for this revision
    // (post-approval revision), mark it as superseded/cancelled.
    const planSurfaceKey = `project_plan:${revisionId}`;
    const [existingPlan] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'project_plan'),
          eq(schema.runProjectionLinks.surfaceKey, planSurfaceKey),
        ),
      )
      .limit(1);

    if (existingPlan && existingPlan.status === 'active') {
      await this.db.drizzle
        .update(schema.projectPlans)
        .set({ status: 'cancelled', updatedAt: now })
        .where(eq(schema.projectPlans.id, existingPlan.surfaceId));
    }
  }

  /**
   * Record a projection failure: create a failed link and emit a
   * projection.failed journal event. This does NOT roll back the
   * authoritative state and does NOT authorize execution (VAL-PLAN-098).
   */
  async recordFailure(
    event: ProjectableEvent,
    surface: PlanGovernanceSurface,
    err: unknown,
    now: Date,
  ): Promise<void> {
    const schema = this.db.schema;
    const payload = event.payload;
    const revisionId = (payload.revisionId as string) ?? 'unknown';
    const surfaceKey = `${surface}:${revisionId}`;
    const errorMessage = err instanceof Error ? err.message : 'Plan governance projection failed';

    const [existing] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, surface),
          eq(schema.runProjectionLinks.surfaceKey, surfaceKey),
        ),
      )
      .limit(1);

    if (existing) {
      await this.db.drizzle
        .update(schema.runProjectionLinks)
        .set({ status: 'failed', errorMessage, updatedAt: now })
        .where(eq(schema.runProjectionLinks.id, existing.id));
    } else {
      await this.db.drizzle.insert(schema.runProjectionLinks).values({
        companyId: event.companyId,
        projectId: event.projectId,
        runId: event.runId,
        surface,
        surfaceId: 'pending',
        surfaceKey,
        eventType: event.type,
        eventSequence: event.sequence,
        status: 'failed',
        errorMessage,
        traceId: event.traceId,
        createdAt: now,
        updatedAt: now,
      });
    }

    // Emit projection.failed journal event under a locked transaction
    // (SELECT FOR UPDATE on mission_runs) so concurrent projection
    // failures cannot produce duplicate or missing sequence numbers
    // (RunEvent Journal invariant). The failed link above remains the
    // retryable record of the failure; this event is the observable
    // journal marker and is non-authoritative — it does not change
    // state_version and does not authorize execution (VAL-PLAN-098).
    await appendProjectionJournalEvent(this.db, {
      runId: event.runId,
      companyId: event.companyId,
      projectId: event.projectId,
      type: 'projection.failed',
      payload: {
        surface,
        eventSequence: event.sequence,
        revisionId,
        error: errorMessage,
      },
      traceId: event.traceId,
      occurredAt: now,
    });
  }

  /**
   * Repair a failed plan governance projection. Idempotent: if the
   * projection is already active, this is a no-op (VAL-PLAN-066).
   */
  async repair(input: PlanGovernanceRepairInput): Promise<PlanGovernanceRepairResult> {
    const schema = this.db.schema;
    const now = this.now();
    const { companyId, projectId, runId, surface, traceId } = input;

    // Find the failed link(s) for this surface.
    const failedLinks = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, companyId),
          eq(schema.runProjectionLinks.runId, runId),
          eq(schema.runProjectionLinks.surface, surface),
          eq(schema.runProjectionLinks.status, 'failed'),
        ),
      );

    if (failedLinks.length === 0) {
      return { repaired: false, surfaceId: null };
    }

    let lastSurfaceId: string | null = null;
    for (const link of failedLinks) {
      // Re-read the triggering event.
      const eventSeq = link.eventSequence;
      if (eventSeq === null) {
        continue;
      }

      const [evt] = await this.db.drizzle
        .select()
        .from(schema.runEvents)
        .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.sequence, eventSeq)))
        .limit(1);

      if (!evt) {
        continue;
      }

      const event: ProjectableEvent = {
        runId,
        companyId,
        projectId,
        sequence: Number(evt.sequence),
        type: evt.type,
        payload: evt.payload as Record<string, unknown>,
        actorType: evt.actorType as 'user' | 'agent' | 'system' | null,
        actorId: evt.actorId,
        traceId: traceId ?? evt.traceId,
        occurredAt: evt.occurredAt,
      };

      // Re-project based on event type.
      try {
        if (evt.type === 'plan.proposed') {
          await this.projectProposedPlan(event, now);
        } else if (evt.type === 'plan.approved') {
          await this.projectApprovedPlan(event, now);
        } else if (evt.type === 'plan.rejected') {
          await this.projectRejectedPlan(event, now);
        } else if (evt.type === 'plan.revision_requested') {
          await this.projectRevisionRequested(event, now);
        }
        lastSurfaceId = link.surfaceId !== 'pending' ? link.surfaceId : lastSurfaceId;
      } catch {
        // Repair failed — the link remains failed. It will be retried.
        continue;
      }
    }

    // Emit projection.repaired activity log entry.
    const repairActivityId = randomUUID();
    await this.db.drizzle.insert(schema.activityLog).values({
      id: repairActivityId,
      companyId,
      actorType: 'system',
      actorId: null,
      action: 'mission.projection.repaired',
      entityType: 'mission_run',
      entityId: runId,
      description: `Mission plan governance projection repaired: ${surface}`,
      metadata: { runId, surface, traceId: traceId ?? null },
      projectId,
    });

    return { repaired: true, surfaceId: lastSurfaceId };
  }

  /**
   * Read the governance projection convergence status for a run
   * (VAL-PLAN-119). Exposes whether each governance surface has converged
   * (active link) or is lagging (failed/missing). This is a read-only
   * surface — it never authorizes execution.
   */
  async readGovernanceStatus(
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<GovernanceProjectionStatus> {
    const schema = this.db.schema;

    // 1. Read the run.
    const [run] = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        status: schema.missionRuns.status,
        lastEventSequence: schema.missionRuns.lastEventSequence,
        currentPlanRevisionId: schema.missionRuns.currentPlanRevisionId,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.id, runId),
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.projectId, projectId),
        ),
      )
      .limit(1);

    if (!run) {
      return {
        runId,
        runStatus: 'not_found',
        latestEventSequence: 0,
        currentPlanRevisionId: null,
        currentPlanContentHash: null,
        surfaces: [],
        converged: false,
        lagging: true,
      };
    }

    // 2. Read the current revision hash.
    let currentHash: string | null = null;
    if (run.currentPlanRevisionId) {
      const [rev] = await this.db.drizzle
        .select({ contentHash: schema.runPlanRevisions.contentHash })
        .from(schema.runPlanRevisions)
        .where(eq(schema.runPlanRevisions.id, run.currentPlanRevisionId))
        .limit(1);
      currentHash = rev?.contentHash ?? null;
    }

    // 3. Read all projection links for the run, grouped by surface.
    const allLinks = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, companyId),
          eq(schema.runProjectionLinks.runId, runId),
        ),
      )
      .orderBy(asc(schema.runProjectionLinks.eventSequence));

    const surfaceTypes: Array<PlanGovernanceSurface | 'thread_item' | 'activity_log'> = [
      'plan_approval',
      'project_plan',
      'project_plan_step',
      'thread_item',
      'activity_log',
    ];

    const surfaces: GovernanceSurfaceStatus[] = surfaceTypes.map((surface) => {
      const links = allLinks.filter((l) => l.surface === surface);
      if (links.length === 0) {
        // No links for this surface — may be missing if plan events exist.
        return {
          surface,
          status: 'missing' as const,
          linkCount: 0,
          latestProjectedSequence: null,
          errorMessage: null,
        };
      }
      const hasFailed = links.some((l) => l.status === 'failed');
      const allActive = links.every((l) => l.status === 'active' || l.status === 'repaired');
      const latestSeq = Math.max(
        ...links.map((l) => (l.eventSequence ? Number(l.eventSequence) : 0)),
      );
      const failedLink = links.find((l) => l.status === 'failed');
      return {
        surface,
        status: hasFailed
          ? ('failed' as const)
          : allActive
            ? ('active' as const)
            : ('repaired' as const),
        linkCount: links.length,
        latestProjectedSequence: latestSeq,
        errorMessage: failedLink?.errorMessage ?? null,
      };
    });

    // 4. Determine convergence: all surfaces that should have links are
    //    active/repaired, and no surface is failed.
    const hasPlanEvents = currentHash !== null || run.currentPlanRevisionId !== null;
    const governanceSurfaces = surfaces.filter(
      (s) =>
        s.surface === 'plan_approval' ||
        s.surface === 'project_plan' ||
        s.surface === 'project_plan_step',
    );
    const laggingSurfaces = governanceSurfaces.filter(
      (s) => s.status === 'failed' || (hasPlanEvents && s.status === 'missing'),
    );
    const converged = laggingSurfaces.length === 0;
    const lagging = laggingSurfaces.length > 0;

    return {
      runId,
      runStatus: run.status,
      latestEventSequence: Number(run.lastEventSequence),
      currentPlanRevisionId: run.currentPlanRevisionId,
      currentPlanContentHash: currentHash,
      surfaces,
      converged,
      lagging,
    };
  }

  // -- internal helpers -----------------------------------------------------

  private async createProjectPlan(
    event: ProjectableEvent,
    planId: string,
    planContent: PlanContent,
    revisionId: string,
    contentHash: string,
    now: Date,
  ): Promise<void> {
    const schema = this.db.schema;
    await this.db.drizzle.insert(schema.projectPlans).values({
      id: planId,
      companyId: event.companyId,
      projectId: event.projectId,
      title: planContent.objective.slice(0, 200) || 'Mission plan',
      description: `Mission plan (revision ${revisionId.slice(0, 8)}, hash ${contentHash.slice(0, 12)})`,
      status: 'active',
      progress: 0,
      createdByUserId: event.actorType === 'user' ? event.actorId : null,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async upsertApprovalLink(
    event: ProjectableEvent,
    revisionId: string,
    approvalId: string,
    now: Date,
  ): Promise<void> {
    const schema = this.db.schema;
    const surfaceKey = `plan_approval:${revisionId}`;

    const [existing] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'plan_approval'),
          eq(schema.runProjectionLinks.surfaceKey, surfaceKey),
        ),
      )
      .limit(1);

    if (existing && existing.status === 'active') {
      return; // Already projected — no-op.
    }

    if (existing) {
      await this.db.drizzle
        .update(schema.runProjectionLinks)
        .set({
          surfaceId: approvalId,
          status: 'active',
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.runProjectionLinks.id, existing.id));
    } else {
      await this.db.drizzle.insert(schema.runProjectionLinks).values({
        companyId: event.companyId,
        projectId: event.projectId,
        runId: event.runId,
        surface: 'plan_approval',
        surfaceId: approvalId,
        surfaceKey,
        eventType: event.type,
        eventSequence: event.sequence,
        status: 'active',
        traceId: event.traceId,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}
