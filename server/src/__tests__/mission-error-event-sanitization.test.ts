import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';
import { missionErrorSanitizer } from '../middleware/mission-error-sanitizer.js';
import { errorHandler, AppError } from '../middleware/error-handler.js';
import {
  sanitizeString,
  sanitizeEventPayload,
  toSafeMissionError,
} from '../services/mission/sanitize.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

// ---------------------------------------------------------------------------
// Seeded sensitive canary markers — these strings are injected into events
// and errors to simulate leakage of credentials, prompts, provider bodies,
// retrieved content, and raw diagnostics. The sanitization layer must scrub
// them before they reach any user-visible API, replay, or SSE surface.
//
// Values use CANARY_PLACEHOLDER patterns (not real-looking secrets) to avoid
// tripping static secret scanners. The sanitization module matches these
// via __CANARY__ marker patterns, sensitive field-name redaction, and
// Bearer/AKIA/PEM value patterns.
// ---------------------------------------------------------------------------

const SECRET_VAL = 'CANARY_CREDENTIAL_PLACEHOLDER';
const API_KEY_VAL = 'CANARY_API_KEY_PLACEHOLDER';
const BEARER_VAL = 'CANARY_BEARER_TOKEN';
const BEARER_LEAKED = 'CANARY_BEARER_LEAKED';
const BEARER_DEEP = 'CANARY_BEARER_DEEP';
const PASSWORD_VAL = 'CANARY_PASSWORD_PLACEHOLDER';

const CANARIES = [
  `__CANARY_SECRET__: ${SECRET_VAL}`,
  `__CANARY_CREDENTIAL__: password=${PASSWORD_VAL}`,
  '__CANARY_PROMPT__: You are a helpful assistant. System instructions here.',
  '__CANARY_PROVIDER_BODY__: {"error":"rate_limited","request_id":"req_abc"}',
  '__CANARY_DOCUMENT__: Retrieved web content about sensitive topic.',
  '__CANARY_RAW_DIAGNOSTICS__: Error: at ProviderClient.fetch (node:internal)',
  `Authorization: Bearer ${BEARER_VAL}`,
  `bearer ${BEARER_LEAKED}`,
  `api_key=${API_KEY_VAL}`,
  'AKIA' + 'CANARYAWSKEY123A' /* AKIA + 16 chars */,
];

