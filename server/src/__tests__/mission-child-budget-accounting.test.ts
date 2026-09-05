import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { BudgetService } from '../services/mission/budget.js';
import { MissionCancellationService } from '../services/mission/cancellation.js';
import { MissionCompletionService } from '../services/mission/completion.js';
import { encryptEnvelope } from '../services/mission/ingress.js';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../providers/types.js';
import { RunProcessor, type ProviderCallFn } from '../services/mission/run-processor.js';
import type { Claim } from '../services/mission/coordinator.js';

/**
 * Child budget accounting: allocate and settle child budgets under one root
 * hold.
 *
 * (VAL-SUB-038, VAL-SUB-071, VAL-SUB-072)
 *
 * All tests use real Postgres on 127.0.0.1:55322. No mocks for persistence.
 *
 * VAL-SUB-038: Mission budget bounds the tree — root and descendant charges
 *   plus reserved in-flight amounts never exceed the finite effective Mission
 *   ceiling.
 * VAL-SUB-071: Child allocation avoids double reservation — allocating budget
 *   to children reduces the root's unallocated residual without creating an
 *   additional company-level hold, and aggregate visible totals do not double
 *   count allocations.
 * VAL-SUB-072: Known cancelled charges remain visible — if a remote call
 *   incurs a known charge before cancellation is observed, that charge still
 *   settles and appears in child/root cost history while its discarded result
 *   remains absent.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

async function seedScope(
  db: AnyDb,
  label: string,
  opts: { companyBudget?: number; companySpent?: number } = {},
) {
  const companyId = randomUUID();
  const now = new Date();
  const companyBudget = opts.companyBudget ?? 100000;
  const companySpent = opts.companySpent ?? 0;
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', ${companyBudget}, ${companySpent}, '{"testFixture": true}'::jsonb, ${now}, ${now})
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
  companyId: string,
  opts: { budget?: number; spent?: number } = {},
): Promise<string> {
  const agentId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "created_at", "updated_at")
    VALUES (${agentId}, ${companyId}, 'A', 'engineer', 'anthropic', 'claude-sonnet-4-6', 'idle', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '["content.create"]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 5, 0, 600, 0, ${opts.budget ?? 0}, ${opts.spent ?? 0}, ${now}, ${now})
  `);
  return agentId;
}

/**
 * Insert a root mission_run with a root budget reservation + allocation.
 * Returns the IDs needed for child allocation tests.
 */
async function seedRootRun(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  opts: {
    reservedCents?: number;
    requestedCents?: number;
    billingAgentId?: string | null;
    status?: string;
  } = {},
): Promise<{ rootRunId: string; reservationId: string; rootAllocationId: string }> {
  const rootRunId = randomUUID();
  const reservationId = randomUUID();
  const rootAllocationId = randomUUID();
  const now = new Date();
  const reserved = opts.reservedCents ?? 5000;
  const requested = opts.requestedCents ?? reserved;
  const status = opts.status ?? 'running';

  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "billing_agent_id", "created_at", "updated_at")
    VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'enc', 'hash', 'Root', 'deep_work', ${status}, 1, 0, 'require_all', NULL, ${opts.billingAgentId ?? null}, ${now}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, ${opts.billingAgentId ?? null}, ${requested}, ${reserved}, 0, 0, '2026-08', 'held', ${now}, ${now})
  `);

  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${rootAllocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, ${opts.billingAgentId ?? null}, ${reserved}, 0, 0, 'held', ${now}, ${now})
  `);

  return { rootRunId, reservationId, rootAllocationId };
}

/**
 * Insert a child mission_run (no reservation — children get allocations
 * from the root hold).
 */
