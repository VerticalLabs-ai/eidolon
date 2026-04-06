# Eidolon Enhancement Implementation Plan

## Context

Eidolon is an AI agent orchestration platform (Express 5 + React/Vite SPA + SQLite/Drizzle ORM) with **zero authentication** and several architectural gaps identified in ENHANCEMENTS.md. This plan covers phased implementation of the 42 enhancements across 5 phases, starting with the most critical: security, race conditions, and reliability.

**Auth Decision: BetterAuth** (not Clerk) -- see rationale below.

---

## Auth Decision: BetterAuth over Clerk

| Factor | Clerk | BetterAuth |
|---|---|---|
| Self-hostable | No (dealbreaker) | Yes |
| Cost | $0.02/MAU after 10K | Free (MIT) |
| SQLite/Drizzle | No (own DB + webhook sync) | Native Drizzle adapter |
| Organizations | Built-in | Plugin (`organization`) |
| API keys | Not native | Plugin (`api-key`) |
| Express integration | `@clerk/express` | `toNodeHandler(auth)` |
| React Vite SPA | `@clerk/clerk-react` | `better-auth/react` |
| Local dev bypass | Requires Clerk account | Trivial middleware bypass |
| Vendor lock-in | High (passwords not exportable) | None |

**Verdict**: Clerk is SaaS-only and not self-hostable. Since Eidolon must be deployable on any user's infrastructure, Clerk is eliminated. BetterAuth stores everything in Eidolon's own SQLite via Drizzle, has native organization + API key plugins, and supports a `local_trusted` dev mode trivially.

---

## Phase 1: Security & Stability (P0)

### 1A. BetterAuth Integration [Enhancement 1.1, 1.2]

**Install**: `better-auth` (core library)

**Server-side** (`server/src/auth.ts` -- new file):
- Initialize BetterAuth with Drizzle adapter pointing to existing SQLite DB
- Enable plugins: `organization()`, `apiKey()`, `bearer()`, `admin()`
- Mount auth routes at `/api/auth/*` in `server/src/app.ts`
- Create `server/src/middleware/auth.ts`:
  - `requireAuth` middleware -- validates session via BetterAuth, attaches `req.user`
  - `requireOrgMember(role?)` middleware -- validates user belongs to the company in `:companyId` param
  - `requireApiKey` middleware -- validates API key from `Authorization: Bearer <key>` header
  - `localTrusted` bypass -- when `AUTH_MODE=local_trusted`, injects a dev user and skips auth

**Database changes** (`packages/db/`):
- Generate BetterAuth schema tables (user, session, account, verification, organization, member, invitation, apikey) using BetterAuth CLI or define manually in Drizzle schema
- Add migration for new auth tables
- Add `users` table reference to `companies` (companies become organizations in BetterAuth)
- Add `createdByUserId` foreign key where needed (tasks already have this field)

**Client-side** (`ui/`):
- Create `ui/src/lib/auth.ts` -- initialize BetterAuth React client
- Create `ui/src/pages/Login.tsx`, `ui/src/pages/Register.tsx`
- Create `ui/src/components/auth/AuthGuard.tsx` -- wraps routes, redirects to login if no session
- Update `ui/src/App.tsx` -- add auth routes outside `AppShell`, wrap company routes with `AuthGuard`
- Add user menu to sidebar (profile, logout, org switcher)

**Files to modify**:
- `server/src/app.ts` -- mount auth routes, add auth middleware to all `/api/companies/*` routes
- `server/src/index.ts` -- pass auth instance to app
- `packages/db/src/schema/` -- new auth schema files
- `packages/db/src/schema/index.ts` -- export new tables
- `ui/src/App.tsx` -- add login/register routes, auth guard
- `.env.example` -- add `AUTH_MODE`, `AUTH_SECRET`

### 1B. Role-Based Access Control [Enhancement 1.2]

- Map BetterAuth organization roles to Eidolon roles: `owner`, `admin`, `member`, `viewer`
- `requireOrgMember('admin')` middleware blocks viewers from write operations
- Company-scoped data isolation: all `/api/companies/:companyId/*` routes verify the authenticated user is a member of that company
- Agent API keys scoped to a specific company

### 1C. Race Condition Fix [Enhancement 3.1]

**Current bug**: `scheduler.ts:119-212` -- `tryAssignTask` does SELECT then UPDATE as separate operations. Two agents can SELECT the same unassigned task simultaneously.

