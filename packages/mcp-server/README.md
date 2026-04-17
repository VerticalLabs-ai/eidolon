# @eidolon/mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) server that wraps
the Eidolon REST API. Point any MCP-capable client (Claude Desktop, Cursor,
Claude Code, `mcp-cli`) at it and drive your agents, tasks, goals, and
approvals directly from the chat.

## Tools

### Read

- `eidolon_list_companies`
- `eidolon_get_company`
- `eidolon_list_agents`
- `eidolon_get_agent`
- `eidolon_list_executions` — includes structured Observe / Think / Act / Reflect transcripts
- `eidolon_list_tasks` — filter by `status`, `priority`, `assigneeAgentId`
- `eidolon_get_task`
- `eidolon_list_goals`
- `eidolon_get_goal`
- `eidolon_list_approvals` — filter by `status`
- `eidolon_get_approval` — includes comments
- `eidolon_list_adapters` — capability matrix for every adapter (streaming, tools, vision, reasoning, …)

### Write

- `eidolon_create_task`
- `eidolon_update_task`
- `eidolon_assign_task`
- `eidolon_create_approval`
- `eidolon_decide_approval` — `approved` or `rejected`
- `eidolon_add_approval_comment`

### Escape hatch

- `eidolon_api_request` — call any `/api/...` path with arbitrary method, body, and query params.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `EIDOLON_API_URL` | yes | Base URL of the Eidolon API (default `http://localhost:3100`) |
| `EIDOLON_API_KEY` | when server runs `authenticated` mode | Bearer token for the session |
| `EIDOLON_COMPANY_ID` | recommended | Default company scope; tools accept a `companyId` arg to override |
| `EIDOLON_AGENT_ID` | optional | Forwarded as `X-Eidolon-Agent-Id` on mutations |
| `EIDOLON_RUN_ID` | optional | Forwarded as `X-Eidolon-Run-Id` for audit traceability |

## Claude Desktop config

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or the equivalent on your platform:

```json
{
  "mcpServers": {
    "eidolon": {
      "command": "node",
      "args": ["/absolute/path/to/Eidolon/packages/mcp-server/dist/index.js"],
      "env": {
        "EIDOLON_API_URL": "http://localhost:3100",
        "EIDOLON_COMPANY_ID": "your-company-uuid"
      }
    }
  }
}
```

Once Eidolon gets published to npm, this simplifies to:

```json
{
  "mcpServers": {
    "eidolon": {
      "command": "npx",
      "args": ["-y", "@eidolon/mcp-server"],
      "env": {
        "EIDOLON_API_URL": "http://localhost:3100",
        "EIDOLON_COMPANY_ID": "your-company-uuid"
      }
    }
  }
}
```

## Local development

```bash
pnpm --filter @eidolon/mcp-server build    # build once
pnpm --filter @eidolon/mcp-server dev      # tsx watch loop
pnpm vitest run packages/mcp-server        # unit tests (REST client)
```

The server speaks MCP over **stdio**, so stdout is reserved for protocol
traffic. All diagnostics go to stderr.

## Response envelope

Eidolon's REST routes wrap JSON responses in `{ "data": ... }`. The client
auto-unwraps that envelope before returning to MCP callers so tool results
are the payload directly, not the wrapper.

Errors come back as `EidolonApiError` carrying the HTTP status, the server's
error `code` (e.g. `AGENT_NOT_FOUND`, `APPROVAL_NOT_PENDING`), and the
original message. MCP clients will see these propagated as tool failures with
the server-provided message.
