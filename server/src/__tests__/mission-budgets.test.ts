import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer } from '../test-utils.js';
import { BudgetService } from '../services/mission/budget.js';

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
    VALUES (${companyId}, ${label}, 'active', ${companyBudget}, ${companySpent}, '{}'::jsonb, ${now}, ${now})
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
  opts: { budget?: number; spent?: number; provider?: string } = {},
) {
  const agentId = randomUUID();
  const now = new Date();
  const agentBudget = opts.budget ?? 0;
  const agentSpent = opts.spent ?? 0;
  const agentProvider = opts.provider ?? 'anthropic';
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "created_at", "updated_at")
    VALUES (${agentId}, ${companyId}, 'A', 'engineer', ${agentProvider}, 'claude-sonnet-4-6', 'idle', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 5, 0, 600, 0, ${agentBudget}, ${agentSpent}, ${now}, ${now})
  `);
  return agentId;
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

async function countRuns(db: AnyDb, companyId: string, projectId: string): Promise<number> {
  const [row] = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS c FROM "mission_runs"
    WHERE "company_id" = ${companyId} AND "project_id" = ${projectId}
  `)) as unknown as { c: number }[];
  return row.c;
}

async function getSettlements(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "external_call_id" AS "externalCallId", "cost_cents" AS "costCents",
           "provider", "model", "input_tokens" AS "inputTokens",
           "output_tokens" AS "outputTokens", "credits"
    FROM "budget_settlements" WHERE "run_id" = ${runId}
    ORDER BY "created_at" ASC
  `)) as unknown as Record<string, unknown>[];
  return rows;
}

// ---------------------------------------------------------------------------
// VAL-RUN-061 / VAL-CROSS-061: Insufficient budget denies start atomically
// ---------------------------------------------------------------------------

describe('VAL-RUN-061 / VAL-CROSS-061: Insufficient budget denies start atomically', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects start with 409 BUDGET_UNAVAILABLE when company headroom is insufficient', async () => {
    // Company has 100 cents budget but all 100 already spent → 0 headroom.
    // Fast mode ceiling is 500 cents; cannot reserve even 1 cent.
    const { companyId, projectId, threadId } = await seedScope(db, 'insufficient-co', {
      companyBudget: 100,
      companySpent: 100,
    });
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const runsBefore = await countRuns(db, companyId, projectId);
    const spendBefore = await getCompanySpend(db, companyId);

    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `insufficient-${randomUUID()}`)
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } })
      .expect(409);

    expect(res.body.code).toBe('BUDGET_UNAVAILABLE');

    // No run was created.
    const runsAfter = await countRuns(db, companyId, projectId);
    expect(runsAfter).toBe(runsBefore);

    // No spend change.
    const spendAfter = await getCompanySpend(db, companyId);
    expect(spendAfter).toBe(spendBefore);
  });

  it('rejects start with 409 BUDGET_UNAVAILABLE when agent headroom is insufficient', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'insufficient-agent', {
      companyBudget: 100000,
    });
    // Agent has only 10 cents budget with all 10 spent → 0 headroom.
    const agentId = await seedAgent(db, companyId, { budget: 10, spent: 10 });
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `insufficient-agent-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Do work' },
      })
      .expect(409);

    expect(res.body.code).toBe('BUDGET_UNAVAILABLE');
    expect(await countRuns(db, companyId, projectId)).toBe(0);
  });

  it('creates no reservation or allocation on budget denial', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'no-reserve', {
      companyBudget: 50,
      companySpent: 50,
    });
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    await request(app)
      .post(base)
      .set('Idempotency-Key', `no-reserve-${randomUUID()}`)
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } })
      .expect(409);

    const reservations = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS c FROM "budget_reservations" WHERE "company_id" = ${companyId}
    `)) as unknown as { c: number }[];
    expect(reservations[0].c).toBe(0);
  });

  it('accepts start when company budget is 0 (unlimited) with finite ceiling', async () => {
    // budgetMonthlyCents=0 means unlimited; Mission ceiling is finite.
    const { companyId, projectId, threadId } = await seedScope(db, 'unlimited-co', {
      companyBudget: 0,
    });
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `unlimited-${randomUUID()}`)
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } })
      .expect(202);

    expect(res.body.data.run.budget.reservedCents).toBe(500); // fast mode ceiling
    expect(res.body.data.run.budget.costCentsCeiling).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-062: Invalid budget limit fails closed
// ---------------------------------------------------------------------------

describe('VAL-RUN-062: Invalid budget limit fails closed', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('rejects zero costCents with 400', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'zero-limit');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `zero-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        request: { text: 'Do work' },
        limits: { costCents: 0 },
      })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await countRuns(db, companyId, projectId)).toBe(0);
  });

  it('rejects negative costCents with 400', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'neg-limit');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `neg-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        request: { text: 'Do work' },
        limits: { costCents: -100 },
      })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await countRuns(db, companyId, projectId)).toBe(0);
  });

  it('rejects non-integer costCents with 400', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'float-limit');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `float-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        request: { text: 'Do work' },
        limits: { costCents: 100.5 },
      })
      .expect(400);

    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await countRuns(db, companyId, projectId)).toBe(0);
  });

  it('accepts a valid lowered costCents and uses it as ceiling', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'valid-limit');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `valid-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        request: { text: 'Do work' },
        limits: { costCents: 100 },
      })
      .expect(202);

    // The user limit of 100 is lower than the fast mode ceiling of 500,
    // so the effective ceiling is 100.
    expect(res.body.data.run.budget.costCentsCeiling).toBe(100);
    expect(res.body.data.run.budget.reservedCents).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-122: Concurrent root budget reservations are race safe
// ---------------------------------------------------------------------------

describe('VAL-RUN-122: Concurrent root budget reservations are race safe', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    app = await createTestServer(db);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('two concurrent starts competing for one minimum reservation yield exactly one 202 and one 409', async () => {
    // Company budget 500 cents, 0 spent. Fast mode ceiling is 500.
    // Two concurrent starts: each needs 500. Only one can reserve.
    const { companyId, projectId, threadId } = await seedScope(db, 'race-co', {
      companyBudget: 500,
      companySpent: 0,
    });
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const key1 = `race-1-${randomUUID()}`;
    const key2 = `race-2-${randomUUID()}`;

    // Fire two starts concurrently.
    const [res1, res2] = await Promise.all([
      request(app)
        .post(base)
        .set('Idempotency-Key', key1)
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Run A' } }),
      request(app)
        .post(base)
        .set('Idempotency-Key', key2)
        .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Run B' } }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    // Exactly one 202 and one 409.
    expect(statuses).toEqual([202, 409]);

    // The 409 must be BUDGET_UNAVAILABLE.
    const failed = res1.status === 409 ? res1 : res2;
    expect(failed.body.code).toBe('BUDGET_UNAVAILABLE');

    // Only one run was created.
    expect(await countRuns(db, companyId, projectId)).toBe(1);

    // Company spend never exceeded budget.
    const spend = await getCompanySpend(db, companyId);
    expect(spend).toBeLessThanOrEqual(500);

    // Total reserved never exceeds budget.
    const reservations = (await db.drizzle.execute(sql`
      SELECT COALESCE(SUM("reserved_cents" - "settled_cents" - "released_cents"), 0)::int AS total
      FROM "budget_reservations"
      WHERE "company_id" = ${companyId} AND "status" IN ('held', 'partially_settled')
    `)) as unknown as { total: number }[];
    expect(reservations[0].total).toBeLessThanOrEqual(500);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-123: Settlement updates compatibility cost surfaces once
// ---------------------------------------------------------------------------

describe('VAL-RUN-123: Settlement updates compatibility cost surfaces once', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('creates one settlement, one cost_event, and increments spend by exactly costCents', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'settle-once');
    const agentId = await seedAgent(db, companyId, { budget: 100000, spent: 0 });
    const app = await createTestServer(db);
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const start = await request(app)
      .post(base)
      .set('Idempotency-Key', `settle-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Do work' },
      })
      .expect(202);
    const runId = start.body.data.run.id as string;

    const companySpendBefore = await getCompanySpend(db, companyId);
    const agentSpendBefore = await getAgentSpend(db, agentId);
    const costEventsBefore = await countCostEvents(db, companyId);

    // Settle a charge of 150 cents.
    const budget = new BudgetService(db);
    const externalCallId = `call-${randomUUID()}`;
    const result = await db.drizzle.transaction(async (tx) => {
      return budget.settle(tx, {
        companyId,
        runId,
        billingAgentId: agentId,
        externalCallId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        inputTokens: 1000,
        outputTokens: 500,
        costCents: 150,
        traceId: 'trace-1',
      });
    });

    expect(result.replayed).toBe(false);
    expect(result.costCents).toBe(150);

    // One settlement.
    expect(await countSettlements(db, runId)).toBe(1);

    // One new cost_event (linked to settlement).
    const costEventsAfter = await countCostEvents(db, companyId);
    expect(costEventsAfter).toBe(costEventsBefore + 1);

    // Company spend incremented by exactly 150.
    const companySpendAfter = await getCompanySpend(db, companyId);
    expect(companySpendAfter).toBe(companySpendBefore + 150);

    // Agent spend incremented by exactly 150.
    const agentSpendAfter = await getAgentSpend(db, agentId);
    expect(agentSpendAfter).toBe(agentSpendBefore + 150);

    // Reservation and allocation settled amounts match.
    const reservation = await getReservation(db, runId);
    expect(reservation!.settled).toBe(150);
    const allocation = await getAllocation(db, runId);
    expect(allocation!.settled).toBe(150);
  });

  it('replaying the same external_call_id does not duplicate settlement, cost_event, or spend', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'settle-replay');
    const agentId = await seedAgent(db, companyId, { budget: 100000, spent: 0 });
    const app = await createTestServer(db);
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const start = await request(app)
      .post(base)
      .set('Idempotency-Key', `replay-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Do work' },
      })
      .expect(202);
    const runId = start.body.data.run.id as string;

    const budget = new BudgetService(db);
    const externalCallId = `call-replay-${randomUUID()}`;

    // First settlement.
    await db.drizzle.transaction(async (tx) => {
      await budget.settle(tx, {
        companyId,
        runId,
        billingAgentId: agentId,
        externalCallId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        costCents: 200,
      });
    });

    const spendAfter1 = await getCompanySpend(db, companyId);
    const settlementsAfter1 = await countSettlements(db, runId);
    const costEventsAfter1 = await countCostEvents(db, companyId);

    // Replay the same external_call_id.
    const result2 = await db.drizzle.transaction(async (tx) => {
      return budget.settle(tx, {
        companyId,
        runId,
        billingAgentId: agentId,
        externalCallId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        costCents: 200,
      });
    });

    expect(result2.replayed).toBe(true);
    expect(result2.costCents).toBe(200);

    // No duplicate settlement, cost_event, or spend.
    expect(await countSettlements(db, runId)).toBe(settlementsAfter1);
    expect(await countCostEvents(db, companyId)).toBe(costEventsAfter1);
    expect(await getCompanySpend(db, companyId)).toBe(spendAfter1);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-064: Terminal accounting is complete and immutable
// ---------------------------------------------------------------------------

describe('VAL-RUN-064: Terminal accounting is complete and immutable', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('release on terminalization releases all unconsumed amounts in one transaction', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'terminal-release');
    const agentId = await seedAgent(db, companyId, { budget: 100000, spent: 0 });
    const app = await createTestServer(db);
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const start = await request(app)
      .post(base)
      .set('Idempotency-Key', `release-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Do work' },
      })
      .expect(202);
    const runId = start.body.data.run.id as string;
    const reservedCents = start.body.data.run.budget.reservedCents as number;

    // Settle a partial charge of 100 cents.
    const budget = new BudgetService(db);
    await db.drizzle.transaction(async (tx) => {
      await budget.settle(tx, {
        companyId,
        runId,
        billingAgentId: agentId,
        externalCallId: `call-${randomUUID()}`,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        costCents: 100,
      });
    });

    // Release on terminalization.
    await db.drizzle.transaction(async (tx) => {
      await budget.release(tx, { companyId, runId });
    });

    // Reservation: settled 100, released = reserved - settled.
    const reservation = await getReservation(db, runId);
    expect(reservation!.settled).toBe(100);
    expect(reservation!.released).toBe(reservedCents - 100);
    expect(reservation!.status).toBe('released');

    // Allocation: same.
    const allocation = await getAllocation(db, runId);
    expect(allocation!.settled).toBe(100);
    expect(allocation!.released).toBe(reservedCents - 100);
    expect(allocation!.status).toBe('released');

    // Invariant: settled + released <= reserved.
    expect(reservation!.settled + reservation!.released).toBeLessThanOrEqual(reservation!.reserved);
  });

  it('terminal state is immutable — no post-terminal settlement is accepted', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'terminal-imm');
    const agentId = await seedAgent(db, companyId, { budget: 100000, spent: 0 });
    const app = await createTestServer(db);
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const start = await request(app)
      .post(base)
      .set('Idempotency-Key', `imm-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Do work' },
      })
      .expect(202);
    const runId = start.body.data.run.id as string;

    const budget = new BudgetService(db);

    // Settle a charge.
    await db.drizzle.transaction(async (tx) => {
      await budget.settle(tx, {
        companyId,
        runId,
        billingAgentId: agentId,
        externalCallId: `call-1-${randomUUID()}`,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        costCents: 100,
      });
    });

    // Release on terminalization.
    await db.drizzle.transaction(async (tx) => {
      await budget.release(tx, { companyId, runId });
    });

    const spendAfterTerminal = await getCompanySpend(db, companyId);
    const settlementsAfterTerminal = await countSettlements(db, runId);

    // Attempt a post-terminal settlement — should fail because allocation
    // is fully released (no remaining headroom).
    await expect(
      db.drizzle.transaction(async (tx) => {
        await budget.settle(tx, {
          companyId,
          runId,
          billingAgentId: agentId,
          externalCallId: `post-terminal-${randomUUID()}`,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          costCents: 50,
        });
      }),
    ).rejects.toThrow();

    // Spend and settlements unchanged.
    expect(await getCompanySpend(db, companyId)).toBe(spendAfterTerminal);
    expect(await countSettlements(db, runId)).toBe(settlementsAfterTerminal);
  });

  it('recovery/reload does not double-account — re-reading shows same values', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'reload');
    const agentId = await seedAgent(db, companyId, { budget: 100000, spent: 0 });
    const app = await createTestServer(db);
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const start = await request(app)
      .post(base)
      .set('Idempotency-Key', `reload-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Do work' },
      })
      .expect(202);
    const runId = start.body.data.run.id as string;

    const budget = new BudgetService(db);
    await db.drizzle.transaction(async (tx) => {
      await budget.settle(tx, {
        companyId,
        runId,
        billingAgentId: agentId,
        externalCallId: `call-r-${randomUUID()}`,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        costCents: 250,
      });
    });
    await db.drizzle.transaction(async (tx) => {
      await budget.release(tx, { companyId, runId });
    });

    // "Reload" — re-read all budget state.
    const reservation1 = await getReservation(db, runId);
    const allocation1 = await getAllocation(db, runId);
    const spend1 = await getCompanySpend(db, companyId);
    const agentSpend1 = await getAgentSpend(db, agentId);
    const settlements1 = await countSettlements(db, runId);
    const costEvents1 = await countCostEvents(db, companyId);

    // Read again — must be identical.
    const reservation2 = await getReservation(db, runId);
    const allocation2 = await getAllocation(db, runId);
    const spend2 = await getCompanySpend(db, companyId);
    const agentSpend2 = await getAgentSpend(db, agentId);
    const settlements2 = await countSettlements(db, runId);
    const costEvents2 = await countCostEvents(db, companyId);

    expect(reservation2).toEqual(reservation1);
    expect(allocation2).toEqual(allocation1);
    expect(spend2).toBe(spend1);
    expect(agentSpend2).toBe(agentSpend1);
    expect(settlements2).toBe(settlements1);
    expect(costEvents2).toBe(costEvents1);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-065: Replayed commands do not double charge
