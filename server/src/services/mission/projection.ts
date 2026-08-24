import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../../types.js';
import {
  isPlanGovernanceProjectable,
  projectPlanGovernanceEvent,
} from './plan-governance-projection.js';
import { isPlanProgressProjectable, projectPlanProgressEvent } from './plan-progress-projection.js';

/**
 * Mission Projection module (VAL-CROSS-075, VAL-CROSS-092, VAL-CROSS-093,
 * VAL-RUN-099, VAL-RUN-100).
 *
 * Consumes committed journal events and idempotently updates mutable
 * projection surfaces: project thread items (`task_thread_items`) and
 * activity log entries (`activity_log`). Each projection is tracked in
 * `run_projection_links` with a deterministic `surface_key` so replay and
 * repair converge once — a duplicate insert is a no-op, not a second row.
 *
 * Projection failure never rolls back a completed external operation. It
 * records a retryable projection error (a `failed` link and a
 * `projection.failed` journal event) and is retried idempotently via
 * {@link MissionProjectionService.repair}. Repair emits a
 * `projection.repaired` journal event and an activity log entry so
 * operators can correlate the repaired card with a durable record.
 *
 * Mutable projections never authorize Mission execution. The authoritative
 * state lives in `mission_runs` and `run_events`.
 */

/** Projection surfaces. */
export type ProjectionSurface = 'thread_item' | 'activity_log';

/** A run event to project. */
export interface ProjectableEvent {
  runId: string;
  companyId: string;
  projectId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  actorType: 'user' | 'agent' | 'system' | null;
  actorId: string | null;
  traceId: string | null;
  occurredAt: Date;
}

export interface ProjectionDeps {
  clock?: () => Date;
}

export interface RepairInput {
  companyId: string;
  projectId: string;
  runId: string;
  surface: ProjectionSurface;
  traceId?: string | null;
}

export interface RepairResult {
  repaired: boolean;
  surfaceId: string | null;
}

/** Projection-tracking journal event types appendable via the locked helper. */
export type ProjectionJournalEventType = 'projection.failed' | 'projection.repaired';

export interface AppendProjectionJournalEventInput {
  runId: string;
  companyId: string;
  projectId: string;
  type: ProjectionJournalEventType;
  payload: Record<string, unknown>;
  traceId?: string | null;
  occurredAt: Date;
  /**
   * When true, skip appending if the run is in a terminal state. Used by
   * `projection.repaired` so post-terminalization repair does not append
   * to the closed run journal (VAL-RUN-034).
   */
  skipIfTerminal?: boolean;
}

/**
 * Append a projection-tracking journal event (`projection.failed` or
 * `projection.repaired`) under a locked transaction that holds
 * `mission_runs` `FOR UPDATE`, computes `sequence = last_event_sequence + 1`,
 * inserts the `run_events` row, and bumps the run counter in one
 * transaction.
 *
 * This honors the architecture's RunEvent Journal invariant: the writer
 * locks `mission_runs`, computes the next sequence, inserts the event, and
 * updates the counter atomically. Concurrent projection failures (or
 * concurrent repair) on the same run cannot produce duplicate or missing
 * sequence numbers — the row lock serializes sequence allocation.
 *
 * Projection-tracking events are non-authoritative: they do not change
 * `state_version` and never authorize execution. A projection failure is
 * still recorded as a retryable `failed` link in `run_projection_links` by
 * the caller; this helper only appends the observable journal event.
 *
 * Returns the appended sequence, or `null` if the run was not found or
 * (when `skipIfTerminal`) the run was terminal and the append was skipped.
 */
export async function appendProjectionJournalEvent(
  db: DbInstance,
  input: AppendProjectionJournalEventInput,
): Promise<number | null> {
  const schema = db.schema;
  return db.drizzle.transaction(async (tx) => {
    const [run] = await tx
      .select({
        lastEventSequence: schema.missionRuns.lastEventSequence,
        status: schema.missionRuns.status,
      })
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, input.runId))
      .for('update')
      .limit(1);

    if (!run) {
      return null;
    }

    if (input.skipIfTerminal) {
      const isTerminal =
        run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
      if (isTerminal) {
        return null;
      }
    }

    const seq = Number(run.lastEventSequence) + 1;
    await tx.insert(schema.runEvents).values({
      companyId: input.companyId,
      projectId: input.projectId,
      runId: input.runId,
      sequence: seq,
      type: input.type,
      schemaVersion: 1,
      payload: input.payload,
      actorType: 'system',
      actorId: null,
      traceId: input.traceId ?? null,
      occurredAt: input.occurredAt,
    });
    await tx
      .update(schema.missionRuns)
      .set({ lastEventSequence: seq, updatedAt: input.occurredAt })
      .where(eq(schema.missionRuns.id, input.runId));
    return seq;
  });
}

