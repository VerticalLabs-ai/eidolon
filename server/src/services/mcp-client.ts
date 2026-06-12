// ---------------------------------------------------------------------------
// MCP Client Service -- Manages MCP server configurations and tool calls
// ---------------------------------------------------------------------------

import { eq, and } from 'drizzle-orm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { DbInstance } from '../types.js';
import eventBus from '../realtime/events.js';
import logger from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export class MCPPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MCPPolicyError';
  }
}

const TENANT_STDIO_MCP_FLAG = 'EIDOLON_ENABLE_TENANT_STDIO_MCP';
const TENANT_STDIO_MCP_ALLOWLIST = 'EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST';
const TENANT_STDIO_MCP_ENV_ALLOWLIST = 'EIDOLON_MCP_STDIO_ENV_ALLOWLIST';
const REMOTE_MCP_HOST_ALLOWLIST = 'EIDOLON_MCP_REMOTE_HOST_ALLOWLIST';
const MCP_CONNECT_TIMEOUT_MS = readPositiveIntegerEnv('EIDOLON_MCP_CONNECT_TIMEOUT_MS', 10_000);
const MCP_DISCOVERY_TIMEOUT_MS = readPositiveIntegerEnv('EIDOLON_MCP_DISCOVERY_TIMEOUT_MS', 10_000);
const MCP_TOOL_CALL_TIMEOUT_MS = readPositiveIntegerEnv('EIDOLON_MCP_TOOL_CALL_TIMEOUT_MS', 30_000);

// ---------------------------------------------------------------------------
// MCPClientService
// ---------------------------------------------------------------------------

export class MCPClientService {
  constructor(private db: DbInstance) {}

  private assertStdioTransportAllowed(command: string, args: string[] = []): void {
    if (process.env[TENANT_STDIO_MCP_FLAG] !== 'true') {
      throw new MCPPolicyError(
        `stdio MCP transport is disabled by server policy; set ${TENANT_STDIO_MCP_FLAG}=true only for trusted operator-managed runtimes`,
      );
    }

    const allowedCommands = parseCsvAllowlist(process.env[TENANT_STDIO_MCP_ALLOWLIST]);
    const commandKey = stdioCommandKey(command, args);
    if (!allowedCommands.has(commandKey)) {
      throw new MCPPolicyError(
        `stdio MCP argv "${commandKey}" is not in ${TENANT_STDIO_MCP_ALLOWLIST}; allowlist the full command plus arguments only for trusted operator-managed runtimes`,
      );
    }
  }

  private sanitizeStdioEnv(env: Record<string, string>): Record<string, string> {
    const sanitized = sanitizeEnv(env);
    const allowedKeys = parseCsvAllowlist(process.env[TENANT_STDIO_MCP_ENV_ALLOWLIST]);
    for (const key of Object.keys(sanitized)) {
      if (!allowedKeys.has(key)) {
        throw new MCPPolicyError(
          `stdio MCP env key "${key}" is not in ${TENANT_STDIO_MCP_ENV_ALLOWLIST}; env overrides must be operator-approved per preset`,
        );
      }
    }
    return sanitized;
  }

  private async assertRemoteTransportAllowed(urlText: string): Promise<URL> {
    const url = new URL(urlText);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new MCPPolicyError(`MCP remote transport only supports http or https URLs`);
    }
    if (url.username || url.password) {
      throw new MCPPolicyError('MCP remote transport URLs must not include credentials');
    }

    const hostname = stripIpBrackets(url.hostname.toLowerCase());
    const allowedHosts = parseCsvAllowlist(
      process.env[REMOTE_MCP_HOST_ALLOWLIST],
      (entry) => stripIpBrackets(entry.toLowerCase()),
    );
    if (allowedHosts.has(hostname)) {
      return url;
    }

    if (isBlockedHostname(hostname) || isPrivateOrReservedIp(hostname)) {
      throw new MCPPolicyError(
        `MCP remote host "${hostname}" is blocked by server policy; add it to ${REMOTE_MCP_HOST_ALLOWLIST} only for trusted operator-managed runtimes`,
      );
    }

    if (net.isIP(hostname) === 0) {
      throw new MCPPolicyError(
        `MCP remote hostname "${hostname}" must be listed in ${REMOTE_MCP_HOST_ALLOWLIST} to prevent DNS rebinding`,
      );
    }

