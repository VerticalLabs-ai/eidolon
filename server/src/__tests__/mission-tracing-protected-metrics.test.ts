import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestApp } from '../test-utils.js';

/**
 * VAL-RUN-076: Trace identity correlates outcomes.
 * VAL-RUN-077: Metrics endpoint remains protected.
 * VAL-RUN-078: Metrics reflect user-visible outcomes.
 *
 * Opaque trace identities correlate authorized responses, commands, and
 * events while protected metrics use bounded labels with no tenant, run,
 * user, URL, prompt, or payload data. Idempotent replay does not count as
 * a second logical run.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

function enableMetricsToken() {
  vi.stubEnv('METRICS_TOKEN', 'metrics-test-token');
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

async function getRunVersion(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(
    sql`SELECT "state_version" FROM "mission_runs" WHERE "id" = ${runId}`,
  )) as unknown as { state_version: number }[];
  return row.state_version;
}

const etag = (v: number): string => `"${v}"`;

/** Start a run via the API and return the response. */
function startRun(
  app: ReturnType<typeof createTestApp>,
  base: string,
  threadId: string,
  key: string,
  text = 'Do work',
) {
  return request(app)
    .post(base)
    .set('Idempotency-Key', key)
    .send({ projectThreadId: threadId, mode: 'fast', request: { text } });
}

/** Parse a metric value from Prometheus text output. */
function parseMetric(
  text: string,
  metricName: string,
  labels?: Record<string, string>,
): number | null {
  const labelStr = labels
    ? `{${Object.entries(labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(',')}}`
    : '';
  const pattern = new RegExp(
    `^${metricName}${labelStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d+)`,
    'm',
  );
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
}

/** Extract all label names from Prometheus text output. */
function extractLabelNames(text: string): Set<string> {
  const names = new Set<string>();
  const labelPattern = /(\w+)\{[^}]*\}/g;
  let match;
  while ((match = labelPattern.exec(text)) !== null) {
    const labelPart = match[0].slice(match[0].indexOf('{') + 1, -1);
    for (const pair of labelPart.split(',')) {
      const name = pair.split('=')[0].trim();
      if (name) {names.add(name);}
    }
  }
  return names;
}

