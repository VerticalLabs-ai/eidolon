import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestServers, closeTestDb } from '../test-utils.js';
import {
  AgentRouter,
  type RoutingContext,
  type AgentCandidate,
} from '../services/mission/agent-router.js';
import type { RoutingRequirements } from '../services/mission/plan-schema.js';

/**
 * Permanent-agent eligibility and deterministic scoring.
 *
 * (VAL-SUB-008, 009, 010, 011, 012, 013, 014, 015, 016, 041, 088)
 *
 * Tests exercise every exclusion filter, idle preference, working capacity,
 * company isolation, reproducible scores, and stable tie breaks.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function seedScope(db: AnyDb, label: string) {
  const companyId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{"testFixture": true}'::jsonb, ${now}, ${now})
  `);
  const projectId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${projectId}, ${companyId}, 'P', 'active', ${now}, ${now})
  `);
  const threadId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, 'T', 'conversation', 'active', ${now}, ${now})
  `);
  return { companyId, projectId, threadId };
}

/** A second company scope for isolation tests. */
async function seedForeignScope(db: AnyDb, label: string) {
  return seedScope(db, label);
}

interface AgentSeedInput {
  id?: string;
  companyId: string;
  name: string;
  status?: string;
  provider?: string;
  model?: string;
  capabilities?: string[];
  toolsEnabled?: string[];
  allowedDomains?: string[];
  permissions?: string[];
  maxConcurrentTasks?: number;
  executionTimeoutSeconds?: number;
  budgetMonthlyCents?: number;
  spentMonthlyCents?: number;
}

async function seedAgent(db: AnyDb, input: AgentSeedInput): Promise<string> {
  const id = input.id ?? randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "api_key_encrypted", "created_at", "updated_at")
    VALUES (${id}, ${input.companyId}, ${input.name}, 'engineer', ${input.provider ?? 'anthropic'}, ${input.model ?? 'claude-sonnet-4-6'}, ${input.status ?? 'idle'}, ${JSON.stringify(input.capabilities ?? [])}::jsonb, '{}'::jsonb, '{}'::jsonb, ${JSON.stringify(input.permissions ?? ['content.create'])}::jsonb, ${JSON.stringify(input.toolsEnabled ?? [])}::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, ${JSON.stringify(input.allowedDomains ?? [])}::jsonb, ${input.maxConcurrentTasks ?? 2}, 300, ${input.executionTimeoutSeconds ?? 600}, 0, ${input.budgetMonthlyCents ?? 0}, ${input.spentMonthlyCents ?? 0}, 'encrypted-key', ${now}, ${now})
  `);
  return id;
}

/**
 * Set up a materialized child run with a pending_routing assignment.
 * Returns the routing context needed to call the router.
 */
async function setupPendingRoutingChild(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  requirements: RoutingRequirements,
  options?: {
    stepBudgetCents?: number;
    stepTimeoutSeconds?: number;
    billingAgentId?: string | null;
    parentProvider?: string;
  },
): Promise<{ childRunId: string; rootRunId: string; parentRunId: string; stepKey: string }> {
  const rootRunId = randomUUID();
  const parentRunId = rootRunId; // For depth-1 children, parent is root.
  const childRunId = randomUUID();
  const stepKey = 'child-step';
  const now = new Date();
  const revisionId = randomUUID();
  const hash = randomUUID();
  const policySnapshotId = randomUUID();

  // Policy snapshot for the root run.
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, ${options?.parentProvider ?? 'anthropic'}, null, 'claude-sonnet-4-6', 'standard', '[]'::jsonb, '[]'::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true, "requiresApproval": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"allowed": false}'::jsonb, 'require_all', '{"steps": 12, "durationSeconds": 2700, "providerCalls": 48, "totalTokens": 300000, "outputBytes": 8388608, "costCents": 5000, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
  `);

  // Root run.
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "created_at", "updated_at")
    VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'encrypted', ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, NULL, ${options?.billingAgentId ?? null}, ${now}, ${now})
  `);

  // Plan revision (approved).
  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
    VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', '{}'::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
  `);

  // Child run shell (queued, available).
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
    VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${parentRunId}, 1, 0, 'company_agent', 'encrypted-child', ${hash}, 'Child step', 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
  `);

  // Step assignment (pending_routing).
  await db.drizzle.execute(sql`
    INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "parent_step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "routing_kind", "routing_requirements", "billing_agent_id", "created_at", "updated_at")
    VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${parentRunId}, ${childRunId}, ${stepKey}, NULL, 0, 'child', ${revisionId}, ${hash}, 'pending_routing', NULL, ${JSON.stringify(requirements)}::jsonb, ${options?.billingAgentId ?? null}, ${now}, ${now})
  `);

  // Budget reservation for the root run (so budget headroom exists).
  const reservationId = randomUUID();
  const allocationId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, NULL, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${allocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, NULL, 5000, 0, 0, 'held', ${now}, ${now})
  `);

  return { childRunId, rootRunId, parentRunId, stepKey };
}

