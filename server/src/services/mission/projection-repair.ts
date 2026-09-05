import { and, asc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * Mission projection-repair read service (VAL-RUN-100, VAL-CROSS-075).
 *
 * Projection repair was previously an internal service method invoked only
 * in integration tests. This read service exposes projection failure and
 * repair evidence — the durable `run_projection_links` rows, the
 * `projection.failed`/`projection.repaired` journal events, and the
 * `mission.projection.repaired` activity log entries — so an authorized
 * operator can correlate a repaired card with an attributable repair record
 * carrying the same run identity and a safe timestamp/trace reference via
 * an HTTP route accessible by `curl`.
 *
 * This is a read-only surface. It never authorizes Mission execution, never
 * triggers a repair, and never mutates authoritative state. The
 * authoritative state lives in `mission_runs`, `run_events`, and
 * `run_projection_links`. Repair is performed by
 * {@link MissionProjectionService.repair}.
 */

/** A projection link summary for the repair-history read. */
export interface ProjectionLinkEntry {
  id: string;
  runId: string;
  surface: string;
  surfaceId: string;
  surfaceKey: string;
  eventType: string | null;
  eventSequence: number | null;
  /** 'active' (projected), 'failed' (retryable projection error),
   *  'repaired' (failure was repaired). */
  status: string;
  errorMessage: string | null;
  traceId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A sanitized projection repair/failure journal event summary. */
export interface RepairEventEntry {
  sequence: number;
  type: string;
  runId: string;
  payload: Record<string, unknown>;
  traceId: string | null;
  occurredAt: string;
}

/** A repair activity log entry attributable to the run. */
export interface RepairActivityEntry {
  id: string;
  action: string;
  entityId: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ProjectionRepairReadResult {
  projectionLinks: ProjectionLinkEntry[];
  /** `projection.failed` and `projection.repaired` journal events only. */
  repairEvents: RepairEventEntry[];
  /** Activity log entries recording projection repair. */
  repairActivity: RepairActivityEntry[];
}

export interface ProjectionRepairReadInput {
  companyId: string;
  projectId: string;
  runId: string;
}

const REPAIR_EVENT_TYPES = ['projection.failed', 'projection.repaired'];
const REPAIR_ACTION = 'mission.projection.repaired';

export class MissionProjectionRepairService {
  constructor(private db: DbInstance) {}

  /**
   * Read the projection repair history/status for a run, scoped to the
   * given company/project. Throws 404 RUN_NOT_FOUND for an absent or
   * cross-scope run id (non-enumerating). Projection link rows, repair
   * journal events, and repair activity entries are returned in stable
   * order. This read does not require the mission feature flag —
   * authorized operators may inspect repair evidence even while the flag
   * is disabled, mirroring the existing commands/events read policy.
   */
  async readRepairHistory(input: ProjectionRepairReadInput): Promise<ProjectionRepairReadResult> {
    const { companyId, projectId, runId } = input;
    const schema = this.db.schema;

    // 1. Verify the run exists in scope (non-enumerating 404).
    const [run] = await this.db.drizzle
      .select({ id: schema.missionRuns.id })
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
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    // 2. Projection links for the run, scoped by company and ordered by
    //    event sequence then surface for stable output.
    const linkRows = await this.db.drizzle
      .select({
        id: schema.runProjectionLinks.id,
        runId: schema.runProjectionLinks.runId,
        surface: schema.runProjectionLinks.surface,
        surfaceId: schema.runProjectionLinks.surfaceId,
        surfaceKey: schema.runProjectionLinks.surfaceKey,
        eventType: schema.runProjectionLinks.eventType,
        eventSequence: schema.runProjectionLinks.eventSequence,
        status: schema.runProjectionLinks.status,
        errorMessage: schema.runProjectionLinks.errorMessage,
        traceId: schema.runProjectionLinks.traceId,
        createdAt: schema.runProjectionLinks.createdAt,
        updatedAt: schema.runProjectionLinks.updatedAt,
      })
      .from(schema.runProjectionLinks)
      .where(
        and(
          eq(schema.runProjectionLinks.companyId, companyId),
          eq(schema.runProjectionLinks.runId, runId),
        ),
      )
      .orderBy(
        asc(schema.runProjectionLinks.eventSequence),
        asc(schema.runProjectionLinks.surface),
      );

    const projectionLinks: ProjectionLinkEntry[] = linkRows.map((r) => ({
      id: r.id,
      runId: r.runId,
      surface: r.surface,
      surfaceId: r.surfaceId,
      surfaceKey: r.surfaceKey,
      eventType: r.eventType,
      eventSequence: r.eventSequence,
      status: r.status,
      errorMessage: r.errorMessage,
      traceId: r.traceId,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }));

    // 3. projection.failed / projection.repaired journal events, scoped to
    //    the run and ordered by sequence.
    const eventRows = await this.db.drizzle
      .select({
        sequence: schema.runEvents.sequence,
        type: schema.runEvents.type,
        runId: schema.runEvents.runId,
        payload: schema.runEvents.payload,
        traceId: schema.runEvents.traceId,
        occurredAt: schema.runEvents.occurredAt,
      })
      .from(schema.runEvents)
      .where(
        and(
          eq(schema.runEvents.companyId, companyId),
          eq(schema.runEvents.runId, runId),
          inArray(schema.runEvents.type, REPAIR_EVENT_TYPES),
        ),
      )
      .orderBy(asc(schema.runEvents.sequence));

    const repairEvents: RepairEventEntry[] = eventRows.map((r) => ({
      sequence: Number(r.sequence),
      type: r.type,
      runId: r.runId,
      payload: r.payload,
      traceId: r.traceId,
      occurredAt: r.occurredAt.toISOString(),
    }));

    // 4. Repair activity log entries attributable to the run. Activity
    //    entries are company-scoped and tied to the run via entityId, so a
    //    post-terminal repair (which writes activity but no run journal
    //    event) remains observable here.
    const activityRows = await this.db.drizzle
      .select({
        id: schema.activityLog.id,
        action: schema.activityLog.action,
        entityId: schema.activityLog.entityId,
        description: schema.activityLog.description,
        metadata: schema.activityLog.metadata,
        createdAt: schema.activityLog.createdAt,
      })
      .from(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.companyId, companyId),
          eq(schema.activityLog.entityId, runId),
          eq(schema.activityLog.action, REPAIR_ACTION),
        ),
      )
      .orderBy(asc(schema.activityLog.createdAt));

    const repairActivity: RepairActivityEntry[] = activityRows.map((r) => ({
      id: r.id,
      action: r.action,
      entityId: r.entityId,
      description: r.description,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    }));

    return { projectionLinks, repairEvents, repairActivity };
  }
}
