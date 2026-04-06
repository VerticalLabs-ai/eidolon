# Database Layer Exploration Plan

## Objective
Thoroughly analyze the database layer of the Eidolon project to understand schema, usage patterns, real-time mechanisms, and comprehensive architecture.

## Phase 1: Schema Discovery & Documentation
**Goal**: Map complete database schema with all tables, columns, relationships, and constraints

### 1.1 Core Schema Files
- Read `packages/db/src/schema/index.ts` to identify all exported tables and relationships
- Read all 25 schema files systematically to document:
  - Table definitions (columns, types, constraints)
  - Foreign key relationships
  - Indexes and unique constraints
  - Default values and generated columns
  
**Files to examine**:
- heartbeats.ts, agent_memories.ts, knowledge.ts, integrations.ts
- agent_config_revisions.ts, projects.ts, companies.ts, webhooks.ts
- workflows.ts, agent_evaluations.ts, messages.ts, agent_files.ts
- secrets.ts, company_templates.ts, activity_log.ts, agent_collaborations.ts
- mcp_servers.ts, agents.ts, prompts.ts, budget_alerts.ts
- goals.ts, cost_events.ts, tasks.ts, agent_executions.ts

### 1.2 Schema Patterns
- Document relationship cardinality (one-to-many, many-to-many, etc.)
- Identify cascade delete/update rules
- Note any polymorphic or soft-delete patterns
- Count total tables and estimate row volumes based on design

## Phase 2: Database Usage Patterns in Server Code
**Goal**: Understand how the application queries the database

### 2.1 Route Layer Analysis
- Examine all route files to understand:
  - Query complexity per endpoint
  - Read vs write patterns
  - Pagination and filtering approaches
  - N+1 query vulnerabilities
  
**Sample routes**: health.ts, tasks.ts, companies.ts, goals.ts, messages.ts, chat.ts, agents.ts

### 2.2 Service Layer Analysis
- Examine service implementations for:
  - Complex queries (joins, subqueries, aggregations)
  - Transaction usage
  - Batch operations
  - Caching patterns
  
**Key services**: orchestrator.ts, agentic-loop.ts, agent-executor.ts, knowledge.ts, memory.ts

### 2.3 Query Patterns Summary
- Classify queries by type (SELECT, INSERT, UPDATE, DELETE)
- Identify heavy-hitter queries (frequently used, complex)
- Document any N+1 query issues
- Note transaction boundaries

## Phase 3: Real-Time & WebSocket Layer
**Goal**: Understand how server pushes updates to clients

### 3.1 Real-Time Infrastructure
- Read `server/src/realtime/ws-server.ts` for WebSocket implementation
- Read `server/src/realtime/events.ts` for event definitions
- Understand:
  - Connection lifecycle management
  - Event broadcast patterns
  - Message format and serialization
  - Error handling and reconnection logic

### 3.2 Event-Driven Patterns
- Identify what entities trigger real-time updates
- Map event subscriptions to table changes
- Understand polling vs event-driven approach

## Phase 4: Migrations & Seed Infrastructure
**Goal**: Understand schema evolution and initialization

### 4.1 Drizzle Configuration
- Locate migration files and configuration
- Understand versioning strategy
- Review seed data complexity
- Check for data transformations

## Phase 5: Comprehensive Summary Generation
**Goal**: Produce executive summary of database architecture

### 5.1 Metrics to Calculate
- Total number of tables
- Relationship count and types
- Estimated row volumes by table
- Query complexity distribution
- Real-time coverage (which entities support live updates)

### 5.2 Summary Document
- Architecture overview diagram (text-based)
- Table inventory with purpose
- Key relationships and dependencies
- Query patterns by category
- Performance considerations
- Real-time architecture explanation

## Execution Order
1. Phase 1: Schema Discovery (builds foundation)
2. Phase 2: Query Pattern Analysis (uses schema knowledge)
3. Phase 3: Real-Time Layer (independent analysis)
4. Phase 4: Migrations (supporting context)
5. Phase 5: Comprehensive Summary (synthesizes all phases)

## Success Criteria
- ✓ Complete schema documentation with all relationships
- ✓ Clear understanding of read/write patterns
- ✓ Identified real-time update mechanisms
- ✓ Comprehensive summary with metrics and architecture overview
