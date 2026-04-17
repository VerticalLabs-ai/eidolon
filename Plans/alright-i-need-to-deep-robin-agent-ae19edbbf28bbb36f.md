# Paperclip — Deep Research / Feature Inventory

**Source:** `github.com/paperclipai/paperclip` (default branch: `master`)
**Homepage:** `paperclip.ing`
**As of:** 2026-04-16 (latest release `v2026.416.0` same day)
**Stars / Forks:** 54,798 / 9,224 — Open issues: 2,360 — Subscribers: 314
**License:** MIT &copy; 2026 Paperclip
**Created:** 2026-03-02 (just ~6 weeks old at time of research — explosive growth)
**Language:** TypeScript (97.4%)

> Tagline: *"Open-source orchestration for zero-human companies."*
> Positioning: *"If OpenClaw is an __employee__, Paperclip is the __company__."*
> Docs: `paperclip.ing/docs` (Mintlify). Discord: `discord.gg/m4HZY7xNG3`.
> Awesome list: `github.com/gsxdsm/awesome-paperclip`.

---

## 1. Overview / Value Proposition

Paperclip is a **control plane for autonomous AI companies** — not a chat app, not an agent framework, not a workflow builder, not a prompt manager. It's a single-tenant but *multi-company* management layer that turns a fleet of coding agents (Claude Code, Codex, Cursor, OpenCode, Pi, Gemini CLI, Hermes, OpenClaw, raw bash, HTTP) into an org chart with goals, budgets, tickets, and governance.

**Three-step flow the README pitches:**
1. Define the company goal (e.g. "Build the #1 AI note-taking app to $1M MRR")
2. Hire the team (CEO, CTO, engineers, designers, marketers — any bot, any provider)
3. Approve and run (review strategy, set budgets, monitor from dashboard)

**Target user profile (from README):**
- Wants to build autonomous AI companies
- Has 20 Claude Code terminals open and is losing track
- Wants agents to run autonomously 24/7 but retain audit + intervention
- Wants per-agent cost/budget enforcement
- Wants a task-manager-like UX
- Wants to run from mobile

**Core product decisions (from `doc/SPEC-implementation.md`):**
- Single-tenant deployment, **multi-company data model** (every business entity is company-scoped)
- **Single human board operator** per deployment (multi-human is on roadmap, not shipped)
- Org graph is a strict tree (`reports_to` nullable root, no multi-manager reporting)
- Communication model is **tasks + comments only** (no separate chat subsystem)
- Task ownership: single assignee, atomic checkout required to move to `in_progress`
- No automatic reassignment — recovery stays explicit
- Built-in `process` and `http` agent adapters; everything else is a plugin/adapter
- Budget window: monthly UTC calendar, soft alerts + hard-stop auto-pause
- Deployment modes: `local_trusted` (implicit board, default) vs `authenticated` (sessions) with `private`/`public` exposure policy
- Storage: Postgres (prod) or embedded PGlite (dev), local disk (`local_disk`) or S3 (`s3`) for objects

---

## 2. Stack

- **Language:** TypeScript end-to-end, ESM
- **Backend:** Node.js 20+, Express REST API in `server/`
- **Frontend:** React + Vite in `ui/`, shadcn-style component library (`components.json`), Tailwind, PWA
- **Chat UI kit:** assistant-ui (for the new chat-style issue thread shipped in v2026.416.0)
- **DB:** PostgreSQL via Drizzle ORM (`packages/db/`). Dev uses **embedded PGlite / embedded-postgres 18.1.0-beta.16** (patched). 56 migrations currently on master.
- **Package manager:** pnpm 9.15.4 (workspaces)
- **Monorepo layout (`pnpm-workspace.yaml`):**
  ```
  packages:
    - packages/*
    - packages/adapters/*
    - packages/plugins/*
    - packages/plugins/examples/*
    - server
    - ui
    - cli
  ```
- **Test stack:** Vitest (unit), Playwright (E2E + release-smoke), PromptFoo (`evals/`)
- **Docs:** Mintlify (`docs/docs.json`)
- **Container:** Dockerfile (Node LTS Trixie slim, multi-stage, ships GitHub CLI + ripgrep + python3; entrypoint runs server via `tsx` loader)
- **Deploy story:** Local-first (embedded PG); production is BYO Postgres + any host; Tailscale private-access path is documented; Vercel mentioned as example cloud target. Installable **PWA** on mobile.

---

## 3. Repo Structure

```
/
  server/                   # Express REST API + orchestration services
  ui/                       # React + Vite board UI (shadcn)
  cli/                      # The `paperclipai` / `npx paperclipai` CLI
  packages/
    db/                     # Drizzle schema + migrations
    shared/                 # Shared types, validators, API path constants
    adapter-utils/          # Shared adapter helpers
    adapters/
      claude-local/
      codex-local/
      cursor-local/
      gemini-local/
      openclaw-gateway/
      opencode-local/
      pi-local/
    mcp-server/             # @paperclipai/mcp-server — MCP wrapper over REST API
    plugins/
      sdk/                  # @paperclipai/plugin-sdk (+ /ui, /testing, /bundlers, /dev-server)
      create-paperclip-plugin/
      examples/
        plugin-authoring-smoke-example/
        plugin-file-browser-example/
        plugin-hello-world-example/
        plugin-kitchen-sink-example/
  skills/
    paperclip/               # The heartbeat skill agents install into their runtime
    paperclip-create-agent/
    paperclip-create-plugin/
    para-memory-files/
  doc/                      # Internal specs (SPEC, PRODUCT, GOAL, DATABASE, DEPLOYMENT-MODES…)
  docs/                     # Public Mintlify docs
  evals/                    # PromptFoo suites
  tests/                    # e2e + release-smoke Playwright
  docker/  scripts/  patches/  releases/  report/
  AGENTS.md  ROADMAP.md  adapter-plugin.md  Dockerfile  .env.example
```

Key root files to know: `AGENTS.md` (contributor rules), `ROADMAP.md` (full roadmap), `adapter-plugin.md` (external-adapter plugin contract), `doc/SPEC-implementation.md` (V1 build contract), `doc/PRODUCT.md` (positioning).

