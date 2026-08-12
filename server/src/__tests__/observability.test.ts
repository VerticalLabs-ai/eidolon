import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';
import { initializeErrorTracking } from '../utils/error-tracking.js';

describe('Observability middleware', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    app = createTestApp(await createTestDb());
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

  it('keeps error tracking disabled without a configured DSN', () => {
    vi.stubEnv('SENTRY_DSN', '');
    expect(initializeErrorTracking()).toBe(false);
  });
});
