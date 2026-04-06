# Eidolon Architecture Exploration Plan

## Primary Objective
Understand how tightly coupled the Eidolon application is to SQLite/Drizzle and identify all areas that would be affected by migration to a different database backend.

## Investigation Scope

### Phase 1: Server Entry Point & Initialization (COMPLETED)
- [x] Read server/src/index.ts to understand database initialization
- [x] Identify SQLite/better-sqlite3 dependency injection
- [x] Map Drizzle ORM initialization and schema loading
- [x] Document database configuration (pragmas, WAL mode, connection pooling)
- [x] Identify all 25+ table definitions
- [x] Understand createApp(db) dependency pattern

**Key Findings:**
- SQLite hardcoded in server entry point via better-sqlite3
- Database instance passed to entire app as dependency
- Schema inline with 25+ tables defined with CREATE TABLE IF NOT EXISTS
- Direct pragma configuration for SQLite optimization
- Migration system via drizzle migrator from packages/db/drizzle

### Phase 2: API Route Structure & Query Patterns (PENDING)
- [ ] Examine all 22 route files in server/src/routes/:
  - health.ts, tasks.ts, companies.ts, goals.ts, messages.ts, budgets.ts, analytics.ts, workflows.ts, activity.ts, secrets.ts, chat.ts, webhooks.ts, knowledge.ts, files.ts, memories.ts, integrations.ts, prompts.ts, mcp.ts, evaluations.ts, agents.ts, collaborations.ts, templates.ts
- [ ] Identify database query patterns in each route
- [ ] Map SELECT, INSERT, UPDATE, DELETE operations
- [ ] Identify complex queries: joins, aggregations, transactions
- [ ] Document relationships between routes and tables
- [ ] Flag any SQLite-specific SQL syntax or features

**Expected Findings:**
- API endpoints that would need query refactoring for new DB
- Complex queries that depend on SQLite semantics
- Data validation/transformation patterns

### Phase 3: UI Data Fetching Patterns (PENDING)
- [ ] Analyze ui/src/lib/api.ts for HTTP API client implementation
  - Query parameter formats
  - Response data structures
  - Error handling patterns
- [ ] Analyze ui/src/lib/hooks.ts for React Query usage
  - Cache key patterns
  - Invalidation strategies
  - Optimistic update patterns
- [ ] Analyze ui/src/lib/ws.ts for WebSocket integration
  - Real-time subscription patterns
  - Event handling for data mutations
  - Fallback mechanisms

**Expected Findings:**
- Data contract expectations between UI and server
- Caching layer dependencies on API structure
- Real-time sync mechanisms that depend on data format

### Phase 4: Database Layer & Schema Details (PENDING)
- [ ] Examine packages/db/src/schema/ for complete schema definition
- [ ] Review Drizzle schema configuration and type generation
- [ ] Identify all table relationships and foreign keys
- [ ] Document multi-tenancy structure (company_id patterns)
- [ ] Check for SQLite-specific constraints or triggers

**Expected Findings:**
- Schema complexity and relationship patterns
- Multi-tenant architecture implications
- Data type mappings between SQLite and target DB

### Phase 5: Services & Complex Business Logic (PENDING)
- [ ] Examine server/src/services/ for:
  - Database transaction patterns
  - Complex query logic
  - Aggregation and reporting queries
  - Batch operations
- [ ] Review heartbeat scheduler for database dependencies
- [ ] Analyze activity logger for schema-specific operations
- [ ] Check WebSocket server for database interactions

**Expected Findings:**
- Transaction isolation requirements
- Performance-critical queries that may need optimization
- Batch operation patterns

### Phase 6: Database Evolution & Migrations (PENDING)
- [ ] Review packages/db/src/ for:
  - Migration scripts and approach
  - Seed data patterns
  - Schema versioning strategy
- [ ] Examine drizzle configuration
- [ ] Document backwards-compatible schema changes

**Expected Findings:**
- Migration complexity and ordering requirements
- Data transformation needs during migration

### Phase 7: Deployment & Configuration (PENDING)
- [ ] Review package.json files for build scripts
- [ ] Examine environment variable patterns (DATABASE_URL, etc.)
- [ ] Check for Docker/container configuration
- [ ] Review cloud deployment configs
- [ ] Document database initialization requirements

**Expected Findings:**
- Build/deployment changes needed for new DB
- Configuration management patterns
- Database initialization ceremony

## Deliverable: Coupling Assessment Report

Final report will document:

1. **Database Coupling Points** - All locations where SQLite/Drizzle is directly used
2. **Migration Impact Map** - Which parts of code need changes for different DB backend
3. **Risk Assessment** - Complex queries or patterns that present challenges
4. **Work Estimates** - Rough effort for migration by component
5. **Recommended Approach** - Phased migration strategy
6. **Abstraction Layer Design** - Proposed interface to decouple from Drizzle ORM

## Notes

- Server tight coupling at entry point: SQLite dependency injected into entire app
- Multi-tenant architecture requires careful migration of company_id foreign keys
- Real-time WebSocket integration may need special attention during DB switch
- React Query caching patterns are backend-agnostic; UI layer is relatively decoupled
- Drizzle ORM provides type safety that would need equivalent in new DB abstraction

