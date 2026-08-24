import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import { PlannerTestHarness, HARNESS_ENV_FLAG } from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';

/**
 * Plan governance convergence (VAL-CROSS-014 through 021, 066, 067, 085).
 *
 * Connects classification, exact decisions, revisions, rejection, and role
 * boundaries to one authoritative run. Exercises plan-required, approve,
 * duplicate, tamper, revise, reject, member, owner/admin, and canonical
 * transaction paths without broad gate reruns.
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
    SELECT "status", "state_version", "last_event_sequence", "current_plan_revision_id",
           "approved_plan_revision_id", "terminal_at"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  const row = rows[0];
  return {
    status: row['status'] as string,
    stateVersion: Number(row['state_version']),
    lastEventSequence: Number(row['last_event_sequence']),
    currentPlanRevisionId: (row['current_plan_revision_id'] as string) ?? null,
    approvedPlanRevisionId: (row['approved_plan_revision_id'] as string) ?? null,
    terminalAt: (row['terminal_at'] as string | Date) ?? null,
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

async function getAllRevisions(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "revision", "status", "content_hash", "parent_revision_id"
    FROM "run_plan_revisions" WHERE "run_id" = ${runId}
    ORDER BY "revision" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    revision: r['revision'] as number,
    status: r['status'] as string,
    contentHash: r['content_hash'] as string,
    parentRevisionId: (r['parent_revision_id'] as string) ?? null,
  }));
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
    sequence: Number(r.sequence),
    type: r.type,
    payload: r.payload,
    actorType: r.actor_type,
    actorId: r.actor_id,
  }));
}

async function getApprovalBinding(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "plan_revision_id", "content_hash", "approval_id", "decision",
           "deciding_user_id", "decided_at", "is_current_authorization"
    FROM "run_plan_approval_bindings" WHERE "run_id" = ${runId}
    ORDER BY "created_at" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    planRevisionId: r['plan_revision_id'] as string,
    contentHash: r['content_hash'] as string,
    approvalId: r['approval_id'] as string,
    decision: (r['decision'] as string) ?? null,
    decidingUserId: (r['deciding_user_id'] as string) ?? null,
    isCurrentAuthorization: r['is_current_authorization'] as boolean,
  }));
}

async function getApprovalRow(db: AnyDb, approvalId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "kind", "status", "resolved_by_user_id", "resolved_at"
    FROM "approvals" WHERE "id" = ${approvalId}
  `)) as unknown as Array<Record<string, unknown>>;
  if (!rows[0]) {
    return null;
  }
  return {
    id: rows[0]['id'] as string,
    kind: rows[0]['kind'] as string,
    status: rows[0]['status'] as string,
    resolvedByUserId: (rows[0]['resolved_by_user_id'] as string) ?? null,
  };
}

async function countCommands(db: AnyDb, runId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS cnt FROM "run_commands" WHERE "run_id" = ${runId}
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
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
  const bindings = await getApprovalBinding(db, runId);
  expect(bindings.length).toBe(1);
  return {
    db,
    app,
    base,
    runId,
    row,
    revision,
    companyId,
    projectId,
    threadId,
    approvalId: bindings[0]!.approvalId,
  };
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ===========================================================================
// VAL-CROSS-014: Complex work stops for approval
// ===========================================================================

describe('VAL-CROSS-014: Complex work stops for approval', () => {
  it('reaches awaiting_approval before any execution or tool event', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-stops-approval');

    // The run is awaiting_approval with a proposed plan.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');
    expect(row!.currentPlanRevisionId).not.toBeNull();
    expect(row!.approvedPlanRevisionId).toBeNull();

    // No execution, tool, or artifact events have occurred.
    const events = await getEvents(db, ctx.runId);
    const execEvent = events.find(
      (e) =>
        e.type === 'execution.started' ||
        e.type === 'tool.started' ||
        e.type === 'artifact.committed',
    );
    expect(execEvent).toBeUndefined();

    // plan.proposed event exists and precedes any approval.
    const proposedEvent = events.find((e) => e.type === 'plan.proposed');
    expect(proposedEvent).toBeDefined();
    const approvedEvent = events.find((e) => e.type === 'plan.approved');
    expect(approvedEvent).toBeUndefined();

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-015: Exact plan approval
// ===========================================================================

describe('VAL-CROSS-015: Exact plan approval', () => {
  it('approves with exact revision ID, hash, and ETag; moves to queued and resolves approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-exact-approve');

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    expect(res.body.data.run.status).toBe('queued');
    expect(res.headers['etag']).toBe(`"${ctx.row!.stateVersion + 1}"`);

    // Run detail shows approved revision/hash.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('queued');
    expect(row!.approvedPlanRevisionId).toBe(ctx.revision!.id);

    // Approval record is resolved.
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('approved');

    // Binding has decision='approved' and is current authorization.
    const bindings = await getApprovalBinding(db, ctx.runId);
    expect(bindings.length).toBe(1);
    expect(bindings[0]!.decision).toBe('approved');
    expect(bindings[0]!.isCurrentAuthorization).toBe(true);

    // plan.approved event exists.
    const events = await getEvents(db, ctx.runId);
    const approvedEvent = events.find((e) => e.type === 'plan.approved');
    expect(approvedEvent).toBeDefined();
    expect(approvedEvent!.payload.revisionId).toBe(ctx.revision!.id);
    expect(approvedEvent!.payload.contentHash).toBe(ctx.revision!.contentHash);

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-016: Duplicate approval is harmless
// ===========================================================================

describe('VAL-CROSS-016: Duplicate approval is harmless', () => {
  it('two identical approval submissions resolve to one binding and one queued transition', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-dup-approve');
    const key = `approve-${randomUUID()}`;

    // First approval.
    const res1 = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    // Second identical approval (same key, same body).
    const res2 = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    // Both return the same run state and command identity.
    expect(res1.body.data.run.id).toBe(res2.body.data.run.id);
    expect(res1.body.data.run.stateVersion).toBe(res2.body.data.run.stateVersion);

    // Exactly one plan.approved event.
    const events = await getEvents(db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents.length).toBe(1);

    // Exactly one binding.
    const bindings = await getApprovalBinding(db, ctx.runId);
    expect(bindings.length).toBe(1);

    // Exactly one command row for this approval.
    const cmds = await countCommands(db, ctx.runId);
    // start command + one approve command = 2
    expect(cmds).toBe(2);

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-017: Tampered plan approval fails
// ===========================================================================

describe('VAL-CROSS-017: Tampered plan approval fails', () => {
  it('rejects approval with a wrong content hash (PLAN_HASH_MISMATCH)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-tamper-hash');

    const wrongHash =
      ctx.revision!.contentHash[0] === 'a'
        ? 'b' + ctx.revision!.contentHash.slice(1)
        : 'a' + ctx.revision!.contentHash.slice(1);

    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: wrongHash })
      .expect(409);

    expect(res.body.code).toBe('PLAN_HASH_MISMATCH');

    // Run remains in awaiting_approval with no approved revision.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');
    expect(row!.approvedPlanRevisionId).toBeNull();

    // Approval still pending.
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('pending');

    // No plan.approved event.
    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.approved')).toBeUndefined();

    await closeTestDb();
  });

  it('rejects approval with a wrong revision ID (PLAN_REVISION_NOT_CURRENT)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-tamper-rev');

    const foreignRevisionId = randomUUID();
    const res = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: foreignRevisionId, contentHash: ctx.revision!.contentHash })
      .expect(409);

    expect(res.body.code).toBe('PLAN_REVISION_NOT_CURRENT');

    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');
    expect(row!.approvedPlanRevisionId).toBeNull();

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-018: Plan revision requires reapproval
// ===========================================================================

describe('VAL-CROSS-018: Plan revision requires reapproval', () => {
  it('revision request creates a new immutable revision/hash and returns to planning then fresh approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-revise');
    const oldRevisionId = ctx.revision!.id;
    const oldHash = ctx.revision!.contentHash;

    // Request a revision with feedback.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `rev-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        revisionId: oldRevisionId,
        contentHash: oldHash,
        feedback: 'Add more detail to step 1',
      })
      .expect(202);

    // Run returns to planning.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('planning');
    expect(row!.approvedPlanRevisionId).toBeNull();

    // Old revision is superseded.
    const oldRevisionRow = (await db.drizzle.execute(sql`
      SELECT "status" FROM "run_plan_revisions" WHERE "id" = ${oldRevisionId}
    `)) as unknown as Array<Record<string, unknown>>;
    expect(oldRevisionRow[0]!['status']).toBe('superseded');

    // Publish a new plan with different content (different hash).
    const newPlan = validPlanContent({
      objective: 'Analyze the quarterly report with revised scope',
    });
    await publishPlanAndWait(db, ctx.runId, newPlan);

    // New revision exists with a different hash.
    const newRevision = await getCurrentRevision(db, ctx.runId);
    expect(newRevision).not.toBeNull();
    expect(newRevision!.id).not.toBe(oldRevisionId);
    expect(newRevision!.contentHash).not.toBe(oldHash);
    expect(newRevision!.revision).toBeGreaterThan(ctx.revision!.revision);

    // Run is back in awaiting_approval.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    // Old revision is retained as immutable history.
    const allRevisions = await getAllRevisions(db, ctx.runId);
    expect(allRevisions.length).toBe(2);
    expect(allRevisions.find((r) => r.id === oldRevisionId)!.status).toBe('superseded');

    // The old approved binding does not exist (never approved).
    const bindings = await getApprovalBinding(db, ctx.runId);
    // A new binding for the new revision should exist.
    const newBinding = bindings.find((b) => b.planRevisionId === newRevision!.id);
    expect(newBinding).toBeDefined();

    await closeTestDb();
  });

  it('post-approval revision obeys the queued pre-effect boundary: no execution under unapproved hash', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-post-approve-revise');

    // First approve.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    const approvedRow = await getRunRow(db, ctx.runId);
    expect(approvedRow!.status).toBe('queued');
    const approvedRevisionId = approvedRow!.approvedPlanRevisionId;
    expect(approvedRevisionId).not.toBeNull();

    // Request a revision from the queued state (post-approval).
    // This should supersede the approved revision and return to planning,
    // clearing the approved pointer. No execution should start under the
    // old approved hash.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `rev-${randomUUID()}`)
      .set('If-Match', `"${approvedRow!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: approvedRevisionId!,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Need to adjust the plan',
      })
      .expect(202);

    const rowAfterRev = await getRunRow(db, ctx.runId);
    expect(rowAfterRev!.status).toBe('planning');
    expect(rowAfterRev!.approvedPlanRevisionId).toBeNull();

    // No execution started under the old hash.
    const events = await getEvents(db, ctx.runId);
    const execEvent = events.find(
      (e) => e.type === 'execution.started' || e.type === 'tool.started',
    );
    expect(execEvent).toBeUndefined();

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-019: Reject plan and cancel
// ===========================================================================

describe('VAL-CROSS-019: Reject plan and cancel', () => {
  it('default disposition rejects, terminally cancels the run, and starts no execution', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-reject-cancel');

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'This plan does not meet our requirements',
      })
      .expect(200);

    // Run is terminally cancelled.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('cancelled');
    expect(row!.terminalAt).not.toBeNull();

    // Approval is rejected.
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('rejected');

    // Binding has decision='rejected'.
    const bindings = await getApprovalBinding(db, ctx.runId);
    expect(bindings[0]!.decision).toBe('rejected');

    // No execution or tool events.
    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'execution.started')).toBeUndefined();
    expect(events.find((e) => e.type === 'tool.started')).toBeUndefined();

    // plan.rejected and run.cancelled events exist.
    expect(events.find((e) => e.type === 'plan.rejected')).toBeDefined();
    expect(events.find((e) => e.type === 'run.cancelled')).toBeDefined();

    // The run is immutable: a later reject/approve does not change it.
    const dupRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(409);

    expect(dupRes.body.code).toBe('INVALID_RUN_STATE');

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-020: Reject plan for revision
// ===========================================================================

describe('VAL-CROSS-020: Reject plan for revision', () => {
  it('rejecting with disposition:"revise" returns to planning and produces a new revision', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-reject-revise');
    const oldRevisionId = ctx.revision!.id;
    const oldHash = ctx.revision!.contentHash;

    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: oldRevisionId,
        contentHash: oldHash,
        reason: 'Needs revision',
        disposition: 'revise',
        feedback: 'Please add a data validation step',
      })
      .expect(200);

    // Run returns to planning, not cancelled.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('planning');
    expect(row!.terminalAt).toBeNull();

    // Approval is rejected (governance record).
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('rejected');

    // Old revision is rejected (governance rejection with revise disposition).
    const oldRevisions = await getAllRevisions(db, ctx.runId);
    const oldRev = oldRevisions.find((r) => r.id === oldRevisionId);
    expect(oldRev!.status).toBe('rejected');

    // plan.rejected event exists (governance rejection).
    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeDefined();

    // No run.cancelled event (it returned to planning, not cancelled).
    expect(events.find((e) => e.type === 'run.cancelled')).toBeUndefined();

    // Publish a new plan and verify a new revision/hash.
    const newPlan = validPlanContent({
      objective: 'Revised analysis plan with validation',
    });
    await publishPlanAndWait(db, ctx.runId, newPlan);

    const newRevision = await getCurrentRevision(db, ctx.runId);
    expect(newRevision).not.toBeNull();
    expect(newRevision!.id).not.toBe(oldRevisionId);
    expect(newRevision!.contentHash).not.toBe(oldHash);

    // Run is back in awaiting_approval requiring fresh approval.
    const rowAfter = await getRunRow(db, ctx.runId);
    expect(rowAfter!.status).toBe('awaiting_approval');

    // Old revision retained as immutable history.
    const allRevisions = await getAllRevisions(db, ctx.runId);
    expect(allRevisions.find((r) => r.id === oldRevisionId)).toBeDefined();

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-021: Approval permission boundary
// ===========================================================================

describe('VAL-CROSS-021: Approval permission boundary', () => {
  it('denies member approval with 403 and allows owner approval on the same revision', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-perm-boundary');

    // Member cannot approve.
    const memberRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(403);

    expect(memberRes.body.code).toBe('INSUFFICIENT_PERMISSION');

    // Run unchanged.
    const rowAfterMember = await getRunRow(db, ctx.runId);
    expect(rowAfterMember!.status).toBe('awaiting_approval');
    expect(rowAfterMember!.stateVersion).toBe(ctx.row!.stateVersion);

    // Owner can approve the same current revision.
    const ownerRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctx.revision!.id, contentHash: ctx.revision!.contentHash })
      .expect(200);

    expect(ownerRes.body.data.run.status).toBe('queued');

    // One final approval binding owned by the authorized actor.
    const bindings = await getApprovalBinding(db, ctx.runId);
    expect(bindings.length).toBe(1);
    expect(bindings[0]!.decision).toBe('approved');
    expect(bindings[0]!.decidingUserId).toBeTruthy();

    await closeTestDb();
  });

  it('denies member rejection with 403', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-perm-reject');

    const memberRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        reason: 'I want to reject',
      })
      .expect(403);

    expect(memberRes.body.code).toBe('INSUFFICIENT_PERMISSION');

    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');

    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('pending');

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-066: Member interaction excludes governance
// ===========================================================================

describe('VAL-CROSS-066: Member interaction excludes governance', () => {
  it('member can request revision but cannot approve or reject', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-member-gov');

    // Member can request revision (content action, not governance).
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/revisions`)
      .set('Idempotency-Key', `rev-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        feedback: 'Please revise',
      })
      .expect(202);

    // Run moved to planning (revision accepted).
    const rowAfterRev = await getRunRow(db, ctx.runId);
    expect(rowAfterRev!.status).toBe('planning');

    // Publish a new plan (different content/hash) to get back to awaiting_approval.
    const revisedPlan = validPlanContent({
      objective: 'Revised plan for member governance boundary test',
    });
    await publishPlanAndWait(db, ctx.runId, revisedPlan);
    const rowAfterPlan = await getRunRow(db, ctx.runId);
    expect(rowAfterPlan!.status).toBe('awaiting_approval');
    const newRevision = await getCurrentRevision(db, ctx.runId);

    // Member cannot approve the new revision.
    const approveRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${rowAfterPlan!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({ revisionId: newRevision!.id, contentHash: newRevision!.contentHash })
      .expect(403);

    expect(approveRes.body.code).toBe('INSUFFICIENT_PERMISSION');

    // Member cannot reject the new revision.
    const rejectRes = await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${rowAfterPlan!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        revisionId: newRevision!.id,
        contentHash: newRevision!.contentHash,
        reason: 'Rejecting',
      })
      .expect(403);

    expect(rejectRes.body.code).toBe('INSUFFICIENT_PERMISSION');

    // Approval unchanged.
    const bindings = await getApprovalBinding(db, ctx.runId);
    const currentBinding = bindings.find((b) => b.planRevisionId === newRevision!.id);
    expect(currentBinding!.decision).toBeNull();

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-067: Owner and admin governance
// ===========================================================================

describe('VAL-CROSS-067: Owner and admin governance', () => {
  it('owner and admin can approve separate current plans; actor is from auth context', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();

    // Owner approves plan A.
    const ctxA = await setupAwaitingApproval(db, '__mtest__ conv-owner-gov');
    const ownerRes = await request(ctxA.app)
      .post(`${ctxA.base}/${ctxA.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctxA.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({ revisionId: ctxA.revision!.id, contentHash: ctxA.revision!.contentHash })
      .expect(200);

    expect(ownerRes.body.data.run.status).toBe('queued');

    // Verify the deciding actor in the event is the authenticated user,
    // not any body-supplied actor.
    const eventsA = await getEvents(db, ctxA.runId);
    const approvedEventA = eventsA.find((e) => e.type === 'plan.approved');
    expect(approvedEventA).toBeDefined();
    expect(approvedEventA!.actorType).toBe('user');
    expect(approvedEventA!.actorId).toBeTruthy();

    // Admin approves plan B.
    const ctxB = await setupAwaitingApproval(db, '__mtest__ conv-admin-gov');
    const adminRes = await request(ctxB.app)
      .post(`${ctxB.base}/${ctxB.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctxB.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'admin')
      .send({ revisionId: ctxB.revision!.id, contentHash: ctxB.revision!.contentHash })
      .expect(200);

    expect(adminRes.body.data.run.status).toBe('queued');

    const eventsB = await getEvents(db, ctxB.runId);
    const approvedEventB = eventsB.find((e) => e.type === 'plan.approved');
    expect(approvedEventB).toBeDefined();
    expect(approvedEventB!.actorType).toBe('user');
    expect(approvedEventB!.actorId).toBeTruthy();

    // Both bindings have deciding user IDs.
    const bindingsA = await getApprovalBinding(db, ctxA.runId);
    expect(bindingsA[0]!.decidingUserId).toBeTruthy();
    const bindingsB = await getApprovalBinding(db, ctxB.runId);
    expect(bindingsB[0]!.decidingUserId).toBeTruthy();

    await closeTestDb();
  });

  it('spoofed actor field in body is ignored; authenticated actor is recorded', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-spoof-actor');

    // The approval body does not accept actor fields, but the canonical
    // command endpoint does not either — actor is always from auth context.
    // Verify the event's actorId matches the authenticated user, not any
    // body-supplied value.
    await request(ctx.app)
      .post(`${ctx.base}/${ctx.runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        // Attempt to spoof actor — this field is not part of the schema
        // and will be ignored by normalizeCommandBody.
        actorId: 'spoofed-actor-id',
      })
      .expect(200);

    // The deciding user in the binding is the authenticated user, not spoofed.
    const bindings = await getApprovalBinding(db, ctx.runId);
    expect(bindings[0]!.decidingUserId).not.toBe('spoofed-actor-id');

    const events = await getEvents(db, ctx.runId);
    const approvedEvent = events.find((e) => e.type === 'plan.approved');
    expect(approvedEvent!.actorId).not.toBe('spoofed-actor-id');

    await closeTestDb();
  });
});

// ===========================================================================
// VAL-CROSS-085: Approvals decisions use the Mission-bound transaction
// ===========================================================================

describe('VAL-CROSS-085: Approvals decisions use the Mission-bound transaction', () => {
  it('legacy decide route delegates approve to Mission command with correct fields', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-legacy-approve');
    const approvalsBase = `/api/companies/${ctx.companyId}/approvals`;

    // Approve via the legacy decide route with Mission-bound fields.
    const res = await request(ctx.app)
      .post(`${approvalsBase}/${ctx.approvalId}/decide`)
      .set('Idempotency-Key', `decide-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        decision: 'approved',
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
      })
      .expect(200);

    // The run moved to queued through the Mission transaction.
    expect(res.body.data.run.status).toBe('queued');

    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('queued');
    expect(row!.approvedPlanRevisionId).toBe(ctx.revision!.id);

    // Approval resolved.
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('approved');

    // One plan.approved event (through Mission transaction).
    const events = await getEvents(db, ctx.runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents.length).toBe(1);

    // One binding.
    const bindings = await getApprovalBinding(db, ctx.runId);
    expect(bindings.length).toBe(1);
    expect(bindings[0]!.decision).toBe('approved');

    await closeTestDb();
  });

  it('legacy decide route delegates reject to Mission command', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-legacy-reject');
    const approvalsBase = `/api/companies/${ctx.companyId}/approvals`;

    await request(ctx.app)
      .post(`${approvalsBase}/${ctx.approvalId}/decide`)
      .set('Idempotency-Key', `decide-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        decision: 'rejected',
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        resolutionNote: 'Rejected via legacy route',
      })
      .expect(200);

    // Run is cancelled through the Mission transaction.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('cancelled');
    expect(row!.terminalAt).not.toBeNull();

    // Approval rejected.
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('rejected');

    // plan.rejected and run.cancelled events.
    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeDefined();
    expect(events.find((e) => e.type === 'run.cancelled')).toBeDefined();

    await closeTestDb();
  });

  it('legacy decide route refuses plan_gate without Mission fields (no resolution)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-legacy-refuse');
    const approvalsBase = `/api/companies/${ctx.companyId}/approvals`;

    // Attempt to decide without Mission-bound fields.
    const res = await request(ctx.app)
      .post(`${approvalsBase}/${ctx.approvalId}/decide`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        decision: 'approved',
        resolutionNote: 'Trying to approve',
      })
      .expect(409);

    expect(res.body.code).toBe('APPROVAL_REQUIRES_MISSION_FIELDS');

    // Approval remains pending.
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('pending');

    // Run remains in awaiting_approval.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');

    // No plan.approved event.
    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.approved')).toBeUndefined();

    await closeTestDb();
  });

  it('legacy decide route delegates reject-with-revise to Mission command', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-legacy-revise');
    const approvalsBase = `/api/companies/${ctx.companyId}/approvals`;

    await request(ctx.app)
      .post(`${approvalsBase}/${ctx.approvalId}/decide`)
      .set('Idempotency-Key', `decide-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        decision: 'rejected',
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
        disposition: 'revise',
        feedback: 'Revise via legacy route',
        resolutionNote: 'Needs work',
      })
      .expect(200);

    // Run returned to planning, not cancelled.
    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('planning');
    expect(row!.terminalAt).toBeNull();

    // Approval rejected (governance record).
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('rejected');

    // plan.rejected event exists, no run.cancelled.
    const events = await getEvents(db, ctx.runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeDefined();
    expect(events.find((e) => e.type === 'run.cancelled')).toBeUndefined();

    await closeTestDb();
  });

  it('legacy decide route tampered hash fails through Mission transaction (PLAN_HASH_MISMATCH)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-legacy-tamper');
    const approvalsBase = `/api/companies/${ctx.companyId}/approvals`;

    const wrongHash =
      ctx.revision!.contentHash[0] === 'a'
        ? 'b' + ctx.revision!.contentHash.slice(1)
        : 'a' + ctx.revision!.contentHash.slice(1);

    const res = await request(ctx.app)
      .post(`${approvalsBase}/${ctx.approvalId}/decide`)
      .set('Idempotency-Key', `decide-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'owner')
      .send({
        decision: 'approved',
        revisionId: ctx.revision!.id,
        contentHash: wrongHash,
      })
      .expect(409);

    expect(res.body.code).toBe('PLAN_HASH_MISMATCH');

    // Approval still pending, run unchanged.
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('pending');

    const row = await getRunRow(db, ctx.runId);
    expect(row!.status).toBe('awaiting_approval');

    await closeTestDb();
  });

  it('legacy decide route denies member approval of plan_gate (403)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const ctx = await setupAwaitingApproval(db, '__mtest__ conv-legacy-member');
    const approvalsBase = `/api/companies/${ctx.companyId}/approvals`;

    const res = await request(ctx.app)
      .post(`${approvalsBase}/${ctx.approvalId}/decide`)
      .set('Idempotency-Key', `decide-${randomUUID()}`)
      .set('If-Match', `"${ctx.row!.stateVersion}"`)
      .set('X-Eidolon-Test-Org-Role', 'member')
      .send({
        decision: 'approved',
        revisionId: ctx.revision!.id,
        contentHash: ctx.revision!.contentHash,
      })
      .expect(403);

    expect(res.body.code).toBe('INSUFFICIENT_PERMISSION');

    // Approval still pending.
    const approval = await getApprovalRow(db, ctx.approvalId);
    expect(approval!.status).toBe('pending');

    await closeTestDb();
  });

  it('legacy decide route for non-plan_gate approval works unchanged', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId } = await seedScope(db, '__mtest__ conv-legacy-non-gate');
    const app = await createTestServer(db);
    const approvalsBase = `/api/companies/${companyId}/approvals`;

    // Create a regular (non-plan_gate) approval.
    const createRes = await request(app)
      .post(approvalsBase)
      .send({
        kind: 'custom',
        title: 'Regular approval',
        priority: 'medium',
      })
      .expect(201);

    const approvalId = createRes.body.data.id;

    // Decide it via the legacy route (no Mission fields needed).
    const decideRes = await request(app)
      .post(`${approvalsBase}/${approvalId}/decide`)
      .send({ decision: 'approved', resolutionNote: 'OK' })
      .expect(200);

    expect(decideRes.body.data.status).toBe('approved');

    await closeTestDb();
  });
});
