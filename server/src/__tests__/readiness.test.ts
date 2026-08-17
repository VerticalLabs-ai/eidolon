import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createTestDb } from '../test-utils.js';
import { checkReadiness } from '../services/readiness.js';
import {
  externalCircuitKey,
  getProviderCircuitSnapshot,
  ProviderCircuitOpenError,
  resetProviderCircuitsForTests,
  withProviderCircuitBreaker,
} from '../services/provider-circuit-breaker.js';
import type { DbInstance } from '../types.js';

describe('readiness', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    resetProviderCircuitsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetProviderCircuitsForTests();
  });

  describe('GET /api/ready', () => {
    it('reports every dependency and returns 200 when all are reachable', async () => {
      const res = await request(app).get('/api/ready').expect(200);

      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(res.body.checks).toEqual([
        { name: 'database', ok: true, durationMs: expect.any(Number) },
      ]);
    });

    it('returns 503 and marks the dependency down when the database is unreachable', async () => {
      const brokenDb = {
        ...db,
        drizzle: {
          execute: () => Promise.reject(new Error('connection refused')),
        },
      } as unknown as DbInstance;

      const brokenApp = createTestApp(brokenDb);
      const res = await request(brokenApp).get('/api/ready').expect(503);

      expect(res.body.status).toBe('degraded');
      expect(res.body.checks).toEqual([
        { name: 'database', ok: false, durationMs: expect.any(Number) },
      ]);
    });

    it('never leaks the driver error text for a failed probe', async () => {
      const brokenDb = {
        ...db,
        drizzle: {
          execute: () =>
            Promise.reject(new Error('connect ECONNREFUSED 10.1.2.3:5432 role "eidolon_prod"')),
        },
      } as unknown as DbInstance;

      const res = await request(createTestApp(brokenDb)).get('/api/ready').expect(503);

      const serialized = JSON.stringify(res.body);
      expect(serialized).not.toContain('ECONNREFUSED');
      expect(serialized).not.toContain('10.1.2.3');
      expect(serialized).not.toContain('eidolon_prod');
    });

    it('does not carry circuit-breaker detail on the unauthenticated route', async () => {
      const failing = () => Promise.reject(new Error('provider down'));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(withProviderCircuitBreaker('openai', failing)).rejects.toThrow();
      }
      expect(getProviderCircuitSnapshot().some((circuit) => circuit.open)).toBe(true);

      const res = await request(app).get('/api/ready').expect(200);
      expect(JSON.stringify(res.body)).not.toContain('openai');
    });

    it('keeps the liveness contract on /api/health independent of readiness', async () => {
      const brokenDb = {
        ...db,
        drizzle: { execute: () => Promise.reject(new Error('down')) },
      } as unknown as DbInstance;
      const brokenApp = createTestApp(brokenDb);

      await request(brokenApp).get('/api/ready').expect(503);
      const liveness = await request(brokenApp).get('/api/health').expect(200);
      expect(liveness.body.status).toBe('ok');
      expect(liveness.body).toHaveProperty('uptime');
      expect(liveness.body).toHaveProperty('wsClients');
    });
  });

  describe('checkReadiness', () => {
    it('resolves degraded rather than hanging when a probe never settles', async () => {
      const hangingDb = {
        ...db,
        drizzle: { execute: () => new Promise(() => {}) },
      } as unknown as DbInstance;

      const report = await checkReadiness(hangingDb);
      expect(report.status).toBe('degraded');
      expect(report.checks[0]).toMatchObject({ name: 'database', ok: false });
    }, 10_000);
  });
});