/**
 * Idempotently project a run event to mutable surfaces.
 *
 * Called after the authoritative transaction commits. Projection failures
 * are caught and recorded as retryable errors — they never roll back the
 * authoritative state.
 */
export async function projectEvent(
  db: DbInstance,
  event: ProjectableEvent,
  deps: ProjectionDeps = {},
): Promise<void> {
  const now = deps.clock ? deps.clock() : new Date();
  const projectionService = new MissionProjectionService(db, deps);

  // Thread item projection for lifecycle events.
  if (isThreadProjectable(event.type)) {
    try {
      await projectionService.projectThreadItem(event, now);
    } catch (err) {
      await projectionService.recordProjectionFailure(db, event, 'thread_item', err, now);
    }
  }

  // Activity log projection for lifecycle events.
  if (isActivityProjectable(event.type)) {
    try {
      await projectionService.projectActivityLog(event, now);
    } catch (err) {
      await projectionService.recordProjectionFailure(db, event, 'activity_log', err, now);
    }
  }

  // Plan governance projection: project plan.proposed/approved/rejected/
  // revision_requested to project_plans, project_plan_steps, and
  // plan_approval surfaces idempotently. Projection failure is caught and
  // recorded — it never authorizes execution (VAL-PLAN-060..064, 066, 098,
  // 099, 119, 127).
  if (isPlanGovernanceProjectable(event.type)) {
    await projectPlanGovernanceEvent(db, event, deps);
  }

  // Plan progress projection: project approved-plan child execution events
  // (child.started/completed/failed/cancel_requested) to the matching
  // project_plan_steps row so the Plans surface tracks execution progress
  // and terminal outcomes idempotently. Mutable projections never alter the
  // immutable approved Mission revision used by execution (VAL-CROSS-046).
  if (isPlanProgressProjectable(event.type)) {
    await projectPlanProgressEvent(db, event, deps);
  }
}

function isThreadProjectable(eventType: string): boolean {
  return (
    eventType === 'run.created' ||
    eventType === 'run.completed' ||
    eventType === 'run.failed' ||
    eventType === 'run.cancelled'
  );
}

function isActivityProjectable(eventType: string): boolean {
  return (
    eventType === 'run.created' ||
    eventType === 'run.completed' ||
    eventType === 'run.failed' ||
    eventType === 'run.cancelled'
  );
}

