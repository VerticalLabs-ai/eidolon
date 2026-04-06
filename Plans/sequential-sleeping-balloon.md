# Database Strategy: Keep SQLite, Skip Convex

## Context

Eidolon is moving toward a public production deployment. The question is whether to migrate from SQLite/Drizzle to Convex or another database. After auditing the full codebase — 26 tables, 39 files touching the DB, 29 complex query patterns, a working WebSocket real-time system — the answer is clear.

## Recommendation: Do NOT migrate to Convex

**Convex would be a ground-up rewrite, not a migration.** It would require:
- Rewriting all 22 route files as Convex functions (replacing Express)
- Rewriting all 13 service files to work in Convex's V8 isolate model
- Replacing the working WebSocket system with Convex reactivity
- Rewriting all 26 schema definitions in Convex's type system
- Replacing every `db.drizzle.select().from(table)...` call across 39 files
- **Estimated: 4-8 weeks with high regression risk**

Convex's main selling point — real-time subscriptions — is redundant. The app already has a working EventBus + WebSocket system that pushes updates after mutations.

## Two-Phase Production Strategy

### Phase 1: Ship with SQLite + Litestream (now)

**Zero code changes required.** SQLite is production-viable for this workload:
- Read-heavy dashboard (agent monitoring, task boards, analytics)
- WAL mode already enabled with tuned pragmas
- Single-server deployment — no horizontal scaling needed yet
- Busiest write path is HeartbeatScheduler at 30s intervals

**Steps:**
1. Add Litestream sidecar for continuous WAL replication to S3 (~$1-5/mo)
2. Deploy on Fly.io (or Railway/Render) with persistent volume
3. Add health check for DB file + WAL state
4. **Effort: ~half a day of ops work**

### Phase 2: Postgres via Drizzle (when needed)

Drizzle ORM makes this a clean swap. **Estimated: 3-5 days.**

What changes:
- `packages/db/src/schema/*.ts` — swap `sqliteTable` → `pgTable` (25 files, mechanical)
- `server/src/types.ts` — change `BetterSQLite3Database` → `PostgresJsDatabase`
- `server/src/index.ts` — swap `better-sqlite3` connection for Postgres driver
- `server/src/routes/analytics.ts` — fix 6 SQLite-specific date expressions
- `server/src/test-utils.ts` — Postgres test DB instead of `:memory:`

What does NOT change:
- All Drizzle query builder calls (`.select().from().where()`) — identical API
- The entire WebSocket/EventBus system — fully DB-agnostic
- All 13 service files — they use Drizzle abstractions
- The React UI — talks to REST API, doesn't know about the DB

**Trigger conditions for Phase 2** (don't migrate until one is true):
- Need multiple server instances behind a load balancer
- Write contention causes `SQLITE_BUSY` errors despite 5s busy_timeout
- Need full-text search beyond SQLite FTS5
- Need row-level security or connection pooling

### Why not Turso?

Turso (libSQL) is SQLite-compatible and would be a minimal driver swap, but:
- Edge distribution is irrelevant for a single-tenant dashboard
- Adds $30/mo managed service cost for no real gain over SQLite + Litestream
- If we're going to add a managed service, go straight to Postgres

## Critical Files

| File | Role |
|------|------|
| `server/src/index.ts` | Server bootstrap, SQLite connection, inline CREATE TABLE statements |
| `server/src/types.ts` | `DbInstance` interface coupling routes to better-sqlite3 |
| `server/src/routes/analytics.ts` | 6 SQLite-specific date expressions |
| `packages/db/src/schema/*.ts` | All 26 table definitions using `sqliteTable` |
| `server/src/realtime/ws-server.ts` | WebSocket system (DB-agnostic, confirms Convex real-time is redundant) |

## Verification

No code changes needed for Phase 1. When ready to deploy:
1. Test Litestream backup/restore cycle locally
2. Verify `npm run db:generate && npm run db:migrate && npm run db:seed && npm run dev` works
3. Confirm WebSocket real-time updates still work after deployment
