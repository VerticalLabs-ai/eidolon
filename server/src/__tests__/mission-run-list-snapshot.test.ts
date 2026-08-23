import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

/** Start a run through the service and return its id + snapshot. */
async function startRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  key: string,
  text = 'Do work',
) {
  const service = new MissionStartService(db);
  return service.start({
    companyId,
    projectId,
    idempotencyKey: key,
    body: { projectThreadId: threadId, mode: 'fast', request: { text } },
    actorType: 'user',
    actorId: 'dev-user-000',
  });
}

/**
 * Directly mutate a snapshot-visible field on a run and bump state_version,
 * simulating what a later feature's applied command transaction would do.
 * Used to prove the ETag covers the complete aggregate (VAL-RUN-129).
 */
async function mutateRun(
  db: AnyDb,
  runId: string,
  patch: Record<string, unknown>,
  bumpVersion = true,
) {
  const setClauses = [];
  for (const [k, v] of Object.entries(patch)) {
    setClauses.push(sql`"${sql.raw(k)}" = ${v}`);
  }
  if (bumpVersion) {
    setClauses.push(sql`"state_version" = "state_version" + 1`);
    setClauses.push(sql`"updated_at" = ${new Date()}`);
  }
  const setExpr = sql.join(setClauses, sql`, `);
  await db.drizzle.execute(sql`UPDATE "mission_runs" SET ${setExpr} WHERE "id" = ${runId}`);
}

// ---------------------------------------------------------------------------
// VAL-RUN-019: Run list is scoped and stable
// ---------------------------------------------------------------------------

