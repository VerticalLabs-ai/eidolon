import { and, eq } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import { isFeatureEnabled } from '../feature-flags.js';
import type { DbInstance } from '../../types.js';

/**
 * Mission plan revision read service.
 *
 * Exposes the immutable current plan revision content (proposed or approved)
 * for a run so the UI can render objective, ordered topology, routing
 * authority, exact tools, expected outputs, and completion criteria from
 * authoritative server content (VAL-PLAN-008..017, VAL-PLAN-125).
 *
 * This is a read-only projection: it never mutates run, revision, approval,
 * or journal state. The durable `run_plan_revisions` row is the
 * authoritative source; the `content` JSONB holds the validated
 * `PlanContentV1`. Cross-scope identifiers return 404 without revealing
 * existence.
 *
 * Reads do not require the mission flag to be enabled, mirroring the
 * existing snapshot/events/commands read policy so an operator can review a
 * proposed plan during a kill switch.
 */

/** A plan revision exposed for card rendering. */
export interface PlanRevisionView {
  id: string;
  revision: number;
  status: 'proposed' | 'superseded' | 'approved' | 'rejected';
  contentHash: string;
  parentRevisionId: string | null;
  createdAt: string;
  content: Record<string, unknown>;
}

export class MissionPlanSnapshotService {
  constructor(private db: DbInstance) {}

  /**
   * Read the current plan revision for a run, scoped to the given
   * company/project. The "current" revision is the one referenced by the
   * run's `current_plan_revision_id` pointer. Throws 404 `RUN_NOT_FOUND`
   * for an absent or cross-scope run, and 404 `PLAN_NOT_FOUND` when the
   * run has no current plan revision (or the revision row is missing).
   *
   * Reads do not require the mission flag (mirrors snapshot/events read
   * policy).
   */
  async getCurrentPlanRevision(
    companyId: string,
    projectId: string,
    runId: string,
  ): Promise<PlanRevisionView> {
    const schema = this.db.schema;

    // Resolve the run's current plan revision pointer, scoped to
    // company/project so a cross-scope ID reveals nothing.
    const [run] = await this.db.drizzle
      .select({
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
      throw new AppError(404, 'RUN_NOT_FOUND', 'Mission run not found');
    }

    const revisionId = run.currentPlanRevisionId;
    if (!revisionId) {
      throw new AppError(404, 'PLAN_NOT_FOUND', 'No current plan revision for this run');
    }

    const [revision] = await this.db.drizzle
      .select()
      .from(schema.runPlanRevisions)
      .where(
        and(
          eq(schema.runPlanRevisions.companyId, companyId),
          eq(schema.runPlanRevisions.id, revisionId),
        ),
      )
      .limit(1);

    if (!revision) {
      throw new AppError(404, 'PLAN_NOT_FOUND', 'Current plan revision not found');
    }

    return {
      id: revision.id,
      revision: revision.revision,
      status: revision.status as PlanRevisionView['status'],
      contentHash: revision.contentHash,
      parentRevisionId: revision.parentRevisionId,
      createdAt: revision.createdAt.toISOString(),
      content: revision.content as Record<string, unknown>,
    };
  }
}

/**
 * Whether the Mission feature flag is enabled for a company. Re-exported
 * here so the route layer can gate creation while keeping reads open.
 */
export function missionFlagEnabled(companyId: string): boolean {
  return isFeatureEnabled('missionAgentIntelligence', companyId);
}
