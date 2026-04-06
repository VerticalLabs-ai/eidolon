# Eidolon Enhancement Roadmap

**Competitive Analysis vs. Paperclip + Independent Recommendations**
*Generated April 6, 2026*

---

## Executive Summary

After a thorough review of the Eidolon codebase and a deep-dive into Paperclip's architecture (via their public DeepWiki), this document identifies **42 enhancements** across 8 categories. Each item is tagged with priority (P0 = critical, P1 = high, P2 = medium, P3 = nice-to-have) and whether it's a gap vs. Paperclip or an independent improvement opportunity.

---

## 1. Security & Authentication (P0 — Critical)

Eidolon currently has **zero authentication**. Every API endpoint is open. This is the single biggest gap in the platform and blocks any real-world deployment.

### 1.1 Authentication System `[P0] [Paperclip Gap]` -- IMPLEMENTED
Paperclip uses **better-auth** with session-based authentication, OAuth/OpenID support, and two deployment modes: `local_trusted` (no auth, localhost only) and `authenticated` (full session management).

**Done:**
- BetterAuth with Drizzle/SQLite adapter
- Email/password authentication
- Google OAuth ("Continue with Google")
- `local_trusted` mode for development
- Session-based auth with cookie management
- Admin auto-promotion via `ADMIN_EMAIL` env var
- Bearer token plugin for API access

### 1.1b OAuth & SSO Connectors `[P1] [Independent]`
Expand authentication beyond Google to support additional identity providers:

- **GitHub OAuth** — Common for developer-facing deployments
- **Microsoft / Azure AD** — Enterprise SSO for corporate deployments
- **Apple Sign-In** — Required for iOS app distribution
- **Generic OIDC** — Support any OpenID Connect provider (Okta, Auth0, Keycloak, etc.)
- **SAML 2.0** — Enterprise SSO standard for large organizations
- **Account linking** — Allow users to connect multiple OAuth providers to a single account
- **Provider management UI** — Admin page to enable/disable providers and configure credentials

### 1.2 Role-Based Access Control `[P0] [Paperclip Gap]`
Paperclip implements company-scoped permissions and user invitations. Eidolon needs:

- User roles (Owner, Admin, Member, Viewer) per company
- Company-scoped data isolation enforcement at the middleware level
- Invitation system for adding users to companies
- Agent API key management with scoped permissions

### 1.3 Board Governance Model `[P0] [Paperclip Gap]`
Paperclip's "Board" concept gives human operators unrestricted override authority. Eidolon should implement:

- A "Board" role with elevated privileges (pause agents, override decisions, set budgets)
- A CEO bootstrap flow (`auth bootstrap-ceo` equivalent) for first-time setup
- Audit trail showing which board member authorized each action

---

## 2. Agent Execution & Adapters (P0–P1)

### 2.1 Adapter Architecture `[P0] [Paperclip Gap]`
Paperclip's adapter system is its most architecturally mature feature — an unopinionated plugin layer that supports any "callable" entity. Eidolon's provider integration is tightly coupled. Needed:

- A formal `ServerAdapter` interface/contract that all providers implement
- An adapter registry for dynamic discovery and loading
- Separation of adapters into independent packages with server/ui/cli entry points
- Support for **local CLI adapters** (spawn external processes like Claude CLI, Codex, Cursor, Gemini)
- Support for **remote gateway adapters** (WebSocket/HTTP connections to remote agents)
- Support for **generic adapters** (arbitrary shell commands, HTTP webhooks)
- Per-adapter configuration stored as JSON blobs on the agent record

### 2.2 Heartbeat Execution Model `[P1] [Paperclip Gap]`
Paperclip's heartbeat model is more sophisticated than Eidolon's 30-second polling:

- **On-demand wakeups**: `POST /api/agents/:id/wakeup` for manual triggering
- **Assignment-based triggers**: Agent wakes immediately when work is checked out to it
- **Timer-based scheduling**: Cron-like intervals per agent, not a global poll
- **Automation triggers**: System-driven wakeups from business logic / event rules
- **Execution states**: Full lifecycle tracking (queued → running → succeeded/failed/timed_out/cancelled)
- **Timeout enforcement**: Configurable per-agent execution time limits