describe('Mission run list (VAL-RUN-019)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let otherCompanyId: string;
  let otherProjectId: string;
  let otherThreadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ list scope', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'List Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'List Thread' })
      .expect(201);
    threadId = thread.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ other list', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other List Project' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;
    const otherThread = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects/${otherProjectId}/threads`)
      .send({ title: 'Other List Thread' })
      .expect(201);
    otherThreadId = otherThread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const listUrl = () => `/api/companies/${companyId}/projects/${projectId}/mission-runs`;

  it('returns only runs from the requested company/project', async () => {
    await startRun(db, companyId, projectId, threadId, 'list-scope-001');
    await startRun(db, companyId, projectId, threadId, 'list-scope-002');
    // A run in another company/project must NOT appear.
    await startRun(db, otherCompanyId, otherProjectId, otherThreadId, 'list-scope-other');

    const res = await request(app).get(listUrl()).expect(200);
    expect(Array.isArray(res.body.data.runs)).toBe(true);
    expect(res.body.data.runs).toHaveLength(2);
    for (const run of res.body.data.runs) {
      expect(run.companyId).toBe(companyId);
      expect(run.projectId).toBe(projectId);
    }
    // No cross-scope leakage.
    expect(JSON.stringify(res.body)).not.toContain(otherCompanyId);
  });

  it('returns runs ordered by createdAt DESC, id DESC', async () => {
    const r1 = await startRun(db, companyId, projectId, threadId, 'list-order-001', 'first');
    const r2 = await startRun(db, companyId, projectId, threadId, 'list-order-002', 'second');
    const r3 = await startRun(db, companyId, projectId, threadId, 'list-order-003', 'third');

    const res = await request(app).get(listUrl()).expect(200);
    const ids = res.body.data.runs.map((r: { id: string }) => r.id);
    // Newest first.
    expect(ids).toEqual([r3.run.id, r2.run.id, r1.run.id]);
  });

  it('honors a valid status filter', async () => {
    const a = await startRun(db, companyId, projectId, threadId, 'list-status-001');
    const b = await startRun(db, companyId, projectId, threadId, 'list-status-002');
    // Move b to a different status directly.
    await mutateRun(db, b.run.id, { status: 'planning' });

    const res = await request(app).get(listUrl()).query({ status: 'planning' }).expect(200);
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.runs[0].id).toBe(b.run.id);
    expect(res.body.data.runs[0].status).toBe('planning');

    // The queued run (fast mode auto-enqueued) is excluded from the
    // planning filter.
    const queuedRes = await request(app).get(listUrl()).query({ status: 'queued' }).expect(200);
    expect(queuedRes.body.data.runs).toHaveLength(1);
    expect(queuedRes.body.data.runs[0].id).toBe(a.run.id);
  });

  it('rejects an invalid status filter with 400 VALIDATION_ERROR', async () => {
    const res = await request(app).get(listUrl()).query({ status: 'turbo' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('supports stable opaque cursor pagination without duplicates or skips', async () => {
    // Create 5 runs.
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await startRun(db, companyId, projectId, threadId, `list-page-${i}`, `run ${i}`);
      created.push(r.run.id);
    }
    // Expected order: newest first.
    const expected = [...created].reverse();

    // Page through with limit=2.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await request(app)
        .get(listUrl())
        .query({ limit: 2, ...(cursor ? { cursor } : {}) })
        .expect(200);
      const runs = res.body.data.runs as { id: string }[];
      for (const r of runs) {
        seen.push(r.id);
      }
      cursor = res.body.data.nextCursor;
      if (!cursor) {
        break;
      }
    }

    // Every run appears exactly once, in the expected order, no skips.
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(created.length);
  });

  it('pagination is stable under concurrent insertion during traversal', async () => {
    // Create 3 runs, then page with limit=2; after the first page, insert a
    // new run, then continue. The anchored keyset must not duplicate or skip.
    const created: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await startRun(db, companyId, projectId, threadId, `list-stable-${i}`, `run ${i}`);
      created.push(r.run.id);
    }
    const expectedFirstPage = [...created].reverse().slice(0, 2);

    const first = await request(app).get(listUrl()).query({ limit: 2 }).expect(200);
    expect(first.body.data.runs.map((r: { id: string }) => r.id)).toEqual(expectedFirstPage);
    expect(first.body.data.nextCursor).toBeTruthy();

    // Insert a newer run mid-traversal.
    const inserted = await startRun(
      db,
      companyId,
      projectId,
      threadId,
      'list-stable-insert',
      'inserted',
    );

    const second = await request(app)
      .get(listUrl())
      .query({ limit: 2, cursor: first.body.data.nextCursor })
      .expect(200);
    // The second page continues from the anchor, NOT from the top, so the
    // inserted run is not duplicated into this traversal and the 3rd original
    // run is not skipped.
    const secondIds = second.body.data.runs.map((r: { id: string }) => r.id);
    expect(secondIds).toContain(created[0]); // oldest original run
    expect(secondIds).not.toContain(inserted.run.id); // not re-introduced here
    // No duplicates across the whole traversal.
    const all = [...first.body.data.runs.map((r: { id: string }) => r.id), ...secondIds];
    expect(new Set(all).size).toBe(all.length);
  });

  it('rejects an invalid limit with 400 VALIDATION_ERROR', async () => {
    await request(app).get(listUrl()).query({ limit: 0 }).expect(400);
    await request(app).get(listUrl()).query({ limit: 101 }).expect(400);
    await request(app).get(listUrl()).query({ limit: 'abc' }).expect(400);
  });

  it('rejects a malformed cursor with 400 VALIDATION_ERROR', async () => {
    const res = await request(app).get(listUrl()).query({ cursor: '!!!not-base64!!!' }).expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns an empty page and null nextCursor when there are no runs', async () => {
    const res = await request(app).get(listUrl()).expect(200);
    expect(res.body.data.runs).toEqual([]);
    expect(res.body.data.nextCursor).toBeNull();
  });

  it('does not leak runs from another project in the same company', async () => {
    // A second project in the same company.
    const secondProject = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Second Project' })
      .expect(201);
    const secondProjectId = secondProject.body.data.id;
    const secondThread = await request(app)
      .post(`/api/companies/${companyId}/projects/${secondProjectId}/threads`)
      .send({ title: 'Second Thread' })
      .expect(201);
    const secondThreadId = secondThread.body.data.id;

    await startRun(db, companyId, projectId, threadId, 'list-proj-001');
    await startRun(db, companyId, secondProjectId, secondThreadId, 'list-proj-other');

    const res = await request(app).get(listUrl()).expect(200);
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.runs[0].projectId).toBe(projectId);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-020: Run snapshot contains recovery state
// ---------------------------------------------------------------------------

describe('Mission run snapshot recovery state (VAL-RUN-020)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ snapshot', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Snapshot Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Snapshot Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the authoritative status, state version, latest sequence, policy/request identity, and budget', async () => {
    const start = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('Idempotency-Key', 'snap-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'Snapshot me' } })
      .expect(202);
    const runId = start.body.data.run.id;

    const res = await request(app)
      .get(`/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}`)
      .expect(200);

    const run = res.body.data.run;
    // Authoritative identity + recovery fields.
    expect(run.id).toBe(runId);
    expect(run.companyId).toBe(companyId);
    expect(run.projectId).toBe(projectId);
    expect(run.projectThreadId).toBe(threadId);
    expect(run.status).toBe('queued');
    expect(run.stateVersion).toBe(2);
    expect(run.lastEventSequence).toBe(5);
    expect(run.resolvedMode).toBe('fast');
    expect(run.policySnapshotId).toBeTruthy();
    expect(run.policyContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(run.requestContentHash).toMatch(/^[0-9a-f]{64}$/);
    // Budget summary.
    expect(run.budget).toBeDefined();
    expect(run.budget.reservedCents).toBeGreaterThan(0);
    expect(run.budget.settledCents).toBe(0);
    expect(run.budget.releasedCents).toBe(0);
    expect(run.budget.costCentsCeiling).toBe(run.budget.reservedCents);
    // Pointers + lifecycle + counters + child summary + links.
    expect(run).toHaveProperty('currentQuestionSetId');
    expect(run).toHaveProperty('currentPlanRevisionId');
    expect(run).toHaveProperty('approvedPlanRevisionId');
    expect(run).toHaveProperty('cancelRequestedAt');
    expect(run).toHaveProperty('failureCategory');
    expect(run).toHaveProperty('safeErrorMessage');
    expect(run).toHaveProperty('startedAt');
    expect(run).toHaveProperty('terminalAt');
    expect(run).toHaveProperty('attemptCount');
    expect(run).toHaveProperty('actualCostCents');
    expect(run).toHaveProperty('childSummary');
    expect(run.childSummary).toEqual({
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: 0,
    });
    expect(run).toHaveProperty('artifacts');
    expect(run.artifacts).toEqual([]);
    expect(run.links.ui).toContain(runId);
    // Strong quoted ETag.
    expect(res.headers.etag).toBe(`"${run.stateVersion}"`);
  });

  it('returns 404 RUN_NOT_FOUND for a cross-scope run id without revealing existence', async () => {
    const start = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('Idempotency-Key', 'snap-xscope-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);
    const runId = start.body.data.run.id;

    // A different company.
    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ snap other', settings: { testFixture: true } })
      .expect(201);
    const otherCompanyId = otherCompany.body.data.id;
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other' })
      .expect(201);
    const otherProjectId = otherProject.body.data.id;

    const res = await request(app)
      .get(`/api/companies/${otherCompanyId}/projects/${otherProjectId}/mission-runs/${runId}`)
      .expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-021: Snapshot supports conditional refresh
// ---------------------------------------------------------------------------

describe('Mission run conditional refresh (VAL-RUN-021)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ conditional', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Conditional Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Conditional Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 304 with no body when If-None-Match matches the current ETag', async () => {
    const start = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('Idempotency-Key', 'cond-304-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);
    const etag = start.headers.etag;

    const res = await request(app)
      .get(
        `/api/companies/${companyId}/projects/${projectId}/mission-runs/${start.body.data.run.id}`,
      )
      .set('If-None-Match', etag)
      .expect(304);
    expect(res.body).toEqual({});
    expect(res.headers.etag).toBe(etag);
  });

  it('returns 200 with the newer snapshot and changed ETag after a transition', async () => {
    const start = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('Idempotency-Key', 'cond-200-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);
    const runId = start.body.data.run.id;
    const oldEtag = start.headers.etag;

    // Simulate a state transition (later feature's command).
    await mutateRun(db, runId, { status: 'planning' });

    // Old If-None-Match no longer matches → 200 with new body + new ETag.
    const res = await request(app)
      .get(`/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}`)
      .set('If-None-Match', oldEtag)
      .expect(200);
    expect(res.body.data.run.status).toBe('planning');
    expect(res.body.data.run.stateVersion).toBe(3);
    expect(res.headers.etag).toBe(`"3"`);
    expect(res.headers.etag).not.toBe(oldEtag);
  });

  it('returns 200 when If-None-Match is absent', async () => {
    const start = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/mission-runs`)
      .set('Idempotency-Key', 'cond-noheader-001')
      .send({ projectThreadId: threadId, mode: 'fast', request: { text: 'x' } })
      .expect(202);

    const res = await request(app)
      .get(
        `/api/companies/${companyId}/projects/${projectId}/mission-runs/${start.body.data.run.id}`,
      )
      .expect(200);
    expect(res.body.data.run.id).toBe(start.body.data.run.id);
  });
});

