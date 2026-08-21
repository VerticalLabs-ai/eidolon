import { and, eq, gt, asc } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';

/**
 * Mission SSE stream service.
 *
 * Implements authenticated, resumable Server-Sent Events over the durable
 * `run_events` journal. Postgres is the system of record; this service is a
 * read-only projection that replays committed events by run-local sequence
 * and then tails the journal for live delivery.
 *
 * SSE rules (from architecture.md):
 * - `after` and `Last-Event-ID` are run-local sequence numbers; explicit
 *   `after` wins. Default is 0 for a complete initial replay.
 * - Each frame is `id: <sequence>`, `event: <type>`, and
 *   `data: <sanitized event envelope>`.
 * - The API queries `sequence > cursor ORDER BY sequence`, emits every
 *   committed event exactly once per connection, then tails. A Postgres
 *   notification may wake the loop, but every wake re-queries the journal.
 * - Send a comment heartbeat every 15 seconds. Reconnect uses the last
 *   completely processed ID.
 * - Validate scope/cursor before sending SSE headers. A cursor greater
 *   than the latest sequence returns `409 CURSOR_AHEAD`.
 * - Slow clients are disconnected when buffered output exceeds 1 MiB;
 *   reconnect/replay supplies lossless recovery.
 * - A terminal event is followed by a final heartbeat/comment and
 *   graceful close.
 *
 * Reads do NOT require the mission feature flag (consistent with snapshot
 * and replay GET endpoints), matching the kill-switch contract that existing
 * runs stay visible/stoppable.
 */

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/** Page size for each journal poll query. */
const POLL_LIMIT = 100;

export interface StreamInput {
  companyId: string;
  projectId: string;
  runId: string;
  /** Explicit `after` query param; wins over Last-Event-ID. null = absent. */
  after: number | null;
  /** Last-Event-ID header value. null = absent. */
  lastEventId: number | null;
  /**
   * Optional periodic access re-check. When provided, the stream service
   * calls this at each poll interval and gracefully closes the SSE
   * connection if it returns `false`. This enables live revocation: a
   * role downgrade or membership removal invalidates an open SSE
   * connection within the poll interval (VAL-CROSS-088).
   */
  accessChecker?: () => Promise<boolean>;
}

export class MissionStreamService {
  private readonly heartbeatMs: number;
  private readonly pollMs: number;
  private readonly maxBufferBytes: number;

  constructor(private db: DbInstance) {
    this.heartbeatMs = Number(process.env.MISSION_SSE_HEARTBEAT_MS) || 15_000;
    this.pollMs = Number(process.env.MISSION_SSE_POLL_MS) || 1_000;
    this.maxBufferBytes = Number(process.env.MISSION_SSE_MAX_BUFFER_BYTES) || 1_048_576; // 1 MiB
  }

