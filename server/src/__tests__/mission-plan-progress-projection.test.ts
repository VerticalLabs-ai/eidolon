import { describe, expect, it, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createTestDb, createTestServer, closeTestServers, closeTestDb } from '../test-utils.js';
import { PlannerService } from '../services/mission/planner.js';
import { PlannerTestHarness, HARNESS_ENV_FLAG } from '../services/mission/planner-harness.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from '../services/mission/plan-schema.js';
import { projectEvent } from '../services/mission/projection.js';

/**
 * Plan Progress Projection Authority (VAL-CROSS-046).
 *
 * Exercises approved-plan child execution event projection to mutable
 * `project_plan_steps` rows: progress/terminal status updates, idempotent
 * replay, stale-event skipping, and proof that mutable projection edits
 * cannot alter the immutable approved Mission revision used by execution.
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

function validPlanContent(): unknown {
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
      {
        stepKey: 'step-2',
        parentStepKey: null,
        childOrdinal: 1,
        nodeKind: 'root',
        title: 'Write analysis',
        description: 'Write the analysis section',
        dependencies: ['step-1'],
        inputBindings: [
          {
            name: 'data',
            source: { kind: 'stepOutput', stepKey: 'step-1', output: 'report-data' },
          },
        ],
        routing: {
          kind: 'requirements',
          routingRequirements: {
            capabilities: ['writing'],
            requiredTools: [],
            requiredDomains: [],
            ephemeralAllowed: false,
          },
        },
        toolAllowlist: [],
        replayClass: 'read_only',
        sideEffecting: false,
        expectedOutputs: ['analysis-text'],
        evidenceRequirements: { citationsRequired: false },
        completionCriteria: 'Analysis written',
        budgetCents: 100,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize the report',
      declaredInputs: [{ kind: 'stepOutput', stepKey: 'step-2', output: 'analysis-text' }],
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
  };
}

async function startPlanningRun(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  threadId: string,
) {
  return request(app)
    .post(base)
    .set('Idempotency-Key', `plan-${randomUUID()}`)
    .send({
      projectThreadId: threadId,
      mode: 'deep_work',
      request: { text: 'Analyze the quarterly report with multiple deliverables' },
    })
    .expect(202);
}

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "current_plan_revision_id",
           "approved_plan_revision_id"
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
  };
}

async function getCurrentRevision(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT rpr."id", rpr."revision", rpr."status", rpr."content_hash", rpr."content"
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
    content: rows[0]['content'] as unknown,
  };
}

async function getProjectPlans(db: AnyDb, companyId: string, projectId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "title", "status", "progress"
    FROM "project_plans" WHERE "company_id" = ${companyId} AND "project_id" = ${projectId}
    ORDER BY "created_at"
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    title: r['title'] as string,
    status: r['status'] as string,
    progress: Number(r['progress']),
  }));
}

async function getProjectPlanSteps(db: AnyDb, planId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "plan_id", "title", "step_order", "status", "gate_config",
           "completed_by_agent_id", "completed_at"
    FROM "project_plan_steps" WHERE "plan_id" = ${planId}
    ORDER BY "step_order"
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r['id'] as string,
    planId: r['plan_id'] as string,
    title: r['title'] as string,
    stepOrder: Number(r['step_order']),
    status: r['status'] as string,
    gateConfig: r['gate_config'] as Record<string, unknown>,
    completedByAgentId: (r['completed_by_agent_id'] as string | null) ?? null,
    completedAt: (r['completed_at'] as string | Date | null) ?? null,
  }));
}

async function getProgressLinks(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "surface", "surface_id", "surface_key", "event_sequence", "status", "error_message"
    FROM "run_projection_links"
    WHERE "run_id" = ${runId} AND "surface" = 'project_plan_step_progress'
    ORDER BY "surface_key"
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    surface: r['surface'] as string,
    surfaceId: r['surface_id'] as string,
    surfaceKey: r['surface_key'] as string,
    eventSequence: r['event_sequence'] !== null ? Number(r['event_sequence']) : null,
    status: r['status'] as string,
    errorMessage: (r['error_message'] as string | null) ?? null,
  }));
}

async function publishPlanAndWait(db: AnyDb, runId: string) {
  const harness = new PlannerTestHarness({ vectors: [{ content: validPlanContent() }] });
  const planner = new PlannerService(db, { generator: harness });
  const coordinator = new RunCoordinator(db);
  const claim = await coordinator.claimNext('test-worker');
  expect(claim).not.toBeNull();
  await planner.plan(claim!, new AbortController().signal);
  await coordinator.release(claim!);
  await projectAllEvents(db, runId);
}

/** Insert a synthetic child execution event and bump the run's last sequence. */
async function appendChildEvent(
  db: AnyDb,
  runId: string,
  companyId: string,
  projectId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "last_event_sequence" FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  const seq = Number(rows[0]['last_event_sequence']) + 1;
  const now = new Date();
  const eventId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "run_events"
      ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version",
       "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
    VALUES
      (${eventId}, ${companyId}, ${projectId}, ${runId}, ${seq}, ${type}, 1,
       ${JSON.stringify(payload)}::jsonb, 'system', NULL, NULL, ${now})
  `);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "last_event_sequence" = ${seq}, "updated_at" = ${now}
    WHERE "id" = ${runId}
  `);
  return seq;
}

