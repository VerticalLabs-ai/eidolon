import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestServers, closeTestDb } from '../test-utils.js';
import {
  EphemeralFallbackRouter,
  checkEphemeralRequirements,
  type EphemeralRoutingContext,
} from '../services/mission/ephemeral-router.js';
import { AgentRouter, type RoutingContext } from '../services/mission/agent-router.js';
import { TopologyMaterializer } from '../services/mission/topology-materializer.js';
import type { ResolvedPolicy } from '../services/mission/policy.js';
import type { RoutingRequirements, PlanContent } from '../services/mission/plan-schema.js';
import type { ModeLimits } from '../services/mission/modes.js';

/**
 * Regression tests for fix-ut-m5-policy-toolallowlist-billing-agent.
 *
 * Three blocking bugs in the routing/ephemeral fallback path:
 *
 * (1) Parent policy toolAllowlist is empty [] when researchPolicy.access
 *     is 'allowed'. checkEphemeralRequirements checks requiredTools against
 *     parentPolicy.toolAllowlist, but toolAllowlist is always empty for
 *     deep_work mode. This causes MISSING_TOOLS denial for all ephemeral
 *     fallback attempts.
 *
 * (2) billing_agent_id is null in run_step_assignments.
 *     handleTopologyMaterialization passes null for billingAgentId to
 *     materializer.materialize().
 *
 * (3) Company agent routing fails with NO_ELIGIBLE_AGENT even when agent
 *     has matching capabilities and tools — research tools are required
 *     but the agent doesn't have them in toolsEnabled, while
 *     researchPolicy.access is 'allowed'.
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

async function seedAgent(
  db: AnyDb,
  input: {
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
  },
): Promise<string> {
  const id = input.id ?? randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "api_key_encrypted", "created_at", "updated_at")
    VALUES (${id}, ${input.companyId}, ${input.name}, 'engineer', ${input.provider ?? 'anthropic'}, ${input.model ?? 'claude-sonnet-4-6'}, ${input.status ?? 'idle'}, ${JSON.stringify(input.capabilities ?? [])}::jsonb, '{}'::jsonb, '{}'::jsonb, ${JSON.stringify(input.permissions ?? ['content.create'])}::jsonb, ${JSON.stringify(input.toolsEnabled ?? [])}::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, ${JSON.stringify(input.allowedDomains ?? [])}::jsonb, ${input.maxConcurrentTasks ?? 2}, 300, ${input.executionTimeoutSeconds ?? 600}, 0, ${input.budgetMonthlyCents ?? 0}, ${input.spentMonthlyCents ?? 0}, 'encrypted-key', ${now}, ${now})
  `);
  return id;
}

const EMPTY_TOOL_POLICY_LIMITS: ModeLimits = {
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

/**
 * Parent policy with an EMPTY toolAllowlist but researchPolicy.access='allowed'.
 * This is the deep_work mode scenario where the agent has no tools enabled,
 * so the intersection produces an empty toolAllowlist, but research is
 * allowed by the mode policy.
 */
const EMPTY_TOOL_PARENT_POLICY: ResolvedPolicy = {
  schemaVersion: 1 as const,
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
  toolAllowlist: [], // EMPTY — this is the bug scenario
  domainAllowlist: ['example.com'],
  researchPolicy: { access: 'allowed' },
  planningPolicy: { strategy: 'always' },
  approvalPolicy: { strategy: 'always' },
  fallbackPolicy: { ephemeralAllowed: true },
  partialResultPolicy: 'require_all' as const,
  limits: EMPTY_TOOL_POLICY_LIMITS,
  resolvedMode: 'deep_work' as const,
};

const RESEARCH_REQS: RoutingRequirements = {
  capabilities: ['research'],
  requiredTools: ['research.search', 'research.extract'],
  requiredDomains: ['example.com'],
  ephemeralAllowed: true,
};

// ---------------------------------------------------------------------------
// Bug 1: Ephemeral fallback succeeds when researchPolicy.access is 'allowed'
// and toolAllowlist is empty
// ---------------------------------------------------------------------------

