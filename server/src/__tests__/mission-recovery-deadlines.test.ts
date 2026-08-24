import { describe, expect, it, afterEach, beforeEach, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { RunCoordinator } from '../services/mission/coordinator.js';
import { MissionCompletionService } from '../services/mission/completion.js';
import { MissionRecoveryService } from '../services/mission/recovery.js';
import { MissionSnapshotService } from '../services/mission/snapshot.js';
import { MissionKillSwitchService } from '../services/mission/kill-switch.js';
import {
  computeRootDeadline,
  computeChildDeadline,
  terminalizeForDeadlineExpiry,
} from '../services/mission/run-deadline-expiry.js';

/**
 * Child recovery, fencing, reconciliation, deadlines, and mirror completion.
 * (VAL-SUB-055, 056, 057, 059, 098, 112)
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
  durationSeconds = 3600,
  partialResultPolicy = 'require_all',
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "provider", "model", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${id}, ${companyId}, 1, 'anthropic', 'claude-sonnet-4-6', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, ${partialResultPolicy}, ${JSON.stringify({ costCents: 5000, durationSeconds, providerCalls: 64, totalTokens: 500000, outputBytes: 10485760, steps: 12, depth: 2, fanOut: 4, descendants: 16 })}::jsonb, ${randomUUID()}, ${now})
  `);
  return id;
}

async function insertRootRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  policySnapshotId: string,
  opts: {
    status?: string;
    partialResultPolicy?: string;
    createdAt?: Date;
  } = {},
): Promise<string> {
  const runId = randomUUID();
  const now = opts.createdAt ?? new Date();
  const status = opts.status ?? 'running';
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 0, ${opts.partialResultPolicy ?? 'require_all'}, ${isTerminal ? now : null}, ${now}, ${now})
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
  opts: {
    status?: string;
    partialResultPolicy?: string;
    leaseOwner?: string;
    createdAt?: Date;
    executingAgentId?: string | null;
  } = {},
): Promise<string> {
  const runId = randomUUID();
  const now = opts.createdAt ?? new Date();
  const status = opts.status ?? 'queued';
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  const leaseToken = opts.leaseOwner ? randomUUID() : null;
  const leaseExpires = opts.leaseOwner ? new Date(now.getTime() + 30000) : null;
  const availableAt = status === 'queued' && !opts.leaseOwner ? now : null;
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "executing_agent_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "lease_owner", "lease_token", "lease_expires_at", "heartbeat_at", "available_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, ${parentRunId}, ${depth}, ${childOrdinal}, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${opts.executingAgentId ?? null}, ${status}, 1, 0, ${opts.partialResultPolicy ?? 'require_all'}, ${isTerminal ? now : null}, ${opts.leaseOwner ?? null}, ${leaseToken}, ${leaseExpires}, ${opts.leaseOwner ? now : null}, ${availableAt}, ${now}, ${now})
  `);
  return runId;
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

async function setLease(db: AnyDb, runId: string, owner: string, expiresAt: Date): Promise<string> {
  const token = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    UPDATE "mission_runs"
    SET "lease_owner" = ${owner}, "lease_token" = ${token},
        "lease_expires_at" = ${expiresAt}, "heartbeat_at" = ${now},
        "updated_at" = ${now}
    WHERE "id" = ${runId}
  `);
  return token;
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
  assignmentStatus = 'pending_routing',
  revisionId?: string,
  contentHash?: string,
): Promise<void> {
  const id = randomUUID();
  const now = new Date();
  const revId = revisionId ?? randomUUID();
  const hash = contentHash ?? randomUUID();
  if (revisionId === undefined) {
    await db.drizzle.execute(sql`
      INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
      VALUES (${revId}, ${companyId}, ${projectId}, ${rootRunId}, 1, 'approved', '{}'::jsonb, ${hash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
    `);
  }
  await db.drizzle.execute(sql`
    INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${projectId}, ${rootRunId}, ${parentRunId}, ${childRunId}, ${stepKey}, 'child', ${revId}, ${hash}, ${assignmentStatus}, ${now}, ${now})
  `);
}

async function insertToolInvocation(
  db: AnyDb,
  companyId: string,
  projectId: string,
  runId: string,
  opts: {
    replayClass: 'read_only' | 'idempotent_write' | 'non_replayable';
    state: 'prepared' | 'started' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    toolId?: string;
    stepKey?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_tool_invocations" ("id", "company_id", "project_id", "run_id", "step_key", "attempt", "tool_id", "ordinal", "replay_class", "state", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${projectId}, ${runId}, ${opts.stepKey ?? 'child-a'}, 1, ${opts.toolId ?? 'research.search'}, 0, ${opts.replayClass}, ${opts.state}, ${now}, ${now})
  `);
  return id;
}

type RunRow = Record<string, unknown> & {
  state_version: number;
  last_event_sequence: number;
  status: string;
  terminal_at: Date | null;
  lease_token: string | null;
  lease_owner: string | null;
  failure_category: string | null;
  failure_code: string | null;
};

async function getRunRow(db: AnyDb, runId: string): Promise<RunRow | null> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "terminal_at",
           "lease_owner", "lease_token", "lease_expires_at", "failure_category",
           "failure_code", "safe_error_message"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  if (!rows[0]) {
    return null;
  }
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

async function getToolInvocationCount(db: AnyDb, runId: string): Promise<number> {
  const rows = (await db.drizzle.execute(sql`
    SELECT count(*)::int AS cnt FROM "run_tool_invocations" WHERE "run_id" = ${runId}
  `)) as unknown as Array<{ cnt: number }>;
  return Number(rows[0]?.cnt ?? 0);
}

/** Set up a root + 2 children tree with budget and assignments. */
async function setupTree(db: AnyDb, label: string) {
  const { companyId, projectId, threadId } = await seedScope(db, label);
  const policyId = await insertPolicySnapshot(db, companyId);
  const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
    status: 'running',
  });
  await insertBudgetReservation(db, companyId, rootRunId, 5000);
  const childA = await insertChildRun(
    db,
    companyId,
    projectId,
    threadId,
    rootRunId,
    rootRunId,
    1,
    0,
    policyId,
    {
      status: 'queued',
    },
  );
  const childB = await insertChildRun(
    db,
    companyId,
    projectId,
    threadId,
    rootRunId,
    rootRunId,
    1,
    1,
    policyId,
    {
      status: 'running',
      leaseOwner: `w-${randomUUID()}`,
    },
  );
  await insertBudgetReservation(db, companyId, childA, 500);
  await insertBudgetReservation(db, companyId, childB, 500);
  const { revisionId, contentHash } = await insertPlanRevision(db, companyId, projectId, rootRunId);
  await insertStepAssignment(
    db,
    companyId,
    projectId,
    rootRunId,
    rootRunId,
    childA,
    'child-a',
    'queued',
    revisionId,
    contentHash,
  );
  await insertStepAssignment(
    db,
    companyId,
    projectId,
    rootRunId,
    rootRunId,
    childB,
    'child-b',
    'routed',
    revisionId,
    contentHash,
  );
  // Give the children some counters/costs to verify reload stability.
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "provider_call_count" = 2, "input_tokens" = 100, "output_tokens" = 50, "output_bytes" = 2048, "actual_cost_cents" = 25, "last_event_sequence" = 3
    WHERE "id" IN (${childA}, ${childB})
  `);
  // Seed a couple of events so the cursor is non-trivial.
  const now = new Date();
  for (const [cid, seq] of [
    [childA, 1],
    [childA, 2],
    [childA, 3],
    [childB, 1],
    [childB, 2],
    [childB, 3],
  ] as const) {
    await db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "occurred_at")
      VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${cid}, ${seq}, 'execution.progress', 1, '{}'::jsonb, ${now})
    `);
  }
  return { companyId, projectId, threadId, rootRunId, childA, childB, policyId };
}