/** Project all committed events for a run to mutable surfaces (simulates worker). */
async function projectAllEvents(db: AnyDb, runId: string): Promise<void> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload", "company_id", "project_id",
           "actor_type", "actor_id", "trace_id", "occurred_at"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<Record<string, unknown>>;
  for (const r of rows) {
    await projectEvent(
      db,
      {
        runId,
        companyId: r['company_id'] as string,
        projectId: r['project_id'] as string,
        sequence: Number(r['sequence']),
        type: r['type'] as string,
        payload: r['payload'] as Record<string, unknown>,
        actorType: (r['actor_type'] as 'user' | 'agent' | 'system' | null) ?? null,
        actorId: (r['actor_id'] as string | null) ?? null,
        traceId: (r['trace_id'] as string | null) ?? null,
        occurredAt: r['occurred_at'] as Date,
      },
      { clock: () => new Date() },
    );
  }
}

async function approvePlan(
  app: Awaited<ReturnType<typeof createTestServer>>,
  base: string,
  runId: string,
  stateVersion: number,
  revisionId: string,
  contentHash: string,
) {
  return request(app)
    .post(`${base}/${runId}/plan/approve`)
    .set('Idempotency-Key', `approve-${randomUUID()}`)
    .set('If-Match', `"${stateVersion}"`)
    .send({ revisionId, contentHash })
    .expect(200);
}