describe('Mission trace correlation and protected metrics', () => {
  let db: AnyDb;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    enableMissionFlag();
    enableMetricsToken();
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-076: Trace identity correlates outcomes
  // -------------------------------------------------------------------------

  describe('VAL-RUN-076: Trace identity correlates outcomes', () => {
    it('returns X-Trace-Id on every Mission response', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ trace-co');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      // Start response has X-Trace-Id
      const startRes = await startRun(app, base, threadId, `trace-${randomUUID()}`).expect(202);
      expect(startRes.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);

      // GET snapshot has X-Trace-Id
      const runId = startRes.body.data.run.id;
      const getRes = await request(app).get(`${base}/${runId}`).expect(200);
      expect(getRes.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);

      // GET events has X-Trace-Id
      const eventsRes = await request(app).get(`${base}/${runId}/events`).expect(200);
      expect(eventsRes.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);

      // GET commands has X-Trace-Id
      const cmdRes = await request(app).get(`${base}/${runId}/commands`).expect(200);
      expect(cmdRes.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    });

    it('correlates trace ID across start response, command result, and event replay', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ trace-correlate');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      // Supply a known traceparent so the trace ID is deterministic
      const traceId = 'abcdef0123456789abcdef0123456789';
      const traceparent = `00-${traceId}-0123456789abcdef-01`;

      const startRes = await request(app)
        .post(base)
        .set('Idempotency-Key', `corr-${randomUUID()}`)
        .set('traceparent', traceparent)
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Correlate trace' } })
        .expect(202);

      // Response header matches the supplied trace ID
      expect(startRes.headers['x-trace-id']).toBe(traceId);

      // Command result body includes the same trace ID
      expect(startRes.body.data.command).toBeDefined();
      expect(startRes.body.data.command.traceId).toBe(traceId);

      const runId = startRes.body.data.run.id;

      // Event replay includes the same trace ID on every event
      const eventsRes = await request(app).get(`${base}/${runId}/events`).expect(200);
      const events = eventsRes.body.data.events;
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event.traceId).toBe(traceId);
      }

      // Command history includes the same trace ID
      const cmdRes = await request(app).get(`${base}/${runId}/commands`).expect(200);
      const commands = cmdRes.body.data.commands;
      expect(commands.length).toBeGreaterThan(0);
      for (const cmd of commands) {
        expect(cmd.traceId).toBe(traceId);
      }
    });

    it('preserves trace ID on idempotent replay of start', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ trace-replay');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      const traceId = 'fedcba9876543210fedcba9876543210';
      const traceparent = `00-${traceId}-abcdef0123456789-01`;
      const key = `replay-${randomUUID()}`;

      // First start
      const first = await request(app)
        .post(base)
        .set('Idempotency-Key', key)
        .set('traceparent', traceparent)
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Replay trace' } })
        .expect(202);

      expect(first.body.data.command.traceId).toBe(traceId);

      // Idempotent replay with a DIFFERENT trace context returns the ORIGINAL trace ID
      const replayTraceId = '11111111111111111111111111111111';
      const replay = await request(app)
        .post(base)
        .set('Idempotency-Key', key)
        .set('traceparent', `00-${replayTraceId}-abcdef0123456789-01`)
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Replay trace' } })
        .expect(202);

      // The replayed command result carries the ORIGINAL trace ID, not the new one
      expect(replay.body.data.command.traceId).toBe(traceId);
      // The response header carries the NEW request's trace ID (middleware sets it)
      expect(replay.headers['x-trace-id']).toBe(replayTraceId);
    });

    it('correlates trace ID across cancel command and its event', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ trace-cancel');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      const traceId = '0123456789abcdef0123456789abcdef';
      const traceparent = `00-${traceId}-0123456789abcdef-01`;

      const startRes = await request(app)
        .post(base)
        .set('Idempotency-Key', `cancel-start-${randomUUID()}`)
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Cancel trace' } })
        .expect(202);

      const runId = startRes.body.data.run.id;
      const version = startRes.body.data.run.stateVersion;

      // Cancel with a known trace context
      const cancelRes = await request(app)
        .post(`${base}/${runId}/cancel`)
        .set('Idempotency-Key', `cancel-${randomUUID()}`)
        .set('If-Match', etag(version))
        .set('traceparent', traceparent)
        .send({ reason: 'Testing trace correlation' })
        .expect(202);

      // Command result includes the trace ID
      expect(cancelRes.body.data.command.traceId).toBe(traceId);

      // Event replay shows the cancel events with the same trace ID
      const eventsRes = await request(app).get(`${base}/${runId}/events`).expect(200);
      const cancelEvents = eventsRes.body.data.events.filter(
        (e: { type: string; traceId: string | null }) =>
          e.type === 'run.cancel_requested' || e.type === 'run.cancelled',
      );
      expect(cancelEvents.length).toBeGreaterThan(0);
      for (const event of cancelEvents) {
        expect(event.traceId).toBe(traceId);
      }
    });

    it('does not encode tenant-sensitive material in the trace ID', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ trace-safe');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      const startRes = await startRun(app, base, threadId, `safe-${randomUUID()}`).expect(202);
      const traceId = startRes.headers['x-trace-id'] as string;

      // Trace ID is a 32-char hex string — no company, project, run, user, URL, or prompt data
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(traceId).not.toContain(companyId);
      expect(traceId).not.toContain(projectId);
      expect(traceId).not.toContain(threadId);
      expect(traceId).not.toContain('user');
      expect(traceId).not.toContain('http');
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-077: Metrics endpoint remains protected
  // -------------------------------------------------------------------------

  describe('VAL-RUN-077: Metrics endpoint remains protected', () => {
    it('denies metrics without a token', async () => {
      vi.stubEnv('METRICS_TOKEN', 'secret-token');
      await request(app).get('/api/metrics').expect(404);
    });

    it('denies metrics with a wrong token', async () => {
      vi.stubEnv('METRICS_TOKEN', 'correct-token');
      await request(app).get('/api/metrics').set('Authorization', 'Bearer wrong-token').expect(404);
    });

    it('exposes Mission metrics with the correct token', async () => {
      vi.stubEnv('METRICS_TOKEN', 'metrics-token');
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ metrics-access');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      // Start a run so Mission metrics have non-zero values
      await startRun(app, base, threadId, `metrics-${randomUUID()}`).expect(202);

      const res = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);

      expect(res.text).toContain('eidolon_mission_runs_started_total');
      expect(res.text).toContain('eidolon_mission_runs_by_status');
      expect(res.text).toContain('eidolon_mission_commands_total');
    });

    it('does not expose forbidden label names in Mission metrics', async () => {
      vi.stubEnv('METRICS_TOKEN', 'metrics-token');
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ metrics-labels');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      await startRun(app, base, threadId, `labels-${randomUUID()}`).expect(202);

      const res = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);

      // Extract all label names from Mission metric lines
      const missionLines = res.text.split('\n').filter((l) => l.startsWith('eidolon_mission'));
      expect(missionLines.length).toBeGreaterThan(0);

      const labelNames = new Set<string>();
      for (const line of missionLines) {
        const labelMatch = line.match(/\{([^}]*)\}/);
        if (labelMatch) {
          for (const pair of labelMatch[1].split(',')) {
            const name = pair.split('=')[0].trim();
            if (name) {labelNames.add(name);}
          }
        }
      }

      // Forbidden label names must not appear
      const forbidden = [
        'company',
        'project',
        'run',
        'url',
        'prompt',
        'user',
        'company_id',
        'project_id',
        'run_id',
        'user_id',
        'tenant',
        'tenant_id',
        'thread',
        'thread_id',
      ];
      for (const name of forbidden) {
        expect(labelNames.has(name)).toBe(false);
      }

      // Allowed label names should be bounded and safe
      const allowed = new Set(['status', 'resolved_mode', 'type', 'result']);
      for (const name of labelNames) {
        expect(allowed.has(name)).toBe(true);
      }
    });

    it('does not expose tenant identifiers as label values in Mission metrics', async () => {
      vi.stubEnv('METRICS_TOKEN', 'metrics-token');
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ metrics-values');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      await startRun(app, base, threadId, `values-${randomUUID()}`).expect(202);

      const res = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);

      // No Mission metric line should contain the company ID, project ID, or thread ID
      const missionLines = res.text.split('\n').filter((l) => l.startsWith('eidolon_mission'));
      for (const line of missionLines) {
        expect(line).not.toContain(companyId);
        expect(line).not.toContain(projectId);
        expect(line).not.toContain(threadId);
      }
    });
  });

  // -------------------------------------------------------------------------
  // VAL-RUN-078: Metrics reflect user-visible outcomes
  // -------------------------------------------------------------------------

  describe('VAL-RUN-078: Metrics reflect user-visible outcomes', () => {
    it('increments run-started counter on a new run but not on idempotent replay', async () => {
      vi.stubEnv('METRICS_TOKEN', 'metrics-token');
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ metrics-start');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      // Capture before
      const beforeRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const beforeStarted =
        parseMetric(beforeRes.text, 'eidolon_mission_runs_started_total', {
          resolved_mode: 'fast',
        }) ?? 0;

      // Start a new run
      const key = `start-${randomUUID()}`;
      await startRun(app, base, threadId, key).expect(202);

      // Capture after start
      const afterStartRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const afterStarted =
        parseMetric(afterStartRes.text, 'eidolon_mission_runs_started_total', {
          resolved_mode: 'fast',
        }) ?? 0;

      // Counter incremented by exactly 1
      expect(afterStarted - beforeStarted).toBe(1);

      // Idempotent replay with the same key
      await startRun(app, base, threadId, key).expect(202);

      // Capture after replay
      const afterReplayRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const afterReplay =
        parseMetric(afterReplayRes.text, 'eidolon_mission_runs_started_total', {
          resolved_mode: 'fast',
        }) ?? 0;

      // Counter did NOT increment on replay
      expect(afterReplay - afterStarted).toBe(0);
    });

    it('increments command counter on new cancel but not on idempotent replay', async () => {
      vi.stubEnv('METRICS_TOKEN', 'metrics-token');
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ metrics-cmd');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      const startRes = await startRun(app, base, threadId, `cmd-start-${randomUUID()}`).expect(202);
      const runId = startRes.body.data.run.id;
      const version = startRes.body.data.run.stateVersion;
      const cancelKey = `cancel-${randomUUID()}`;

      // Capture before cancel
      const beforeRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const beforeApplied =
        parseMetric(beforeRes.text, 'eidolon_mission_commands_total', {
          type: 'run.cancel',
          result: 'applied',
        }) ?? 0;

      // Cancel
      await request(app)
        .post(`${base}/${runId}/cancel`)
        .set('Idempotency-Key', cancelKey)
        .set('If-Match', etag(version))
        .send({ reason: 'Testing metrics' })
        .expect(202);

      // Capture after cancel
      const afterCancelRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const afterApplied =
        parseMetric(afterCancelRes.text, 'eidolon_mission_commands_total', {
          type: 'run.cancel',
          result: 'applied',
        }) ?? 0;

      // Counter incremented by exactly 1
      expect(afterApplied - beforeApplied).toBe(1);

      // Idempotent replay of cancel
      await request(app)
        .post(`${base}/${runId}/cancel`)
        .set('Idempotency-Key', cancelKey)
        .set('If-Match', etag(version))
        .send({ reason: 'Testing metrics' })
        .expect(202);

      // Capture after replay
      const afterReplayRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const afterReplay =
        parseMetric(afterReplayRes.text, 'eidolon_mission_commands_total', {
          type: 'run.cancel',
          result: 'applied',
        }) ?? 0;

      // Counter did NOT increment on replay
      expect(afterReplay - afterApplied).toBe(0);

      // But the idempotent replay counter DID increment
      const beforeReplays =
        parseMetric(beforeRes.text, 'eidolon_mission_command_idempotent_replays_total') ?? 0;
      const afterReplays =
        parseMetric(afterReplayRes.text, 'eidolon_mission_command_idempotent_replays_total') ?? 0;
      expect(afterReplays - beforeReplays).toBeGreaterThanOrEqual(1);
    });

    it('reflects run status in the by-status gauge', async () => {
      vi.stubEnv('METRICS_TOKEN', 'metrics-token');
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ metrics-status');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      // Start a run (status: draft)
      const startRes = await startRun(app, base, threadId, `status-${randomUUID()}`).expect(202);
      const runId = startRes.body.data.run.id;

      // Check the gauge shows at least 1 draft run
      const res = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);

      const draftCount =
        parseMetric(res.text, 'eidolon_mission_runs_by_status', { status: 'draft' }) ?? 0;
      expect(draftCount).toBeGreaterThanOrEqual(1);
    });

    it('increments budget denial counter when budget is unavailable', async () => {
      vi.stubEnv('METRICS_TOKEN', 'metrics-token');

      // Create a company with zero budget headroom
      const companyId = randomUUID();
      const now = new Date();
      await db.drizzle.execute(sql`
        INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
        VALUES (${companyId}, '__mtest__ no-budget', 'active', 100, 100, '{}'::jsonb, ${now}, ${now})
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
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      // Capture before
      const beforeRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const beforeDenials =
        parseMetric(beforeRes.text, 'eidolon_mission_budget_denials_total') ?? 0;

      // Attempt to start with a cost ceiling above the available headroom
      await request(app)
        .post(base)
        .set('Idempotency-Key', `denied-${randomUUID()}`)
        .send({
          projectThreadId: threadId,
          mode: 'deep_work',
          request: { text: 'Should be denied' },
          limits: { costCents: 50000 },
        })
        .expect(409);

      // Capture after denial
      const afterRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const afterDenials = parseMetric(afterRes.text, 'eidolon_mission_budget_denials_total') ?? 0;

      // Counter incremented
      expect(afterDenials - beforeDenials).toBeGreaterThanOrEqual(1);
    });

    it('increments SSE replay counter on stream connection', async () => {
      vi.stubEnv('METRICS_TOKEN', 'metrics-token');
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ metrics-sse');
      const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

      const startRes = await startRun(app, base, threadId, `sse-${randomUUID()}`).expect(202);
      const runId = startRes.body.data.run.id;

      // Capture before
      const beforeRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const beforeSse = parseMetric(beforeRes.text, 'eidolon_mission_sse_connections_total') ?? 0;

      // Open an SSE stream (supertest buffers the response)
      await request(app)
        .get(`${base}/${runId}/stream`)
        .set('Accept', 'text/event-stream')
        .buffer(true)
        .parse((res, cb) => {
          // Consume the initial replay data then close
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
            if (data.includes('event: budget.reserved') || data.includes(': heartbeat')) {
              (res as unknown as { destroy: () => void }).destroy();
              cb(null, { text: data });
            }
          });
          res.on('end', () => cb(null, { text: data }));
        })
        .ok(() => true);

      // Capture after SSE
      const afterRes = await request(app)
        .get('/api/metrics')
        .set('Authorization', 'Bearer metrics-token')
        .expect(200);
      const afterSse = parseMetric(afterRes.text, 'eidolon_mission_sse_connections_total') ?? 0;

      // Counter incremented
      expect(afterSse - beforeSse).toBeGreaterThanOrEqual(1);
    });
  });
});