/** Flatten a value to a string for canary scanning. */
function flatten(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

/** Assert that none of the canary strings appear in a response body. */
function assertNoCanaries(body: unknown): void {
  const text = flatten(body);
  for (const canary of CANARIES) {
    // The AKIA canary uses concatenation; check the raw assembled form.
    if (canary.startsWith('AKIA')) {
      const assembled = 'AKIA' + 'CANARYAWSKEY123A';
      expect(text).not.toContain(assembled);
    } else {
      expect(text).not.toContain(canary);
    }
  }
}

function enableMissionFlag(): void {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function seedScope(db: AnyDb, label: string) {
  const companyId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{}'::jsonb, ${now}, ${now})
  `);
  const projectId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${projectId}, ${companyId}, 'P', 'active', ${now}, ${now})
  `);
  const threadId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, 'T', 'conversation', 'active', ${now}, ${now})
  `);
  return { companyId, projectId, threadId };
}

/**
 * Insert a journal event with a sensitive payload containing all canaries.
 * Simulates a future feature or provider failure that accidentally writes
 * raw credentials, prompts, provider bodies, or retrieved content into a
 * journal event.
 */
async function insertSensitiveEvent(
  db: AnyDb,
  companyId: string,
  projectId: string,
  runId: string,
  sequence: number,
  type = 'execution.progress',
  payloadOverride?: Record<string, unknown>,
): Promise<void> {
  const schema = db.schema;
  const now = new Date();
  const payload: Record<string, unknown> = payloadOverride ?? {
    // Sensitive fields that should be redacted by name
    prompt: '__CANARY_PROMPT__: You are a helpful assistant.',
    apiKey: API_KEY_VAL,
    authorization: `Bearer ${BEARER_VAL}`,
    providerBody: '__CANARY_PROVIDER_BODY__: {"error":"rate_limited"}',
    retrievedContent: '__CANARY_DOCUMENT__: Retrieved web content.',
    rawDiagnostics: '__CANARY_RAW_DIAGNOSTICS__: stack trace here',
    // Sensitive values in non-sensitive fields (should be pattern-redacted)
    summary: `Authorization: Bearer ${BEARER_VAL} in text`,
    nested: {
      secret: SECRET_VAL,
      safe: 'This is a safe value that should pass through.',
      deep: {
        token: BEARER_DEEP,
      },
    },
    safeFields: {
      runId,
      status: 'running',
      count: 42,
    },
  };
  await db.drizzle.insert(schema.runEvents).values({
    companyId,
    projectId,
    runId,
    sequence,
    type,
    schemaVersion: 1,
    payload,
    actorType: 'system',
    actorId: null,
    traceId: null,
    occurredAt: now,
  });
}

// ===========================================================================
// Unit tests for sanitization functions
// ===========================================================================

describe('sanitizeString', () => {
  it('redacts Bearer tokens', () => {
    const input = `Authorization: Bearer ${BEARER_VAL}`;
    expect(sanitizeString(input)).not.toContain(BEARER_VAL);
    expect(sanitizeString(input)).toContain('[REDACTED]');
  });

  it('redacts API keys and secrets', () => {
    const input = `api_key=${API_KEY_VAL}`;
    expect(sanitizeString(input)).not.toContain(API_KEY_VAL);
  });

  it('redacts AWS access key IDs', () => {
    // AWS access key IDs are 20 chars total: AKIA + 16 uppercase alphanumeric.
    const input = 'AKIA' + 'CANARYAWSKEY123A'; // 16 chars after AKIA
    expect(sanitizeString(input)).not.toContain(input);
    expect(sanitizeString(input)).toContain('[REDACTED]');
  });

  it('redacts PEM key blocks', () => {
    const input = '-----BEGIN PRIVATE KEY-----\nMIBabc\n-----END PRIVATE KEY-----';
    expect(sanitizeString(input)).toContain('[REDACTED]');
    expect(sanitizeString(input)).not.toContain('MIBabc');
  });

  it('redacts test canary markers', () => {
    const input = '__CANARY_PROMPT__: You are a helpful assistant.';
    expect(sanitizeString(input)).not.toContain('__CANARY_PROMPT__');
    expect(sanitizeString(input)).toContain('[REDACTED]');
  });

  it('redacts sk- prefixed keys (constructed at runtime)', () => {
    // Construct the sk- value at runtime to avoid static secret scanners.
    const prefix = String.fromCharCode(115, 107); // 'sk'
    const value = prefix + '-' + 'a'.repeat(20);
    expect(sanitizeString(value)).not.toContain(value);
    expect(sanitizeString(value)).toContain('[REDACTED]');
  });

  it('leaves safe strings unchanged', () => {
    const input = 'Run completed successfully with 42 tokens.';
    expect(sanitizeString(input)).toBe(input);
  });
});

describe('sanitizeEventPayload', () => {
  it('redacts sensitive field names', () => {
    const payload = {
      prompt: 'You are a helpful assistant',
      apiKey: 'placeholder-xxx',
      status: 'running',
      count: 42,
    };
    const result = sanitizeEventPayload(payload) as Record<string, unknown>;
    expect(result.prompt).toBe('[REDACTED]');
    expect(result.apiKey).toBe('[REDACTED]');
    expect(result.status).toBe('running');
    expect(result.count).toBe(42);
  });

  it('redacts sensitive values in non-sensitive fields', () => {
    const payload = {
      message: `Authorization: Bearer ${BEARER_VAL} leaked`,
      safe: 'all good',
    };
    const result = sanitizeEventPayload(payload) as Record<string, unknown>;
    expect(String(result.message)).not.toContain(BEARER_VAL);
    expect(result.safe).toBe('all good');
  });

  it('recurses into nested objects and arrays', () => {
    const payload = {
      nested: {
        secret: SECRET_VAL,
        safe: 'ok',
        deep: { token: BEARER_DEEP },
      },
      arr: [`Authorization: Bearer ${BEARER_VAL}`, 'safe'],
    };
    const result = sanitizeEventPayload(payload) as Record<string, unknown>;
    expect(result.nested).toMatchObject({ secret: '[REDACTED]', safe: 'ok' });
    const deep = result.nested as Record<string, unknown>;
    const deepInner = deep.deep as Record<string, unknown>;
    expect(deepInner.token).toBe('[REDACTED]');
    const arr = result.arr as unknown[];
    expect(String(arr[0])).not.toContain(BEARER_VAL);
    expect(arr[1]).toBe('safe');
  });

  it('handles null and primitives', () => {
    expect(sanitizeEventPayload(null)).toBeNull();
    expect(sanitizeEventPayload(undefined)).toBeUndefined();
    expect(sanitizeEventPayload(42)).toBe(42);
    expect(sanitizeEventPayload(true)).toBe(true);
    expect(sanitizeEventPayload('safe string')).toBe('safe string');
  });

  it('guards against excessive depth', () => {
    let nested: unknown = 'deep';
    for (let i = 0; i < 15; i++) {
      nested = { value: nested };
    }
    const result = sanitizeEventPayload(nested) as Record<string, unknown>;
    // Deep values are replaced by the max-depth sentinel.
    const text = JSON.stringify(result);
    expect(text).toContain('[REDACTED:max-depth]');
  });
});

describe('toSafeMissionError', () => {
  it('passes through ZodError unchanged', async () => {
    const { ZodError } = await import('zod');
    const zodErr = new ZodError([]);
    expect(toSafeMissionError(zodErr)).toBe(zodErr);
  });

  it('sanitizes AppError messages and details', () => {
    const err = new AppError(
      500,
      'INTERNAL_SERVER_ERROR',
      'Provider failed: __CANARY_PROVIDER_BODY__: {"error":"rate_limited"}',
      { apiKey: API_KEY_VAL, safe: 'ok' },
    );
    const safe = toSafeMissionError(err) as AppError;
    expect(safe.message).not.toContain('__CANARY_PROVIDER_BODY__');
    expect(safe.message).not.toContain('rate_limited');
    const details = safe.details as Record<string, unknown>;
    expect(details.apiKey).toBe('[REDACTED]');
    expect(details.safe).toBe('ok');
  });

  it('converts unexpected errors to sanitized 500', () => {
    const err = new Error(`Provider error: Authorization: Bearer ${BEARER_VAL} in response body`);
    const safe = toSafeMissionError(err) as AppError;
    expect(safe.status).toBe(500);
    expect(safe.code).toBe('INTERNAL_SERVER_ERROR');
    expect(safe.message).not.toContain(BEARER_VAL);
  });

  it('uses generic message when sanitized message is empty', () => {
    const err = new Error(`bearer ${BEARER_LEAKED}`);
    const safe = toSafeMissionError(err) as AppError;
    expect(safe.message).toBe('An unexpected error occurred');
  });

  it('converts non-Error throwables to generic 500', () => {
    const safe = toSafeMissionError('just a string') as AppError;
    expect(safe.status).toBe(500);
    expect(safe.code).toBe('INTERNAL_SERVER_ERROR');
  });
});

// ===========================================================================
// Integration: event replay sanitization (VAL-RUN-073)
// ===========================================================================

describe('VAL-RUN-073: event replay sanitizes sensitive payloads', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let runId: string;
  let base: string;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeTestServers();
  });

  it('scrubs canaries from JSON replay events', async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
    const scope = await seedScope(db, '__mtest__ replay-sanitize');
    companyId = scope.companyId;
    projectId = scope.projectId;
    threadId = scope.threadId;
    base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const start = await request(app)
      .post(base)
      .set('Idempotency-Key', `replay-${randomUUID()}`)
      .send({ projectThreadId: threadId, mode: 'deep_work', request: { text: 'Test work' } })
      .expect(202);
    runId = start.body.data.run.id;

    // Deep Work now transitions draft→planning (5 events). Revert to
    // draft (4 events) so sensitive event insertion at sequences 5 and 6
    // matches the original test semantics.
    await db.drizzle.execute(sql`
      DELETE FROM "run_events" WHERE "run_id" = ${runId} AND "sequence" = 5
    `);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'draft', "state_version" = 1,
        "last_event_sequence" = 4, "updated_at" = ${new Date()}
      WHERE "id" = ${runId}
    `);

    // Insert sensitive events at sequences 5 and 6 (after the initial 4).
    await insertSensitiveEvent(db, companyId, projectId, runId, 5, 'execution.progress');
    await insertSensitiveEvent(db, companyId, projectId, runId, 6, 'research.source_retrieved', {
      prompt: '__CANARY_PROMPT__: secret system instructions',
      providerBody: '__CANARY_PROVIDER_BODY__: raw provider JSON',
      documentContent: '__CANARY_DOCUMENT__: full retrieved page text',
      safeUrl: 'https://example.com/page',
      safeTitle: 'Example Page',
    });

    // Advance the run's last_event_sequence so the events are visible.
    await db.drizzle
      .update(db.schema.missionRuns)
      .set({ lastEventSequence: 6 })
      .where(eq(db.schema.missionRuns.id, runId));

    const res = await request(app).get(`${base}/${runId}/events?after=0&limit=100`).expect(200);

    const events = res.body.data.events;
    expect(events.length).toBeGreaterThanOrEqual(6);

    // Scan every event payload for canary absence.
    assertNoCanaries(res.body);

    // Verify sensitive fields are redacted in the sensitive events.
    const sensitiveEvent = events.find((e: { sequence: number }) => e.sequence === 5);
    expect(sensitiveEvent).toBeDefined();
    const payload = sensitiveEvent.payload;
    expect(payload.prompt).toBe('[REDACTED]');
    expect(payload.apiKey).toBe('[REDACTED]');
    expect(payload.authorization).toBe('[REDACTED]');
    expect(payload.providerBody).toBe('[REDACTED]');
    expect(payload.retrievedContent).toBe('[REDACTED]');
    expect(payload.rawDiagnostics).toBe('[REDACTED]');
    // Non-sensitive fields pass through.
    expect(payload.safeFields.runId).toBe(runId);
    expect(payload.safeFields.status).toBe('running');
    expect(payload.safeFields.count).toBe(42);
    // Sensitive values in non-sensitive fields are pattern-redacted.
    expect(String(payload.summary)).not.toContain(BEARER_VAL);
    expect(String(payload.nested.secret)).toBe('[REDACTED]');
    expect(payload.nested.safe).toBe('This is a safe value that should pass through.');
  });
});

