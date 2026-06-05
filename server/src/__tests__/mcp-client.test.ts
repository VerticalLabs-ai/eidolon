import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createTestApp, createTestDb } from '../test-utils.js';
import { MCPClientService } from '../services/mcp-client.js';

describe('MCP client service integration', () => {
  let app: ReturnType<typeof createTestApp>;
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let companyId: string;
  let tempDir: string;
  let previousStdioEnabled: string | undefined;
  let previousStdioAllowlist: string | undefined;
  let previousRemoteHostAllowlist: string | undefined;

  beforeEach(async () => {
    previousStdioEnabled = process.env.EIDOLON_ENABLE_TENANT_STDIO_MCP;
    previousStdioAllowlist = process.env.EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST;
    previousRemoteHostAllowlist = process.env.EIDOLON_MCP_REMOTE_HOST_ALLOWLIST;

    db = await createTestDb();
    app = createTestApp(db);
    const fixtureRoot = path.resolve(process.cwd(), 'server', '.tmp-tests');
    await fs.mkdir(fixtureRoot, { recursive: true });
    tempDir = await fs.mkdtemp(path.join(fixtureRoot, 'eidolon-mcp-test-'));

    const company = await request(app)
      .post('/api/companies')
      .send({ name: 'MCP Corp', budgetMonthlyCents: 100000 })
      .expect(201);
    companyId = company.body.data.id;
  });

  afterEach(async () => {
    restoreEnv('EIDOLON_ENABLE_TENANT_STDIO_MCP', previousStdioEnabled);
    restoreEnv('EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST', previousStdioAllowlist);
    restoreEnv('EIDOLON_MCP_REMOTE_HOST_ALLOWLIST', previousRemoteHostAllowlist);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('discovers and calls tools over stdio using the MCP SDK', async () => {
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

    const connected = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers/${registered.body.data.id}/connect`)
      .expect(200);

    expect(connected.body.data.status).toBe('connected');
    expect(connected.body.data.availableTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'echo' }),
      ]),
    );

    const called = await request(app)
      .post(`/api/companies/${companyId}/mcp/tools/echo/call`)
      .send({
        serverId: registered.body.data.id,
        args: { text: 'hello from Eidolon' },
      })
      .expect(200);

    expect(called.body.data.isError).toBe(false);
    expect(called.body.data.content[0].text).toBe('hello from Eidolon');
  });

  it('requires stdio MCP allowlist entries to include the full argv', async () => {
    process.env.EIDOLON_ENABLE_TENANT_STDIO_MCP = 'true';
    process.env.EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST = process.execPath;

    await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Arg Bypass MCP',
        transport: 'stdio',
        command: process.execPath,
        args: ['-e', 'console.log("not a managed preset")'],
      })
      .expect(403);
  });

  it('rejects unallowlisted stdio MCP environment overrides', async () => {
    process.env.EIDOLON_ENABLE_TENANT_STDIO_MCP = 'true';
    process.env.EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST = process.execPath;

    await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Env Override MCP',
        transport: 'stdio',
        command: process.execPath,
        env: { NODE_OPTIONS: '--require ./tenant-code.js' },
      })
      .expect(403);
  });

  it('blocks tenant remote MCP transports to private hosts by default', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Loopback MCP',
        transport: 'sse',
        url: 'http://127.0.0.1:8765/sse',
      })
      .expect(403);

    await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'IPv4-mapped Loopback MCP',
        transport: 'sse',
        url: 'http://[::ffff:7f00:1]:8765/sse',
      })
      .expect(403);

    await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Site-local IPv6 MCP',
        transport: 'sse',
        url: 'http://[fec0::1]:8765/sse',
      })
      .expect(403);
  });

  it('requires operator allowlisting for remote MCP hostnames', async () => {
    await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Hostname MCP',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
      })
      .expect(403);
  });

  it('blocks redirects from remote MCP transports', async () => {
    process.env.EIDOLON_MCP_REMOTE_HOST_ALLOWLIST = '127.0.0.1';

    const redirectServer = http.createServer((_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/internal-mcp');
      res.end();
    });

    try {
      await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve));
      const address = redirectServer.address();
      if (!address || typeof address === 'string') throw new Error('Expected TCP test server address');

      const registered = await request(app)
        .post(`/api/companies/${companyId}/mcp/servers`)
        .send({
          name: 'Redirect MCP',
          transport: 'streamable-http',
          url: `http://127.0.0.1:${address.port}/mcp`,
        })
        .expect(201);

      const connected = await request(app)
        .post(`/api/companies/${companyId}/mcp/servers/${registered.body.data.id}/connect`)
        .expect(403);

      expect(connected.body.message).toContain('redirect');
    } finally {
      await new Promise<void>((resolve, reject) => {
        redirectServer.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('rejects service-level tool calls for another company', async () => {
    process.env.EIDOLON_MCP_REMOTE_HOST_ALLOWLIST = 'example.com';

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: 'Other MCP Corp', budgetMonthlyCents: 100000 })
      .expect(201);
    const registered = await request(app)
      .post(`/api/companies/${companyId}/mcp/servers`)
      .send({
        name: 'Isolated MCP',
        transport: 'streamable-http',
        url: 'https://example.com/mcp',
      })
      .expect(201);

    const result = await new MCPClientService(db).callTool(
      otherCompany.body.data.id,
      registered.body.data.id,
      'echo',
      {},
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