async function seedChildRun(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  rootRunId: string,
  opts: { status?: string; depth?: number; childOrdinal?: number } = {},
): Promise<string> {
  const childRunId = randomUUID();
  const now = new Date();
  const ordinal = opts.childOrdinal ?? Math.floor(Math.random() * 100000);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
    VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${rootRunId}, ${opts.depth ?? 1}, ${ordinal}, 'company_agent', 'enc-child', 'hash', 'Child', 'deep_work', ${opts.status ?? 'queued'}, 1, 0, 'require_all', ${now}, ${now}, ${now})
  `);
  return childRunId;
}

async function getCompanySpend(db: AnyDb, companyId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "spent_monthly_cents" AS "spent" FROM "companies" WHERE "id" = ${companyId}
  `)) as unknown as { spent: number }[];
  return row.spent;
}

async function getAgentSpend(db: AnyDb, agentId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "spent_monthly_cents" AS "spent" FROM "agents" WHERE "id" = ${agentId}
  `)) as unknown as { spent: number }[];
  return row.spent;
}

async function getReservation(db: AnyDb, runId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "reserved_cents" AS "reserved", "settled_cents" AS "settled",
           "released_cents" AS "released", "status", "requested_cents" AS "requested"
    FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return row
    ? {
        reserved: row.reserved as number,
        settled: row.settled as number,
        released: row.released as number,
        status: row.status as string,
        requested: row.requested as number,
      }
    : null;
}

async function getAllocation(db: AnyDb, runId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "allocated_cents" AS "allocated", "settled_cents" AS "settled",
           "released_cents" AS "released", "status"
    FROM "budget_allocations" WHERE "run_id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return row
    ? {
        allocated: row.allocated as number,
        settled: row.settled as number,
        released: row.released as number,
        status: row.status as string,
      }
    : null;
}

async function countReservations(db: AnyDb, companyId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "budget_reservations" WHERE "company_id" = ${companyId}
  `)) as unknown as { c: number }[];
  return row.c;
}

async function countAllocations(db: AnyDb, rootReservationId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "budget_allocations" WHERE "root_reservation_id" = ${rootReservationId}
  `)) as unknown as { c: number }[];
  return row.c;
}

async function sumChildAllocations(db: AnyDb, rootReservationId: string, rootRunId: string) {
  const [row] = (await db.drizzle.execute(sql`
    SELECT
      coalesce(sum("allocated_cents"), 0)::int AS "total_allocated",
      coalesce(sum("settled_cents"), 0)::int AS "total_settled",
      coalesce(sum("released_cents"), 0)::int AS "total_released",
      count(*)::int AS "count"
    FROM "budget_allocations"
    WHERE "root_reservation_id" = ${rootReservationId} AND "run_id" != ${rootRunId}
  `)) as unknown as Record<string, number>[];
  return row;
}

async function countSettlements(db: AnyDb, runId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "budget_settlements" WHERE "run_id" = ${runId}
  `)) as unknown as { c: number }[];
  return row.c;
}