describe('m4-f06-recovery-deadlines', () => {
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

  // -- VAL-SUB-098: Deadline semantics include waiting time ----------------

  describe('VAL-SUB-098: Deadline semantics include waiting time', () => {
    it('root deadline equals creation plus effective duration', () => {
      const created = new Date('2026-01-01T00:00:00Z');
      const deadline = computeRootDeadline(created, 3600);
      expect(deadline.toISOString()).toBe('2026-01-01T01:00:00.000Z');
    });

    it('child deadline is the minimum of child allowance, parent deadline, and root deadline', () => {
      const rootCreated = new Date('2026-01-01T00:00:00Z');
      const rootDeadline = computeRootDeadline(rootCreated, 3600); // 01:00
      const childCreated = new Date('2026-01-01T00:10:00Z');
      // child allowance = 00:10 + 600s = 00:20; parent deadline = rootDeadline (01:00)
      const childDeadline = computeChildDeadline(childCreated, 600, rootDeadline, rootDeadline);
      expect(childDeadline.toISOString()).toBe('2026-01-01T00:20:00.000Z');
    });

    it('child deadline is bounded by the parent/root deadline when its allowance is longer', () => {
      const rootCreated = new Date('2026-01-01T00:00:00Z');
      const rootDeadline = computeRootDeadline(rootCreated, 600); // 00:10
      const childCreated = new Date('2026-01-01T00:01:00Z');
      // child allowance = 00:01 + 3600 = 01:01; but root deadline 00:10 wins
      const childDeadline = computeChildDeadline(childCreated, 3600, rootDeadline, rootDeadline);
      expect(childDeadline.toISOString()).toBe('2026-01-01T00:10:00.000Z');
    });

    it('deadline timestamps survive restart (re-read from durable rows)', async () => {
      const { companyId, projectId, rootRunId } = await setupTree(db, '__mtest__ deadline-restart');
      const snapshotSvc = new MissionSnapshotService(db);
      const before = await snapshotSvc.getSnapshot(companyId, projectId, rootRunId);
      expect(before.deadlineAt).not.toBeNull();
      // Simulate restart by re-reading (Postgres is the authority).
      const after = await snapshotSvc.getSnapshot(companyId, projectId, rootRunId);
      expect(after.deadlineAt).toBe(before.deadlineAt);
      expect(after.rootRunId).toBe(before.rootRunId);
    });

    it('terminalizes a queued child past its deadline with limit/TIME_LIMIT and no external call', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ deadline-queued');
      // Root with a short 60s duration created 2 hours ago (deadline passed).
      const longAgo = new Date(Date.now() - 7200_000);
      const rootPolicy = await insertPolicySnapshot(db, companyId, 60);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, rootPolicy, {
        status: 'running',
        createdAt: longAgo,
      });
      await insertBudgetReservation(db, companyId, rootRunId, 5000);
      // Child queued, also past its (min) deadline.
      const childPolicy = await insertPolicySnapshot(db, companyId, 60);
      const child = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        childPolicy,
        { status: 'queued', createdAt: longAgo },
      );
      await insertBudgetReservation(db, companyId, child, 500);
      await insertStepAssignment(
        db,
        companyId,
        projectId,
        rootRunId,
        rootRunId,
        child,
        'child-a',
        'queued',
      );

      const now = new Date();
      const killSwitch = new MissionKillSwitchService(db, { clock: () => now });
      await killSwitch.enforceDeadlines();

      const row = await getRunRow(db, child);
      expect(row!.status).toBe('failed');
      expect(row!.failure_category).toBe('limit');
      expect(row!.failure_code).toBe('TIME_LIMIT');
      expect(row!.terminal_at).not.toBeNull();

      // No external provider call was made.
      const callCountRows = (await db.drizzle.execute(sql`
        SELECT "provider_call_count"::int AS cnt FROM "mission_runs" WHERE "id" = ${child}
      `)) as unknown as Array<{ cnt: number }>;
      expect(Number(callCountRows[0]?.cnt ?? 0)).toBe(0);

      const events = await getEvents(db, child);
      expect(events.find((e) => e.type === 'run.failed')).toBeDefined();
      expect(events.find((e) => e.payload?.code === 'TIME_LIMIT')).toBeDefined();
    });

    it('directly terminalizes a waiting run with terminalizeForDeadlineExpiry', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ deadline-direct');
      const policy = await insertPolicySnapshot(db, companyId, 60);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy, {
        status: 'awaiting_input',
      });
      await insertBudgetReservation(db, companyId, rootRunId, 1000);

      const now = new Date();
      await db.drizzle.transaction(async (tx) => {
        const [run] = await tx
          .select()
          .from(db.schema.missionRuns)
          .where(eq(db.schema.missionRuns.id, rootRunId))
          .for('update')
          .limit(1);
        await terminalizeForDeadlineExpiry(db, tx, run!, { clock: () => now }, {});
      });

      const row = await getRunRow(db, rootRunId);
      expect(row!.status).toBe('failed');
      expect(row!.failure_category).toBe('limit');
      expect(row!.failure_code).toBe('TIME_LIMIT');
    });
  });

  // -- VAL-SUB-055: Reload recovers durable child state --------------------

  describe('VAL-SUB-055: Reload recovers durable child state', () => {
    it('re-fetching snapshots after reload returns the same tree, counters, routing, costs, and cursor', async () => {
      const { companyId, projectId, rootRunId, childA, childB } = await setupTree(
        db,
        '__mtest__ reload055',
      );
      const snapshotSvc = new MissionSnapshotService(db);

      const capture = async () => {
        const root = await snapshotSvc.getSnapshot(companyId, projectId, rootRunId);
        const a = await snapshotSvc.getSnapshot(companyId, projectId, childA);
        const b = await snapshotSvc.getSnapshot(companyId, projectId, childB);
        return { root, a, b };
      };
      const before = await capture();
      // Simulate API/browser reload by re-reading authoritative state.
      const after = await capture();

      // Tree identity stable (no recreated children).
      expect(after.root.id).toBe(before.root.id);
      expect(after.a.id).toBe(before.a.id);
      expect(after.b.id).toBe(before.b.id);
      expect(after.a.rootRunId).toBe(rootRunId);
      expect(after.b.rootRunId).toBe(rootRunId);
      expect(after.a.parentRunId).toBe(rootRunId);
      expect(after.a.depth).toBe(1);
      expect(after.a.childOrdinal).toBe(0);
      expect(after.b.childOrdinal).toBe(1);

      // Counters, routing, costs, and cursor stable.
      expect(after.a.providerCallCount).toBe(before.a.providerCallCount);
      expect(after.a.providerCallCount).toBe(2);
      expect(after.a.inputTokens).toBe(100);
      expect(after.a.actualCostCents).toBe(25);
      expect(after.a.lastEventSequence).toBe(before.a.lastEventSequence);
      expect(after.a.lastEventSequence).toBe(3);
      expect(after.a.routingKind).toBe(before.a.routingKind);

      // Child summary on root stable.
      expect(after.root.childSummary).toEqual(before.root.childSummary);
    });
  });

  // -- VAL-SUB-056: Worker restart resumes safely --------------------------

  describe('VAL-SUB-056: Worker restart resumes safely', () => {
    it('recovers a nonterminal child under a new fenced lease with run.recovered and no duplicate child', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ restart056');
      const policy = await insertPolicySnapshot(db, companyId);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy, {
        status: 'running',
      });
      await insertBudgetReservation(db, companyId, rootRunId, 5000);
      // Hold the root with a valid lease so only the expired child is eligible.
      await setLease(db, rootRunId, 'root-worker', new Date(Date.now() + 30000));
      // Child running with a lease that is now expired.
      const pastExpiry = new Date(Date.now() - 60_000);
      const child = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policy,
        { status: 'running', leaseOwner: 'worker-A' },
      );
      await insertBudgetReservation(db, companyId, child, 500);
      await insertStepAssignment(
        db,
        companyId,
        projectId,
        rootRunId,
        rootRunId,
        child,
        'child-a',
        'routed',
      );
      // Expire the lease.
      await db.drizzle.execute(sql`
        UPDATE "mission_runs" SET "lease_expires_at" = ${pastExpiry} WHERE "id" = ${child}
      `);
      const staleToken = (
        (await db.drizzle.execute(
          sql`SELECT "lease_token" FROM "mission_runs" WHERE "id" = ${child}`,
        )) as unknown as Array<{ lease_token: string }>
      )[0]!.lease_token;

      const coordinator = new RunCoordinator(db, { clock: () => new Date() });
      const claim = await coordinator.claimNext('worker-B');
      expect(claim).not.toBeNull();
      expect(claim!.runId).toBe(child);
      expect(claim!.isRecovery).toBe(true);
      // New fenced lease token differs from the stale one.
      expect(claim!.leaseToken).not.toBe(staleToken);

      const row = await getRunRow(db, child);
      expect(row!.lease_owner).toBe('worker-B');
      expect(row!.lease_token).toBe(claim!.leaseToken);

      // run.recovered event emitted; no duplicate child created.
      const events = await getEvents(db, child);
      expect(events.find((e) => e.type === 'run.recovered')).toBeDefined();
      const children = (await db.drizzle.execute(sql`
        SELECT count(*)::int AS cnt FROM "mission_runs" WHERE "parent_run_id" = ${rootRunId}
      `)) as unknown as Array<{ cnt: number }>;
      expect(Number(children[0]!.cnt)).toBe(1);
    });
  });

  // -- VAL-SUB-057: Stale workers cannot commit ---------------------------

  describe('VAL-SUB-057: Stale workers cannot commit', () => {
    it('a stale worker cannot complete a child after another worker recovers it', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ stale057');
      const policy = await insertPolicySnapshot(db, companyId);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy, {
        status: 'running',
      });
      await insertBudgetReservation(db, companyId, rootRunId, 5000);
      await setLease(db, rootRunId, 'root-worker', new Date(Date.now() + 30000));
      const child = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policy,
        { status: 'running', leaseOwner: 'worker-A' },
      );
      await insertBudgetReservation(db, companyId, child, 500);
      await insertStepAssignment(
        db,
        companyId,
        projectId,
        rootRunId,
        rootRunId,
        child,
        'child-a',
        'routed',
      );
      const staleToken = (
        (await db.drizzle.execute(
          sql`SELECT "lease_token" FROM "mission_runs" WHERE "id" = ${child}`,
        )) as unknown as Array<{ lease_token: string }>
      )[0]!.lease_token;

      // Expire worker-A's lease and let worker-B recover the child.
      await db.drizzle.execute(sql`
        UPDATE "mission_runs" SET "lease_expires_at" = ${new Date(Date.now() - 60_000)} WHERE "id" = ${child}
      `);
      const coordinator = new RunCoordinator(db, { clock: () => new Date() });
      const claim = await coordinator.claimNext('worker-B');
      expect(claim!.runId).toBe(child);
      expect(claim!.leaseToken).not.toBe(staleToken);

      // Worker-A attempts to complete with its stale token — must be rejected.
      const completionService = new MissionCompletionService(db);
      await expect(
        db.drizzle.transaction(async (tx) => {
          await completionService.completeRun(tx, companyId, projectId, child, {
            leaseToken: staleToken,
          });
        }),
      ).rejects.toThrow();

      // No completion event or terminal state from the stale worker.
      const row = await getRunRow(db, child);
      expect(row!.status).toBe('running');
      expect(row!.terminal_at).toBeNull();
      const events = await getEvents(db, child);
      expect(events.find((e) => e.type === 'run.completed')).toBeUndefined();
    });
  });

  // -- VAL-SUB-059: Non-replayable effects are not repeated ----------------

  describe('VAL-SUB-059: Non-replayable effects are not repeated', () => {
    it('a child non-replayable invocation in started state causes terminal unknown_effect on recovery', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ nonrep059');
      const policy = await insertPolicySnapshot(db, companyId);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy, {
        status: 'running',
      });
      await insertBudgetReservation(db, companyId, rootRunId, 5000);
      await setLease(db, rootRunId, 'root-worker', new Date(Date.now() + 30000));
      const child = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policy,
        { status: 'running', leaseOwner: 'worker-A' },
      );
      await insertBudgetReservation(db, companyId, child, 500);
      await insertStepAssignment(
        db,
        companyId,
        projectId,
        rootRunId,
        rootRunId,
        child,
        'child-a',
        'routed',
      );
      // A non-replayable tool invocation left in `started`.
      await insertToolInvocation(db, companyId, projectId, child, {
        replayClass: 'non_replayable',
        state: 'started',
      });

      // Expire worker-A's lease and let worker-B recover the child.
      await db.drizzle.execute(sql`
        UPDATE "mission_runs" SET "lease_expires_at" = ${new Date(Date.now() - 60_000)} WHERE "id" = ${child}
      `);
      const coordinator = new RunCoordinator(db, { clock: () => new Date() });
      const claim = await coordinator.claimNext('worker-B');
      expect(claim!.isRecovery).toBe(true);

      const recoveryService = new MissionRecoveryService(db, { clock: () => new Date() });
      const result = await recoveryService.checkNonReplayableEffects({
        companyId,
        projectId,
        runId: child,
        leaseToken: claim!.leaseToken,
      });
      expect(result.terminalized).toBe(true);
      expect(result.failureCategory).toBe('unknown_effect');

      const row = await getRunRow(db, child);
      expect(row!.status).toBe('failed');
      expect(row!.failure_category).toBe('unknown_effect');

      // The invocation was never repeated — count stays 1.
      expect(await getToolInvocationCount(db, child)).toBe(1);
    });

    it('a read-only invocation in started state does NOT cause failure on recovery', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ readonly059');
      const policy = await insertPolicySnapshot(db, companyId);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy, {
        status: 'running',
      });
      await insertBudgetReservation(db, companyId, rootRunId, 5000);
      await setLease(db, rootRunId, 'root-worker', new Date(Date.now() + 30000));
      const child = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policy,
        { status: 'running', leaseOwner: 'worker-A' },
      );
      await insertBudgetReservation(db, companyId, child, 500);
      await insertStepAssignment(
        db,
        companyId,
        projectId,
        rootRunId,
        rootRunId,
        child,
        'child-a',
        'routed',
      );
      await insertToolInvocation(db, companyId, projectId, child, {
        replayClass: 'read_only',
        state: 'started',
      });

      await db.drizzle.execute(sql`
        UPDATE "mission_runs" SET "lease_expires_at" = ${new Date(Date.now() - 60_000)} WHERE "id" = ${child}
      `);
      const coordinator = new RunCoordinator(db, { clock: () => new Date() });
      const claim = await coordinator.claimNext('worker-B');

      const recoveryService = new MissionRecoveryService(db, { clock: () => new Date() });
      const result = await recoveryService.checkNonReplayableEffects({
        companyId,
        projectId,
        runId: child,
        leaseToken: claim!.leaseToken,
      });
      expect(result.terminalized).toBe(false);
      const row = await getRunRow(db, child);
      expect(row!.status).toBe('running');
    });

    it('a stale worker cannot run the recovery check with the old lease token', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ stale059');
      const policy = await insertPolicySnapshot(db, companyId);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy, {
        status: 'running',
      });
      await insertBudgetReservation(db, companyId, rootRunId, 5000);
      await setLease(db, rootRunId, 'root-worker', new Date(Date.now() + 30000));
      const child = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policy,
        { status: 'running', leaseOwner: 'worker-A' },
      );
      await insertBudgetReservation(db, companyId, child, 500);
      await insertStepAssignment(
        db,
        companyId,
        projectId,
        rootRunId,
        rootRunId,
        child,
        'child-a',
        'routed',
      );
      await insertToolInvocation(db, companyId, projectId, child, {
        replayClass: 'non_replayable',
        state: 'started',
      });
      const staleToken = (
        (await db.drizzle.execute(
          sql`SELECT "lease_token" FROM "mission_runs" WHERE "id" = ${child}`,
        )) as unknown as Array<{ lease_token: string }>
      )[0]!.lease_token;

      await db.drizzle.execute(sql`
        UPDATE "mission_runs" SET "lease_expires_at" = ${new Date(Date.now() - 60_000)} WHERE "id" = ${child}
      `);
      const coordinator = new RunCoordinator(db, { clock: () => new Date() });
      const claim = await coordinator.claimNext('worker-B');
      expect(claim!.leaseToken).not.toBe(staleToken);

      const recoveryService = new MissionRecoveryService(db, { clock: () => new Date() });
      await expect(
        recoveryService.checkNonReplayableEffects({
          companyId,
          projectId,
          runId: child,
          leaseToken: staleToken,
        }),
      ).rejects.toThrow();
    });
  });
});
