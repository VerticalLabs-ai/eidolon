import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import http, { type IncomingMessage, type ClientRequest } from 'node:http';
import request from 'supertest';
import { sql, eq } from 'drizzle-orm';
import { createTestDb, createTestServer, closeTestServers } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

/** Start a run through the service and return its id + snapshot. */
async function startRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  key: string,
  text = 'Do work',
) {
  // Use deep_work mode. Deep Work now transitions draft→planning (5
  // initial events). These SSE tests need a quiet non-queued run with
  // a known initial event count; revert the planning transition to
  // preserve the original 4-event draft semantics.
  const service = new MissionStartService(db);
  const result = await service.start({
    companyId,
    projectId,
    idempotencyKey: key,
    body: { projectThreadId: threadId, mode: 'deep_work', request: { text } },
    actorType: 'user',
    actorId: 'dev-user-000',
  });
  await db.drizzle.execute(sql`
    DELETE FROM "run_events" WHERE "run_id" = ${result.run.id} AND "sequence" = 5
  `);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "status" = 'draft', "state_version" = 1,
      "last_event_sequence" = 4, "updated_at" = ${new Date()}
    WHERE "id" = ${result.run.id}
  `);
  return {
    ...result,
    run: { ...result.run, status: 'draft', stateVersion: 1, lastEventSequence: 4 },
  };
}

/**
 * Append `count` synthetic journal events to a run, simulating what a later
 * feature's command transaction would do. Locks the run row, computes
 * sequence = last_event_sequence + 1..+count, inserts the events, and
 * advances the run's last_event_sequence in one transaction.
 */
async function appendEvents(
  db: AnyDb,
  companyId: string,
  projectId: string,
  runId: string,
  count: number,
  payloadSize = 0,
): Promise<void> {
  const schema = db.schema;
  await db.drizzle.transaction(async (tx) => {
    const [run] = await tx
      .select({ lastEventSequence: schema.missionRuns.lastEventSequence })
      .from(schema.missionRuns)
      .where(sql`"id" = ${runId} AND "company_id" = ${companyId} AND "project_id" = ${projectId}`)
      .limit(1);
    if (!run) {
      throw new Error('appendEvents: run not found');
    }
    let seq = Number(run.lastEventSequence);
    const now = new Date();
    for (let i = 0; i < count; i++) {
      seq += 1;
      const payload: Record<string, unknown> = { n: i };
      if (payloadSize > 0) {
        payload.blob = 'x'.repeat(payloadSize);
      }
      await tx.insert(schema.runEvents).values({
        companyId,
        projectId,
        runId,
        sequence: seq,
        type: 'execution.progress',
        schemaVersion: 1,
        payload,
        actorType: 'system',
        actorId: null,
        traceId: null,
        occurredAt: now,
      });
    }
    await tx
      .update(schema.missionRuns)
      .set({ lastEventSequence: seq, updatedAt: now })
      .where(eq(schema.missionRuns.id, runId));
  });
}

/**
 * Append a terminal event and set the run to a terminal status in one
 * transaction, simulating what a later feature's terminalization would do.
 */
async function terminalizeRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  runId: string,
  status: 'completed' | 'failed' | 'cancelled' = 'completed',
): Promise<void> {
  const schema = db.schema;
  await db.drizzle.transaction(async (tx) => {
    const [run] = await tx
      .select({ lastEventSequence: schema.missionRuns.lastEventSequence })
      .from(schema.missionRuns)
      .where(sql`"id" = ${runId} AND "company_id" = ${companyId} AND "project_id" = ${projectId}`)
      .limit(1);
    if (!run) {
      throw new Error('terminalizeRun: run not found');
    }
    const seq = Number(run.lastEventSequence) + 1;
    const now = new Date();
    const eventType =
      status === 'completed'
        ? 'run.completed'
        : status === 'failed'
          ? 'run.failed'
          : 'run.cancelled';
    await tx.insert(schema.runEvents).values({
      companyId,
      projectId,
      runId,
      sequence: seq,
      type: eventType,
      schemaVersion: 1,
      payload: { status },
      actorType: 'system',
      actorId: null,
      traceId: null,
      occurredAt: now,
    });
    await tx
      .update(schema.missionRuns)
      .set({
        status,
        terminalAt: now,
        lastEventSequence: seq,
        stateVersion: sql`"state_version" + 1`,
        updatedAt: now,
      })
      .where(eq(schema.missionRuns.id, runId));
  });
}

// ---------------------------------------------------------------------------
// SSE client helpers
// ---------------------------------------------------------------------------

interface SseFrame {
  id: string | null;
  event: string | null;
  data: string | null;
}

interface SseConnection {
  req: ClientRequest;
  res: IncomingMessage;
  frames: SseFrame[];
  comments: string[];
  statusCode: number | undefined;
  headers: http.IncomingHttpHeaders;
  /** Resolves when the response stream ends (server closes). */
  ended: Promise<void>;
  close: () => void;
}

function parseSseFrame(raw: string): SseFrame {
  const frame: SseFrame = { id: null, event: null, data: null };
  for (const line of raw.split('\n')) {
    if (line.startsWith('id:')) {
      frame.id = line.slice(3).trim();
    } else if (line.startsWith('event:')) {
      frame.event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      frame.data = line.slice(5).trim();
    }
  }
  return frame;
}

function openSse(
  server: http.Server,
  path: string,
  options?: {
    after?: number;
    lastEventId?: number;
    headers?: Record<string, string>;
  },
): Promise<SseConnection> {
  const address = server.address() as { port: number };
  if (!address) {
    throw new Error('Server is not listening');
  }
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...options?.headers,
  };
  if (options?.lastEventId !== undefined) {
    headers['Last-Event-ID'] = String(options.lastEventId);
  }
  let query = '';
  if (options?.after !== undefined) {
    query = `?after=${options.after}`;
  }

  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: path + query,
        headers,
      },
      (res) => {
        const frames: SseFrame[] = [];
        const comments: string[] = [];
        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const raw = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (raw.startsWith(':')) {
              comments.push(raw);
            } else if (raw.trim()) {
              frames.push(parseSseFrame(raw));
            }
          }
        });

        const ended = new Promise<void>((resolveEnd) => {
          res.on('end', resolveEnd);
        });

        resolve({
          req,
          res,
          frames,
          comments,
          statusCode: res.statusCode,
          headers: res.headers,
          ended,
          close: () => {
            req.destroy();
          },
        });
      },
    );
    req.on('error', reject);
  });
}

/** Wait for a predicate to return a non-undefined value, polling at intervals. */
async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000, intervalMs = 10): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result !== undefined) {
      return result;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

const streamUrl = (companyId: string, projectId: string, runId: string) =>
  `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/stream`;

const eventsUrl = (companyId: string, projectId: string, runId: string) =>
  `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/events`;

// ---------------------------------------------------------------------------
// VAL-RUN-026: SSE frames are ordered and resumable
// ---------------------------------------------------------------------------

describe('Mission SSE frames are ordered and resumable (VAL-RUN-026)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
    vi.stubEnv('MISSION_SSE_POLL_MS', '50');
    vi.stubEnv('MISSION_SSE_HEARTBEAT_MS', '60000');
    app = await createTestServer(db);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ sse ordered', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'SSE Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'SSE Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(async () => {
    await closeTestServers();
    vi.unstubAllEnvs();
  });

  it('responds as text/event-stream with ordered, gap-free, unique frame IDs', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-ordered-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    const conn = await openSse(app, streamUrl(companyId, projectId, start.run.id));

    // Content-Type must be text/event-stream.
    expect(conn.headers['content-type']).toContain('text/event-stream');

    // Wait for all 10 frames to arrive.
    await waitFor(() => (conn.frames.length >= 10 ? true : undefined));

    const ids = conn.frames.map((f) => Number(f.id));
    // Frame IDs are run-local sequences 1..10, strictly increasing, no gaps.
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]).toBeGreaterThan(ids[i - 1]);
    }
    expect(new Set(ids).size).toBe(10);

    // Each frame has a meaningful event type and sanitized data.
    for (const frame of conn.frames) {
      expect(frame.event).toBeTruthy();
      expect(frame.data).toBeTruthy();
      const parsed = JSON.parse(frame.data!);
      expect(parsed.sequence).toBe(Number(frame.id));
      expect(parsed.type).toBe(frame.event);
      expect(typeof parsed.payload).toBe('object');
    }

    // First frame is the creation event.
    expect(conn.frames[0].event).toBe('run.created');

    conn.close();
  });

  it('rejects a cross-scope run id with 404 RUN_NOT_FOUND before SSE headers', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-xscope-001');

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ sse other', settings: { testFixture: true } })
      .expect(201);
    const otherCompanyId = otherCompany.body.data.id;
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other' })
      .expect(201);
    const otherProjectId = otherProject.body.data.id;

    const res = await request(app)
      .get(streamUrl(otherCompanyId, otherProjectId, start.run.id))
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('rejects a cursor ahead with 409 CURSOR_AHEAD before SSE headers', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-ahead-001');
    await appendEvents(db, companyId, projectId, start.run.id, 2); // 6 total

    const res = await request(app)
      .get(streamUrl(companyId, projectId, start.run.id))
      .query({ after: 999 })
      .expect(409);
    expect(res.body.code).toBe('CURSOR_AHEAD');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-027: SSE defaults to complete replay
// ---------------------------------------------------------------------------

describe('Mission SSE defaults to complete replay (VAL-RUN-027)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
    vi.stubEnv('MISSION_SSE_POLL_MS', '50');
    vi.stubEnv('MISSION_SSE_HEARTBEAT_MS', '60000');
    app = await createTestServer(db);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ sse default', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Default Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Default Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(async () => {
    await closeTestServers();
    vi.unstubAllEnvs();
  });

  it('replays from sequence zero when no after or Last-Event-ID is provided', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-default-001');
    // Start creates 4 events (sequences 1..4).
    const conn = await openSse(app, streamUrl(companyId, projectId, start.run.id));

    await waitFor(() => (conn.frames.length >= 4 ? true : undefined));

    const ids = conn.frames.map((f) => Number(f.id));
    expect(ids).toEqual([1, 2, 3, 4]);

    // Correlate with the JSON replay response.
    const jsonReplay = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 100 })
      .expect(200);
    const jsonSeqs = jsonReplay.body.data.events.map((e: { sequence: number }) => e.sequence);
    expect(jsonSeqs).toEqual([1, 2, 3, 4]);
    expect(ids).toEqual(jsonSeqs);

    conn.close();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-028: Explicit stream cursor wins
// ---------------------------------------------------------------------------

describe('Mission SSE explicit stream cursor wins (VAL-RUN-028)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
    vi.stubEnv('MISSION_SSE_POLL_MS', '50');
    vi.stubEnv('MISSION_SSE_HEARTBEAT_MS', '60000');
    app = await createTestServer(db);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ sse cursor', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Cursor Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Cursor Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(async () => {
    await closeTestServers();
    vi.unstubAllEnvs();
  });

  it('uses explicit after over a different Last-Event-ID', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-cursor-001');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    // after=4 wins over Last-Event-ID=2. Replay should start after 4 (sequences 5..10).
    const conn = await openSse(app, streamUrl(companyId, projectId, start.run.id), {
      after: 4,
      lastEventId: 2,
    });

    await waitFor(() => (conn.frames.length >= 6 ? true : undefined));

    const ids = conn.frames.map((f) => Number(f.id));
    // First frame ID must be 5 (strictly after the explicit after=4).
    expect(ids[0]).toBe(5);
    expect(ids).toEqual([5, 6, 7, 8, 9, 10]);

    // Correlate with the JSON event list after=4.
    const jsonReplay = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 4, limit: 100 })
      .expect(200);
    const jsonSeqs = jsonReplay.body.data.events.map((e: { sequence: number }) => e.sequence);
    expect(jsonSeqs).toEqual([5, 6, 7, 8, 9, 10]);
    expect(ids).toEqual(jsonSeqs);

    conn.close();
  });

  it('uses Last-Event-ID when no explicit after is provided', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-cursor-002');
    await appendEvents(db, companyId, projectId, start.run.id, 6); // 10 total

    // No after, Last-Event-ID=4. Replay should start after 4 (sequences 5..10).
    const conn = await openSse(app, streamUrl(companyId, projectId, start.run.id), {
      lastEventId: 4,
    });

    await waitFor(() => (conn.frames.length >= 6 ? true : undefined));

    const ids = conn.frames.map((f) => Number(f.id));
    expect(ids[0]).toBe(5);
    expect(ids).toEqual([5, 6, 7, 8, 9, 10]);

    conn.close();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-034: Terminal SSE closes cleanly
// ---------------------------------------------------------------------------

describe('Mission terminal SSE closes cleanly (VAL-RUN-034)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
    vi.stubEnv('MISSION_SSE_POLL_MS', '50');
    vi.stubEnv('MISSION_SSE_HEARTBEAT_MS', '60000');
    app = await createTestServer(db);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ sse terminal', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Terminal Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Terminal Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(async () => {
    await closeTestServers();
    vi.unstubAllEnvs();
  });

  it('sends terminal event, final comment, and closes gracefully', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-terminal-001');
    // Start creates 4 events. Open the stream first.
    const conn = await openSse(app, streamUrl(companyId, projectId, start.run.id));

    // Wait for the initial 4 replay frames.
    await waitFor(() => (conn.frames.length >= 4 ? true : undefined));
    expect(conn.frames.map((f) => Number(f.id))).toEqual([1, 2, 3, 4]);

    // Terminalize: appends run.completed (seq 5) and sets status=completed.
    await terminalizeRun(db, companyId, projectId, start.run.id, 'completed');

    // Wait for the terminal event frame and connection close.
    await waitFor(() => (conn.frames.length >= 5 ? true : undefined));
    await waitFor(() => (conn.res.destroyed ? true : undefined), 5000);

    // The terminal event (run.completed) is the last frame.
    const lastFrame = conn.frames[conn.frames.length - 1];
    expect(lastFrame.event).toBe('run.completed');
    expect(Number(lastFrame.id)).toBe(5);

    // A final comment/heartbeat was sent before close.
    expect(conn.comments.length).toBeGreaterThan(0);

    // The response stream ended (graceful close).
    expect(conn.res.destroyed).toBe(true);

    // JSON replay proves the terminal event is last.
    const replay = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 100 })
      .expect(200);
    const replayEvents = replay.body.data.events as { sequence: number; type: string }[];
    expect(replayEvents[replayEvents.length - 1].type).toBe('run.completed');
    expect(replayEvents[replayEvents.length - 1].sequence).toBe(5);
  });

  it('closes immediately when the run is already terminal at connection time', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-terminal-pre-001');
    await terminalizeRun(db, companyId, projectId, start.run.id, 'completed');

    const conn = await openSse(app, streamUrl(companyId, projectId, start.run.id));

    // All 5 events (4 creation + 1 terminal) are replayed, then the stream closes.
    await waitFor(() => (conn.frames.length >= 5 ? true : undefined));
    await waitFor(() => (conn.res.destroyed ? true : undefined), 5000);

    expect(conn.frames.map((f) => Number(f.id))).toEqual([1, 2, 3, 4, 5]);
    expect(conn.frames[4].event).toBe('run.completed');
    expect(conn.res.destroyed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-080: API restart supports stream replay
// ---------------------------------------------------------------------------

describe('Mission API restart supports stream replay (VAL-RUN-080)', () => {
  let db: AnyDb;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
    vi.stubEnv('MISSION_SSE_POLL_MS', '50');
    vi.stubEnv('MISSION_SSE_HEARTBEAT_MS', '60000');
    const company = await request(await createTestServer(db))
      .post('/api/companies')
      .send({ name: '__mtest__ sse restart', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(await createTestServer(db))
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Restart Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(await createTestServer(db))
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Restart Thread' })
      .expect(201);
    threadId = thread.body.data.id;
    await closeTestServers();
  });

  afterEach(async () => {
    await closeTestServers();
    vi.unstubAllEnvs();
  });

  it('reconnects after server restart and replays subsequent events exactly once', async () => {
    // Phase 1: Start a run on server A, observe some frames.
    const serverA = await createTestServer(db);
    const start = await startRun(db, companyId, projectId, threadId, 'sse-restart-001');
    await appendEvents(db, companyId, projectId, start.run.id, 2); // 6 total

    const connA = await openSse(serverA, streamUrl(companyId, projectId, start.run.id));
    await waitFor(() => (connA.frames.length >= 6 ? true : undefined));
    const lastProcessedId = Number(connA.frames[connA.frames.length - 1].id);
    expect(lastProcessedId).toBe(6);

    // Simulate API restart: close server A, open server B on a new port.
    await closeTestServers();
    const serverB = await createTestServer(db);

    // While the server was "down", more events were committed.
    await appendEvents(db, companyId, projectId, start.run.id, 3); // 9 total

    // Phase 2: Reconnect from the last fully processed event ID.
    const connB = await openSse(serverB, streamUrl(companyId, projectId, start.run.id), {
      lastEventId: lastProcessedId,
    });

    // Wait for the 3 new events (sequences 7, 8, 9) to arrive.
    await waitFor(() => (connB.frames.length >= 3 ? true : undefined));

    const ids = connB.frames.map((f) => Number(f.id));
    expect(ids).toEqual([7, 8, 9]);

    // No duplicates: the reconnected stream starts strictly after 6.
    for (const id of ids) {
      expect(id).toBeGreaterThan(lastProcessedId);
    }

    // JSON replay comparison: all events 7..9 match.
    const jsonReplay = await request(serverB)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: lastProcessedId, limit: 100 })
      .expect(200);
    const jsonSeqs = jsonReplay.body.data.events.map((e: { sequence: number }) => e.sequence);
    expect(jsonSeqs).toEqual([7, 8, 9]);
    expect(ids).toEqual(jsonSeqs);

    connA.close();
    connB.close();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-104: SSE sends idle heartbeats
// ---------------------------------------------------------------------------

describe('Mission SSE sends idle heartbeats (VAL-RUN-104)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
    vi.stubEnv('MISSION_SSE_POLL_MS', '50');
    // Short heartbeat for testing (default is 15000ms).
    vi.stubEnv('MISSION_SSE_HEARTBEAT_MS', '100');
    app = await createTestServer(db);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ sse heartbeat', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Heartbeat Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Heartbeat Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(async () => {
    await closeTestServers();
    vi.unstubAllEnvs();
  });

  it('sends comment heartbeats at idle intervals without creating journal events', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-heartbeat-001');
    // Start creates 4 events. The run stays nonterminal (draft).
    const conn = await openSse(app, streamUrl(companyId, projectId, start.run.id));

    // Wait for the 4 replay frames.
    await waitFor(() => (conn.frames.length >= 4 ? true : undefined));
    const frameCountAfterReplay = conn.frames.length;

    // Wait for at least 2 heartbeats (comments).
    await waitFor(() => (conn.comments.length >= 2 ? true : undefined), 5000);

    // Heartbeats are SSE comments (lines starting with ':').
    for (const comment of conn.comments) {
      expect(comment.startsWith(':')).toBe(true);
    }
    expect(conn.comments.length).toBeGreaterThanOrEqual(2);

    // No new event frames arrived during idle (only heartbeats).
    expect(conn.frames.length).toBe(frameCountAfterReplay);

    // JSON replay proves heartbeats did not become run events.
    const replay = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 100 })
      .expect(200);
    expect(replay.body.data.events).toHaveLength(4);
    expect(replay.body.data.latestSequence).toBe(4);

    conn.close();
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-105: Slow stream client recovers losslessly
// ---------------------------------------------------------------------------

describe('Mission slow stream client recovers losslessly (VAL-RUN-105)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
  });

  beforeEach(async () => {
    enableMissionFlag();
    vi.stubEnv('MISSION_SSE_POLL_MS', '20');
    vi.stubEnv('MISSION_SSE_HEARTBEAT_MS', '60000');
    // Lower the buffer threshold for testing (default is 1 MiB).
    vi.stubEnv('MISSION_SSE_MAX_BUFFER_BYTES', '65536');
    app = await createTestServer(db);
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ sse slow', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Slow Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Slow Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(async () => {
    await closeTestServers();
    vi.unstubAllEnvs();
  });

  it('disconnects a throttled reader and reconnect recovers every later event', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'sse-slow-001');
    // Generate a large volume of events with substantial payloads to fill
    // the server's write buffer beyond the threshold. On localhost, OS
    // socket buffers absorb ~860KB before backpressure occurs (verified
    // empirically). 500 events × 8KB = ~4MB of SSE frames, well beyond
    // the OS buffer capacity.
    const eventCount = 500;
    const payloadSize = 8192; // 8KB per event → ~4MB of SSE frames
    await appendEvents(db, companyId, projectId, start.run.id, eventCount, payloadSize);
    const totalEvents = eventCount + 4; // 4 creation + 500 appended

    // Open an SSE connection and immediately pause the response stream.
    // This stops Node.js from reading from the socket, causing the OS
    // receive buffer to fill up. The server's write buffer grows as it
    // writes events that the client never reads. Once buffered output
    // exceeds the threshold, the server disconnects.
    const conn = await openSse(app, streamUrl(companyId, projectId, start.run.id));
    conn.res.pause();

    // Wait for the server to detect backpressure and end the response.
    // The server writes events in a tight loop; backpressure occurs after
    // ~96KB of data (writableLength exceeds the 64KB threshold). Give the
    // server a few seconds to write events, detect the slow client, and
    // call res.end().
    await new Promise((r) => setTimeout(r, 2000));

    // Resume reading. If the server has ended the response (detected the
    // slow client and disconnected), the 'end' event fires immediately
    // after resume. If the server is still streaming, the 'end' event
    // does not fire within the timeout.
    const serverEndedResponse = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        conn.res.removeListener('end', onEnd);
        resolve(false);
      }, 2000);
      const onEnd = () => {
        clearTimeout(timer);
        resolve(true);
      };
      conn.res.once('end', onEnd);
      conn.res.resume();
    });

    conn.close();

    // Verify all events are recovered via the JSON replay endpoint
    // (lossless recovery after slow-client disconnect).
    const replay = await request(app)
      .get(eventsUrl(companyId, projectId, start.run.id))
      .query({ after: 0, limit: 100 })
      .expect(200);
    expect(replay.body.data.events).toHaveLength(100);
    expect(replay.body.data.nextCursor).toBe(100);
    expect(replay.body.data.latestSequence).toBe(totalEvents);

    // Page through the rest to verify complete coverage.
    let cursor = 100;
    const allSeqs: number[] = [
      ...replay.body.data.events.map((e: { sequence: number }) => e.sequence),
    ];
    while (true) {
      const page = await request(app)
        .get(eventsUrl(companyId, projectId, start.run.id))
        .query({ after: cursor, limit: 100 })
        .expect(200);
      const pageEvents = page.body.data.events as { sequence: number }[];
      if (pageEvents.length === 0) {
        break;
      }
      allSeqs.push(...pageEvents.map((e) => e.sequence));
      cursor = page.body.data.nextCursor;
    }

    // Every sequence 1..totalEvents is present exactly once (lossless).
    expect(allSeqs).toEqual(Array.from({ length: totalEvents }, (_, i) => i + 1));
    expect(new Set(allSeqs).size).toBe(totalEvents);

    // The server detected the slow client and ended the response.
    expect(serverEndedResponse).toBe(true);
  });
});
