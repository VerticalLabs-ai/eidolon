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

/** Whether a run status is terminal (immutable). */
function isTerminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

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
      if (desc.id === rootRunId) {
        continue;
      }
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

  /**
   * Ensure all relevant terminal descendant source events have been mirrored
   * to the root journal before root synthesis/terminalization closes the run
   * (VAL-SUB-112).
   *
   * For each terminal descendant, this fills any mirror gap between the
   * per-descendant watermark and the descendant's latest source sequence by
   * reading the authoritative local descendant events and mirroring them.
   * Projection repair may fill gaps before terminalization; root close emits
   * final mirrors first and then closes with no later descendant mirror.
   *
   * Nonterminal descendants are not "relevant terminal watermarks": they are
   * reported as incomplete so the caller does not close the root while
   * descendants are still active. (Composite root close is gated by the
   * synthesis module; this method provides the mirror-completion guarantee.)
   *
   * Must be called inside a locked transaction where the root run row is
   * already locked via `FOR UPDATE` (so no concurrent terminalization can
   * interleave). Each filled mirror uses {@link mirrorDescendantEvent} and
   * therefore inherits uniqueness, de-cycling, and no-post-terminal behavior.
   *
   * Returns `{ complete, filled }`:
   *  - `complete` is true only when every descendant is terminal AND fully
   *    mirrored up to its latest source sequence.
   *  - `filled` is the number of mirror gaps closed in this call.
   */
  async ensureMirrorsCompleteBeforeTerminal(
    tx: Tx,
    input: {
      companyId: string;
      projectId: string;
      rootRunId: string;
      actorType?: 'user' | 'agent' | 'system';
      actorId?: string | null;
      traceId?: string | null;
    },
  ): Promise<{ complete: boolean; filled: number }> {
    const schema = this.db.schema;
    const actorType = input.actorType ?? 'system';
    const actorId = input.actorId ?? null;
    const traceId = input.traceId ?? null;

    // Read the root under the caller's lock to confirm it is not already
    // terminal (no post-terminal mirror is legal).
    const [rootRun] = await tx
      .select({ status: schema.missionRuns.status })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, input.companyId),
          eq(schema.missionRuns.id, input.rootRunId),
        ),
      )
      .limit(1);

    if (!rootRun) {
      return { complete: false, filled: 0 };
    }
    if (isTerminalStatus(rootRun.status)) {
      // Root already terminal: no post-terminal mirror. Nothing to fill.
      return { complete: true, filled: 0 };
    }

    // Gather all descendants of this root (excluding the root itself).
    const descendants = await tx
      .select({
        id: schema.missionRuns.id,
        status: schema.missionRuns.status,
        lastEventSequence: schema.missionRuns.lastEventSequence,
      })
      .from(schema.missionRuns)
      .where(
        and(
          eq(schema.missionRuns.companyId, input.companyId),
          eq(schema.missionRuns.rootRunId, input.rootRunId),
        ),
      )
      .for('update');

    const watermarks = await this.getAllWatermarks(input.rootRunId);
    let filled = 0;
    let allTerminalAndComplete = true;

    for (const desc of descendants) {
      if (desc.id === input.rootRunId) {
        continue;
      }
      const latest = Number(desc.lastEventSequence);
      const watermark = watermarks.get(desc.id) ?? 0;

      if (!isTerminalStatus(desc.status)) {
        // A nonterminal descendant means the root must not close yet.
        allTerminalAndComplete = false;
        continue;
      }
      if (watermark >= latest) {
        continue; // already fully mirrored
      }
      filled += await this.fillDescendantMirrorGaps(
        tx,
        {
          companyId: input.companyId,
          projectId: input.projectId,
          rootRunId: input.rootRunId,
          actorType,
          actorId,
          traceId,
        },
        desc.id,
        watermark,
      );
    }

    // Re-verify completeness after filling, reading within this transaction
    // so uncommitted mirrors are visible (an outer-connection read would not
    // see rows inserted in `tx`).
    const finalWatermarks = await this.readWatermarksTx(tx, input.rootRunId);
    for (const desc of descendants) {
      if (desc.id === input.rootRunId) {
        continue;
      }
      if (!isTerminalStatus(desc.status)) {
        allTerminalAndComplete = false;
        continue;
      }
      const latest = Number(desc.lastEventSequence);
      const watermark = finalWatermarks.get(desc.id) ?? 0;
      if (watermark < latest) {
        allTerminalAndComplete = false;
      }
    }

    return { complete: allTerminalAndComplete, filled };
  }

  /**
   * Read and mirror the authoritative local descendant source events above
   * the current watermark, in source-sequence order. Returns the number of
   * new mirrors created.
   */
  private async fillDescendantMirrorGaps(
    tx: Tx,
    input: {
      companyId: string;
      projectId: string;
      rootRunId: string;
      actorType: 'user' | 'agent' | 'system';
      actorId: string | null;
      traceId: string | null;
    },
    descendantRunId: string,
    watermark: number,
  ): Promise<number> {
    const schema = this.db.schema;
    const missingRows = await tx
      .select({
        sequence: schema.runEvents.sequence,
        type: schema.runEvents.type,
        payload: schema.runEvents.payload,
        actorType: schema.runEvents.actorType,
        actorId: schema.runEvents.actorId,
        traceId: schema.runEvents.traceId,
      })
      .from(schema.runEvents)
      .where(
        and(
          eq(schema.runEvents.companyId, input.companyId),
          eq(schema.runEvents.runId, descendantRunId),
        ),
      )
      .orderBy(schema.runEvents.sequence);

    let filled = 0;
    for (const ev of missingRows) {
      const srcSeq = Number(ev.sequence);
      if (srcSeq <= watermark) {
        continue; // already mirrored below the watermark
      }
      const result = await this.mirrorDescendantEvent(tx, {
        companyId: input.companyId,
        projectId: input.projectId,
        rootRunId: input.rootRunId,
        descendantRunId,
        sourceSequence: srcSeq,
        sourceEventType: ev.type,
        sourcePayload: ev.payload as Record<string, unknown>,
        actorType: (ev.actorType as 'user' | 'agent' | 'system' | null) ?? input.actorType,
        actorId: ev.actorId ?? input.actorId,
        traceId: ev.traceId ?? input.traceId,
      });
      if (result.created) {
        filled += 1;
      }
    }
    return filled;
  }

  /**
   * Read per-descendant watermarks within a transaction (so uncommitted
   * mirror rows inserted in `tx` are visible).
   */
  private async readWatermarksTx(tx: Tx, rootRunId: string): Promise<Map<string, number>> {
    const schema = this.db.schema;
    const rows = await tx
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
}
