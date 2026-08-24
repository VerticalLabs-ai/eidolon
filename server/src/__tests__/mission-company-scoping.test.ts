import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestServers, closeTestDb } from '../test-utils.js';
import { SchedulingService } from '../services/mission/scheduling.js';

/**
 * Defense-in-depth company scoping on internal scheduling helper queries
 * (fix-misc-company-scoping).
 *
 * These tests verify:
 * - acquireRunningPermits idempotent re-acquire short-circuits BEFORE the
 *   limit checks, so a child that already holds permits reacquires them
 *   instead of throwing LIMIT_EXCEEDED when it is itself the permit holder
 *   at the cap.
 * - countHeldPermits, releasePermits, and getPermitsForRun are
 *   companyId-scoped: permits belonging to another company are never
 *   counted, released, or returned.
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

async function createRootRun(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
): Promise<string> {
  const rootRunId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
    VALUES (${rootRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, NULL, 0, 'company_agent', 'enc', 'h', 'Root', 'deep_work', 'running', 1, 0, 'require_all', ${now}, ${now})
  `);
  return rootRunId;
}

async function createChildRun(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  rootRunId: string,
  parentRunId: string,
  ordinal: number,
): Promise<string> {
  const childRunId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "created_at", "updated_at")
    VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${rootRunId}, ${parentRunId}, 1, ${ordinal}, 'company_agent', 'enc', 'h', 'Child', 'deep_work', 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
  `);
  return childRunId;
}

/**
 * Insert a permit row directly (bypassing acquireRunningPermits) so we can
 * place a permit under a different companyId than the one under test, to
 * verify scoping.
 */
async function insertPermit(
  db: AnyDb,
  input: {
    companyId: string;
    projectId: string;
    rootRunId: string;
    parentRunId: string;
    runId: string;
    permitKind: 'root_running' | 'parent_running';
    status?: 'held' | 'released';
  },
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_scheduling_permits" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "permit_kind", "status", "acquired_at", "released_at", "created_at", "updated_at")
    VALUES (${id}, ${input.companyId}, ${input.projectId}, ${input.rootRunId}, ${input.parentRunId}, ${input.runId}, ${input.permitKind}, ${input.status ?? 'held'}, ${now}, NULL, ${now}, ${now})
  `);
  return id;
}

describe('Company scoping on scheduling helpers (fix-misc-company-scoping)', () => {
  let db: AnyDb;
  let scope: { companyId: string; projectId: string; threadId: string };
  let scheduling: SchedulingService;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
    scope = await seedScope(db, '__mtest__ company-scoping');
    scheduling = new SchedulingService(db, { clock: () => new Date() });
  });

  afterEach(async () => {
    await closeTestServers();
    await closeTestDb();
  });

  it('idempotent re-acquire short-circuits before limit checks at the cap', async () => {
    // rootFanOut = 1: only one running child permitted. The single child
    // already holds the permit. Re-acquiring for the SAME child must return
    // the existing permit IDs instead of throwing LIMIT_EXCEEDED.
    const rootRunId = await createRootRun(db, scope);
    const childRunId = await createChildRun(db, scope, rootRunId, rootRunId, 0);

    // First acquire — succeeds, now at the cap.
    const first = await db.drizzle.transaction(async (tx) => {
      return scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childRunId,
        rootFanOut: 1,
        parentFanOut: 1,
      });
    });
    expect(first.rootPermitId).toBeTruthy();
    expect(first.parentPermitId).toBeTruthy();

    // Second acquire for the same child at the cap must short-circuit
    // (return the same IDs) instead of throwing LIMIT_EXCEEDED.
    const second = await db.drizzle.transaction(async (tx) => {
      return scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childRunId,
        rootFanOut: 1,
        parentFanOut: 1,
      });
    });

    expect(second.rootPermitId).toBe(first.rootPermitId);
    expect(second.parentPermitId).toBe(first.parentPermitId);

    // No duplicate permit rows.
    const permits = await scheduling.getPermitsForRun(childRunId, scope.companyId);
    expect(permits.length).toBe(2);
  });

  it('countHeldPermits is companyId-scoped', async () => {
    const rootRunId = await createRootRun(db, scope);
    const childA = await createChildRun(db, scope, rootRunId, rootRunId, 0);

    // Acquire a permit for company A's child.
    await db.drizzle.transaction(async (tx) => {
      await scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childA,
        rootFanOut: 4,
        parentFanOut: 4,
      });
    });

    // Insert a foreign permit under the SAME rootRunId but a different
    // companyId (a theoretical cross-company row). countHeldPermits with
    // company A's companyId must NOT count the foreign row.
    const scopeB = await seedScope(db, '__mtest__ company-scoping-b');
    const foreignChild = await createChildRun(db, scopeB, rootRunId, rootRunId, 1);
    await insertPermit(db, {
      companyId: scopeB.companyId,
      projectId: scopeB.projectId,
      rootRunId,
      parentRunId: rootRunId,
      runId: foreignChild,
      permitKind: 'root_running',
      status: 'held',
    });

    // Company A count must be 1 (its own permit), not 2 (which would
    // include the foreign row).
    const heldA = await scheduling.countHeldPermits(
      db.drizzle,
      rootRunId,
      'root_running',
      scope.companyId,
    );
    expect(heldA).toBe(1);

    // Company B count sees only its own foreign permit.
    const heldB = await scheduling.countHeldPermits(
      db.drizzle,
      rootRunId,
      'root_running',
      scopeB.companyId,
    );
    expect(heldB).toBe(1);
  });

  it('releasePermits is companyId-scoped — cannot release another company’s permits', async () => {
    const rootRunIdA = await createRootRun(db, scope);
    const childA = await createChildRun(db, scope, rootRunIdA, rootRunIdA, 0);

    // Acquire a permit for company A's child.
    await db.drizzle.transaction(async (tx) => {
      await scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId: rootRunIdA,
        parentRunId: rootRunIdA,
        runId: childA,
        rootFanOut: 4,
        parentFanOut: 4,
      });
    });

    // A second company attempts to release company A's child permits using
    // company B's companyId. The release must match zero rows (scoped).
    const scopeB = await seedScope(db, '__mtest__ company-scoping-release');
    const released = await db.drizzle.transaction(async (tx) => {
      return scheduling.releasePermits(tx, childA, scopeB.companyId);
    });
    expect(released.released).toBe(0);

    // Company A's permits are still held.
    const permits = await scheduling.getPermitsForRun(childA, scope.companyId);
    expect(permits.every((p) => p.status === 'held')).toBe(true);
  });

  it('getPermitsForRun is companyId-scoped', async () => {
    const rootRunId = await createRootRun(db, scope);
    const childRunId = await createChildRun(db, scope, rootRunId, rootRunId, 0);

    await db.drizzle.transaction(async (tx) => {
      await scheduling.acquireRunningPermits(tx, {
        companyId: scope.companyId,
        projectId: scope.projectId,
        rootRunId,
        parentRunId: rootRunId,
        runId: childRunId,
        rootFanOut: 4,
        parentFanOut: 4,
      });
    });

    // Querying with the wrong companyId returns no permits.
    const scopeB = await seedScope(db, '__mtest__ company-scoping-get');
    const wrongPermits = await scheduling.getPermitsForRun(childRunId, scopeB.companyId);
    expect(wrongPermits.length).toBe(0);

    // Querying with the correct companyId returns the 2 permits.
    const correctPermits = await scheduling.getPermitsForRun(childRunId, scope.companyId);
    expect(correctPermits.length).toBe(2);
  });
});