**Fix** (`server/src/services/scheduler.ts`):
- Replace two-step SELECT+UPDATE with atomic UPDATE...WHERE that includes the unassigned check:
```sql
UPDATE tasks
SET assignee_agent_id = ?, status = 'in_progress', started_at = ?
WHERE id = (
  SELECT id FROM tasks
  WHERE company_id = ? AND status IN ('todo','backlog') AND assignee_agent_id IS NULL
  ORDER BY priority_order LIMIT 1
)
AND assignee_agent_id IS NULL
```
- Check `changes()` count -- if 0, another agent won the race, skip.
- Same fix needed in `task-assigner.ts:168-218` (`assignTask` method) -- add `WHERE assignee_agent_id IS NULL` guard.

### 1D. Execution Timeouts [Enhancement 6.2]

- Add `timeoutSeconds` column to `agents` table (default 300)
- Add `timedOut` to task status enum
- In `scheduler.ts` tick: query for tasks with `status = 'in_progress'` and `startedAt + timeout < now`, transition to `timed_out`
- Emit `task.timed_out` event

---

## Phase 2: Execution Model (P1)

### 2A. Adapter Architecture [Enhancement 2.1]

**New files**:
- `server/src/adapters/types.ts` -- `ServerAdapter` interface:
  ```typescript
  interface ServerAdapter {
    id: string;
    name: string;
    type: 'local_cli' | 'remote_gateway' | 'generic';
    execute(context: ExecutionContext): AsyncGenerator<ExecutionEvent>;
    healthCheck(): Promise<boolean>;
  }
  ```
- `server/src/adapters/registry.ts` -- adapter registry (register, discover, get by id)
- `server/src/adapters/anthropic.ts` -- refactor existing `providers/anthropic.ts` into adapter
- `server/src/adapters/openai.ts` -- refactor existing `providers/openai.ts`
- `server/src/adapters/local-cli.ts` -- spawn CLI processes (Claude CLI, Codex, etc.)
- `server/src/adapters/generic.ts` -- shell commands, HTTP webhooks

**Database**: Add `adapterType` and `adapterConfig` (JSON) columns to `agents` table.

### 2B. Heartbeat Improvements [Enhancement 2.2]

- Add `POST /api/companies/:companyId/agents/:agentId/wakeup` endpoint (already partially exists via `scheduler.wakeAgent`)
- Add per-agent cron expression support (`cronExpression` column on agents)
- Replace global 30s poll with per-agent interval respect (already reads `heartbeatIntervalSeconds`, just needs better scheduling)
- Add execution states: `queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled` to a new `agent_executions` table (already exists in schema)

### 2C. Session Persistence [Enhancement 2.3]

- Add `agent_sessions` table with context JSON blob
- Adapters load previous session on execution start, save on completion
- Sessions survive across heartbeat cycles

---

## Phase 3: Developer Experience (P1)

### 3A. CLI Tool [Enhancement 4.1]

**New package**: `packages/cli/` using `commander` or `citty`

Commands:
- `eidolon doctor` -- check DB, API keys, storage, server connectivity
- `eidolon configure` -- interactive config setup
- `eidolon run` -- start server with pre-flight checks
- `eidolon db:backup` / `db:migrate` / `db:seed`
- `eidolon agent list/create/wake`
- `eidolon task list/create/assign`
- `--json` flag on all commands

### 3B. API Documentation [Enhancement 4.3]

- Add `swagger-jsdoc` + `swagger-ui-express` to server
- Generate OpenAPI spec from Zod schemas (use `zod-to-openapi` or `@asteasolutions/zod-to-openapi`)
- Serve at `/api/docs`

### 3C. PostgreSQL Support [Enhancement 5.1]

- Add `drizzle-orm/node-postgres` driver alongside `better-sqlite3`
- Environment switch: `DATABASE_PROVIDER=sqlite|postgres`, `DATABASE_URL`
- Abstract DB creation in `packages/db/src/index.ts` to return either SQLite or PG Drizzle instance
- Dual migration support

### 3D. Docker [Enhancement 8.3]

- `Dockerfile` (multi-stage: build + production)
- `docker-compose.yml` (Eidolon + optional Postgres)
- `.dockerignore`
- Health check in compose

---

## Phase 4: Governance & Workflows (P1)

### 4A. Board Governance [Enhancement 1.3]