    return url;
  }

  private createRemoteFetch(): typeof fetch {
    return (async (input, init) => {
      const urlText = input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : String(input);
      await this.assertRemoteTransportAllowed(urlText);

      const response = await fetch(input, { ...init, redirect: 'manual' });
      if (response.status >= 300 && response.status < 400) {
        throw new MCPPolicyError(`MCP remote redirect from "${urlText}" is blocked by server policy`);
      }
      return response;
    }) as typeof fetch;
  }

  private async createTransport(server: any): Promise<{ transport: Transport; stderr: string[] }> {
    const stderr: string[] = [];
    if (server.transport === 'stdio') {
      if (!server.command) {
        throw new Error(`MCP server "${server.name}" is missing command`);
      }

      const args = Array.isArray(server.args) ? server.args : [];
      this.assertStdioTransportAllowed(server.command, args);

      const env = this.sanitizeStdioEnv((server.env ?? {}) as Record<string, string>);

      const transport = new StdioClientTransport({
        command: server.command,
        args,
        env,
        stderr: 'pipe',
      });
      transport.stderr?.on('data', (chunk) => {
        stderr.push(String(chunk));
        while (stderr.join('').length > 4000) stderr.shift();
      });
      return { transport, stderr };
    }

    if (server.transport === 'sse') {
      if (!server.url) {
        throw new Error(`MCP server "${server.name}" is missing url`);
      }
      return {
        transport: new SSEClientTransport(await this.assertRemoteTransportAllowed(server.url), {
          fetch: this.createRemoteFetch(),
        }),
        stderr,
      };
    }

    if (server.transport === 'streamable-http') {
      if (!server.url) {
        throw new Error(`MCP server "${server.name}" is missing url`);
      }
      return {
        transport: new StreamableHTTPClientTransport(await this.assertRemoteTransportAllowed(server.url), {
          fetch: this.createRemoteFetch(),
        }),
        stderr,
      };
    }

    throw new Error(`Unsupported MCP transport: ${server.transport}`);
  }

  private async connect(server: any): Promise<{ client: Client; transport: Transport }> {
    const client = new Client({
      name: 'eidolon-server',
      version: '0.1.0',
    });
    const { transport, stderr } = await this.createTransport(server);
    try {
      await withTimeout(
        client.connect(transport),
        MCP_CONNECT_TIMEOUT_MS,
        `MCP server "${server.name}" connect timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`,
      );
    } catch (error) {
      await this.closeConnection(client, transport);
      const stderrText = stderr.join('').trim();
      if (stderrText && error instanceof Error) {
        throw new Error(`${error.message}; stderr: ${stderrText}`);
      }
      throw error;
    }
    return { client, transport };
  }

  private async closeConnection(client: Client, transport: Transport): Promise<void> {
    try {
      await client.close();
    } catch (error) {
      logger.debug({ error }, 'MCP client close failed');
    }

    try {
      await transport.close();
    } catch (error) {
      logger.debug({ error }, 'MCP transport close failed');
    }
  }

  /**
   * List all MCP servers for a company.
   */
  async listServers(companyId: string): Promise<any[]> {
    const { mcpServers } = this.db.schema;
    return this.db.drizzle
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.companyId, companyId));
  }

  /**
   * Get a single MCP server by ID.
   */
  async getServer(serverId: string): Promise<any | null> {
    const { mcpServers } = this.db.schema;
    const [server] = await this.db.drizzle
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.id, serverId))
      .limit(1);
    return server ?? null;
  }

  /**
   * Register a new MCP server configuration.
   */
  async registerServer(companyId: string, config: MCPServerConfig): Promise<any> {
    const { mcpServers } = this.db.schema;
    const now = new Date();

    // Validate transport-specific requirements
    if (config.transport === 'stdio' && !config.command) {
      throw new Error('stdio transport requires a command');
    }
    if (config.transport === 'stdio' && config.command) {
      this.assertStdioTransportAllowed(config.command, config.args ?? []);
      this.sanitizeStdioEnv(config.env ?? {});
    }
    if ((config.transport === 'sse' || config.transport === 'streamable-http') && !config.url) {
      throw new Error(`${config.transport} transport requires a url`);
    }
    if ((config.transport === 'sse' || config.transport === 'streamable-http') && config.url) {
      await this.assertRemoteTransportAllowed(config.url);
    }

    const [row] = await this.db.drizzle
      .insert(mcpServers)
      .values({
        id: randomUUID(),
        companyId,
        name: config.name,
        transport: config.transport,
        command: config.command ?? null,
        args: config.args ?? [],
        env: config.env ?? {},
        url: config.url ?? null,
        status: 'disconnected',
        availableTools: [],
        availableResources: [],
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    logger.info(
      { serverId: row.id, name: config.name, transport: config.transport, companyId },
      'MCP server registered',
    );

    return row;
  }

  /**
   * Update server status and available tools/resources.
   * Used after connecting to an MCP server to store its capabilities.
   */
  async updateServerCapabilities(
    serverId: string,
    data: {
      status?: 'connected' | 'disconnected' | 'error';
      availableTools?: MCPTool[];
      availableResources?: MCPResource[];
    },
  ): Promise<any> {
    const { mcpServers } = this.db.schema;
    const now = new Date();

    const updates: Record<string, unknown> = { updatedAt: now };
    if (data.status !== undefined) {
      updates.status = data.status;
      if (data.status === 'connected') {
        updates.lastConnectedAt = now;
      }
    }
    if (data.availableTools !== undefined) {
      updates.availableTools = data.availableTools;
    }
    if (data.availableResources !== undefined) {
      updates.availableResources = data.availableResources;
    }

    const [updated] = await this.db.drizzle
      .update(mcpServers)
      .set(updates)
      .where(eq(mcpServers.id, serverId))
      .returning();

    return updated;
  }

  /**
   * Get available tools from all MCP servers for a company.
   * Returns a flat list with server attribution for each tool.
   */
  async getAvailableTools(
    companyId: string,
  ): Promise<Array<MCPTool & { serverId: string; serverName: string }>> {
    const servers = await this.listServers(companyId);
    const tools: Array<MCPTool & { serverId: string; serverName: string }> = [];

    for (const server of servers) {
      const serverTools = (server.availableTools ?? []) as MCPTool[];
      for (const tool of serverTools) {
        tools.push({
          ...tool,
          serverId: server.id,
          serverName: server.name,
        });
      }
    }

    return tools;
  }

  /**
   * Connect to a configured MCP server, discover capabilities, and persist the
   * latest tool/resource manifest for fast agent prompt construction.
   */
  async connectServer(serverId: string): Promise<any> {
    const server = await this.getServer(serverId);
    if (!server) {
      throw new Error(`MCP server ${serverId} not found`);
    }

    let connection: { client: Client; transport: Transport } | null = null;
    try {
      connection = await this.connect(server);

      const toolsResponse = await withTimeout(
        connection.client.listTools(),
        MCP_DISCOVERY_TIMEOUT_MS,
        `MCP server "${server.name}" listTools timed out after ${MCP_DISCOVERY_TIMEOUT_MS}ms`,
      );
      const availableTools: MCPTool[] = (toolsResponse.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
      }));

      let availableResources: MCPResource[] = [];
      try {
        const resourcesResponse = await withTimeout(
          connection.client.listResources(),
          MCP_DISCOVERY_TIMEOUT_MS,
          `MCP server "${server.name}" listResources timed out after ${MCP_DISCOVERY_TIMEOUT_MS}ms`,
        );
        availableResources = (resourcesResponse.resources ?? []).map((resource) => ({
          uri: resource.uri,
          name: resource.name,
          description: resource.description,
          mimeType: resource.mimeType,
        }));
      } catch (error) {
        logger.debug({ error, serverId }, 'MCP server did not expose listResources');
      }

      return await this.updateServerCapabilities(serverId, {
        status: 'connected',
        availableTools,
        availableResources,
      });
    } catch (error) {
      await this.updateServerCapabilities(serverId, { status: 'error' });
      throw error;
    } finally {
      if (connection) {
        await this.closeConnection(connection.client, connection.transport);
      }
    }
  }

  /**
   * Call a tool on an MCP server.
   *
   * Calls the real MCP server over its configured transport. Each call is
   * persisted to `mcp_tool_calls` for auditability and emitted as a runtime
   * event so transcripts and operator views can attach it to a run later.
   */
  async callTool(
    companyId: string,
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPCallResult> {
    const { mcpToolCalls } = this.db.schema;
    const server = await this.getServer(serverId);

    if (!server) {
      logger.warn({ serverId, toolName }, 'MCP tool call to unknown server');
      return {
        content: [{
          type: 'text',
          text: `Error: MCP server "${serverId}" not found`,
        }],
        isError: true,
      };
    }
    if (server.companyId !== companyId) {
      logger.warn({ serverId, toolName, companyId }, 'MCP tool call rejected for wrong company');
      return {
        content: [{
          type: 'text',
          text: `Error: MCP server "${serverId}" not found`,
        }],
        isError: true,
      };
    }

    const startedAt = new Date();
    const callId = randomUUID();

    await this.db.drizzle.insert(mcpToolCalls).values({
      id: callId,
      companyId: server.companyId,
      serverId: server.id,
      toolName,
      arguments: args,
      status: 'started',
      startedAt,
    });

    let connection: { client: Client; transport: Transport } | null = null;
    try {
      connection = await this.connect(server);
      const result = await withTimeout(
        connection.client.callTool({
          name: toolName,
          arguments: args,
        }),
        MCP_TOOL_CALL_TIMEOUT_MS,
        `MCP tool "${toolName}" timed out after ${MCP_TOOL_CALL_TIMEOUT_MS}ms`,
      );
      const normalized = normalizeCallResult(result);
      const completedAt = new Date();

      await this.db.drizzle
        .update(mcpToolCalls)
        .set({
          status: normalized.isError ? 'failed' : 'succeeded',
          isError: normalized.isError ?? false,
          result: normalized as unknown as Record<string, unknown>,
          completedAt,
        })
        .where(eq(mcpToolCalls.id, callId));

      eventBus.emitEvent({
        type: 'runtime.tool_call',
        companyId: server.companyId,
        payload: {
          callId,
          serverId: server.id,
          toolName,
          isError: normalized.isError ?? false,
        },
        timestamp: completedAt.toISOString(),
      });

      logger.info(
        { callId, serverId: server.id, serverName: server.name, toolName, transport: server.transport },
        'MCP tool call completed',
      );

      return normalized;
    } catch (error) {
      const completedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);

      await this.db.drizzle
        .update(mcpToolCalls)
        .set({
          status: 'failed',
          isError: true,
          error: message,
          result: {
            content: [{ type: 'text', text: `Error: ${message}` }],
            isError: true,
          },
          completedAt,
        })
        .where(eq(mcpToolCalls.id, callId));
      await this.updateServerCapabilities(server.id, { status: 'error' });

      eventBus.emitEvent({
        type: 'runtime.tool_call',
        companyId: server.companyId,
        payload: {
          callId,
          serverId: server.id,
          toolName,
          isError: true,
          error: message,
        },
        timestamp: completedAt.toISOString(),
      });

      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    } finally {
      if (connection) {
        await this.closeConnection(connection.client, connection.transport);
      }
    }
  }

  /**
   * Delete a server configuration.
   */
  async deleteServer(serverId: string, companyId: string): Promise<void> {
    const { mcpServers } = this.db.schema;
    await this.db.drizzle
      .delete(mcpServers)
      .where(
        and(
          eq(mcpServers.id, serverId),
          eq(mcpServers.companyId, companyId),
        ),
      );
    logger.info({ serverId, companyId }, 'MCP server deleted');
  }
}

