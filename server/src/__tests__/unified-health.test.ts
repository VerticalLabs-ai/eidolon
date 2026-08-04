import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestApp, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

async function insertMcpServer(
  db: DbInstance,
  companyId: string,
  opts: {
    name: string;
    transport?: string;
    status: 'connected' | 'disconnected' | 'error';
    lastConnectedAt?: Date | null;
    url?: string | null;
    command?: string | null;
  },
) {
  const { mcpServers } = db.schema;
  const now = new Date();
  const [row] = await db.drizzle
    .insert(mcpServers)
    .values({
      id: randomUUID(),
      companyId,
      name: opts.name,
      transport: (opts.transport ?? 'stdio') as 'stdio' | 'sse' | 'streamable-http',
      command: opts.command ?? null,
      args: [],
      env: {},
      url: opts.url ?? null,
      status: opts.status,
      availableTools: [],
      availableResources: [],
      lastConnectedAt: opts.lastConnectedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row;
}

async function getMcpServer(db: DbInstance, id: string) {
  const rows = await db.drizzle
    .select()
    .from(db.schema.mcpServers)
    .where(eq(db.schema.mcpServers.id, id))
    .limit(1);
  return rows[0] ?? null;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// Unified health surface — GET /integrations/health
// ---------------------------------------------------------------------------

describe('unified health surface — GET /integrations/health (VAL-HLT-010, 011, 012)', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Health Co');
    otherCompanyId = await createCompany(app, 'Other Health Co');
    projectId = await createProject(app, companyId, 'Proj Alpha');
    otherProjectId = await createProject(app, companyId, 'Proj Beta');
  });

  it('returns unified list with both integration and MCP entries (VAL-HLT-010)', async () => {
    await createIntegration(app, companyId, {
      name: 'GitHub',
      type: 'github',
      provider: 'github',
      credentials: 'token',
    });

    await insertMcpServer(db, companyId, {
      name: 'Echo MCP',
      transport: 'stdio',
      status: 'disconnected',
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    const types = res.body.data.map((e: { type: string }) => e.type);
    expect(types).toContain('integration');
    expect(types).toContain('mcp_server');
  });

  it('every entry has the canonical shape with all required fields (VAL-HLT-010)', async () => {
    await createIntegration(app, companyId, {
      name: 'Scoped API',
      type: 'custom_api',
      provider: 'custom',
      config: { baseUrl: 'http://127.0.0.1:1' },
      credentials: 'token',
      projectId,
    });

    await insertMcpServer(db, companyId, {
      name: 'Connected MCP',
      transport: 'streamable-http',
      status: 'connected',
      lastConnectedAt: new Date(),
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    for (const entry of res.body.data) {
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('healthStatus');
      expect(entry).toHaveProperty('lastHealthCheckAt');
      expect(entry).toHaveProperty('healthError');
      expect(entry).toHaveProperty('projectId');
      expect(['integration', 'mcp_server']).toContain(entry.type);
      expect(['healthy', 'degraded', 'error', 'unknown']).toContain(entry.healthStatus);
    }
  });

  it('integration entries include provider, MCP entries include transport', async () => {
    await createIntegration(app, companyId, {
      name: 'Slack',
      type: 'slack',
      provider: 'slack',
      credentials: 'token',
    });

    await insertMcpServer(db, companyId, {
      name: 'SSE MCP',
      transport: 'sse',
      status: 'disconnected',
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    const integEntry = res.body.data.find((e: { type: string }) => e.type === 'integration');
    const mcpEntry = res.body.data.find((e: { type: string }) => e.type === 'mcp_server');

    expect(integEntry.provider).toBe('slack');
    expect(mcpEntry.transport).toBe('sse');
  });

  it('?project= filter returns only entries for that project (VAL-HLT-011)', async () => {
    const scopedInteg = await createIntegration(app, companyId, {
      name: 'Scoped API',
      type: 'custom_api',
      provider: 'custom',
      credentials: 'token',
      projectId,
    });
    const otherScopedInteg = await createIntegration(app, companyId, {
      name: 'Other Scoped',
      type: 'custom_api',
      provider: 'custom',
      credentials: 'token',
      projectId: otherProjectId,
    });
    const unscopedInteg = await createIntegration(app, companyId, {
      name: 'Unscoped',
      type: 'custom_api',
      provider: 'custom',
      credentials: 'token',
    });

    // MCP server (no projectId — should be excluded by project filter)
    await insertMcpServer(db, companyId, {
      name: 'MCP No Project',
      status: 'disconnected',
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/integrations/health?project=${projectId}`)
      .expect(200);

    const ids = res.body.data.map((e: { id: string }) => e.id);
    expect(ids).toContain(scopedInteg.id);
    expect(ids).not.toContain(otherScopedInteg.id);
    expect(ids).not.toContain(unscopedInteg.id);

    // No MCP entries when project filter is applied (MCP servers have no projectId).
    const types = res.body.data.map((e: { type: string }) => e.type);
    expect(types).not.toContain('mcp_server');

    // Every returned entry belongs to the requested project.
    for (const entry of res.body.data) {
      expect(entry.projectId).toBe(projectId);
    }
  });

  it('?project= filter excludes unscoped entries (VAL-HLT-011)', async () => {
    await createIntegration(app, companyId, {
      name: 'Unscoped',
      type: 'custom_api',
      provider: 'custom',
      credentials: 'token',
    });
    await createIntegration(app, companyId, {
      name: 'Scoped',
      type: 'custom_api',
      provider: 'custom',
      credentials: 'token',
      projectId,
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/integrations/health?project=${projectId}`)
      .expect(200);

    for (const entry of res.body.data) {
      expect(entry.projectId).not.toBeNull();
      expect(entry.projectId).toBe(projectId);
    }
  });

  it('MCP status maps truthfully: connected→healthy, error→error, disconnected→unknown (VAL-HLT-012)', async () => {
    await insertMcpServer(db, companyId, {
      name: 'Connected Server',
      status: 'connected',
      lastConnectedAt: new Date(),
    });
    await insertMcpServer(db, companyId, {
      name: 'Error Server',
      status: 'error',
    });
    await insertMcpServer(db, companyId, {
      name: 'Disconnected Server',
      status: 'disconnected',
    });

    const res = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    const mcpEntries = res.body.data.filter((e: { type: string }) => e.type === 'mcp_server');
    const byName = Object.fromEntries(mcpEntries.map((e: { name: string }) => [e.name, e]));

    expect(byName['Connected Server'].healthStatus).toBe('healthy');
    expect(byName['Connected Server'].lastHealthCheckAt).not.toBeNull();

    expect(byName['Error Server'].healthStatus).toBe('error');

    expect(byName['Disconnected Server'].healthStatus).toBe('unknown');
  });

  it('unified health listing is isolated to the requested company', async () => {
    const coAInteg = await createIntegration(app, companyId, {
      name: 'Co A Integ',
      type: 'custom_api',
      provider: 'custom',
      credentials: 'token',
    });
    await insertMcpServer(db, companyId, {
      name: 'Co A MCP',
      status: 'connected',
    });

    const coBInteg = await createIntegration(app, otherCompanyId, {
      name: 'Co B Integ',
      type: 'custom_api',
      provider: 'custom',
      credentials: 'token',
    });
    await insertMcpServer(db, otherCompanyId, {
      name: 'Co B MCP',
      status: 'error',
    });

    const resA = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    const idsA = resA.body.data.map((e: { id: string }) => e.id);
    expect(idsA).toContain(coAInteg.id);
    expect(idsA).not.toContain(coBInteg.id);

    const resB = await request(app)
      .get(`/api/companies/${otherCompanyId}/integrations/health`)
      .expect(200);

    const idsB = resB.body.data.map((e: { id: string }) => e.id);
    expect(idsB).toContain(coBInteg.id);
    expect(idsB).not.toContain(coAInteg.id);

    // Disjoint sets
    for (const id of idsA) {
      expect(idsB).not.toContain(id);
    }
  });

  it('returns empty data array when company has no integrations or MCP servers', async () => {
    const res = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    expect(res.body.data).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MCP health re-check — POST /mcp/servers/:id/health
// ---------------------------------------------------------------------------

describe('MCP health re-check — POST /mcp/servers/:id/health (VAL-HLT-013, 014, 015)', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let otherCompanyId: string;
  let tempDir: string;
  let prevStdioEnabled: string | undefined;
  let prevStdioAllowlist: string | undefined;
  let prevRemoteHostAllowlist: string | undefined;

  beforeEach(async () => {
    prevStdioEnabled = process.env.EIDOLON_ENABLE_TENANT_STDIO_MCP;
    prevStdioAllowlist = process.env.EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST;
    prevRemoteHostAllowlist = process.env.EIDOLON_MCP_REMOTE_HOST_ALLOWLIST;

    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'MCP Health Co');
    otherCompanyId = await createCompany(app, 'Other MCP Health Co');

    const fixtureRoot = path.resolve(process.cwd(), 'server', '.tmp-tests');
    await fs.mkdir(fixtureRoot, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(fixtureRoot, 'eidolon-unified-health-'));
  });

  afterEach(async () => {
    restoreEnv('EIDOLON_ENABLE_TENANT_STDIO_MCP', prevStdioEnabled);
    restoreEnv('EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST', prevStdioAllowlist);
    restoreEnv('EIDOLON_MCP_REMOTE_HOST_ALLOWLIST', prevRemoteHostAllowlist);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('successful re-check connects, discovers tools, and persists status=connected (VAL-HLT-013)', async () => {
    process.env.EIDOLON_ENABLE_TENANT_STDIO_MCP = 'true';

    const serverPath = path.join(tempDir, 'echo-mcp-server.mjs');
    process.env.EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST = `${process.execPath} ${serverPath}`;
    await fs.writeFile(
      serverPath,
      `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-test", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo text back to the caller.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

await server.connect(new StdioServerTransport());
`,
      'utf8',
    );

    const registered = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Echo MCP',
        transport: 'stdio',
        command: process.execPath,
        args: [serverPath],
      })
      .expect(201);

    const serverId = registered.body.data.id;

    // Initially disconnected
    expect(registered.body.data.status).toBe('disconnected');

    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers/${serverId}/health`)
      .expect(200);

    expect(res.body.data.id).toBe(serverId);
    expect(res.body.data.status).toBe('connected');
    expect(res.body.data.lastConnectedAt).not.toBeNull();
    expect(res.body.data.toolCount).toBeGreaterThan(0);

    // Persisted in DB
    const row = await getMcpServer(db, serverId);
    expect(row!.status).toBe('connected');
    expect(row!.lastConnectedAt).not.toBeNull();
    expect((row!.availableTools ?? []).length).toBeGreaterThan(0);
  });

  it('failed re-check persists status=error and returns error message (VAL-HLT-014)', async () => {
    process.env.EIDOLON_MCP_REMOTE_HOST_ALLOWLIST = '127.0.0.1';

    const registered = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Dead MCP',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:1/mcp',
      })
      .expect(201);

    const serverId = registered.body.data.id;

    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers/${serverId}/health`)
      .expect(200);

    expect(res.body.data.id).toBe(serverId);
    expect(res.body.data.status).toBe('error');
    expect(res.body.data.error).toBeTruthy();
    expect(res.body.data.toolCount).toBe(0);
    // Must not claim connected
    expect(res.body.data.status).not.toBe('connected');

    // Persisted in DB
    const row = await getMcpServer(db, serverId);
    expect(row!.status).toBe('error');
  });

  it('cross-company re-check is rejected with 404 (VAL-HLT-015)', async () => {
    process.env.EIDOLON_MCP_REMOTE_HOST_ALLOWLIST = '127.0.0.1';

    const registered = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Isolated MCP',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:1/mcp',
      })
      .expect(201);

    const serverId = registered.body.data.id;

    const res = await request(app)
      .post(`/api/companies/${otherCompanyId}/mcp/servers/${serverId}/health`);

    expect(res.status).toBe(404);

    // Foreign server unchanged — still disconnected (not modified by the other company)
    const row = await getMcpServer(db, serverId);
    expect(row!.status).toBe('disconnected');
  });

  it('re-check on nonexistent server returns 404', async () => {
    const fakeId = randomUUID();
    const res = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers/${fakeId}/health`);

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-004 — MCP re-check updates unified health surface
// ---------------------------------------------------------------------------

describe('MCP re-check updates unified health surface (VAL-CROSS-004)', () => {
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;
  let tempDir: string;
  let prevStdioEnabled: string | undefined;
  let prevStdioAllowlist: string | undefined;

  beforeEach(async () => {
    prevStdioEnabled = process.env.EIDOLON_ENABLE_TENANT_STDIO_MCP;
    prevStdioAllowlist = process.env.EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST;

    db = await createTestDb();
    app = createTestApp(db);
    companyId = await createCompany(app, 'Cross-004 Co');

    const fixtureRoot = path.resolve(process.cwd(), 'server', '.tmp-tests');
    await fs.mkdir(fixtureRoot, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(fixtureRoot, 'eidolon-cross004-'));
  });

  afterEach(async () => {
    restoreEnv('EIDOLON_ENABLE_TENANT_STDIO_MCP', prevStdioEnabled);
    restoreEnv('EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST', prevStdioAllowlist);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('unified health reflects disconnected→healthy after successful re-check', async () => {
    process.env.EIDOLON_ENABLE_TENANT_STDIO_MCP = 'true';

    const serverPath = path.join(tempDir, 'echo-mcp-server.mjs');
    process.env.EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST = `${process.execPath} ${serverPath}`;
    await fs.writeFile(
      serverPath,
      `
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo-test", version: "1.0.0" });
server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo text back to the caller.",
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({ content: [{ type: "text", text }] }),
);

await server.connect(new StdioServerTransport());
`,
      'utf8',
    );

    const registered = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Echo MCP',
        transport: 'stdio',
        command: process.execPath,
        args: [serverPath],
      })
      .expect(201);

    const serverId = registered.body.data.id;

    // Before re-check: unified health shows unknown (disconnected)
    const before = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    const mcpBefore = before.body.data.find((e: { id: string }) => e.id === serverId);
    expect(mcpBefore).toBeDefined();
    expect(mcpBefore.healthStatus).toBe('unknown');
    expect(mcpBefore.lastHealthCheckAt).toBeNull();

    // Perform re-check
    await request(app)
      .post(`/api/companies/${companyId}/mcp/servers/${serverId}/health`)
      .expect(200);

    // After re-check: unified health shows healthy (connected)
    const after = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    const mcpAfter = after.body.data.find((e: { id: string }) => e.id === serverId);
    expect(mcpAfter).toBeDefined();
    expect(mcpAfter.healthStatus).toBe('healthy');
    expect(mcpAfter.lastHealthCheckAt).not.toBeNull();

    // Persisted on re-query
    const requery = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);

    const mcpRequery = requery.body.data.find((e: { id: string }) => e.id === serverId);
    expect(mcpRequery.healthStatus).toBe('healthy');
  });

  it('unified health reflects error after failed re-check', async () => {
    process.env.EIDOLON_MCP_REMOTE_HOST_ALLOWLIST = '127.0.0.1';

    const registered = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Dead MCP',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:1/mcp',
      })
      .expect(201);

    const serverId = registered.body.data.id;

    // Before re-check: unknown (disconnected)
    const before = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);
    const mcpBefore = before.body.data.find((e: { id: string }) => e.id === serverId);
    expect(mcpBefore.healthStatus).toBe('unknown');

    // Perform re-check (fails)
    await request(app)
      .post(`/api/companies/${companyId}/mcp/servers/${serverId}/health`)
      .expect(200);

    // After re-check: error
    const after = await request(app)
      .get(`/api/companies/${companyId}/integrations/health`)
      .expect(200);
    const mcpAfter = after.body.data.find((e: { id: string }) => e.id === serverId);
    expect(mcpAfter.healthStatus).toBe('error');
  });
});