- Add `board_member` role in BetterAuth organization roles
- Board members can: pause agents, override decisions, set budgets, approve high-impact actions
- Bootstrap flow: first user who creates a company becomes board member + owner
- Audit trail: all board actions logged to `activity_log`

### 4B. Approval Workflows [Enhancement 3.3]

- New `approvals` table (id, companyId, type, entityId, requestedBy, status, approvedBy, comment, createdAt)
- Approval rules engine: configurable per-company (e.g., "budget changes > $100 require board approval")
- API: `POST /api/companies/:companyId/approvals`, `PATCH .../approvals/:id` (approve/reject)
- UI: Approvals queue page, inline approve/reject

### 4C. Cron Scheduling [Enhancement 3.2]

- Per-agent cron expressions stored in DB
- Cron evaluator in scheduler (replace simple interval check)
- Event-triggered automation rules table
- Retry with exponential backoff for failed tasks

### 4D. Onboarding Wizard [Enhancement 7.1]

- New `ui/src/pages/Onboarding.tsx` -- step-by-step: create company -> configure API keys -> hire first agent -> create first task
- Show on first visit (no companies exist)
- Progress indicator, skip option

---

## Phase 5: Polish & Extensibility (P2-P3)

### 5A. Retry & Circuit Breaker [Enhancement 6.1]
- Configurable retry policies per adapter
- Circuit breaker pattern: track failures, open circuit after N failures
- Dead letter queue for permanently failed tasks

### 5B. Health Check Improvements [Enhancement 6.3]
- Add DB connectivity, LLM reachability, disk space, migration status to `/api/health`

### 5C. UI Polish [Enhancements 7.2-7.7]
- Run transcript display with streaming
- Live execution monitoring with status indicators
- Instance settings page
- Loading skeletons, empty states, keyboard shortcuts
- Dark mode (already using Tailwind)

### 5D. Plugin System [Enhancement 8.1]
- Plugin SDK with lifecycle hooks
- UI extension slots
- Plugin registry

### 5E. Agent Skills & Evals [Enhancements 2.4, 9.2]
- Skills framework with trust levels
- Evaluation framework for agent quality

### 5F. Webhook Improvements [Enhancement 8.2]
- Retry with backoff, delivery logs, HMAC signatures

### 5G. Test Coverage [Enhancement 9.1]
- Race condition tests (concurrent task assignment)
- E2E workflow tests
- Load tests for scheduler with 100+ agents

---

## Verification Plan

### Phase 1 Verification
1. **Auth flow**: Register user -> login -> create company -> verify session persists across page reloads
2. **RBAC**: Viewer cannot create tasks, Admin can, Owner can delete company
3. **API keys**: Generate API key -> use it to call `/api/companies/:id/tasks` -> verify access
4. **Local trusted mode**: Set `AUTH_MODE=local_trusted` -> verify no login required, all routes accessible
5. **Race condition**: Run concurrent task assignment test -- verify no duplicate assignments
6. **Timeouts**: Create agent with 5s timeout, assign task, verify it transitions to `timed_out`

### Phase 2 Verification
1. **Adapter**: Register a mock adapter, assign task to agent using it, verify execution
2. **Wakeup**: POST to wakeup endpoint, verify agent picks up task immediately

### Phase 3 Verification
1. **CLI**: Run `eidolon doctor` and verify all checks pass
2. **API docs**: Navigate to `/api/docs`, verify all endpoints documented
3. **Docker**: `docker compose up` -> verify full stack runs

### Running Tests
```bash
pnpm test:run              # Unit tests
pnpm dev                   # Manual E2E via UI
curl localhost:3100/api/health  # Health check
```

---

## Key Files Reference

| Area | Critical Files |
|---|---|
| Server entry | `server/src/index.ts`, `server/src/app.ts` |
| Middleware | `server/src/middleware/error-handler.ts`, `server/src/middleware/validate.ts` |
| DB Schema | `packages/db/src/schema/*.ts`, `packages/db/src/schema/index.ts` |
| Task assignment | `server/src/services/task-assigner.ts`, `server/src/services/scheduler.ts` |
| Providers | `server/src/providers/*.ts` |
| Services | `server/src/services/orchestrator.ts`, `server/src/services/agent-executor.ts` |
| UI routing | `ui/src/App.tsx` |
| UI layout | `ui/src/components/layout/AppShell.tsx`, `ui/src/components/layout/Sidebar.tsx` |
| Config | `.env.example`, `package.json` (root) |
