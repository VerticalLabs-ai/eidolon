import { describe, expect, it, afterEach, beforeEach, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { MissionCompletionService } from '../services/mission/completion.js';
import { DescendantMirrorService } from '../services/mission/descendant-mirror.js';

/**
 * Root mirror completion before terminal close (VAL-SUB-112).
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

async function insertPolicySnapshot(db: AnyDb, companyId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "provider", "model", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${id}, ${companyId}, 1, 'anthropic', 'claude-sonnet-4-6', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'require_all', '{"costCents": 5000, "durationSeconds": 3600, "providerCalls": 64, "totalTokens": 500000, "outputBytes": 10485760, "steps": 12, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
  `);
  return id;
}

async function insertRootRun(
  db: AnyDb,
  companyId: string,
  projectId: string,
  threadId: string,
  policySnapshotId: string,
  status = 'running',
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 0, 'require_all', ${isTerminal ? now : null}, ${now}, ${now})
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
  policySnapshotId: string,
  opts: { status?: string; leaseOwner?: string } = {},
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const status = opts.status ?? 'running';
  const leaseToken = opts.leaseOwner ? randomUUID() : null;
  const leaseExpires = opts.leaseOwner ? new Date(now.getTime() + 30000) : null;
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "lease_owner", "lease_token", "lease_expires_at", "heartbeat_at", "available_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, ${parentRunId}, ${depth}, ${childOrdinal}, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 0, 'require_all', null, ${opts.leaseOwner ?? null}, ${leaseToken}, ${leaseExpires}, ${opts.leaseOwner ? now : null}, null, ${now}, ${now})
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
        "lease_expires_at" = ${expiresAt}, "heartbeat_at" = ${now}, "updated_at" = ${now}
    WHERE "id" = ${runId}
  `);
  return token;
}

async function getRunRow(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "terminal_at", "lease_token"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

async function getMirrors(db: AnyDb, rootRunId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "descendant_run_id", "source_sequence", "source_event_type", "root_event_sequence"
    FROM "run_descendant_mirrors" WHERE "root_run_id" = ${rootRunId}
    ORDER BY "root_event_sequence" ASC
  `)) as unknown as Array<{
    descendant_run_id: string;
    source_sequence: string | number;
    source_event_type: string;
    root_event_sequence: string | number;
  }>;
  return rows.map((r) => ({
    descendant_run_id: r.descendant_run_id,
    source_event_type: r.source_event_type,
    source_sequence: Number(r.source_sequence),
    root_event_sequence: Number(r.root_event_sequence),
  }));
}

describe('m4-f06-recovery-deadlines (mirror completion)', () => {
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

  // -- VAL-SUB-112: Root mirror is complete before terminal close ---------

  it('mirrors only local descendant source events with unique (root,descendant,source) rows', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ mirror112-unique');
    const policy = await insertPolicySnapshot(db, companyId);
    const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy);
    await insertBudgetReservation(db, companyId, rootRunId, 5000);
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
      {
        status: 'running',
        leaseOwner: 'w-x',
      },
    );
    await insertBudgetReservation(db, companyId, child, 500);

    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "occurred_at")
      VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${child}, 1, 'child.started', 1, '{}'::jsonb, ${now})
    `);
    await db.drizzle
      .update(db.schema.missionRuns)
      .set({ lastEventSequence: 1 })
      .where(eq(db.schema.missionRuns.id, child));

    const mirrorSvc = new DescendantMirrorService(db, { clock: () => now });
    await db.drizzle.transaction(async (tx) => {
      await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, rootRunId))
        .for('update')
        .limit(1);
      await mirrorSvc.mirrorDescendantEvent(tx, {
        companyId,
        projectId,
        rootRunId,
        descendantRunId: child,
        sourceSequence: 1,
        sourceEventType: 'child.started',
        sourcePayload: {},
      });
    });

    const mirrors = await getMirrors(db, rootRunId);
    expect(mirrors.length).toBe(1);
    expect(mirrors[0]!.source_sequence).toBe(1);
    expect(mirrors[0]!.descendant_run_id).toBe(child);

    await db.drizzle.transaction(async (tx) => {
      await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, rootRunId))
        .for('update')
        .limit(1);
      const r = await mirrorSvc.mirrorDescendantEvent(tx, {
        companyId,
        projectId,
        rootRunId,
        descendantRunId: child,
        sourceSequence: 1,
        sourceEventType: 'child.started',
        sourcePayload: {},
      });
      expect(r.created).toBe(false);
    });
    expect((await getMirrors(db, rootRunId)).length).toBe(1);
  });

  it('does not mirror a descendant.progressed source event (no cycles)', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ mirror112-cycle');
    const policy = await insertPolicySnapshot(db, companyId);
    const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy);
    await insertBudgetReservation(db, companyId, rootRunId, 5000);
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
      {
        status: 'running',
        leaseOwner: 'w-x',
      },
    );
    await insertBudgetReservation(db, companyId, child, 500);

    const now = new Date();
    const mirrorSvc = new DescendantMirrorService(db, { clock: () => now });
    let created = true;
    await db.drizzle.transaction(async (tx) => {
      await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, rootRunId))
        .for('update')
        .limit(1);
      const r = await mirrorSvc.mirrorDescendantEvent(tx, {
        companyId,
        projectId,
        rootRunId,
        descendantRunId: child,
        sourceSequence: 1,
        sourceEventType: 'descendant.progressed',
        sourcePayload: {},
      });
      created = r.created;
    });
    expect(created).toBe(false);
    expect((await getMirrors(db, rootRunId)).length).toBe(0);
  });

  it('fills delayed terminal mirror gaps before root terminal close (no post-terminal mirror)', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ mirror112-fill');
    const policy = await insertPolicySnapshot(db, companyId);
    const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy);
    await insertBudgetReservation(db, companyId, rootRunId, 5000);
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
      {
        status: 'running',
        leaseOwner: 'w-x',
      },
    );
    await insertBudgetReservation(db, companyId, child, 500);

    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "occurred_at")
      VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${child}, 1, 'child.started', 1, '{}'::jsonb, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "occurred_at")
      VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${child}, 2, 'run.cancelled', 1, '{}'::jsonb, ${now})
    `);
    await db.drizzle
      .update(db.schema.missionRuns)
      .set({ lastEventSequence: 2, status: 'cancelled', terminalAt: now })
      .where(eq(db.schema.missionRuns.id, child));

    const mirrorSvc = new DescendantMirrorService(db, { clock: () => now });
    await db.drizzle.transaction(async (tx) => {
      await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, rootRunId))
        .for('update')
        .limit(1);
      await mirrorSvc.mirrorDescendantEvent(tx, {
        companyId,
        projectId,
        rootRunId,
        descendantRunId: child,
        sourceSequence: 1,
        sourceEventType: 'child.started',
        sourcePayload: {},
      });
    });

    const verifyBefore = await mirrorSvc.verifyWatermarks(companyId, rootRunId);
    expect(verifyBefore.get(child)?.complete).toBe(false);

    const fillResult = await db.drizzle.transaction(async (tx) => {
      await tx
        .select()
        .from(db.schema.missionRuns)
        .where(eq(db.schema.missionRuns.id, rootRunId))
        .for('update')
        .limit(1);
      return mirrorSvc.ensureMirrorsCompleteBeforeTerminal(tx, {
        companyId,
        projectId,
        rootRunId,
        actorType: 'system',
        actorId: null,
        traceId: null,
      });
    });
    expect(fillResult.complete).toBe(true);
    expect(fillResult.filled).toBeGreaterThan(0);

    const verifyAfter = await mirrorSvc.verifyWatermarks(companyId, rootRunId);
    expect(verifyAfter.get(child)?.complete).toBe(true);

    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'completed', "terminal_at" = ${now}, "lease_owner" = NULL, "lease_token" = NULL, "lease_expires_at" = NULL WHERE "id" = ${rootRunId}
    `);
    const mirrorsBeforeClose = (await getMirrors(db, rootRunId)).length;
    await db.drizzle.transaction(async (tx) => {
      const r = await mirrorSvc.mirrorDescendantEvent(tx, {
        companyId,
        projectId,
        rootRunId,
        descendantRunId: child,
        sourceSequence: 3,
        sourceEventType: 'run.completed',
        sourcePayload: {},
      });
      expect(r.created).toBe(false);
      expect(r.skipReason).toBe('root_terminal');
    });
    expect((await getMirrors(db, rootRunId)).length).toBe(mirrorsBeforeClose);
  });

  it('root completion fills final mirrors before close and refuses while descendants are nonterminal', async () => {
    const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ mirror112-close');
    const policy = await insertPolicySnapshot(db, companyId);
    const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policy);
    await insertBudgetReservation(db, companyId, rootRunId, 5000);
    const rootLeaseToken = await setLease(
      db,
      rootRunId,
      'root-worker',
      new Date(Date.now() + 30000),
    );

    const nonterminalChild = await insertChildRun(
      db,
      companyId,
      projectId,
      threadId,
      rootRunId,
      rootRunId,
      1,
      0,
      policy,
      {
        status: 'running',
        leaseOwner: 'w-x',
      },
    );
    await insertBudgetReservation(db, companyId, nonterminalChild, 500);

    const completionService = new MissionCompletionService(db, { clock: () => new Date() });
    await expect(
      db.drizzle.transaction(async (tx) => {
        await completionService.completeRun(tx, companyId, projectId, rootRunId, {
          leaseToken: rootLeaseToken,
        });
      }),
    ).rejects.toThrow();

    expect((await getRunRow(db, rootRunId))!.status).toBe('running');

    const now = new Date();
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'cancelled', "terminal_at" = ${now}, "lease_owner" = NULL, "lease_token" = NULL, "lease_expires_at" = NULL, "last_event_sequence" = 1
      WHERE "id" = ${nonterminalChild}
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "run_events" ("id", "company_id", "project_id", "run_id", "sequence", "type", "schema_version", "payload", "occurred_at")
      VALUES (${randomUUID()}, ${companyId}, ${projectId}, ${nonterminalChild}, 1, 'run.cancelled', 1, '{}'::jsonb, ${now})
    `);

    expect((await getMirrors(db, rootRunId)).length).toBe(0);

    await db.drizzle.transaction(async (tx) => {
      await completionService.completeRun(tx, companyId, projectId, rootRunId, {
        leaseToken: rootLeaseToken,
      });
    });

    const rootRowAfter = await getRunRow(db, rootRunId);
    expect(rootRowAfter!.status).toBe('completed');
    expect(rootRowAfter!.terminal_at).not.toBeNull();

    const mirrorsAfter = await getMirrors(db, rootRunId);
    expect(mirrorsAfter.length).toBe(1);
    expect(mirrorsAfter[0]!.descendant_run_id).toBe(nonterminalChild);
    expect(mirrorsAfter[0]!.source_event_type).toBe('run.cancelled');

    const mirrorSvc = new DescendantMirrorService(db, { clock: () => new Date() });
    await db.drizzle.transaction(async (tx) => {
      const r = await mirrorSvc.mirrorDescendantEvent(tx, {
        companyId,
        projectId,
        rootRunId,
        descendantRunId: nonterminalChild,
        sourceSequence: 2,
        sourceEventType: 'run.completed',
        sourcePayload: {},
      });
      expect(r.created).toBe(false);
      expect(r.skipReason).toBe('root_terminal');
    });
    expect((await getMirrors(db, rootRunId)).length).toBe(1);
  });
});