describe('circuit breaker coverage for non-LLM dependencies', () => {
  beforeEach(() => {
    resetProviderCircuitsForTests();
  });

  afterEach(() => {
    resetProviderCircuitsForTests();
  });

  it('derives a stable key per endpoint without carrying the address', () => {
    const first = externalCircuitKey('mcp', 'https://tenant.example.com/mcp');
    const second = externalCircuitKey('mcp', 'https://tenant.example.com/mcp');
    const other = externalCircuitKey('mcp', 'https://other.example.com/mcp');

    expect(first).toBe(second);
    expect(first).not.toBe(other);
    expect(first).toMatch(/^mcp:[0-9a-f]{12}$/);
    expect(first).not.toContain('tenant.example.com');
  });

  it('opens per endpoint so one dead dependency does not suppress another', async () => {
    const dead = externalCircuitKey('remote_runtime', 'https://dead.example.com');
    const healthy = externalCircuitKey('remote_runtime', 'https://healthy.example.com');
    const failing = () => Promise.reject(new Error('unreachable'));

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(withProviderCircuitBreaker(dead, failing)).rejects.toThrow('unreachable');
    }

    await expect(withProviderCircuitBreaker(dead, failing)).rejects.toBeInstanceOf(
      ProviderCircuitOpenError,
    );
    await expect(withProviderCircuitBreaker(healthy, async () => 'served')).resolves.toBe('served');
  });

  it('short-circuits without invoking the dependency once open', async () => {
    const key = externalCircuitKey('mcp', 'https://dead.example.com/mcp');
    const failing = () => Promise.reject(new Error('unreachable'));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(withProviderCircuitBreaker(key, failing)).rejects.toThrow('unreachable');
    }

    const attempted = vi.fn(() => Promise.resolve('should not run'));
    await expect(withProviderCircuitBreaker(key, attempted)).rejects.toBeInstanceOf(
      ProviderCircuitOpenError,
    );
    expect(attempted).not.toHaveBeenCalled();
  });

  it('exposes open state through the snapshot without an extra call', async () => {
    const key = externalCircuitKey('mcp', 'https://dead.example.com/mcp');
    const failing = () => Promise.reject(new Error('unreachable'));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(withProviderCircuitBreaker(key, failing)).rejects.toThrow('unreachable');
    }

    const snapshot = getProviderCircuitSnapshot();
    const circuit = snapshot.find((entry) => entry.provider === key);
    expect(circuit).toMatchObject({ open: true, consecutiveFailures: 5 });
    expect(circuit?.retryAfterMs).toBeGreaterThan(0);
  });

  it('clears the circuit from the snapshot after a successful call', async () => {
    const key = externalCircuitKey('mcp', 'https://flaky.example.com/mcp');
    await expect(
      withProviderCircuitBreaker(key, () => Promise.reject(new Error('blip'))),
    ).rejects.toThrow('blip');
    expect(getProviderCircuitSnapshot().map((entry) => entry.provider)).toContain(key);

    await expect(withProviderCircuitBreaker(key, async () => 'ok')).resolves.toBe('ok');
    expect(getProviderCircuitSnapshot().map((entry) => entry.provider)).not.toContain(key);
  });
});

describe('circuit breaker metrics', () => {
  beforeEach(() => {
    resetProviderCircuitsForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetProviderCircuitsForTests();
  });

  it('publishes open circuits by kind without exposing the circuit key', async () => {
    vi.stubEnv('METRICS_TOKEN', 'metrics-test-token');
    const app = createTestApp(await createTestDb());

    const key = externalCircuitKey('mcp', 'https://tenant.example.com/mcp');
    const failing = () => Promise.reject(new Error('unreachable'));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(withProviderCircuitBreaker(key, failing)).rejects.toThrow('unreachable');
    }

    const res = await request(app)
      .get('/api/metrics')
      .set('Authorization', 'Bearer metrics-test-token')
      .expect(200);

    expect(res.text).toContain('eidolon_provider_circuits_open{kind="mcp"} 1');
    expect(res.text).toContain('eidolon_provider_circuits_open{kind="remote_runtime"} 0');
    expect(res.text).not.toContain(key.split(':')[1]);
  });
});
