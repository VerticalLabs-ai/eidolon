import { describe, expect, it, afterEach, beforeEach, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { MissionCancellationService } from '../services/mission/cancellation.js';
import { MissionKillSwitchService } from '../services/mission/kill-switch.js';

/**
 * Cancellation cascade convergence: sequence-collision bug fix.
 *
 * Bug: enforceDeadlines() throws a run_events (run_id, sequence) unique-
 * constraint violation in applyParentPolicyOnChildTerminal when
 * terminalizing a cancel-requested child whose child.cancel_requested
 * event was already emitted by the require_all_policy_cascade. The error
 * is swallowed by the worker's non-fatal deadline-sweep catch block, so
 * the sweep retries and collides every ~10s and no cancel-requested run
 * terminalizes.
 *
 * Fix:
 *  1. applyParentPolicyOnChildTerminal skips re-emitting
 *     child.cancel_requested when the sibling is already cancel-requested.
 *  2. run_events sequence is atomically re-read and incremented inside
 *     the locked transaction before each event insert.
 *  3. Non-LEASE_NOT_HELD/INVALID_RUN_STATE deadline-sweep errors are
 *     logged, not silently swallowed.
 *
 * (VAL-CROSS-058, VAL-RUN-109, VAL-SUB-096)
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

async function insertBudgetReservation(
  db: AnyDb,
  companyId: string,
  runId: string,
  reservedCents = 1000,
): Promise<void> {
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
}

/**
 * Insert a run that is already cancel-requested with a past deadline and
 * a pre-emitted child.cancel_requested event (simulating the parent
 * cascade). The run has no active lease.
 */
async function insertCancelRequestedRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  rootRunId: string,
  parentRunId: string | null,
  depth: number,
  childOrdinal: number,
  policySnapshotId: string,
  status: string,
  isRoot: boolean,
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const past = new Date(now.getTime() - 120_000);
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);

  if (isRoot) {
    // Root: running, cancel_requested, past deadline, stale lease.
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "cancel_requested_at", "cancel_requested_by", "cancellation_deadline_at", "lease_owner", "lease_token", "lease_expires_at", "started_at", "available_at", "created_at", "updated_at")
      VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 1, 'require_all', ${isTerminal ? now : null}, ${past}, null, ${past}, 'stale-worker', 'stale-token', ${past}, ${now}, ${now}, ${now}, ${now})
    `);
    // Pre-emit run.cancel_requested event at sequence 1.
    const rootPayload = JSON.stringify({ cancellationDeadlineAt: past.toISOString() });
    await db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
      VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${runId}, 1, 'run.cancel_requested', 1, ${rootPayload}::jsonb, 'system', null, null, ${past})
    `);
  } else {
    // Child: queued, cancel_requested, past deadline, no lease.
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "cancel_requested_at", "cancel_requested_by", "cancellation_deadline_at", "lease_owner", "lease_token", "lease_expires_at", "available_at", "created_at", "updated_at")
      VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, ${parentRunId}, ${depth}, ${childOrdinal}, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 1, 'require_all', ${isTerminal ? now : null}, ${past}, null, ${past}, null, null, null, null, ${now}, ${now})
    `);
    // Pre-emit child.cancel_requested event at sequence 1 (already emitted
    // by the parent cascade).
    const childPayload = JSON.stringify({
      parentRunId: rootRunId,
      reason: 'parent_cancel_cascade',
    });
    await db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "actor_type", "actor_id", "trace_id", "occurred_at")
      VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${runId}, 1, 'child.cancel_requested', 1, ${childPayload}::jsonb, 'system', null, null, ${past})
    `);
  }

  return runId;
}

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "terminal_at", "cancel_requested_at", "last_event_sequence", "lease_owner"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

async function getEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{ sequence: string | number; type: string }>;
  return rows.map((r) => ({ sequence: Number(r.sequence), type: r.type }));
}