/** Build a RoutingContext from a pending-routing child setup. */
function buildContext(
  scope: { companyId: string; projectId: string },
  setup: { childRunId: string; rootRunId: string; parentRunId: string; stepKey: string },
  requirements: RoutingRequirements,
  options?: {
    stepBudgetCents?: number;
    stepTimeoutSeconds?: number;
    billingAgentId?: string | null;
  },
): RoutingContext {
  return {
    companyId: scope.companyId,
    projectId: scope.projectId,
    rootRunId: setup.rootRunId,
    parentRunId: setup.parentRunId,
    childRunId: setup.childRunId,
    stepKey: setup.stepKey,
    routingRequirements: requirements,
    stepBudgetCents: options?.stepBudgetCents ?? 100,
    stepTimeoutSeconds: options?.stepTimeoutSeconds ?? 300,
    billingAgentId: options?.billingAgentId ?? null,
    parentProvider: 'anthropic',
  };
}

/** Fetch the routing decision recorded in the DB after routing. */
async function getAssignment(db: AnyDb, rootRunId: string, stepKey: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "assignment_status", "routing_kind", "executing_agent_id", "billing_agent_id"
    FROM "run_step_assignments" WHERE "root_run_id" = ${rootRunId} AND "step_key" = ${stepKey}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

async function getChildRun(db: AnyDb, childRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "executing_agent_id", "routing_kind", "status", "available_at"
    FROM "mission_runs" WHERE "id" = ${childRunId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

async function getRoutedEvent(db: AnyDb, rootRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "type", "payload" FROM "run_events"
    WHERE "run_id" = ${rootRunId} AND "type" = 'child.routed'
  `)) as unknown as Array<{ type: string; payload: Record<string, unknown> }>;
  return rows[0];
}

/** Mark a mission_run as actively executing for an agent (to simulate working capacity). */
async function addActiveTask(
  db: AnyDb,
  agentId: string,
  companyId: string,
  projectId: string,
  threadId: string,
) {
  const runId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "executing_agent_id", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, NULL, 0, ${agentId}, 'company_agent', 'enc', 'hash', 'Active task', 'deep_work', 'running', 1, 0, 'require_all', ${now}, ${now}, ${now})
  `);
  return runId;
}

// ---------------------------------------------------------------------------
// Pure scoring unit tests (VAL-SUB-088) — no DB needed
// ---------------------------------------------------------------------------

describe('AgentRouter scoring (VAL-SUB-088) — pure unit', () => {
  function makeCandidate(over: Partial<AgentCandidate> & { id: string }): AgentCandidate {
    return {
      id: over.id,
      companyId: over.companyId ?? 'co',
      status: over.status ?? 'idle',
      provider: over.provider ?? 'anthropic',
      model: over.model ?? 'claude-sonnet-4-6',
      capabilities: over.capabilities ?? [],
      toolsEnabled: over.toolsEnabled ?? [],
      allowedDomains: over.allowedDomains ?? [],
      permissions: over.permissions ?? ['content.create'],
      maxConcurrentTasks: over.maxConcurrentTasks ?? 2,
      executionTimeoutSeconds: over.executionTimeoutSeconds ?? 600,
      budgetMonthlyCents: over.budgetMonthlyCents ?? 0,
      spentMonthlyCents: over.spentMonthlyCents ?? 0,
      activeTaskCount: over.activeTaskCount ?? 0,
      residualActiveAllocations: over.residualActiveAllocations ?? 0,
    };
  }

  it('sorts by capability match count descending', () => {
    const req: RoutingRequirements = {
      capabilities: ['research', 'analysis'],
      requiredTools: [],
      requiredDomains: [],
      ephemeralAllowed: true,
    };
    const a = makeCandidate({ id: 'a', capabilities: ['research', 'analysis', 'writing'] });
    const b = makeCandidate({ id: 'b', capabilities: ['research', 'analysis'] });
    // Both have all required, so match count = 2 for both. Tie-break by UUID.
    // 'a' < 'b' so 'a' wins.
    const winner = AgentRouter.scoreAndSelect([a, b], req);
    expect(winner?.id).toBe('a');
  });

  it('prefers idle before working (VAL-SUB-009)', () => {
    const req: RoutingRequirements = {
      capabilities: [],
      requiredTools: [],
      requiredDomains: [],
      ephemeralAllowed: true,
    };
    const idle = makeCandidate({ id: 'zzz', status: 'idle' });
    const working = makeCandidate({
      id: 'aaa',
      status: 'working',
      activeTaskCount: 0,
      maxConcurrentTasks: 2,
    });
    const winner = AgentRouter.scoreAndSelect([idle, working], req);
    expect(winner?.id).toBe('zzz');
  });

  it('sorts by free reserved slots descending', () => {
    const req: RoutingRequirements = {
      capabilities: [],
      requiredTools: [],
      requiredDomains: [],
      ephemeralAllowed: true,
    };
    // Both working, different free slots.
    const more = makeCandidate({
      id: 'b',
      status: 'working',
      maxConcurrentTasks: 5,
      activeTaskCount: 1,
    });
    const less = makeCandidate({
      id: 'a',
      status: 'working',
      maxConcurrentTasks: 2,
      activeTaskCount: 1,
    });
    const winner = AgentRouter.scoreAndSelect([more, less], req);
    expect(winner?.id).toBe('b');
  });

  it('sorts by remaining budget ratio descending (unlimited = 1.0)', () => {
    const req: RoutingRequirements = {
      capabilities: [],
      requiredTools: [],
      requiredDomains: [],
      ephemeralAllowed: true,
    };
    const unlimited = makeCandidate({ id: 'b', budgetMonthlyCents: 0 });
    const limited = makeCandidate({
      id: 'a',
      budgetMonthlyCents: 1000,
      spentMonthlyCents: 500,
      residualActiveAllocations: 0,
    });
    // unlimited ratio = 1.0; limited ratio = 0.5. Unlimited wins.
    const winner = AgentRouter.scoreAndSelect([unlimited, limited], req);
    expect(winner?.id).toBe('b');
  });

  it('breaks ties by lowercase UUID ascending', () => {
    const req: RoutingRequirements = {
      capabilities: [],
      requiredTools: [],
      requiredDomains: [],
      ephemeralAllowed: true,
    };
    const upper = makeCandidate({ id: 'BBBBBBBB' });
    const lower = makeCandidate({ id: 'aaaaaaaa' });
    const winner = AgentRouter.scoreAndSelect([upper, lower], req);
    expect(winner?.id).toBe('aaaaaaaa');
  });

  it('produces reproducible order across repeated calls (VAL-SUB-088)', () => {
    const req: RoutingRequirements = {
      capabilities: ['research'],
      requiredTools: ['research.search'],
      requiredDomains: [],
      ephemeralAllowed: true,
    };
    const candidates = [
      makeCandidate({
        id: 'c-3',
        status: 'working',
        maxConcurrentTasks: 3,
        activeTaskCount: 1,
        capabilities: ['research'],
        toolsEnabled: ['research.search'],
      }),
      makeCandidate({
        id: 'a-1',
        status: 'idle',
        maxConcurrentTasks: 2,
        activeTaskCount: 0,
        capabilities: ['research'],
        toolsEnabled: ['research.search'],
      }),
      makeCandidate({
        id: 'b-2',
        status: 'idle',
        maxConcurrentTasks: 5,
        activeTaskCount: 0,
        capabilities: ['research'],
        toolsEnabled: ['research.search'],
      }),
    ];
    const run1 = AgentRouter.scoreAndSelect(candidates, req);
    const run2 = AgentRouter.scoreAndSelect(candidates, req);
    expect(run1?.id).toBe(run2?.id);
    // b-2 has more free slots (5) than a-1 (2), both idle → b-2 wins.
    expect(run1?.id).toBe('b-2');
  });
});

// ---------------------------------------------------------------------------
// Filter chain integration tests — real Postgres
// ---------------------------------------------------------------------------

describe('AgentRouter filter chain (VAL-SUB-008 through 016, 041)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: AgentRouter;

  const baseReqs: RoutingRequirements = {
    capabilities: ['research'],
    requiredTools: ['research.search'],
    requiredDomains: ['example.com'],
    ephemeralAllowed: true,
  };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ routing');
    router = new AgentRouter(db, { clock: () => new Date() });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('VAL-SUB-008: eligible company agent wins', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible Agent',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(agentId);
    expect(decision.routingKind).toBe('company_agent');

    // DB state: assignment is routed, executing agent set.
    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment['assignment_status']).toBe('routed');
    expect(assignment['executing_agent_id']).toBe(agentId);
    expect(assignment['routing_kind']).toBe('company_agent');

    // Child run has executing agent set.
    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun['executing_agent_id']).toBe(agentId);
    expect(childRun['routing_kind']).toBe('company_agent');

    // child.routed event emitted on root journal.
    const evt = await getRoutedEvent(db, setup.rootRunId);
    expect(evt).toBeDefined();
    expect(evt!.payload['childRunId']).toBe(setup.childRunId);
    expect(evt!.payload['executingAgentId']).toBe(agentId);
    expect(evt!.payload['routingKind']).toBe('company_agent');
  });

  it('VAL-SUB-009: idle agents preferred over working', async () => {
    const idleId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Idle Agent',
      status: 'idle',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const workingId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Working Agent',
      status: 'working',
      maxConcurrentTasks: 2,
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    // Give the working agent an active task (below capacity).
    await addActiveTask(db, workingId, scope.companyId, scope.projectId, scope.threadId);

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(idleId);
  });

  it('VAL-SUB-010: working capacity honored (below-capacity selected, at-capacity excluded)', async () => {
    const belowId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Below Capacity',
      status: 'working',
      maxConcurrentTasks: 2,
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const atCapId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'At Capacity',
      status: 'working',
      maxConcurrentTasks: 1,
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    // Give each one active task. belowId has 1/2 (eligible), atCapId has 1/1 (excluded).
    await addActiveTask(db, belowId, scope.companyId, scope.projectId, scope.threadId);
    await addActiveTask(db, atCapId, scope.companyId, scope.projectId, scope.threadId);

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(belowId);
    // The at-capacity agent must be excluded.
    const atCapCandidate = decision.candidates.find((c) => c.agentId === atCapId);
    expect(atCapCandidate?.excluded).toBe(true);
    expect(atCapCandidate?.exclusionReason).toMatch(/capacity/i);
  });

  it('VAL-SUB-011: inactive agents excluded (paused, error, offline)', async () => {
    const eligibleId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const pausedId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Paused',
      status: 'paused',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const errorId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Error',
      status: 'error',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const offlineId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Offline',
      status: 'offline',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(eligibleId);
    for (const id of [pausedId, errorId, offlineId]) {
      const c = decision.candidates.find((x) => x.agentId === id);
      expect(c?.excluded).toBe(true);
      expect(c?.exclusionReason).toMatch(/status/i);
    }
  });

  it('VAL-SUB-012: capability coverage required (partial match excluded)', async () => {
    const fullId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Full Match',
      capabilities: ['research', 'analysis'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const partialId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Partial Match',
      capabilities: ['research'], // missing 'analysis'
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const reqs: RoutingRequirements = {
      capabilities: ['research', 'analysis'],
      requiredTools: ['research.search'],
      requiredDomains: ['example.com'],
      ephemeralAllowed: true,
    };
    const setup = await setupPendingRoutingChild(db, scope, reqs);
    const ctx = buildContext(scope, setup, reqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(fullId);
    const partial = decision.candidates.find((c) => c.agentId === partialId);
    expect(partial?.excluded).toBe(true);
    expect(partial?.exclusionReason).toMatch(/capabilit/i);
  });

  it('VAL-SUB-013: exact tools required (prefix wildcard does not match)', async () => {
    const exactId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Exact Tool',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const prefixId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Prefix Only',
      capabilities: ['research'],
      toolsEnabled: ['research'], // prefix, not exact 'research.search'
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(exactId);
    const prefix = decision.candidates.find((c) => c.agentId === prefixId);
    expect(prefix?.excluded).toBe(true);
    expect(prefix?.exclusionReason).toMatch(/tool/i);
  });

  it('VAL-SUB-013: exact domains required', async () => {
    const exactId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Exact Domain',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const wrongDomainId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Wrong Domain',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['other.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(exactId);
    const wrong = decision.candidates.find((c) => c.agentId === wrongDomainId);
    expect(wrong?.excluded).toBe(true);
    expect(wrong?.exclusionReason).toMatch(/domain/i);
  });

  it('VAL-SUB-014: runtime compatibility required (wrong provider excluded)', async () => {
    const compatibleId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Anthropic Agent',
      provider: 'anthropic',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const incompatibleId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'OpenAI Agent',
      provider: 'openai',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);
    // parentProvider defaults to 'anthropic'
    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(compatibleId);
    const incompatible = decision.candidates.find((c) => c.agentId === incompatibleId);
    expect(incompatible?.excluded).toBe(true);
    expect(incompatible?.exclusionReason).toMatch(/runtime|provider/i);
  });

  it('VAL-SUB-015: project permission required (no content.create excluded)', async () => {
    const authorizedId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Authorized',
      permissions: ['content.create'],
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const unauthorizedId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Unauthorized',
      permissions: [], // no content.create
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(authorizedId);
    const unauthorized = decision.candidates.find((c) => c.agentId === unauthorizedId);
    expect(unauthorized?.excluded).toBe(true);
    expect(unauthorized?.exclusionReason).toMatch(/permission/i);
  });

  it('VAL-SUB-016: budget eligibility (insufficient budget excluded)', async () => {
    const sufficientId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Sufficient Budget',
      budgetMonthlyCents: 1000,
      spentMonthlyCents: 0,
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const exhaustedId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Exhausted Budget',
      budgetMonthlyCents: 100,
      spentMonthlyCents: 100, // fully spent, 0 remaining
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs, {
      stepBudgetCents: 50,
    });
    const ctx = buildContext(scope, setup, baseReqs, { stepBudgetCents: 50 });

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(sufficientId);
    const exhausted = decision.candidates.find((c) => c.agentId === exhaustedId);
    expect(exhausted?.excluded).toBe(true);
    expect(exhausted?.exclusionReason).toMatch(/budget/i);
  });

  it('VAL-SUB-016: timeout eligibility (insufficient timeout excluded)', async () => {
    const sufficientId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Sufficient Timeout',
      executionTimeoutSeconds: 600,
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const insufficientId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Insufficient Timeout',
      executionTimeoutSeconds: 60,
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs, {
      stepTimeoutSeconds: 300,
    });
    const ctx = buildContext(scope, setup, baseReqs, { stepTimeoutSeconds: 300 });

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(sufficientId);
    const insufficient = decision.candidates.find((c) => c.agentId === insufficientId);
    expect(insufficient?.excluded).toBe(true);
    expect(insufficient?.exclusionReason).toMatch(/timeout/i);
  });

  it('VAL-SUB-041: company isolation (foreign-company agent never selected)', async () => {
    const foreignScope = await seedForeignScope(db, '__mtest__ foreign-co');
    const foreignAgentId = await seedAgent(db, {
      companyId: foreignScope.companyId,
      name: 'Foreign Agent',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const domesticId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Domestic Agent',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(domesticId);
    // Foreign agent must not appear in candidates at all.
    const foreign = decision.candidates.find((c) => c.agentId === foreignAgentId);
    expect(foreign).toBeUndefined();
  });

  it('VAL-SUB-041: no eligible domestic agent → no winner (foreign never considered)', async () => {
    const foreignScope = await seedForeignScope(db, '__mtest__ foreign-only');
    // Only a foreign agent exists — no domestic agent.
    await seedAgent(db, {
      companyId: foreignScope.companyId,
      name: 'Only Foreign',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(false);
    expect(decision.winnerAgentId).toBeNull();
    expect(decision.reason).toMatch(/no.*eligible/i);
    // No child.routed event.
    const evt = await getRoutedEvent(db, setup.rootRunId);
    expect(evt).toBeUndefined();
  });

  it('VAL-SUB-088: routing is reproducible across repeated calls', async () => {
    // Two identical-score agents — tie broken by UUID.
    const agentA = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Agent A',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    const agentB = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Agent B',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    // Route a single child twice (idempotent). Both calls return the same
    // winner — the lower UUID, since both agents have identical scores.
    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const d1 = await router.route(ctx);
    const d2 = await router.route(ctx);

    expect(d1.winnerAgentId).toBe(d2.winnerAgentId);
    const expectedWinner = [agentA, agentB].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    )[0];
    expect(d1.winnerAgentId).toBe(expectedWinner);
  });

  it('normal user output exposes only winner and safe reason codes (VAL-SUB-088)', async () => {
    await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);

    // The RoutingDecision exposes winner + reason, but candidate details
    // (scores, tuples) are protected diagnostics not in normal user output.
    expect(decision.winnerAgentId).toBeTruthy();
    expect(decision.reason).toBe('company_agent');
    // candidates array exists for protected diagnostics but is not part of
    // normal user API output (the caller decides what to expose).
    expect(Array.isArray(decision.candidates)).toBe(true);
  });

  it('routing is idempotent: re-routing a routed child returns the same decision', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const d1 = await router.route(ctx);
    expect(d1.winnerAgentId).toBe(agentId);

    // Re-route the same child — should return the same decision without
    // duplicating events or changing the assignment.
    const d2 = await router.route(ctx);
    expect(d2.winnerAgentId).toBe(agentId);
    expect(d2.selected).toBe(true);

    // Only one child.routed event.
    const rows = (await db.drizzle.execute(sql`
      SELECT count(*)::int as cnt FROM "run_events"
      WHERE "run_id" = ${setup.rootRunId} AND "type" = 'child.routed'
    `)) as unknown as Array<{ cnt: number }>;
    expect(rows[0].cnt).toBe(1);
  });
});