describe('Bug 1: Ephemeral fallback with empty toolAllowlist + researchPolicy.access=allowed', () => {
  describe('checkEphemeralRequirements — pure unit', () => {
    it('research tools pass when researchPolicy.access is allowed even if toolAllowlist is empty', () => {
      const result = checkEphemeralRequirements({
        routingRequirements: RESEARCH_REQS,
        parentPolicy: EMPTY_TOOL_PARENT_POLICY,
        billingAgentId: 'billing-agent-1',
        billingAgentBudgetMonthlyCents: 0,
        billingAgentSpentMonthlyCents: 0,
        billingAgentResidualAllocations: 0,
        stepBudgetCents: 500,
        stepTimeoutSeconds: 300,
        hasCredential: true,
      });
      expect(result).toBeNull(); // all requirements satisfied
    });

    it('research tools fail when researchPolicy.access is off and toolAllowlist is empty', () => {
      const policy: ResolvedPolicy = {
        ...EMPTY_TOOL_PARENT_POLICY,
        researchPolicy: { access: 'off' },
      };
      const result = checkEphemeralRequirements({
        routingRequirements: RESEARCH_REQS,
        parentPolicy: policy,
        billingAgentId: 'billing-agent-1',
        billingAgentBudgetMonthlyCents: 0,
        billingAgentSpentMonthlyCents: 0,
        billingAgentResidualAllocations: 0,
        stepBudgetCents: 500,
        stepTimeoutSeconds: 300,
        hasCredential: true,
      });
      expect(result).toBe('MISSING_TOOLS');
    });

    it('non-research tools still require toolAllowlist membership', () => {
      const reqs: RoutingRequirements = {
        ...RESEARCH_REQS,
        requiredTools: ['research.search', 'artifact.create'],
      };
      const result = checkEphemeralRequirements({
        routingRequirements: reqs,
        parentPolicy: EMPTY_TOOL_PARENT_POLICY,
        billingAgentId: 'billing-agent-1',
        billingAgentBudgetMonthlyCents: 0,
        billingAgentSpentMonthlyCents: 0,
        billingAgentResidualAllocations: 0,
        stepBudgetCents: 500,
        stepTimeoutSeconds: 300,
        hasCredential: true,
      });
      expect(result).toBe('MISSING_TOOLS');
    });

    it('research tools pass when toolAllowlist contains them (backward compat)', () => {
      const policy: ResolvedPolicy = {
        ...EMPTY_TOOL_PARENT_POLICY,
        toolAllowlist: ['research.search', 'research.extract'],
        researchPolicy: { access: 'off' },
      };
      const result = checkEphemeralRequirements({
        routingRequirements: RESEARCH_REQS,
        parentPolicy: policy,
        billingAgentId: 'billing-agent-1',
        billingAgentBudgetMonthlyCents: 0,
        billingAgentSpentMonthlyCents: 0,
        billingAgentResidualAllocations: 0,
        stepBudgetCents: 500,
        stepTimeoutSeconds: 300,
        hasCredential: true,
      });
      expect(result).toBeNull();
    });
  });

  describe('Integration: ephemeral fallback succeeds with empty toolAllowlist', () => {
    let db: AnyDb;
    let scope: { companyId: string; projectId: string; threadId: string };
    let router: EphemeralFallbackRouter;

    beforeEach(async () => {
      enableMissionFlag();
      db = await createTestDb();
      scope = await seedScope(db, '__mtest__ toolallowlist-fix');
      router = new EphemeralFallbackRouter(db, { clock: () => new Date(), hasCredential: true });
    });

    afterEach(async () => {
      await closeTestServers();
      await closeTestDb();
    });

    it('ephemeral fallback succeeds when researchPolicy.access is allowed and toolAllowlist is empty', async () => {
      const billingAgentId = await seedAgent(db, {
        companyId: scope.companyId,
        name: 'Billing Agent',
      });

      // Create a parent run with an EMPTY toolAllowlist policy snapshot
      // but researchPolicy.access = 'allowed'.
      const rootRunId = randomUUID();
      const childRunId = randomUUID();
      const stepKey = `research-step-${randomUUID().slice(0, 8)}`;
      const now = new Date();
      const revisionId = randomUUID();
      const hash = randomUUID();
      const policySnapshotId = randomUUID();

      await db.drizzle.execute(sql`
        INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "system_prompt_hash", "instruction_hash", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
        VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', 'hash-sys', 'hash-instr', '[]'::jsonb, ${JSON.stringify(EMPTY_TOOL_PARENT_POLICY.domainAllowlist)}::jsonb, '{"access": "allowed"}'::jsonb, '{"strategy": "always"}'::jsonb, '{"strategy": "always"}'::jsonb, '{"ephemeralAllowed": true}'::jsonb, 'require_all', ${JSON.stringify(EMPTY_TOOL_POLICY_LIMITS)}::jsonb, ${randomUUID()}, ${now})
      `);

      await db.drizzle.execute(sql`
        INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "created_at", "updated_at")
        VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'encrypted', ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, NULL, ${billingAgentId}, ${now}, ${now})
      `);

      await db.drizzle.execute(sql`
        INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
        VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', '{}'::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
      `);

      await db.drizzle.execute(sql`
        INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
        VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${rootRunId}, 1, 0, 'company_agent', 'encrypted-child', ${hash}, 'Child step', 'deep_work', ${policySnapshotId}, 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
      `);

      await db.drizzle.execute(sql`
        INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "parent_step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "routing_kind", "routing_requirements", "billing_agent_id", "created_at", "updated_at")
        VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${rootRunId}, ${childRunId}, ${stepKey}, NULL, 0, 'child', ${revisionId}, ${hash}, 'pending_routing', NULL, ${JSON.stringify(RESEARCH_REQS)}::jsonb, ${billingAgentId}, ${now}, ${now})
      `);

      const reservationId = randomUUID();
      const allocationId = randomUUID();
      await db.drizzle.execute(sql`
        INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
        VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, ${billingAgentId}, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
      `);
      await db.drizzle.execute(sql`
        INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
        VALUES (${allocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, ${billingAgentId}, 5000, 0, 0, 'held', ${now}, ${now})
      `);

      const ctx: EphemeralRoutingContext = {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        childRunId,
        stepKey,
        routingRequirements: RESEARCH_REQS,
        stepBudgetCents: 500,
        stepTimeoutSeconds: 300,
        billingAgentId,
      };

      const result = await router.routeOrFail(ctx);

      expect(result.outcome).toBe('ephemeral');
      expect(result.routingKind).toBe('ephemeral');
      expect(result.reason).toBe('ephemeral');
    });
  });
});

