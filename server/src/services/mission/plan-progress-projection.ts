import { and, eq } from 'drizzle-orm';
import type { DbInstance } from '../../types.js';
import type { ProjectableEvent, ProjectionDeps } from './projection.js';
/**
 * Plan Progress Projection module (VAL-CROSS-046).
 *
 * Idempotently projects approved-plan child execution events
 * (`child.started`, `child.completed`, `child.failed`,
 * `child.cancel_requested`) to the mutable `project_plan_steps` projection
 * so the cross-surface Plans view tracks execution progress and terminal
 * outcomes without granting edit authority over the immutable approved
 * Mission revision.
 *
 * ### Invariants
 *
 * - **Read-only projection:** This module never mutates the authoritative
 *   run, revision, approval, binding, budget, or execution ledger. Mission
 *   execution always reads the immutable approved revision from
 *   `run_plan_revisions`, not these mutable step rows. Editing a projected
 *   `project_plan_steps` row cannot alter the Mission's approved revision
 *   or hash (VAL-CROSS-046, VAL-PLAN-099).
 * - **Idempotent ordering:** Each step's latest projected event sequence is
 *   tracked in `run_projection_links` under surface
 *   `project_plan_step_progress` with a deterministic
 *   `surface_key = project_plan_step_progress:{revisionId}:{stepKey}`. An
 *   event whose sequence is not newer than the tracked sequence is a
 *   no-op, so replay/repair converges once and never applies a stale event
 *   over a newer one.
 * - **Terminal wins:** A terminal event (`child.completed`,
 *   `child.failed`, `child.cancel_requested`) is never overwritten by a
 *   later non-terminal event for the same step. Once a step is terminal in
 *   the projection, only a terminal event with a newer sequence may update
 *   it (defensive; the authoritative event journal is ordered so this is
 *   a safety net, not the primary ordering mechanism).
 * - **No projection authorizes execution:** A failed or absent progress
 *   projection does not change run state. Projection failure is caught and
 *   recorded as a retryable `failed` link, never re-thrown.
 */

/** Whether a run event type is an approved-plan progress event to project. */
export function isPlanProgressProjectable(eventType: string): boolean {
  return (
    eventType === 'child.started' ||
    eventType === 'child.completed' ||
    eventType === 'child.failed' ||
    eventType === 'child.cancel_requested'
  );
}

/** The projected `project_plan_steps.status` value for an event type. */
function stepStatusForEvent(eventType: string): string | null {
  switch (eventType) {
    case 'child.started':
      return 'in_progress';
    case 'child.completed':
      return 'completed';
    case 'child.failed':
      return 'blocked';
    case 'child.cancel_requested':
      return 'skipped';
    default:
      return null;
  }
}

/** Whether a status is terminal in the projected step model. */
function isTerminalStepStatus(status: string): boolean {
  return status === 'completed' || status === 'blocked' || status === 'skipped';
}

/**
 * Idempotently project an approved-plan child execution event to the
 * matching `project_plan_steps` row. Called after the authoritative
 * transaction commits. Projection failures are caught and recorded — they
 * never roll back authoritative state or authorize execution.
 */
export async function projectPlanProgressEvent(
  db: DbInstance,
  event: ProjectableEvent,
  deps: ProjectionDeps = {},
): Promise<void> {
  // Only child execution events with a stepKey are projectable.
  if (!isPlanProgressProjectable(event.type)) {
    return;
  }
  const stepKey = (event.payload?.stepKey as string | undefined) ?? undefined;
  if (!stepKey) {
    return;
  }
  const newStatus = stepStatusForEvent(event.type);
  if (!newStatus) {
    return;
  }

  const service = new MissionPlanProgressProjectionService(db, deps);
  try {
    await service.projectProgress(event, stepKey, newStatus);
  } catch (err) {
    await service.recordFailure(event, stepKey, err);
  }
}