---

## 4. Feature Inventory

### 4.1 Control-plane domain (from server routes + UI pages + DB schema)

**Server routes (`server/src/routes/*.ts`) — each is the API surface for a feature area:**
`access`, `activity`, `adapters`, `agents`, `approvals`, `assets`, `authz`, `companies`, `company-skills`, `costs`, `dashboard`, `execution-workspaces`, `goals`, `health`, `inbox-dismissals`, `instance-settings`, `issues`, `issues-checkout-wakeup`, `llms`, `org-chart-svg`, `plugin-ui-static`, `plugins`, `projects`, `routines`, `secrets`, `sidebar-badges`, `sidebar-preferences`, `workspace-command-authz`, `workspace-runtime-service-authz`.

**UI pages (`ui/src/pages/*.tsx`):**
`Auth`, `BoardClaim`, `CliAuth`, `Companies`, `CompanyExport`, `CompanyImport`, `CompanySettings`, `CompanySkills`, `Costs`, `Dashboard`, `DesignGuide`, `ExecutionWorkspaceDetail`, `GoalDetail`, `Goals`, `Inbox`, `IssueDetail`, `Issues`, `MyIssues`, `NewAgent`, `NotFound`, `Org`, `OrgChart`, `PluginManager`, `PluginPage`, `PluginSettings`, `ProjectDetail`, `ProjectWorkspaceDetail`, `Projects`, `RoutineDetail`, `Routines`, `Approvals`, `ApprovalDetail`, `AdapterManager`, `InstanceSettings`, `InstanceGeneralSettings`, `InstanceExperimentalSettings`, `InviteLanding`, `IssueChatUxLab`, `RunTranscriptUxLab`, `Activity`.

**DB tables (`packages/db/src/schema/*.ts`) — ~60 tables, grouped:**
- **Identity/auth:** `auth`, `company_memberships`, `invites`, `join_requests`, `instance_user_roles`, `principal_permission_grants`, `board_api_keys`, `agent_api_keys`, `cli_auth_challenges`, `instance_settings`
- **Companies & org:** `companies`, `company_logos`, `company_secrets`, `company_secret_versions`, `company_skills`, `company_user_sidebar_preferences`, `user_sidebar_preferences`, `agents`, `agent_config_revisions`, `agent_runtime_state`, `agent_task_sessions`, `agent_wakeup_requests`
- **Work:** `goals`, `projects`, `project_goals`, `project_workspaces`, `labels`, `issue_labels`, `issues`, `issue_comments`, `issue_documents`, `document_revisions`, `documents`, `issue_attachments`, `issue_relations`, `issue_read_states`, `issue_inbox_archives`, `issue_work_products`, `issue_approvals`, `issue_execution_decisions`, `inbox_dismissals`
- **Execution / workspaces:** `execution_workspaces`, `workspace_operations`, `workspace_runtime_services`, `heartbeat_runs`, `heartbeat_run_events`
- **Money:** `cost_events`, `budget_policies`, `budget_incidents`, `finance_events`
- **Automation:** `routines`
- **Approvals:** `approvals`, `approval_comments`
- **Plugins:** `plugins`, `plugin_config`, `plugin_company_settings`, `plugin_entities`, `plugin_jobs`, `plugin_logs`, `plugin_state`, `plugin_webhooks`
- **Quality:** `feedback_votes`, `feedback_exports`, `activity_log`, `assets`, `quota_windows`

### 4.2 Feature groups (with file-level evidence)

**Companies & org chart**
- First-class multi-company; every entity is company-scoped (`doc/SPEC-implementation.md`)
- Import/export entire companies with secret scrubbing, GitHub shorthand refs, nested-file-picker (shipped v2026.325.0, routes: `companies.ts`, UI: `CompanyImport.tsx`, `CompanyExport.tsx`)
- Company logos with SVG sanitization
- `companies.sh` CLI equivalent for import/export
- Org chart SVG generation route (`server/src/routes/org-chart-svg.ts`)
- `OrgChart.tsx` + `Org.tsx` pages render the org graph; `reports_to` tree