// ---------------------------------------------------------------------------
// VAL-RUN-129: Snapshot validator covers the complete aggregate
// ---------------------------------------------------------------------------

describe('Mission run aggregate ETag (VAL-RUN-129)', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlag();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ aggregate etag', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Aggregate Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Aggregate Thread' })
      .expect(201);
    threadId = thread.body.data.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const detailUrl = (runId: string) =>
    `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}`;

  it('an unchanged aggregate returns 304', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'agg-unchanged-001');
    const etag = `"${start.run.stateVersion}"`;

    const res = await request(app)
      .get(detailUrl(start.run.id))
      .set('If-None-Match', etag)
      .expect(304);
    expect(res.body).toEqual({});
  });

  /**
   * Each snapshot-visible mutation changes the strong ETag even when the
   * lifecycle status does not change. We mutate one field at a time (bumping
   * state_version, as an applied command would) and assert the ETag changes,
   * the snapshot reflects the new value, and the old ETag no longer matches.
   */
  const mutationCases: Array<{
    name: string;
    patch: Record<string, unknown>;
    field: string;
    expect: unknown;
  }> = [
    {
      name: 'currentQuestionSetId pointer',
      patch: { current_question_set_id: 'qset-001' },
      field: 'currentQuestionSetId',
      expect: 'qset-001',
    },
    {
      name: 'currentPlanRevisionId pointer',
      patch: { current_plan_revision_id: 'plan-001' },
      field: 'currentPlanRevisionId',
      expect: 'plan-001',
    },
    {
      name: 'approvedPlanRevisionId pointer',
      patch: { approved_plan_revision_id: 'plan-001' },
      field: 'approvedPlanRevisionId',
      expect: 'plan-001',
    },
    {
      name: 'cancellation request',
      patch: { cancel_requested_at: new Date(), cancel_requested_by: 'dev-user-000' },
      field: 'cancelRequestedAt',
      expect: expect.any(String),
    },
    {
      name: 'failure details',
      patch: {
        failure_category: 'provider_permanent',
        failure_code: 'PROVIDER_400',
        safe_error_message: 'The provider rejected the request.',
      },
      field: 'failureCategory',
      expect: 'provider_permanent',
    },
    {
      name: 'actual cost cents',
      patch: { actual_cost_cents: 123 },
      field: 'actualCostCents',
      expect: 123,
    },
    {
      name: 'attempt count',
      patch: { attempt_count: 2 },
      field: 'attemptCount',
      expect: 2,
    },
    {
      name: 'last event sequence',
      patch: { last_event_sequence: 9 },
      field: 'lastEventSequence',
      expect: 9,
    },
    {
      name: 'output tokens counter',
      patch: { output_tokens: 500 },
      field: 'outputTokens',
      expect: 500,
    },
    {
      name: 'startedAt timestamp',
      patch: { started_at: new Date() },
      field: 'startedAt',
      expect: expect.any(String),
    },
  ];

  for (const c of mutationCases) {
    it(`changes the ETag when only "${c.name}" changes (status unchanged)`, async () => {
      const start = await startRun(db, companyId, projectId, threadId, `agg-${c.name}-001`);
      const beforeRes = await request(app).get(detailUrl(start.run.id)).expect(200);
      const beforeEtag = beforeRes.headers.etag;
      const beforeStatus = beforeRes.body.data.run.status;

      await mutateRun(db, start.run.id, c.patch);

      const afterRes = await request(app).get(detailUrl(start.run.id)).expect(200);
      expect(afterRes.headers.etag).not.toBe(beforeEtag);
      // Status unchanged but ETag advanced.
      expect(afterRes.body.data.run.status).toBe(beforeStatus);
      expect(afterRes.body.data.run.stateVersion).toBe(start.run.stateVersion + 1);
      expect(afterRes.body.data.run[c.field]).toEqual(c.expect);

      // Old ETag no longer matches → 200.
      const stale = await request(app)
        .get(detailUrl(start.run.id))
        .set('If-None-Match', beforeEtag)
        .expect(200);
      expect(stale.headers.etag).toBe(afterRes.headers.etag);

      // New ETag matches → 304.
      await request(app)
        .get(detailUrl(start.run.id))
        .set('If-None-Match', afterRes.headers.etag)
        .expect(304);
    });
  }

  it('changes the ETag when budget settled cents change (status unchanged)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'agg-budget-001');
    const beforeEtag = (await request(app).get(detailUrl(start.run.id)).expect(200)).headers.etag;

    // Settle some budget directly (simulating a later feature's settlement).
    await db.drizzle.execute(sql`
      UPDATE "budget_reservations"
      SET "settled_cents" = 50, "status" = 'partially_settled', "updated_at" = ${new Date()}
      WHERE "run_id" = ${start.run.id}
    `);
    await db.drizzle.execute(sql`
      UPDATE "budget_allocations"
      SET "settled_cents" = 50, "status" = 'partially_settled', "updated_at" = ${new Date()}
      WHERE "run_id" = ${start.run.id}
    `);
    // The run's state_version must advance so the ETag reflects the budget
    // change (an applied settlement command would do both in one transaction).
    await mutateRun(db, start.run.id, { actual_cost_cents: 50 });

    const afterRes = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(afterRes.headers.etag).not.toBe(beforeEtag);
    expect(afterRes.body.data.run.budget.settledCents).toBe(50);
    expect(afterRes.body.data.run.budget.actualCostCents).toBe(50);
    expect(afterRes.body.data.run.status).toBe('queued');
  });

  it('changes the ETag when a child summary changes (status unchanged)', async () => {
    const start = await startRun(db, companyId, projectId, threadId, 'agg-child-001');
    const beforeEtag = (await request(app).get(detailUrl(start.run.id)).expect(200)).headers.etag;
    expect(beforeEtag).toBeDefined();

    // Insert a child run directly (simulating a later feature's child creation
    // that would bump the parent's state_version in the same transaction).
    const childId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id","company_id","project_id","project_thread_id","root_run_id",
        "parent_run_id","depth","child_ordinal","request_envelope","request_content_hash",
        "resolved_mode","status","state_version","last_event_sequence","created_at","updated_at")
      VALUES (${childId},${companyId},${projectId},${threadId},${start.run.id},
        ${start.run.id},1,1,'{}'::jsonb,'x','fast','running',1,0,${now},${now})
    `);
    await mutateRun(db, start.run.id, { descendant_count: 1 });

    const afterRes = await request(app).get(detailUrl(start.run.id)).expect(200);
    expect(afterRes.headers.etag).not.toBe(beforeEtag);
    expect(afterRes.body.data.run.childSummary.running).toBe(1);
    expect(afterRes.body.data.run.childSummary.total).toBe(1);
    expect(afterRes.body.data.run.status).toBe('queued');
  });
});
