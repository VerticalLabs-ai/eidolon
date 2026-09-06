import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer } from '../test-utils.js';
import { MissionStartService } from '../services/mission/start.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlags() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({
      missionAgentIntelligence: { enabled: true },
      missionPolish: { enabled: true },
    }),
  );
}

function disableMissionPolish() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({
      missionAgentIntelligence: { enabled: true },
      missionPolish: { enabled: false },
    }),
  );
}

function enableOnlyMissionAgentIntelligence() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({
      missionAgentIntelligence: { enabled: true },
    }),
  );
}

/** Start a root run through the service and return its id + snapshot. */
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

/** Insert a child run directly into the database. */
async function insertChildRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  rootRunId: string,
  parentRunId: string,
  depth: number,
  childOrdinal: number,
  status = 'queued',
  actualCostCents = 0,
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" (
      "id", "company_id", "project_id", "project_thread_id",
      "root_run_id", "parent_run_id", "depth", "child_ordinal",
      "routing_kind", "request_envelope", "request_content_hash",
      "resolved_mode", "status", "actual_cost_cents",
      "terminal_at", "created_at", "updated_at"
    ) VALUES (
      ${runId}, ${companyId}, ${projectId}, ${threadId},
      ${rootRunId}, ${parentRunId}, ${depth}, ${childOrdinal},
      'company_agent', 'encrypted-envelope', ${randomUUID()},
      'fast', ${status}, ${actualCostCents},
      ${isTerminal ? now : null}, ${now}, ${now}
    )
  `);
  return runId;
}

/** Insert a run_step_assignment for a child run. */
async function insertStepAssignment(
  db: AnyDb,
  companyId: string,
  projectId: string,
  rootRunId: string,
  parentRunId: string,
  runId: string,
  stepKey: string,
): Promise<void> {
  // First create a minimal plan revision to reference
  const revisionId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions" (
      "id", "company_id", "project_id", "run_id",
      "revision", "content_hash", "content"
    ) VALUES (
      ${revisionId}, ${companyId}, ${projectId}, ${rootRunId},
      1, ${randomUUID()}, ${JSON.stringify({ schemaVersion: 1, objective: 'test', steps: [] })}
    )
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "run_step_assignments" (
      "id", "company_id", "project_id",
      "root_run_id", "parent_run_id", "run_id", "step_key",
      "node_kind", "approved_plan_revision_id", "approved_content_hash",
      "assignment_status"
    ) VALUES (
      ${randomUUID()}, ${companyId}, ${projectId},
      ${rootRunId}, ${parentRunId}, ${runId}, ${stepKey},
      'child', ${revisionId}, ${randomUUID()},
      'pending_dependencies'
    )
  `);
}

