#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EidolonClient } from "./client.js";
import { loadConfig } from "./config.js";
import { registerEidolonTools } from "./tools.js";

/**
 * @eidolon/mcp-server — thin MCP wrapper over the Eidolon REST API.
 *
 * Spawn via stdio from any MCP-capable client (Claude Desktop, Cursor,
 * Claude Code, mcp-cli). Env vars:
 *   EIDOLON_API_URL       — required, e.g. http://localhost:3100
 *   EIDOLON_API_KEY       — bearer token, required unless server is local_trusted
 *   EIDOLON_COMPANY_ID    — default company for company-scoped tools
 *   EIDOLON_AGENT_ID      — optional, forwarded as X-Eidolon-Agent-Id
 *   EIDOLON_RUN_ID        — optional, forwarded as X-Eidolon-Run-Id
 */
async function main() {
  const config = loadConfig();
  const client = new EidolonClient(config);

  const server = new McpServer({
    name: "eidolon-mcp-server",
    version: "0.1.0",
  });

  registerEidolonTools(server, client, config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stderr only — stdout is reserved for the MCP protocol stream.
  process.stderr.write(
    `eidolon-mcp-server ready (api: ${config.apiUrl}, company: ${
      config.companyId ?? "<not set>"
    })\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `eidolon-mcp-server failed to start: ${
      err instanceof Error ? err.message : String(err)
    }\n`,
  );
  process.exit(1);
});
