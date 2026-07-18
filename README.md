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
| **Hybrid runtime sessions** | Durable run/session records with adapter metadata, workspace leases, cancellation, finalization, and first-class local Codex/Claude CLI execution. |
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

### Local CLI runtime adapters

`codex_local` and `claude_local` let a platform operator execute the installed Codex or Claude Code CLI through a required external sandbox. Create a durable session with `POST /api/companies/:id/sessions`, then send work to `POST /api/companies/:id/sessions/:sessionId/run` with `{ "prompt": "..." }`. The equivalent MCP tools are `eidolon_create_runtime_session` and `eidolon_run_runtime_session`. The run endpoint rejects non-platform-admin users even when they are an organization admin.

Both adapters accept `cwd`, string-valued `env`, `timeoutSec`, `graceSec`, and `model` in `adapterConfig`; Claude also accepts `maxTurns`. `cwd` is confined to the company directory under `EIDOLON_WORKSPACE_ROOT`. Adapter env keys must be explicitly named in the server-side `EIDOLON_LOCAL_CLI_ENV_ALLOWLIST`; the child inherits only a small OS/runtime baseline plus those operator-approved keys. Arbitrary CLI arguments and permission-bypass flags are rejected.

Every local runner must also be explicitly operator-authorized as a `<companyId>:<agentId>` entry in `EIDOLON_LOCAL_CLI_ALLOWED_AGENTS`. CLI executable selection is operator-owned: Eidolon resolves `codex` and `claude` from the server PATH, or accepts absolute overrides through `EIDOLON_CODEX_CLI_COMMAND` and `EIDOLON_CLAUDE_CLI_COMMAND`.

Each adapter receives an isolated `HOME` under `EIDOLON_RUNTIME_HOME` (default `~/.eidolon/runtime`) using the company plus environment or agent ID. Eidolon never exposes or links the server operator's home or CLI credentials into that runtime. Codex runs against an OpenAI Responses-compatible gateway configured through `EIDOLON_CODEX_GATEWAY_URL` and an absolute `EIDOLON_CODEX_GATEWAY_TOKEN_COMMAND`. Eidolon executes that trusted helper outside the workspace for each run, passes the company, agent, and session IDs as `EIDOLON_CODEX_TOKEN_*` context, and gives Codex only the returned short-lived gateway credential through the custom provider's `CODEX_API_KEY` channel. Reusable provider credentials remain in the gateway. File credentials such as `codex-home/auth.json` are refused. Codex is launched with shell snapshots disabled and a server-owned tool environment allowlist containing only safe OS variables plus the adapter keys explicitly approved by the operator, never `CODEX_API_KEY`. A strict permission profile additionally grants minimal runtime reads, workspace-root writes, and no tool network access. The installed Codex CLI must support custom Responses providers and named filesystem permission profiles or strict configuration will fail the run.

Claude runs in `--bare` mode without the reusable server `ANTHROPIC_API_KEY`. The operator must configure an Anthropic-compatible gateway through `EIDOLON_CLAUDE_GATEWAY_URL` and an absolute `EIDOLON_CLAUDE_GATEWAY_TOKEN_COMMAND`. Eidolon executes that trusted helper outside the workspace for each run, passing the company, agent, and session IDs as `EIDOLON_CLAUDE_TOKEN_*` context, and gives Claude only the returned short-lived gateway credential through bare mode's supported `ANTHROPIC_API_KEY` channel. Both gateways own the reusable provider credentials, usage limits, and audit policy. Each helper must finish within five seconds and print one token of at most 8192 characters. Both adapters persist and resume their session IDs.

Local execution is refused unless `EIDOLON_LOCAL_CLI_CONTAINMENT_COMMAND` points to an operator-managed sandbox launcher that provides process-tree, filesystem, credential, network, and OS-identity isolation. A cgroup or Windows Job Object alone is not sufficient because it does not prevent the CLI's tools from reading server files or credentials. Use a container or dedicated sandbox identity that exposes only the assigned workspace and brokered runtime credentials. The launcher must reopen and validate its inherited working directory against the trusted company workspace root immediately before mounting or entering it; it must not trust an earlier pathname check. Optional fixed launcher arguments are supplied as a JSON string array in `EIDOLON_LOCAL_CLI_CONTAINMENT_ARGS_JSON`; Eidolon appends the resolved CLI command and its server-owned arguments. Eidolon's parent-lifetime supervisor additionally terminates the launcher process group if a run is cancelled, times out, exceeds its output cap, or loses its server parent.

Tenant adapter environment values are delivered to the sandboxed launcher over a dedicated pipe; they are not applied to Eidolon's host supervisor. Loader and startup variables such as `NODE_OPTIONS`, `LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES` are rejected even when mistakenly included in the operator allowlist.

Processes are spawned without a shell in a managed process group, transcript output is bounded, and cancellation/timeout terminates the process tree. POSIX runners receive a graceful termination signal before the force deadline; Windows runners retain the supervised tree for the configured drain interval and then use a forced tree kill because Windows does not provide an equivalent catchable signal for arbitrary console process trees. Each claimed run persists a unique server-owner ID. Only successful durable lease refreshes renew the child supervisor watchdog; a stalled database heartbeat therefore fences the CLI tree even if its server process remains alive. A local session remains fenced in `cancelling` until its owner records the exit; after a restart, a foreign owner can be reconciled only after its last durable heartbeat plus the supervisor lease timeout, the configured force-kill grace, and a fencing buffer have expired. Failures record the command, cwd, exit code or signal, timeout state, and stderr tail without logging configured environment values. These adapters require a trusted local/desktop server host with the relevant authenticated CLI installed; a serverless Vercel function cannot provide that host runtime.

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
| `POST /api/companies/:id/sessions/:sessionId/run` | Run a prompt through a Codex Local or Claude Local session |
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