// ---------------------------------------------------------------------------
// Bug 2: billing_agent_id is non-null in step assignments after materialization
// ---------------------------------------------------------------------------

describe('Bug 2: billing_agent_id is non-null in step assignments', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ billing-agent-fix');
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('materialize sets billing_agent_id from rootRun.billingAgentId when set', async () => {
    const initiatingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Initiating Agent',
    });

    const rootRunId = randomUUID();
    const now = new Date();
    const revisionId = randomUUID();
    const hash = randomUUID();
    const policySnapshotId = randomUUID();

    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "system_prompt_hash", "instruction_hash", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', 'h', 'h', '[]'::jsonb, '[]'::jsonb, '{"access": "allowed"}'::jsonb, '{"strategy": "always"}'::jsonb, '{"strategy": "always"}'::jsonb, '{}'::jsonb, 'require_all', ${JSON.stringify(EMPTY_TOOL_POLICY_LIMITS)}::jsonb, ${randomUUID()}, ${now})
    `);

    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "initiating_agent_id", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'enc', ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, NULL, ${initiatingAgentId}, ${initiatingAgentId}, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', ${JSON.stringify(
        {
          schemaVersion: 1 as const,
          objective: 'Test objective',
          steps: [
            {
              stepKey: 'root-step',
              title: 'Root',
              description: 'Root step',
              parentStepKey: null,
              childOrdinal: 0,
              nodeKind: 'root',
              dependencies: [],
              routing: { kind: 'direct' },
              toolAllowlist: [],
              expectedOutputs: [],
              completionCriteria: [],
              budgetCents: 5000,
            },
            {
              stepKey: 'child-step-1',
              title: 'Child Step 1',
              description: 'Research step',
              parentStepKey: 'root-step',
              childOrdinal: 0,
              nodeKind: 'child',
              dependencies: ['root-step'],
              dependencyKinds: { 'root-step': 'required' },
              routing: {
                kind: 'requirements',
                routingRequirements: {
                  capabilities: ['research'],
                  requiredTools: ['research.search'],
                  requiredDomains: [],
                  ephemeralAllowed: true,
                },
              },
              toolAllowlist: ['research.search'],
              expectedOutputs: ['research-results'],
              completionCriteria: [],
              budgetCents: 500,
            },
          ],
          synthesis: { strategy: 'concat' },
          partialResultPolicy: 'require_all',
          limits: { ...EMPTY_TOOL_POLICY_LIMITS, costCents: 5000 },
        },
      )}::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    // Read the root run row.
    const schema = db.schema;
    const [rootRun] = await db.drizzle
      .select()
      .from(schema.missionRuns)
      .where(eq(schema.missionRuns.id, rootRunId))
      .limit(1);

    const materializer = new TopologyMaterializer(db, { clock: () => now });
    const plan = {
      schemaVersion: 1 as const,
      objective: 'Test objective',
      steps: [
        {
          stepKey: 'root-step',
          title: 'Root',
          description: 'Root step',
          parentStepKey: null,
          childOrdinal: 0,
          nodeKind: 'root' as const,
          dependencies: [],
          routing: { kind: 'direct' as const },
          toolAllowlist: [],
          expectedOutputs: [],
          completionCriteria: [],
          budgetCents: 5000,
        },
        {
          stepKey: 'child-step-1',
          title: 'Child Step 1',
          description: 'Research step',
          parentStepKey: 'root-step',
          childOrdinal: 0,
          nodeKind: 'child' as const,
          dependencies: ['root-step'],
          dependencyKinds: { 'root-step': 'required' },
          routing: {
            kind: 'requirements' as const,
            routingRequirements: {
              capabilities: ['research'],
              requiredTools: ['research.search'],
              requiredDomains: [],
              ephemeralAllowed: true,
            },
          },
          toolAllowlist: ['research.search'],
          expectedOutputs: ['research-results'],
          completionCriteria: [],
          budgetCents: 500,
        },
      ],
      synthesis: { strategy: 'concat' as const },
      planningBudgetCents: 0,
      partialResultPolicy: 'require_all' as const,
      limits: { ...EMPTY_TOOL_POLICY_LIMITS, costCents: 5000 },
    } as unknown as PlanContent;

    await db.drizzle.transaction(async (tx) => {
      // Lock the root run.
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, rootRunId))
        .for('update')
        .limit(1);

      await materializer.materialize(
        tx,
        lockedRun,
        plan,
        revisionId,
        hash,
        'system',
        null,
        null,
        undefined,
        // Pass the effective billing agent ID (rootRun.billingAgentId ?? rootRun.initiatingAgentId)
        lockedRun.billingAgentId ?? lockedRun.initiatingAgentId,
      );
    });

    // Verify the step assignment has a non-null billing_agent_id.
    const assignmentRows = (await db.drizzle.execute(sql`
      SELECT "billing_agent_id" FROM "run_step_assignments"
      WHERE "root_run_id" = ${rootRunId} AND "step_key" = 'child-step-1'
    `)) as unknown as Array<{ billing_agent_id: string }>;

    expect(assignmentRows.length).toBe(1);
    expect(assignmentRows[0].billing_agent_id).toBe(initiatingAgentId);
  });

  it('materialize falls back to initiatingAgentId when billingAgentId is null', async () => {
    const initiatingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Initiating Agent',
    });

    const rootRunId = randomUUID();
    const now = new Date();
    const revisionId = randomUUID();
    const hash = randomUUID();
    const policySnapshotId = randomUUID();

    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "system_prompt_hash", "instruction_hash", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', 'h', 'h', '[]'::jsonb, '[]'::jsonb, '{"access": "allowed"}'::jsonb, '{"strategy": "always"}'::jsonb, '{"strategy": "always"}'::jsonb, '{}'::jsonb, 'require_all', ${JSON.stringify(EMPTY_TOOL_POLICY_LIMITS)}::jsonb, ${randomUUID()}, ${now})
    `);

    // Root run with billing_agent_id = NULL but initiating_agent_id = set.
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "initiating_agent_id", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'enc', ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, NULL, NULL, ${initiatingAgentId}, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', ${JSON.stringify(
        {
          schemaVersion: 1 as const,
          objective: 'Test',
          steps: [
            {
              stepKey: 'root-step',
              title: 'Root',
              description: 'Root',
              parentStepKey: null,
              childOrdinal: 0,
              nodeKind: 'root',
              dependencies: [],
              routing: { kind: 'direct' },
              toolAllowlist: [],
              expectedOutputs: [],
              completionCriteria: [],
              budgetCents: 5000,
            },
            {
              stepKey: 'child-1',
              title: 'Child',
              description: 'Child',
              parentStepKey: 'root-step',
              childOrdinal: 0,
              nodeKind: 'child',
              dependencies: ['root-step'],
              dependencyKinds: { 'root-step': 'required' },
              routing: {
                kind: 'requirements',
                routingRequirements: {
                  capabilities: ['research'],
                  requiredTools: ['research.search'],
                  requiredDomains: [],
                  ephemeralAllowed: true,
                },
              },
              toolAllowlist: ['research.search'],
              expectedOutputs: [],
              completionCriteria: [],
              budgetCents: 500,
            },
          ],
          synthesis: { strategy: 'concat' },
          partialResultPolicy: 'require_all',
          limits: { ...EMPTY_TOOL_POLICY_LIMITS, costCents: 5000 },
        },
      )}::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    const schema = db.schema;
    const materializer = new TopologyMaterializer(db, { clock: () => now });

    const plan = {
      schemaVersion: 1 as const,
      objective: 'Test',
      steps: [
        {
          stepKey: 'root-step',
          title: 'Root',
          description: 'Root',
          parentStepKey: null,
          childOrdinal: 0,
          nodeKind: 'root' as const,
          dependencies: [],
          routing: { kind: 'direct' as const },
          toolAllowlist: [],
          expectedOutputs: [],
          completionCriteria: [],
          budgetCents: 5000,
        },
        {
          stepKey: 'child-1',
          title: 'Child',
          description: 'Child',
          parentStepKey: 'root-step',
          childOrdinal: 0,
          nodeKind: 'child' as const,
          dependencies: ['root-step'],
          dependencyKinds: { 'root-step': 'required' },
          routing: {
            kind: 'requirements' as const,
            routingRequirements: {
              capabilities: ['research'],
              requiredTools: ['research.search'],
              requiredDomains: [],
              ephemeralAllowed: true,
            },
          },
          toolAllowlist: ['research.search'],
          expectedOutputs: [],
          completionCriteria: [],
          budgetCents: 500,
        },
      ],
      synthesis: { strategy: 'concat' as const },
      planningBudgetCents: 0,
      partialResultPolicy: 'require_all' as const,
      limits: { ...EMPTY_TOOL_POLICY_LIMITS, costCents: 5000 },
    } as unknown as PlanContent;

    await db.drizzle.transaction(async (tx) => {
      const [lockedRun] = await tx
        .select()
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, rootRunId))
        .for('update')
        .limit(1);

      await materializer.materialize(
        tx,
        lockedRun,
        plan,
        revisionId,
        hash,
        'system',
        null,
        null,
        undefined,
        // Pass the fallback: billingAgentId is null, so use initiatingAgentId
        lockedRun.billingAgentId ?? lockedRun.initiatingAgentId,
      );
    });

    // Verify the step assignment has a non-null billing_agent_id (from initiatingAgentId).
    const assignmentRows = (await db.drizzle.execute(sql`
      SELECT "billing_agent_id" FROM "run_step_assignments"
      WHERE "root_run_id" = ${rootRunId} AND "step_key" = 'child-1'
    `)) as unknown as Array<{ billing_agent_id: string }>;

    expect(assignmentRows.length).toBe(1);
    expect(assignmentRows[0].billing_agent_id).toBe(initiatingAgentId);
  });
});

