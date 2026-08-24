import { and, eq, sql } from 'drizzle-orm';
import type { DbInstance } from '../../types.js';

/**
 * Mission Descendant Mirror module (VAL-SUB-058, VAL-SUB-092,
 * VAL-SUB-112).
 *
 * Mirrors authoritative local descendant lifecycle events to the root run
 * journal as stable `descendant.progressed/v1` events. The root stream
 * thereby durably mirrors complete descendant progress: every user-visible
 * descendant assignment, status, cost, failure, question, and output-link
 * change appears once as `descendant.progressed/v1`.
 *
 * **Uniqueness and de-cycling (VAL-SUB-058):** Each mirror is recorded in
 * `run_descendant_mirrors` with a unique constraint on
 * `(root_run_id, descendant_run_id, source_sequence)`. A mirror is only ever
 * created from an authoritative local descendant event, never from another
 * mirror. This prevents cycles and duplicates.
 *
 * **Per-descendant watermarks (VAL-SUB-092, VAL-SUB-112):** The
 * `MAX(source_sequence)` per descendant tracks how far mirroring has
 * progressed. Root synthesis and terminalization must wait for all relevant
 * terminal watermarks before proceeding.
 *
 * **No post-terminal mirror (VAL-SUB-092, VAL-SUB-112):** Once the root run
 * is terminal, no further descendant mirrors may be appended to the root
 * journal. Final mirrors must precede terminal close.
 */

type Tx = Parameters<Parameters<DbInstance['drizzle']['transaction']>[0]>[0];

export interface DescendantMirrorDeps {
  clock?: () => Date;
}

/**
 * Event types that are mirrorable from descendant runs to the root journal.
 * Only authoritative local descendant lifecycle events are mirrored —
 * never projection events, never other mirrors.
 */
const MIRRORABLE_EVENT_TYPES = new Set([
  'run.created',
  'run.status_changed',
  'run.claimed',
  'run.recovered',
  'run.cancel_requested',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'child.created',
  'child.routed',
  'child.started',
  'child.completed',
  'child.failed',
  'child.cancel_requested',
  'execution.started',
  'execution.progress',
  'tool.requested',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'tool.denied',
  'questions.requested',
  'questions.answered',
  'questions.invalidated',
  'budget.reserved',
  'budget.allocated',
  'budget.settled',
  'budget.released',
  'budget.exhausted',
  'artifact.committed',
  'synthesis.started',
  'synthesis.completed',
]);

export interface MirrorInput {
  companyId: string;
  projectId: string;
  rootRunId: string;
  descendantRunId: string;
  /** The run-local sequence of the source event on the descendant run. */
  sourceSequence: number;
  /** The type of the source event. */
  sourceEventType: string;
  /** Sanitized payload of the source event. */
  sourcePayload: Record<string, unknown>;
  actorType?: 'user' | 'agent' | 'system' | null;
  actorId?: string | null;
  traceId?: string | null;
}

export interface MirrorResult {
  /** Whether a new mirror was created (false = already mirrored or skipped). */
  created: boolean;
  /** The root run journal sequence of the mirror event, if created. */
  rootEventSequence: number | null;
  /** Reason the mirror was skipped, if applicable. */
  skipReason: string | null;
}

export class DescendantMirrorService {
  constructor(
    private db: DbInstance,
    private deps: DescendantMirrorDeps = {},
  ) {}

  private now(): Date {
    return this.deps.clock ? this.deps.clock() : new Date();
  }

  /**
   * Mirror a descendant source event to the root run journal as a
   * `descendant.progressed` event.
   *
   * This is idempotent: if the source event has already been mirrored
   * (unique constraint on `(root_run_id, descendant_run_id,
   * source_sequence)`), the existing mirror is returned without creating
   * a duplicate (VAL-SUB-058).
   *
   * No post-terminal mirror: if the root run is already terminal, the
   * mirror is skipped (VAL-SUB-092, VAL-SUB-112).
   *
   * Only authoritative local descendant events are mirrored — projection
   * events and other mirrors are excluded to prevent cycles (VAL-SUB-058).
   *
   * Must be called inside a locked transaction where the root run row is
   * already locked via `FOR UPDATE`.
   */
  async mirrorDescendantEvent(tx: Tx, input: MirrorInput): Promise<MirrorResult> {
    const schema = this.db.schema;
    const now = this.now();

    // Only mirror authoritative local descendant events.
    if (!MIRRORABLE_EVENT_TYPES.has(input.sourceEventType)) {
      return { created: false, rootEventSequence: null, skipReason: 'not_mirrorable' };
    }
    // Check for an existing mirror — idempotency.
    const [existing] = await tx
      .select()
      .from(schema.runDescendantMirrors)
      .where(
        and(
          eq(schema.runDescendantMirrors.rootRunId, input.rootRunId),
          eq(schema.runDescendantMirrors.descendantRunId, input.descendantRunId),
          eq(schema.runDescendantMirrors.sourceSequence, input.sourceSequence),
        ),
      )
      .limit(1);

    if (existing) {
      return {
        created: false,
        rootEventSequence: Number(existing.rootEventSequence),
        skipReason: 'already_mirrored',
      };
    }

    // Read the root run under the lock (caller must hold FOR UPDATE).
    const [rootRun] = await tx
      .select({
        lastEventSequence: schema.missionRuns.lastEventSequence,
        status: schema.missionRuns.status,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, input.companyId),
          eq(schema.missionRuns.id, input.rootRunId),
        ),
      )
      .limit(1);

