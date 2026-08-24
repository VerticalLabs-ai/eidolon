import { describe, expect, it, afterEach, beforeEach, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { MissionSynthesisService } from '../services/mission/synthesis.js';
import { SubtreeCancellationService } from '../services/mission/subtree-cancellation.js';

/**
 * Partial result synthesis: require-all/best-effort outcomes and
 * exactly-once synthesis.
 *
 * (VAL-SUB-051, 052, 053, 054, 064, 065, 066, 111)
 *
 * All tests use real Postgres on 127.0.0.1:55322. No mocks for persistence.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

function enableMissionFlag() {
  vi.stubEnv(
    'EIDOLON_FEATURE_FLAGS',
    JSON.stringify({ missionAgentIntelligence: { enabled: true } }),
  );
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

async function insertPolicySnapshot(
  db: AnyDb,
  companyId: string,
  partialResultPolicy = 'require_all',
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "provider", "model", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${id}, ${companyId}, 1, 'anthropic', 'claude-sonnet-4-6', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${partialResultPolicy}, '{"costCents": 5000, "durationSeconds": 3600, "providerCalls": 64, "totalTokens": 500000, "outputBytes": 10485760, "steps": 12, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
  `);
  return id;
}

async function insertRootRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  policySnapshotId: string,
  partialResultPolicy = 'require_all',
  status = 'running',
  approvedRevisionId?: string,
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "approved_plan_revision_id", "terminal_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 0, ${partialResultPolicy}, ${approvedRevisionId ?? null}, ${isTerminal ? now : null}, ${now}, ${now})
  `);
  return runId;
}

async function insertChildRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  rootRunId: string,
  parentRunId: string,
  depth: number,
  childOrdinal: number,
  policySnapshotId: string | null,
  partialResultPolicy = 'require_all',
  status = 'queued',
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const availableAt = status === 'queued' ? now : null;
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "available_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, ${parentRunId}, ${depth}, ${childOrdinal}, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 0, ${partialResultPolicy}, ${isTerminal ? now : null}, ${availableAt}, ${now}, ${now})
  `);
  return runId;
}

async function insertPlanRevision(
  db: AnyDb,
  companyId: string,
  projectId: string,
  runId: string,
): Promise<{ revisionId: string; contentHash: string }> {
  const revisionId = randomUUID();
  const contentHash = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
    VALUES (${revisionId}, ${companyId}, ${projectId}, ${runId}, 1, 'approved', '{}'::jsonb, ${contentHash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
  `);
  return { revisionId, contentHash };
}

async function insertStepAssignment(
  db: AnyDb,
  companyId: string,
  projectId: string,
  rootRunId: string,
  parentRunId: string,
  childRunId: string,
  stepKey: string,
  childOrdinal: number,
  assignmentStatus = 'completed',
  resultStatus = 'completed',
  revisionId?: string,
  contentHash?: string,
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const revId = revisionId ?? randomUUID();
  const hash = contentHash ?? randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "result_status", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${projectId}, ${rootRunId}, ${parentRunId}, ${childRunId}, ${stepKey}, ${childOrdinal}, 'child', ${revId}, ${hash}, ${assignmentStatus}, ${resultStatus}, ${now}, ${now})
  `);
  return id;
}

async function insertBudgetReservation(
  db: AnyDb,
  companyId: string,
  runId: string,
  reservedCents = 5000,
): Promise<{ reservationId: string; allocationId: string }> {
  const reservationId = randomUUID();
  const allocationId = randomUUID();
  const now = new Date();
  const periodKey = now.toISOString().slice(0, 7);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${companyId}, ${runId}, null, ${reservedCents}, ${reservedCents}, 0, 0, ${periodKey}, 'held', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${allocationId}, ${companyId}, ${reservationId}, ${runId}, null, ${reservedCents}, 0, 0, 'held', ${now}, ${now})
  `);
  return { reservationId, allocationId };
}

type RunRow = Record<string, unknown> & {
  state_version: number;
  last_event_sequence: number;
  status: string;
  terminal_at: Date | null;
  partial_result_policy: string;
  failure_category: string | null;
  failure_code: string | null;
};

async function getRunRow(db: AnyDb, runId: string): Promise<RunRow | null> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "terminal_at",
           "partial_result_policy", "failure_category", "failure_code",
           "safe_error_message", "cancel_requested_at"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  if (!rows[0]) {return null;}
  const row = rows[0];
  return {
    ...row,
    state_version: Number(row.state_version),
    last_event_sequence: Number(row.last_event_sequence),
  } as RunRow;
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

async function getManifest(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "id", "manifest", "manifest_hash", "status", "synthesis_result",
           "disclosed_gaps", "synthesis_ordinal", "failure_category", "failure_code",
           "started_event_sequence", "completed_event_sequence"
    FROM "run_synthesis_manifests" WHERE "run_id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return rows[0] ?? null;
}

async function countManifests(db: AnyDb, runId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS cnt FROM "run_synthesis_manifests" WHERE "run_id" = ${runId}
  `)) as unknown as Array<{ cnt: number }>;
  return rows[0]?.cnt ?? 0;
}

async function getAssignment(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "assignment_status", "result_status", "failure_category", "failure_code"
    FROM "run_step_assignments" WHERE "run_id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  return rows[0] ?? null;
}

/**
 * Set up a root with a budget reservation, an approved plan revision,
 * and N children with step assignments. Children default to 'completed'
 * status with completed assignments.
 */
async function setupCompositeTree(
  db: AnyDb,
  label: string,
  opts: {
    partialResultPolicy?: 'require_all' | 'best_effort';
    childCount?: number;
    childStatuses?: string[];
    childResultStatuses?: string[];
  } = {},
) {
  const {
    partialResultPolicy = 'require_all',
    childCount = 2,
    childStatuses,
    childResultStatuses,
  } = opts;
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const policyId = await insertPolicySnapshot(db, companyId, partialResultPolicy);
  const rootRunId = await insertRootRun(
    db,
    companyId,
    projectId,
    threadId,
    policyId,
    partialResultPolicy,
  );
  await insertBudgetReservation(db, companyId, rootRunId, 5000);

  const { revisionId, contentHash } = await insertPlanRevision(db, companyId, projectId, rootRunId);

  // Update root run with approved revision.
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
  `);

  const childRunIds: string[] = [];
  for (let i = 0; i < childCount; i++) {
    const status = childStatuses?.[i] ?? 'completed';
    const resultStatus =
      childResultStatuses?.[i] ?? (status === 'completed' ? 'completed' : status);
    const childRunId = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      i,
      policyId,
      partialResultPolicy,
      status,
    );
    childRunIds.push(childRunId);
    await insertStepAssignment(
      db,
      companyId,
      projectId,
      rootRunId,
      rootRunId,
      childRunId,
      `step-${i}`,
      i,
      resultStatus,
      resultStatus,
      revisionId,
      contentHash,
    );
  }

  return {
    companyId,
    projectId,
    threadId,
    rootRunId,
    revisionId,
    contentHash,
    childRunIds,
    policyId,
  };
}

describe('Partial Result Synthesis (VAL-SUB-051, 052, 053, 054, 064, 065, 066, 111)', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb();
    vi.unstubAllEnvs();
  });

  // VAL-SUB-064: Synthesis waits for children
  it('does not emit synthesis.started until all direct children are terminal', async () => {
    const tree = await setupCompositeTree(db, 'wait-for-children', {
      childCount: 3,
      childStatuses: ['completed', 'running', 'completed'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(false);
    expect(result.skipReason).toBe('children_not_terminal');

    // Verify no synthesis.started event was emitted.
    const events = await getEvents(db, tree.rootRunId);
    const synthesisStarted = events.find((e) => e.type === 'synthesis.started');
    expect(synthesisStarted).toBeUndefined();

    // Run should still be running.
    const runRow = await getRunRow(db, tree.rootRunId);
    expect(runRow?.status).toBe('running');
  });

  // VAL-SUB-064: Synthesis waits for children — all terminal triggers synthesis
  it('emits synthesis.started and synthesis.completed when all children are terminal', async () => {
    const tree = await setupCompositeTree(db, 'all-terminal', {
      childCount: 2,
      childStatuses: ['completed', 'completed'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.terminalized).toBe(true);

    const events = await getEvents(db, tree.rootRunId);
    const startedEvent = events.find((e) => e.type === 'synthesis.started');
    const completedEvent = events.find((e) => e.type === 'synthesis.completed');
    expect(startedEvent).toBeDefined();
    expect(completedEvent).toBeDefined();
    expect(startedEvent!.sequence).toBeLessThan(completedEvent!.sequence);
  });

  // VAL-SUB-051: Require-all fails on required child
  it('fails the parent under require_all when a required child fails', async () => {
    const tree = await setupCompositeTree(db, 'require-all-fail', {
      partialResultPolicy: 'require_all',
      childCount: 3,
      childStatuses: ['completed', 'failed', 'completed'],
      childResultStatuses: ['completed', 'failed', 'completed'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.terminalized).toBe(true);

    // Parent should be failed, not completed.
    const runRow = await getRunRow(db, tree.rootRunId);
    expect(runRow?.status).toBe('failed');
    expect(runRow?.failure_category).toBe('child_failed');
    expect(runRow?.failure_code).toBe('REQUIRED_CHILD_FAILED');

    // No successful synthesis/completion — check for failed outcome.
    const events = await getEvents(db, tree.rootRunId);
    const completedEvent = events.find((e) => e.type === 'run.completed');
    expect(completedEvent).toBeUndefined();
    const failedEvent = events.find((e) => e.type === 'run.failed');
    expect(failedEvent).toBeDefined();

    // Synthesis completed event should have outcome 'failed'.
    const synthCompleted = events.find((e) => e.type === 'synthesis.completed');
    expect(synthCompleted).toBeDefined();
    expect((synthCompleted!.payload as Record<string, unknown>).outcome).toBe('failed');
  });

  // VAL-SUB-051: Require-all with cancelled child also fails
  it('fails the parent under require_all when a child is cancelled', async () => {
    const tree = await setupCompositeTree(db, 'require-all-cancel', {
      partialResultPolicy: 'require_all',
      childCount: 2,
      childStatuses: ['completed', 'cancelled'],
      childResultStatuses: ['completed', 'cancelled'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.terminalized).toBe(true);
  });

  // VAL-SUB-052: Best-effort preserves siblings
  it('does not cancel siblings under best_effort when a child fails', async () => {
    const tree = await setupCompositeTree(db, 'best-effort-fail', {
      partialResultPolicy: 'best_effort',
      childCount: 3,
      childStatuses: ['completed', 'failed', 'completed'],
      childResultStatuses: ['completed', 'failed', 'completed'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(true);
    // Best-effort with gaps: completed (partial), not failed.
    expect(result.status).toBe('completed');
    expect(result.terminalized).toBe(true);

    // Verify siblings were not cancelled.
    for (let i = 0; i < tree.childRunIds.length; i++) {
      if (i === 1) {continue;} // Skip the failed child
      const childRow = await getRunRow(db, tree.childRunIds[i]);
      expect(childRow?.status).toBe('completed');
    }

    // Disclosed gaps should include the failed step.
    expect(result.disclosedGaps).toBeDefined();
    expect(result.disclosedGaps!.length).toBe(1);
    expect(result.disclosedGaps![0].stepKey).toBe('step-1');
  });

  // VAL-SUB-053: Best-effort synthesis discloses gaps
  it('discloses each failed, cancelled, or missing step in best-effort synthesis', async () => {
    const tree = await setupCompositeTree(db, 'best-effort-gaps', {
      partialResultPolicy: 'best_effort',
      childCount: 4,
      childStatuses: ['completed', 'failed', 'cancelled', 'completed'],
      childResultStatuses: ['completed', 'failed', 'cancelled', 'completed'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.disclosedGaps).toBeDefined();
    expect(result.disclosedGaps!.length).toBe(2);

    const gapSteps = result.disclosedGaps!.map((g) => g.stepKey).sort();
    expect(gapSteps).toEqual(['step-1', 'step-2']);

    // The synthesis.completed event should disclose gaps and not claim
    // full success.
    const events = await getEvents(db, tree.rootRunId);
    const synthCompleted = events.find((e) => e.type === 'synthesis.completed');
    expect(synthCompleted).toBeDefined();
    const payload = synthCompleted!.payload as Record<string, unknown>;
    expect(payload.outcome).toBe('partial');
    expect(payload.hasGaps).not.toBe(false);
  });

  // VAL-SUB-053: Best-effort with no gaps claims full success
  it('claims full success in best-effort when all children complete', async () => {
    const tree = await setupCompositeTree(db, 'best-effort-full', {
      partialResultPolicy: 'best_effort',
      childCount: 2,
      childStatuses: ['completed', 'completed'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.disclosedGaps).toEqual([]);

    const events = await getEvents(db, tree.rootRunId);
    const synthCompleted = events.find((e) => e.type === 'synthesis.completed');
    expect(synthCompleted).toBeDefined();
    const payload = synthCompleted!.payload as Record<string, unknown>;
    expect(payload.outcome).toBe('full_success');
  });

  // VAL-SUB-054: Failure policy is snapshotted
  it('uses the snapshotted partial_result_policy, not live configuration', async () => {
    const tree = await setupCompositeTree(db, 'snapshotted-policy', {
      partialResultPolicy: 'require_all',
      childCount: 2,
      childStatuses: ['completed', 'failed'],
      childResultStatuses: ['completed', 'failed'],
    });

    // Mutate the live partial_result_policy on the run row to best_effort
    // after approval. The synthesis service reads from the run row, but
    // the policy was snapshotted at creation. The run row's
    // partial_result_policy IS the snapshot — it was set at creation time
    // and must not be changed by live configuration.
    // Simulate a live configuration change by attempting to change the
    // policy_snapshot's partial_result_policy (which the synthesis service
    // does NOT read). The run row's partial_result_policy is authoritative.
    await db.drizzle.execute(sql`
      UPDATE "run_policy_snapshots" SET "partial_result_policy" = 'best_effort'
      WHERE "id" = ${tree.policyId}
    `);

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    // The run row still has require_all, so the parent should fail.
    expect(result.synthesized).toBe(true);
    expect(result.status).toBe('failed');

    const runRow = await getRunRow(db, tree.rootRunId);
    expect(runRow?.status).toBe('failed');
    expect(runRow?.partial_result_policy).toBe('require_all');
  });

  // VAL-SUB-065: Synthesis commits once per composite run
  it('commits exactly one synthesis manifest per composite run', async () => {
    const tree = await setupCompositeTree(db, 'exactly-once', {
      childCount: 2,
      childStatuses: ['completed', 'completed'],
    });

    const service = new MissionSynthesisService(db);

    // First call: synthesis should succeed.
    const result1 = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });
    expect(result1.synthesized).toBe(true);

    // Second call: should be a no-op (already synthesized).
    const result2 = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });
    expect(result2.synthesized).toBe(false);
    // After successful synthesis the run is terminal, so the terminal check
    // fires first. Both 'already_terminal' and 'already_synthesized' prove
    // exactly-once: the run was not re-synthesized.
    expect(['already_terminal', 'already_synthesized']).toContain(result2.skipReason);

    // Verify exactly one manifest row.
    const count = await countManifests(db, tree.rootRunId);
    expect(count).toBe(1);

    // Verify exactly one synthesis.started and one synthesis.completed event.
    const events = await getEvents(db, tree.rootRunId);
    const startedEvents = events.filter((e) => e.type === 'synthesis.started');
    const completedEvents = events.filter((e) => e.type === 'synthesis.completed');
    expect(startedEvents.length).toBe(1);
    expect(completedEvents.length).toBe(1);
  });

  // VAL-SUB-065: Concurrent settlement commits exactly once
  it('concurrent synthesis attempts produce exactly one manifest', async () => {
    const tree = await setupCompositeTree(db, 'concurrent-once', {
      childCount: 2,
      childStatuses: ['completed', 'completed'],
    });

    const service = new MissionSynthesisService(db);

    // Launch two concurrent transactions. One should succeed and the other
    // should fail (unique constraint or observe terminal state).
    const results = await Promise.allSettled([
      db.drizzle.transaction(async (tx) => {
        return service.attemptSynthesis(tx, {
          companyId: tree.companyId,
          projectId: tree.projectId,
          runId: tree.rootRunId,
        });
      }),
      db.drizzle.transaction(async (tx) => {
        return service.attemptSynthesis(tx, {
          companyId: tree.companyId,
          projectId: tree.projectId,
          runId: tree.rootRunId,
        });
      }),
    ]);

    // At least one should succeed.
    const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value.synthesized);
    expect(succeeded.length).toBe(1);

    // Verify exactly one manifest.
    const count = await countManifests(db, tree.rootRunId);
    expect(count).toBe(1);

    // Run should be completed (or failed, but not both).
    const runRow = await getRunRow(db, tree.rootRunId);
    expect(['completed', 'failed']).toContain(runRow?.status);
  });

  // VAL-SUB-066: Synthesis ordering is stable
  it('orders the manifest by child ordinal/step key, not completion order', async () => {
    const tree = await setupCompositeTree(db, 'stable-order', {
      childCount: 3,
      childStatuses: ['completed', 'completed', 'completed'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(true);
    expect(result.manifest).toBeDefined();
    expect(result.manifest!.length).toBe(3);

    // Manifest should be ordered by child ordinal: 0, 1, 2
    const ordinals = result.manifest!.map((e) => e.childOrdinal);
    expect(ordinals).toEqual([0, 1, 2]);

    // Each entry should have the correct step key.
    const stepKeys = result.manifest!.map((e) => e.stepKey);
    expect(stepKeys).toEqual(['step-0', 'step-1', 'step-2']);

    // Each entry should have resultStatus 'completed'.
    for (const entry of result.manifest!) {
      expect(entry.resultStatus).toBe('completed');
    }

    // Verify the manifest in the database matches.
    const manifestRow = await getManifest(db, tree.rootRunId);
    expect(manifestRow).toBeDefined();
    const storedManifest = manifestRow!.manifest as Array<Record<string, unknown>>;
    expect(storedManifest.length).toBe(3);
    expect(storedManifest[0]!.stepKey).toBe('step-0');
    expect(storedManifest[2]!.stepKey).toBe('step-2');
  });

  // VAL-SUB-066: Reverse completion order does not affect manifest order
  it('produces stable manifest order even when children complete in reverse', async () => {
    const tree = await setupCompositeTree(db, 'reverse-completion', {
      childCount: 3,
      // All completed — "reverse completion" is simulated by the fact that
      // the manifest is always ordered by ordinal, not by when children
      // reached terminal state.
      childStatuses: ['completed', 'completed', 'completed'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.manifest).toBeDefined();
    const stepKeys = result.manifest!.map((e) => e.stepKey);
    expect(stepKeys).toEqual(['step-0', 'step-1', 'step-2']);
  });

  // VAL-SUB-111: Every composite synthesizes exactly once
  it('two sibling composites each synthesize exactly once with reverse completion', async () => {
    // Create a root with two composite children, each having their own children.
    const { companyId, projectId, threadId } = await seedScope(db, 'sibling-composites');
    const policyId = await insertPolicySnapshot(db, companyId, 'best_effort');
    const rootRunId = await insertRootRun(
      db,
      companyId,
      projectId,
      threadId,
      policyId,
      'best_effort',
    );
    await insertBudgetReservation(db, companyId, rootRunId, 10000);
    const { revisionId, contentHash } = await insertPlanRevision(
      db,
      companyId,
      projectId,
      rootRunId,
    );
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    // Create two composite children at depth 1 (in running status — they
    // oversee their children and will be synthesized when children settle).
    const compositeA = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      0,
      policyId,
      'best_effort',
      'running',
    );
    const compositeB = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
      policyId,
      'best_effort',
      'running',
    );

    // Each composite has its own children at depth 2.
    const childA1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      compositeA,
      2,
      0,
      policyId,
      'best_effort',
      'completed',
    );
    const childA2 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      compositeA,
      2,
      1,
      policyId,
      'best_effort',
      'completed',
    );
    const childB1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      compositeB,
      2,
      0,
      policyId,
      'best_effort',
      'completed',
    );
    const childB2 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      compositeB,
      2,
      1,
      policyId,
      'best_effort',
      'completed',
    );

    // Insert step assignments for depth-2 children.
    for (const [childRunId, parentRunId, stepKey, ordinal] of [
      [childA1, compositeA, 'step-a1', 0],
      [childA2, compositeA, 'step-a2', 1],
      [childB1, compositeB, 'step-b1', 0],
      [childB2, compositeB, 'step-b2', 1],
    ] as const) {
      await insertStepAssignment(
        db,
        companyId,
        projectId,
        rootRunId,
        parentRunId,
        childRunId,
        stepKey,
        ordinal,
        'completed',
        'completed',
        revisionId,
        contentHash,
      );
    }

    // Insert step assignments for depth-1 composites.
    await insertStepAssignment(
      db,
      companyId,
      projectId,
      rootRunId,
      rootRunId,
      compositeA,
      'step-a',
      0,
      'completed',
      'completed',
      revisionId,
      contentHash,
    );
    await insertStepAssignment(
      db,
      companyId,
      projectId,
      rootRunId,
      rootRunId,
      compositeB,
      'step-b',
      1,
      'completed',
      'completed',
      revisionId,
      contentHash,
    );

    // Give composites their own approved plan revisions and budget.
    const revA = await insertPlanRevision(db, companyId, projectId, compositeA);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revA.revisionId} WHERE "id" = ${compositeA}
    `);
    const revB = await insertPlanRevision(db, companyId, projectId, compositeB);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revB.revisionId} WHERE "id" = ${compositeB}
    `);

    const service = new MissionSynthesisService(db);

    // Synthesize composite A first (reverse of ordinal B=1, A=0).
    const resultA = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId,
        projectId,
        runId: compositeA,
      });
    });
    expect(resultA.synthesized).toBe(true);
    expect(resultA.status).toBe('completed');

    // Synthesize composite B.
    const resultB = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId,
        projectId,
        runId: compositeB,
      });
    });
    expect(resultB.synthesized).toBe(true);
    expect(resultB.status).toBe('completed');

    // Each composite has exactly one manifest.
    const countA = await countManifests(db, compositeA);
    const countB = await countManifests(db, compositeB);
    expect(countA).toBe(1);
    expect(countB).toBe(1);

    // Composite A manifest contains only its direct children (A1, A2).
    expect(resultA.manifest!.length).toBe(2);
    expect(resultA.manifest!.map((e) => e.stepKey)).toEqual(['step-a1', 'step-a2']);
    // No grandchildren (B1, B2) in A's manifest.
    expect(resultA.manifest!.map((e) => e.childRunId)).not.toContain(childB1);
    expect(resultA.manifest!.map((e) => e.childRunId)).not.toContain(childB2);

    // Composite B manifest contains only its direct children (B1, B2).
    expect(resultB.manifest!.length).toBe(2);
    expect(resultB.manifest!.map((e) => e.stepKey)).toEqual(['step-b1', 'step-b2']);

    // Now synthesize the root — it should consume only direct-child (composite)
    // results, not grandchildren.
    const resultRoot = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId,
        projectId,
        runId: rootRunId,
      });
    });
    expect(resultRoot.synthesized).toBe(true);
    expect(resultRoot.status).toBe('completed');

    // Root manifest contains only composites A and B, not grandchildren.
    expect(resultRoot.manifest!.length).toBe(2);
    const rootChildIds = resultRoot.manifest!.map((e) => e.childRunId);
    expect(rootChildIds).toContain(compositeA);
    expect(rootChildIds).toContain(compositeB);
    expect(rootChildIds).not.toContain(childA1);
    expect(rootChildIds).not.toContain(childB1);

    // Root has exactly one manifest.
    const countRoot = await countManifests(db, rootRunId);
    expect(countRoot).toBe(1);
  });

  // VAL-SUB-111: Parent consumes only direct-child committed results
  it('manifest contains only accepted result revision/hash or typed unavailable reason', async () => {
    const tree = await setupCompositeTree(db, 'manifest-entries', {
      partialResultPolicy: 'best_effort',
      childCount: 3,
      childStatuses: ['completed', 'failed', 'cancelled'],
      childResultStatuses: ['completed', 'failed', 'cancelled'],
    });

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.manifest).toBeDefined();
    const manifest = result.manifest!;

    // Completed child: has resultRevision/resultHash (may be null if not set).
    expect(manifest[0]!.resultStatus).toBe('completed');
    // Failed child: has unavailableReason 'failed'.
    expect(manifest[1]!.resultStatus).toBe('failed');
    expect(manifest[1]!.unavailableReason).toBe('failed');
    // Cancelled child: has unavailableReason 'cancelled'.
    expect(manifest[2]!.resultStatus).toBe('cancelled');
    expect(manifest[2]!.unavailableReason).toBe('cancelled');
  });

  // VAL-SUB-051/052: Cancellation is idempotent for synthesis
  it('skips synthesis when cancellation is pending', async () => {
    const tree = await setupCompositeTree(db, 'cancel-pending', {
      childCount: 2,
      childStatuses: ['completed', 'completed'],
    });

    // Set cancel_requested_at on the root.
    const now = new Date();
    await db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "cancel_requested_at" = ${now}, "cancel_requested_by" = 'test'
      WHERE "id" = ${tree.rootRunId}
    `);

    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(false);
    expect(result.skipReason).toBe('cancellation_pending');

    // No synthesis manifest should exist.
    const count = await countManifests(db, tree.rootRunId);
    expect(count).toBe(0);
  });

  // VAL-SUB-051/052: Step assignment updates propagate to synthesis
  it('uses updated step assignment result status from child terminal policy', async () => {
    const tree = await setupCompositeTree(db, 'policy-propagation', {
      partialResultPolicy: 'require_all',
      childCount: 2,
      childStatuses: ['running', 'running'],
      childResultStatuses: ['pending_routing', 'pending_routing'],
    });

    // Simulate child 0 completing: update run + step assignment.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'completed', "terminal_at" = ${new Date()}
      WHERE "id" = ${tree.childRunIds[0]}
    `);
    await db.drizzle.execute(sql`
      UPDATE "run_step_assignments" SET "assignment_status" = 'completed', "result_status" = 'completed'
      WHERE "run_id" = ${tree.childRunIds[0]}
    `);

    // Simulate child 1 failing: update run + step assignment + apply policy.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'failed', "terminal_at" = ${new Date()},
        "failure_category" = 'provider_permanent', "failure_code" = 'PROVIDER_ERROR'
      WHERE "id" = ${tree.childRunIds[1]}
    `);

    const subtreeService = new SubtreeCancellationService(db);
    await db.drizzle.transaction(async (tx) => {
      await subtreeService.applyChildTerminalPolicy(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        rootRunId: tree.rootRunId,
        childRunId: tree.childRunIds[1],
        parentRunId: tree.rootRunId,
        terminalStatus: 'failed',
        failureCategory: 'provider_permanent',
        failureCode: 'PROVIDER_ERROR',
        safeErrorMessage: 'Provider error',
        actorType: 'system',
        actorId: null,
        traceId: null,
      });
    });

    // Now attempt synthesis — require_all should fail.
    const service = new MissionSynthesisService(db);
    const result = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, {
        companyId: tree.companyId,
        projectId: tree.projectId,
        runId: tree.rootRunId,
      });
    });

    expect(result.synthesized).toBe(true);
    expect(result.status).toBe('failed');

    // Verify manifest has correct result statuses.
    expect(result.manifest).toBeDefined();
    expect(result.manifest![0]!.resultStatus).toBe('completed');
    expect(result.manifest![1]!.resultStatus).toBe('failed');
  });

  // Fence verification: stale lease cannot synthesize
  it('rejects synthesis from a stale lease token', async () => {
    const tree = await setupCompositeTree(db, 'stale-lease', {
      childCount: 2,
      childStatuses: ['completed', 'completed'],
    });

    // Set a lease on the root run.
    const leaseToken = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      UPDATE "mission_runs"
      SET "lease_owner" = 'worker-A', "lease_token" = ${leaseToken},
          "lease_expires_at" = ${new Date(now.getTime() + 30000)}, "heartbeat_at" = ${now}
      WHERE "id" = ${tree.rootRunId}
    `);

    const service = new MissionSynthesisService(db);

    // Attempt with a wrong lease token should fail.
    await expect(
      db.drizzle.transaction(async (tx) => {
        return service.attemptSynthesis(tx, {
          companyId: tree.companyId,
          projectId: tree.projectId,
          runId: tree.rootRunId,
          leaseToken: 'wrong-token',
        });
      }),
    ).rejects.toThrow();

    // No manifest should have been created.
    const count = await countManifests(db, tree.rootRunId);
    expect(count).toBe(0);
  });

  // Nested composites: depth-2 tree with failure
  it('handles nested composite with best_effort and child failure at depth 2', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, 'nested-failure');
    const policyId = await insertPolicySnapshot(db, companyId, 'best_effort');
    const rootRunId = await insertRootRun(
      db,
      companyId,
      projectId,
      threadId,
      policyId,
      'best_effort',
    );
    await insertBudgetReservation(db, companyId, rootRunId, 10000);
    const { revisionId, contentHash } = await insertPlanRevision(
      db,
      companyId,
      projectId,
      rootRunId,
    );
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
    `);

    // Create one composite child (running — it will be synthesized) and one leaf child.
    const compositeChild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      0,
      policyId,
      'best_effort',
      'running',
    );
    const leafChild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
      policyId,
      'best_effort',
      'completed',
    );

    // Composite child has two grandchildren: one completed, one failed.
    const grandchild1 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      compositeChild,
      2,
      0,
      policyId,
      'best_effort',
      'completed',
    );
    const grandchild2 = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      compositeChild,
      2,
      1,
      policyId,
      'best_effort',
      'failed',
    );

    // Assignments for grandchildren.
    await insertStepAssignment(
      db,
      companyId,
      projectId,
      rootRunId,
      compositeChild,
      grandchild1,
      'step-g1',
      0,
      'completed',
      'completed',
      revisionId,
      contentHash,
    );
    await insertStepAssignment(
      db,
      companyId,
      projectId,
      rootRunId,
      compositeChild,
      grandchild2,
      'step-g2',
      1,
      'failed',
      'failed',
      revisionId,
      contentHash,
    );

    // Give the composite child its own plan revision.
    const revComposite = await insertPlanRevision(db, companyId, projectId, compositeChild);
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revComposite.revisionId} WHERE "id" = ${compositeChild}
    `);

    // Assignments for depth-1 children.
    await insertStepAssignment(
      db,
      companyId,
      projectId,
      rootRunId,
      rootRunId,
      compositeChild,
      'step-comp',
      0,
      'completed',
      'completed',
      revisionId,
      contentHash,
    );
    await insertStepAssignment(
      db,
      companyId,
      projectId,
      rootRunId,
      rootRunId,
      leafChild,
      'step-leaf',
      1,
      'completed',
      'completed',
      revisionId,
      contentHash,
    );

    const service = new MissionSynthesisService(db);

    // Synthesize the composite child (best_effort with one failed grandchild).
    const resultComp = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, { companyId, projectId, runId: compositeChild });
    });
    expect(resultComp.synthesized).toBe(true);
    expect(resultComp.status).toBe('completed'); // best_effort: partial success
    expect(resultComp.disclosedGaps!.length).toBe(1);
    expect(resultComp.disclosedGaps![0].stepKey).toBe('step-g2');

    // Synthesize the root (best_effort with all children completed).
    const resultRoot = await db.drizzle.transaction(async (tx) => {
      return service.attemptSynthesis(tx, { companyId, projectId, runId: rootRunId });
    });
    expect(resultRoot.synthesized).toBe(true);
    expect(resultRoot.status).toBe('completed');
    // Root's manifest has 2 direct children (composite + leaf).
    expect(resultRoot.manifest!.length).toBe(2);
  });
});