async function getBudgetStatus(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status" FROM "budget_reservations" WHERE "run_id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

/**
 * Verify that all events for a run have strictly unique, monotonically
 * increasing sequences (no collision / no gap from the run's perspective).
 */
function assertUniqueSequences(events: Array<{ sequence: number; type: string }>): void {
  const seqs = events.map((e) => e.sequence);
  const unique = new Set(seqs);
  expect(unique.size).toBe(seqs.length);
}

describe('fix-ut-m4-cascade-sequence-collision', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('cancel-requested children with already-emitted events terminalize cleanly via enforceDeadlines without sequence collision', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ cascade-collision');
    const policyId = await insertPolicySnapshot(db, companyId, 'require_all');

    // Root: running, cancel-requested, past deadline, stale lease.
    const rootRunId = await insertCancelRequestedRun(
      db,
      companyId,
      projectId,
      threadId,
      '',
      null,
      0,
      0,
      policyId,
      'running',
      true,
    );
    await insertBudgetReservation(db, companyId, rootRunId, 5000);

    // Three queued children, all already cancel-requested with pre-emitted
    // child.cancel_requested events (simulating the parent cascade). All
    // have past deadlines and no active lease. With 3+ children, the
    // recursive applyParentPolicyOnChildTerminal call from terminalizing
    // child A would process sibling C, and then the outer loop would try
    // to process C again with a stale sequence — causing the collision.
    const childA = await insertCancelRequestedRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      0,
      policyId,
      'queued',
      false,
    );
    const childB = await insertCancelRequestedRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
      policyId,
      'queued',
      false,
    );
    const childC = await insertCancelRequestedRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      2,
      policyId,
      'queued',
      false,
    );
    await insertBudgetReservation(db, companyId, childA, 500);
    await insertBudgetReservation(db, companyId, childB, 500);
    await insertBudgetReservation(db, companyId, childC, 500);

    const killSwitch = new MissionKillSwitchService(db);

    // First sweep: terminalizes the children (each in its own transaction).
    // Without the fix, this throws a unique-constraint violation that is
    // silently swallowed by the worker's catch block.
    const result1 = await killSwitch.enforceDeadlines();
    expect(result1.terminalized).toBeGreaterThanOrEqual(3);

    // All three children should be cancelled.
    for (const childId of [childA, childB, childC]) {
      const row = await getRunRow(db, childId);
      expect(row?.status).toBe('cancelled');
      expect(row?.terminal_at).not.toBeNull();
    }

    // Second sweep: root terminalizes now that all descendants are terminal.
    const result2 = await killSwitch.enforceDeadlines();
    expect(result2.terminalized).toBeGreaterThanOrEqual(1);

    const rootRow = await getRunRow(db, rootRunId);
    expect(rootRow?.status).toBe('cancelled');
    expect(rootRow?.terminal_at).not.toBeNull();
    expect(rootRow?.lease_owner).toBeNull();

    // Verify no duplicate sequences for any run (the collision symptom).
    for (const runId of [rootRunId, childA, childB, childC]) {
      const events = await getEvents(db, runId);
      assertUniqueSequences(events);
      // Each run should have run.cancelled and budget.released events.
      const types = events.map((e) => e.type);
      expect(types).toContain('run.cancelled');
      expect(types).toContain('budget.released');
      // run.cancelled must come before budget.released in sequence order.
      const cancelledIdx = types.indexOf('run.cancelled');
      const releasedIdx = types.indexOf('budget.released');
      expect(cancelledIdx).toBeLessThan(releasedIdx);
    }

    // Budget released for all runs.
    for (const runId of [rootRunId, childA, childB, childC]) {
      const budget = await getBudgetStatus(db, runId);
      expect(budget?.status).toBe('released');
    }
  });

  it('does not re-emit child.cancel_requested when the sibling is already cancel-requested', async () => {
    const { companyId, projectId, threadId } = await seedScope(
      db,
      '__mtest__ no-duplicate-cancel-req',
    );
    const policyId = await insertPolicySnapshot(db, companyId, 'require_all');

    // Root with two children, both already cancel-requested.
    const rootRunId = await insertCancelRequestedRun(
      db,
      companyId,
      projectId,
      threadId,
      '',
      null,
      0,
      0,
      policyId,
      'running',
      true,
    );
    await insertBudgetReservation(db, companyId, rootRunId, 5000);

    const childA = await insertCancelRequestedRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      0,
      policyId,
      'queued',
      false,
    );
    const childB = await insertCancelRequestedRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      1,
      policyId,
      'queued',
      false,
    );
    await insertBudgetReservation(db, companyId, childA, 500);
    await insertBudgetReservation(db, companyId, childB, 500);

    // Terminalize child A directly (simulating the deadline sweep).
    const cancelService = new MissionCancellationService(db);
    await db.drizzle.transaction(async (tx) => {
      await cancelService.terminalize(tx, companyId, projectId, childA, {
        actorType: 'system',
        actorId: null,
        traceId: null,
      });
    });

    // Child A should be cancelled.
    const rowA = await getRunRow(db, childA);
    expect(rowA?.status).toBe('cancelled');

    // Child B should still be queued (not terminalized by the cascade —
    // it was already cancel-requested, so applyParentPolicyOnChildTerminal
    // skips it and leaves terminalization to the deadline sweep).
    const rowB = await getRunRow(db, childB);
    expect(rowB?.status).toBe('queued');
    expect(rowB?.cancel_requested_at).not.toBeNull();

    // Child B should have exactly ONE child.cancel_requested event (the
    // one pre-emitted by the parent cascade). The cascade from A's
    // terminalization must NOT have re-emitted a second one.
    const eventsB = await getEvents(db, childB);
    const cancelReqCount = eventsB.filter((e) => e.type === 'child.cancel_requested').length;
    expect(cancelReqCount).toBe(1);
  });

  it('require_all cascade still fires for non-cancel-requested siblings', async () => {
    // Verify the fix doesn't break the normal require_all cascade: when a
    // child terminalizes and a sibling is NOT already cancel-requested,
    // the cascade should still emit child.cancel_requested on that sibling.
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ cascade-still-fires');
    const policyId = await insertPolicySnapshot(db, companyId, 'require_all');

    // Root running with a lease (not cancel-requested).
    const rootRunId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "created_at", "updated_at")
      VALUES (${rootRunId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policyId}, 'running', 1, 0, 'require_all', null, ${now}, ${now})
    `);
    await insertBudgetReservation(db, companyId, rootRunId, 5000);

    // Child A: queued, cancel-requested (will be terminalized).
    const childA = await insertCancelRequestedRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      0,
      policyId,
      'queued',
      false,
    );
    await insertBudgetReservation(db, companyId, childA, 500);

    // Child B: queued, NOT cancel-requested (the cascade should fire here).
    const childB = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "available_at", "created_at", "updated_at")
      VALUES (${childB}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, ${rootRunId}, 1, 1, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'deep_work', ${policyId}, 'queued', 1, 0, 'require_all', null, ${now}, ${now}, ${now})
    `);
    await insertBudgetReservation(db, companyId, childB, 500);

    // Terminalize child A.
    const cancelService = new MissionCancellationService(db);
    await db.drizzle.transaction(async (tx) => {
      await cancelService.terminalize(tx, companyId, projectId, childA, {
        actorType: 'system',
        actorId: null,
        traceId: null,
      });
    });

    // Child A should be cancelled.
    expect((await getRunRow(db, childA))?.status).toBe('cancelled');

    // Child B should now be cancel-requested (cascade fired).
    const rowB = await getRunRow(db, childB);
    expect(rowB?.cancel_requested_at).not.toBeNull();

    // Child B should have a child.cancel_requested event.
    const eventsB = await getEvents(db, childB);
    expect(eventsB.filter((e) => e.type === 'child.cancel_requested').length).toBe(1);
  });
});
