# Eidolon vs. Paperclip — Deep Dive & Enhancement Plan

_As of 2026-04-16 — Eidolon `main` at 812756d, Paperclip `master` at v2026.416.0_

---

## 1. Context

Eidolon is a from-scratch rebuild of [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — an "AI company control plane" that turns agents into employees inside companies with goals, budgets, tasks, and an org chart. Paperclip has moved fast in the last ~60 days (adapters SDK, plugin SDK, standalone MCP server, chat-style issue thread, execution policies, blocker deps, inbox polish).

The repo already has a P0→P3 roadmap in [ENHANCEMENTS.md](ENHANCEMENTS.md) that pre-dates the most recent Paperclip releases. **The big P0 item — auth — has landed (commit 812756d).** The user now wants a fresh, thorough pass that:

1. Verifies what's actually wired up and working.
2. Flags duplicate/overlapping surfaces.
3. Lists new features/enhancements Paperclip shipped since the last audit.
4. Prioritizes next moves.

This plan is that deliverable. It is **analysis + recommendations**, not a single implementation plan — the user asked for outlining work, not starting it.

---

## 2. Eidolon — What's Actually There (Feature Inventory)

### 2.1 Stack

- **Monorepo** (pnpm 10.33, workspaces): `server/`, `ui/`, `packages/db`, `packages/shared`
- **Server**: Express 5, Drizzle + `better-sqlite3`, **BetterAuth** (email/password, Google OAuth, `organization` + `bearer` + `admin` plugins), pino logger, native WS (`server/src/realtime/ws-server.ts`), event bus (`server/src/realtime/events.ts`)
- **UI**: Vite + React + React Router v6, Tailwind + shadcn-style components, clsx
- **Tests**: Vitest + Supertest (`server/src/__tests__/`: agents, companies, health, secrets, tasks)
- **Deploy**: none checked in — no Dockerfile, no CI, no vercel.ts, no production build story beyond `express.static` fallback
- **Missing workspace entries** vs Paperclip: no `cli/`, no `packages/adapters/*`, no `packages/plugins/*`, no `packages/mcp-server`, no `skills/`, no `docs/`, no `evals/`

### 2.2 Server routes (`server/src/routes/`)

`activity`, `agents`, `analytics`, `budgets`, `chat`, `collaborations`, `companies`, `evaluations`, `files`, `goals`, `health`, `integrations`, `knowledge`, `mcp`, `memories`, `messages`, `projects`, `prompts`, `secrets`, `tasks`, `templates`, `webhooks`, `workflows` (23 route files, all wired in [server/src/app.ts](server/src/app.ts)).

### 2.3 Server services (`server/src/services/`)

`agent-executor`, `agentic-loop` (Observe→Think→Act→Reflect), `budget-enforcer`, `collaboration`, `crypto`, `evaluation`, `knowledge` (with chunks), `mcp-client`, `memory`, `orchestrator`, `scheduler` (heartbeat, 30s tick), `task-assigner`, `templates` (1022 lines).

### 2.4 DB schema (`packages/db/src/schema/`, SQLite)

Business: `companies`, `agents`, `agent_config_revisions`, `agent_executions`, `agent_memories`, `agent_files`, `agent_collaborations`, `agent_evaluations`, `tasks`, `projects`, `goals`, `messages`, `activity_log`, `heartbeats`, `cost_events`, `budget_alerts`, `secrets`, `webhooks`, `workflows`, `prompts`, `integrations`, `knowledge`, `mcp_servers`, `company_templates`. Auth (BetterAuth): `users`, `sessions`, `accounts`, `verifications`, `organizations`, `members`, `invitations`, `apikeys`.

### 2.5 UI pages (`ui/src/pages/`) — routed in [ui/src/App.tsx](ui/src/App.tsx:63)

`Login`, `Register`, `CompanyList`, `Templates`, then under `/company/:companyId/`: `CompanyDashboard`, `Inbox`, `ProjectList`, `ProjectDetail`, `TaskBoard` (at `/issues`), `TaskDetail`, `GoalTree`, `AgentList`, `AgentDetail`, `OrgChart`, `VirtualWorkspace`, `Documents`, `PromptStudio`, `Analytics`, `Integrations`, `CompanySettings`.

### 2.6 What's distinctive to Eidolon (not in Paperclip)

| Feature | Evidence |
|---|---|
| **Agentic Loop** runtime (Observe→Think→Act→Reflect) | [server/src/services/agentic-loop.ts](server/src/services/agentic-loop.ts) |
| **Knowledge base with RAG chunking** | [packages/db/src/schema/knowledge.ts](packages/db/src/schema/knowledge.ts), [server/src/services/knowledge.ts](server/src/services/knowledge.ts) |
| **Agent memories** (per-agent long-term) | [packages/db/src/schema/agent_memories.ts](packages/db/src/schema/agent_memories.ts) |
| **Virtual Workspace** (floor/desk visual) | [ui/src/pages/VirtualWorkspace.tsx](ui/src/pages/VirtualWorkspace.tsx), `ui/src/components/workspace/*` |
| **Collaboration primitive** (delegate/request_help/review/escalation) | [server/src/services/collaboration.ts](server/src/services/collaboration.ts) |
| **Prompt Studio** with template versioning | [ui/src/pages/PromptStudio.tsx](ui/src/pages/PromptStudio.tsx) |
| **Agent config revisions with rollback** | [server/src/routes/agents.ts:789](server/src/routes/agents.ts:789) |
| **API key auto-encryption on PATCH** (in-flight) | [server/src/routes/agents.ts:196](server/src/routes/agents.ts:196) |

---

## 3. What's In Flight (Uncommitted Work)

From `git status` + diff on modified files:

- **[ui/src/lib/ai-catalog.ts](ui/src/lib/ai-catalog.ts)** — new, untracked. Single source of truth for providers/models (anthropic, openai, google, local/ollama). **Dropped `mistral` and `custom`** from UI options.
- [ui/src/pages/AgentDetail.tsx](ui/src/pages/AgentDetail.tsx), [ui/src/components/agents/CreateAgentModal.tsx](ui/src/components/agents/CreateAgentModal.tsx), [ui/src/pages/CompanySettings.tsx](ui/src/pages/CompanySettings.tsx) — all refactored to consume the catalog (eliminates 3× duplicated PROVIDER/MODEL maps).
- [server/src/routes/agents.ts](server/src/routes/agents.ts) — CreateAgentBody `provider` enum now `anthropic | openai | google | local | ollama`; `ollama` is normalized to `local` on persist; `apiKeyEncrypted` values are auto-encrypted via `normalizeApiKeyForStorage` unless already in `iv:tag:ct` form.
- [server/src/__tests__/agents.test.ts](server/src/__tests__/agents.test.ts) — three new tests: ollama alias, apikey encryption on PATCH, execution summary shape.
- [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) — GitNexus boilerplate edits (mirror each other).

**Conclusion:** current in-flight work is a clean provider/model consolidation + API-key hardening. Ship it.

---

## 4. Configuration & Integration Issues

### 4.1 Orphan audit — correction (2026-04-16, post-execution)

**Initial audit was wrong.** All six pages flagged as "orphaned" are actually tab children of a parent page. The composition is deliberate:

| Parent page (routed) | Tab children |
|---|---|
| [ui/src/pages/Documents.tsx](ui/src/pages/Documents.tsx) | `KnowledgeBase`, `FileManager` |
| [ui/src/pages/Analytics.tsx](ui/src/pages/Analytics.tsx) | `AnalyticsDashboard`, `AgentPerformance` |
| [ui/src/pages/Inbox.tsx](ui/src/pages/Inbox.tsx) | `BoardChat`, `MessageCenter` |

Routing them separately would create duplicates in the nav. Deleting `AnalyticsDashboard` or `AgentPerformance` would break `Analytics.tsx`. **No routing or deletion work needed** — the code is well-organized.

What remains valid: the audit surfaced that "Documents" is a confusing umbrella label for Knowledge+Files, and "Analytics" is tab-bar deep even though its two tabs (overview, performance) are substantial standalone views. A future pass could consider flattening either of these into top-level nav, but it's a UX preference, not a bug.

### 4.2 Overlapping communication primitives (3 systems, same shape)

| Surface | Table | Purpose |
|---|---|---|
| `chatRouter` + `BoardChat.tsx` | `messages` with `__board__` sentinel | Human-to-agent chat |
| `messagesRouter` + `MessageCenter.tsx` | `messages` | Agent-to-agent DMs |
| `collaborationsRouter` + service | `agent_collaborations` | Delegation, help requests, reviews, escalations |

These are three parallel APIs using overlapping UI surfaces (both `BoardChat` and `MessageCenter` live inside `Inbox` tabs). Paperclip's model is **comments-on-issues + approvals** — one communication surface, not three. Eidolon should pick one of:

- **(a)** Keep all three but add a clear rubric in the UI (board chat = human↔CEO; messages = 1:1 peer; collaborations = workflow events).
- **(b)** Collapse `messages` into `collaborations` (all peer-to-peer traffic becomes typed collaboration events).
- **(c)** Follow Paperclip: push most traffic onto task comments and kill standalone messaging.

Recommend **(b)** — it's the smallest rename + preserves the UI investment.

### 4.3 Overlapping execution/scheduling services (4 of them)

- `orchestrator.ts` — 278 lines
- `scheduler.ts` — 287 lines (HeartbeatScheduler, assigns tasks)
- `task-assigner.ts` — 336 lines
- `agentic-loop.ts` — multi-step loop runner
- `agent-executor.ts` — single-shot executor

`agents.ts` `POST /execute` dispatches between `AgentExecutor` (single) and `AgenticLoop` (loop) based on `?mode=loop`. Meanwhile `HeartbeatScheduler.tick()` has its own `tryAssignTask` that also updates agent status and emits events — not going through `TaskAssigner`. Paperclip keeps this narrow: one checkout call, one heartbeat entry, one wake path.

**Action:** audit the call graph (`gitnexus_context({name:"tryAssignTask"})` and `"TaskAssigner"`), consolidate to one assignment function used by both scheduler and `/wake`, and have the orchestrator delegate to it.

### 4.4 Auth posture — working, with caveats

[server/src/auth.ts](server/src/auth.ts) is well-built: BetterAuth with Drizzle adapter, email/pw + Google OAuth, `organization` + `bearer` + `admin` plugins, cookie-cache session, `ADMIN_EMAIL` auto-promotion (case-insensitive). [server/src/middleware/auth.ts](server/src/middleware/auth.ts) enforces `requireAuth` + `requireOrgMember(minRole)` and is wired on every company-scoped route.

**Concerns:**

1. **Admin-bypass grants owner access to _any_ org** ([server/src/middleware/auth.ts:133](server/src/middleware/auth.ts:133)). Logged but not approval-gated. Acceptable for a "board operator" model but needs docs.
2. **`AUTH_MODE=local_trusted`** bypasses auth completely with a hard-coded admin user. The code doesn't check bind address — a misconfigured deploy exposes the entire API. Paperclip ties this to loopback/lan/tailnet bind presets.
3. **No rate limiting** on `/api/auth/*` or anywhere else.
4. **No CSRF defense** beyond cookie `sameSite` defaults and the pre-json mount.
5. **Admin bypass has no test coverage** — [ENHANCEMENTS.md:43](ENHANCEMENTS.md:43) already flagged this test gap.
6. **Task-assignment race test gap** — [ENHANCEMENTS.md:44](ENHANCEMENTS.md:44) still open. Scheduler does use a conditional `UPDATE ... WHERE assigneeAgentId IS NULL RETURNING` which is atomic in SQLite, but no concurrency test proves it.

### 4.5 Model defaults are outdated

[server/src/routes/agents.ts:43](server/src/routes/agents.ts:43) defaults `model: "claude-sonnet-4-6"`. Per user's own runtime (opus-4-7-1m), the latest family is now Opus 4.7 / Sonnet 4.6 / Haiku 4.5 — the catalog covers these, but the **default** should move to `claude-sonnet-4-6` → keep, or promote to `claude-opus-4-7` if the catalog adds it. Currently [ai-catalog.ts:32](ui/src/lib/ai-catalog.ts:32) is still on Opus 4.6 — one generation behind Paperclip.

### 4.6 SQLite-only

[ENHANCEMENTS.md:200](ENHANCEMENTS.md:200) flagged this; still open. Paperclip ships Postgres + embedded PGlite. Not blocking, but blocks multi-replica deploys.

### 4.7 `workflows` route + schema exist but UI is absent

[server/src/routes/workflows.ts](server/src/routes/workflows.ts) and `packages/db/src/schema/workflows.ts` are wired, but there's no `Workflows.tsx`. Either build the UI or mark the feature stubbed.

### 4.8 Route/page terminology drift

Routes use `/tasks/:taskId` but list sits at `/issues` (Paperclip uses "issues" uniformly). Pick one vocabulary.

---

## 5. Paperclip — What's New Since ENHANCEMENTS.md (April 2026)

The existing roadmap predates the last three Paperclip releases. Net-new surface area (see the detailed dossier at [Plans/alright-i-need-to-deep-robin-agent-ae19edbbf28bbb36f.md](Plans/alright-i-need-to-deep-robin-agent-ae19edbbf28bbb36f.md) for file-level evidence):

**v2026.416.0 (newest)**

- **Issue chat thread (assistant-ui)** — replaces comment timeline with a streaming chat UI that inlines agent chain-of-thought, tool calls, and human messages.
- **Execution policies** — multi-stage signoff workflow on issues (not just "review" status).
- **Blocker dependencies** with auto-wake when deps resolve.
- **Standalone MCP server** package (`@paperclipai/mcp-server`) — 21 read + 12 write tools + escape hatch.
- **External adapter plugins** — third-party `ServerAdapter` packages installable via `~/.paperclip/adapter-plugins.json`.
- **Inbox parent-child nesting** with `j`/`k` traversal.
- **Adapter capability flags** on `ServerAdapterModule`.

**v2026.403.0**

- **Inbox overhaul**: mail-client shortcuts (`j`/`k`/`a`/`y`/`o`), swipe-to-archive, per-user read state, operator search, "Today" divider.
- **Feedback voting** (thumbs on outputs) + PromptFoo eval suite in `evals/`.
- **Document revisions** with restore flow.
- **Execution workspaces** (experimental) with lifecycle + runtime controls.
- **Optimistic comments** + comment interrupts.
- Telemetry stack with `DO_NOT_TRACK` honored.

**v2026.325.0**

- **Company import/export** with GitHub shorthand refs + nested file picker.
- **Company skills library** (pin GitHub skills, inject into agent home dirs at wake time).
- **Routines engine** — cron recurrence with variables and workspace awareness.

**v2026.318.0**

- **Plugin SDK + runtime** — manifests, cron jobs, webhooks, UI slots/launchers, tool registry, agent-sessions two-way chat.
- **Hermes adapter** (later externalized).
- **Issue documents + attachments** inline editing.

**Paperclip-native architecture we lack entirely**

- Adapter architecture with 7 built-in adapters (claude-local, codex-local, cursor-local, gemini-local, opencode-local, pi-local, openclaw-gateway) + generic `process` / `http`.
- Atomic checkout (`POST /api/issues/:id/checkout`) + `X-Paperclip-Run-Id` audit header on every mutation.
- Scoped-wake fast path + env-payload hydration (`PAPERCLIP_WAKE_PAYLOAD_JSON`).
- PWA / mobile-first (swipe-to-archive, bottom nav).
- `local_trusted` vs `authenticated` modes with loopback/lan/tailnet bind presets.

---

## 6. Recommended Enhancements (ranked)

Every item below has been validated against the current codebase. ✅ = already shipped, ⚠️ = partially there, ❌ = missing.

### Tier A — Ship / fix this week

**A1. Land the in-flight provider catalog** ⚠️
Commit [ui/src/lib/ai-catalog.ts](ui/src/lib/ai-catalog.ts) and the three files that consume it. Currently the only thing blocking a clean PR.

**A2. ~~Remove orphaned UI pages~~** — Cancelled 2026-04-16 after §4.1 re-audit found all six pages are already reachable as tab children. No action.

**A3. Consolidate the three communication APIs (§4.2)**
Pick (b) — collapse `messages` into `collaborations`. Keep BoardChat as a special-cased human surface.

**A4. Bump catalog default models**
Update [ai-catalog.ts](ui/src/lib/ai-catalog.ts) and the server `CreateAgentBody.model` default to a current model (Opus 4.7 or Sonnet 4.6 — match what Paperclip ships).

**A5. Close the test gaps flagged in ENHANCEMENTS.md §1.1**
Add tests for `requireAuth`, `requireOrgMember`, admin-bypass audit-log emission, and concurrent task-assignment race.

### Tier B — High-leverage, next sprint

**B1. Adapter architecture** ❌
Factor [server/src/providers/](server/src/providers/) into a formal `ServerAdapter` interface with capability flags (`streaming`, `tools`, `mcp`, `vision`, etc.). Each current provider becomes an adapter with the same shape Paperclip uses. Don't ship external-plugin loading yet — just the interface + registry, so we can add `claude-local`/`codex-local` later without rewriting. [ENHANCEMENTS.md:81](ENHANCEMENTS.md:81) already specs this.

**B2. Inbox overhaul** ❌
[ui/src/pages/Inbox.tsx](ui/src/pages/Inbox.tsx) is a 51-line 3-tab stub. Copy Paperclip's j/k/a/y/o model — mail-client nav, per-user read state column on existing tables, "mark all read", "Today" divider. The infrastructure (messages, activity_log, collaborations) is already there.

**B3. Approvals surface (real enforcement)** ❌
Tasks have a `review` status but no approval entity. Add `approvals` table + `issue_approvals` join + an `Approvals.tsx` page. Gate budget changes and agent terminations behind it.

**B4. MCP server package** ❌
Paperclip shipped `@paperclipai/mcp-server` as a thin REST wrapper. Eidolon already has MCP server *management* ([server/src/routes/mcp.ts](server/src/routes/mcp.ts)) but isn't an MCP server itself. Publishing one lets Claude Desktop / Cursor drive the platform directly. This is a ~2-day project given the existing REST API.

**B5. Run transcript & streaming**
[server/src/services/agentic-loop.ts](server/src/services/agentic-loop.ts) emits step events but the UI doesn't visualize them. Add a transcript component on AgentDetail → Executions, streaming deltas via the existing WS bus.

**B6. Rate limit + CSRF on auth surface**
Add `express-rate-limit` on `/api/auth/*` and a CSRF token check on state-changing routes. BetterAuth has hooks; use them.

### Tier C — Durable investments

**C1. Routines / cron** ❌
Paperclip `routines_engine` is cron + recurring tasks. Plug into the existing `HeartbeatScheduler` rather than adding a new worker.

**C2. Plugin SDK** ❌
Not worth building now — wait until we have ≥3 concrete extensions. Note in roadmap.

**C3. Postgres + embedded-PG fallback** ❌
Add `@electric-sql/pglite` for local dev and a Drizzle `pg-core` path for prod. Existing [ENHANCEMENTS.md:200](ENHANCEMENTS.md:200) covers this.

**C4. CLI (`eidolon` binary)** ❌
Onboard + doctor + db:backup cover the pain points. Copy Paperclip CLI layout.

**C5. Docker + deploy story** ❌
Multi-stage Dockerfile + `vercel.ts` (or bare Node host docs). Ship a `render.yaml` or `fly.toml`.

**C6. PWA manifest + service worker** ❌
One Vite plugin + a manifest — cheap win for a tool people check on their phones.

**C7. Feedback voting + PromptFoo evals** ⚠️
`evaluations` table exists, `evaluation` service exists, but no UI thumbs. Add `feedback_votes` or reuse `agent_evaluations` and surface it on run outputs.

**C8. Company import/export** ⚠️
`company_templates` partially covers this. Extend to full export (agents + goals + projects + prompts + secrets[redacted]) with a round-trippable JSON.

---

## 7. Critical Files to Open When Executing

- [server/src/app.ts](server/src/app.ts) — wire new routes here
- [server/src/middleware/auth.ts](server/src/middleware/auth.ts) — where rate-limit + CSRF go
- [server/src/routes/agents.ts](server/src/routes/agents.ts) — adapter registry entry point
- [server/src/services/scheduler.ts](server/src/services/scheduler.ts) vs [server/src/services/task-assigner.ts](server/src/services/task-assigner.ts) — consolidation target
- [server/src/services/agentic-loop.ts](server/src/services/agentic-loop.ts) — transcript hooks
- [packages/db/src/schema/](packages/db/src/schema/) — add `approvals`, `feedback_votes`, `routines` tables
- [ui/src/App.tsx](ui/src/App.tsx) — add routes for Knowledge + FileManager
- [ui/src/pages/Inbox.tsx](ui/src/pages/Inbox.tsx) — the stub to rewrite
- [ui/src/lib/ai-catalog.ts](ui/src/lib/ai-catalog.ts) — untracked, commit first

---

## 8. Verification Checklist (run after each tier)

```bash
pnpm typecheck            # whole monorepo
pnpm test:run             # vitest suites
pnpm --filter server dev  # Express on :3100
pnpm --filter ui dev      # Vite on :5173
npx gitnexus analyze      # refresh index after schema changes
```

Manual smoke (per tier):

- **Tier A**: `curl /api/companies` returns 401 without cookie; login via UI; create agent with each provider; PATCH apikey and confirm ciphertext at rest (sqlite CLI).
- **Tier B**: drive MCP server from Claude Desktop; exercise j/k in Inbox; submit + resolve an approval.
- **Tier C**: run `npx eidolon doctor`; boot with `DATABASE_URL=postgres://…`; install PWA on phone.

For UI changes use the Claude_Preview MCP (`preview_start`, `preview_snapshot`, `preview_console_logs`) rather than manual clicks.

---

## 9. Confirmed Scope for First Execution Pass

User-confirmed (2026-04-16):

- **Communication merge (§4.2)** → Collapse `messages` into `collaborations`. BoardChat stays as the human↔CEO surface.
- **Orphan cleanup (§4.1)** → Cancelled after re-audit; all six "orphaned" pages are tab children of `Documents`, `Analytics`, or `Inbox`.
- **First execution pass** → **Tier A** (§6), revised:
  1. Stage [ui/src/lib/ai-catalog.ts](ui/src/lib/ai-catalog.ts) + the 3 UI consumers + server changes + new tests — user will review and commit.
  2. Fix stale `tsconfig.tsbuildinfo` + add `exclude` to root tsconfig so `tsc -b` stops complaining about `**/dist`.
  3. Add missing tests: `requireAuth`, `requireOrgMember`, admin-bypass audit-log emission, concurrent task-assignment race (use better-sqlite3 in-memory + `Promise.all` racers).
  4. Bump default model (server `CreateAgentBody.model`) + add Opus 4.7 to [ai-catalog.ts](ui/src/lib/ai-catalog.ts).

Tier B (adapter architecture, real inbox, approvals surface, MCP server package, run transcript, rate limit + CSRF) and Tier C remain queued for subsequent passes.

Per-symbol `gitnexus_impact` must run before editing each of: `CreateAgentBody`, `agentsRouter`, `HeartbeatScheduler.tryAssignTask`, `TaskAssigner`, `App` component.
