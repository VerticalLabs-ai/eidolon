import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';

describe('Origin-based CSRF defense', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  const originalEnforce = process.env.EIDOLON_ENFORCE_CSRF;
  const originalCorsOrigin = process.env.CORS_ORIGIN;

  // Opt INTO CSRF by flipping the explicit switch (default is off, matching
  // production behavior: NODE_ENV=production OR EIDOLON_ENFORCE_CSRF=1).
  beforeEach(async () => {
    process.env.EIDOLON_ENFORCE_CSRF = '1';
    process.env.CORS_ORIGIN = 'https://app.example.com';

    db = await createTestDb();
    app = createTestApp(db, 'authenticated');
  });

  afterEach(() => {
    if (originalEnforce === undefined) delete process.env.EIDOLON_ENFORCE_CSRF;
    else process.env.EIDOLON_ENFORCE_CSRF = originalEnforce;
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
