import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import { PlannerTestHarness, HARNESS_ENV_FLAG } from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import {
  planContentHash,
  validatePlan,
  PLAN_CONTENT_SCHEMA_VERSION,
} from '../services/mission/plan-schema.js';

/**
 * Canonical hash/revision-bound decision commands and idempotency.
 *
 * (VAL-PLAN-029, 030, 043, 044, 046, 047, 095, 096, 118, 128)
 *
 * Exercises exact/mismatched bindings, stale versions, duplicate/conflicting
 * keys, policy revalidation, deny-only changes, redaction, and precedence.
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

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{
    sequence: string | number;
    type: string;
    payload: Record<string, unknown>;
  }>;
  return rows.map((r) => ({ ...r, sequence: Number(r.sequence) }));
}

async function getApprovalBindings(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "plan_revision_id", "content_hash", "approval_id", "decision",
           "deciding_user_id", "decided_at"
    FROM "run_plan_approval_bindings" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    planRevisionId: r['plan_revision_id'] as string,
    contentHash: r['content_hash'] as string,
    approvalId: r['approval_id'] as string,
    decision: (r['decision'] as string) ?? null,
    decidingUserId: (r['deciding_user_id'] as string) ?? null,
  }));
}

async function countCommands(db: AnyDb, runId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS cnt FROM "run_commands" WHERE "run_id" = ${runId}
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-PLAN-029 + VAL-PLAN-030: Exact revision ID and content hash binding
// ---------------------------------------------------------------------------

describe('VAL-PLAN-029 + 030: Approval binds exact revision ID and content hash', () => {
  it('rejects approval with a mismatched (non-current) revision ID', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-bind-rev');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');
    const revision = await getCurrentRevision(db, runId);
    expect(revision).not.toBeNull();

    // Use a valid hash but a foreign revision ID.
    const foreignRevisionId = randomUUID();
    const approveRes = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: foreignRevisionId, contentHash: revision!.contentHash })
      .expect(409);

    expect(approveRes.body.code).toBe('PLAN_REVISION_NOT_CURRENT');

    // Run remains unchanged.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.stateVersion).toBe(row!.stateVersion);
    expect(rowAfter!.approvedPlanRevisionId).toBeNull();

    await closeTestDb();
  });

  it('rejects approval with a mismatched content hash (one char changed)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-bind-hash');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Flip one hex character in the hash.
    const wrongHash =
      revision!.contentHash[0] === 'a'
        ? 'b' + revision!.contentHash.slice(1)
        : 'a' + revision!.contentHash.slice(1);

    const approveRes = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: wrongHash })
      .expect(409);

    expect(approveRes.body.code).toBe('PLAN_HASH_MISMATCH');

    // No binding, no execution event.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.approvedPlanRevisionId).toBeNull();
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.approved')).toBeUndefined();

    await closeTestDb();
  });

  it('approves successfully with exact revision ID and content hash', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-bind-ok');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    const approveRes = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);

    expect(approveRes.body.data.run.status).toBe('queued');
    expect(approveRes.body.data.run.approvedPlanRevisionId ?? true).toBeTruthy();

    // The binding has decision='approved'.
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings.find((b) => b.decision === 'approved')).toBeTruthy();

    // A plan.approved event was appended.
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.approved')).toBeTruthy();

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-043 + VAL-PLAN-044: Stale version and missing precondition
// ---------------------------------------------------------------------------

describe('VAL-PLAN-043 + 044: Stale version and missing precondition cannot decide', () => {
  it('rejects approve/reject/revise with stale If-Match (412)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-stale');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    const staleVersion = row!.stateVersion - 1; // older version

    // Approve with stale version.
    const approveRes = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .set('If-Match', `"${staleVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(412);
    expect(approveRes.body.code).toBe('RUN_VERSION_MISMATCH');

    // Reject with stale version.
    const rejectRes = await request(app)
      .post(`${base}/${runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${staleVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash, reason: 'No good' })
      .expect(412);
    expect(rejectRes.body.code).toBe('RUN_VERSION_MISMATCH');

    // Revise with stale version.
    const reviseRes = await request(app)
      .post(`${base}/${runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${staleVersion}"`)
      .send({
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        feedback: 'Add more detail',
      })
      .expect(412);
    expect(reviseRes.body.code).toBe('RUN_VERSION_MISMATCH');

    // Run remains unchanged.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.stateVersion).toBe(row!.stateVersion);

    await closeTestDb();
  });

  it('rejects approve/reject/revise without If-Match (428)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-missing');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const revision = await getCurrentRevision(db, runId);

    // Approve without If-Match.
    const approveRes = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `approve-${randomUUID()}`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(428);
    expect(approveRes.body.code).toBe('PRECONDITION_REQUIRED');

    // Reject without If-Match.
    const rejectRes = await request(app)
      .post(`${base}/${runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash, reason: 'No good' })
      .expect(428);
    expect(rejectRes.body.code).toBe('PRECONDITION_REQUIRED');

    // Revise without If-Match.
    const reviseRes = await request(app)
      .post(`${base}/${runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .send({
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        feedback: 'Add more detail',
      })
      .expect(428);
    expect(reviseRes.body.code).toBe('PRECONDITION_REQUIRED');

    // State unchanged.
    const row = await getRunRow(db, runId);
    expect(row!.status).toBe('awaiting_approval');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-046 + VAL-PLAN-047: Idempotency — duplicate replay and key conflict
// ---------------------------------------------------------------------------

describe('VAL-PLAN-046 + 047: Duplicate identical approval is idempotent; reused key with changed content is rejected', () => {
  it('replays the original result for a duplicate identical approval', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-idem');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    const key = `approve-dup-${randomUUID()}`;
    const body = { revisionId: revision!.id, contentHash: revision!.contentHash };

    // First approval.
    const first = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send(body)
      .expect(200);
    expect(first.body.data.run.status).toBe('queued');

    // Second identical approval with the same key.
    const second = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send(body)
      .expect(200);

    // Same result (same run snapshot).
    expect(second.body.data.run.id).toBe(first.body.data.run.id);
    expect(second.body.data.run.status).toBe('queued');

    // No second binding, event, or transition.
    const events = await getEvents(db, runId);
    const approvedEvents = events.filter((e) => e.type === 'plan.approved');
    expect(approvedEvents).toHaveLength(1);
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings.filter((b) => b.decision === 'approved')).toHaveLength(1);

    // Only one command row for this key.
    const cmdCount = await countCommands(db, runId);
    // Start + approve = 2 commands; the duplicate replays, so no new row.
    expect(cmdCount).toBe(2);

    await closeTestDb();
  });

  it('rejects reused key with changed decision content (409 IDEMPOTENCY_KEY_REUSED)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-conflict');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    const key = `key-conflict-${randomUUID()}`;

    // First: approve.
    const first = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(200);
    expect(first.body.data.run.status).toBe('queued');

    // Reuse same key for reject — changed content.
    const conflict = await request(app)
      .post(`${base}/${runId}/plan/reject`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        reason: 'Changed my mind',
      })
      .expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // Original outcome remains authoritative.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('queued');

    await closeTestDb();
  });

  it('rejects reused key with changed hash (409 IDEMPOTENCY_KEY_REUSED)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-hash-conflict');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    const key = `key-hash-${randomUUID()}`;

    // First: approve (will fail with hash mismatch, but that's ok — the
    // command is recorded as rejected).
    const wrongHash = 'a'.repeat(64);
    await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: wrongHash })
      .expect(409);

    // Reuse same key with a different (correct) hash — changed content.
    const conflict = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-128: Deterministic error precedence
// ---------------------------------------------------------------------------

describe('VAL-PLAN-128: Plan command error precedence is deterministic', () => {
  it('scope (404) takes precedence over idempotency for a foreign run', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-prec-scope');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const revision = await getCurrentRevision(db, runId);
    const foreignRunId = randomUUID();

    // Foreign run ID → 404 before any other check.
    const result = await request(app)
      .post(`${base}/${foreignRunId}/plan/approve`)
      .set('Idempotency-Key', `prec-${randomUUID()}`)
      .set('If-Match', `"1"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(404);
    expect(result.body.code).toBe('RUN_NOT_FOUND');

    await closeTestDb();
  });

  it('missing precondition (428) takes precedence over stale revision and hash', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-prec-428');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Missing If-Match + wrong revision + wrong hash → 428 wins.
    const result = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `prec-428-${randomUUID()}`)
      .send({ revisionId: randomUUID(), contentHash: 'a'.repeat(64) })
      .expect(428);
    expect(result.body.code).toBe('PRECONDITION_REQUIRED');

    await closeTestDb();
  });

  it('stale ETag (412) takes precedence over stale revision and hash', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-prec-412');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    // Stale If-Match + wrong revision + wrong hash → 412 wins.
    const result = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `prec-412-${randomUUID()}`)
      .set('If-Match', `"0"`)
      .send({ revisionId: randomUUID(), contentHash: 'a'.repeat(64) })
      .expect(412);
    expect(result.body.code).toBe('RUN_VERSION_MISMATCH');

    await closeTestDb();
  });

  it('stale revision (PLAN_REVISION_NOT_CURRENT) takes precedence over hash mismatch', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-prec-rev');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);

    // Wrong revision + wrong hash → PLAN_REVISION_NOT_CURRENT wins.
    const result = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `prec-rev-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: randomUUID(), contentHash: 'a'.repeat(64) })
      .expect(409);
    expect(result.body.code).toBe('PLAN_REVISION_NOT_CURRENT');

    await closeTestDb();
  });

  it('hash mismatch (PLAN_HASH_MISMATCH) applies only to the current revision', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-prec-hash');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Correct revision + wrong hash → PLAN_HASH_MISMATCH.
    const wrongHash =
      revision!.contentHash[0] === 'a'
        ? 'b' + revision!.contentHash.slice(1)
        : 'a' + revision!.contentHash.slice(1);
    const result = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `prec-hash-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: wrongHash })
      .expect(409);
    expect(result.body.code).toBe('PLAN_HASH_MISMATCH');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-095 + VAL-PLAN-118: Policy revalidation is deny-only
// ---------------------------------------------------------------------------

describe('VAL-PLAN-095 + 118: Policy change cannot silently alter proposed plan; revalidation is deny-only', () => {
  it('the plan content hash is immutable after proposal', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-immutable');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    const planContent = validPlanContent();
    await publishPlanAndWait(db, runId, planContent);

    const revision = await getCurrentRevision(db, runId);
    const expectedHash = planContentHash(validatePlan(planContent));
    expect(revision!.contentHash).toBe(expectedHash);

    // The hash does not change after proposal (immutable).
    const revision2 = await getCurrentRevision(db, runId);
    expect(revision2!.contentHash).toBe(expectedHash);

    await closeTestDb();
  });

  it('approval with a plan tool not in the policy snapshot is denied (deny-only)', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-deny-tool');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    // Create an agent with a specific tool allowlist so the policy
    // snapshot has a non-empty tool set for deny-only revalidation.
    const agentId = randomUUID();
    const now0 = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "created_at", "updated_at")
      VALUES (${agentId}, ${companyId}, 'A', 'engineer', 'anthropic', 'claude-sonnet-4-6', 'idle', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '["research.search"]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 5, 0, 600, 0, 10000, 0, ${now0}, ${now0})
    `);

    // Start the run with the agent so the snapshot includes its tools.
    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `plan-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'deep_work',
        initiatingAgentId: agentId,
        request: { text: 'Analyze the quarterly report with multiple deliverables' },
      })
      .expect(202);
    const runId = res.body.data.run.id as string;

    // Publish a plan with a tool NOT in the agent's allowlist.
    const planWithExoticTool = validPlanContent({
      steps: [
        {
          ...((validPlanContent() as Record<string, unknown[]>).steps[0] as Record<
            string,
            unknown
          >),
          toolAllowlist: ['exotic.unauthorized.tool'],
          routing: {
            kind: 'requirements',
            routingRequirements: {
              capabilities: ['analysis'],
              requiredTools: ['exotic.unauthorized.tool'],
              requiredDomains: [],
              ephemeralAllowed: true,
            },
          },
        },
      ],
    });
    await publishPlanAndWait(db, runId, planWithExoticTool);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Approval should be denied because the tool is not in the policy
    // snapshot (deny-only revalidation).
    const result = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `deny-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(409);
    expect(result.body.code).toBe('POLICY_UNSATISFIABLE');

    // Run remains awaiting_approval (not queued).
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.status).toBe('awaiting_approval');
    expect(rowAfter!.approvedPlanRevisionId).toBeNull();

    // The plan hash is unchanged (deny-only, not altered).
    const revisionAfter = await getCurrentRevision(db, runId);
    expect(revisionAfter!.contentHash).toBe(revision!.contentHash);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// VAL-PLAN-096: Decision errors do not leak secrets
// ---------------------------------------------------------------------------

describe('VAL-PLAN-096: Decision errors do not leak secrets', () => {
  it('reject/revision feedback with canary patterns is redacted in errors and events', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-redact');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Reject with a canary in the reason.
    const canary = 'api_key=FAKE_TEST_CANARY_NOT_REAL_12345';
    const rejectRes = await request(app)
      .post(`${base}/${runId}/plan/reject`)
      .set('Idempotency-Key', `redact-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash, reason: canary })
      .expect(200);

    // The response should not contain the canary.
    const responseText = JSON.stringify(rejectRes.body);
    expect(responseText).not.toContain('FAKE_TEST_CANARY_NOT_REAL_12345');
    expect(responseText).not.toContain('api_key=FAKE');

    // Events should not contain the canary.
    const events = await getEvents(db, runId);
    const eventsText = JSON.stringify(events);
    expect(eventsText).not.toContain('FAKE_TEST_CANARY_NOT_REAL_12345');

    // The revision feedback should be encrypted, not plaintext.
    const revisionRows = (await db.drizzle.execute(sql`
      SELECT "feedback" FROM "run_plan_revisions" WHERE "id" = ${revision!.id}
    `)) as unknown as Array<{ feedback: string | null }>;
    const feedback = revisionRows[0]?.feedback;
    expect(feedback).not.toBeNull();
    expect(feedback).not.toContain('FAKE_TEST_CANARY_NOT_REAL_12345');
    expect(feedback).not.toContain('api_key=FAKE');

    await closeTestDb();
  });

  it('policy denial errors do not leak provider secrets', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-err-secret');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    // Create an agent with a specific tool allowlist.
    const agentId = randomUUID();
    const now0 = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "capabilities", "config", "metadata", "permissions", "tools_enabled", "skills_enabled", "routine_policy", "session_policy", "allowed_domains", "max_concurrent_tasks", "heartbeat_interval_seconds", "execution_timeout_seconds", "auto_assign_tasks", "budget_monthly_cents", "spent_monthly_cents", "created_at", "updated_at")
      VALUES (${agentId}, ${companyId}, 'A', 'engineer', 'anthropic', 'claude-sonnet-4-6', 'idle', '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '["research.search"]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, 5, 0, 600, 0, 10000, 0, ${now0}, ${now0})
    `);

    const res = await request(app)
      .post(base)
      .set('Idempotency-Key', `plan-${randomUUID()}`)
      .send({
        projectThreadId: threadId,
        mode: 'deep_work',
        initiatingAgentId: agentId,
        request: { text: 'Analyze the quarterly report with multiple deliverables' },
      })
      .expect(202);
    const runId = res.body.data.run.id as string;

    const planWithExoticTool = validPlanContent({
      steps: [
        {
          ...((validPlanContent() as Record<string, unknown[]>).steps[0] as Record<
            string,
            unknown
          >),
          toolAllowlist: ['exotic.unauthorized.tool'],
          routing: {
            kind: 'requirements',
            routingRequirements: {
              capabilities: ['analysis'],
              requiredTools: ['exotic.unauthorized.tool'],
              requiredDomains: [],
              ephemeralAllowed: true,
            },
          },
        },
      ],
    });
    await publishPlanAndWait(db, runId, planWithExoticTool);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    const result = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', `err-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ revisionId: revision!.id, contentHash: revision!.contentHash })
      .expect(409);

    // Error response should not contain secrets, prompts, or provider bodies.
    const errorText = JSON.stringify(result.body);
    expect(errorText).not.toContain('api_key');
    expect(errorText).not.toContain('Bearer');
    expect(errorText).not.toContain('password');
    expect(errorText).not.toContain('-----BEGIN');

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// Reject and revision_request command behavior
// ---------------------------------------------------------------------------

describe('Plan reject and revision_request commands', () => {
  it('reject without disposition cancels the run', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-reject-cancel');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    const rejectRes = await request(app)
      .post(`${base}/${runId}/plan/reject`)
      .set('Idempotency-Key', `reject-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        reason: 'Not what we need',
      })
      .expect(200);

    expect(rejectRes.body.data.run.status).toBe('cancelled');

    // Events: plan.rejected + run.cancelled.
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeTruthy();
    expect(events.find((e) => e.type === 'run.cancelled')).toBeTruthy();

    // Binding decision = rejected.
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings.find((b) => b.decision === 'rejected')).toBeTruthy();

    await closeTestDb();
  });

  it('reject with disposition revise returns to planning', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-reject-revise');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    const rejectRes = await request(app)
      .post(`${base}/${runId}/plan/reject`)
      .set('Idempotency-Key', `reject-revise-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        reason: 'Needs more detail',
        disposition: 'revise',
        feedback: 'Please add a step for data validation',
      })
      .expect(200);

    expect(rejectRes.body.data.run.status).toBe('planning');

    // Events: plan.rejected + plan.revision_requested.
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.rejected')).toBeTruthy();
    expect(events.find((e) => e.type === 'plan.revision_requested')).toBeTruthy();
    expect(events.find((e) => e.type === 'run.cancelled')).toBeUndefined();

    // Binding decision = rejected (not superseded).
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings.find((b) => b.decision === 'rejected')).toBeTruthy();

    // Current revision pointer cleared.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.currentPlanRevisionId).toBeNull();

    await closeTestDb();
  });

  it('reject with disposition revise requires feedback', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(
      db,
      '__mtest__ plan-reject-no-feedback',
    );
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    // Reject with disposition revise but no feedback → 400.
    const result = await request(app)
      .post(`${base}/${runId}/plan/reject`)
      .set('Idempotency-Key', `no-feedback-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        reason: 'Needs work',
        disposition: 'revise',
      })
      .expect(400);
    expect(result.body.code).toBe('VALIDATION_ERROR');

    await closeTestDb();
  });

  it('revision_request supersedes the proposal and returns to planning', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-revise');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);

    const reviseRes = await request(app)
      .post(`${base}/${runId}/plan/revisions`)
      .set('Idempotency-Key', `revise-${randomUUID()}`)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({
        revisionId: revision!.id,
        contentHash: revision!.contentHash,
        feedback: 'Please add more detail to step 1',
      })
      .expect(202);

    expect(reviseRes.body.data.run.status).toBe('planning');

    // The revision is superseded (not rejected).
    const revisionRows = (await db.drizzle.execute(sql`
      SELECT "status" FROM "run_plan_revisions" WHERE "id" = ${revision!.id}
    `)) as unknown as Array<{ status: string }>;
    expect(revisionRows[0]?.status).toBe('superseded');

    // Events: plan.revision_requested (no plan.rejected).
    const events = await getEvents(db, runId);
    expect(events.find((e) => e.type === 'plan.revision_requested')).toBeTruthy();
    expect(events.find((e) => e.type === 'plan.rejected')).toBeUndefined();

    // Binding decision is null (superseded without a rejection decision).
    const bindings = await getApprovalBindings(db, runId);
    expect(bindings[0]?.decision).toBeNull();

    // Current revision pointer cleared.
    const rowAfter = await getRunRow(db, runId);
    expect(rowAfter!.currentPlanRevisionId).toBeNull();

    await closeTestDb();
  });

  it('duplicate revision_request is idempotent', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-revise-idem');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    const key = `revise-idem-${randomUUID()}`;
    const body = {
      revisionId: revision!.id,
      contentHash: revision!.contentHash,
      feedback: 'Please add more detail',
    };

    const first = await request(app)
      .post(`${base}/${runId}/plan/revisions`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send(body)
      .expect(202);

    const second = await request(app)
      .post(`${base}/${runId}/plan/revisions`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send(body)
      .expect(202);

    // Same result.
    expect(second.body.data.run.id).toBe(first.body.data.run.id);

    // Only one revision_requested event.
    const events = await getEvents(db, runId);
    expect(events.filter((e) => e.type === 'plan.revision_requested')).toHaveLength(1);

    await closeTestDb();
  });
});

// ---------------------------------------------------------------------------
// Canonical command endpoint equivalence
// ---------------------------------------------------------------------------

describe('Canonical command endpoint shares idempotency namespace with convenience routes', () => {
  it('replaying approve via canonical endpoint with same key returns original result', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ plan-canonical');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    const key = `canonical-${randomUUID()}`;
    const body = { revisionId: revision!.id, contentHash: revision!.contentHash };

    // First: via convenience route.
    const first = await request(app)
      .post(`${base}/${runId}/plan/approve`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send(body)
      .expect(200);

    // Second: via canonical command endpoint with the same key and body.
    const second = await request(app)
      .post(`${base}/${runId}/commands`)
      .set('Idempotency-Key', key)
      .set('If-Match', `"${row!.stateVersion}"`)
      .send({ type: 'plan.approve', ...body })
      .expect(200);

    // Same result (replay).
    expect(second.body.data.run.id).toBe(first.body.data.run.id);
    expect(second.body.data.run.status).toBe('queued');

    // Only one approved event.
    const events = await getEvents(db, runId);
    expect(events.filter((e) => e.type === 'plan.approved')).toHaveLength(1);

    await closeTestDb();
  });
});