// ---------------------------------------------------------------------------

describe('VAL-RUN-065: Replayed commands do not double charge', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('replaying an idempotent start does not create a second reservation', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'replay-start');
    const app = await createTestServer(db);
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const key = `replay-start-${randomUUID()}`;

    const res1 = await request(app)
      .post(base)
      .set('Idempotency-Key', key)
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } })
      .expect(202);

    const res2 = await request(app)
      .post(base)
      .set('Idempotency-Key', key)
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Do work' } })
      .expect(202);

    // Same run ID, same budget.
    expect(res2.body.data.run.id).toBe(res1.body.data.run.id);
    expect(res2.body.data.run.budget.reservedCents).toBe(res1.body.data.run.budget.reservedCents);

    // Only one run and one reservation.
    expect(await countRuns(db, companyId, projectId)).toBe(1);
    const reservations = (await db.drizzle.execute(sql`
      SELECT count(*)::int AS c FROM "budget_reservations" WHERE "company_id" = ${companyId}
    `)) as unknown as { c: number }[];
    expect(reservations[0].c).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// VAL-CROSS-064: Settlement survives cancellation and retry
// ---------------------------------------------------------------------------

describe('VAL-CROSS-064: Settlement survives cancellation and retry', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('known charges around cancellation are settled once; retry uses fresh reservation without re-settling old call', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'cancel-retry');
    const agentId = await seedAgent(db, companyId, { budget: 100000, spent: 0 });
    const app = await createTestServer(db);
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

    const start = await request(app)
      .post(base)
      .set('Idempotency-Key', `cancel-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'fast',
        initiatingAgentId: agentId,
        request: { text: 'Do work' },
      })
      .expect(202);
    const runId = start.body.data.run.id as string;
    const stateVersion = start.body.data.run.stateVersion as number;

    const budget = new BudgetService(db);

    // Settle a charge (known charge that finishes around cancellation).
    const externalCallId = `call-cancel-${randomUUID()}`;
    await db.drizzle.transaction(async (tx) => {
      await budget.settle(tx, {
        companyId,
        runId,
        billingAgentId: agentId,
        externalCallId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        costCents: 100,
      });
    });

    const spendAfterSettle = await getCompanySpend(db, companyId);

    // Move the run to a terminal cancelled state + release.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'cancelled', "terminal_at" = ${new Date()}, "updated_at" = ${new Date()}
      WHERE "id" = ${runId}
    `);
    await db.drizzle.transaction(async (tx) => {
      await budget.release(tx, { companyId, runId });
    });

    // Retry the cancelled run.
    const retryRes = await request(app)
      .post(`${base}/${runId}/retry`)
      .set('Idempotency-Key', `retry-${randomUUID()}`)
      .set('If-Match', `"${stateVersion}"`)
      .send({})
      .expect(202);

    const successorRunId = retryRes.headers.location?.split('/').pop() as string;
    expect(successorRunId).not.toBe(runId);

    // The old settlement is unique — no duplicate external_call_id.
    const settlements = await getSettlements(db, runId);
    expect(settlements.length).toBe(1);
    expect(settlements[0].externalCallId).toBe(externalCallId);

    // The successor has its own fresh reservation.
    const successorReservation = await getReservation(db, successorRunId);
    expect(successorReservation).not.toBeNull();
    expect(successorReservation!.reserved).toBeGreaterThan(0);

    // The old reservation is released.
    const oldReservation = await getReservation(db, runId);
    expect(oldReservation!.status).toBe('released');

    // Company spend is unchanged after retry (no re-settlement of old call).
    expect(await getCompanySpend(db, companyId)).toBe(spendAfterSettle);

    // No settlement on the successor run.
    expect(await countSettlements(db, successorRunId)).toBe(0);
  });
});