// ---------------------------------------------------------------------------
// Bug 3: Company agent routing succeeds for agents with matching
// capabilities/tools when researchPolicy.access is 'allowed'
// ---------------------------------------------------------------------------

describe('Bug 3: Company agent routing with research tools + researchPolicy.access=allowed', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: AgentRouter;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ agent-routing-fix');
    router = new AgentRouter(db, { clock: () => new Date() });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('agent without research tools in toolsEnabled is selected when researchAccessAllowed is true', async () => {
    // Agent has 'research' capability but does NOT have 'research.search'
    // in toolsEnabled. The routing requirements ask for 'research.search'.
    // With researchAccessAllowed=true, the research tool check should pass.
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Research Agent',
      status: 'idle',
      capabilities: ['research'],
      toolsEnabled: [], // No research tools in toolsEnabled
      allowedDomains: ['example.com'],
      permissions: ['content.create'],
      executionTimeoutSeconds: 600,
    });

    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const stepKey = 'research-child';
    const now = new Date();
    const revisionId = randomUUID();
    const hash = randomUUID();
    const policySnapshotId = randomUUID();

    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "system_prompt_hash", "instruction_hash", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', 'h', 'h', '[]'::jsonb, ${JSON.stringify(['example.com'])}::jsonb, '{"access": "allowed"}'::jsonb, '{"strategy": "always"}'::jsonb, '{"strategy": "always"}'::jsonb, '{}'::jsonb, 'require_all', ${JSON.stringify(EMPTY_TOOL_POLICY_LIMITS)}::jsonb, ${randomUUID()}, ${now})
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'enc', ${hash}, 'Root', 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', NULL, NULL, ${agentId}, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', '{}'::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
      VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${rootRunId}, 1, 0, 'company_agent', 'enc-child', ${hash}, 'Child', 'deep_work', 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "parent_step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "routing_kind", "routing_requirements", "billing_agent_id", "created_at", "updated_at")
      VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${rootRunId}, ${childRunId}, ${stepKey}, NULL, 0, 'child', ${revisionId}, ${hash}, 'pending_routing', NULL, ${JSON.stringify(RESEARCH_REQS)}::jsonb, ${agentId}, ${now}, ${now})
    `);

    const reservationId = randomUUID();
    const allocationId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
      VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, ${agentId}, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
      VALUES (${allocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, ${agentId}, 5000, 0, 0, 'held', ${now}, ${now})
    `);

    const ctx: RoutingContext = {
      companyId: scope.companyId,
      projectId: scope.projectId,
      rootRunId,
      parentRunId: rootRunId,
      childRunId,
      stepKey,
      routingRequirements: RESEARCH_REQS,
      stepBudgetCents: 500,
      stepTimeoutSeconds: 300,
      billingAgentId: agentId,
      parentProvider: 'anthropic',
      researchAccessAllowed: true, // research is allowed by parent policy
    };

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(true);
    expect(decision.winnerAgentId).toBe(agentId);
    expect(decision.routingKind).toBe('company_agent');
  });

  it('agent without research tools is NOT selected when researchAccessAllowed is false', async () => {
    const agentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Research Agent',
      status: 'idle',
      capabilities: ['research'],
      toolsEnabled: [],
      allowedDomains: ['example.com'],
      permissions: ['content.create'],
      executionTimeoutSeconds: 600,
    });

    const rootRunId = randomUUID();
    const childRunId = randomUUID();
    const stepKey = 'research-child-no-access';
    const now = new Date();
    const revisionId = randomUUID();
    const hash = randomUUID();

    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "approved_plan_revision_id", "billing_agent_id", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'enc', ${hash}, 'Root', 'deep_work', 'running', 1, 0, 'require_all', NULL, NULL, ${agentId}, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
      VALUES (${revisionId}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, 1, 'approved', '{}'::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
      VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${rootRunId}, 1, 0, 'company_agent', 'enc-child', ${hash}, 'Child', 'deep_work', 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
    `);

    await db.drizzle.execute(sql`
      INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "parent_step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "routing_kind", "routing_requirements", "billing_agent_id", "created_at", "updated_at")
      VALUES (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${rootRunId}, ${rootRunId}, ${childRunId}, ${stepKey}, NULL, 0, 'child', ${revisionId}, ${hash}, 'pending_routing', NULL, ${JSON.stringify(RESEARCH_REQS)}::jsonb, ${agentId}, ${now}, ${now})
    `);

    const reservationId = randomUUID();
    const allocationId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "execution_earmark_cents", "period_key", "status", "created_at", "updated_at")
      VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, ${agentId}, 5000, 5000, 0, 0, 0, '2026-08', 'held', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
      VALUES (${allocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, ${agentId}, 5000, 0, 0, 'held', ${now}, ${now})
    `);

    const ctx: RoutingContext = {
      companyId: scope.companyId,
      projectId: scope.projectId,
      rootRunId,
      parentRunId: rootRunId,
      childRunId,
      stepKey,
      routingRequirements: RESEARCH_REQS,
      stepBudgetCents: 500,
      stepTimeoutSeconds: 300,
      billingAgentId: agentId,
      parentProvider: 'anthropic',
      researchAccessAllowed: false, // research is NOT allowed
    };

    const decision = await router.route(ctx);

    expect(decision.selected).toBe(false);
    expect(decision.reason).toBe('NO_ELIGIBLE_AGENT');
  });
});
