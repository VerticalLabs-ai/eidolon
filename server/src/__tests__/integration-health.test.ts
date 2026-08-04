import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import { eq, and, sql } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';
import {
  checkIntegrationHealth,
  _setDnsLookupForTesting,
  _resetDnsLookupForTesting,
  type IntegrationRow,
} from '../services/integration-health-checker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The SSRF protection in integration-health-checker rejects private/loopback
 * addresses. Tests that bind local servers on 127.0.0.1 must set
 * EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE=true so the check is bypassed.
 * SSRF-specific tests leave the env var unset to verify protection.
 */
let savedAllowPrivate: string | undefined;

function allowPrivateAddresses(): void {
  savedAllowPrivate = process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE;
  process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE = 'true';
}

function restoreAllowPrivate(): void {
  if (savedAllowPrivate === undefined) {
    delete process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE;
  } else {
    process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE = savedAllowPrivate;
  }
}

async function createCompany(app: ReturnType<typeof createTestApp>, name: string) {
  const res = await request(app).post('/api/companies').send({ name }).expect(201);
  return res.body.data.id as string;
}

async function createProject(
  app: ReturnType<typeof createTestApp>,
  companyId: string,
  name: string,
) {
  const res = await request(app)
    .post(`/api/companies/${companyId}/projects`)
    .send({ name })
    .expect(201);
  return res.body.data.id as string;
}

async function createIntegration(
  app: ReturnType<typeof createTestApp>,
  companyId: string,
  opts: {
    name: string;
    type: string;
    provider: string;
    config?: Record<string, unknown>;
    credentials?: string;
    projectId?: string | null;
  },
) {
  const body: Record<string, unknown> = {
    name: opts.name,
    type: opts.type,
    provider: opts.provider,
    config: opts.config ?? {},
  };
  if (opts.credentials !== undefined) body.credentials = opts.credentials;
  if (opts.projectId !== undefined) body.projectId = opts.projectId;
  const res = await request(app)
    .post(`/api/companies/${companyId}/integrations`)
    .send(body)
    .expect(201);
  return res.body.data;
}

