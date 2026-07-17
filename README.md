# Eidolon — The AI Company Runtime

**Open-source orchestration platform for autonomous AI companies.**

Eidolon lets you define a business goal, hire AI agents from any provider (Anthropic, OpenAI, Google, local via Ollama), organize them into an org chart, set budgets, and manage their work through a ticket-based system — all from one dashboard.

## Features

| Feature | Description |
|---|---|
| **Multi-provider agents** | Hire from Anthropic, OpenAI, Google, or local models (Ollama). Unified interface with per-adapter capability flags (streaming, tools, vision, reasoning) surfaced at `GET /api/adapters`. |
| **Org chart & hierarchy** | Agents have roles, titles, and `reports_to` lines. Delegation flows naturally. |
| **Task board** | Kanban-style task management with atomic checkout, priority ordering, and concurrency-safe assignment. |
| **Goal alignment** | OKR-style goal hierarchy. Every task traces back to the company mission. |
| **Budget control** | Per-agent monthly budgets with real-time cost tracking and hard-stop enforcement. |
| **Workflow engine** | DAG-based workflows with task dependencies and automatic orchestration. |
| **Unified inbox** | Approvals, collaborations, and high-signal activity in one feed with j/k/a/o keyboard nav. |
| **Approvals governance** | First-class approvals table for budget changes, agent terminations, custom reviews — with decision audit + comment threads. |
| **Agentic loop runtime** | Observe → Think → Act → Reflect loop with per-step streaming transcript visible on each agent. |
| **Hybrid runtime sessions** | Durable run/session records with adapter metadata, workspace leases, cancellation, finalization, and Jarvis-oriented runtime events. |
| **Skills + routines foundation** | Company skill install/assignment and scheduled/continuous Jarvis routines for daily briefing, monitoring, research, and follow-up workflows. |
| **Knowledge base + RAG** | Company-scoped documents with chunked semantic retrieval plugged into the agentic loop. |
| **Agent memories** | Per-agent long-term memory synthesized from completed tasks. |
| **MCP client + server** | Connect agents to real MCP tool servers over stdio, SSE, or Streamable HTTP, and expose Eidolon itself as an MCP server (`@eidolon/mcp-server`) so Claude Desktop / Cursor can drive the platform. |
| **Real-time dashboard** | WebSocket-powered live updates. Monitor everything from your phone. |
| **Multi-tenancy** | Run multiple autonomous companies from one deployment, isolated by org membership. |
| **Activity audit log** | Every action tracked with actor, entity, and timestamp. |

## Quickstart

```bash
git clone https://github.com/verticallabs-ai/eidolon.git
cd eidolon
pnpm install
pnpm run db:start      # Boot local Supabase (Postgres on :54322, Studio on :54323)
pnpm run db:migrate    # Apply Drizzle migrations
pnpm run dev           # Start server (:3100) + UI (:5173)
```

The database starts empty — create your first company from the UI. There is no demo/mock data.