describe('GET /api/companies/:cid/projects/:pid/mission-runs/:rid/children', () => {
  let db: AnyDb;
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let companyId: string;
  let projectId: string;
  let threadId: string;
  let otherCompanyId: string;
  let otherProjectId: string;
  let rootRunId: string;

  beforeAll(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
  });

  beforeEach(async () => {
    enableMissionFlags();
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ children endpoint', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Children Project' })
      .expect(201);
    projectId = project.body.data.id;
    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Children Thread' })
      .expect(201);
    threadId = thread.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ other children', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;
    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other Children Project' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    // Start a root run
    const result = await startRun(db, companyId, projectId, threadId, 'children-root-001');
    rootRunId = result.run.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const childrenUrl = (runId: string, query?: Record<string, unknown>) => {
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs/${runId}/children`;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        params.set(k, String(v));
      }
      return `${base}?${params.toString()}`;
    }
    return base;
  };

  // VAL-M1-016: /children returns empty tree for a run with no children
  it('returns a single-node tree (empty children) for a run with no children', async () => {
    const res = await request(app).get(childrenUrl(rootRunId)).expect(200);
    const tree = res.body.data.tree;
    expect(tree).toBeDefined();
    expect(tree.runId).toBe(rootRunId);
    expect(tree.children).toEqual([]);
    expect(tree.status).toBeDefined();
    expect(tree.cost).toBeDefined();
    expect(tree.routingInfo).toBeDefined();
    expect(tree.stepKey).toBeDefined();
  });

  // VAL-M1-015: /children returns tree structure for a run with children
  it('returns a tree structure with children for a run with children', async () => {
    const child1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
      'running',
      100,
    );
    const child2 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      2,
      'completed',
      200,
    );

    const res = await request(app).get(childrenUrl(rootRunId)).expect(200);
    const tree = res.body.data.tree;
    expect(tree.runId).toBe(rootRunId);
    expect(tree.children).toHaveLength(2);
    // Children ordered by creation sequence (child_ordinal)
    expect(tree.children[0].runId).toBe(child1);
    expect(tree.children[1].runId).toBe(child2);
  });

  // VAL-M1-023: Tree node includes all required fields
  it('includes all required fields in each tree node', async () => {
    await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
      'running',
      150,
    );

    const res = await request(app).get(childrenUrl(rootRunId)).expect(200);
    const tree = res.body.data.tree;
    const child = tree.children[0];

    expect(child).toHaveProperty('runId');
    expect(child).toHaveProperty('status');
    expect(child).toHaveProperty('cost');
    expect(child).toHaveProperty('routingInfo');
    expect(child).toHaveProperty('stepKey');
    expect(child).toHaveProperty('children');
    expect(child.routingInfo).toHaveProperty('mode');
    expect(child.routingInfo).toHaveProperty('model');
    expect(child.routingInfo).toHaveProperty('provider');
  });

  // VAL-M1-017: /children respects default maxDepth of 3
  it('respects default maxDepth of 3', async () => {
    // Create a chain: root -> child1 -> grandchild -> greatGrandchild -> greatGreatGrandchild
    const child1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
    );
    const grandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      child1,
      2,
      1,
    );
    const greatGrandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      grandchild,
      3,
      1,
    );
    const greatGreatGrandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      greatGrandchild,
      4,
      1,
    );

    const res = await request(app).get(childrenUrl(rootRunId)).expect(200);
    const tree = res.body.data.tree;

    // Depth 0: root
    expect(tree.runId).toBe(rootRunId);
    // Depth 1: child1
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].runId).toBe(child1);
    // Depth 2: grandchild
    expect(tree.children[0].children).toHaveLength(1);
    expect(tree.children[0].children[0].runId).toBe(grandchild);
    // Depth 3: greatGrandchild
    expect(tree.children[0].children[0].children).toHaveLength(1);
    expect(tree.children[0].children[0].children[0].runId).toBe(greatGrandchild);
    // Depth 4: greatGreatGrandchild should NOT be included (maxDepth=3)
    expect(tree.children[0].children[0].children[0].children).toHaveLength(0);
  });

  // VAL-M1-018: /children respects maxDepth query parameter up to 5
  it('respects maxDepth=1 (only immediate children)', async () => {
    const child1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
    );
    await insertChildRun(db, companyId, projectId, threadId, rootRunId, child1, 2, 1);

    const res = await request(app)
      .get(childrenUrl(rootRunId, { maxDepth: 1 }))
      .expect(200);
    const tree = res.body.data.tree;
    expect(tree.children).toHaveLength(1);
    // Grandchildren should not be included
    expect(tree.children[0].children).toHaveLength(0);
  });

  it('respects maxDepth=5 (expanded tree)', async () => {
    const child1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
    );
    const grandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      child1,
      2,
      1,
    );
    const greatGrandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      grandchild,
      3,
      1,
    );
    const greatGreatGrandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      greatGrandchild,
      4,
      1,
    );
    const depth5 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      greatGreatGrandchild,
      5,
      1,
    );

    const res = await request(app)
      .get(childrenUrl(rootRunId, { maxDepth: 5 }))
      .expect(200);
    const tree = res.body.data.tree;
    // Navigate to depth 5
    let node = tree;
    for (let i = 0; i < 4; i++) {
      expect(node.children).toHaveLength(1);
      node = node.children[0];
    }
    // At depth 5, the child should be included
    expect(node.children).toHaveLength(1);
    expect(node.children[0].runId).toBe(depth5);
  });

  it('clamps maxDepth above 5 to 5', async () => {
    const child1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
    );
    const grandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      child1,
      2,
      1,
    );
    const greatGrandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      grandchild,
      3,
      1,
    );
    const greatGreatGrandchild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      greatGrandchild,
      4,
      1,
    );
    const depth5 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      greatGreatGrandchild,
      5,
      1,
    );
    const depth6 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      depth5,
      6,
      1,
    );

    // maxDepth=10 should be clamped to 5
    const res = await request(app)
      .get(childrenUrl(rootRunId, { maxDepth: 10 }))
      .expect(200);
    const tree = res.body.data.tree;
    // Navigate to depth 5
    let node = tree;
    for (let i = 0; i < 4; i++) {
      expect(node.children).toHaveLength(1);
      node = node.children[0];
    }
    // Depth 5 child should be included
    expect(node.children).toHaveLength(1);
    expect(node.children[0].runId).toBe(depth5);
    // Depth 6 should NOT be included (clamped to 5)
    expect(node.children[0].children).toHaveLength(0);
  });

  // VAL-M1-019: /children returns 404 when run does not exist
  it('returns 404 when run does not exist', async () => {
    const fakeRunId = randomUUID();
    const res = await request(app).get(childrenUrl(fakeRunId)).expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  // VAL-M1-020: /children returns 404 when missionPolish flag is disabled
  it('returns 404 when missionPolish flag is disabled', async () => {
    disableMissionPolish();
    const res = await request(app).get(childrenUrl(rootRunId)).expect(404);
    expect(res.body.code).toBe('FEATURE_NOT_AVAILABLE');
  });

  // VAL-M1-022: /children returns 404 when project does not belong to company
  it('returns 404 when project does not belong to company', async () => {
    const url = `/api/companies/${companyId}/projects/${otherProjectId}/mission-runs/${rootRunId}/children`;
    await request(app).get(url).expect(404);
  });

  // VAL-M1-021: /children requires company-scoped auth (cross-company returns 404)
  it('returns 404 for a run belonging to a different company', async () => {
    const otherThread = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects/${otherProjectId}/threads`)
      .send({ title: 'Other Thread' })
      .expect(201);
    const otherResult = await startRun(
      db,
      otherCompanyId,
      otherProjectId,
      otherThread.body.data.id,
      'children-other-001',
    );
    // Try to access other company's run from this company's context
    const url = `/api/companies/${companyId}/projects/${projectId}/mission-runs/${otherResult.run.id}/children`;
    const res = await request(app).get(url).expect(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  // VAL-M1-035: /children tree preserves parent-child ordering
  it.each([
    { order: 'creation time', offsets: [2, 0, 1], expectedOrder: [2, 3, 1] },
    {
      order: 'child ordinal when creation timestamps tie',
      offsets: [0, 0, 0],
      expectedOrder: [1, 2, 3],
    },
  ])('preserves parent-child ordering by $order', async ({ offsets, expectedOrder }) => {
    // Insert in reverse order so storage order cannot satisfy the assertion.
    const child3 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      3,
      'failed',
    );
    const child2 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      2,
      'completed',
    );
    const child1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
      'running',
    );

    const children = [child1, child2, child3];
    for (const [index, childId] of children.entries()) {
      const createdAt = new Date(Date.UTC(2026, 0, 1) + offsets[index]! * 1000);
      await db.drizzle.execute(sql`
        UPDATE mission_runs SET created_at = ${createdAt} WHERE id = ${childId}
      `);
    }

    const res = await request(app).get(childrenUrl(rootRunId)).expect(200);
    const tree = res.body.data.tree;
    expect(tree.children.map((child: { runId: string }) => child.runId)).toEqual(
      expectedOrder.map((ordinal) => children[ordinal - 1]),
    );
  });

  // VAL-M1-109: Circular parent references handled gracefully
  it('handles circular parent references gracefully (CTE terminates at maxDepth)', async () => {
    const child1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
    );
    // Create a cycle: child1 -> child2 -> child1
    const child2 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      child1,
      2,
      1,
    );
    // Point child1's parent_run_id to child2 (creating a cycle)
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "parent_run_id" = ${child2} WHERE "id" = ${child1}
    `);

    // The CTE should terminate at maxDepth without infinite recursion
    const res = await request(app)
      .get(childrenUrl(rootRunId, { maxDepth: 3 }))
      .expect(200);
    const tree = res.body.data.tree;
    expect(tree.runId).toBe(rootRunId);
    // The tree should contain some nodes without hanging
    expect(tree).toBeDefined();
  });

  it('serializes a reachable parent cycle without duplicate nodes or back-edges', async () => {
    const child = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
    );
    await db.drizzle.execute(
      sql`UPDATE mission_runs SET parent_run_id = ${child} WHERE id = ${rootRunId}`,
    );
    const res = await request(app)
      .get(childrenUrl(rootRunId, { maxDepth: 3 }))
      .expect(200);
    expect(res.body.data.tree.runId).toBe(rootRunId);
    expect(res.body.data.tree.children).toHaveLength(1);
    expect(res.body.data.tree.children[0].runId).toBe(child);
    expect(res.body.data.tree.children[0].children).toEqual([]);
  });

  // VAL-M1-114: /children handles run in terminal state
  it('handles a run in terminal state (completed)', async () => {
    // Set root run to completed (must also set terminal_at due to chk_mission_runs_terminal_at)
    const now = new Date();
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'completed', "terminal_at" = ${now} WHERE "id" = ${rootRunId}
    `);
    const child1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
      'completed',
      500,
    );
    const child2 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      2,
      'failed',
      100,
    );

    const res = await request(app).get(childrenUrl(rootRunId)).expect(200);
    const tree = res.body.data.tree;
    expect(tree.status).toBe('completed');
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].status).toBe('completed');
    expect(tree.children[1].status).toBe('failed');
  });

  // VAL-M1-117: maxDepth=0 returns 400
  it('returns 400 for maxDepth=0', async () => {
    const res = await request(app)
      .get(childrenUrl(rootRunId, { maxDepth: 0 }))
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // VAL-M1-118: Negative maxDepth returns 400
  it('returns 400 for negative maxDepth', async () => {
    const res = await request(app)
      .get(childrenUrl(rootRunId, { maxDepth: -1 }))
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // VAL-M1-119: Non-numeric maxDepth returns 400
  it('returns 400 for non-numeric maxDepth', async () => {
    const res = await request(app)
      .get(childrenUrl(rootRunId, { maxDepth: 'abc' }))
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // VAL-M1-102: missionPolish requires missionAgentIntelligence (layering)
  it('returns 404 when missionAgentIntelligence is disabled but missionPolish is enabled', async () => {
    enableOnlyMissionAgentIntelligence();
    // This actually disables missionPolish because the layering rule
    // requires missionAgentIntelligence to be enabled first
    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({
        missionAgentIntelligence: { enabled: false },
        missionPolish: { enabled: true },
      }),
    );
    const res = await request(app).get(childrenUrl(rootRunId)).expect(404);
    expect(res.body.code).toBe('FEATURE_NOT_AVAILABLE');
  });
});