### 2.3 Session Persistence `[P1] [Paperclip Gap]`
Paperclip maintains `AgentTaskSession` entities that persist context across multiple heartbeats. Eidolon needs:

- Session objects that survive across execution windows
- Adapter-level support for session resumption
- Session state stored in the database, not just in-memory

### 2.4 Agent Skills System `[P2] [Paperclip Gap]`
Paperclip has a formal skills framework with trust levels:

- **Skill definitions** with metadata, entry points, and documentation
- **Company-scoped skills** that organizations can create for their agents
- **Trust levels**: `markdown_only`, `assets`, `scripts_executables`
- **Skill injection pipeline**: Skills materialized to disk and symlinked into agent environments
- **Stale pruning**: Automatic cleanup of outdated skill versions

---

## 3. Task Management & Concurrency (P0–P1)

### 3.1 Issue Checkout Semantics `[P0] [Paperclip Gap]`
Eidolon has a **race condition vulnerability** in task assignment — two agents can simultaneously claim the same task. Paperclip prevents this with checkout semantics:

- Atomic checkout: Tasks are "checked out" to an agent in a transaction, preventing double-assignment
- Optimistic locking with version fields on task records
- Transaction wrappers around all assignment operations
- Conflict detection and resolution when concurrent claims occur

### 3.2 Cron-Like Scheduling `[P1] [Paperclip Gap]`
Eidolon's scheduler is a simple 30-second poll. Paperclip supports routines and scheduled jobs:

- Per-agent cron expressions (e.g., "run daily at 9am")
- Event-triggered automation rules (e.g., "when task.done, trigger review workflow")
- Retry scheduling with exponential backoff for failed tasks
- Scheduled maintenance windows

### 3.3 Approval Workflows `[P1] [Paperclip Gap]`
Paperclip has a multi-stage approval system for high-impact decisions. Eidolon has a `review` task status but no enforcement:

- Approval entity type with status tracking (pending, approved, rejected)
- Configurable approval rules (e.g., "budget changes > $100 require board approval")
- Agent join requests requiring board approval before activation
- Approval queue UI for board members
- Approval history and audit trail

---

## 4. Developer Experience & Tooling (P1)

### 4.1 CLI Tool `[P1] [Paperclip Gap]`
Paperclip has a comprehensive CLI with 15+ commands. Eidolon has none beyond dev/build scripts:

- `eidolon onboard` — Interactive first-run setup wizard
- `eidolon doctor` — Diagnostic checks with auto-repair (config validation, DB connectivity, storage access, API key verification)
- `eidolon configure` — Update LLM, database, logging, storage, or secrets settings
- `eidolon run` — Start server with pre-flight health checks
- `eidolon db:backup` — Create database backups with retention policies
- `eidolon heartbeat run` — Manually trigger a single agent execution for debugging
- `eidolon issue` / `eidolon agent` / `eidolon approval` — Resource CRUD from terminal
- `eidolon context set` — Manage CLI profiles for different environments
- `--json` flag on all commands for scriptability

### 4.2 Worktree Isolation `[P1] [Paperclip Gap]`
Paperclip enables isolated development environments per Git branch:

- `eidolon worktree:make <branch>` — Create isolated instance with its own database and port
- Database seeding options: `minimal`, `full`, `--no-seed`
- Independent port assignment (3100 default, 3101+ for worktrees)
- Automatic cleanup when branches are deleted

### 4.3 API Documentation `[P1] [Independent]`
Neither platform has great docs, but Eidolon has zero API documentation:

- OpenAPI/Swagger spec auto-generated from Zod schemas
- Interactive API explorer at `/api/docs`
- TypeScript client SDK generated from the spec
- Architecture decision records (ADRs) for key design choices