export class MissionPlanProgressProjectionService {
  constructor(
    private db: DbInstance,
    private deps: ProjectionDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Project a single child execution event to the matching projected step.
   * Idempotent via the per-step progress link's tracked event sequence.
   */
  async projectProgress(
    event: ProjectableEvent,
    stepKey: string,
    newStatus: string,
  ): Promise<void> {
    const schema = this.db.schema;
    const now = this.now();

    // 1. Read the run to resolve the approved revision (execution reads the
    //    approved revision; progress projections track approved-plan steps).
    const [run] = await this.db.drizzle
      .select({
        approvedRevisionId: schema.missionRuns.approvedPlanRevisionId,
        currentRevisionId: schema.missionRuns.currentPlanRevisionId,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.id, event.runId),
          eq(schema.missionRuns.companyId, event.companyId),
        ),
      )
      .limit(1);

    if (!run) {
      return; // Run gone — nothing to project.
    }

    // Prefer the approved revision; fall back to the current revision so a
    // revision-requested re-projection still targets the originally
    // approved step rows. Execution only happens after approval, so the
    // approved revision is the canonical source.
    const revisionId = run.approvedRevisionId ?? run.currentRevisionId;
    if (!revisionId) {
      return; // No plan to track.
    }

    // 2. Locate the projected step row via its governance projection link.
    const stepSurfaceKey = `project_plan_step:${revisionId}:${stepKey}`;
    const [stepLink] = await this.db.drizzle
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

    if (!stepLink || stepLink.status !== 'active' || stepLink.surfaceId === 'pending') {
      // The step projection hasn't converged yet — record a retryable
      // failure so repair re-projects once the step row exists.
      throw new Error(
        `Projected step row not found for run ${event.runId} step ${stepKey} (revision ${revisionId})`,
      );
    }
    const stepId = stepLink.surfaceId;

    // 3. Idempotency: check the per-step progress link's tracked sequence.
    const progressSurfaceKey = `project_plan_step_progress:${revisionId}:${stepKey}`;
    const [progressLink] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'project_plan_step_progress'),
          eq(schema.runProjectionLinks.surfaceKey, progressSurfaceKey),
        ),
      )
      .limit(1);

    const trackedSeq = progressLink?.eventSequence ? Number(progressLink.eventSequence) : null;
    // Skip stale events: only apply if this event is newer than the last
    // projected event for this step.
    if (trackedSeq !== null && event.sequence <= trackedSeq) {
      return; // Already projected a newer-or-equal event — no-op.
    }

    // 4. Read the current step status so a terminal projection is not
    //    overwritten by a later non-terminal event (defensive ordering).
    const [stepRow] = await this.db.drizzle
      .select({ status: schema.projectPlanSteps.status })
      .from(schema.projectPlanSteps)
      .where(eq(schema.projectPlanSteps.id, stepId))
      .limit(1);
    if (!stepRow) {
      throw new Error(`Projected step row ${stepId} missing for run ${event.runId}`);
    }
    if (
      isTerminalStepStatus(stepRow.status) &&
      !isTerminalStepStatus(newStatus) &&
      trackedSeq !== null
    ) {
      // A terminal status was already projected from a newer event; do not
      // regress it with an older non-terminal event.
      return;
    }

    // 5. Update the projected step status (and completion timestamp for
    //    completed steps). This is a mutable projection; it never changes
    //    the immutable approved revision that execution reads. The
    //    authoritative producing-agent identity lives in the run's child
    //    execution ledger, not this mutable row, so the projection does not
    //    set agent FK columns (which would risk FK violations for ephemeral
    //    or cross-company agent references).
    const update: Record<string, unknown> = {
      status: newStatus,
      updatedAt: now,
    };
    if (newStatus === 'completed') {
      update.completedAt = now;
    } else if (isTerminalStepStatus(newStatus)) {
      // Failed/skipped: clear any stale completion metadata.
      update.completedAt = null;
      update.completedByUserId = null;
      update.completedByAgentId = null;
    }

    await this.db.drizzle
      .update(schema.projectPlanSteps)
      .set(update)
      .where(eq(schema.projectPlanSteps.id, stepId));

    // 6. Upsert the progress link to track the latest projected sequence.
    if (progressLink) {
      await this.db.drizzle
        .update(schema.runProjectionLinks)
        .set({
          surfaceId: stepId,
          status: 'active',
          eventSequence: event.sequence,
          eventType: event.type,
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.runProjectionLinks.id, progressLink.id));
    } else {
      await this.db.drizzle.insert(schema.runProjectionLinks).values({
        companyId: event.companyId,
        projectId: event.projectId,
        runId: event.runId,
        surface: 'project_plan_step_progress',
        surfaceId: stepId,
        surfaceKey: progressSurfaceKey,
        eventType: event.type,
        eventSequence: event.sequence,
        status: 'active',
        traceId: event.traceId,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /**
   * Record a projection failure as a retryable `failed` progress link. Does
   * NOT roll back authoritative state or authorize execution.
   */
  async recordFailure(event: ProjectableEvent, stepKey: string, err: unknown): Promise<void> {
    const schema = this.db.schema;
    const now = this.now();
    const errorMessage = err instanceof Error ? err.message : 'Plan progress projection failed';
    const surfaceKey = `project_plan_step_progress:${event.runId}:${stepKey}`;

    const [existing] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'project_plan_step_progress'),
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
        surface: 'project_plan_step_progress',
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
  }

  /**
   * Repair failed progress projections for a run by re-projecting from the
   * authoritative event journal. Idempotent.
   */
  async repair(companyId: string, runId: string): Promise<boolean> {
    const schema = this.db.schema;
    const failedLinks = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, companyId),
          eq(schema.runProjectionLinks.runId, runId),
          eq(schema.runProjectionLinks.surface, 'project_plan_step_progress'),
          eq(schema.runProjectionLinks.status, 'failed'),
        ),
      );

    if (failedLinks.length === 0) {
      return false;
    }

    let repairedAny = false;
    for (const link of failedLinks) {
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
      const stepKey = (evt.payload?.stepKey as string | undefined) ?? undefined;
      const newStatus = stepStatusForEvent(evt.type);
      if (!stepKey || !newStatus) {
        continue;
      }
      const event: ProjectableEvent = {
        runId,
        companyId,
        projectId: link.projectId,
        sequence: Number(evt.sequence),
        type: evt.type,
        payload: evt.payload as Record<string, unknown>,
        actorType: evt.actorType as 'user' | 'agent' | 'system' | null,
        actorId: evt.actorId,
        traceId: link.traceId ?? evt.traceId,
        occurredAt: evt.occurredAt,
      };
      try {
        await this.projectProgress(event, stepKey, newStatus);
        repairedAny = true;
      } catch {
        // Repair failed — link remains failed for the next retry.
      }
    }
    return repairedAny;
  }
}