async function countCostEvents(db: AnyDb, companyId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "cost_events" WHERE "company_id" = ${companyId}
  `)) as unknown as { c: number }[];
  return row.c;
}

async function getEventsByType(db: AnyDb, runId: string, type: string) {
  return (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload" FROM "run_events"
    WHERE "run_id" = ${runId} AND "type" = ${type}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{ sequence: number; type: string; payload: Record<string, unknown> }>;
}

async function getRunStatus(db: AnyDb, runId: string): Promise<string> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT "status" FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as { status: string }[];
  return row.status;
}

// ---------------------------------------------------------------------------
// VAL-SUB-071: Child allocation avoids double reservation
// ---------------------------------------------------------------------------

describe('VAL-SUB-071: Child allocation avoids double reservation', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await closeTestDb();
  });

  it('creates child allocation within the root hold without a new company reservation', async () => {
    const scope = await seedScope(db, 'double-reservation-co');
    const { rootRunId, reservationId } = await seedRootRun(db, scope, { reservedCents: 5000 });
    const childRunId = await seedChildRun(db, scope, rootRunId);
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    const reservationsBefore = await countReservations(db, scope.companyId);

    await db.drizzle.transaction(async (tx) => {
      await budgetService.allocateChild(tx, {
        companyId: scope.companyId,
        rootReservationId: reservationId,
        runId: childRunId,
        billingAgentId: null,
        allocatedCents: 1000,
        projectId: scope.projectId,
        stepKey: 'step-a',
      });
    });

    // Exactly one reservation (the root hold) — no new company-level hold.
    const reservationsAfter = await countReservations(db, scope.companyId);
    expect(reservationsAfter).toBe(reservationsBefore);

    // One root allocation + one child allocation = 2 allocations on the root.
    const allocations = await countAllocations(db, reservationId);
    expect(allocations).toBe(2);

    // The child allocation is within the root hold.
    const childAlloc = await getAllocation(db, childRunId);
    expect(childAlloc).not.toBeNull();
    expect(childAlloc!.allocated).toBe(1000);
    expect(childAlloc!.status).toBe('held');
  });

  it('multiple child allocations reduce the root residual without double-counting', async () => {
    const scope = await seedScope(db, 'multi-alloc-co');
    const { rootRunId, reservationId } = await seedRootRun(db, scope, { reservedCents: 5000 });
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    const childRun1 = await seedChildRun(db, scope, rootRunId);
    const childRun2 = await seedChildRun(db, scope, rootRunId);
    const childRun3 = await seedChildRun(db, scope, rootRunId);

    // Allocate 1000 + 1500 + 2000 = 4500 to three children.
    for (const [child, amount, step] of [
      [childRun1, 1000, 'step-a'],
      [childRun2, 1500, 'step-b'],
      [childRun3, 2000, 'step-c'],
    ] as const) {
      await db.drizzle.transaction(async (tx) => {
        await budgetService.allocateChild(tx, {
          companyId: scope.companyId,
          rootReservationId: reservationId,
          runId: child,
          billingAgentId: null,
          allocatedCents: amount,
          projectId: scope.projectId,
          stepKey: step,
        });
      });
    }

    // Root residual = 5000 - 4500 = 500 (root has 0 settled/released).
    const childSums = await sumChildAllocations(db, reservationId, rootRunId);
    expect(childSums.total_allocated).toBe(4500);
    expect(childSums.count).toBe(3);

    // Company spend unchanged — allocations do not spend.
    const spend = await getCompanySpend(db, scope.companyId);
    expect(spend).toBe(0);

    // Only one reservation for the company.
    expect(await countReservations(db, scope.companyId)).toBe(1);
  });

  it('rejects child allocation exceeding the root unallocated residual', async () => {
    const scope = await seedScope(db, 'exceed-residual-co');
    const { rootRunId, reservationId } = await seedRootRun(db, scope, { reservedCents: 1000 });
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    const childRun1 = await seedChildRun(db, scope, rootRunId);
    const childRun2 = await seedChildRun(db, scope, rootRunId);

    // First child takes 800 — residual is 200.
    await db.drizzle.transaction(async (tx) => {
      await budgetService.allocateChild(tx, {
        companyId: scope.companyId,
        rootReservationId: reservationId,
        runId: childRun1,
        billingAgentId: null,
        allocatedCents: 800,
        projectId: scope.projectId,
        stepKey: 'step-a',
      });
    });

    // Second child requests 300 — exceeds residual 200.
    await expect(
      db.drizzle.transaction(async (tx) => {
        await budgetService.allocateChild(tx, {
          companyId: scope.companyId,
          rootReservationId: reservationId,
          runId: childRun2,
          billingAgentId: null,
          allocatedCents: 300,
          projectId: scope.projectId,
          stepKey: 'step-b',
        });
      }),
    ).rejects.toThrow(/exceeds unallocated root residual/);

    // Second child has no allocation.
    const child2Alloc = await getAllocation(db, childRun2);
    expect(child2Alloc).toBeNull();

    // Only one child allocation was created.
    const allocations = await countAllocations(db, reservationId);
    expect(allocations).toBe(2); // root + one child
  });

  it('concurrent child allocations near the residual boundary admit only capacity that exists', async () => {
    const scope = await seedScope(db, 'concurrent-alloc-co');
    const { rootRunId, reservationId } = await seedRootRun(db, scope, { reservedCents: 1000 });
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    // Two children each request 800 but only 1000 is available.
    // Only one should succeed; the other should get BUDGET_UNAVAILABLE.
    const childRun1 = await seedChildRun(db, scope, rootRunId);
    const childRun2 = await seedChildRun(db, scope, rootRunId);

    const results = await Promise.allSettled([
      db.drizzle.transaction(async (tx) => {
        await budgetService.allocateChild(tx, {
          companyId: scope.companyId,
          rootReservationId: reservationId,
          runId: childRun1,
          billingAgentId: null,
          allocatedCents: 800,
          projectId: scope.projectId,
          stepKey: 'step-a',
        });
      }),
      db.drizzle.transaction(async (tx) => {
        await budgetService.allocateChild(tx, {
          companyId: scope.companyId,
          rootReservationId: reservationId,
          runId: childRun2,
          billingAgentId: null,
          allocatedCents: 800,
          projectId: scope.projectId,
          stepKey: 'step-b',
        });
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Total child allocations must not exceed the root hold.
    const childSums = await sumChildAllocations(db, reservationId, rootRunId);
    expect(childSums.total_allocated).toBeLessThanOrEqual(1000);
    expect(childSums.total_allocated).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// VAL-SUB-038: Mission budget bounds the tree
// ---------------------------------------------------------------------------

describe('VAL-SUB-038: Mission budget bounds the tree', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await closeTestDb();
  });

  it('root and descendant charges plus in-flight allocations never exceed the ceiling', async () => {
    const scope = await seedScope(db, 'ceiling-co');
    const CEILING = 5000;
    const { rootRunId, reservationId } = await seedRootRun(db, scope, { reservedCents: CEILING });
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    // Allocate 2000 to child A, 2000 to child B. Total allocated = 4000.
    const childA = await seedChildRun(db, scope, rootRunId);
    const childB = await seedChildRun(db, scope, rootRunId);

    for (const [child, amount, step] of [
      [childA, 2000, 'step-a'],
      [childB, 2000, 'step-b'],
    ] as const) {
      await db.drizzle.transaction(async (tx) => {
        await budgetService.allocateChild(tx, {
          companyId: scope.companyId,
          rootReservationId: reservationId,
          runId: child,
          billingAgentId: null,
          allocatedCents: amount,
          projectId: scope.projectId,
          stepKey: step,
        });
      });
    }

    // Settle 1500 on child A (known charge).
    await db.drizzle.transaction(async (tx) => {
      await budgetService.settle(tx, {
        companyId: scope.companyId,
        runId: childA,
        billingAgentId: null,
        externalCallId: `call-${childA}-1`,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        operation: 'chat',
        inputTokens: 1000,
        outputTokens: 500,
        costCents: 1500,
      });
    });

    // Remaining residual = 5000 - 4000 = 1000. Try to allocate 1500 → reject.
    const childC = await seedChildRun(db, scope, rootRunId);
    await expect(
      db.drizzle.transaction(async (tx) => {
        await budgetService.allocateChild(tx, {
          companyId: scope.companyId,
          rootReservationId: reservationId,
          runId: childC,
          billingAgentId: null,
          allocatedCents: 1500,
          projectId: scope.projectId,
          stepKey: 'step-c',
        });
      }),
    ).rejects.toThrow(/exceeds unallocated root residual/);

    // Final totals: settled (1500) + in-flight allocations (4000 allocated
    // across children, minus 1500 settled on childA = 2500 still in-flight)
    // + root allocation (5000) — but the invariant is: total allocations
    // under the root cannot exceed the root hold (5000).
    const childSums = await sumChildAllocations(db, reservationId, rootRunId);
    expect(childSums.total_allocated).toBe(4000);
    expect(childSums.total_settled).toBe(1500);

    // Root reservation settled = 1500 (settled propagates up).
    const rootRes = await getReservation(db, rootRunId);
    expect(rootRes!.settled).toBe(1500);
    expect(rootRes!.reserved).toBe(CEILING);

    // Company spend increased by the settled amount only.
    const spend = await getCompanySpend(db, scope.companyId);
    expect(spend).toBe(1500);
  });

  it('emits budget.allocated event on the root journal when a child is allocated', async () => {
    const scope = await seedScope(db, 'alloc-event-co');
    const { rootRunId, reservationId } = await seedRootRun(db, scope, { reservedCents: 5000 });
    const childRunId = await seedChildRun(db, scope, rootRunId);
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    await db.drizzle.transaction(async (tx) => {
      await budgetService.allocateChild(tx, {
        companyId: scope.companyId,
        rootReservationId: reservationId,
        runId: childRunId,
        billingAgentId: null,
        allocatedCents: 1000,
        projectId: scope.projectId,
        stepKey: 'step-a',
      });
    });

    const events = await getEventsByType(db, rootRunId, 'budget.allocated');
    expect(events.length).toBe(1);
    expect(events[0].payload).toMatchObject({
      childRunId,
      allocatedCents: 1000,
      stepKey: 'step-a',
    });
  });

  it('emits budget.exhausted event when the root residual is fully allocated', async () => {
    const scope = await seedScope(db, 'exhausted-co');
    const { rootRunId, reservationId } = await seedRootRun(db, scope, { reservedCents: 2000 });
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    const childA = await seedChildRun(db, scope, rootRunId);
    const childB = await seedChildRun(db, scope, rootRunId);

    // Allocate 1500 — residual is 500, not exhausted.
    await db.drizzle.transaction(async (tx) => {
      await budgetService.allocateChild(tx, {
        companyId: scope.companyId,
        rootReservationId: reservationId,
        runId: childA,
        billingAgentId: null,
        allocatedCents: 1500,
        projectId: scope.projectId,
        stepKey: 'step-a',
      });
    });

    let exhaustedEvents = await getEventsByType(db, rootRunId, 'budget.exhausted');
    expect(exhaustedEvents.length).toBe(0);

    // Allocate the remaining 500 — residual is now 0, exhausted.
    await db.drizzle.transaction(async (tx) => {
      await budgetService.allocateChild(tx, {
        companyId: scope.companyId,
        rootReservationId: reservationId,
        runId: childB,
        billingAgentId: null,
        allocatedCents: 500,
        projectId: scope.projectId,
        stepKey: 'step-b',
      });
    });

    exhaustedEvents = await getEventsByType(db, rootRunId, 'budget.exhausted');
    expect(exhaustedEvents.length).toBe(1);
    expect(exhaustedEvents[0].payload).toMatchObject({
      reservedCents: 2000,
      totalAllocatedCents: 2000,
    });
  });

  it('settlement is bounded by the child allocation and propagates to the root', async () => {
    const scope = await seedScope(db, 'settle-bound-co');
    const billingAgentId = await seedAgent(db, scope.companyId);
    const { rootRunId, reservationId } = await seedRootRun(db, scope, {
      reservedCents: 3000,
      billingAgentId,
    });
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    const childRun = await seedChildRun(db, scope, rootRunId);

    await db.drizzle.transaction(async (tx) => {
      await budgetService.allocateChild(tx, {
        companyId: scope.companyId,
        rootReservationId: reservationId,
        runId: childRun,
        billingAgentId,
        allocatedCents: 1000,
        projectId: scope.projectId,
        stepKey: 'step-a',
      });
    });

    // Settle 1200 — exceeds the 1000 allocation → BUDGET_EXHAUSTED.
    await expect(
      db.drizzle.transaction(async (tx) => {
        await budgetService.settle(tx, {
          companyId: scope.companyId,
          runId: childRun,
          billingAgentId,
          externalCallId: `call-${childRun}-over`,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          operation: 'chat',
          costCents: 1200,
        });
      }),
    ).rejects.toThrow(/Settlement exceeds remaining allocation/);

    // Settle 1000 — exactly the allocation.
    await db.drizzle.transaction(async (tx) => {
      await budgetService.settle(tx, {
        companyId: scope.companyId,
        runId: childRun,
        billingAgentId,
        externalCallId: `call-${childRun}-exact`,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        operation: 'chat',
        costCents: 1000,
      });
    });

    // Root reservation settled = 1000.
    const rootRes = await getReservation(db, rootRunId);
    expect(rootRes!.settled).toBe(1000);

    // Company and agent spend increased by 1000.
    expect(await getCompanySpend(db, scope.companyId)).toBe(1000);
    expect(await getAgentSpend(db, billingAgentId)).toBe(1000);

    // One settlement, one cost_event.
    expect(await countSettlements(db, childRun)).toBe(1);
    expect(await countCostEvents(db, scope.companyId)).toBe(1);
  });

  it('releasing a child terminal releases its unconsumed allocation back to the root', async () => {
    const scope = await seedScope(db, 'release-co');
    const { rootRunId, reservationId } = await seedRootRun(db, scope, { reservedCents: 5000 });
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    const childRun = await seedChildRun(db, scope, rootRunId);

    // Allocate 2000 to the child.
    await db.drizzle.transaction(async (tx) => {
      await budgetService.allocateChild(tx, {
        companyId: scope.companyId,
        rootReservationId: reservationId,
        runId: childRun,
        billingAgentId: null,
        allocatedCents: 2000,
        projectId: scope.projectId,
        stepKey: 'step-a',
      });
    });

    // Settle 500 (partial use).
    await db.drizzle.transaction(async (tx) => {
      await budgetService.settle(tx, {
        companyId: scope.companyId,
        runId: childRun,
        billingAgentId: null,
        externalCallId: `call-${childRun}-partial`,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        operation: 'chat',
        costCents: 500,
      });
    });

    // Release the child (terminalization).
    await db.drizzle.transaction(async (tx) => {
      await budgetService.release(tx, {
        companyId: scope.companyId,
        runId: childRun,
      });
    });

    // Child allocation: 2000 allocated, 500 settled, 1500 released.
    const childAlloc = await getAllocation(db, childRun);
    expect(childAlloc!.allocated).toBe(2000);
    expect(childAlloc!.settled).toBe(500);
    expect(childAlloc!.released).toBe(1500);
    expect(childAlloc!.status).toBe('released');

    // Root reservation: 5000 reserved, 500 settled, 1500 released.
    const rootRes = await getReservation(db, rootRunId);
    expect(rootRes!.settled).toBe(500);
    expect(rootRes!.released).toBe(1500);
    // Released funds have returned to the company and cannot fund new children.
    const nextChild = await seedChildRun(db, scope, rootRunId);
    await expect(
      db.drizzle.transaction((tx) =>
        budgetService.allocateChild(tx, {
          companyId: scope.companyId,
          rootReservationId: reservationId,
          runId: nextChild,
          billingAgentId: null,
          allocatedCents: 3001,
        }),
      ),
    ).rejects.toThrow(/exceeds unallocated root residual/);

    // settled + released <= reserved.
    expect(rootRes!.settled + rootRes!.released).toBeLessThanOrEqual(rootRes!.reserved);
  });
});

// ---------------------------------------------------------------------------
// VAL-SUB-072: Known cancelled charges remain visible
// ---------------------------------------------------------------------------

describe('VAL-SUB-072: Known cancelled charges remain visible', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await closeTestDb();
  });

  it('settles a known charge even when cancellation wins, while the result is discarded', async () => {
    const scope = await seedScope(db, 'cancel-charge-co');
    const { rootRunId, reservationId } = await seedRootRun(db, scope, {
      reservedCents: 5000,
      status: 'running',
    });
    const childRun = await seedChildRun(db, scope, rootRunId, { status: 'running' });
    const budgetService = new BudgetService(db, { clock: () => new Date() });

    // Allocate budget to the child.
    await db.drizzle.transaction(async (tx) => {
      await budgetService.allocateChild(tx, {
        companyId: scope.companyId,
        rootReservationId: reservationId,
        runId: childRun,
        billingAgentId: null,
        allocatedCents: 2000,
        projectId: scope.projectId,
        stepKey: 'step-a',
      });
    });

    // Simulate: provider call completes with a known charge of 800 cents.
    const CHARGE_CENTS = 800;
    const externalCallId = `cancel-charge-${childRun}-1`;

    // Settle the known charge (the call completed and incurred cost).
    await db.drizzle.transaction(async (tx) => {
      await budgetService.settle(tx, {
        companyId: scope.companyId,
        runId: childRun,
        billingAgentId: null,
        externalCallId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        operation: 'chat',
        inputTokens: 1000,
        outputTokens: 500,
        costCents: CHARGE_CENTS,
      });
    });

    // Now cancellation wins — the child is terminalized as cancelled.
    const cancelService = new MissionCancellationService(db, { clock: () => new Date() });
    await db.drizzle.transaction(async (tx) => {
      const [childRow] = await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, childRun))
        .for('update')
        .limit(1);
      expect(childRow).toBeDefined();
      await cancelService.requestCancellation(tx, childRow!, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: childRun,
        actorType: 'system' as const,
        actorId: null,
      });
    });

    // The charge IS visible in settlement/cost history.
    expect(await countSettlements(db, childRun)).toBe(1);
    expect(await countCostEvents(db, scope.companyId)).toBe(0); // no billing agent → no cost_event

    // The child is cancelled (not completed).
    const childStatus = await getRunStatus(db, childRun);
    expect(childStatus).toBe('cancelled');

    // No completion event on the child journal.
    const completedEvents = await getEventsByType(db, childRun, 'run.completed');
    expect(completedEvents.length).toBe(0);

    // Cancellation event IS present.
    const cancelledEvents = await getEventsByType(db, childRun, 'run.cancelled');
    expect(cancelledEvents.length).toBe(1);

    // The settlement remains after cancellation — replay does not duplicate.
    await db.drizzle.transaction(async (tx) => {
      const result = await budgetService.settle(tx, {
        companyId: scope.companyId,
        runId: childRun,
        billingAgentId: null,
        externalCallId, // same external_call_id → replay
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        operation: 'chat',
        costCents: CHARGE_CENTS,
      });
      expect(result.replayed).toBe(true);
    });
    expect(await countSettlements(db, childRun)).toBe(1);
  });

  it('proves charge visibility via run-processor when cancellation arrives after a successful call', async () => {
    const scope = await seedScope(db, 'processor-cancel-co');
    // Use a ROOT run (parentRunId === null, no approved plan) so the
    // processor goes directly to executeAndComplete.
    const now = new Date();
    const policySnapshotId = randomUUID();
    const limits = {
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
    await db.drizzle.execute(sql`
      INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "source_profile", "source_profile_version", "provider", "adapter_id", "model", "reasoning_depth", "system_prompt_hash", "instruction_hash", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
      VALUES (${policySnapshotId}, ${scope.companyId}, 1, 'fast', 1, 'anthropic', null, 'claude-sonnet-4-6', 'standard', 'h-sys', 'h-instr', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'require_all', ${JSON.stringify(limits)}::jsonb, ${randomUUID()}, ${now})
    `);

    const rootRunId = randomUUID();
    const encryptedEnvelope = encryptEnvelope({ text: 'Process this mission run.' });
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "billing_agent_id", "lease_owner", "lease_token", "lease_expires_at", "created_at", "updated_at")
      VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', ${encryptedEnvelope}, 'hash', 'Root', 'fast', ${policySnapshotId}, 'running', 1, 0, 'require_all', ${now}, NULL, 'test-worker', 'test-token', ${new Date(now.getTime() + 30000)}, ${now}, ${now})
    `);

    // Create a root reservation + allocation for this run.
    const reservationId = randomUUID();
    const allocationId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "period_key", "status", "created_at", "updated_at")
      VALUES (${reservationId}, ${scope.companyId}, ${rootRunId}, NULL, 5000, 5000, 0, 0, '2026-08', 'held', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
      VALUES (${allocationId}, ${scope.companyId}, ${reservationId}, ${rootRunId}, NULL, 5000, 0, 0, 'held', ${now}, ${now})
    `);

    // The provider call SUCCEEDS with a known charge, but cancellation
    // is requested before the processor can complete the run.
    const CHARGE_CENTS = 600;
    const mockProviderCall: ProviderCallFn = async (
      _messages: ChatMessage[],
      _config: ProviderConfig,
      _signal: AbortSignal,
    ): Promise<CompletionResult> => {
      // Request cancellation while the provider call is "in flight"
      // (after the call completes but before the processor can settle
      // and complete). This simulates the race where the charge was
      // incurred but cancellation wins the run lock.
      const cancelService = new MissionCancellationService(db, { clock: () => new Date() });
      await db.drizzle.transaction(async (tx) => {
        const [runRow] = await tx
          .select()
          .from(db.schema.missionRuns)
          .where(eq(db.schema.missionRuns.id, rootRunId))
          .for('update')
          .limit(1);
        await cancelService.requestCancellation(tx, runRow!, {
          companyId: scope.companyId,
          projectId: scope.projectId,
          runId: rootRunId,
          actorType: 'system' as const,
          actorId: null,
        });
      });
      return {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        content: 'Result that should be discarded',
        finishReason: 'stop',
        inputTokens: 1000,
        outputTokens: 500,
        costCents: CHARGE_CENTS,
        latencyMs: 100,
      };
    };

    const claim: Claim = {
      runId: rootRunId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      leaseOwner: 'test-worker',
      leaseToken: 'test-token',
      leaseExpiresAt: new Date(now.getTime() + 30000),
      claimedFromStatus: 'running',
      status: 'running',
      stateVersion: 1,
      lastEventSequence: 0,
      attemptCount: 0,
      isRecovery: false,
    };

    const processor = new RunProcessor(db, {
      clock: () => new Date(),
      providerCall: mockProviderCall,
    });

    const controller = new AbortController();
    await processor.advance(claim, controller.signal);

    // The charge IS settled and visible — settlement happened before
    // completeRun refused due to the pending cancellation.
    expect(await countSettlements(db, rootRunId)).toBe(1);

    // No completion event — the result was discarded.
    const completedEvents = await getEventsByType(db, rootRunId, 'run.completed');
    expect(completedEvents.length).toBe(0);

    // Cancellation was requested during the provider call.
    const cancelRequestedEvents = await getEventsByType(db, rootRunId, 'run.cancel_requested');
    expect(cancelRequestedEvents.length).toBe(1);

    // The run is still 'running' with cancel_requested_at set (the lease
    // was active, so cancellation was not immediately terminalized).
    // Now terminalize to complete the cancellation (simulating the worker
    // observing the cancellation at a checkpoint).
    const cancelService2 = new MissionCancellationService(db, { clock: () => new Date() });
    await db.drizzle.transaction(async (tx) => {
      await cancelService2.terminalize(tx, scope.companyId, scope.projectId, rootRunId, {});
    });

    // The run is now cancelled (not completed).
    const status = await getRunStatus(db, rootRunId);
    expect(status).toBe('cancelled');

    // The settlement remains visible after terminalization.
    expect(await countSettlements(db, rootRunId)).toBe(1);

    // Cancellation event IS present.
    const cancelledEvents = await getEventsByType(db, rootRunId, 'run.cancelled');
    expect(cancelledEvents.length).toBe(1);
  });
});