### 4.4 Dev Server Health Banner `[P2] [Paperclip Gap]`
Paperclip shows a `DevRestartBanner` when the backend has unapplied changes or pending migrations:

- Visual indicator in the UI when the server needs restart
- Migration status indicator
- Database schema drift detection

---

## 5. Database & Scalability (P1)

### 5.1 PostgreSQL Support `[P1] [Paperclip Gap]`
Eidolon is SQLite-only. Paperclip uses PostgreSQL (with an embedded option for local dev):

- Add PostgreSQL driver alongside SQLite
- Configuration switch between SQLite (development) and PostgreSQL (production)
- Embedded PostgreSQL option for zero-config local development
- Connection pooling for production deployments
- Migration path documentation from SQLite → PostgreSQL

### 5.2 Company Data Export/Import `[P1] [Paperclip Gap]`
Paperclip supports complete organizational portability:

- Export a company with all agents, projects, tasks, goals, and history
- Import into a different instance preserving referential integrity
- Selective export (omit logs, sensitive data, or operational history)
- JSON-based portable format

### 5.3 Database Backups `[P2] [Paperclip Gap]`
- Automated backup scheduling with configurable retention windows
- Point-in-time recovery support
- Backup verification and integrity checks
- One-command manual backup: `eidolon db:backup`

---

## 6. Reliability & Error Handling (P1)

### 6.1 Retry Logic & Circuit Breaker `[P1] [Independent]`
Eidolon has no retry logic or failure isolation:

- Configurable retry policies per agent/adapter (count, backoff strategy)
- Circuit breaker pattern: After N failures, stop calling a provider and fail fast
- Graceful degradation: If one agent/provider fails, others continue operating
- Dead letter queue for permanently failed tasks

### 6.2 Execution Timeouts `[P1] [Paperclip Gap]`
Paperclip enforces time limits with a `timed_out` status. Eidolon has none:

- Per-agent configurable execution timeout
- Per-task maximum duration
- Automatic status transition to `timed_out` when limits are exceeded
- Alert/notification when timeouts occur

### 6.3 Health Check Improvements `[P2] [Independent]`
The existing `/api/health` endpoint only reports uptime and memory:

- Add database connectivity check
- Add LLM provider reachability check
- Add disk space check
- Add pending migration detection
- Structured health response with per-subsystem status

---

## 7. UI & Design Improvements (P1–P2)

### 7.1 Onboarding Wizard `[P1] [Paperclip Gap]`
Paperclip has an interactive onboarding flow. Eidolon drops users into a blank dashboard:

- Step-by-step setup: Create company → Configure LLM keys → Hire first agent → Create first task
- Progress indicator showing completion percentage
- Contextual help and tooltips throughout
- Skip option for experienced users

### 7.2 Run Transcript Display `[P1] [Paperclip Gap]`
Paperclip shows live execution transcripts with streaming output:

- Real-time log streaming during agent execution
- Syntax-highlighted output for code generation tasks
- Expandable/collapsible execution steps
- Cost attribution per execution step
- Copy-to-clipboard for outputs

### 7.3 Live Execution Monitoring `[P1] [Paperclip Gap]`
Beyond the existing WebSocket updates, Paperclip provides richer monitoring:

- Agent status indicators (idle, running, error, paused) visible at a glance on all views
- Execution timeline visualization
- Real-time cost accumulation display during execution
- "Stop" button to cancel running executions

### 7.4 Approvals UI `[P2] [Paperclip Gap]`
- Dedicated approvals queue page
- Inline approve/reject with comment
- Approval request notifications
- Approval history per agent and per company

### 7.5 Instance Settings Page `[P2] [Paperclip Gap]`
Paperclip has a dedicated settings UI for system-level configuration:

- LLM provider configuration and API key management (currently env-var only)
- Storage configuration (local vs. S3)
- Logging level configuration
- Server binding and network settings
- Database connection status

### 7.6 Markdown Editor `[P3] [Paperclip Gap]`
Paperclip includes rich markdown editing and rendering:

- WYSIWYG markdown editor for task descriptions and documents
- Preview mode with syntax highlighting
- Image embedding support
- @-mention support for agents

### 7.7 Dashboard Polish `[P2] [Independent]`
General UI quality improvements:

- Loading skeletons instead of spinners
- Empty states with helpful CTAs (not just "No items found")
- Keyboard shortcuts for power users (navigate tasks, switch views)
- Dark mode support
- Responsive design audit for tablet/mobile views
- Consistent error states across all pages

---

## 8. Platform Extensibility (P2)

### 8.1 Plugin System `[P2] [Paperclip Gap]`
Paperclip has a formal plugin architecture with SDK, UI slots, and runtime:

- Plugin SDK for third-party extensions
- UI extension points (slots) where plugins can inject components
- Plugin registry and discovery
- Plugin lifecycle management (install, enable, disable, uninstall)
- Plugin configuration UI

### 8.2 Webhook Improvements `[P2] [Independent]`
Eidolon has webhook subscriptions but they could be more robust:

- Webhook delivery retry with exponential backoff
- Webhook delivery logs with status codes
- Webhook signature verification (HMAC)
- Webhook testing/ping endpoint
- Filtering: Subscribe to specific event types per webhook

### 8.3 Docker & Deployment `[P2] [Paperclip Gap]`
Paperclip has Docker support and deployment tooling. Eidolon has neither:

- Official Dockerfile and docker-compose.yml
- Production deployment guide
- Environment-specific configuration profiles (dev, staging, production)
- Health check integration with container orchestrators
- Smoke test suite for deployment verification

---

## 9. Testing & Quality (P1)

### 9.1 Test Coverage Expansion `[P1] [Independent]`
Eidolon has basic tests but critical gaps:

- **Race condition tests**: Concurrent task assignment must be tested
- **E2E workflow tests**: Full agent lifecycle from hiring → task assignment → execution → completion
- **Load tests**: Verify heartbeat scheduler performance with 100+ agents
- **Integration tests**: Cross-service tests (orchestrator + scheduler + collaboration)
- **Migration tests**: Verify schema changes don't break existing data

### 9.2 Agent Behavior Evals `[P2] [Paperclip Gap]`
Paperclip includes evaluation tooling for agent quality:

- Evaluation framework for measuring agent task completion quality
- Benchmark suites for common task types
- Regression detection when agent configurations change
- Evaluation results dashboard

---

## Priority Summary

| Priority | Count | Focus |
|----------|-------|-------|
| P0 (Critical) | 5 | Auth, race conditions, governance |
| P1 (High) | 16 | Adapters, CLI, PostgreSQL, reliability, UI |
| P2 (Medium) | 14 | Plugins, backups, polish, extensibility |
| P3 (Nice-to-have) | 2 | Markdown editor, minor UX |

---

## Recommended Implementation Order

**Phase 1 — Security & Stability (Weeks 1–3)**
Items 1.1, 1.2, 3.1, 6.2, 9.1 (race condition tests)

**Phase 2 — Execution Model (Weeks 4–6)**
Items 2.1, 2.2, 2.3, 3.2, 6.1

**Phase 3 — Developer Experience (Weeks 7–9)**
Items 4.1, 4.3, 5.1, 8.3

**Phase 4 — Governance & Workflows (Weeks 10–11)**
Items 1.3, 3.3, 7.1, 7.4

**Phase 5 — Polish & Extensibility (Weeks 12–16)**
Items 2.4, 4.2, 5.2, 5.3, 7.2–7.7, 8.1, 8.2, 9.2

---

## Key Takeaway

Eidolon and Paperclip are solving the same problem — orchestrating AI agents as employees within organizational structures. Eidolon has a strong foundation with its goal hierarchy, budget management, collaboration service, and analytics. But Paperclip is ahead in three critical areas: **security** (auth + governance), **execution flexibility** (adapter architecture + heartbeat model), and **developer tooling** (CLI + worktrees + deployment). Closing these gaps would make Eidolon production-ready and competitive.
