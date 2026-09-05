import { and, asc, eq, gt } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import { sanitizeEventPayload } from './sanitize.js';
import type { DbInstance } from '../../types.js';

/**
 * Mission journal JSON replay.
 *
 * Postgres is the system of record; `run_events` is the append-only ordered
 * journal. This service reconstructs a bounded, strictly-ordered page of
 * committed events for tests and recovery. It is a read-only projection of
 * the journal and never advances run state.
 *
 * Cursor semantics:
 * - `after` is a run-local sequence number (default 0 for a complete replay).
 * - The page returns events with `sequence > after`, ordered ascending.
 * - `nextCursor` is the highest sequence in the page, or `after` when the
 *   page is empty (caught up). A client follows cursors until an empty page;
 *   that empty page is the stop signal, so `nextCursor` is always present
 *   and stable for recovery/resume.
 * - `after == latest` is valid and yields an empty page (caught up).
 * - `after > latest` is an impossible cursor and is rejected with
 *   `409 CURSOR_AHEAD` rather than hanging or silently skipping history.
 *
 * Reads are company-scoped first, then project-validated at the route layer.
 * Cross-scope identifiers return 404 without revealing existence.
 */

/** A sanitized, bounded replay event envelope. */
export interface ReplayEvent {
  sequence: number;
  type: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
  commandId: string | null;
  actorType: string | null;
  actorId: string | null;
  traceId: string | null;
  occurredAt: string;
}

export interface ReplayInput {
  companyId: string;
  projectId: string;
  runId: string;
  /** Inclusive lower-bound cursor; default 0 (complete replay from creation). */
  after: number;
  /** Page size, 1-1000. */
  limit: number;
}

export interface ReplayResult {
  events: ReplayEvent[];
  /** Highest sequence in the page, or `after` when empty. Stable resume point. */
  nextCursor: number;
  /** The run's current `last_event_sequence`. */
  latestSequence: number;
}

export class MissionReplayService {
  constructor(private db: DbInstance) {}

  async replay(input: ReplayInput): Promise<ReplayResult> {
    const { companyId, projectId, runId, after, limit } = input;
    const schema = this.db.schema;

    // 1. Scope check: the run must exist in this company/project. A missing
    //    or cross-scope id is a non-enumerating 404.
    const [run] = await this.db.drizzle
      .select({ lastEventSequence: schema.missionRuns.lastEventSequence })
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

    const latestSequence = Number(run.lastEventSequence);

    // 2. Cursor-ahead guard. Phase 1 does not prune the journal, so there is
    //    no normal cursor-expired case: a cursor beyond the latest committed
    //    sequence is impossible and is rejected rather than silently skipped.
    //    `after == latest` is the caught-up case (empty page), not an error.
    if (after > latestSequence) {
      throw new AppError(
        409,
        'CURSOR_AHEAD',
        'Event cursor is ahead of the latest committed sequence',
      );
    }

    // 3. Bounded page: events strictly after the cursor, ordered ascending.
    const rows = await this.db.drizzle
      .select({
        sequence: schema.runEvents.sequence,
        type: schema.runEvents.type,
        schemaVersion: schema.runEvents.schemaVersion,
        payload: schema.runEvents.payload,
        commandId: schema.runEvents.commandId,
        actorType: schema.runEvents.actorType,
        actorId: schema.runEvents.actorId,
        traceId: schema.runEvents.traceId,
        occurredAt: schema.runEvents.occurredAt,
      })
      .from(schema.runEvents)
      .where(
        and(
          eq(schema.runEvents.runId, runId),
          eq(schema.runEvents.companyId, companyId),
          eq(schema.runEvents.projectId, projectId),
          gt(schema.runEvents.sequence, after),
        ),
      )
      .orderBy(asc(schema.runEvents.sequence))
      .limit(limit);

    const events: ReplayEvent[] = rows.map((r) => ({
      sequence: Number(r.sequence),
      type: r.type,
      schemaVersion: r.schemaVersion,
      // Sanitize the payload to ensure no credentials, prompts, provider
      // bodies, retrieved content, or raw diagnostics leak through the
      // JSON replay surface (VAL-RUN-073).
      payload: sanitizeEventPayload(r.payload) as Record<string, unknown>,
      commandId: r.commandId,
      actorType: r.actorType,
      actorId: r.actorId,
      traceId: r.traceId,
      occurredAt: r.occurredAt.toISOString(),
    }));

    // 4. nextCursor is the highest sequence in the page, or the cursor
    //    itself when empty. This is a stable resume point: a client follows
    //    cursors until it receives an empty page, which means it is caught
    //    up to `latestSequence`. The cursor never skips or duplicates events.
    const nextCursor = events.length > 0 ? events[events.length - 1].sequence : after;

    return { events, nextCursor, latestSequence };
  }
}
