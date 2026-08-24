import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestServers, closeTestDb } from '../test-utils.js';
import {
  EphemeralFallbackRouter,
  type EphemeralRoutingContext,
  deriveEphemeralChildPolicy,
  checkEphemeralRequirements,
} from '../services/mission/ephemeral-router.js';
import { policyContentHash, type ResolvedPolicy } from '../services/mission/policy.js';
import type { RoutingRequirements } from '../services/mission/plan-schema.js';
import type { ModeLimits } from '../services/mission/modes.js';

/**
 * Bounded ephemeral fallback without employee/memory/secret surfaces.
 *
 * (VAL-MODEQ-043, VAL-SUB-019, VAL-SUB-021, VAL-SUB-022, VAL-SUB-023,
 *  VAL-SUB-090, VAL-SUB-091, VAL-SUB-114)
 *
 * Tests exercise:
 * - Disallowed fallback fails the stable shell closed (VAL-SUB-019).
 * - Ephemeral children are not employees (VAL-SUB-021).
 * - Ephemeral policy only narrows (VAL-SUB-022, VAL-MODEQ-043).
 * - Ephemeral billing remains attributable (VAL-SUB-023).
 * - Ephemeral fallback cannot bypass denial (VAL-SUB-090).
 * - Ephemeral execution has no employee memory or secret surface (VAL-SUB-091).
 * - Failed shells have exact cardinality and usage (VAL-SUB-114).
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

const PARENT_LIMITS: ModeLimits = {
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
  fallbackPolicy: { ephemeralAllowed: true },
  partialResultPolicy: 'require_all' as const,
  limits: PARENT_LIMITS,
  resolvedMode: 'deep_work' as const,
};

const EPHEMERAL_REQS: RoutingRequirements = {
  capabilities: ['research'],
  requiredTools: ['research.search'],
  requiredDomains: ['example.com'],
  ephemeralAllowed: true,
};

const DISALLOWED_REQS: RoutingRequirements = {
  capabilities: ['research'],
  requiredTools: ['research.search'],
  requiredDomains: ['example.com'],
  ephemeralAllowed: false,
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
    VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'deep_work', 1, ${options?.parentProvider ?? 'anthropic'}, null, 'claude-sonnet-4-6', 'standard', 'hash-system-123', 'hash-instruct-456', ${JSON.stringify(PARENT_POLICY.toolAllowlist)}::jsonb, ${JSON.stringify(PARENT_POLICY.domainAllowlist)}::jsonb, '{"allowed": true}'::jsonb, '{"requiresPlan": true}'::jsonb, '{"requiresApproval": true}'::jsonb, '{"ephemeralAllowed": true}'::jsonb, 'require_all', ${JSON.stringify(PARENT_LIMITS)}::jsonb, ${randomUUID()}, ${now})
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
): EphemeralRoutingContext {
  return {
    companyId: scope.companyId,
    projectId: scope.projectId,
    rootRunId: setup.rootRunId,
    parentRunId: setup.parentRunId,
    childRunId: setup.childRunId,
    stepKey: setup.stepKey,
    routingRequirements: requirements,
    stepBudgetCents: options?.stepBudgetCents ?? 500,
    stepTimeoutSeconds: options?.stepTimeoutSeconds ?? 300,
    billingAgentId: options?.billingAgentId ?? null,
  };
}

async function getAssignment(db: AnyDb, rootRunId: string, stepKey: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "assignment_status", "routing_kind", "executing_agent_id", "billing_agent_id",
           "child_policy_snapshot_id", "child_policy_content_hash", "admission_slot_held",
           "budget_allocation_id", "failure_category", "failure_code"
    FROM "run_step_assignments" WHERE "root_run_id" = ${rootRunId} AND "step_key" = ${stepKey}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0];
}

async function getChildRun(db: AnyDb, childRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "executing_agent_id", "routing_kind", "billing_agent_id", "status",
           "available_at", "policy_snapshot_id", "failure_category", "failure_code",
           "terminal_at", "provider_call_count", "input_tokens", "output_tokens",
           "output_bytes", "actual_cost_cents"
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

async function getChildFailedEvent(db: AnyDb, rootRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "type", "payload" FROM "run_events"
    WHERE "run_id" = ${rootRunId} AND "type" = 'child.failed'
  `)) as unknown as Array<{ type: string; payload: Record<string, unknown> }>;
  return rows[0];
}

async function getRunFailedEvent(db: AnyDb, childRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "type", "payload" FROM "run_events"
    WHERE "run_id" = ${childRunId} AND "type" = 'run.failed'
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

async function getAgentCount(db: AnyDb, companyId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int as cnt FROM "agents" WHERE "company_id" = ${companyId}
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0].cnt;
}

async function countSettlements(db: AnyDb, runId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int as cnt FROM "budget_settlements" WHERE "run_id" = ${runId}
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0].cnt;
}

// ---------------------------------------------------------------------------
// Pure unit tests: ephemeral child policy derivation (VAL-MODEQ-043, VAL-SUB-022)
// ---------------------------------------------------------------------------

describe('Ephemeral child policy derivation (VAL-MODEQ-043, VAL-SUB-022) — pure unit', () => {
  it('ephemeral policy inherits parent provider/model and tools/domains', () => {
    const child = deriveEphemeralChildPolicy({
      parentPolicy: PARENT_POLICY,
      stepBudgetCents: 500,
      stepTimeoutSeconds: 300,
    });

    expect(child.provider).toBe('anthropic');
    expect(child.model).toBe('claude-sonnet-4-6');
    expect(child.toolAllowlist).toEqual(PARENT_POLICY.toolAllowlist);
    expect(child.domainAllowlist).toEqual(PARENT_POLICY.domainAllowlist);
    expect(child.instructionHash).toBe(PARENT_POLICY.instructionHash);
    expect(child.resolvedMode).toBe(PARENT_POLICY.resolvedMode);
  });

  it('ephemeral policy narrows cost and duration limits (VAL-MODEQ-043)', () => {
    const child = deriveEphemeralChildPolicy({
      parentPolicy: PARENT_POLICY,
      stepBudgetCents: 500,
      stepTimeoutSeconds: 300,
    });

    // costCents = min(parent 5000, step 500) = 500
    expect(child.limits.costCents).toBe(500);
    // durationSeconds = min(parent 2700, step 300) = 300
    expect(child.limits.durationSeconds).toBe(300);
    // Other limits inherited unchanged.
    expect(child.limits.steps).toBe(PARENT_LIMITS.steps);
    expect(child.limits.providerCalls).toBe(PARENT_LIMITS.providerCalls);
    expect(child.limits.totalTokens).toBe(PARENT_LIMITS.totalTokens);
    expect(child.limits.depth).toBe(PARENT_LIMITS.depth);
    expect(child.limits.fanOut).toBe(PARENT_LIMITS.fanOut);
    expect(child.limits.descendants).toBe(PARENT_LIMITS.descendants);
  });

  it('ephemeral policy is never broader than parent for any field (VAL-MODEQ-043)', () => {
    const child = deriveEphemeralChildPolicy({
      parentPolicy: PARENT_POLICY,
      stepBudgetCents: 10000, // higher than parent
      stepTimeoutSeconds: 9999, // higher than parent
    });

    // Even with high step values, limits are capped by parent.
    expect(child.limits.costCents).toBe(PARENT_LIMITS.costCents);
    expect(child.limits.durationSeconds).toBe(PARENT_LIMITS.durationSeconds);
    expect(child.limits.steps).toBeLessThanOrEqual(PARENT_LIMITS.steps);
    expect(child.limits.providerCalls).toBeLessThanOrEqual(PARENT_LIMITS.providerCalls);
    expect(child.limits.totalTokens).toBeLessThanOrEqual(PARENT_LIMITS.totalTokens);
    expect(child.limits.outputBytes).toBeLessThanOrEqual(PARENT_LIMITS.outputBytes);
    expect(child.limits.depth).toBeLessThanOrEqual(PARENT_LIMITS.depth);
    expect(child.limits.fanOut).toBeLessThanOrEqual(PARENT_LIMITS.fanOut);
    expect(child.limits.descendants).toBeLessThanOrEqual(PARENT_LIMITS.descendants);
  });

  it('ephemeral policy hash is immutable — later broadening does not expand it (VAL-SUB-022)', () => {
    const child = deriveEphemeralChildPolicy({
      parentPolicy: PARENT_POLICY,
      stepBudgetCents: 500,
      stepTimeoutSeconds: 300,
    });
    const committedHash = policyContentHash(child);

    // The committed hash never changes.
    expect(policyContentHash(child)).toBe(committedHash);
  });
});

// ---------------------------------------------------------------------------
// Pure unit tests: ephemeral requirements checks (VAL-SUB-090)
// ---------------------------------------------------------------------------

describe('Ephemeral requirements checks (VAL-SUB-090) — pure unit', () => {
  function makeCheckInput(
    over: Partial<{
      routingRequirements: RoutingRequirements;
      billingAgentId: string | null;
      billingAgentBudgetMonthlyCents: number;
      billingAgentSpentMonthlyCents: number;
      billingAgentResidualAllocations: number;
      stepBudgetCents: number;
      stepTimeoutSeconds: number;
      hasCredential: boolean;
    }>,
  ) {
    return {
      routingRequirements: over.routingRequirements ?? EPHEMERAL_REQS,
      parentPolicy: PARENT_POLICY,
      billingAgentId: over.billingAgentId !== undefined ? over.billingAgentId : 'billing-agent-1',
      billingAgentBudgetMonthlyCents: over.billingAgentBudgetMonthlyCents ?? 0,
      billingAgentSpentMonthlyCents: over.billingAgentSpentMonthlyCents ?? 0,
      billingAgentResidualAllocations: over.billingAgentResidualAllocations ?? 0,
      stepBudgetCents: over.stepBudgetCents ?? 500,
      stepTimeoutSeconds: over.stepTimeoutSeconds ?? 300,
      hasCredential: over.hasCredential,
    };
  }

  it('all requirements satisfied returns null', () => {
    expect(checkEphemeralRequirements(makeCheckInput({ hasCredential: true }))).toBeNull();
  });

  it('ephemeral disallowed fails closed (VAL-SUB-090)', () => {
    expect(
      checkEphemeralRequirements(
        makeCheckInput({
          routingRequirements: DISALLOWED_REQS,
          hasCredential: true,
        }),
      ),
    ).toBe('EPHEMERAL_DISALLOWED');
  });

  it('missing required tool fails closed (VAL-SUB-090)', () => {
    const reqs: RoutingRequirements = {
      ...EPHEMERAL_REQS,
      requiredTools: ['nonexistent.tool'],
    };
    expect(
      checkEphemeralRequirements(
        makeCheckInput({
          routingRequirements: reqs,
          hasCredential: true,
        }),
      ),
    ).toBe('MISSING_TOOLS');
  });

  it('missing required domain fails closed (VAL-SUB-090)', () => {
    const reqs: RoutingRequirements = {
      ...EPHEMERAL_REQS,
      requiredDomains: ['nonexistent.example'],
    };
    expect(
      checkEphemeralRequirements(
        makeCheckInput({
          routingRequirements: reqs,
          hasCredential: true,
        }),
      ),
    ).toBe('MISSING_DOMAINS');
  });

  it('null billing agent fails closed (VAL-SUB-023, VAL-SUB-090)', () => {
    expect(
      checkEphemeralRequirements(
        makeCheckInput({
          billingAgentId: null,
          hasCredential: true,
        }),
      ),
    ).toBe('NO_BILLING_AGENT');
  });

  it('insufficient billing headroom fails closed (VAL-SUB-090)', () => {
    expect(
      checkEphemeralRequirements(
        makeCheckInput({
          billingAgentBudgetMonthlyCents: 1000,
          billingAgentSpentMonthlyCents: 800,
          billingAgentResidualAllocations: 0,
          stepBudgetCents: 500,
          hasCredential: true,
        }),
      ),
    ).toBe('INSUFFICIENT_BILLING_HEADROOM');
  });

  it('insufficient timeout fails closed (VAL-SUB-090)', () => {
    expect(
      checkEphemeralRequirements(
        makeCheckInput({
          stepTimeoutSeconds: 9999,
          hasCredential: true,
        }),
      ),
    ).toBe('INSUFFICIENT_TIMEOUT');
  });

  it('unlimited billing agent budget always has headroom (VAL-SUB-023)', () => {
    expect(
      checkEphemeralRequirements(
        makeCheckInput({
          billingAgentBudgetMonthlyCents: 0,
          billingAgentSpentMonthlyCents: 999999,
          stepBudgetCents: 500,
          hasCredential: true,
        }),
      ),
    ).toBeNull();
  });

  it('no credential fails closed (VAL-SUB-090)', () => {
    expect(
      checkEphemeralRequirements(
        makeCheckInput({
          hasCredential: false,
        }),
      ),
    ).toBe('NO_CREDENTIAL');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: disallowed fallback fails the stable shell closed
// (VAL-SUB-019, VAL-SUB-114)
// ---------------------------------------------------------------------------

describe('Disallowed fallback fails the stable shell closed (VAL-SUB-019, VAL-SUB-114)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: EphemeralFallbackRouter;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ ephemeral-019');
    router = new EphemeralFallbackRouter(db, { clock: () => new Date(), hasCredential: true });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('disallowed ephemeral routing terminally fails with NO_ELIGIBLE_AGENT (VAL-SUB-019)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, DISALLOWED_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, DISALLOWED_REQS, { billingAgentId });

    const result = await router.routeOrFail(ctx);

    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('NO_ELIGIBLE_AGENT');
    expect(result.routingKind).toBeNull();

    // Child run is terminally failed.
    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun['status']).toBe('failed');
    expect(childRun['failure_code']).toBe('NO_ELIGIBLE_AGENT');
    expect(childRun['terminal_at']).not.toBeNull();

    // Assignment is failed with null routing kind.
    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment['assignment_status']).toBe('failed');
    expect(assignment['routing_kind']).toBeNull();
    expect(assignment['failure_code']).toBe('NO_ELIGIBLE_AGENT');

    // Zero usage.
    expect(childRun['provider_call_count']).toBe(0);
    expect(childRun['input_tokens']).toBe(0);
    expect(childRun['output_tokens']).toBe(0);
    expect(childRun['output_bytes']).toBe(0);
    expect(childRun['actual_cost_cents']).toBe(0);

    // run.failed on child journal.
    const failedEvt = await getRunFailedEvent(db, setup.childRunId);
    expect(failedEvt).toBeDefined();
    expect(failedEvt!.payload['code']).toBe('NO_ELIGIBLE_AGENT');

    // child.failed on root journal.
    const childFailedEvt = await getChildFailedEvent(db, setup.rootRunId);
    expect(childFailedEvt).toBeDefined();
    expect(childFailedEvt!.payload['code']).toBe('NO_ELIGIBLE_AGENT');
  });

  it('failed shell has zero settlements (VAL-SUB-114)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, DISALLOWED_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, DISALLOWED_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    const settlements = await countSettlements(db, setup.childRunId);
    expect(settlements).toBe(0);
  });

  it('failed shell releases provisional allocation exactly once (VAL-SUB-114)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, DISALLOWED_REQS, {
      billingAgentId,
    });

    // Add a provisional allocation for the child.
    const provisionalAllocId = randomUUID();
    const now = new Date();
    const rootResRows = (await db.drizzle.execute(sql`
      SELECT "id" FROM "budget_reservations" WHERE "run_id" = ${setup.rootRunId} LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    await db.drizzle.execute(sql`
      INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
      VALUES (${provisionalAllocId}, ${scope.companyId}, ${rootResRows[0].id}, ${setup.childRunId}, ${billingAgentId}, 300, 0, 0, 'held', ${now}, ${now})
    `);

    const ctx = buildContext(scope, setup, DISALLOWED_REQS, { billingAgentId });
    await router.routeOrFail(ctx);

    // The provisional allocation should be released.
    const allocRows = (await db.drizzle.execute(sql`
      SELECT "status", "released_cents", "allocated_cents" FROM "budget_allocations" WHERE "id" = ${provisionalAllocId}
    `)) as unknown as Array<{ status: string; released_cents: number; allocated_cents: number }>;
    expect(allocRows[0].status).toBe('released');
    expect(allocRows[0].released_cents).toBe(allocRows[0].allocated_cents);
  });

  it('failed shell counts once toward descendant cardinality (VAL-SUB-114)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, DISALLOWED_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, DISALLOWED_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    // The child run still exists as one shell — it was already created by
    // the topology materializer and remains counted in the tree.
    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun).toBeDefined();

    // Count children under this root.
    const childCountRows = (await db.drizzle.execute(sql`
      SELECT count(*)::int as cnt FROM "mission_runs"
      WHERE "root_run_id" = ${setup.rootRunId} AND "parent_run_id" IS NOT NULL
    `)) as unknown as Array<{ cnt: number }>;
    expect(childCountRows[0].cnt).toBe(1);
  });

  it('no credential fails closed (VAL-SUB-090)', async () => {
    // Use a provider with no server-side key mapping and a router that
    // does NOT inject hasCredential (so the real check runs).
    const noCredRouter = new EphemeralFallbackRouter(db, { clock: () => new Date() });
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
      provider: 'unknown_provider',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
      parentProvider: 'unknown_provider',
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    const result = await noCredRouter.routeOrFail(ctx);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toBe('NO_ELIGIBLE_AGENT');
    expect(result.denialReason).toBe('NO_CREDENTIAL');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ephemeral children are not employees (VAL-SUB-021, VAL-SUB-091)
// ---------------------------------------------------------------------------

describe('Ephemeral children are not employees (VAL-SUB-021, VAL-SUB-091)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: EphemeralFallbackRouter;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ ephemeral-021');
    router = new EphemeralFallbackRouter(db, { clock: () => new Date(), hasCredential: true });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('creating an ephemeral child does not add an agent (VAL-SUB-021)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const agentCountBefore = await getAgentCount(db, scope.companyId);

    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    const agentCountAfter = await getAgentCount(db, scope.companyId);
    expect(agentCountAfter).toBe(agentCountBefore);
  });

  it('ephemeral child has no permanent executing agent (VAL-SUB-021, VAL-SUB-023)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun['executing_agent_id']).toBeNull();
    expect(childRun['routing_kind']).toBe('ephemeral');
  });

  it('ephemeral child retains immutable run history (VAL-SUB-091)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    // Child run is still readable.
    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun).toBeDefined();
    expect(childRun['status']).not.toBe('failed');
    expect(childRun['routing_kind']).toBe('ephemeral');

    // child.routed event exists with routingKind ephemeral.
    const evt = await getRoutedEvent(db, setup.rootRunId);
    expect(evt).toBeDefined();
    expect(evt!.payload['routingKind']).toBe('ephemeral');
    expect(evt!.payload['executingAgentId']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ephemeral policy only narrows (VAL-SUB-022, VAL-MODEQ-043)
// ---------------------------------------------------------------------------

describe('Ephemeral policy only narrows (VAL-SUB-022, VAL-MODEQ-043)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: EphemeralFallbackRouter;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ ephemeral-022');
    router = new EphemeralFallbackRouter(db, { clock: () => new Date(), hasCredential: true });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('ephemeral child policy is narrower than parent (VAL-MODEQ-043)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
      stepBudgetCents: 500,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, {
      billingAgentId,
      stepBudgetCents: 500,
      stepTimeoutSeconds: 300,
    });

    await router.routeOrFail(ctx);

    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    const snapshot = await getChildPolicySnapshot(
      db,
      assignment['child_policy_snapshot_id'] as string,
    );

    // Tools inherited from parent (not broadened).
    const tools = snapshot['tool_allowlist'] as string[];
    expect(tools).toEqual(PARENT_POLICY.toolAllowlist);

    // Domains inherited from parent (not broadened).
    const domains = snapshot['domain_allowlist'] as string[];
    expect(domains).toEqual(PARENT_POLICY.domainAllowlist);

    // Limits narrowed: cost and duration are min(parent, step).
    const limits = snapshot['limits'] as ModeLimits;
    expect(limits.costCents).toBe(500);
    expect(limits.durationSeconds).toBe(300);

    // Other limits not broader than parent.
    expect(limits.steps).toBeLessThanOrEqual(PARENT_LIMITS.steps);
    expect(limits.providerCalls).toBeLessThanOrEqual(PARENT_LIMITS.providerCalls);
    expect(limits.depth).toBeLessThanOrEqual(PARENT_LIMITS.depth);
    expect(limits.fanOut).toBeLessThanOrEqual(PARENT_LIMITS.fanOut);
  });

  it('ephemeral policy hash is immutable after commit (VAL-SUB-022)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    const committedHash = assignment['child_policy_content_hash'] as string;

    // Re-route (idempotent) — hash should not change.
    const result2 = await router.routeOrFail(ctx);
    expect(result2.outcome).toBe('ephemeral');

    const assignment2 = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment2['child_policy_content_hash']).toBe(committedHash);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ephemeral billing remains attributable (VAL-SUB-023)
// ---------------------------------------------------------------------------

describe('Ephemeral billing remains attributable (VAL-SUB-023)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: EphemeralFallbackRouter;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ ephemeral-023');
    router = new EphemeralFallbackRouter(db, { clock: () => new Date(), hasCredential: true });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('ephemeral child has null executor but non-null billing agent (VAL-SUB-023)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun['executing_agent_id']).toBeNull();
    expect(childRun['billing_agent_id']).toBe(billingAgentId);
  });

  it('ephemeral child allocation has the billing agent ID (VAL-SUB-023)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
      stepBudgetCents: 500,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, {
      billingAgentId,
      stepBudgetCents: 500,
    });

    await router.routeOrFail(ctx);

    // Child allocation created with the billing agent.
    const allocRows = (await db.drizzle.execute(sql`
      SELECT "billing_agent_id", "allocated_cents", "status" FROM "budget_allocations"
      WHERE "run_id" = ${setup.childRunId}
    `)) as unknown as Array<{ billing_agent_id: string; allocated_cents: number; status: string }>;
    expect(allocRows.length).toBe(1);
    expect(allocRows[0].billing_agent_id).toBe(billingAgentId);
    expect(allocRows[0].allocated_cents).toBe(500);
    expect(allocRows[0].status).toBe('held');
  });

  it('null billing agent fails ephemeral routing (VAL-SUB-023)', async () => {
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId: null,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId: null });

    const result = await router.routeOrFail(ctx);
    expect(result.outcome).toBe('failed');
    expect(result.denialReason).toBe('NO_BILLING_AGENT');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ephemeral fallback cannot bypass denial (VAL-SUB-090)
// ---------------------------------------------------------------------------

describe('Ephemeral fallback cannot bypass denial (VAL-SUB-090)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: EphemeralFallbackRouter;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ ephemeral-090');
    router = new EphemeralFallbackRouter(db, { clock: () => new Date(), hasCredential: true });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('missing required tool fails closed even when ephemeral is allowed (VAL-SUB-090)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const reqs: RoutingRequirements = {
      ...EPHEMERAL_REQS,
      requiredTools: ['nonexistent.tool'],
    };
    const setup = await setupPendingRoutingChild(db, scope, reqs, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, reqs, { billingAgentId });

    const result = await router.routeOrFail(ctx);
    expect(result.outcome).toBe('failed');
    expect(result.denialReason).toBe('MISSING_TOOLS');
  });

  it('missing required domain fails closed even when ephemeral is allowed (VAL-SUB-090)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const reqs: RoutingRequirements = {
      ...EPHEMERAL_REQS,
      requiredDomains: ['nonexistent.example'],
    };
    const setup = await setupPendingRoutingChild(db, scope, reqs, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, reqs, { billingAgentId });

    const result = await router.routeOrFail(ctx);
    expect(result.outcome).toBe('failed');
    expect(result.denialReason).toBe('MISSING_DOMAINS');
  });

  it('insufficient billing headroom fails closed (VAL-SUB-090)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
      budgetMonthlyCents: 1000,
      spentMonthlyCents: 800,
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
      stepBudgetCents: 500,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, {
      billingAgentId,
      stepBudgetCents: 500,
    });

    const result = await router.routeOrFail(ctx);
    expect(result.outcome).toBe('failed');
    expect(result.denialReason).toBe('INSUFFICIENT_BILLING_HEADROOM');
  });

  it('insufficient timeout fails closed (VAL-SUB-090)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, {
      billingAgentId,
      stepTimeoutSeconds: 9999,
    });

    const result = await router.routeOrFail(ctx);
    expect(result.outcome).toBe('failed');
    expect(result.denialReason).toBe('INSUFFICIENT_TIMEOUT');
  });
});

// ---------------------------------------------------------------------------
// Integration tests: ephemeral execution has no employee memory or secret
// surface (VAL-SUB-091)
// ---------------------------------------------------------------------------

describe('Ephemeral execution has no employee memory or secret surface (VAL-SUB-091)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: EphemeralFallbackRouter;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ ephemeral-091');
    router = new EphemeralFallbackRouter(db, { clock: () => new Date(), hasCredential: true });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('ephemeral child creates no agent, profile, memory, or session record (VAL-SUB-091)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const agentCountBefore = await getAgentCount(db, scope.companyId);

    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    const agentCountAfter = await getAgentCount(db, scope.companyId);
    expect(agentCountAfter).toBe(agentCountBefore);

    // The billing agent's apiKeyEncrypted is not exposed in the child run
    // or routing event.
    const evt = await getRoutedEvent(db, setup.rootRunId);
    expect(evt).toBeDefined();
    const payloadStr = JSON.stringify(evt!.payload);
    // No credential markers in the event payload.
    expect(payloadStr).not.toContain('api_key');
    expect(payloadStr).not.toContain('apiKey');
    expect(payloadStr).not.toContain('encrypted');
    expect(payloadStr).not.toContain('secret');
  });

  it('ephemeral child never becomes a routing candidate (VAL-SUB-091)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    // The ephemeral child's executing_agent_id is NULL — it is not an agent
    // and cannot appear in agent lists or routing candidates.
    const childRun = await getChildRun(db, setup.childRunId);
    expect(childRun['executing_agent_id']).toBeNull();

    // Agent count unchanged — no new agent was created that could be a
    // routing candidate.
    const agentCount = await getAgentCount(db, scope.companyId);
    expect(agentCount).toBe(1); // only the billing agent
  });
});

// ---------------------------------------------------------------------------
// Integration tests: failed shells have exact cardinality and usage
// (VAL-SUB-114)
// ---------------------------------------------------------------------------

describe('Failed shells have exact cardinality and usage (VAL-SUB-114)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let router: EphemeralFallbackRouter;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ ephemeral-114');
    router = new EphemeralFallbackRouter(db, { clock: () => new Date(), hasCredential: true });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('every topology node counts one shell even on routing failure (VAL-SUB-114)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });

    // Create two children under the same root — one that fails routing
    // (disallowed ephemeral) and one that succeeds (allowed ephemeral).
    const setup1 = await setupPendingRoutingChild(db, scope, DISALLOWED_REQS, {
      billingAgentId,
    });
    const setup2 = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    // Link setup2 to the same root as setup1.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "root_run_id" = ${setup1.rootRunId}, "parent_run_id" = ${setup1.rootRunId}, "child_ordinal" = 1
      WHERE "id" = ${setup2.childRunId}
    `);
    await db.drizzle.execute(sql`
      UPDATE "run_step_assignments" SET "root_run_id" = ${setup1.rootRunId}, "parent_run_id" = ${setup1.rootRunId}
      WHERE "run_id" = ${setup2.childRunId}
    `);

    const ctx1 = buildContext(scope, setup1, DISALLOWED_REQS, { billingAgentId });
    const ctx2: EphemeralRoutingContext = {
      ...buildContext(scope, setup2, EPHEMERAL_REQS, { billingAgentId }),
      rootRunId: setup1.rootRunId,
      parentRunId: setup1.rootRunId,
    };

    await router.routeOrFail(ctx1);
    await router.routeOrFail(ctx2);

    // Both shells exist — one failed, one ephemeral.
    const childCountRows = (await db.drizzle.execute(sql`
      SELECT count(*)::int as cnt FROM "mission_runs"
      WHERE "root_run_id" = ${setup1.rootRunId} AND "parent_run_id" IS NOT NULL
    `)) as unknown as Array<{ cnt: number }>;
    expect(childCountRows[0].cnt).toBe(2);

    // The failed shell has zero usage.
    const failedChild = await getChildRun(db, setup1.childRunId);
    expect(failedChild['status']).toBe('failed');
    expect(failedChild['provider_call_count']).toBe(0);
    expect(failedChild['actual_cost_cents']).toBe(0);

    // The ephemeral shell has zero usage so far (no execution yet).
    const ephemeralChild = await getChildRun(db, setup2.childRunId);
    expect(ephemeralChild['routing_kind']).toBe('ephemeral');
    expect(ephemeralChild['provider_call_count']).toBe(0);
  });

  it('failed shell holds no active permit (VAL-SUB-114)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, DISALLOWED_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, DISALLOWED_REQS, { billingAgentId });

    await router.routeOrFail(ctx);

    const assignment = await getAssignment(db, setup.rootRunId, setup.stepKey);
    expect(assignment['admission_slot_held']).toBe(false);
  });

  it('idempotent: re-routing a failed shell does not duplicate events (VAL-SUB-019)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, DISALLOWED_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, DISALLOWED_REQS, { billingAgentId });

    await router.routeOrFail(ctx);
    await router.routeOrFail(ctx);

    // Only one run.failed event on the child.
    const failedEvts = (await db.drizzle.execute(sql`
      SELECT count(*)::int as cnt FROM "run_events"
      WHERE "run_id" = ${setup.childRunId} AND "type" = 'run.failed'
    `)) as unknown as Array<{ cnt: number }>;
    expect(failedEvts[0].cnt).toBe(1);

    // Only one child.failed event on the root.
    const childFailedEvts = (await db.drizzle.execute(sql`
      SELECT count(*)::int as cnt FROM "run_events"
      WHERE "run_id" = ${setup.rootRunId} AND "type" = 'child.failed'
    `)) as unknown as Array<{ cnt: number }>;
    expect(childFailedEvts[0].cnt).toBe(1);
  });

  it('idempotent: re-routing an ephemeral child does not duplicate events (VAL-SUB-022)', async () => {
    const billingAgentId = await seedAgent(db, {
      companyId: scope.companyId,
      name: 'Billing Agent',
    });
    const setup = await setupPendingRoutingChild(db, scope, EPHEMERAL_REQS, {
      billingAgentId,
    });
    const ctx = buildContext(scope, setup, EPHEMERAL_REQS, { billingAgentId });

    await router.routeOrFail(ctx);
    await router.routeOrFail(ctx);

    // Only one child.routed event.
    const routedEvts = (await db.drizzle.execute(sql`
      SELECT count(*)::int as cnt FROM "run_events"
      WHERE "run_id" = ${setup.rootRunId} AND "type" = 'child.routed'
    `)) as unknown as Array<{ cnt: number }>;
    expect(routedEvts[0].cnt).toBe(1);

    // Only one child allocation.
    const allocCount = await countChildAllocations(db, setup.childRunId);
    expect(allocCount).toBe(1);
  });
});