async function getIntegration(db: DbInstance, id: string) {
  const rows = await db.drizzle
    .select()
    .from(db.schema.integrations)
    .where(eq(db.schema.integrations.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Start a local HTTP server that records the incoming request method and
 * returns a configurable status code. Returns the server plus the URL and
 * a list of received requests.
 */
function startRecordingServer(
  status: number = 200,
  opts: { delayMs?: number; body?: Buffer; followRedirects?: boolean } = {},
): Promise<{ server: http.Server; url: string; requests: { method: string; path: string }[]; close: () => Promise<void> }> {
  const requests: { method: string; path: string }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', path: req.url ?? '/' });
    if (opts.delayMs) {
      setTimeout(() => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(opts.body ?? '{}');
      }, opts.delayMs);
      return;
    }
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(opts.body ?? '{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('integration health — real HTTP checks (VAL-HLT-001)', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let recorder: Awaited<ReturnType<typeof startRecordingServer>>;

  beforeEach(async () => {
    allowPrivateAddresses();
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Test Co');
    recorder = await startRecordingServer(200);
  });

  afterEach(async () => {
    await recorder.close();
    restoreAllowPrivate();
  });

  it('custom_api 2xx → healthy with http_head method (real HEAD request)', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'Custom API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: recorder.url },
      credentials: 'token-abc',
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    expect(res.body.data.healthStatus).toBe('healthy');
    expect(res.body.data.healthCheckMethod).toBe('http_head');
    expect(res.body.data.success).toBe(true);
    expect(res.body.data.healthError).toBeNull();

    // The server recorded a real HEAD request.
    expect(recorder.requests.some((r) => r.method === 'HEAD')).toBe(true);
  });

  it('webhook_out 2xx → healthy with http_head method', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'Outbound Webhook',
      type: 'webhook_out',
      provider: 'custom',
      config: { url: recorder.url },
      credentials: 'secret-xyz',
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    expect(res.body.data.healthStatus).toBe('healthy');
    expect(res.body.data.healthCheckMethod).toBe('http_head');
    expect(recorder.requests.some((r) => r.method === 'HEAD')).toBe(true);
  });

  it('custom_api non-2xx → error with non-empty healthError (VAL-HLT-006)', async () => {
    await recorder.close();
    recorder = await startRecordingServer(503);

    const integ = await createIntegration(app, companyId, {
      name: 'Failing API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: recorder.url },
      credentials: 'token-abc',
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    expect(res.body.data.healthStatus).toBe('error');
    expect(res.body.data.healthCheckMethod).toBe('http_head');
    expect(res.body.data.healthError).toBeTruthy();
    expect(res.body.data.success).toBe(false);
  });

  it('connection refused → error (VAL-HLT-006)', async () => {
    // Close the server so the port is unreachable, then target that port.
    const port = (recorder.server.address() as { port: number }).port;
    await recorder.close();

    const integ = await createIntegration(app, companyId, {
      name: 'Dead API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: `http://127.0.0.1:${port}` },
      credentials: 'token-abc',
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    expect(res.body.data.healthStatus).toBe('error');
    expect(res.body.data.healthError).toBeTruthy();
    expect(res.body.data.success).toBe(false);
  });

  it('timeout → error with bounded duration (VAL-HLT-009)', async () => {
    await recorder.close();
    recorder = await startRecordingServer(200, { delayMs: 500 });

    const start = Date.now();
    const result = await checkIntegrationHealth(
      {
        id: '1',
        type: 'custom_api',
        provider: 'custom',
        config: { baseUrl: recorder.url },
        credentialsEncrypted: 'token',
      },
      { timeoutMs: 200 },
    );
    const elapsed = Date.now() - start;

    expect(result.healthStatus).toBe('error');
    expect(result.healthError).toMatch(/timed out|timeout/i);
    // Bounded: must return well under the 500ms server delay.
    expect(elapsed).toBeLessThan(1000);
  });

  it('does not follow redirects — 3xx treated as error (VAL-HLT-009)', async () => {
    await recorder.close();
    // Server returns a 301 with a Location header.
    const redirectServer = http.createServer((req, res) => {
      res.writeHead(301, { location: 'http://127.0.0.1:1/elsewhere' });
      res.end();
    });
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
    const addr = redirectServer.address() as { port: number };
    const redirectUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const integ = await createIntegration(app, companyId, {
        name: 'Redirect API',
        type: 'custom_api',
        provider: 'custom',
        config: { baseUrl: redirectUrl },
        credentials: 'token-abc',
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
        .expect(200);

      expect(res.body.data.healthStatus).toBe('error');
      expect(res.body.data.httpStatus).toBe(301);
      expect(res.body.data.healthError).toMatch(/301/);
    } finally {
      await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// Truthfulness invariant (VAL-HLT-002)
// ---------------------------------------------------------------------------

describe('integration health — truthfulness invariant (VAL-HLT-002)', () => {
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Truth Co');
  });

  it('never returns healthy without a real network check (unit invariant)', async () => {
    // Missing credentials → unknown, no real check.
    const noCreds = await checkIntegrationHealth({
      id: '1',
      type: 'custom_api',
      provider: 'custom',
      config: { url: 'http://127.0.0.1:1' },
      credentialsEncrypted: null,
    });
    expect(noCreds.healthStatus).toBe('unknown');
    expect(noCreds.realCheckPerformed).toBe(false);

    // Catalog provider without checker → unknown, no real check.
    const catalog = await checkIntegrationHealth({
      id: '2',
      type: 'github',
      provider: 'github',
      config: {},
      credentialsEncrypted: 'token',
    });
    expect(catalog.healthStatus).toBe('unknown');
    expect(catalog.realCheckPerformed).toBe(false);

    // HTTP type with no URL → unknown, no real check.
    const noUrl = await checkIntegrationHealth({
      id: '3',
      type: 'custom_api',
      provider: 'custom',
      config: {},
      credentialsEncrypted: 'token',
    });
    expect(noUrl.healthStatus).toBe('unknown');
    expect(noUrl.realCheckPerformed).toBe(false);
  });

  it('newly created integration starts unknown, not healthy (VAL-HLT-007)', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'New API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://127.0.0.1:1' },
      credentials: 'token',
    });

    expect(integ.healthStatus).toBe('unknown');
    // Lifecycle status is separate from health.
    expect(integ.status).toBe('active');

    const list = await request(app)
      .get(`/api/companies/${companyId}/integrations`)
      .expect(200);
    const found = list.body.data.find((i: { id: string }) => i.id === integ.id);
    expect(found.healthStatus).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Unimplemented catalog providers (VAL-HLT-003)
// ---------------------------------------------------------------------------

describe('integration health — unimplemented catalog providers (VAL-HLT-003)', () => {
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Catalog Co');
  });

  const providers = ['github', 'slack', 'notion', 'linear', 'gmail', 'calendar', 'stripe', 'hubspot'];
  for (const type of providers) {
    it(`${type} returns unknown with healthCheckMethod=none`, async () => {
      const integ = await createIntegration(app, companyId, {
        name: `${type} integration`,
        type,
        provider: type,
        config: {},
        credentials: 'some-credential',
      });

      const res = await request(app)
        .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
        .expect(200);

      expect(res.body.data.healthStatus).toBe('unknown');
      expect(res.body.data.healthCheckMethod).toBe('none');
      expect(res.body.data.message).toBeTruthy();
      expect(res.body.data.success).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Missing credentials (VAL-HLT-004)
// ---------------------------------------------------------------------------

describe('integration health — missing credentials (VAL-HLT-004)', () => {
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'No Creds Co');
  });

  it('custom_api without credentials → unknown with none method', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'No creds API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://127.0.0.1:1' },
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    expect(res.body.data.healthStatus).toBe('unknown');
    expect(res.body.data.healthCheckMethod).toBe('none');
    expect(res.body.data.message).toMatch(/credential/i);
    expect(res.body.data.success).toBe(false);
  });

  it('github without credentials → unknown with none method', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'No creds github',
      type: 'github',
      provider: 'github',
      config: {},
    });

    const res = await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    expect(res.body.data.healthStatus).toBe('unknown');
    expect(res.body.data.healthCheckMethod).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// Health field persistence (VAL-HLT-005)
// ---------------------------------------------------------------------------

describe('integration health — persistence (VAL-HLT-005)', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let recorder: Awaited<ReturnType<typeof startRecordingServer>>;

  beforeEach(async () => {
    allowPrivateAddresses();
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Persist Co');
    recorder = await startRecordingServer(200);
  });

  afterEach(async () => {
    await recorder.close();
    restoreAllowPrivate();
  });

  it('persists all four health fields after a successful check', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'Persist API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: recorder.url },
      credentials: 'token',
    });

    await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    const row = await getIntegration(db, integ.id);
    expect(row).not.toBeNull();
    expect(row!.healthStatus).toBe('healthy');
    expect(row!.healthCheckMethod).toBe('http_head');
    expect(row!.healthError).toBeNull();
    expect(row!.lastHealthCheckAt).not.toBeNull();
  });

  it('persists error fields after a failed check (VAL-HLT-006)', async () => {
    await recorder.close();
    recorder = await startRecordingServer(500);

    const integ = await createIntegration(app, companyId, {
      name: 'Persist Error API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: recorder.url },
      credentials: 'token',
    });

    await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    const row = await getIntegration(db, integ.id);
    expect(row!.healthStatus).toBe('error');
    expect(row!.healthError).toBeTruthy();
    expect(row!.lastHealthCheckAt).not.toBeNull();
  });

  it('list response reflects persisted health fields', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'List API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: recorder.url },
      credentials: 'token',
    });

    await request(app)
      .post(`/api/companies/${companyId}/integrations/${integ.id}/test`)
      .expect(200);

    const list = await request(app)
      .get(`/api/companies/${companyId}/integrations`)
      .expect(200);

    const found = list.body.data.find((i: { id: string }) => i.id === integ.id);
    expect(found.healthStatus).toBe('healthy');
    expect(found.healthCheckMethod).toBe('http_head');
    expect(found.healthError).toBeNull();
    expect(found.lastHealthCheckAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Project scoping (VAL-HLT-008)
// ---------------------------------------------------------------------------

describe('integration health — project scoping (VAL-HLT-008)', () => {
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let otherCompanyId: string;

  beforeEach(async () => {
    const db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Scope Co');
    otherCompanyId = await createCompany(app, 'Other Co');
  });

  it('create accepts optional projectId owned by the company', async () => {
    const projectId = await createProject(app, companyId, 'Proj A');

    const integ = await createIntegration(app, companyId, {
      name: 'Scoped API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://127.0.0.1:1' },
      credentials: 'token',
      projectId,
    });

    expect(integ.projectId).toBe(projectId);
  });

  it('create rejects a foreign-company projectId', async () => {
    const foreignProject = await createProject(app, otherCompanyId, 'Foreign Proj');

    const res = await request(app)
      .post(`/api/companies/${companyId}/integrations`)
      .send({
        name: 'Bad Scope',
        type: 'custom_api',
        provider: 'custom',
        config: {},
        credentials: 'token',
        projectId: foreignProject,
      });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('create without projectId is valid (company-scoped)', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'Unscoped API',
      type: 'custom_api',
      provider: 'custom',
      config: {},
      credentials: 'token',
    });
    expect(integ.projectId).toBeNull();
  });

  it('GET ?project= filters to the requested project', async () => {
    const projectId = await createProject(app, companyId, 'Filter Proj');
    const otherProject = await createProject(app, companyId, 'Other Proj');

    const scoped = await createIntegration(app, companyId, {
      name: 'Scoped',
      type: 'custom_api',
      provider: 'custom',
      config: {},
      credentials: 'token',
      projectId,
    });
    const otherScoped = await createIntegration(app, companyId, {
      name: 'Other Scoped',
      type: 'custom_api',
      provider: 'custom',
      config: {},
      credentials: 'token',
      projectId: otherProject,
    });
    const unscoped = await createIntegration(app, companyId, {
      name: 'Unscoped',
      type: 'custom_api',
      provider: 'custom',
      config: {},
      credentials: 'token',
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/integrations?project=${projectId}`)
      .expect(200);

    const ids = res.body.data.map((i: { id: string }) => i.id);
    expect(ids).toContain(scoped.id);
    expect(ids).not.toContain(otherScoped.id);
    expect(ids).not.toContain(unscoped.id);
    // Every returned entry belongs to the requested project.
    for (const entry of res.body.data) {
      expect(entry.projectId).toBe(projectId);
    }
  });

  it('cross-company integration test is rejected (404)', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'Cross Co',
      type: 'custom_api',
      provider: 'custom',
      config: {},
      credentials: 'token',
    });

    const res = await request(app)
      .post(`/api/companies/${otherCompanyId}/integrations/${integ.id}/test`);

    expect(res.status).toBe(404);
  });

  it('cross-company integration fetch is rejected (404)', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'Cross Fetch',
      type: 'custom_api',
      provider: 'custom',
      config: {},
      credentials: 'token',
    });

    const patchRes = await request(app)
      .patch(`/api/companies/${otherCompanyId}/integrations/${integ.id}`)
      .send({ name: 'Stolen' });
    expect(patchRes.status).toBe(404);

    const delRes = await request(app)
      .delete(`/api/companies/${otherCompanyId}/integrations/${integ.id}`);
    expect(delRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Bounded checks (VAL-HLT-009) — unit level
// ---------------------------------------------------------------------------

describe('integration health — bounded checks (VAL-HLT-009)', () => {
  beforeEach(() => {
    allowPrivateAddresses();
  });

  afterEach(() => {
    restoreAllowPrivate();
  });

  it('bounded HEAD respects a short timeout option', async () => {
    const recorder = await startRecordingServer(200, { delayMs: 3000 });
    try {
      const start = Date.now();
      const result = await checkIntegrationHealth(
        {
          id: '1',
          type: 'custom_api',
          provider: 'custom',
          config: { baseUrl: recorder.url },
          credentialsEncrypted: 'token',
        },
        { timeoutMs: 500 },
      );
      const elapsed = Date.now() - start;

      expect(result.healthStatus).toBe('error');
      expect(result.healthError).toMatch(/timed out|timeout/i);
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await recorder.close();
    }
  });

  it('oversized response is handled without exhaustion', async () => {
    // Return a large body on a HEAD — most servers omit the body for HEAD,
    // but if present it must be bounded.
    const bigBody = Buffer.alloc(2 * 1024 * 1024, 'x');
    const recorder = await startRecordingServer(200, { body: bigBody });
    try {
      const result = await checkIntegrationHealth({
        id: '1',
        type: 'custom_api',
        provider: 'custom',
        config: { baseUrl: recorder.url },
        credentialsEncrypted: 'token',
      });

      // Either healthy (HEAD ignored body) or error (body exceeded bound).
      // The key invariant: it terminates and does not hang or exhaust resources.
      expect(['healthy', 'error']).toContain(result.healthStatus);
    } finally {
      await recorder.close();
    }
  });
});

// ---------------------------------------------------------------------------
// New integrations start unknown (VAL-HLT-007) — direct DB invariant
// ---------------------------------------------------------------------------

describe('integration health — new integrations start unknown (VAL-HLT-007)', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Unknown Start Co');
  });

  it('DB row has healthStatus=unknown immediately after insert', async () => {
    const integ = await createIntegration(app, companyId, {
      name: 'Fresh',
      type: 'github',
      provider: 'github',
      config: {},
      credentials: 'token',
    });

    const row = await getIntegration(db, integ.id);
    expect(row!.healthStatus).toBe('unknown');
    expect(row!.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// SSRF protection — private/loopback address rejection and DNS pinning
// ---------------------------------------------------------------------------

describe('integration health — SSRF protection', () => {
  beforeEach(() => {
    // Ensure private address checks are enforced for these tests.
    delete process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE;
  });

  afterEach(() => {
    delete process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE;
    _resetDnsLookupForTesting();
  });

  // --- Private IPv4 literal rejection ----------------------------------

  const privateIpv4Cases: Array<[string, string]> = [
    ['127.0.0.1', '127.0.0.0/8 loopback'],
    ['127.255.255.255', '127.0.0.0/8 loopback high'],
    ['10.0.0.1', '10.0.0.0/8 private'],
    ['10.255.255.255', '10.0.0.0/8 private high'],
    ['192.168.1.1', '192.168.0.0/16 private'],
    ['192.168.0.0', '192.168.0.0/16 private low'],
    ['172.16.0.1', '172.16.0.0/12 private low'],
    ['172.31.255.255', '172.16.0.0/12 private high'],
    ['169.254.1.1', '169.254.0.0/16 link-local'],
    ['0.0.0.0', '0.0.0.0/8 unspecified'],
  ];

  for (const [ip, label] of privateIpv4Cases) {
    it(`rejects private IPv4 ${ip} (${label})`, async () => {
      const result = await checkIntegrationHealth({
        id: '1',
        type: 'custom_api',
        provider: 'custom',
        config: { baseUrl: `http://${ip}:80` },
        credentialsEncrypted: 'token',
      });

      expect(result.healthStatus).toBe('error');
      expect(result.realCheckPerformed).toBe(true);
      expect(result.healthError).toMatch(/private|loopback|SSRF|blocked/i);
    });
  }

  // --- Non-private IPv4 should NOT be SSRF-blocked (may fail to connect) -

  it('does not SSRF-block 172.15.0.1 (just below 172.16 range)', async () => {
    const result = await checkIntegrationHealth({
      id: '1',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://172.15.0.1:80' },
      credentialsEncrypted: 'token',
      // Short timeout so it fails fast (connection refused / timeout, not SSRF).
    }, { timeoutMs: 500 });

    expect(result.healthStatus).toBe('error');
    expect(result.healthError).not.toMatch(/SSRF|private|loopback|blocked/i);
  });

  it('does not SSRF-block 172.32.0.1 (just above 172.31 range)', async () => {
    const result = await checkIntegrationHealth({
      id: '1',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://172.32.0.1:80' },
      credentialsEncrypted: 'token',
    }, { timeoutMs: 500 });

    expect(result.healthStatus).toBe('error');
    expect(result.healthError).not.toMatch(/SSRF|private|loopback|blocked/i);
  });

  // --- localhost hostname rejection ------------------------------------

  it('rejects "localhost" hostname', async () => {
    const result = await checkIntegrationHealth({
      id: '1',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://localhost:80' },
      credentialsEncrypted: 'token',
    }, { timeoutMs: 500 });

    expect(result.healthStatus).toBe('error');
    expect(result.realCheckPerformed).toBe(true);
    expect(result.healthError).toMatch(/localhost/i);
  });

  // --- IPv6 loopback rejection -----------------------------------------

  it('rejects IPv6 loopback [::1]', async () => {
    const result = await checkIntegrationHealth({
      id: '1',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://[::1]:80' },
      credentialsEncrypted: 'token',
    }, { timeoutMs: 500 });

    expect(result.healthStatus).toBe('error');
    expect(result.realCheckPerformed).toBe(true);
    expect(result.healthError).toMatch(/private|loopback|SSRF|blocked/i);
  });

  it('rejects IPv6 unspecified [::]', async () => {
    const result = await checkIntegrationHealth({
      id: '1',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://[::]:80' },
      credentialsEncrypted: 'token',
    }, { timeoutMs: 500 });

    expect(result.healthStatus).toBe('error');
    expect(result.realCheckPerformed).toBe(true);
    expect(result.healthError).toMatch(/private|loopback|SSRF|blocked/i);
  });

  // --- DNS pre-resolution catches private addresses for hostnames -------

  it('rejects hostname that resolves to a private address (DNS pre-resolution)', async () => {
    // Mock DNS to return 127.0.0.1 for a public-looking hostname.
    _setDnsLookupForTesting(async () => [
      { address: '127.0.0.1', family: 4 },
    ]);

    try {
      const result = await checkIntegrationHealth({
        id: '1',
        type: 'custom_api',
        provider: 'custom',
        config: { baseUrl: 'http://rebind.example.com:80' },
        credentialsEncrypted: 'token',
      }, { timeoutMs: 1000 });

      expect(result.healthStatus).toBe('error');
      expect(result.realCheckPerformed).toBe(true);
      expect(result.healthError).toMatch(/private|loopback|SSRF|blocked/i);
      expect(result.healthError).toMatch(/rebind\.example\.com|127\.0\.0\.1/);
    } finally {
      _resetDnsLookupForTesting();
    }
  });

  // --- DNS pinning: request uses the pre-resolved address --------------

  it('pins the resolved address in the HTTP request (DNS rebinding protection)', async () => {
    // Start a local server on 127.0.0.1.
    const recorder = await startRecordingServer(200);
    try {
      // Allow private addresses so the private check is bypassed, but
      // the pinning mechanism still applies: DNS is mocked to return
      // 127.0.0.1, and the request must use that pinned address to
      // reach the local server.
      process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE = 'true';

      let lookupCalls = 0;
      _setDnsLookupForTesting(async () => {
        lookupCalls++;
        return [{ address: '127.0.0.1', family: 4 }];
      });

      try {
        const result = await checkIntegrationHealth({
          id: '1',
          type: 'custom_api',
          provider: 'custom',
          config: { baseUrl: `http://pinned.example.com:${(recorder.server.address() as { port: number }).port}` },
          credentialsEncrypted: 'token',
        });

        // The request reached the local server via the pinned 127.0.0.1.
        expect(result.healthStatus).toBe('healthy');
        expect(result.realCheckPerformed).toBe(true);
        expect(recorder.requests.some((r) => r.method === 'HEAD')).toBe(true);

        // DNS lookup was called once during pre-resolution.
        expect(lookupCalls).toBe(1);
      } finally {
        _resetDnsLookupForTesting();
      }
    } finally {
      await recorder.close();
    }
  });

  it('pins address and does not re-resolve DNS during the HTTP request', async () => {
    // Start a local server on 127.0.0.1.
    const recorder = await startRecordingServer(200);
    try {
      process.env.EIDOLON_HEALTH_CHECK_ALLOW_PRIVATE = 'true';

      let lookupCalls = 0;
      _setDnsLookupForTesting(async () => {
        lookupCalls++;
        if (lookupCalls === 1) {
          // First call (pre-resolution) returns 127.0.0.1.
          return [{ address: '127.0.0.1', family: 4 }];
        }
        // Second call would be a DNS rebinding attack — return a different address.
        return [{ address: '10.0.0.1', family: 4 }];
      });

      try {
        const result = await checkIntegrationHealth({
          id: '1',
          type: 'custom_api',
          provider: 'custom',
          config: { baseUrl: `http://rebind-test.example.com:${(recorder.server.address() as { port: number }).port}` },
          credentialsEncrypted: 'token',
        });

        // The request used the pinned 127.0.0.1 and reached the local server.
        expect(result.healthStatus).toBe('healthy');
        expect(recorder.requests.some((r) => r.method === 'HEAD')).toBe(true);
        // DNS lookup was called exactly once (pre-resolution only).
        // The HTTP request used the lookup callback, not DNS.
        expect(lookupCalls).toBe(1);
      } finally {
        _resetDnsLookupForTesting();
      }
    } finally {
      await recorder.close();
    }
  });

  // --- IPv4-mapped IPv6 rejection --------------------------------------

  it('rejects IPv4-mapped IPv6 loopback [::ffff:127.0.0.1]', async () => {
    const result = await checkIntegrationHealth({
      id: '1',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://[::ffff:127.0.0.1]:80' },
      credentialsEncrypted: 'token',
    }, { timeoutMs: 500 });

    expect(result.healthStatus).toBe('error');
    expect(result.realCheckPerformed).toBe(true);
    expect(result.healthError).toMatch(/private|loopback|SSRF|blocked/i);
  });
});
