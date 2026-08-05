import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestDb, createTestApp, createTestServer } from '../test-utils.js';

describe('Health API', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    const db = await createTestDb();
    app = await createTestServer(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('GET /api/health', () => {
    it('should return 200 with status ok', async () => {
      const res = await request(app).get('/api/health').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.uptime).toBeDefined();
      expect(typeof res.body.uptime).toBe('number');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.memory).toBeDefined();
      expect(res.body.memory.rss).toBeDefined();
      expect(res.body.memory.heapUsed).toBeDefined();
    });

    it('should return wsClients count', async () => {
      const res = await request(app).get('/api/health').expect(200);

      expect(typeof res.body.wsClients).toBe('number');
    });

    it('uses Vercel client IPs as independent rate-limit keys', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VERCEL', '1');
      const db = await createTestDb();
      const vercelApp = createTestApp(db);

      expect(vercelApp.get('trust proxy')).toBe(1);

      const vercelServer = await createTestServer(db);
      const first = await request(vercelServer)
        .get('/api/health')
        .set('X-Forwarded-For', '198.51.100.10')
        .expect(200);
      const second = await request(vercelServer)
        .get('/api/health')
        .set('X-Forwarded-For', '198.51.100.11')
        .expect(200);

      expect(first.headers.ratelimit).toContain('remaining=599');
      expect(second.headers.ratelimit).toContain('remaining=599');

      vi.stubEnv('VERCEL', '0');
      const directApp = createTestApp(db);
      expect(directApp.get('trust proxy')).toBe(false);
    });
  });
});
