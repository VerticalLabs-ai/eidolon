import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import {
  assertQueryCountIndependentOfRows,
  createTestApp,
  createTestDb,
  QueryCounter,
} from '../test-utils.js';
import { BudgetService } from '../services/mission/budget.js';
import { costWindow } from '../services/cost-breakdown.js';
import type { DbInstance } from '../types.js';

const DAY_MS = 86_400_000;

function enableFlags(...flags: string[]) {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify(Object.fromEntries(flags.map((flag) => [flag, { enabled: true }]))),
  );
}

describe('costWindow', () => {
  it('covers whole UTC days and ends with the day `now` falls in', () => {
    const { from, to } = costWindow(7, new Date('2026-11-09T23:59:59.999Z'));
    expect(from.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-10T00:00:00.000Z');
  });

  it('does not shift the window at the start of a UTC day', () => {
    const { from, to } = costWindow(30, new Date('2026-03-01T00:00:00.000Z'));
    expect(from.toISOString()).toBe('2026-01-31T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });
});

describe('GET /api/companies/:companyId/analytics/costs/breakdown', () => {
  const queries = new QueryCounter();
  let db: DbInstance;
  let app: ReturnType<typeof createTestApp>;
  let companyId: string;

  const breakdownUrl = (days?: number, id = companyId) =>
    `/api/companies/${id}/analytics/costs/breakdown${days ? `?days=${days}` : ''}`;

  async function createCompany(name: string): Promise<string> {
    const res = await request(app)
      .post('/api/companies')
      .send({
        name: `__mtest__ ${name}`,
        settings: { testFixture: true },
        budgetMonthlyCents: 500_000,
      })
      .expect(201);
    return res.body.data.id;
  }

  async function createAgent(name: string, id = companyId): Promise<string> {
    const res = await request(app)
      .post(`/api/companies/${id}/agents`)
      .send({ name, role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    return res.body.data.id;
  }

  /** Insert a legacy (non-Mission) charge at an exact time. */
  async function charge(input: {
    agentId: string;
    costCents: number;
    at: Date;
    company?: string;
    provider?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
  }) {
    await db.drizzle.insert(db.schema.costEvents).values({
      companyId: input.company ?? companyId,
      agentId: input.agentId,
      provider: input.provider ?? 'anthropic',
      model: input.model ?? 'claude-sonnet-4-6',
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      costCents: input.costCents,
      createdAt: input.at,
    });
  }

  /** Start a real Mission run through the API and return its id. */
  async function startRun(text: string, agentId?: string): Promise<string> {
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: `Project for ${text}` })
      .expect(201);
    const projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Mission thread' })
      .expect(201);
    const res = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('Idempotency-Key', `cost-breakdown-${randomUUID()}`)
      .send({
        projectThreadId: thread.body.data.id,
        mode: 'fast',
        request: { text },
        ...(agentId ? { initiatingAgentId: agentId } : {}),
      })
      .expect(202);
    return res.body.data.run.id;
  }

  async function settle(runId: string, billingAgentId: string | null, costCents: number) {
    const budget = new BudgetService(db);
    await db.drizzle.transaction((tx) =>
      budget.settle(tx, {
        companyId,
        runId,
        billingAgentId,
        externalCallId: `call-${randomUUID()}`,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        inputTokens: 1_000,
        outputTokens: 200,
        costCents,
      }),
    );
  }

  /**
   * Add a child run under `rootRunId` with its own slice of the root budget.
   * Rows are cloned from the root so the fixture cannot drift from the schema.
   */
  async function addChildRun(rootRunId: string): Promise<string> {
    const childRunId = randomUUID();
    await db.drizzle.transaction(async (tx) => {
      await tx.execute(sql`create temp table child_run on commit drop as
        select * from mission_runs where id = ${rootRunId}`);
      await tx.execute(sql`update child_run
        set id = ${childRunId}, parent_run_id = ${rootRunId}, depth = 1, child_ordinal = 0`);
      await tx.execute(sql`insert into mission_runs select * from child_run`);
      await tx.execute(sql`create temp table child_allocation on commit drop as
        select * from budget_allocations where run_id = ${rootRunId}`);
      await tx.execute(sql`update child_allocation
        set id = ${randomUUID()}, run_id = ${childRunId}, settled_cents = 0, released_cents = 0`);
      await tx.execute(sql`insert into budget_allocations select * from child_allocation`);
    });
    return childRunId;
  }

  beforeEach(async () => {
    db = await createTestDb(queries);
    app = createTestApp(db);
    companyId = await createCompany('cost breakdown');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns a zero-filled window for a company with no spend', async () => {
    const res = await request(app).get(breakdownUrl()).expect(200);
    const data = res.body.data;

    expect(data.range.days).toBe(30);
    expect(data.totals).toEqual({ costCents: 0, inputTokens: 0, outputTokens: 0, callCount: 0 });
    expect(data.previous).toEqual({ costCents: 0, callCount: 0 });
    expect(data.daily).toHaveLength(30);
    expect(data.daily.every((day: { costCents: number }) => day.costCents === 0)).toBe(true);
    expect(data.byAgent).toEqual([]);
    expect(data.byModel).toEqual([]);
  });

  it('aggregates spend by day, agent and model inside the window only', async () => {
    const { from, to } = costWindow(7, new Date());
    const alpha = await createAgent('Alpha');
    const beta = await createAgent('Beta');
    const lastDay = new Date(to.getTime() - DAY_MS / 2);
    const firstInstant = from;

    await charge({
      agentId: alpha,
      costCents: 300,
      at: lastDay,
      inputTokens: 100,
      outputTokens: 10,
    });
    await charge({
      agentId: alpha,
      costCents: 50,
      at: firstInstant,
      inputTokens: 5,
      outputTokens: 1,
    });
    await charge({
      agentId: beta,
      costCents: 120,
      at: lastDay,
      provider: 'openai',
      model: 'gpt-5',
      inputTokens: 40,
      outputTokens: 4,
    });
    // One millisecond before the window: belongs to the previous period.
    await charge({ agentId: beta, costCents: 900, at: new Date(from.getTime() - 1) });
    // Before the previous period entirely: counted nowhere.
    await charge({ agentId: beta, costCents: 7_000, at: new Date(from.getTime() - 8 * DAY_MS) });

    const res = await request(app).get(breakdownUrl(7)).expect(200);
    const data = res.body.data;

    expect(data.range).toEqual({ days: 7, from: from.toISOString(), to: to.toISOString() });
    expect(data.totals).toEqual({
      costCents: 470,
      inputTokens: 145,
      outputTokens: 15,
      callCount: 3,
    });
    expect(data.previous).toEqual({ costCents: 900, callCount: 1 });

    expect(data.daily).toHaveLength(7);
    expect(data.daily[0]).toEqual({
      date: from.toISOString().slice(0, 10),
      costCents: 50,
      callCount: 1,
    });
    expect(data.daily[6]).toEqual({
      date: lastDay.toISOString().slice(0, 10),
      costCents: 420,
      callCount: 2,
    });
    expect(data.daily.slice(1, 6).every((day: { costCents: number }) => day.costCents === 0)).toBe(
      true,
    );

    expect(
      data.byAgent.map((row: { name: string; costCents: number; callCount: number }) => [
        row.name,
        row.costCents,
        row.callCount,
      ]),
    ).toEqual([
      ['Alpha', 350, 2],
      ['Beta', 120, 1],
    ]);
    expect(data.byAgent[0]).toMatchObject({ agentId: alpha, role: 'engineer' });

    expect(
      data.byModel.map((row: { provider: string; model: string; costCents: number }) => [
        row.provider,
        row.model,
        row.costCents,
      ]),
    ).toEqual([
      ['anthropic', 'claude-sonnet-4-6', 350],
      ['openai', 'gpt-5', 120],
    ]);
  });

  it('never includes another company in any breakdown', async () => {
    const mine = await createAgent('Mine');
    const otherCompany = await createCompany('other tenant');
    const theirs = await createAgent('Theirs', otherCompany);
    const now = new Date();

    await charge({ agentId: mine, costCents: 25, at: now });
    await charge({ agentId: theirs, costCents: 9_999, at: now, company: otherCompany });

    const res = await request(app).get(breakdownUrl(7)).expect(200);
    expect(res.body.data.totals.costCents).toBe(25);
    expect(res.body.data.byAgent).toHaveLength(1);
    expect(res.body.data.byAgent[0].name).toBe('Mine');

    const other = await request(app).get(breakdownUrl(7, otherCompany)).expect(200);
    expect(other.body.data.totals.costCents).toBe(9_999);
  });

  it('rejects a window that is not offered', async () => {
    const res = await request(app).get(breakdownUrl(14)).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('withholds the Mission run breakdown while cost monitoring is off', async () => {
    const res = await request(app).get(breakdownUrl(7)).expect(200);
    expect(res.body.data.runs).toBeNull();
  });

  describe('with Mission cost monitoring enabled', () => {
    beforeEach(() => {
      enableFlags('missionAgentIntelligence', 'missionPolish');
    });

    it('rolls Mission charges up to the run and counts each charge once', async () => {
      const agent = await createAgent('Researcher');
      const runA = await startRun('Compare three vendors', agent);
      const runB = await startRun('Summarise the Q3 board deck', agent);

      await settle(runA, agent, 140);
      await settle(runA, agent, 60);
      await settle(runB, agent, 35);
      // Not billed to a company agent: has a settlement but no cost event.
      await settle(runB, null, 15);
      // Legacy spend that belongs to no run.
      await charge({ agentId: agent, costCents: 500, at: new Date() });

      const res = await request(app).get(breakdownUrl(7)).expect(200);
      const data = res.body.data;

      // 140 + 60 + 35 + 15 + 500. A settlement and its compatibility cost
      // event are one charge, not two.
      expect(data.totals.costCents).toBe(750);
      expect(data.totals.callCount).toBe(5);

      expect(data.runs.totalCount).toBe(2);
      expect(data.runs.costCents).toBe(250);
      expect(
        data.runs.items.map(
          (row: {
            runId: string;
            costCents: number;
            callCount: number;
            chargedRunCount: number;
          }) => [row.runId, row.costCents, row.callCount, row.chargedRunCount],
        ),
      ).toEqual([
        [runA, 200, 2, 1],
        [runB, 50, 2, 1],
      ]);
      expect(data.runs.items[0]).toMatchObject({
        mode: 'fast',
        projectName: 'Project for Compare three vendors',
        inputTokens: 2_000,
        outputTokens: 400,
      });
      expect(Number.isNaN(Date.parse(data.runs.items[0].lastChargeAt))).toBe(false);

      // Spend with no billing agent is reported, not dropped.
      const unassigned = data.byAgent.find(
        (row: { agentId: string | null }) => row.agentId === null,
      );
      expect(unassigned).toMatchObject({ name: null, costCents: 15, callCount: 1 });
      const researcher = data.byAgent.find(
        (row: { agentId: string | null }) => row.agentId === agent,
      );
      expect(researcher).toMatchObject({ costCents: 735, callCount: 4 });
    });

    it('rolls child-run charges up to the root run', async () => {
      const agent = await createAgent('Lead');
      const root = await startRun('Audit the onboarding flow', agent);
      const child = await addChildRun(root);

      await settle(root, agent, 40);
      await settle(child, agent, 25);

      const res = await request(app).get(breakdownUrl(7)).expect(200);
      const { runs } = res.body.data;

      expect(runs.totalCount).toBe(1);
      expect(runs.items).toHaveLength(1);
      expect(runs.items[0]).toMatchObject({
        runId: root,
        costCents: 65,
        callCount: 2,
        chargedRunCount: 2,
      });
    });

    it('uses the same number of queries however many agents and runs are charged', async () => {
      const seed = async (count: number) => {
        for (let index = 0; index < count; index += 1) {
          const agent = await createAgent(`Agent ${randomUUID()}`);
          const run = await startRun(`Mission ${randomUUID()}`, agent);
          await settle(run, agent, 10 + index);
        }
      };

      await seed(1);

      await assertQueryCountIndependentOfRows({
        queries,
        label: 'GET /api/companies/:companyId/analytics/costs/breakdown',
        read: async () => {
          const res = await request(app).get(breakdownUrl(7)).expect(200);
          expect(res.body.data.runs.items.length).toBeGreaterThan(0);
        },
        seed: () => seed(3),
      });
    });
  });
});