export class MissionProjectionService {
  constructor(
    private db: DbInstance,
    private deps: ProjectionDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Idempotently create a thread item projection for a run event.
   * inside a transaction. Uses a deterministic surface_key to prevent
   * duplicates on replay.
   */
  async projectThreadItem(event: ProjectableEvent, now: Date): Promise<string> {
    const schema = this.db.schema;
    const surfaceKey = `thread_item:${event.sequence}`;

    // Check for an existing link — if active, the projection already exists.
    const [existing] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'thread_item'),
          eq(schema.runProjectionLinks.surfaceKey, surfaceKey),
        ),
      )
      .limit(1);

    if (existing && existing.status === 'active') {
      return existing.surfaceId;
    }

    // Create the thread item.
    const itemId = randomUUID();
    const statusText = deriveStatusFromEvent(event.type);
    await this.db.drizzle.insert(schema.taskThreadItems).values({
      id: itemId,
      companyId: event.companyId,
      projectThreadId: await this.getThreadForRun(event.companyId, event.projectId, event.runId),
      kind: 'execution_event',
      content: `Mission ${statusText}`,
      payload: {
        runId: event.runId,
        eventType: event.type,
        eventSequence: event.sequence,
        missionStatus: statusText,
      },
      status: 'linked',
      projectId: event.projectId,
    });

    // Upsert the projection link.
    if (existing) {
      // Update the failed link to active.
      await this.db.drizzle
        .update(schema.runProjectionLinks)
        .set({
          surfaceId: itemId,
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
        surface: 'thread_item',
        surfaceId: itemId,
        surfaceKey,
        eventType: event.type,
        eventSequence: event.sequence,
        status: 'active',
        traceId: event.traceId,
        createdAt: now,
        updatedAt: now,
      });
    }

    return itemId;
  }

  /**
   * Idempotently create an activity log entry for a run event.
   */
  async projectActivityLog(event: ProjectableEvent, now: Date): Promise<string> {
    const schema = this.db.schema;
    const surfaceKey = `activity_log:${event.sequence}`;

    const [existing] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, event.companyId),
          eq(schema.runProjectionLinks.runId, event.runId),
          eq(schema.runProjectionLinks.surface, 'activity_log'),
          eq(schema.runProjectionLinks.surfaceKey, surfaceKey),
        ),
      )
      .limit(1);

    if (existing && existing.status === 'active') {
      return existing.surfaceId;
    }

    const activityId = randomUUID();
    const action = deriveActivityAction(event.type);
    await this.db.drizzle.insert(schema.activityLog).values({
      id: activityId,
      companyId: event.companyId,
      actorType: event.actorType ?? 'system',
      actorId: event.actorId,
      action,
      entityType: 'mission_run',
      entityId: event.runId,
      description: `Mission run ${deriveStatusFromEvent(event.type)}`,
      metadata: {
        runId: event.runId,
        eventType: event.type,
        eventSequence: event.sequence,
      },
      projectId: event.projectId,
    });

    if (existing) {
      await this.db.drizzle
        .update(schema.runProjectionLinks)
        .set({
          surfaceId: activityId,
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
        surface: 'activity_log',
        surfaceId: activityId,
        surfaceKey,
        eventType: event.type,
        eventSequence: event.sequence,
        status: 'active',
        traceId: event.traceId,
        createdAt: now,
        updatedAt: now,
      });
    }

    return activityId;
  }

  /**
   * Record a projection failure: create a failed link and emit a
   * `projection.failed` journal event. This does NOT roll back the
   * authoritative state.
   */
  async recordProjectionFailure(
    db: DbInstance,
    event: ProjectableEvent,
    surface: ProjectionSurface,
    err: unknown,
    now: Date,
  ): Promise<void> {
    const schema = db.schema;
    const surfaceKey = `${surface}:${event.sequence}`;
    const errorMessage = err instanceof Error ? err.message : 'Projection failed';

    // Check if a link already exists.
    const [existing] = await db.drizzle
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
      await db.drizzle
        .update(schema.runProjectionLinks)
        .set({ status: 'failed', errorMessage, updatedAt: now })
        .where(eq(schema.runProjectionLinks.id, existing.id));
    } else {
      await db.drizzle.insert(schema.runProjectionLinks).values({
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
    // journal marker and is non-authoritative.
    await appendProjectionJournalEvent(db, {
      runId: event.runId,
      companyId: event.companyId,
      projectId: event.projectId,
      type: 'projection.failed',
      payload: { surface, eventSequence: event.sequence, error: errorMessage },
      traceId: event.traceId,
      occurredAt: now,
    });
  }

  /**
   * Repair a failed projection. Idempotent: if the projection is already
   * active or repaired, this is a no-op. If the run is terminal, the repair
   * does NOT append to the closed run journal — it only updates the
   * projection surface, the link, and the activity log.
   */
  async repair(input: RepairInput): Promise<RepairResult> {
    const schema = this.db.schema;
    const now = this.now();
    const { companyId, projectId, runId, surface, traceId } = input;

    // Find the failed link.
    const [link] = await this.db.drizzle
      .select()
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, companyId),
          eq(schema.runProjectionLinks.runId, runId),
          eq(schema.runProjectionLinks.surface, surface),
        ),
      )
      .limit(1);

    if (!link) {
      return { repaired: false, surfaceId: null };
    }

    // Already active or repaired — no-op.
    if (link.status === 'active' || link.status === 'repaired') {
      return { repaired: false, surfaceId: link.surfaceId };
    }

    // Re-read the run to get the event details for re-projection.
    const [run] = await this.db.drizzle
      .select()
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, runId))
      .limit(1);

    if (!run) {
      return { repaired: false, surfaceId: null };
    }

    // Re-read the triggering event.
    const eventSeq = link.eventSequence;
    let event: ProjectableEvent | null = null;
    if (eventSeq !== null) {
      const [evt] = await this.db.drizzle
        .select()
        .from(schema.runEvents)
        .where(and(eq(schema.runEvents.runId, runId), eq(schema.runEvents.sequence, eventSeq)))
        .limit(1);
      if (evt) {
        event = {
          runId,
          companyId,
          projectId,
          sequence: Number(evt.sequence),
          type: evt.type,
          payload: evt.payload,
          actorType: evt.actorType as 'user' | 'agent' | 'system' | null,
          actorId: evt.actorId,
          traceId: traceId ?? evt.traceId,
          occurredAt: evt.occurredAt,
        };
      }
    }

    // If we can't find the original event, reconstruct from the run.
    if (!event) {
      event = {
        runId,
        companyId,
        projectId,
        sequence: eventSeq ?? 0,
        type: link.eventType ?? 'run.created',
        payload: { runId, status: run.status },
        actorType: 'system',
        actorId: null,
        traceId: traceId ?? null,
        occurredAt: now,
      };
    }

    // Re-project to the surface.
    let surfaceId: string | null = null;
    if (surface === 'thread_item') {
      surfaceId = await this.projectThreadItem(event, now);
    } else if (surface === 'activity_log') {
      surfaceId = await this.projectActivityLog(event, now);
    }

    // Update the link to repaired.
    await this.db.drizzle
      .update(schema.runProjectionLinks)
      .set({
        surfaceId: surfaceId ?? link.surfaceId,
        status: 'repaired',
        errorMessage: null,
        traceId: traceId ?? link.traceId,
        updatedAt: now,
      })
      .where(eq(schema.runProjectionLinks.id, link.id));

    // Check if the run is terminal — if so, do NOT append to the run journal.
    // The append itself is performed under a locked transaction
    // (SELECT FOR UPDATE on mission_runs) via appendProjectionJournalEvent
    // with skipIfTerminal, so the terminal check and sequence allocation
    // are atomic and concurrent repairs cannot corrupt the journal.
    await appendProjectionJournalEvent(this.db, {
      runId,
      companyId,
      projectId,
      type: 'projection.repaired',
      payload: { surface, eventSequence: eventSeq, linkId: link.id },
      traceId: traceId ?? null,
      occurredAt: now,
      skipIfTerminal: true,
    });

    // Always write an activity log entry for the repair (even after terminalization).
    const repairActivityId = randomUUID();
    await this.db.drizzle.insert(schema.activityLog).values({
      id: repairActivityId,
      companyId,
      actorType: 'system',
      actorId: null,
      action: 'mission.projection.repaired',
      entityType: 'mission_run',
      entityId: runId,
      description: `Mission projection repaired: ${surface}`,
      metadata: {
        runId,
        surface,
        linkId: link.id,
        eventSequence: eventSeq,
      },
      projectId,
    });

    return { repaired: true, surfaceId: surfaceId ?? link.surfaceId };
  }

  /**
   * Look up the project thread ID for a run.
   */
  private async getThreadForRun(
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<string> {
    const schema = this.db.schema;
    const [run] = await this.db.drizzle
      .select({ threadId: schema.missionRuns.projectThreadId })
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, runId))
      .limit(1);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    return run.threadId;
  }
}

/** Derive a human-readable status from an event type. */
function deriveStatusFromEvent(eventType: string): string {
  switch (eventType) {
    case 'run.created':
      return 'started';
    case 'run.completed':
      return 'completed';
    case 'run.failed':
      return 'failed';
    case 'run.cancelled':
      return 'cancelled';
    default:
      return eventType;
  }
}

/** Derive an activity log action from an event type. */
function deriveActivityAction(eventType: string): string {
  switch (eventType) {
    case 'run.created':
      return 'mission.run.started';
    case 'run.completed':
      return 'mission.run.completed';
    case 'run.failed':
      return 'mission.run.failed';
    case 'run.cancelled':
      return 'mission.run.cancelled';
    default:
      return `mission.${eventType}`;
  }
}