afterEach(async () => {
  await closeTestServers();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// VAL-CROSS-046: Plans projection tracks execution
// ---------------------------------------------------------------------------

describe('VAL-CROSS-046: Plans projection tracks execution', () => {
  it('updates projected step status from child.started then child.completed idempotently', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ progress-proj-046');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);

    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    await approvePlan(app, base, runId, row!.stateVersion, revision!.id, revision!.contentHash);
    await projectAllEvents(db, runId);

    const plans = await getProjectPlans(db, companyId, projectId);
    expect(plans).toHaveLength(1);
    const steps = await getProjectPlanSteps(db, plans[0].id);
    expect(steps).toHaveLength(2);
    expect(steps[0].status).toBe('pending');
    expect(steps[1].status).toBe('pending');

    // Emit child.started for step-1.
    const startedSeq = await appendChildEvent(db, runId, companyId, projectId, 'child.started', {
      stepKey: 'step-1',
      agentId: 'agent-abc',
    });
    await projectAllEvents(db, runId);
    const stepsAfterStart = await getProjectPlanSteps(db, plans[0].id);
    expect(stepsAfterStart[0].status).toBe('in_progress');
    expect(stepsAfterStart[1].status).toBe('pending');

    // Emit child.completed for step-1.
    const completedSeq = await appendChildEvent(
      db,
      runId,
      companyId,
      projectId,
      'child.completed',
      { stepKey: 'step-1', agentId: 'agent-abc', costCents: 50, outputSummary: 'data ready' },
    );
    await projectAllEvents(db, runId);
    const stepsAfterComplete = await getProjectPlanSteps(db, plans[0].id);
    expect(stepsAfterComplete[0].status).toBe('completed');
    expect(stepsAfterComplete[0].completedAt).not.toBeNull();
    expect(stepsAfterComplete[1].status).toBe('pending');

    // Idempotent: re-projecting all events does not duplicate or regress.
    await projectAllEvents(db, runId);
    const stepsReplayed = await getProjectPlanSteps(db, plans[0].id);
    expect(stepsReplayed).toHaveLength(2);
    expect(stepsReplayed[0].status).toBe('completed');

    // One progress link per step that received events; tracked sequence is
    // the latest (completed) event.
    const progressLinks = await getProgressLinks(db, runId);
    expect(progressLinks).toHaveLength(1);
    expect(progressLinks[0].surfaceKey).toContain('step-1');
    expect(progressLinks[0].eventSequence).toBe(completedSeq);
    expect(progressLinks[0].status).toBe('active');
    // The started event sequence is strictly less than completed.
    expect(startedSeq).toBeLessThan(completedSeq);

    // The immutable approved revision content/hash is unchanged — mutable
    // step status edits cannot alter the Mission's approved revision.
    const revisionAfter = await getCurrentRevision(db, runId);
    expect(revisionAfter!.contentHash).toBe(revision!.contentHash);
    expect(revisionAfter!.content).toEqual(revision!.content);

    await closeTestDb();
  });

  it('projects child.failed to blocked and child.cancel_requested to skipped', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ progress-proj-fail');
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);
    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    await approvePlan(app, base, runId, row!.stateVersion, revision!.id, revision!.contentHash);
    await projectAllEvents(db, runId);

    const plans = await getProjectPlans(db, companyId, projectId);
    const steps = await getProjectPlanSteps(db, plans[0].id);

    // step-1 fails, step-2 is cancellation-requested.
    await appendChildEvent(db, runId, companyId, projectId, 'child.started', {
      stepKey: steps[0].gateConfig.stepKey as string,
    });
    await appendChildEvent(db, runId, companyId, projectId, 'child.failed', {
      stepKey: steps[0].gateConfig.stepKey as string,
      failureCategory: 'tool_failed',
      safeErrorMessage: 'Tool unavailable',
    });
    await appendChildEvent(db, runId, companyId, projectId, 'child.cancel_requested', {
      stepKey: steps[1].gateConfig.stepKey as string,
    });
    await projectAllEvents(db, runId);

    const stepsAfter = await getProjectPlanSteps(db, plans[0].id);
    expect(stepsAfter[0].status).toBe('blocked');
    expect(stepsAfter[1].status).toBe('skipped');
    // Failed step clears any completion metadata.
    expect(stepsAfter[0].completedAt).toBeNull();

    await closeTestDb();
  });

  it('does not regress a terminal step status with a later non-terminal event', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(
      db,
      '__mtest__ progress-proj-noregress',
    );
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);
    const row = await getRunRow(db, runId);
    const revision = await getCurrentRevision(db, runId);
    await approvePlan(app, base, runId, row!.stateVersion, revision!.id, revision!.contentHash);
    await projectAllEvents(db, runId);

    const plans = await getProjectPlans(db, companyId, projectId);
    const steps = await getProjectPlanSteps(db, plans[0].id);
    const stepKey = steps[0].gateConfig.stepKey as string;

    // Complete the step, then emit a stale started event with a LOWER
    // sequence by inserting it but projecting only that older event after
    // the completed link is already tracked.
    await appendChildEvent(db, runId, companyId, projectId, 'child.started', { stepKey });
    await appendChildEvent(db, runId, companyId, projectId, 'child.completed', { stepKey });
    await projectAllEvents(db, runId);
    const stepsAfter = await getProjectPlanSteps(db, plans[0].id);
    expect(stepsAfter[0].status).toBe('completed');

    // Re-project all events (replay) — completed must not regress to in_progress.
    await projectAllEvents(db, runId);
    const stepsReplayed = await getProjectPlanSteps(db, plans[0].id);
    expect(stepsReplayed[0].status).toBe('completed');

    await closeTestDb();
  });

  it('records a retryable failure when the step projection has not converged yet', async () => {
    enableMissionFlag();
    enableHarness();
    const db = await createTestDb();
    const { companyId, projectId, threadId } = await seedScope(
      db,
      '__mtest__ progress-proj-missing',
    );
    const base = `/api/companies/${companyId}/projects/${projectId}/mission-runs`;
    const app = await createTestServer(db);

    const res = await startPlanningRun(app, base, threadId);
    const runId = res.body.data.run.id as string;
    await publishPlanAndWait(db, runId);
    // Do NOT approve/project — no project_plan_step rows exist yet.

    // Emit a child.started for a step that has no projected step row.
    await appendChildEvent(db, runId, companyId, projectId, 'child.started', {
      stepKey: 'step-1',
    });
    await projectAllEvents(db, runId);

    // The progress link is recorded as failed (retryable) — not active.
    const progressLinks = await getProgressLinks(db, runId);
    expect(progressLinks.length).toBeGreaterThanOrEqual(1);
    expect(progressLinks.every((l) => l.status === 'failed')).toBe(true);

    await closeTestDb();
  });
});
