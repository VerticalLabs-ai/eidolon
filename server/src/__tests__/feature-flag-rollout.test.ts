import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { DbInstance } from '../types.js';
import { createTestDb, createTestServer, QueryCounter } from '../test-utils.js';
import {
  evaluateFeatureFlags,
  FEATURE_FLAG_NAMES,
  isFeatureEnabled,
} from '../services/feature-flags.js';

// The query logger is bound when the database is first created in a file, so the
// counter has to be created here rather than per test.
const queries = new QueryCounter();

describe('feature flag rollout', () => {
  let db: DbInstance;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let agentIds: string[];

  beforeAll(async () => {
    db = await createTestDb(queries);
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ flag rollout', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    agentIds = [];
    for (const name of ['Scout', 'Builder', 'Auditor']) {
      const agent = await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name, role: 'engineer' })
        .expect(201);
      agentIds.push(agent.body.data.id);
    }

    // Two agents carry tasks and one carries none, so the batched path is
    // exercised on an agent absent from the aggregate result.
    for (const [index, agentId] of agentIds.slice(0, 2).entries()) {
      for (let n = 0; n <= index; n += 1) {
        await request(app)
          .post(`/api/companies/${companyId}/tasks`)
          .send({ title: `Task ${index}-${n}`, assigneeAgentId: agentId })
          .expect(201);
      }
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reports every declared flag as off when nothing is configured', async () => {
    const response = await request(app).get(`/api/companies/${companyId}/flags`).expect(200);

    expect(response.body.data.subject).toBe(companyId);
    expect(Object.keys(response.body.data.flags).sort()).toEqual([...FEATURE_FLAG_NAMES].sort());
    expect(Object.values(response.body.data.flags)).toEqual(FEATURE_FLAG_NAMES.map(() => false));
  });

  it('never exposes the raw configuration or an undeclared flag name', async () => {
    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({
        analyticsAgentsBatched: { enabled: true, rolloutPercentage: 37 },
        unreleasedAcquisitionPricing: { enabled: true },
      }),
    );

    const response = await request(app).get(`/api/companies/${companyId}/flags`).expect(200);

    const body = JSON.stringify(response.body);
    // An unreleased flag name is operator configuration, not client data.
    expect(body).not.toContain('unreleasedAcquisitionPricing');
    // rolloutPercentage describes the population, not this caller.
    expect(body).not.toContain('rolloutPercentage');
    expect(JSON.stringify(response.body.data.flags)).not.toContain('37');
    // Only declared flags are present, each as a boolean outcome. Which
    // outcome depends on where this company falls in the 37% bucket.
    expect(Object.keys(response.body.data.flags).sort()).toEqual([...FEATURE_FLAG_NAMES].sort());
    expect(typeof response.body.data.flags.analyticsAgentsBatched).toBe('boolean');
    expect(response.body.data.flags.analyticsAgentsBatched).toBe(
      isFeatureEnabled('analyticsAgentsBatched', companyId),
    );
    // productAnalytics is declared but not configured here, so it is off.
    expect(typeof response.body.data.flags.productAnalytics).toBe('boolean');
    expect(response.body.data.flags.productAnalytics).toBe(false);
  });

  it('refuses an unauthenticated caller', async () => {
    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({ analyticsAgentsBatched: { enabled: true } }),
    );
    const authenticatedApp = await createTestServer(db, 'authenticated');

    const response = await request(authenticatedApp)
      .get(`/api/companies/${companyId}/flags`)
      .expect(401);

    expect(JSON.stringify(response.body)).not.toContain('analyticsAgentsBatched');
  });

  it('keeps a percentage assignment stable for a subject across evaluations', () => {
    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({ analyticsAgentsBatched: { enabled: true, rolloutPercentage: 50 } }),
    );

    const subjects = Array.from({ length: 200 }, (_, index) => `company-${index}`);
    const first = subjects.map((subject) => isFeatureEnabled('analyticsAgentsBatched', subject));
    const second = subjects.map((subject) => isFeatureEnabled('analyticsAgentsBatched', subject));
    const viaEvaluate = subjects.map(
      (subject) => evaluateFeatureFlags(subject).analyticsAgentsBatched,
    );

    expect(second).toEqual(first);
    expect(viaEvaluate).toEqual(first);

    // A 50% rollout that lands on every subject or none would pass a stability
    // check while being useless, so assert the split is genuinely partial.
    const enabled = first.filter(Boolean).length;
    expect(enabled).toBeGreaterThan(subjects.length * 0.25);
    expect(enabled).toBeLessThan(subjects.length * 0.75);
  });

  it('widening the rollout only adds subjects, so an enabled subject never flips off', () => {
    const subjects = Array.from({ length: 200 }, (_, index) => `company-${index}`);
    const enabledAt = (percentage: number) => {
      vi.stubEnv(
        'EIDOLON_FEATURE_FLAGS',
        JSON.stringify({
          analyticsAgentsBatched: { enabled: true, rolloutPercentage: percentage },
        }),
      );
      return new Set(
        subjects.filter((subject) => isFeatureEnabled('analyticsAgentsBatched', subject)),
      );
    };

    const at10 = enabledAt(10);
    const at50 = enabledAt(50);
    for (const subject of at10) {
      expect(at50.has(subject)).toBe(true);
    }
    expect(at50.size).toBeGreaterThan(at10.size);
  });

  it('serves an identical agent analytics response with and without the flag', async () => {
    const unbatched = await request(app)
      .get(`/api/companies/${companyId}/analytics/agents`)
      .expect(200);

    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({ analyticsAgentsBatched: { enabled: true } }),
    );
    const batched = await request(app)
      .get(`/api/companies/${companyId}/analytics/agents`)
      .expect(200);

    expect(batched.body).toEqual(unbatched.body);
    // The fixture must actually distinguish the paths: an agent with tasks and
    // an agent with none.
    const totals = batched.body.data.map((row: { tasks: { total: number } }) => row.tasks.total);
    expect(totals).toContain(0);
    expect(totals.some((total: number) => total > 0)).toBe(true);
  });

  it('collapses the per-agent queries only when the flag is enabled', async () => {
    // The batched path costs the agent list plus one aggregate, on top of the
    // route's own membership lookup. The unbatched path adds one query per
    // agent, so with three agents it cannot fit in the same budget.
    const BATCHED_BUDGET = 3;

    queries.reset();
    await request(app).get(`/api/companies/${companyId}/analytics/agents`).expect(200);
    expect(() => queries.assertAtMost(BATCHED_BUDGET)).toThrow(/database queries/);

    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({ analyticsAgentsBatched: { enabled: true } }),
    );
    queries.reset();
    await request(app).get(`/api/companies/${companyId}/analytics/agents`).expect(200);
    queries.assertAtMost(BATCHED_BUDGET);
  });

  it('keeps the batched cost flat as agents are added', async () => {
    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({ analyticsAgentsBatched: { enabled: true } }),
    );
    const url = `/api/companies/${companyId}/analytics/agents`;

    queries.reset();
    await request(app).get(url).expect(200);
    const withThreeAgentsFits = (() => {
      try {
        queries.assertAtMost(3);
        return true;
      } catch {
        return false;
      }
    })();
    expect(withThreeAgentsFits).toBe(true);

    for (const name of ['Extra one', 'Extra two', 'Extra three']) {
      await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name, role: 'engineer' })
        .expect(201);
    }

    queries.reset();
    const response = await request(app).get(url).expect(200);
    expect(response.body.data).toHaveLength(6);
    // Doubling the agent count must not change the query count.
    queries.assertAtMost(3);
  });
});
