// ---------------------------------------------------------------------------
// MCP Client Service -- Manages MCP server configurations and tool calls
// ---------------------------------------------------------------------------

import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { DbInstance } from '../types.js';
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
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

// ---------------------------------------------------------------------------
// MCPClientService
// ---------------------------------------------------------------------------

export class MCPClientService {
  constructor(private db: DbInstance) {}

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
    if ((config.transport === 'sse' || config.transport === 'streamable-http') && !config.url) {
      throw new Error(`${config.transport} transport requires a url`);
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
   * Call a tool on an MCP server.
   *
   * Currently simulated -- in production this would:
   *   1. Resolve the server config from DB
   *   2. Spawn a child process (stdio) or connect via HTTP (sse/streamable-http)
   *   3. Send a tools/call JSON-RPC request per MCP protocol
   *   4. Parse and return the structured response
   */
  async callTool(
    serverId: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<MCPCallResult> {
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

    logger.info(
      { serverId: server.id, serverName: server.name, toolName, transport: server.transport },
      'MCP tool call (simulated)',
    );

    // Simulated response -- replace with actual MCP protocol implementation
    return {
      content: [{
        type: 'text',
        text: `Tool "${toolName}" on server "${server.name}" called successfully with args: ${JSON.stringify(args)}`,
      }],
      isError: false,
    };
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