**Agents & adapters**
- Agent creation wizard (`NewAgent.tsx`, `NewAgentDialog.tsx`), icon picker, role/reports-to picker
- Shipping **7 built-in adapters**: `claude-local`, `codex-local`, `cursor-local`, `gemini-local`, `opencode-local`, `pi-local`, `openclaw-gateway` — plus generic `process` and `http` runtimes
- **Hermes** adapter exists as an external plugin (not a built-in on upstream — `hermes_local` type is supported)
- **Capability flags** on adapters (`ServerAdapterModule.capabilities`, PR #3540, 2026-04-15)
- External-adapter plugin system (`adapter-plugin.md`, `~/.paperclip/adapter-plugins.json`, npm or `file:` install, config-schema + `ui-parser.js` — merged as PRs #2649–2654)
- Agent `status_changed`, `budget_monthly_cents`, `spent_monthly_cents`, `context_mode: thin | fat`, `last_heartbeat_at`, `reports_to` invariants (no cycles)
- **Agent permissions**, **agent instructions** (`default-agent-instructions.ts`), **hire hook** (`hire-hook.ts`)
- **Claude subscription panel** and **Codex subscription panel** components — quota surfacing from provider accounts
- **Provider quota card** (`ProviderQuotaCard.tsx`, `QuotaBar.tsx`)
- **GPT-5.4** + `xhigh` effort level in OpenAI-based adapters (shipped v2026.403.0)
- **Opus 4.7** in Claude adapter dropdown (commit 2026-04-16)

**Heartbeats & run model**
- Agents run on **scheduled heartbeats** + event wakes (comment, @-mention, approval resolved, assignment, blocker resolved)
- `heartbeat_runs` / `heartbeat_run_events` persistence
- **Atomic issue checkout** via `POST /api/issues/:id/checkout` with `X-Paperclip-Run-Id` header for traceability
- **Wake payload injection** — env vars `PAPERCLIP_WAKE_REASON`, `PAPERCLIP_WAKE_COMMENT_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_APPROVAL_ID`, `PAPERCLIP_LINKED_ISSUE_IDS`, `PAPERCLIP_WAKE_PAYLOAD_JSON`
- **Scoped-wake fast path** — agent skips inbox lookup and jumps straight to the checkout for the targeted issue
- **Auto-checkout** for scoped wakes in the harness (v2026.416.0)
- **Resume delta** — agents resume prior task context across heartbeats
- **Heartbeat context** endpoint `GET /api/issues/:id/heartbeat-context` returns compact state + ancestor summaries + comment cursor
- **Heartbeat run summary** (`services/heartbeat-run-summary.ts`), **heartbeat-lite inbox** (`/api/agents/me/inbox-lite`)
- **Heartbeat token optimization** (v2026.318.0) — skip redundant token usage on no-op cycles
- **Adapter-aware session compaction** (per-adapter context limits)
- Default **max turns raised to 300** (v0.3.1)

**Issues / tickets (the core work object)**
- Hierarchical: `parent_id`, `request_depth`, traces up to a company goal
- Statuses: `backlog | todo | in_progress | in_review | done | blocked | cancelled`
- Priorities: `critical | high | medium | low`
- Single assignee; atomic checkout invariant
- `billing_code` field for cost attribution
- **Kanban board** (`KanbanBoard.tsx`), list view, **grouped by workspace** (v2026.416.0)
- **Issue chat thread** — new chat-style thread powered by assistant-ui replacing the old comment timeline (v2026.416.0, PR #3079, major flagship feature)
- **Comment interrupts** + queued-comment UX + optimistic comment IDs
- **Copy comment as markdown**
- **Sub-issues** + issue tree (`issue-tree.ts`)
- **Mermaid diagrams** render in comment/description markdown
- **Image gallery** modal + inline image attachments
- **Mention chips** with custom URL schemes + atomic deletion
- **Live run output** streamed over WebSocket with coalesced deltas
- **Scroll-to-bottom** button + **keyboard shortcuts** cheatsheet
- **Retry failed runs** button
- **Issue documents** — inline rich-doc editing on issues, file staging pre-create, copy/download actions, live refresh (v2026.318.0)
- **Document revisions** — full revision history, restore flow, revision tracking API (v2026.403.0)
- **Issue link quicklook** (`IssueLinkQuicklook.tsx`), **issues quicklook**, **issue group header**
- **Filters popover** with project/assignee/status filters (Me/Unassigned shortcuts)
- **Issue attachments** — configurable MIME types via `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES`

**Inbox (big investment area)**
- Dedicated **"Mine" tab** with mail-client shortcuts: `j`/`k` nav, `a`/`y` archive, `o` open (v2026.403.0)
- **Swipe-to-archive** (`SwipeToArchive.tsx` — also mobile)
- **"Mark all as read"**
- **Operator search** inside inbox with keyboard controls
- **"Today" divider** + per-user read state on all inbox items
- **Parent-child nesting** with toggle + keyboard traversal across nested items (v2026.416.0)
- **Unread indicators** in inbox, dashboard, and browser tab (blue dot)
- **Inbox badge** includes join requests + approvals; alert-focused ordering
- **Workspace grouping** with collapsible mobile groups (v2026.416.0)
- **Inbox dismissals** table/route

**Goals & projects**
- Goals have levels `company | team | agent | task`, parentage, owner agent
- **Goal tree** UI (`GoalTree.tsx`)
- Projects are linked to one goal, have a lead agent, target date, **env jsonb** (secret-aware env bindings merged into run env, overriding agent env before Paperclip runtime-owned keys)
- **Project workspaces** — first-class concept with detail page (`ProjectWorkspaceDetail.tsx`) and a tab on project view
- **Issue goal fallback** service

**Execution workspaces (experimental / GA-ing)**
- Isolated agent-run workspaces with full lifecycle (v2026.318.0 / v2026.403.0)
- **Runtime controls** (start/stop) — `WorkspaceRuntimeControls.tsx`
- **Close readiness** checks + `ExecutionWorkspaceCloseDialog.tsx`
- **Follow-up issue workspace inheritance**
- **Workspace policy** per-project (`execution-workspace-policy.ts`)
- **Workspace operation log**, **workspace-runtime-read-model**
- **Worktree:cleanup** command + env-var defaults + auto-prefix for worktree branches
- **`worktree:make`** CLI command provisions isolated dev instances with own DB, secrets, favicon branding, git hooks, minimal seed mode

**Cost control & budgets**
- `cost_events` stream (per-agent / -issue / -project / -goal / -company)
- **Monthly per-agent budgets**, hard-stop auto-pause at limit
- **Budget incidents** + **budget policies** tables
- **Budget incident card**, **budget policy card**, **budget sidebar marker**
- **Finance events** (`finance.ts` service, `finance_events` table) + **finance timeline card**, **biller spend card**, **finance kind card**, **accounting model card**
- **Quota windows** service + **quota bar** UI
- **Anthropic subscription quota** surfacing
- `Costs.tsx` page + `MetricCard.tsx`

**Approvals & governance**
- **Approvals** first-class with `approvals.ts` route + service, `approval_comments`, `ApprovalCard.tsx`, `ApprovalPayload.tsx`
- **Issue approvals** — can link any approval to any issue (`issue_approvals` + `issue-approvals.ts`)
- **Execution policies** — multi-stage signoff workflow on issues with per-stage reviewers/approvers, automatic stage routing (v2026.416.0, PR #3222) — `issue-execution-policy.ts`, `issue_execution_decisions`
- **Board claim** flow (`BoardClaim.tsx`, `board-claim.ts`) — human operator claim
- **Activity log** for every mutation (`activity_log` + `activity.ts`)
- **Blocker dependencies** — `blockedByIssueIds`, auto-wake on dependency resolved (v2026.416.0, PR #2797)

**Routines (recurring tasks)**
- Full routines engine: cron triggers, routine runs, coalescing, portability (v2026.325.0)
- **Routine variables** (dialog + editor) + **workspace-aware routine runs**
- `Routines.tsx`, `RoutineDetail.tsx`, `RoutineRunVariablesDialog.tsx`, `RoutineVariablesEditor.tsx`, `ScheduleEditor.tsx`
- New **`paperclip-routines` skill** documents routine management for agents

**Skills system**
- **Company skills library** (v2026.325.0) — company-scoped skills with UI, pinned GitHub skills + update checks, built-in skill support
- **Agent skill sync** across all local adapters (Claude, Codex, Pi, Gemini)
- Skills include: `paperclip` (heartbeat procedure), `paperclip-create-agent`, `paperclip-create-plugin`, `para-memory-files`, `paperclip-routines`
- Skills installed into adapter home dirs (e.g. `~/.gemini/` for Gemini)
- **Agent instructions recovery** from disk on startup

**Plugin framework**
- Full plugin runtime shipped v2026.318.0 (PRs #904, #910, #912, #909, #1074)
- `@paperclipai/plugin-sdk` with worker, UI, testing harness, bundlers, dev-server entry points
- **Manifest-based** (capabilities, jobs, webhooks, UI slots, UI launchers)
- **Worker lifecycle:** `setup`, `onHealth`, `onConfigChanged`, `onShutdown`, `onValidateConfig`, `onWebhook`
- **Context API:** `config`, `events`, `jobs`, `launchers`, `http`, `secrets`, `activity`, `state`, `entities`, `projects`, `companies`, `issues`, `agents`, `goals`, `data`, `actions`, `streams`, `tools`, `metrics`, `logger`, `manifest`
- **Agent sessions** (two-way chat): `ctx.agents.sessions.create`, `list`, `sendMessage` (streaming `onEvent`), `close`
- **Scheduled jobs** via cron in manifest + `ctx.jobs.register`
- **Webhooks:** `POST /api/plugins/:pluginId/webhooks/:endpointKey`
- **State scopes:** `instance`, `company`, `project`, `project_workspace`, `agent`, `issue`, `goal`, `run`
- **Core domain events** plugins can subscribe to: `company.*`, `project.*`, `project.workspace_*`, `issue.created/updated/comment.created`, `agent.created/updated/status_changed`, `agent.run.started/finished/failed/cancelled`, `goal.*`, `approval.created/decided`, `cost_event.created`, `activity.logged`
- **Plugin-to-plugin events:** `plugin.<pluginId>.<eventName>`
- **UI slots + launchers** — extensibility zones in the board UI
- **Dev server** with SSE hot reload, in-memory testing harness
- **Kitchen-sink + file-browser + hello-world + authoring-smoke** example plugins
- **Plugin dev watcher**, **capability validator**, **config validator**, **event bus**, **host service cleanup**, **host services**, **job coordinator**, **job scheduler**, **job store**, **lifecycle**, **loader**, **log retention**, **manifest validator**, **registry**, **runtime sandbox**, **secrets handler**, **state store**, **stream bus**, **tool dispatcher**, **tool registry**, **worker manager** — every one of those is a separate service file in `server/src/services/`, which gives a sense of the investment depth.
- **Plugin-UI static server** route

**Secrets & env**
- `company_secrets` + `company_secret_versions` tables (versioned)
- **Secret-aware env binding format** shared by agent + project env
- **Env var editor** component (`EnvVarEditor.tsx`)
- Inline-env secret migration script (`scripts/migrate-inline-env-secrets.ts`)
- `PAPERCLIP_ALLOWED_ATTACHMENT_TYPES`, `PAPERCLIP_PUBLIC_URL`, `PAPERCLIP_API_URL`, `PAPERCLIP_TELEMETRY_DISABLED`, `DO_NOT_TRACK`, `AUTH_DISABLE_SIGNUP`

**Auth & multi-user**
- **`local_trusted` (default)** — implicit board, no friction (lan/tailnet/loopback bind presets)
- **`authenticated` mode** — Better-Auth (`BETTER_AUTH_SECRET` in `.env.example`) — sessions + hashed agent API keys + **bind presets** (loopback / lan / tailnet)
- **Board API keys** + **agent API keys** hashed at rest (never access other companies)
- **CLI auth challenges** flow for `paperclipai` CLI
- **Invites** + **join requests** (inline in inbox)
- **Instance user roles** + **principal permission grants**
- `auth.disableSignUp` config / `AUTH_DISABLE_SIGNUP`
- **Board mutation guard** hardened via `PAPERCLIP_PUBLIC_URL` trust
- Multi-human support is **not shipped** — it's on the roadmap as "Multiple Human Users"

**Feedback & evals**
- **Thumbs-up/down voting** on outputs (v2026.403.0, PR #2529)
- `feedback_votes` + `feedback_exports` tables
- `OutputFeedbackButtons.tsx`, `feedback.ts` service, `feedback-redaction.ts`, `feedback-share-client.ts`
- PromptFoo eval suite in `evals/promptfoo/`
- Docs page at `docs/feedback-voting.md`

**Mobile & PWA**
- Installable **PWA** with service worker (network-first) — v0.3.0
- **MobileBottomNav.tsx**, swipe-to-archive, mobile-aware inbox layout
- A11y fix: removed `maximum-scale` and `user-scalable=no` (commit 2026-04-15)

**Misc UX polish**
- **Command palette** (`CommandPalette.tsx`)
- **Sidebar** with badges + preferences + per-company preferences
- **Breadcrumb bar**, **page tab bar**, **properties panel**
- **Design guide** page
- **Issue chat UX lab** + **Run transcript UX lab** pages (they ship an internal UX-experimentation sandbox in the app)
- **Onboarding wizard** — adapter env checks animate on success/failure; Claude Code + Codex recommended
- **Markdown editor** (Lexical-based) with **soft-break remark plugin**, paste normalization, mention-aware link node
- **Ascii art animation** component (branding moment)
- **Dev restart banner** + **worktree banner**
- **Copy text**, **empty state**, **identity**, **metric card** shared components

**Telemetry**
- Anonymized, enabled by default, per-install salt hashes for private repo refs
- Disable via `PAPERCLIP_TELEMETRY_DISABLED=1`, `DO_NOT_TRACK=1`, `CI=true`, or config `telemetry.enabled: false`
- `server/src/telemetry.ts`

### 4.3 Standalone MCP server — `@paperclipai/mcp-server`

New package in v2026.416.0 (PR #2435). Thin MCP wrapper over the REST API. Env-configured (`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_RUN_ID`). Run via `npx -y @paperclipai/mcp-server`.

**Read tools (21):** `paperclipMe`, `paperclipInboxLite`, `paperclipListAgents`, `paperclipGetAgent`, `paperclipListIssues`, `paperclipGetIssue`, `paperclipGetHeartbeatContext`, `paperclipListComments`, `paperclipGetComment`, `paperclipListIssueApprovals`, `paperclipListDocuments`, `paperclipGetDocument`, `paperclipListDocumentRevisions`, `paperclipListProjects`, `paperclipGetProject`, `paperclipListGoals`, `paperclipGetGoal`, `paperclipListApprovals`, `paperclipGetApproval`, `paperclipGetApprovalIssues`, `paperclipListApprovalComments`.

**Write tools (12):** `paperclipCreateIssue`, `paperclipUpdateIssue`, `paperclipCheckoutIssue`, `paperclipReleaseIssue`, `paperclipAddComment`, `paperclipUpsertIssueDocument`, `paperclipRestoreIssueDocumentRevision`, `paperclipCreateApproval`, `paperclipLinkIssueApproval`, `paperclipUnlinkIssueApproval`, `paperclipApprovalDecision`, `paperclipAddApprovalComment`.

**Escape hatch:** `paperclipApiRequest` (any `/api` path, JSON).

### 4.4 CLI — `paperclipai` / `npx paperclipai`

- `npx paperclipai onboard --yes` — default first run (loopback trusted mode)
- `npx paperclipai onboard --yes --bind lan` / `--bind tailnet` — alternate exposure
- `paperclipai configure` — edit existing config
- `paperclipai worktree:make` / `worktree:cleanup` — dev worktree provisioning
- `paperclipai db:backup` — on-demand / scheduled snapshots
- `paperclipai company import` / `company export`
- `paperclipai agent local-cli <id> --company-id <id>` — print PAPERCLIP_* env vars + install skills for Claude/Codex
- Dev-runner with worktree env isolation + bind presets

### 4.5 Docs (public Mintlify — `docs/docs.json`)

Tabs: **Get Started** (what-is, quickstart, core-concepts, architecture), **Guides → Board Operator** (dashboard, creating-a-company, managing-agents, org-structure, managing-tasks, execution-workspaces-and-runtime-services, delegation, approvals, costs-and-budgets, activity-log, importing-and-exporting), **Guides → Agent Developer** (how-agents-work, heartbeat-protocol, writing-a-skill, task-workflow, comments-and-communication, handling-approvals, cost-reporting), **Deploy** (overview, local-development, tailscale-private-access, docker, deployment-modes, database, secrets, storage, environment-variables), **Adapters** (overview, claude-local, codex-local, process, http, external-adapters, adapter-ui-parser, creating-an-adapter), **API Reference** (overview, authentication, companies, agents, issues, approvals, goals-and-projects, costs, secrets, activity, dashboard), **CLI** (overview, setup-commands, control-plane-commands).

Also internal docs: `execution-policy.md`, `openclaw-docker-setup.md`, `feedback-voting.md`, `agents-runtime.md`.

### 4.6 Internal specs (`doc/`)

`GOAL.md`, `PRODUCT.md`, `SPEC.md`, `SPEC-implementation.md`, `DATABASE.md`, `DEVELOPING.md`, `DOCKER.md`, `DEPLOYMENT-MODES.md`, `CLI.md`, `CLIPHUB.md`, `OPENCLAW_ONBOARDING.md`, `PUBLISHING.md`, `RELEASING.md`, `RELEASE-AUTOMATION-SETUP.md`, `TASKS.md`, `TASKS-mcp.md`, `UNTRUSTED-PR-REVIEW.md`, `execution-semantics.md`, `memory-landscape.md`, `AGENTCOMPANIES_SPEC_INVENTORY.md`, plus `plans/`, `plugins/`, `spec/`, `experimental/` subdirs.

---

## 5. Recent / New Features (last ~60 days)

Repo is only ~6 weeks old; **everything** is recent. Grouped by release, latest first:

### v2026.416.0 — 2026-04-16 (latest)
- **Issue chat thread** — replaces classic comment timeline with full chat-style thread powered by **assistant-ui**. Agent run transcripts, chain-of-thought, user messages render inline as one conversation with avatars, action bars, relative timestamps. (PR #3079) **Flagship.**
- **Execution policies** — multi-stage signoff workflow on issues. Reviewers/approvers per stage, automatic routing. (PR #3222)
- **Blocker dependencies** — `blockedByIssueIds` + auto-wake when all blockers reach `done`. (PR #2797)
- **Issue-to-issue navigation** — scroll reset, prefetch, detail-view optimizations. (PR #3542)
- **Auto-checkout for scoped wakes** — harness auto-checks-out scoped issue on comment-driven wakes. (PR #3538)
- **Inbox parent-child nesting** — toggle + `j`/`k` nested traversal. (PR #2218)
- **Standalone MCP server** — `@paperclipai/mcp-server` package. (PR #2435) **BETA.**
- **Board approvals** — generic issue-linked board approvals with card styling. (PR #3220)
- **Inbox workspace grouping** — collapsible mobile groups, shared column controls. (PR #3356)
- **External adapter plugins** — third-party adapters installable as npm packages or from local directories; declare config schema + optional UI transcript parser; built-ins can be overridden externally. (PRs #2649, #2650, #2651, #2654, #2655, #2659, #2218)
- Claude adapter: **Opus 4.7** in dropdown
- Heartbeat: `hermes_local` added to `SESSIONED_LOCAL_ADAPTERS`
- A11y: removed `maximum-scale`, `user-scalable=no`
- UI: drop `console.*` and legal comments in prod builds
- **Adapter capability flags** on `ServerAdapterModule` (PR #3540)

### v2026.410.0 — 2026-04-13 (security release)

### v2026.403.0 — 2026-04-03
- **Inbox overhaul** — Mine tab, mail-client shortcuts (j/k/a/y/o), swipe-to-archive, "Mark all as read", operator search, "Today" divider, per-user read state (PRs #2072, #2540)
- **Feedback & evals** — thumbs UI, feedback modal (PR #2529)
- **Document revisions** — history + restore flow (PR #2317)
- **Telemetry** — anonymized, `DO_NOT_TRACK=1` opt-out (PR #2527)
- **Execution workspaces** (experimental) — full lifecycle, runtime controls, close readiness, workspace-aware routines, project workspace detail pages (PRs #2074, #2203)
- **Comment interrupts** with queued UX
- **Docker** host UID/GID mapping, base image reorg (PRs #2407, #1923)
- **Optimistic comments**
- **GitHub Enterprise** support (PR #2449)
- **Gemini local adapter** validation fix (PR #2430)
- **Routines** — `paperclip-routines` skill, variables, workspace-awareness (PR #2414)
- **GPT-5.4** + `xhigh` effort (PR #112)

### v2026.325.0 — 2026-03-25
- **Company import/export** — file-browser UX, frontmatter preview, nested file picker, merge history, GitHub shorthand refs, CLI commands (PRs #840, #1631, #1632, #1655)
- **Company skills library** — company-scoped skills UI, agent skill sync across Claude/Codex/Pi/Gemini, pinned GitHub skills (PR #1346)
- **Routines engine** — triggers, coalescing, portability (PRs #1351, #1622)
- Inline join requests in inbox, onboarding seeding, alphabetical agent sorting, improved CLI API error messages, Lexical LinkNode custom URL schemes, failed-run session resume
- **Docker image CI** (PR #542)
- **Project filter on issues** (PR #552)
- **7 migrations** in this release

### v2026.318.0 — 2026-03-18
- **Plugin framework and SDK** — runtime lifecycle, CLI tooling, settings UI, breadcrumb + slot extensibility, domain event bridge, kitchen-sink example, document CRUD, testing harness (PRs #904, #910, #912, #909, #1074)
- **Upgraded costs & budgeting** (PR #949)
- **Issue documents & attachments** — inline rich-doc editing, file staging, deep-links, live refresh (PR #899)
- **Hermes agent adapter** — `hermes_local` (PR #587)
- **Execution workspaces** (experimental) — initial drop (PR #1038)
- **Heartbeat token optimization** — skip redundant token use
- **Adapter-aware session compaction**
- **Company logos** with SVG sanitization (PR #162)
- App version label, copy-to-clipboard on issues, worktree cleanup command

### v0.3.1 — 2026-03-12
- **Gemini CLI adapter** (`gemini_local`) — API-key detect, turn limits, sandbox/approval modes, skill injection into `~/.gemini/`, yolo-mode default (PRs #452, #656)
- **Run transcript polish** — markdown, folded stdout, path redaction, humanized events (PRs #648, #695)
- **Heartbeat settings sidebar** (PR #697)
- **Config tabs** for projects + agents
- **Agent runs tab**
- **`PAPERCLIP_ALLOWED_ATTACHMENT_TYPES`** env var (PR #495)
- **Default max turns → 300** (PR #701)
- **Issue creator** shown in sidebar (PR #145)
- **Worktree:make** CLI (PRs #496, #530, #545)

### v0.3.0 — 2026-03-09
- **Cursor + OpenCode + Pi** adapters — first-class, model discovery, run-log streaming, skill injection (PRs #62, #141, #240, #183)
- **OpenClaw gateway adapter** — strict SSE, device-key pairing, invite-based onboarding (PR #270)
- **Inbox + unread semantics** — per-user read state, blue-dot browser tab badge (PR #196)
- **PWA support** — installable, service worker network-first
- **Agent creation wizard** — choice modal + full-page config
- **Mermaid diagrams** in markdown
- **Live run output** via WebSocket
- **Retry failed runs**, **copy comment as markdown**, **scroll-to-bottom**
- **Database backup CLI**
- **`auth.disableSignUp`** (PR #279)

---

## 6. Integrations & Ecosystem

### LLM providers / coding agents (as first-class adapters)
- Anthropic **Claude Code** (`claude-local`) — Opus 4.7 in dropdown as of 2026-04-16; Claude subscription panel surfaces quota
- **Codex** (`codex-local`) — fast mode (PR #3383), Codex subscription panel, env-probe behavior
- **Cursor** (`cursor-local`) — model discovery + streaming
- **OpenCode** (`opencode-local`) — model discovery + streaming
- **Pi** (`pi-local`) — local RPC mode with cost tracking
- **Gemini CLI** (`gemini-local`) — API-key detect, sandbox/approval modes, skill injection
- **Hermes CLI** (`hermes_local`) — upstream native once, now externalized as plugin on fork branches; `SESSIONED_LOCAL_ADAPTERS`
- **OpenClaw** (`openclaw-gateway`) — SSE streaming, device-key pairing, invite tokens
- Generic **`process`** adapter (any shell) and **`http`** adapter (any webhooked agent)
- **OpenAI**: GPT-5.4 fallback + `xhigh` effort level supported
- Via MCP: **any MCP-capable client** (Claude Desktop, etc.) can drive Paperclip via `@paperclipai/mcp-server`

### Integrations
- **GitHub** — skill/company imports by shorthand refs; **GitHub Enterprise** URL support; hardened GHE detection; shared GitHub helpers (`github-fetch.ts`)
- **Git worktrees** — first-class (`worktree:make`, `worktree:cleanup`)
- **Docker** — full Docker image CI, host UID/GID mapping
- **Tailscale** — documented private-access path, `tailnet` bind preset
- **S3** — optional object storage (`s3` storage driver alongside `local_disk`)
- **Cron** — native in routines + plugin-scheduled jobs
- **Webhooks** — plugins can handle inbound via `onWebhook`
- **assistant-ui** — chat thread UI
- **Mintlify** — docs

### Storage / data
- **Postgres** (prod) or **embedded PGlite / embedded-postgres** (dev, patched)
- **Drizzle** ORM + migrations
- Local disk or **S3** for files/attachments
- `~/.paperclip/` home layout (`home-paths.ts`)
- `agent_runtime_state`, `agent_task_sessions` for persistent agent state

### Vector DB / RAG / Memory
- **None shipped.** Memory/Knowledge is explicitly on the roadmap as `⚪ Memory / Knowledge`. `doc/memory-landscape.md` exists as a design doc. Plugins can register tools/data/state — vector stores would likely land as plugins first.

### Auth providers
- **Better-Auth** (`BETTER_AUTH_SECRET` env) is the auth backbone in `authenticated` mode
- No OAuth provider list shipped out of the box in the core — providers would flow through Better-Auth config

### MCP
- **Yes — two sides:**
  - **Inbound**: `@paperclipai/mcp-server` makes Paperclip itself an MCP server (v2026.416.0)
  - **Outbound (agent side)**: each agent adapter (Claude, Codex, etc.) brings its own MCP client story. The `RunTranscriptView` explicitly groups MCP init noise (`stderr_group` amber accordion on the Henk fork).

### Deployment targets
- **Local-first** (default), **Tailscale** for remote, **Docker**, **any Node 20+ host with Postgres**, **Vercel** mentioned as example
- **Cloud deployments** are on roadmap as `⚪ Cloud deployments` (shared story not yet "shipped")

---

## 7. Architecture Highlights

### Control-plane invariants (from `AGENTS.md` and `SPEC-implementation.md`)
1. **Company-scoped everything** — every entity has `company_id`; enforced at route level
2. **Single-assignee task model**
3. **Atomic issue checkout** (`POST /api/issues/:id/checkout`)
4. **Approval gates** for governed actions
5. **Budget hard-stop auto-pause**
6. **Activity logging** for every mutation
7. **Contract synchronization rule** — change schema? Update db + shared + server + ui in the same PR

### Agents are defined in code, not UI-driven configs
- Adapter **type + config** define an agent. Adapter-specific formats: Claude Code reads `CLAUDE.md`, OpenClaw reads `SOUL.md` + `HEARTBEAT.md`, raw scripts use CLI args.
- `AGENTS.md`-style config is first-class for repo-native setup.
- **Agent config revisions** table — versioned; revisions UI component
- **Hire hook** runs on new agent provisioning

### Multi-tenancy model
- **Single deployment → many companies** (complete data isolation via `company_id`).
- **Single board operator** per deployment in V1 (multi-human is on roadmap).
- Agent API keys are company-scoped and cannot cross companies.

### Heartbeat execution model
- Two fundamental modes per `doc/PRODUCT.md`:
  1. **Run a command** — kick off shell process and monitor
  2. **Fire-and-forget webhook** — notify externally-running agent
- Heartbeat triggers: **schedule + events** (task assignment, @-mentions, comment wakes, approval resolution, blocker resolution)
- **Persistent state** (`agent_runtime_state`, `agent_task_sessions`) + **session resume** across heartbeats
- **Runtime skill injection** — skills pushed into agent home dirs at runtime without retraining

### Background jobs / streaming
- In-process **lightweight scheduler/worker** (no separate queue infra in V1) handles heartbeat triggers, stuck-run detection, budget thresholds
- **Plugin job coordinator + scheduler + store** — plugins can declare cron jobs in manifest
- **Plugin stream bus**, **live events** service, **WebSocket** streaming for run output
- **SSE** for OpenClaw adapter, dev-server reload, realtime

### Run transcripts & transparency
- Path redaction (`log-redaction.ts`, `redaction.ts`) — home paths, user identities
- `run-log-store`, `workspace-operation-log-store`
- Stderr grouping for MCP init noise (fork feature, potentially upstream path)
- Progressive disclosure (PRODUCT.md principle): top-layer summary → middle-layer checklist → bottom-layer raw tool calls

### Deployment modes (`doc/DEPLOYMENT-MODES.md`)
- **`local_trusted`** — default, implicit board, no login friction, loopback/lan/tailnet bind presets
- **`authenticated`** — sessions required, supports private-network + public exposure policies

---

## 8. What Makes Paperclip Distinctive

1. **Framing = company, not pipeline.** The "agent = employee, platform = company" metaphor is not decoration — it's baked into every data model, every route, every page. Org chart, reports_to, budgets, hires, approvals, strategy proposals, board claim. No drag-and-drop workflow builder. No canvas. It's a task manager that happens to run AI.

2. **Agent-agnostic on purpose.** The core has **two** built-in runtimes (`process`, `http`). Everything else — Claude, Codex, Cursor, Gemini, OpenCode, Pi, OpenClaw, Hermes — is an adapter package. Plus a plugin system so third parties can ship adapters as npm packages with their own config schema and transcript parser. "If it can receive a heartbeat, it's hired."

3. **Heartbeats instead of continuous loops.** Paperclip explicitly doesn't run agents forever. Agents wake, check-work, act, exit. The **scoped-wake fast path** (skip inbox, jump to target issue) is a meaningful latency optimization that most orchestration platforms don't bother with.

4. **Atomic checkout + run-id header on every mutation.** `X-Paperclip-Run-Id` on every PATCH/POST that touches an issue — full immutable audit trail. The skill instructs the agent to never retry a 409. This is rare in the space.

5. **Execution policies with per-stage signoff.** The v2026.416.0 execution-policy feature supports multi-stage review/approval as first-class issue state, with automatic participant routing. Not "add a reviewer" — a real review state machine.

6. **Multi-company portability (`company import/export`).** Clipmart (teased, "coming soon") wants to be a marketplace of company templates — one-click download a full org structure, agent configs, skills, routines. The import/export plumbing is already shipping.

7. **Plugins are unusually deep.** `@paperclipai/plugin-sdk` has `/worker`, `/ui`, `/testing`, `/bundlers`, `/dev-server` entry points. Manifest-declared jobs with cron, webhooks, UI slots, UI launchers, tool registry, two-way **agent sessions** for interactive chat. Four example plugins in-tree. The server has ~25 plugin-* service files. This is a serious first-party extension model, not an afterthought.

8. **Inbox as the mail client.** The v2026.403.0 inbox overhaul (j/k/a/y/o, swipe-to-archive, parent-child nesting, "Today" divider, operator search) is unusually polished for a 6-week-old project. "Mine" tab is the intended default mode.

9. **PWA + mobile-first interactions.** Swipe-to-archive, mobile bottom nav, installable PWA with service worker. This is rare in operator tools.

10. **Transcript-as-chat.** v2026.416.0 replaced the comment timeline with an assistant-ui-powered chat thread where agent chain-of-thought, tool calls, and user messages all render inline as one conversation. That's the "magic moment" they're investing in right now.

11. **Runtime skill injection.** Skills live in `skills/paperclip/` and get pushed into agent home dirs at wake time (`~/.gemini/`, etc.) so agents learn Paperclip workflows *without retraining* and without needing a baked-in framework client.

12. **Wake-payload env hydration.** `PAPERCLIP_WAKE_PAYLOAD_JSON` carries the compact issue summary + ordered comment batch straight into the wake environment — the agent often doesn't need to hit the API at all for the first response. That's a clever latency/cost optimization.

13. **Declarative budget enforcement.** Monthly per-agent hard stop + `budget_incidents` + `budget_policies` is part of the core invariant list. Competitors usually treat cost as telemetry; Paperclip treats it as governance.

14. **Dogfooded PR culture.** The `AGENTS.md` PR template mandates a **"Model Used"** field ("provider, exact model ID, context window, capabilities" or "None — human-authored"). Looking at the commit log, lots of `[codex]` prefixes — indicating they use the product to build the product.

---

## 9. Gap-Mapping Hooks for Eidolon Diff

Concrete areas where you can compare Eidolon's current codebase against specifically-named Paperclip surfaces:

| Paperclip concept | Evidence (file / table) | Eidolon status hook |
|---|---|---|
| Companies as first-class multi-tenant unit | `packages/db/src/schema/companies.ts`, all route-level `company_id` checks | Compare against Eidolon's organization model |
| Org chart / `reports_to` tree | `agents.ts` schema, `OrgChart.tsx`, `org-chart-svg.ts` | Does Eidolon model reporting hierarchies? |
| Atomic issue checkout | `issues-checkout-wakeup.ts`, `heartbeat-run-summary.ts` | Does Eidolon prevent double-assignment? |
| Heartbeat runs table | `heartbeat_runs`, `heartbeat_run_events` | Does Eidolon persist invocations separately from tasks? |
| Wake-reason env injection | Skill doc + `agent-auth-jwt.ts` | Does Eidolon pass context via env to agent runtimes? |
| Execution policies (multi-stage signoff) | `issue-execution-policy.ts`, `issue_execution_decisions` | Only ships `issue_approvals`? |
| Blocker dependencies | `blockedByIssueIds`, `issue_relations` | Does Eidolon auto-wake on blocker resolution? |
| Document revisions | `document_revisions`, `issue_documents` | Rich doc editing with revision history? |
| Company skills library | `company_skills`, `CompanySkills.tsx` | Does Eidolon have a skills/tools library per company? |
| Routines engine | `routines`, `routines.ts`, `ScheduleEditor.tsx` | Scheduled / recurring tasks? |
| Plugin runtime | All `plugin_*` tables + `plugin-*` services + `@paperclipai/plugin-sdk` | Does Eidolon have a plugin story? |
| Standalone MCP server | `packages/mcp-server/` | Does Eidolon expose its API as MCP? |
| External adapter plugins | `adapter-plugin.md`, `~/.paperclip/adapter-plugins.json` | Can third parties ship agent runtimes to Eidolon? |
| Budget hard-stop | `budget_policies`, `budget_incidents`, `quota_windows` | Governance-level enforcement vs just telemetry? |
| Finance events | `finance_events`, `FinanceTimelineCard.tsx` | Broader accounting model beyond token costs? |
| PWA / mobile | `vite.config.ts`, `MobileBottomNav.tsx`, `SwipeToArchive.tsx` | Installable PWA? Mobile-first gestures? |
| Issue chat thread (assistant-ui) | `IssueChatThread.tsx`, `IssueChatUxLab.tsx` | Compare against Eidolon's issue detail |
| Command palette | `CommandPalette.tsx`, keyboard shortcuts | j/k/a/y/o + cheatsheet? |
| Company import/export | `CompanyImport.tsx`, `CompanyExport.tsx`, `companies.sh` | Template/portability story? |
| Tailscale / bind presets | `server/src/config.ts`, onboard bind modes | Remote-access story? |
| Feedback votes | `feedback_votes`, `OutputFeedbackButtons.tsx` | Thumbs / evals surface? |
| Local-trusted vs authenticated modes | `doc/DEPLOYMENT-MODES.md` | Default no-login UX with clean upgrade to auth? |
| Telemetry opt-out stack | `telemetry.ts`, `DO_NOT_TRACK`, `CI=true` | How does Eidolon handle anonymized usage data? |
| Adapter capability flags | `ServerAdapterModule.capabilities` (PR #3540) | Does Eidolon differentiate agent capabilities per-adapter? |

---

## 10. Key URLs (for follow-up)

- Root: https://github.com/paperclipai/paperclip
- README (raw): https://raw.githubusercontent.com/paperclipai/paperclip/master/README.md
- Roadmap: https://raw.githubusercontent.com/paperclipai/paperclip/master/ROADMAP.md
- SPEC-implementation: https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/SPEC-implementation.md
- PRODUCT: https://raw.githubusercontent.com/paperclipai/paperclip/master/doc/PRODUCT.md
- AGENTS.md: https://raw.githubusercontent.com/paperclipai/paperclip/master/AGENTS.md
- Landing: https://paperclip.ing
- Docs: https://paperclip.ing/docs
- Releases: https://github.com/paperclipai/paperclip/releases
- MCP server README: https://raw.githubusercontent.com/paperclipai/paperclip/master/packages/mcp-server/README.md
- Plugin SDK README: https://raw.githubusercontent.com/paperclipai/paperclip/master/packages/plugins/sdk/README.md
- Awesome list: https://github.com/gsxdsm/awesome-paperclip
- Default branch is **`master`**, not `main` (this bit me early — it caused raw.githubusercontent.com 404s on `/main/` paths)
