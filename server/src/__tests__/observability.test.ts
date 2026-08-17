import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';
import { initializeErrorTracking } from '../utils/error-tracking.js';
import * as schema from '@eidolon/db';

describe('Observability middleware', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a safe request ID and preserves a valid caller ID', async () => {
    const supplied = await request(app)
      .get('/api/health')
      .set('X-Request-ID', 'operator-check-123')
      .expect(200);
    expect(supplied.headers['x-request-id']).toBe('operator-check-123');

    const generated = await request(app).get('/api/health').expect(200);
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.headers['x-trace-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(generated.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('continues a valid W3C trace context', async () => {
    const traceId = '0123456789abcdef0123456789abcdef';
    const response = await request(app)
      .get('/api/health')
      .set('traceparent', `00-${traceId}-0123456789abcdef-01`)
      .expect(200);

    expect(response.headers['x-trace-id']).toBe(traceId);
    expect(response.headers.traceparent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
  });

  it('does not expose metrics without the operator token', async () => {
    await request(app).get('/api/metrics').expect(404);
  });

  it('returns 404 when METRICS_TOKEN is not configured', async () => {
    vi.stubEnv('METRICS_TOKEN', '');
    await request(app).get('/api/metrics').expect(404);
  });

  it('exposes Prometheus metrics with the operator token', async () => {
    vi.stubEnv('METRICS_TOKEN', 'metrics-test-token');

    await request(app).get('/api/health').expect(200);
    const response = await request(app)
      .get('/api/metrics')
      .set('Authorization', 'Bearer metrics-test-token')
      .expect(200);

    expect(response.text).toContain('eidolon_http_requests_total');
    expect(response.headers['content-type']).toContain('text/plain');
  });

  it('includes business metrics in the Prometheus output', async () => {
    vi.stubEnv('METRICS_TOKEN', 'metrics-test-token');

    // Seed one active company and one agent so the gauges report non-zero.
    const [company] = await db.drizzle
      .insert(schema.companies)
      .values({
        name: '__mtest__ metrics company',
        status: 'active',
        settings: { testFixture: true },
      })
      .returning();
    await db.drizzle.insert(schema.agents).values({
      companyId: company.id,
      name: '__mtest__ metrics agent',
      role: 'engineer',
      status: 'idle',
    });

    const response = await request(app)
      .get('/api/metrics')
      .set('Authorization', 'Bearer metrics-test-token')
      .expect(200);

    expect(response.text).toContain('eidolon_companies_active');
    expect(response.text).toContain('eidolon_agents_by_status');
    expect(response.text).toContain('eidolon_tasks_by_status');
  });

  it('reports accurate business metric counts from the database', async () => {
    vi.stubEnv('METRICS_TOKEN', 'metrics-test-token');

    const [company] = await db.drizzle
      .insert(schema.companies)
      .values({
        name: '__mtest__ count company',
        status: 'active',
        settings: { testFixture: true },
      })
      .returning();

    // Two idle agents and one working agent.
    await db.drizzle.insert(schema.agents).values([
      {
        companyId: company.id,
        name: '__mtest__ agent-1',
        role: 'engineer',
        status: 'idle',
      },
      {
        companyId: company.id,
        name: '__mtest__ agent-2',
        role: 'engineer',
        status: 'idle',
      },
      {
        companyId: company.id,
        name: '__mtest__ agent-3',
        role: 'engineer',
        status: 'working',
      },
    ]);

    // One done task and one in_progress task.
    await db.drizzle.insert(schema.tasks).values([
      {
        companyId: company.id,
        title: '__mtest__ task-1',
        status: 'done',
      },
      {
        companyId: company.id,
        title: '__mtest__ task-2',
        status: 'in_progress',
      },
    ]);

    const response = await request(app)
      .get('/api/metrics')
      .set('Authorization', 'Bearer metrics-test-token')
      .expect(200);

    const metricsText = response.text;

    // Active companies should be at least 1 (other test companies may exist
    // in the same test database, so we check for a value >= 1).
    const companiesMatch = metricsText.match(/eidolon_companies_active (\d+)/);
    expect(companiesMatch).not.toBeNull();
    expect(Number(companiesMatch![1])).toBeGreaterThanOrEqual(1);

    // Agents: status="idle" should be >= 2, status="working" >= 1.
    const idleMatch = metricsText.match(/eidolon_agents_by_status\{status="idle"\} (\d+)/);
    expect(idleMatch).not.toBeNull();
    expect(Number(idleMatch![1])).toBeGreaterThanOrEqual(2);

    const workingMatch = metricsText.match(/eidolon_agents_by_status\{status="working"\} (\d+)/);
    expect(workingMatch).not.toBeNull();
    expect(Number(workingMatch![1])).toBeGreaterThanOrEqual(1);

    // Tasks: status="done" >= 1, status="in_progress" >= 1.
    const doneMatch = metricsText.match(/eidolon_tasks_by_status\{status="done"\} (\d+)/);
    expect(doneMatch).not.toBeNull();
    expect(Number(doneMatch![1])).toBeGreaterThanOrEqual(1);

    const inProgressMatch = metricsText.match(
      /eidolon_tasks_by_status\{status="in_progress"\} (\d+)/,
    );
    expect(inProgressMatch).not.toBeNull();
    expect(Number(inProgressMatch![1])).toBeGreaterThanOrEqual(1);
  });

  it('rejects an invalid metrics token', async () => {
    vi.stubEnv('METRICS_TOKEN', 'correct-token');
    await request(app).get('/api/metrics').set('Authorization', 'Bearer wrong-token').expect(404);
  });

  it('keeps error tracking disabled without a configured DSN', () => {
    vi.stubEnv('SENTRY_DSN', '');
    expect(initializeErrorTracking()).toBe(false);
  });
});