**Requirements:** Node.js 24 LTS, `pnpm`, Docker, and the [Supabase CLI](https://supabase.com/docs/guides/cli) (`brew install supabase/tap/supabase` on macOS). Auth is handled by Clerk via the Vercel Marketplace integration (see [Deployment](#deployment)).

## Architecture

```
eidolon/
├── packages/
│   ├── shared/      # Types, Zod schemas, constants
│   ├── db/          # Drizzle ORM, Postgres, migrations
│   └── mcp-server/  # @eidolon/mcp-server — MCP wrapper over the REST API
├── server/          # Express API + WebSocket server
│   ├── routes/      # REST endpoints (agents, tasks, approvals, inbox, mcp…)
│   ├── services/    # Agentic loop, scheduler, knowledge, memory, budgets
│   ├── providers/   # ServerAdapter impls (anthropic, openai, google, ollama)
│   ├── middleware/  # Auth, rate-limit, validation, error handling
│   └── realtime/    # WebSocket event bus
└── ui/              # React + Vite + Tailwind dashboard
    ├── pages/       # Dashboard, TaskBoard, OrgChart, Inbox, Approvals, …
    ├── components/  # Reusable UI + TranscriptView
    └── lib/         # API client, ws hooks, React Query
```

## Tech stack

- **Backend:** Node.js 24 LTS, Express 5, TypeScript
- **Database:** Postgres via Drizzle ORM + `postgres.js`. Locally provisioned by the Supabase CLI (`supabase/config.toml`); migrations live in `packages/db/drizzle/`. Tests run against PGlite (in-memory Postgres) with the same migrations.
- **Frontend:** React 19, Vite, Tailwind CSS v4, TanStack React Query, Framer Motion
- **Auth:** Clerk (production) / `local_trusted` bypass (dev loopback)
- **Real-time:** WebSocket (`ws`) with typed events and an in-process event bus
- **Validation:** Zod schemas shared between client and server
- **MCP:** `@modelcontextprotocol/sdk` for both the client (agent side) and the standalone server package

## Development

```bash
pnpm run dev           # Start server + UI in dev mode
pnpm run dev:server    # Server only  (Express on :3100)
pnpm run dev:ui        # UI only      (Vite on :5173)
pnpm run build         # Build shared → server → UI
pnpm run typecheck     # tsc -b across all projects
pnpm run test          # vitest watch mode
pnpm run test:run      # One-shot test run
pnpm run db:start      # Start local Supabase (Postgres + Studio)
pnpm run db:stop       # Stop local Supabase
pnpm run db:reset      # Drop the DB and re-apply Drizzle migrations
pnpm run db:generate   # Regenerate migration SQL from schema
pnpm run db:migrate    # Apply outstanding migrations
```

### The standalone MCP server

```bash
pnpm --filter @eidolon/mcp-server build
EIDOLON_API_URL=http://localhost:3100 \
EIDOLON_COMPANY_ID=<uuid> \
  node packages/mcp-server/dist/index.js
```

Point any MCP-capable client (Claude Desktop, Cursor, Claude Code, `mcp-cli`) at the binary. Full docs in [`packages/mcp-server/README.md`](packages/mcp-server/README.md).

For agent-side MCP client connections, tenant-registered `stdio` transports are disabled by default because they spawn local processes on the Eidolon server. Operators can enable them for trusted deployments with `EIDOLON_ENABLE_TENANT_STDIO_MCP=true`; `EIDOLON_MCP_STDIO_COMMAND_ALLOWLIST` must list exact full argv presets such as `/usr/local/bin/node /opt/eidolon/mcp/echo-server.mjs`, not generic interpreters or package runners. Stdio env overrides are rejected unless each key is listed in `EIDOLON_MCP_STDIO_ENV_ALLOWLIST`; the spawned process never inherits the Eidolon server process env. Remote SSE/Streamable HTTP transports can use safe public IP literals by default; hostnames and trusted private hosts must be listed in `EIDOLON_MCP_REMOTE_HOST_ALLOWLIST` so operators own the DNS/network path. MCP connect, discovery, and tool calls are bounded by `EIDOLON_MCP_CONNECT_TIMEOUT_MS`, `EIDOLON_MCP_DISCOVERY_TIMEOUT_MS`, and `EIDOLON_MCP_TOOL_CALL_TIMEOUT_MS`.

## How it works

1. **Create a company** — Define mission and budget.
2. **Hire agents** — Add agents with specific roles (CEO, CTO, Engineer, etc.). Each agent has its own provider, model, budget, instructions, and capability flags.
3. **Set goals** — Define OKRs that cascade from mission to tasks.
4. **Create tasks** — Kanban board with atomic assignment and priority-aware scheduling.
5. **Run** — Agents execute via the Observe → Think → Act → Reflect loop with live transcript streaming, budget enforcement, and approval gates on governed actions.
6. **Monitor** — Inbox surfaces pending approvals, inbound collaborations, and high-signal activity. Navigate with `j`/`k`/`a`/`o`.

## API overview

All endpoints under `/api`. See the per-route source for full schemas.

| Endpoint | Description |
|---|---|
| `GET /api/companies` | List companies |
| `POST /api/companies` | Create company |
| `GET /api/adapters` | Provider adapter manifest with capability flags |
| `GET /api/runtime/adapters` | Provider, process, HTTP, MCP, and OpenJarvis-local runtime descriptors |
| `GET /api/companies/:id/agents` | List agents |
| `POST /api/companies/:id/agents` | Hire agent |
| `POST /api/companies/:id/agents/:agentId/wake` | Wake an idle agent for immediate task assignment |
| `GET /api/companies/:id/agents/:agentId/executions` | Execution history with transcripts |
| `POST /api/companies/:id/agents/:agentId/execute` | Run agent on a task (supports `?mode=loop`) |
| `POST /api/companies/:id/sessions` | Create a durable runtime session |
| `POST /api/companies/:id/sessions/:sessionId/cancel` | Cancel a runtime session |
| `POST /api/companies/:id/sessions/:sessionId/finalize` | Finalize a runtime session and release its workspace |
| `POST /api/companies/:id/skills/install` | Install/update a company skill and optionally assign it to agents |
| `POST /api/companies/:id/routines` | Create a scheduled, continuous, or on-demand Jarvis routine |
| `GET /api/companies/:id/tasks` | List tasks |
| `POST /api/companies/:id/tasks` | Create task |
| `GET /api/companies/:id/goals` | Goal tree |
| `GET /api/companies/:id/approvals` | List approvals |
| `POST /api/companies/:id/approvals/:id/decide` | Approve / reject |
| `GET /api/companies/:id/inbox` | Unified feed |
| `GET /api/companies/:id/analytics/*` | Analytics endpoints |
| `WS /ws` | Real-time events |

## Deployment

Auth + secrets are provisioned via the **Vercel Marketplace → Clerk** integration. Link once, pull env, and ship:

```bash
vercel link
vercel integration add clerk
vercel env pull .env.local --yes
```

Rate-limiting is opt-in via `RATE_LIMIT_ENABLED=1` (or automatic when `NODE_ENV=production`).

## Releases

Versions follow **Calendar Versioning (CalVer)** using the **UTC** calendar date: `YYYY.M.D` with no zero-padding on month or day (for example `2026.4.17`).

- The **first** successful release on a given UTC day is tagged exactly as that date.
- **Additional** releases on the **same UTC day** use a numeric suffix: `2026.4.17-2`, `2026.4.17-3`, and so on.

Each push to `main` that passes CI (typecheck, tests, build) triggers [`.github/workflows/release.yml`](.github/workflows/release.yml): a new Git tag is created and a **GitHub Release** is published with auto-generated notes. Workspace `package.json` versions are not bumped; the tag and release are the public version.

## License

MIT
