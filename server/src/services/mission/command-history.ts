import { and, asc, eq, gt, or } from 'drizzle-orm';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import { decodeCursor, encodeCursor } from './snapshot.js';

/**
 * Mission command history: scoped, bounded, restart-stable reads of the
 * immutable `run_commands` ledger.
 *
 * The declared `GET .../commands?limit=&cursor=` route returns at most 100
 * command summaries ordered by `(createdAt ASC, id ASC)` with opaque keyset
 * cursors, request hash, actor/result metadata, and redacted payload access
 * by permission (VAL-RUN-075).
 *
 * Domain-rejected commands (stale, invalid-state, idempotency-conflict) are
 * stored as `status='rejected'` rows and remain visible here without
 * changing any state, event, budget, or output. Middleware 401/403 attempts
 * never create a user-readable command row.
 */

/** A bounded command summary for the history endpoint. */
export interface CommandHistoryEntry {
  id: string;
  type: string;
  idempotencyKey: string;
  requestHash: string;
  status: string;
  resultStatusCode: number;
  errorCode: string | null;
  actorType: string;
  actorId: string | null;
  createdAt: string;
  appliedAt: string | null;
  /** The command payload, or null when redacted by permission. */
  payload: Record<string, unknown> | null;
}

export interface CommandHistoryResult {
  commands: CommandHistoryEntry[];
  nextCursor: string | null;
}

export interface CommandHistoryInput {
  companyId: string;
  projectId: string;
  runId: string;
  limit: number;
  cursor?: string;
  /** When false, payloads are redacted (null) for viewers. */
  includePayload: boolean;
}

export class MissionCommandHistoryService {
  constructor(private db: DbInstance) {}

  /**
   * List command summaries for a run, scoped to the given company/project.
   * Returns at most `limit` entries ordered by `(createdAt ASC, id ASC)`
   * with an opaque keyset cursor for the next page. Throws 404
   * RUN_NOT_FOUND for an absent or cross-scope run id.
   */
  async listCommands(input: CommandHistoryInput): Promise<CommandHistoryResult> {
    const { companyId, projectId, runId, limit, cursor, includePayload } = input;
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

    // 2. Build the keyset query.
    const anchor = decodeCursor(cursor);
    const fetchLimit = limit + 1;

    const conditions = [
      eq(schema.runCommands.companyId, companyId),
      eq(schema.runCommands.projectId, projectId),
      eq(schema.runCommands.runId, runId),
    ];
    if (anchor) {
      // Keyset: rows strictly after the anchor in (createdAt ASC, id ASC).
      const cursorCondition = or(
        gt(schema.runCommands.createdAt, new Date(anchor.createdAt)),
        and(
          eq(schema.runCommands.createdAt, new Date(anchor.createdAt)),
          gt(schema.runCommands.id, anchor.id),
        ),
      );
      conditions.push(cursorCondition!);
    }

    const rows = await this.db.drizzle
      .select({
        id: schema.runCommands.id,
        type: schema.runCommands.type,
        idempotencyKey: schema.runCommands.idempotencyKey,
        requestHash: schema.runCommands.requestHash,
        status: schema.runCommands.status,
        resultStatusCode: schema.runCommands.resultStatusCode,
        errorCode: schema.runCommands.errorCode,
        actorType: schema.runCommands.actorType,
        actorId: schema.runCommands.actorId,
        payload: schema.runCommands.payload,
        createdAt: schema.runCommands.createdAt,
        appliedAt: schema.runCommands.appliedAt,
      })
      .from(schema.runCommands)
      .where(and(...conditions))
      .orderBy(asc(schema.runCommands.createdAt), asc(schema.runCommands.id))
      .limit(fetchLimit);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const commands: CommandHistoryEntry[] = page.map((r) => ({
      id: r.id,
      type: r.type,
      idempotencyKey: r.idempotencyKey,
      requestHash: r.requestHash,
      status: r.status,
      resultStatusCode: r.resultStatusCode ?? 0,
      errorCode: r.errorCode,
      actorType: r.actorType,
      actorId: r.actorId,
      payload: includePayload ? r.payload : null,
      createdAt: r.createdAt.toISOString(),
      appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
    }));

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1];
      nextCursor = encodeCursor(last.createdAt, last.id);
    }

    return { commands, nextCursor };
  }
}