// ===========================================================================
// Integration: SSE stream sanitization (VAL-RUN-073)
// ===========================================================================

describe('VAL-RUN-073: SSE stream sanitizes sensitive payloads', () => {
  let db: AnyDb;
  let server: http.Server;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeTestServers();
  });

  it('scrubs canaries from SSE event frames', async () => {
    enableMissionFlag();
    db = await createTestDb();
    server = await createTestServer(db);
    const scope = await seedScope(db, '__mtest__ sse-sanitize');
    const { companyId, projectId, threadId } = scope;
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    // Start a run through the service directly (avoids needing the API
    // server for setup).
    const service = new MissionStartService(db);
    const startResult = await service.start({
      companyId,
      projectId,
      idempotencyKey: `sse-${randomUUID()}`,
      body: { projectThreadId: threadId, mode: 'deep_work', request: { text: 'SSE test' } },
      actorType: 'user',
      actorId: 'dev-user-000',
    });
    const runId = startResult.run.id;

    // Deep Work now transitions draft→planning (5 events). Revert to
    // draft (4 events) so the sensitive event insertion at sequence 5
    // matches the original test semantics.
    await db.drizzle.execute(sql`
      DELETE FROM "run_events" WHERE "run_id" = ${runId} AND "sequence" = 5
    `);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'draft', "state_version" = 1,
        "last_event_sequence" = 4, "updated_at" = ${new Date()}
      WHERE "id" = ${runId}
    `);

    // Insert a sensitive event at sequence 5.
    await insertSensitiveEvent(db, companyId, projectId, runId, 5, 'execution.progress');
    await db.drizzle
      .update(db.schema.missionRuns)
      .set({ lastEventSequence: 5 })
      .where(eq(db.schema.missionRuns.id, runId));

    // Open an SSE connection to the already-listening test server.
    const address = server.address() as { port: number };
    const ssePath = `${base}/${runId}/stream`;

    const frames: { id: string | null; event: string | null; data: string | null }[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: ssePath,
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          res.setEncoding('utf8');
          let buffer = '';
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const raw = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              if (raw.startsWith(':') || !raw.trim()) {
                continue;
              }
              const frame = {
                id: null as string | null,
                event: null as string | null,
                data: null as string | null,
              };
              for (const line of raw.split('\n')) {
                if (line.startsWith('id:')) {
                  frame.id = line.slice(3).trim();
                } else if (line.startsWith('event:')) {
                  frame.event = line.slice(6).trim();
                } else if (line.startsWith('data:')) {
                  frame.data = line.slice(5).trim();
                }
              }
              frames.push(frame);
            }
            // Once we have all 5 committed events, close the connection.
            if (frames.length >= 5) {
              req.destroy();
              resolve();
            }
          });
          res.on('end', resolve);
          res.on('error', reject);
          // Safety timeout: close after 3 seconds regardless.
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 3000);
        },
      );
      req.on('error', reject);
    });

    // The stream should have delivered the initial events (including the
    // sensitive one at sequence 5). Since the run is non-terminal, the
    // stream stays open until our timeout closes it.
    expect(frames.length).toBeGreaterThanOrEqual(5);

    // Scan every SSE frame's data for canary absence.
    for (const frame of frames) {
      assertNoCanaries(frame.data);
    }

    // Verify the sensitive event (sequence 5) has redacted fields.
    const sensitiveFrame = frames.find((f) => f.id === '5');
    expect(sensitiveFrame).toBeDefined();
    if (sensitiveFrame?.data) {
      const payload = JSON.parse(sensitiveFrame.data).payload;
      expect(payload.prompt).toBe('[REDACTED]');
      expect(payload.apiKey).toBe('[REDACTED]');
      expect(payload.providerBody).toBe('[REDACTED]');
      expect(payload.rawDiagnostics).toBe('[REDACTED]');
    }
  });
});

// ===========================================================================
// Integration: error response sanitization (VAL-RUN-046)
// ===========================================================================

describe('VAL-RUN-046: Mission API errors are sanitized', () => {
  it('scrubs canaries from unexpected 500 errors via the sanitizer middleware', async () => {
    // Build a mini Express app with the Mission error sanitizer and the
    // global error handler. A route throws an error with sensitive canaries
    // to simulate an internal/provider failure.
    const testApp = express();
    testApp.use(express.json());

    // A route that throws an error with sensitive canaries, simulating an
    // internal or provider failure that leaks raw diagnostics.
    testApp.get('/test-error', () => {
      throw new Error(
        'Provider failure: __CANARY_PROVIDER_BODY__: {"error":"rate_limited"} ' +
          `Authorization: Bearer ${BEARER_VAL} ` +
          '__CANARY_PROMPT__: You are a helpful assistant. ' +
          `api_key=${API_KEY_VAL} ` +
          '__CANARY_RAW_DIAGNOSTICS__: stack at ProviderClient.fetch',
      );
    });

    // Mission error sanitizer → global error handler.
    testApp.use(missionErrorSanitizer);
    testApp.use(errorHandler);

    const res = await request(testApp).get('/test-error').expect(500);

    // The error response must use the structured error contract.
    expect(res.body.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');

    // Scan for all canary strings — none should appear.
    assertNoCanaries(res.body);
    expect(res.body.message).not.toContain('__CANARY_PROVIDER_BODY__');
    expect(res.body.message).not.toContain(BEARER_VAL);
    expect(res.body.message).not.toContain('__CANARY_PROMPT__');
    expect(res.body.message).not.toContain(API_KEY_VAL);
    expect(res.body.message).not.toContain('__CANARY_RAW_DIAGNOSTICS__');
    // [REDACTED] should appear where canaries were scrubbed.
    expect(res.body.message).toContain('[REDACTED]');
  });

  it('sanitizes AppError details with sensitive fields', async () => {
    const testApp = express();
    testApp.use(express.json());

    testApp.get('/test-error', () => {
      throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'Internal failure', {
        apiKey: API_KEY_VAL,
        prompt: '__CANARY_PROMPT__: secret instructions',
        safe: 'public info',
      });
    });

    testApp.use(missionErrorSanitizer);
    testApp.use(errorHandler);

    const res = await request(testApp).get('/test-error').expect(500);

    expect(res.body.status).toBe(500);
    expect(res.body.details.apiKey).toBe('[REDACTED]');
    expect(res.body.details.prompt).toBe('[REDACTED]');
    expect(res.body.details.safe).toBe('public info');
    assertNoCanaries(res.body);
  });

  it('passes through validation errors unchanged', async () => {
    const testApp = express();
    testApp.use(express.json());

    testApp.get('/test-error', () => {
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid request shape', {
        field: 'mode',
      });
    });

    testApp.use(missionErrorSanitizer);
    testApp.use(errorHandler);

    const res = await request(testApp).get('/test-error').expect(400);

    expect(res.body.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.message).toBe('Invalid request shape');
    expect(res.body.details.field).toBe('mode');
  });
});

// ===========================================================================
// Integration: canary absence across all surfaces
// ===========================================================================

describe('VAL-RUN-046/073: full surface canary scan', () => {
  let db: AnyDb;
  let server: http.Server;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeTestServers();
  });

  it('events, SSE, and errors all omit sensitive canaries', async () => {
    enableMissionFlag();
    db = await createTestDb();
    server = await createTestServer(db);
    const scope = await seedScope(db, '__mtest__ full-scan');
    const { companyId, projectId, threadId } = scope;
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    // Start a run.
    const start = await request(server)
      .post(base)
      .set('Idempotency-Key', `full-${randomUUID()}`)
      .send({ projectThreadId: threadId, mode: 'deep_work', request: { text: 'Full scan' } })
      .expect(202);
    const runId = start.body.data.run.id;

    // Deep Work now transitions draft→planning (5 events). Revert to
    // draft (4 events) so the sensitive event insertion at sequence 5
    // matches the original test semantics.
    await db.drizzle.execute(sql`
      DELETE FROM "run_events" WHERE "run_id" = ${runId} AND "sequence" = 5
    `);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'draft', "state_version" = 1,
        "last_event_sequence" = 4, "updated_at" = ${new Date()}
      WHERE "id" = ${runId}
    `);

    // Insert sensitive events.
    await insertSensitiveEvent(db, companyId, projectId, runId, 5);
    await db.drizzle
      .update(db.schema.missionRuns)
      .set({ lastEventSequence: 5 })
      .where(eq(db.schema.missionRuns.id, runId));

    // 1. JSON replay surface.
    const replayRes = await request(server)
      .get(`${base}/${runId}/events?after=0&limit=100`)
      .expect(200);
    assertNoCanaries(replayRes.body);

    // 2. Snapshot surface (should not contain event payloads).
    const snapshotRes = await request(server).get(`${base}/${runId}`).expect(200);
    assertNoCanaries(snapshotRes.body);

    // 3. SSE stream surface — server is already listening.
    const address = server.address() as { port: number };
    const sseFrames: string[] = [];
    await new Promise<void>((resolve) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: `${base}/${runId}/stream`,
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          res.setEncoding('utf8');
          let buffer = '';
          res.on('data', (chunk: string) => {
            buffer += chunk;
            let idx: number;
            while ((idx = buffer.indexOf('\n\n')) >= 0) {
              const raw = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              if (raw.startsWith(':') || !raw.trim()) {
                continue;
              }
              sseFrames.push(raw);
            }
            // Once we have all 5 committed events, close the connection.
            if (sseFrames.length >= 5) {
              req.destroy();
              resolve();
            }
          });
          res.on('end', resolve);
          // Safety timeout: close after 3 seconds regardless.
          setTimeout(() => {
            req.destroy();
            resolve();
          }, 3000);
        },
      );
      req.on('error', () => resolve());
    });

    for (const frame of sseFrames) {
      assertNoCanaries(frame);
    }

    // 4. Error surface — trigger a known safe error and verify no canaries.
    const errorRes = await request(server)
      .post(`${base}/${runId}/cancel`)
      .set('Idempotency-Key', `err-${randomUUID()}`)
      .set('If-Match', '"999"') // stale version → 412
      .send({ reason: 'No longer needed' })
      .expect(412);
    assertNoCanaries(errorRes.body);
  });
});
