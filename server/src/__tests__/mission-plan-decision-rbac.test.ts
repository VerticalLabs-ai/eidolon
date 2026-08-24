import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import { PlannerTestHarness, HARNESS_ENV_FLAG } from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';
import { hashAgentKey, AGENT_KEY_PREFIX } from '../middleware/agent-key-auth.js';

/**
 * Enforce exact human governance roles, scope, and actor attribution.
 *
 * (VAL-PLAN-052, 053, 054, 056, 057, 058, 059, 105, 123)
 *
 * Exercises owner/admin/member/viewer/agent matrices, cross-company/project
 * IDs, actor spoofing, and revision/rejection authority.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
}

function enableHarness() {
  vi.stubEnv(HARNESS_ENV_FLAG, '1');
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

/** Seed a second company/project/thread for cross-scope tests. */
async function seedForeignScope(db: AnyDb, label: string) {
  return seedScope(db, label);
}

/** Create an agent API key in the DB and return the raw bearer token. */
async function createAgentKey(
  db: AnyDb,
  companyId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer' = 'member',
): Promise<string> {
  const keyId = randomUUID();
  const rawKey = `${AGENT_KEY_PREFIX}${randomUUID().replace(/-/g, '')}`;
  const keyHash = hashAgentKey(rawKey);
  const keyPrefix = rawKey.slice(0, 10);
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "agent_api_keys" ("id", "company_id", "name", "key_hash", "key_prefix", "role", "created_by_user_id", "created_at", "updated_at")
    VALUES (${keyId}, ${companyId}, 'test-agent-key', ${keyHash}, ${keyPrefix}, ${role}, 'dev-user-000', ${now}, ${now})
  `);
  return rawKey;
}

function validPlanContent(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Analyze the quarterly report',
    steps: [
      {
        stepKey: 'step-1',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root',
        title: 'Gather data',
        description: 'Collect the quarterly data',
        dependencies: [],
        inputBindings: [],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['analysis'],
            requiredTools: ['research.search'],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: ['research.search'],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['report-data'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Data collected',
        budgetCents: 100,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize the report',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-1', output: 'report-data' }],
      declaredOutput: 'final-report',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'Report complete',
      budgetCents: 100,
    },
    planningBudgetCents: 100,
    partialResultPolicy: 'require_all',
    limits: {
      steps: 4,
      durationSeconds: 300,
      providerCalls: 6,
      totalTokens: 32000,
      outputBytes: 1048576,
      costCents: 500,
      depth: 0,
      fanOut: 0,
      descendants: 0,
    },
    ...overrides,
  };
}

async function startPlanningRun(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  threadId: string,
  text = 'Analyze the quarterly report with multiple deliverables and dependencies',
) {
  return request(app)
    .post(base)
    .set('Idempotency-Key', `plan-${randomUUID()}`)
    .send({ projectThreadId: threadId, mode: 'deep_work', request: { text } })
    .expect(202);
}

/** Publish a valid plan via the harness and get the run into awaiting_approval. */
async function publishPlanAndWait(
  db: AnyDb,
  runId: string,
  planContent: unknown = validPlanContent(),
) {
  const harness = new PlannerTestHarness({ vectors: [{ content: planContent }] });
  const planner = new PlannerService(db, { generator: harness });
  const coordinator = new RunCoordinator(db);
  const claim = await coordinator.claimNext('test-worker');
  expect(claim).not.toBeNull();
  await planner.plan(claim!, new AbortController().signal);
  await coordinator.release(claim!);
}

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "current_plan_revision_id", "approved_plan_revision_id"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    status: row['status'] as string,
    stateVersion: Number(row['state_version']),
    currentPlanRevisionId: (row['current_plan_revision_id'] as string) ?? null,
    approvedPlanRevisionId: (row['approved_plan_revision_id'] as string) ?? null,
  };
}

async function getCurrentRevision(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT rpr."id", rpr."revision", rpr."status", rpr."content_hash"
    FROM "run_plan_revisions" rpr
    JOIN "mission_runs" mr ON mr."current_plan_revision_id" = rpr."id"
    WHERE mr."id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  return {
    id: rows[0]['id'] as string,
    revision: rows[0]['revision'] as number,
    status: rows[0]['status'] as string,
    contentHash: rows[0]['content_hash'] as string,
  };
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload", "actor_type", "actor_id"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{
    sequence: string | number;
    type: string;
    payload: Record<string, unknown>;
    actor_type: string;
    actor_id: string | null;
  }>;
  return rows.map((r) => ({
    ...r,
    sequence: Number(r.sequence),
    actorType: r.actor_type,
    actorId: r.actor_id,
  }));
}

async function getApprovalBindings(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "plan_revision_id", "decision", "deciding_user_id"
    FROM "run_plan_approval_bindings" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    planRevisionId: r['plan_revision_id'] as string,
    decision: (r['decision'] as string) ?? null,
    decidingUserId: (r['deciding_user_id'] as string) ?? null,
  }));
}

/** Helper: set up a run in awaiting_approval and return context. */
async function setupAwaitingApproval(db: AnyDb, label: string) {
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
  const app = await createTestServer(db);
  const res = await startPlanningRun(app, base, threadId);
  const runId = res.body.data.run.id as string;
  await publishPlanAndWait(db, runId);
  const row = await getRunRow(db, runId);
  expect(row!.status).toBe('awaiting_approval');
  const revision = await getCurrentRevision(db, runId);
  expect(revision).not.toBeNull();
  return { db, app, base, runId, row, revision, companyId, projectId, threadId };
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-PLAN-052: Owner can approve and reject
// ---------------------------------------------------------------------------

describe('VAL-PLAN-052: Owner can approve and reject', () => {
  it('allows owner to approve a current plan', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-owner-approve');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    expect(res.body.data.run.status).toBe('queued');

    // The deciding actor in the event is the authenticated user.
    const events = await getEvents(db, ctx.runId);
    const approvedEvent = events.find((e) => e.type === 'plan.approved');
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.actorType).toBe('user');
    expect(approvedEvent!.actorId).toBeTruthy();

    await closeTestDb();
  });

  it('allows owner to reject a current plan', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-owner-reject');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'Not what we need',
      })
      .expect(200);

    expect(res.body.data.run.status).toBe('cancelled');

    const events = await getEvents(db, ctx.runId);
    const rejectedEvent = events.find((e) => e.type === 'plan.rejected');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent!.actorType).toBe('user');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-053: Admin can approve and reject
// ---------------------------------------------------------------------------

describe('VAL-PLAN-053: Admin can approve and reject', () => {
  it('allows admin to approve a current plan', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-admin-approve');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'admin')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    expect(res.body.data.run.status).toBe('queued');

    const bindings = await getApprovalBindings(db, ctx.runId);
    expect(bindings[0].decision).toBe('approved');

    await closeTestDb();
  });

  it('allows admin to reject a current plan', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-admin-reject');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'admin')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'Budget too high',
      })
      .expect(200);

    expect(res.body.data.run.status).toBe('cancelled');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-054: Member cannot approve or reject
// ---------------------------------------------------------------------------

describe('VAL-PLAN-054: Member cannot approve or reject', () => {
  it('denies member approval with 403 INSUFFICIENT_PERMISSION', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-member-approve');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    // Run remains unchanged.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.approvedPlanRevisionId).toBeNull();

    // No decision event.
    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.approved')).toBeUndefined();

    await closeTestDb();
  });

  it('denies member rejection with 403 INSUFFICIENT_PERMISSION', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-member-reject');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'I disagree',
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeUndefined();

    await closeTestDb();
  });

  it('denies viewer approval with 403', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-viewer-approve');

    // Viewer cannot even POST (content.create denied at mount level).
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'viewer')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-056: Approval permission is server enforced
// ---------------------------------------------------------------------------

describe('VAL-PLAN-056: Approval permission is server enforced', () => {
  it('denies a forged member approval via the canonical command endpoint', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-forged-approve');

    // Submit directly via the canonical command endpoint as a member.
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', `cmd-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        type: 'plan.approve',
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    // State unchanged.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.approvedPlanRevisionId).toBeNull();

    await closeTestDb();
  });

  it('denies a forged member rejection via the canonical command endpoint', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-forged-reject');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', `cmd-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        type: 'plan.reject',
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'Forged rejection',
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-057: Cross-company plan is hidden
// ---------------------------------------------------------------------------

describe('VAL-PLAN-057: Cross-company plan is hidden', () => {
  it('returns 404 for cross-company plan read and decision', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-xco-plan');
    const foreign = await seedForeignScope(db, '__mtest__ rbac-xco-foreign');
    const foreignBase = `/api/companies/${foreign.companyId}/projects/${foreign.projectId}/mission-runs`;

    // Read the plan from the foreign company's scope — scope-safe 404
    // that reveals neither existence nor metadata.
    const planRes = await request(ctx.app).get(`${foreignBase}/${ctx.runId}/plan`).expect(404);
    // Either RUN_NOT_FOUND or PLAN_NOT_FOUND is acceptable — both are
    // non-enumerating 404s that do not reveal the run exists elsewhere.
    expect(planRes.body.code).toMatch(/RUN_NOT_FOUND|PLAN_NOT_FOUND/);

    // Attempt to approve through the foreign company's route.
    const approveRes = await request(ctx.app)
      .post(`${foreignBase}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(404);

    expect(approveRes.body.code).toBe('RUN_NOT_FOUND');

    // The real run remains unchanged.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.approvedPlanRevisionId).toBeNull();

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-058: Cross-project plan is hidden
// ---------------------------------------------------------------------------

describe('VAL-PLAN-058: Cross-project plan is hidden', () => {
  it('returns 404 for cross-project plan reads and decisions', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-xproj-plan');
    // Create a second project in the SAME company.
    const now = new Date();
    const otherProjectId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
      VALUES (${otherProjectId}, ${ctx.companyId}, 'Other', 'active', ${now}, ${now})
    `);
    const wrongBase = `/api/companies/${ctx.companyId}/projects/${otherProjectId}/mission-runs`;

    // Read through the wrong project scope.
    const snapshotRes = await request(ctx.app).get(`${wrongBase}/${ctx.runId}`).expect(404);
    expect(snapshotRes.body.code).toBe('RUN_NOT_FOUND');

    // Attempt to approve through the wrong project.
    const approveRes = await request(ctx.app)
      .post(`${wrongBase}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(404);

    expect(approveRes.body.code).toBe('RUN_NOT_FOUND');

    // The real run remains unchanged.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-059: Audit actor cannot be spoofed
// ---------------------------------------------------------------------------

describe('VAL-PLAN-059: Audit actor cannot be spoofed', () => {
  it('ignores spoofed actor fields in the approve body and records the authenticated user', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-spoof-approve');

    const spoofedActorId = randomUUID();
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      // Attempt to inject actor fields — they should be stripped by Zod.
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        actorId: spoofedActorId,
        actorType: 'agent',
        userId: spoofedActorId,
        decidingUserId: spoofedActorId,
      })
      .expect(200);

    expect(res.body.data.run.status).toBe('queued');

    // The recorded deciding actor is the authenticated user, not the spoofed one.
    const events = await getEvents(db, ctx.runId);
    const approvedEvent = events.find((e) => e.type === 'plan.approved');
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.actorId).not.toBe(spoofedActorId);
    expect(approvedEvent!.actorType).toBe('user');

    // The binding's deciding user is also the authenticated user.
    const bindings = await getApprovalBindings(db, ctx.runId);
    expect(bindings[0].decidingUserId).not.toBe(spoofedActorId);
    expect(bindings[0].decidingUserId).toBeTruthy();

    await closeTestDb();
  });

  it('ignores spoofed actor fields in the reject body', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-spoof-reject');

    const spoofedActorId = randomUUID();
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'Rejected',
        actorId: spoofedActorId,
        userId: spoofedActorId,
      })
      .expect(200);

    expect(res.body.data.run.status).toBe('cancelled');

    const events = await getEvents(db, ctx.runId);
    const rejectedEvent = events.find((e) => e.type === 'plan.rejected');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent!.actorId).not.toBe(spoofedActorId);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-105: Only human owners and admins decide plans