    if (!rootRun) {
      return { created: false, rootEventSequence: null, skipReason: 'root_not_found' };
    }

    // No post-terminal mirror (VAL-SUB-092, VAL-SUB-112).
    const isTerminal = ['completed', 'failed', 'cancelled'].includes(rootRun.status);
    if (isTerminal) {
      return { created: false, rootEventSequence: null, skipReason: 'root_terminal' };
    }

    // Compute the next root journal sequence.
    const rootSeq = Number(rootRun.lastEventSequence) + 1;

    // Emit the `descendant.progressed` event on the root run journal.
    await tx.insert(schema.runEvents).values({
      companyId: input.companyId,
      projectId: input.projectId,
      runId: input.rootRunId,
      sequence: rootSeq,
      type: 'descendant.progressed',
      schemaVersion: 1,
      payload: {
        descendantRunId: input.descendantRunId,
        sourceSequence: input.sourceSequence,
        sourceEventType: input.sourceEventType,
        sourcePayload: input.sourcePayload,
      },
      actorType: input.actorType ?? 'system',
      actorId: input.actorId ?? null,
      traceId: input.traceId ?? null,
      occurredAt: now,
    });

    // Update the root run's last_event_sequence.
    await tx
      .update(schema.missionRuns)
      .set({ lastEventSequence: rootSeq, updatedAt: now })
      .where(eq(schema.missionRuns.id, input.rootRunId));

    // Record the mirror for uniqueness and watermark tracking.
    await tx.insert(schema.runDescendantMirrors).values({
      companyId: input.companyId,
      projectId: input.projectId,
      rootRunId: input.rootRunId,
      descendantRunId: input.descendantRunId,
      sourceSequence: input.sourceSequence,
      sourceEventType: input.sourceEventType,
      rootEventSequence: rootSeq,
      traceId: input.traceId ?? null,
      createdAt: now,
    });

    return { created: true, rootEventSequence: rootSeq, skipReason: null };
  }

  /**
   * Get the per-descendant watermark (the highest mirrored source sequence)
   * for a given descendant run under a root.
   */
  async getDescendantWatermark(rootRunId: string, descendantRunId: string): Promise<number> {
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
      .select({
        maxSeq: sql<number>`coalesce(max(${schema.runDescendantMirrors.sourceSequence}), 0)`,
      })
      .from(schema.runDescendantMirrors)
      .where(
        and(
          eq(schema.runDescendantMirrors.rootRunId, rootRunId),
          eq(schema.runDescendantMirrors.descendantRunId, descendantRunId),
        ),
      );
    return Number(row?.maxSeq ?? 0);
  }

  /**
   * Get all descendant watermarks for a root run.
   * Returns a map of descendantRunId → highest mirrored source sequence.
   */
  async getAllWatermarks(rootRunId: string): Promise<Map<string, number>> {
    const schema = this.db.schema;
    const rows = await this.db.drizzle
      .select({
        descendantRunId: schema.runDescendantMirrors.descendantRunId,
        maxSeq: sql<number>`coalesce(max(${schema.runDescendantMirrors.sourceSequence}), 0)`,
      })
      .from(schema.runDescendantMirrors)
      .where(eq(schema.runDescendantMirrors.rootRunId, rootRunId))
      .groupBy(schema.runDescendantMirrors.descendantRunId);

    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(row.descendantRunId, Number(row.maxSeq));
    }
    return map;
  }

  /**
   * Check whether all descendants of a root run have been mirrored up to
   * their latest source sequence. Used to verify that root synthesis and
   * terminalization may proceed (VAL-SUB-092, VAL-SUB-112).
   *
   * Returns a map of descendantRunId → { latestSource, watermark, complete }.
   */
  async verifyWatermarks(
    companyId: string,
    rootRunId: string,
  ): Promise<Map<string, { latestSource: number; watermark: number; complete: boolean }>> {
    const schema = this.db.schema;
    const result = new Map<
      string,
      { latestSource: number; watermark: number; complete: boolean }
    >();

    // Get all descendants of this root.
    const descendants = await this.db.drizzle
      .select({
        id: schema.missionRuns.id,
        lastEventSequence: schema.missionRuns.lastEventSequence,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, companyId),
          eq(schema.missionRuns.rootRunId, rootRunId),
        ),
      );

    const watermarks = await this.getAllWatermarks(rootRunId);

    for (const desc of descendants) {
      if (desc.id === rootRunId) {continue;}
      const latest = Number(desc.lastEventSequence);
      const watermark = watermarks.get(desc.id) ?? 0;
      result.set(desc.id, {
        latestSource: latest,
        watermark,
        complete: watermark >= latest,
      });
    }

    return result;
  }
}