  /**
   * Open an SSE stream: validate scope/cursor, replay committed events,
   * then tail the journal with heartbeats until terminal close or client
   * disconnect. All validation happens BEFORE SSE headers are sent so
   * errors (404, 409) are regular JSON responses.
   */
  async stream(input: StreamInput, req: Request, res: Response): Promise<void> {
    const { companyId, projectId, runId } = input;
    const schema = this.db.schema;

    // 1. Resolve cursor: explicit `after` wins, then Last-Event-ID, then 0.
    const cursor = input.after ?? input.lastEventId ?? 0;

    // 2. Scope check + latest sequence (before sending SSE headers).
    const [run] = await this.db.drizzle
      .select({
        lastEventSequence: schema.missionRuns.lastEventSequence,
        status: schema.missionRuns.status,
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

    const latestSequence = Number(run.lastEventSequence);

    // 3. Cursor-ahead guard (before SSE headers). Phase 1 does not prune,
    //    so a cursor beyond the latest committed sequence is impossible.
    if (cursor > latestSequence) {
      throw new AppError(
        409,
        'CURSOR_AHEAD',
        'Event cursor is ahead of the latest committed sequence',
      );
    }

    // 4. Set SSE headers and flush them immediately.
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // 5. Connection state tracking.
    let closed = false;
    let lastSentSequence = cursor;
    let bytesWrittenSinceDrain = 0;
    let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      closed = true;
      if (heartbeatTimer) {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    // Client disconnect detection.
    req.on('close', cleanup);
    res.on('close', cleanup);

    // Track buffered output: when the OS can't drain the internal write
    // buffer (client is slow), the 'drain' event stops firing and
    // bytesWrittenSinceDrain grows. This is a more reliable slow-client
    // signal than writableLength alone, which stays 0 on localhost when
    // the OS send buffer auto-tunes to several MB.
    res.on('drain', () => {
      bytesWrittenSinceDrain = 0;
    });

    // 6. Write a single SSE frame for a committed event. Combines all
    //    parts into one res.write() call so the return value (backpressure
    //    signal) and byte count are accurate.
    const writeFrame = (row: {
      sequence: number;
      type: string;
      schemaVersion: number;
      payload: Record<string, unknown>;
      commandId: string | null;
      actorType: string | null;
      actorId: string | null;
      traceId: string | null;
      occurredAt: string;
    }): void => {
      const data = JSON.stringify({
        sequence: row.sequence,
        type: row.type,
        schemaVersion: row.schemaVersion,
        payload: row.payload,
        commandId: row.commandId,
        actorType: row.actorType,
        actorId: row.actorId,
        traceId: row.traceId,
        occurredAt: row.occurredAt,
      });
      const frame = `id: ${row.sequence}\nevent: ${row.type}\ndata: ${data}\n\n`;
      const frameBytes = Buffer.byteLength(frame, 'utf8');
      // res.write() returns false when the internal buffer is above the
      // high-water mark (backpressure). Track bytes written while
      // backpressured; reset on 'drain' when the OS accepts the data.
      const ok = res.write(frame);
      if (!ok) {
        bytesWrittenSinceDrain += frameBytes;
      }
      lastSentSequence = row.sequence;
    };

    // 7. Write a comment heartbeat (liveness signal, not a journal event).
    const writeHeartbeat = (): void => {
      if (!closed && !res.writableEnded) {
        res.write(': heartbeat\n\n');
      }
    };

    // 8. Check if the client is too slow. Uses two signals:
    //    a) writableLength: the internal write buffer that hasn't been
    //       flushed to the OS. Grows when the OS send buffer is full.
    //    b) bytesWrittenSinceDrain: total bytes written since the last
    //       'drain' event. Grows when the OS can't accept more data
    //       (send buffer full, client not reading). On localhost with
    //       a small send buffer (set via MISSION_SSE_SEND_BUFFER_BYTES),
    //       this grows quickly when the client pauses reading.
    const isSlowClient = (): boolean => {
      const socket = res.socket;
      if (socket && socket.writableLength > this.maxBufferBytes) {
        return true;
      }
      if (bytesWrittenSinceDrain > this.maxBufferBytes) {
        return true;
      }
      return false;
    };

    // 9. Query and send all events with sequence > lastSentSequence.
    //    Loops through pages until caught up. Returns false if the
    //    connection was closed or the client is slow (buffer overflow).
    const sendNewEvents = async (): Promise<boolean> => {
      if (closed) {
        return false;
      }

      // Loop through pages so the initial replay sends every committed
      // event in one burst. This also ensures slow-client detection sees
      // accumulated backpressure rather than draining between polls.
      while (!closed) {
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
              gt(schema.runEvents.sequence, lastSentSequence),
            ),
          )
          .orderBy(asc(schema.runEvents.sequence))
          .limit(POLL_LIMIT);

        if (rows.length === 0) {
          break;
        }

        for (const row of rows) {
          if (closed) {
            return false;
          }
          writeFrame({
            sequence: Number(row.sequence),
            type: row.type,
            schemaVersion: row.schemaVersion,
            payload: row.payload,
            commandId: row.commandId,
            actorType: row.actorType,
            actorId: row.actorId,
            traceId: row.traceId,
            occurredAt: row.occurredAt.toISOString(),
          });
          if (isSlowClient()) {
            // Slow client: buffered output exceeds threshold. Disconnect.
            return false;
          }
        }
      }

      return true;
    };

    // 10. Check if the run has reached a terminal state.
    const checkTerminal = async (): Promise<boolean> => {
      const [r] = await this.db.drizzle
        .select({ status: schema.missionRuns.status })
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, runId))
        .limit(1);
      return r ? TERMINAL_STATUSES.has(r.status) : false;
    };

    // 11. Graceful close: send a final comment and end the response.
    const gracefulClose = (): void => {
      if (closed) {
        return;
      }
      writeHeartbeat(); // final comment before close
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
    };

    // 12. Initial replay of all committed events > cursor.
    const ok = await sendNewEvents();
    if (!ok) {
      // Slow client during replay or client disconnected.
      cleanup();
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    // Check if the run is already terminal after replay.
    const isTerminal = await checkTerminal();
    if (isTerminal) {
      gracefulClose();
      return;
    }

    // 13. Live tail: poll the journal for new events at intervals.
    const poll = async (): Promise<void> => {
      if (closed) {
        return;
      }

      // Live revocation re-check: if the access checker returns false,
      // the user's membership or role has been revoked/downgraded since
      // the connection opened. Gracefully close the SSE stream so the
      // client reconnects and hits the fresh permission check
      // (VAL-CROSS-088).
      if (input.accessChecker) {
        try {
          const hasAccess = await input.accessChecker();
          if (!hasAccess) {
            cleanup();
            if (!res.writableEnded) {
              res.end();
            }
            return;
          }
        } catch {
          // On error, fail closed: close the connection.
          cleanup();
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }
      }

      const ok = await sendNewEvents();
      if (!ok) {
        // Slow client or client disconnect.
        cleanup();
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      const terminal = await checkTerminal();
      if (terminal) {
        gracefulClose();
        return;
      }

      if (!closed) {
        pollTimer = setTimeout(poll, this.pollMs);
      }
    };

    // 14. Heartbeat loop: send a comment at idle intervals.
    const heartbeat = (): void => {
      if (closed) {
        return;
      }
      writeHeartbeat();
      if (!closed) {
        heartbeatTimer = setTimeout(heartbeat, this.heartbeatMs);
      }
    };

    // Start the poll and heartbeat loops.
    pollTimer = setTimeout(poll, this.pollMs);
    heartbeatTimer = setTimeout(heartbeat, this.heartbeatMs);
  }
}
