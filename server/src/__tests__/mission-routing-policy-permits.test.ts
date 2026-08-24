import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestServers, closeTestDb } from '../test-utils.js';
import { AgentRouter, type RoutingContext } from '../services/mission/agent-router.js';
import { SchedulingService } from '../services/mission/scheduling.js';
import {
  deriveChildPolicy,
  childPolicyContentHash,
  checkRoutedAgentEligibility,
  type AgentPolicySettings,
} from '../services/mission/child-policy.js';
import type { ResolvedPolicy } from '../services/mission/policy.js';
import type { RoutingRequirements } from '../services/mission/plan-schema.js';
import { PLATFORM_HARD_CAPS } from '../services/mission/modes.js';
import { AppError } from '../middleware/error-handler.js';

/**
 * Routing policy and scheduling permits.
 *
 * (VAL-SUB-086, VAL-SUB-087, VAL-SUB-108, VAL-SUB-109)
 *
 * Tests exercise:
 * - Atomic capacity reservation under concurrent routing races.
 * - Immutable child policy derivation and revocation deny-only behavior.
 * - Permanent-agent execution policy derived once without substitution.
 * - Child scheduling permit acquire/release/recovery lifecycle.
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

const PARENT_LIMITS = {
  steps: 12,
  durationSeconds: 2700,
  providerCalls: 48,
  totalTokens: 300000,
  outputBytes: 8388608,
  costCents: 5000,
  depth: 2,
  fanOut: 4,
  descendants: 16,
};

const PARENT_POLICY: ResolvedPolicy = {
  schemaVersion: 1,
  sourceProfile: 'deep_work',
  sourceProfileName: 'Deep Work',
  sourceProfileDescription: 'Structured plan and approval by default',
  sourceProfileVersion: null,
  modeProfileId: null,
  provider: 'anthropic',
  adapterId: null,
  model: 'claude-sonnet-4-6',
  reasoningDepth: 'standard',
  systemPromptHash: 'hash-system-123',
  instructionHash: 'hash-instruct-456',
  toolAllowlist: ['research.search', 'artifact.create', 'analysis.run'],
  domainAllowlist: ['example.com', 'docs.example.com'],
  researchPolicy: { access: 'allowed' },
  planningPolicy: { strategy: 'always' },
  approvalPolicy: { strategy: 'always' },
  fallbackPolicy: {},
  partialResultPolicy: 'require_all' as const,
  limits: PARENT_LIMITS,
  resolvedMode: 'deep_work' as const,
};

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
  const parentRunId = rootRunId;
  const childRunId = randomUUID();
  const stepKey = `child-step-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const revisionId = randomUUID();
  const hash = randomUUID();
  const policySnapshotId = randomUUID();

  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "system_prompt_hash", "instruction_hash", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, ${options?.parentProvider ?? 'anthropic'}, null, 'claude-sonnet-4-6', 'standard', 'hash-system-123', 'hash-instruct-456', ${JSON.stringify(PARENT_POLICY.toolAllowlist)}::jsonb, ${JSON.stringify(PARENT_POLICY.domainAllowlist)}::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{}'::jsonb, 'require_all', ${JSON.stringify(PARENT_LIMITS)}::jsonb, ${randomUUID()}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "created_at", "updated_at")
    VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'encrypted', ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, NULL, ${options?.billingAgentId ?? null}, ${now}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
    VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', '{}'::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
    VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${parentRunId}, 1, 0, 'company_agent', 'encrypted-child', ${hash}, 'Child step', 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "parent_step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "routing_kind", "routing_requirements", "billing_agent_id", "created_at", "updated_at")
    VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${parentRunId}, ${childRunId}, ${stepKey}, NULL, 0, 'child', ${revisionId}, ${hash}, 'pending_routing', NULL, ${JSON.stringify(requirements)}::jsonb, ${options?.billingAgentId ?? null}, ${now}, ${now})
  `);

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

async function getAssignment(db: AnyDb, rootRunId: string, stepKey: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "assignment_status", "routing_kind", "executing_agent_id", "billing_agent_id",
           "child_policy_snapshot_id", "child_policy_content_hash", "admission_slot_held",
           "budget_allocation_id"
    FROM "run_step_assignments" WHERE "root_run_id" = ${rootRunId} AND "step_key" = ${stepKey}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

async function getChildRun(db: AnyDb, childRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "executing_agent_id", "routing_kind", "status", "available_at", "policy_snapshot_id"
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

async function getChildPolicySnapshot(db: AnyDb, snapshotId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "provider", "model", "tool_allowlist", "domain_allowlist", "limits", "content_hash",
           "instruction_hash", "system_prompt_hash"
    FROM "run_policy_snapshots" WHERE "id" = ${snapshotId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

async function countChildAllocations(db: AnyDb, childRunId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int as cnt FROM "budget_allocations" WHERE "run_id" = ${childRunId}
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0].cnt;
}

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
// Pure unit tests: child policy derivation (VAL-SUB-087, VAL-SUB-108)
// ---------------------------------------------------------------------------

describe('Child policy derivation (VAL-SUB-087, VAL-SUB-108) — pure unit', () => {
  function makeAgent(over: Partial<AgentPolicySettings> & { id: string }): AgentPolicySettings {
    return {
      id: over.id,
      provider: over.provider ?? 'anthropic',
      model: over.model ?? 'claude-sonnet-4-6',
      toolsEnabled: over.toolsEnabled ?? ['research.search', 'artifact.create', 'analysis.run'],
      allowedDomains: over.allowedDomains ?? ['example.com', 'docs.example.com'],
      permissions: over.permissions ?? ['content.create'],
      executionTimeoutSeconds: over.executionTimeoutSeconds ?? 600,
      budgetMonthlyCents: over.budgetMonthlyCents ?? 0,
      spentMonthlyCents: over.spentMonthlyCents ?? 0,
      status: over.status ?? 'idle',
    };
  }

  const baseReqs: RoutingRequirements = {
    capabilities: ['research'],
    requiredTools: ['research.search'],
    requiredDomains: ['example.com'],
    ephemeralAllowed: true,
  };

  it('derives child policy as parent ∩ agent (VAL-SUB-108)', () => {
    const agent = makeAgent({
      id: 'agent-1',
      toolsEnabled: ['research.search', 'artifact.create'], // missing 'analysis.run'
      allowedDomains: ['example.com'], // missing 'docs.example.com'
      model: 'claude-opus-4-2',
    });

    const child = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent,
      stepBudgetCents: 500,
    });

    // Provider from agent (matches parent).
    expect(child.provider).toBe('anthropic');
    // Model from agent — no substitution.
    expect(child.model).toBe('claude-opus-4-2');
    // Tools: parent ∩ agent.
    expect(child.toolAllowlist).toEqual(
      expect.arrayContaining(['research.search', 'artifact.create']),
    );
    expect(child.toolAllowlist).not.toContain('analysis.run');
    // Domains: parent ∩ agent.
    expect(child.domainAllowlist).toEqual(['example.com']);
    // Instruction hash inherited from parent.
    expect(child.instructionHash).toBe(PARENT_POLICY.instructionHash);
    // Partial result policy inherited.
    expect(child.partialResultPolicy).toBe('require_all');
  });

  it('child policy narrows limits (min of parent and agent) (VAL-SUB-108)', () => {
    const agent = makeAgent({
      id: 'agent-1',
      executionTimeoutSeconds: 300, // less than parent 2700
      budgetMonthlyCents: 1000,
      spentMonthlyCents: 600, // remaining = 400
    });

    const child = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent,
      stepBudgetCents: 200,
    });

    // Duration: min(parent 2700, agent 300) = 300.
    expect(child.limits.durationSeconds).toBe(300);
    // Cost: min(parent 5000, agent remaining 400, step 200) = 200.
    expect(child.limits.costCents).toBe(200);
  });

  it('child policy hash is immutable — later broadening does not expand it (VAL-SUB-087)', () => {
    const agent = makeAgent({
      id: 'agent-1',
      toolsEnabled: ['research.search', 'artifact.create'],
    });

    const child = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent,
      stepBudgetCents: 500,
    });
    const committedHash = childPolicyContentHash(child);

    // Later, the agent gets MORE tools (broadening). The committed hash
    // must NOT change because the snapshot is immutable.
    expect(childPolicyContentHash(child)).toBe(committedHash);

    // Even if we re-derive with a broadened agent, the original snapshot
    // hash is unchanged — the snapshot is read-only after commit.
    const broadenedAgent = makeAgent({
      id: 'agent-1',
      toolsEnabled: ['research.search', 'artifact.create', 'analysis.run', 'new.tool'],
    });
    const broadenedChild = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent: broadenedAgent,
      stepBudgetCents: 500,
    });
    // The broadened child would have a different hash, but the COMMITTED
    // snapshot hash is immutable — it never changes after commit.
    expect(childPolicyContentHash(child)).toBe(committedHash);
    // The broadened derivation produces a different (broader) policy.
    expect(childPolicyContentHash(broadenedChild)).not.toBe(committedHash);
  });

  it('empty tool intersection fails closed (VAL-SUB-108)', () => {
    const agent = makeAgent({
      id: 'agent-1',
      toolsEnabled: ['some.other.tool'], // no overlap with parent tools
    });

    try {
      deriveChildPolicy({
        parentPolicy: PARENT_POLICY,
        routingRequirements: baseReqs,
        agent,
        stepBudgetCents: 500,
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('POLICY_UNSATISFIABLE');
    }
  });

  it('checkRoutedAgentEligibility: eligible agent returns null (VAL-SUB-087)', () => {
    const child = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent: makeAgent({ id: 'agent-1' }),
      stepBudgetCents: 500,
    });
    const agent = makeAgent({ id: 'agent-1' });
    expect(checkRoutedAgentEligibility(child, agent)).toBeNull();
  });

  it('checkRoutedAgentEligibility: paused agent is ineligible (VAL-SUB-087)', () => {
    const child = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent: makeAgent({ id: 'agent-1' }),
      stepBudgetCents: 500,
    });
    const agent = makeAgent({ id: 'agent-1', status: 'paused' });
    expect(checkRoutedAgentEligibility(child, agent)).toBe('AGENT_BECAME_INELIGIBLE');
  });

  it('checkRoutedAgentEligibility: tools removed is ineligible (VAL-SUB-087)', () => {
    const child = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent: makeAgent({
        id: 'agent-1',
        toolsEnabled: ['research.search', 'artifact.create', 'analysis.run'],
      }),
      stepBudgetCents: 500,
    });
    // Agent later loses 'research.search'.
    const agent = makeAgent({ id: 'agent-1', toolsEnabled: ['artifact.create', 'analysis.run'] });
    expect(checkRoutedAgentEligibility(child, agent)).toBe('AGENT_BECAME_INELIGIBLE');
  });

  it('checkRoutedAgentEligibility: budget exhausted is ineligible (VAL-SUB-087)', () => {
    const child = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent: makeAgent({ id: 'agent-1', budgetMonthlyCents: 1000, spentMonthlyCents: 0 }),
      stepBudgetCents: 500,
    });
    // Agent later exhausts budget.
    const agent = makeAgent({ id: 'agent-1', budgetMonthlyCents: 1000, spentMonthlyCents: 1000 });
    expect(checkRoutedAgentEligibility(child, agent)).toBe('AGENT_BECAME_INELIGIBLE');
  });

  it('checkRoutedAgentEligibility: provider changed is ineligible (VAL-SUB-087)', () => {
    const child = deriveChildPolicy({
      parentPolicy: PARENT_POLICY,
      routingRequirements: baseReqs,
      agent: makeAgent({ id: 'agent-1', provider: 'anthropic' }),
      stepBudgetCents: 500,
    });
    const agent = makeAgent({ id: 'agent-1', provider: 'openai' });
    expect(checkRoutedAgentEligibility(child, agent)).toBe('AGENT_BECAME_INELIGIBLE');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: atomic capacity reservation (VAL-SUB-086)
// ---------------------------------------------------------------------------

describe('Atomic capacity reservation (VAL-SUB-086)', () => {
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
    scope = await seedScope(db, '__mtest__ routing-policy-086');
    router = new AgentRouter(db, { clock: () => new Date() });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('concurrent routers for one remaining slot produce at most one reservation', async () => {
    // Agent with maxConcurrentTasks=1, working, already has 1 active task.
    // The slot is full. Two concurrent routers should both fail.
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Single Slot Agent',
      status: 'working',
      maxConcurrentTasks: 1,
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });
    // Give the agent one active task (at capacity).
    await addActiveTask(db, agentId, scope.companyId, scope.projectId, scope.threadId);

    // Two concurrent routing attempts for different children.
    const setup1 = await setupPendingRoutingChild(db, scope, baseReqs);
    const setup2 = await setupPendingRoutingChild(db, scope, baseReqs);

    const ctx1 = buildContext(scope, setup1, baseReqs);
    const ctx2 = buildContext(scope, setup2, baseReqs);

    const [d1, d2] = await Promise.all([router.route(ctx1), router.route(ctx2)]);

    // Both should fail — no capacity.
    expect(d1.selected).toBe(false);
    expect(d2.selected).toBe(false);
    expect(d1.reason).toMatch(/no.*eligible/i);
    expect(d2.reason).toMatch(/no.*eligible/i);

    // No child.routed events.
    const evt1 = await getRoutedEvent(db, setup1.rootRunId);
    const evt2 = await getRoutedEvent(db, setup2.rootRunId);
    expect(evt1).toBeUndefined();
    expect(evt2).toBeUndefined();
  });

  it('concurrent routers for one available slot produce exactly one winner', async () => {
    // Agent with maxConcurrentTasks=1, idle (0 active tasks).
    // Two concurrent routers competing for the same single slot.
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Single Slot Idle',
      maxConcurrentTasks: 1,
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    // Two concurrent routing attempts for different children, same root run.
    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const stepKey2 = `child-step-${randomUUID().slice(0, 8)}`;
    const childRunId2 = randomUUID();
    const now = new Date();

    // Get the revision ID from the first step assignment.
    const revRows = (await db.drizzle.execute(sql`
      SELECT "approved_plan_revision_id" FROM "run_step_assignments"
      WHERE "root_run_id" = ${setup.rootRunId} LIMIT 1
    `)) as unknown as Array<{ approved_plan_revision_id: string }>;
    const revisionId = revRows[0]?.approved_plan_revision_id ?? setup.rootRunId;

    // Create a second child under the same root.
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
      VALUES (${childRunId2}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${setup.rootRunId}, ${setup.rootRunId}, 1, 1, 'company_agent', 'enc', 'h', 'Child 2', 'deep_work', 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "parent_step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "routing_kind", "routing_requirements", "billing_agent_id", "created_at", "updated_at")
      VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${setup.rootRunId}, ${setup.rootRunId}, ${childRunId2}, ${stepKey2}, NULL, 1, 'child', ${revisionId}, 'h', 'pending_routing', NULL, ${JSON.stringify(baseReqs)}::jsonb, NULL, ${now}, ${now})
    `);

    const ctx1 = buildContext(scope, setup, baseReqs);
    const ctx2: RoutingContext = {
      ...ctx1,
      childRunId: childRunId2,
      stepKey: stepKey2,
    };

    const [d1, d2] = await Promise.all([router.route(ctx1), router.route(ctx2)]);

    // Exactly one should win, the other should fail.
    const winners = [d1, d2].filter((d) => d.selected);
    const losers = [d1, d2].filter((d) => !d.selected);
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(winners[0].winnerAgentId).toBe(agentId);
    expect(losers[0].reason).toMatch(/no.*eligible/i);
  });

  it('routing reserves one agent admission slot (VAL-SUB-086)', async () => {
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

    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment['admission_slot_held']).toBe(true);
  });

  it('terminalization releases the admission slot exactly once (VAL-SUB-086)', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible Agent',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    await router.route(ctx);

    // Release the admission slot.
    await db.drizzle.transaction(async (tx) => {
      await router.releaseAdmissionSlot(tx, {
        companyId: scope.companyId,
        rootRunId: setup.rootRunId,
        stepKey: setup.stepKey,
      });
    });

    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment['admission_slot_held']).toBe(false);

    // Releasing again is idempotent — no error, still false.
    await db.drizzle.transaction(async (tx) => {
      await router.releaseAdmissionSlot(tx, {
        companyId: scope.companyId,
        rootRunId: setup.rootRunId,
        stepKey: setup.stepKey,
      });
    });

    const assignment2 = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment2['admission_slot_held']).toBe(false);
  });

  it('routing creates one child budget allocation from root reservation (VAL-SUB-086)', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible Agent',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs, { stepBudgetCents: 500 });
    const ctx = buildContext(scope, setup, baseReqs, { stepBudgetCents: 500 });

    const decision = await router.route(ctx);
    expect(decision.selected).toBe(true);

    // One child allocation created.
    const allocCount = await countChildAllocations(db, setup.childRunId);
    expect(allocCount).toBe(1);

    // Assignment has the allocation ID set.
    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment['budget_allocation_id']).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: immutable child policy and revocation (VAL-SUB-087)
// ---------------------------------------------------------------------------

describe('Immutable child policy and revocation (VAL-SUB-087, VAL-SUB-108)', () => {
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
    scope = await seedScope(db, '__mtest__ routing-policy-087');
    router = new AgentRouter(db, { clock: () => new Date() });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('routing commits one immutable child policy snapshot (VAL-SUB-087, VAL-SUB-108)', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible Agent',
      model: 'claude-opus-4-2',
      capabilities: ['research'],
      toolsEnabled: ['research.search', 'artifact.create'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const decision = await router.route(ctx);
    expect(decision.selected).toBe(true);

    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment['child_policy_snapshot_id']).toBeTruthy();
    expect(assignment['child_policy_content_hash']).toBeTruthy();

    // The child run's policy_snapshot_id is updated to the child snapshot.
    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun['policy_snapshot_id']).toBe(assignment['child_policy_snapshot_id']);

    // The child policy snapshot has the agent's model (no substitution).
    const snapshot = await getChildPolicySnapshot(
      db,
      assignment['child_policy_snapshot_id'] as string,
    );
    expect(snapshot['model']).toBe('claude-opus-4-2');
    expect(snapshot['provider']).toBe('anthropic');
    // Tools: parent ∩ agent.
    const tools = snapshot['tool_allowlist'] as string[];
    expect(tools).toContain('research.search');
    expect(tools).toContain('artifact.create');
    expect(tools).not.toContain('analysis.run');
    // Instruction hash inherited from parent.
    expect(snapshot['instruction_hash']).toBe('hash-instruct-456');
  });

  it('child.routed event includes policy snapshot ID and hash (VAL-SUB-087)', async () => {
    await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible Agent',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    await router.route(ctx);

    const evt = await getRoutedEvent(db, setup.rootRunId);
    expect(evt).toBeDefined();
    expect(evt!.payload['policySnapshotId']).toBeTruthy();
    expect(evt!.payload['policyContentHash']).toBeTruthy();
  });

  it('after routing, never reroutes — re-routing returns same decision (VAL-SUB-087)', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Eligible Agent',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    const d1 = await router.route(ctx);
    const d2 = await router.route(ctx);

    expect(d1.winnerAgentId).toBe(agentId);
    expect(d2.winnerAgentId).toBe(agentId);

    // Only one child.routed event.
    const rows = (await db.drizzle.execute(sql`
      SELECT count(*)::int as cnt FROM "run_events"
      WHERE "run_id" = ${setup.rootRunId} AND "type" = 'child.routed'
    `)) as unknown as Array<{ cnt: number }>;
    expect(rows[0].cnt).toBe(1);

    // Only one child policy snapshot.
    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    const snapshotRows = (await db.drizzle.execute(sql`
      SELECT count(*)::int as cnt FROM "run_policy_snapshots"
      WHERE "id" = ${assignment['child_policy_snapshot_id']}
    `)) as unknown as Array<{ cnt: number }>;
    expect(snapshotRows[0].cnt).toBe(1);
  });

  it('revoked agent fails child with AGENT_BECAME_INELIGIBLE (VAL-SUB-087)', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Becomes Ineligible',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    await router.route(ctx);

    // Agent becomes paused (revoked).
    await db.drizzle.execute(sql`
      UPDATE "agents" SET "status" = 'paused' WHERE "id" = ${agentId}
    `);

    // Check and fail.
    const failed = await db.drizzle.transaction(async (tx) => {
      return router.checkAndFailRevokedAgent(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId: setup.rootRunId,
        childRunId: setup.childRunId,
        stepKey: setup.stepKey,
      });
    });

    expect(failed).toBe(true);

    // Child run is failed.
    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun['status']).toBe('failed');

    // Assignment is failed with AGENT_BECAME_INELIGIBLE.
    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment['assignment_status']).toBe('failed');

    // Admission slot released.
    expect(assignment['admission_slot_held']).toBe(false);

    // run.failed event on child journal.
    const failedEvts = (await db.drizzle.execute(sql`
      SELECT "type", "payload" FROM "run_events"
      WHERE "run_id" = ${setup.childRunId} AND "type" = 'run.failed'
    `)) as unknown as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(failedEvts.length).toBe(1);
    expect(failedEvts[0].payload['code']).toBe('AGENT_BECAME_INELIGIBLE');

    // child.failed event on root journal.
    const childFailedEvts = (await db.drizzle.execute(sql`
      SELECT "type", "payload" FROM "run_events"
      WHERE "run_id" = ${setup.rootRunId} AND "type" = 'child.failed'
    `)) as unknown as Array<{ type: string; payload: Record<string, unknown> }>;
    expect(childFailedEvts.length).toBe(1);
    expect(childFailedEvts[0].payload['code']).toBe('AGENT_BECAME_INELIGIBLE');
  });

  it('eligible agent is not failed by revocation check (VAL-SUB-087)', async () => {
    await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Still Eligible',
      capabilities: ['research'],
      toolsEnabled: ['research.search'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    await router.route(ctx);

    const failed = await db.drizzle.transaction(async (tx) => {
      return router.checkAndFailRevokedAgent(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId: setup.rootRunId,
        childRunId: setup.childRunId,
        stepKey: setup.stepKey,
      });
    });

    expect(failed).toBe(false);

    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun['status']).not.toBe('failed');
  });

  it('later agent broadening does not change committed child hash (VAL-SUB-087)', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Broadened Later',
      capabilities: ['research'],
      toolsEnabled: ['research.search', 'artifact.create'],
      allowedDomains: ['example.com'],
    });

    const setup = await setupPendingRoutingChild(db, scope, baseReqs);
    const ctx = buildContext(scope, setup, baseReqs);

    await router.route(ctx);

    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    const committedHash = assignment['child_policy_content_hash'] as string;

    // Agent gets more tools (broadening).
    await db.drizzle.execute(sql`
      UPDATE "agents" SET "tools_enabled" = ${JSON.stringify(['research.search', 'artifact.create', 'analysis.run', 'new.tool'])}::jsonb
      WHERE "id" = ${agentId}
    `);

    // Re-check revocation — agent is still eligible (has more tools, not fewer).
    const failed = await db.drizzle.transaction(async (tx) => {
      return router.checkAndFailRevokedAgent(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId: setup.rootRunId,
        childRunId: setup.childRunId,
        stepKey: setup.stepKey,
      });
    });

    expect(failed).toBe(false);

    // The committed hash is unchanged.
    const assignment2 = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment2['child_policy_content_hash']).toBe(committedHash);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: scheduling permits (VAL-SUB-109)
// ---------------------------------------------------------------------------

describe('Child scheduling permits (VAL-SUB-109)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let scheduling: SchedulingService;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ routing-policy-109');
    scheduling = new SchedulingService(db, { clock: () => new Date() });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  async function createChildRun(
    rootRunId: string,
    parentRunId: string,
    ordinal: number,
  ): Promise<string> {
    const childRunId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
      VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${parentRunId}, 1, ${ordinal}, 'company_agent', 'enc', 'h', 'Child', 'deep_work', 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
    `);
    return childRunId;
  }

  async function createRootRun(): Promise<string> {
    const rootRunId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'enc', 'h', 'Root', 'deep_work', 'running', 1, 0, 'require_all', ${now}, ${now})
    `);
    return rootRunId;
  }

  it('acquire permits creates root_running and parent_running permits (VAL-SUB-109)', async () => {
    const rootRunId = await createRootRun();
    const childRunId = await createChildRun(rootRunId, rootRunId, 0);

    const result = await db.drizzle.transaction(async (tx) => {
      return scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childRunId,
        rootFanOut: 4,
        parentFanOut: 4,
      });
    });

    expect(result.rootPermitId).toBeTruthy();
    expect(result.parentPermitId).toBeTruthy();

    // Two permits in the DB.
    const permits = await scheduling.getPermitsForRun(childRunId);
    expect(permits.length).toBe(2);
    expect(permits.some((p) => p.permitKind === 'root_running')).toBe(true);
    expect(permits.some((p) => p.permitKind === 'parent_running')).toBe(true);
    expect(permits.every((p) => p.status === 'held')).toBe(true);
  });

  it('root running permit limit enforced (VAL-SUB-109)', async () => {
    const rootRunId = await createRootRun();
    // Acquire permits for 4 children (platform hard cap).
    for (let i = 0; i < PLATFORM_HARD_CAPS.fanOut; i++) {
      const childRunId = await createChildRun(rootRunId, rootRunId, i);
      await db.drizzle.transaction(async (tx) => {
        await scheduling.acquireRunningPermits(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          rootRunId,
          parentRunId: rootRunId,
          runId: childRunId,
          rootFanOut: 4,
          parentFanOut: 4,
        });
      });
    }

    // 5th child should fail.
    const child5 = await createChildRun(rootRunId, rootRunId, 4);
    try {
      await db.drizzle.transaction(async (tx) => {
        await scheduling.acquireRunningPermits(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          rootRunId,
          parentRunId: rootRunId,
          runId: child5,
          rootFanOut: 4,
          parentFanOut: 4,
        });
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('LIMIT_EXCEEDED');
    }
  });

  it('parent running permit limit enforced (VAL-SUB-109)', async () => {
    const rootRunId = await createRootRun();
    const parentFanOut = 2;

    // Acquire permits for 2 children (parent fan-out limit).
    for (let i = 0; i < parentFanOut; i++) {
      const childRunId = await createChildRun(rootRunId, rootRunId, i);
      await db.drizzle.transaction(async (tx) => {
        await scheduling.acquireRunningPermits(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          rootRunId,
          parentRunId: rootRunId,
          runId: childRunId,
          rootFanOut: 4,
          parentFanOut,
        });
      });
    }

    // 3rd child should fail (parent fan-out exceeded).
    const child3 = await createChildRun(rootRunId, rootRunId, 2);
    try {
      await db.drizzle.transaction(async (tx) => {
        await scheduling.acquireRunningPermits(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          rootRunId,
          parentRunId: rootRunId,
          runId: child3,
          rootFanOut: 4,
          parentFanOut,
        });
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('LIMIT_EXCEEDED');
    }
  });

  it('release permits is idempotent (VAL-SUB-109)', async () => {
    const rootRunId = await createRootRun();
    const childRunId = await createChildRun(rootRunId, rootRunId, 0);

    await db.drizzle.transaction(async (tx) => {
      await scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childRunId,
        rootFanOut: 4,
        parentFanOut: 4,
      });
    });

    // Release.
    const r1 = await db.drizzle.transaction(async (tx) => {
      return scheduling.releasePermits(tx, childRunId);
    });
    expect(r1.released).toBe(2);

    // Release again — idempotent, no permits to release.
    const r2 = await db.drizzle.transaction(async (tx) => {
      return scheduling.releasePermits(tx, childRunId);
    });
    expect(r2.released).toBe(0);

    // All permits are released.
    const permits = await scheduling.getPermitsForRun(childRunId);
    expect(permits.every((p) => p.status === 'released')).toBe(true);
    expect(permits.every((p) => p.releasedAt !== null)).toBe(true);
  });

  it('release frees permit slots for other children (VAL-SUB-109)', async () => {
    const rootRunId = await createRootRun();
    const parentFanOut = 1;

    // Acquire permit for child 1.
    const child1 = await createChildRun(rootRunId, rootRunId, 0);
    await db.drizzle.transaction(async (tx) => {
      await scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: child1,
        rootFanOut: 4,
        parentFanOut,
      });
    });

    // Child 2 should fail (parent fan-out = 1, slot held by child 1).
    const child2 = await createChildRun(rootRunId, rootRunId, 1);
    try {
      await db.drizzle.transaction(async (tx) => {
        await scheduling.acquireRunningPermits(tx, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          rootRunId,
          parentRunId: rootRunId,
          runId: child2,
          rootFanOut: 4,
          parentFanOut,
        });
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('LIMIT_EXCEEDED');
    }

    // Release child 1's permits.
    await db.drizzle.transaction(async (tx) => {
      await scheduling.releasePermits(tx, child1);
    });

    // Now child 2 can acquire (slot freed).
    await db.drizzle.transaction(async (tx) => {
      await scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: child2,
        rootFanOut: 4,
        parentFanOut,
      });
    });

    const permits = await scheduling.getPermitsForRun(child2);
    expect(permits.length).toBe(2);
    expect(permits.every((p) => p.status === 'held')).toBe(true);
  });

  it('reacquire permits after awaiting_input (VAL-SUB-109)', async () => {
    const rootRunId = await createRootRun();
    const childRunId = await createChildRun(rootRunId, rootRunId, 0);

    // Acquire.
    await db.drizzle.transaction(async (tx) => {
      await scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childRunId,
        rootFanOut: 4,
        parentFanOut: 4,
      });
    });

    // Release (child enters awaiting_input).
    await db.drizzle.transaction(async (tx) => {
      await scheduling.releasePermits(tx, childRunId);
    });

    // Reacquire (child resumes from awaiting_input).
    const result = await db.drizzle.transaction(async (tx) => {
      return scheduling.reacquirePermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childRunId,
        rootFanOut: 4,
        parentFanOut: 4,
      });
    });

    expect(result.rootPermitId).toBeTruthy();
    expect(result.parentPermitId).toBeTruthy();

    // The child has 2 permits total (reactivated, not duplicated).
    // One lifecycle per permit — no duplicate rows (VAL-SUB-109).
    const permits = await scheduling.getPermitsForRun(childRunId);
    expect(permits.length).toBe(2);
    expect(permits.every((p) => p.status === 'held')).toBe(true);
  });

  it('cancellation release is idempotent — no double-release (VAL-SUB-109)', async () => {
    const rootRunId = await createRootRun();
    const childRunId = await createChildRun(rootRunId, rootRunId, 0);

    await db.drizzle.transaction(async (tx) => {
      await scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childRunId,
        rootFanOut: 4,
        parentFanOut: 4,
      });
    });

    // Simulate cancellation, failure, and recovery all releasing.
    for (let i = 0; i < 3; i++) {
      await db.drizzle.transaction(async (tx) => {
        await scheduling.releasePermits(tx, childRunId);
      });
    }

    // Only 2 permits were ever held, and all are released.
    const permits = await scheduling.getPermitsForRun(childRunId);
    expect(permits.length).toBe(2);
    expect(permits.every((p) => p.status === 'released')).toBe(true);
  });
});
