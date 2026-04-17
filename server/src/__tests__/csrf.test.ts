import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Origin-based CSRF defense', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalVitest = process.env.VITEST;
  const originalWorker = process.env.VITEST_WORKER_ID;
  const originalCorsOrigin = process.env.CORS_ORIGIN;

  // Opt INTO the CSRF check for these tests by clearing the test bypasses.
  // The app-level bypass (AUTH_MODE=local_trusted) stays off because
  // createTestApp sets that too — so we must run in 'authenticated' mode.
  beforeEach(async () => {
    delete process.env.NODE_ENV;
    delete process.env.VITEST;
    delete process.env.VITEST_WORKER_ID;
    process.env.CORS_ORIGIN = 'https://app.example.com';

    db = await createTestDb();
    app = createTestApp(db, 'authenticated');
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = originalVitest;
    if (originalWorker === undefined) delete process.env.VITEST_WORKER_ID;
    else process.env.VITEST_WORKER_ID = originalWorker;
    if (originalCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalCorsOrigin;
  });

  it('allows GET requests without an Origin header', async () => {
    // Should not be 403; auth may still 401, but CSRF should pass through.
    const res = await request(app).get('/api/companies');
    expect(res.status).not.toBe(403);
    const body = res.body ?? {};
    expect(body.code).not.toBe('CSRF_MISSING_ORIGIN');
    expect(body.code).not.toBe('CSRF_ORIGIN_REJECTED');
  });

  it('rejects POSTs with no Origin/Referer', async () => {
    const res = await request(app)
      .post('/api/companies')
      .send({ name: 'Test' })
      .expect(403);
    expect(res.body.code).toBe('CSRF_MISSING_ORIGIN');
  });

  it('rejects POSTs from a foreign Origin', async () => {
    const res = await request(app)
      .post('/api/companies')
      .set('Origin', 'https://evil.example.com')
      .send({ name: 'Test' })
      .expect(403);
    expect(res.body.code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('accepts POSTs from an allowed Origin (then hits auth gate)', async () => {
    const res = await request(app)
      .post('/api/companies')
      .set('Origin', 'https://app.example.com')
      .send({ name: 'Test' });
    // CSRF passed — next gate is auth, which returns 401 in authenticated
    // mode without a session. The important thing is we didn't get a 403.
    expect(res.status).not.toBe(403);
  });

  it('bypasses the check for /api/health', async () => {
    const res = await request(app)
      .post('/api/health')
      .send({})
      // health only defines GET — 404 is fine, 403 would be a CSRF failure.
      .expect((r) => {
        if (r.status === 403) {
          throw new Error('health endpoint should bypass CSRF');
        }
      });
    expect(res.status).not.toBe(403);
  });

  it('falls back to Referer when Origin is absent', async () => {
    const res = await request(app)
      .post('/api/companies')
      .set('Referer', 'https://app.example.com/companies/new')
      .send({ name: 'Test' });
    expect(res.status).not.toBe(403);
  });
});