// ---------------------------------------------------------------------------

describe('VAL-PLAN-105: Only human owners and admins decide plans', () => {
  it('denies agent API key approval even with admin role', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-agent-approve');

    // Create an agent API key with admin role.
    const agentToken = await createAgentKey(db, ctx.companyId, 'admin');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    // Run remains unchanged.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.approvedPlanRevisionId).toBeNull();

    await closeTestDb();
  });

  it('denies agent API key rejection even with admin role', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-agent-reject');

    const agentToken = await createAgentKey(db, ctx.companyId, 'admin');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'Agent rejection',
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });

  it('denies agent API key approval via the canonical command endpoint', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-agent-cmd-approve');

    const agentToken = await createAgentKey(db, ctx.companyId, 'admin');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', `cmd-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        type: 'plan.approve',
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-123: Revision and rejection actor authority is exact
// ---------------------------------------------------------------------------

describe('VAL-PLAN-123: Revision and rejection actor authority is exact', () => {
  it('allows a member to request a revision (content action)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-member-revise');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Add more detail to step 1',
      })
      .expect(202);

    expect(res.body.data.run.status).toBe('planning');

    // The revision_request event is recorded with the member actor.
    const events = await getEvents(db, ctx.runId);
    const reviseEvent = events.find((e) => e.type === 'plan.revision_requested');
    expect(reviseEvent).toBeDefined();
    expect(reviseEvent!.actorType).toBe('user');

    await closeTestDb();
  });

  it('allows an owner to request a revision', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-owner-revise');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Revise the approach',
      })
      .expect(202);

    expect(res.body.data.run.status).toBe('planning');

    await closeTestDb();
  });

  it('allows an admin to request a revision', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-admin-revise');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'admin')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Revise the approach',
      })
      .expect(202);

    expect(res.body.data.run.status).toBe('planning');

    await closeTestDb();
  });

  it('denies an agent API key from requesting a revision (even with member role)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-agent-revise');

    const agentToken = await createAgentKey(db, ctx.companyId, 'member');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Agent revision request',
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    // Run remains unchanged.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    // No revision event.
    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.revision_requested')).toBeUndefined();

    await closeTestDb();
  });

  it('denies an agent API key from requesting a revision via the canonical command endpoint', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-agent-cmd-revise');

    const agentToken = await createAgentKey(db, ctx.companyId, 'member');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/commands`)
      .set('Idempotency-Key', `cmd-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        type: 'plan.revision_request',
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Agent revision via command',
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });

  it('denies a viewer from requesting a revision (content.update required)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-viewer-revise');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'viewer')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Viewer revision',
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    await closeTestDb();
  });

  it('records rejected disposition for owner reject-with-revise', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();

    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-reject-disposition');
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'Needs work',
        disposition: 'revise',
        feedback: 'Revise the budget',
      })
      .expect(200);

    const events = await getEvents(db, ctx.runId);
    const rejectedEvent = events.find((e) => e.type === 'plan.rejected');
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent!.payload.disposition).toBe('revise');
    expect(rejectedEvent!.actorType).toBe('user');

    await closeTestDb();
  });

  it('member revision_request does not record a rejected disposition', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();

    const ctx = await setupAwaitingApproval(db, '__mtest__ rbac-member-revise-dispo');
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Add more detail',
      })
      .expect(202);

    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeUndefined();
    expect(events.find((e) => e.type === 'plan.revision_requested')).toBeDefined();

    await closeTestDb();
  });
});
