import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestDb, createTestApp } from '../test-utils.js';

describe('Health API', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    const db = createTestDb();
    app = createTestApp(db);
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
  });
});