function sanitizeEnv(env: NodeJS.ProcessEnv | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function parseCsvAllowlist(
  value: string | undefined,
  normalize: (value: string) => string = (entry) => entry,
): Set<string> {
  return new Set(
    (value ?? '')
      .split(',')
      .map((entry) => normalize(entry.trim()))
      .filter(Boolean),
  );
}

function stdioCommandKey(command: string, args: string[]): string {
  return [command, ...args].map(shellToken).join(' ');
}

function shellToken(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, `'\\''`)}'`;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function stripIpBrackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function isBlockedHostname(hostname: string): boolean {
  if (net.isIP(hostname) !== 0) return false;
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname.endsWith('.home.arpa') ||
    !hostname.includes('.')
  );
}

function isPrivateOrReservedIp(address: string): boolean {
  const normalized = stripIpBrackets(address.toLowerCase());
  if (normalized.startsWith('::ffff:')) {
    return true;
  }

  const version = net.isIP(normalized);
  if (version === 4) {
    const [a, b] = normalized.split('.').map((part) => Number(part));
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 ||
      a === 192 && b === 168 ||
      a === 100 && b >= 64 && b <= 127 ||
      a === 198 && (b === 18 || b === 19) ||
      a >= 224
    );
  }

  if (version === 6) {
    return true;
  }

  return false;
}

function normalizeCallResult(result: unknown): MCPCallResult {
  const record = result as {
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };

  return {
    content: Array.isArray(record.content) ? record.content : [],
    structuredContent: record.structuredContent,
    isError: record.isError ?? false,
  };
}
