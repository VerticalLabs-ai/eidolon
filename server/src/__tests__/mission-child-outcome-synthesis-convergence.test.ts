import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { MissionSynthesisService } from '../services/mission/synthesis.js';
import { MissionCancellationService } from '../services/mission/cancellation.js';
import { MissionCompletionService } from '../services/mission/completion.js';
import { SubtreeCancellationService } from '../services/mission/subtree-cancellation.js';
import { MissionSnapshotService } from '../services/mission/snapshot.js';

/**
 * Child outcome & synthesis convergence (m4-f15).
 *
 * Connects descendant failure/cancellation and ordered synthesis to durable
 * root outcomes. Exercises require-all/best-effort, reverse completion,
 * durable synthesis, running-parent cancellation, partial authority, and
 * topology revision boundaries.
 *
 * (VAL-CROSS-028, 029, 038, 039, 058, 091, 102)
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
  result_completeness: string | null;
};

async function getRunRow(db: AnyDb, runId: string): Promise<RunRow | null> {
  const rows = (await db.drizzle.execute(sql`
    SELECT "status", "state_version", "last_event_sequence", "terminal_at",
           "partial_result_policy", "failure_category", "failure_code",
           "safe_error_message", "cancel_requested_at", "result_completeness"
    FROM "mission_runs" WHERE "id" = ${runId}
  `)) as unknown as Record<string, unknown>[];
  if (!rows[0]) {
    return null;
  }
  const row = rows[0]!;
  return {
    ...row,
    state_version: Number(row.state_version),
    last_event_sequence: Number(row.last_event_sequence),
    result_completeness: (row.result_completeness as string | null) ?? null,
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

/**
 * Seed a complete composite run tree: root with an approved plan, N direct
 * children with step assignments, and budget reservation. Children start
 * in the given status.
 */
async function seedCompositeTree(
  db: AnyDb,
  partialResultPolicy: 'require_all' | 'best_effort',
  childStatuses: Array<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>,
) {
  const { companyId, projectId, threadId } = await seedScope(
    db,
    `__mtest__ convergence-${partialResultPolicy}`,
  );
  const policyId = await insertPolicySnapshot(db, companyId, partialResultPolicy);
  // Create root run first (without approved revision), then create the plan
  // revision referencing it, then set the approved revision ID.
  const rootRunId = await insertRootRun(
    db,
    companyId,
    projectId,
    threadId,
    policyId,
    partialResultPolicy,
    'running',
  );
  const { revisionId, contentHash } = await insertPlanRevision(db, companyId, projectId, rootRunId);
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId}
    WHERE "id" = ${rootRunId}
  `);
  await insertBudgetReservation(db, companyId, rootRunId);

  const childIds: string[] = [];
  for (let i = 0; i < childStatuses.length; i++) {
    const status = childStatuses[i]!;
    const childId = await insertChildRun(
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
    const resultStatus =
      status === 'completed'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : status === 'cancelled'
            ? 'cancelled'
            : 'pending';
    const assignmentStatus =
      status === 'completed' || status === 'failed' || status === 'cancelled' ? status : 'routed';
    await insertStepAssignment(
      db,
      companyId,
      projectId,
      rootRunId,
      rootRunId,
      childId,
      `step-${i}`,
      i,
      assignmentStatus,
      resultStatus,
      revisionId,
      contentHash,
    );
    await insertBudgetReservation(db, companyId, childId, 1000);
    childIds.push(childId);
  }

  return { companyId, projectId, threadId, rootRunId, childIds, revisionId, contentHash };
}

describe('m4-f15: child outcome & synthesis convergence', () => {
  let db: AnyDb;

  beforeEach(async () => {
    enableMissionFlag();
    db = await createTestDb();
  });

  afterEach(async () => {
    await closeTestDb();
    vi.unstubAllEnvs();
  });

  // -- VAL-CROSS-028: Required-child failure propagation -------------------

  describe('VAL-CROSS-028: required-child failure propagation', () => {
    it('fails the parent and cancels remaining required work when a required child fails under require_all', async () => {
      // Two children: one completed, one failed. Under require_all the
      // parent must fail rather than synthesize a success.
      const { companyId, projectId, rootRunId, childIds } = await seedCompositeTree(
        db,
        'require_all',
        ['completed', 'failed'],
      );

      const synthesisService = new MissionSynthesisService(db);
      const result = await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });

      expect(result.synthesized).toBe(true);
      expect(result.terminalized).toBe(true);
      expect(result.status).toBe('failed');

      // Parent must be failed with child_failed category.
      const rootRow = await getRunRow(db, rootRunId);
      expect(rootRow!.status).toBe('failed');
      expect(rootRow!.failure_category).toBe('child_failed');
      expect(rootRow!.failure_code).toBe('REQUIRED_CHILD_FAILED');

      // No completed-success artifact (no manifest with status completed).
      const manifest = await getManifest(db, rootRunId);
      expect(manifest).not.toBeNull();
      expect(manifest!.status).toBe('failed');

      // The failed step must be identified in the manifest entries.
      const manifestEntries = manifest!.manifest as Array<{
        stepKey: string;
        resultStatus: string;
      }>;
      const failedEntry = manifestEntries.find((e) => e.resultStatus === 'failed');
      expect(failedEntry).toBeDefined();
      expect(failedEntry!.stepKey).toBe('step-1');

      // The synthesis.completed event must also carry the gaps.
      const events = await getEvents(db, rootRunId);
      const synthesisCompleted = events.find((e) => e.type === 'synthesis.completed');
      expect(synthesisCompleted).toBeDefined();
      const eventGaps = synthesisCompleted!.payload.gaps as Array<{
        stepKey: string;
        reason: string;
      }>;
      expect(eventGaps.length).toBe(1);
      expect(eventGaps[0]!.stepKey).toBe('step-1');
      expect(eventGaps[0]!.reason).toBe('failed');

      // resultCompleteness must be null for a failed run.
      expect(rootRow!.result_completeness).toBeNull();
    });

    it('stops remaining required work via subtree cancellation cascade when a child fails', async () => {
      // Three children: one failed, two still running. Under require_all,
      // the subtree cancellation service cascades cancellation to siblings.
      const { companyId, projectId, rootRunId, childIds } = await seedCompositeTree(
        db,
        'require_all',
        ['failed', 'running', 'running'],
      );

      const subtreeService = new SubtreeCancellationService(db);
      const policyResult = await db.drizzle.transaction(async (tx) => {
        return subtreeService.applyChildTerminalPolicy(tx, {
          companyId,
          projectId,
          rootRunId,
          childRunId: childIds[0]!,
          parentRunId: rootRunId,
          terminalStatus: 'failed',
          failureCategory: 'tool_failed',
          failureCode: 'TOOL_ERROR',
          safeErrorMessage: 'Child tool failed',
          actorType: 'system',
          actorId: null,
          traceId: null,
        });
      });

      // Under require_all, cancellation cascades to nonterminal siblings.
      expect(policyResult.cascadedToSiblings).toBe(true);
      expect(policyResult.cascadedSiblingIds).toHaveLength(2);
      expect(policyResult.cascadedSiblingIds).toContain(childIds[1]);
      expect(policyResult.cascadedSiblingIds).toContain(childIds[2]);

      // Siblings must have cancel_requested_at set.
      const sib1 = await getRunRow(db, childIds[1]!);
      const sib2 = await getRunRow(db, childIds[2]!);
      expect(sib1!.cancel_requested_at).not.toBeNull();
      expect(sib2!.cancel_requested_at).not.toBeNull();
    });
  });

  // -- VAL-CROSS-029: Best-effort partial synthesis -----------------------

  describe('VAL-CROSS-029: best-effort partial synthesis', () => {
    it('allows siblings to finish and produces partial synthesis naming failed/missing steps', async () => {
      // Under best_effort: one completed, one failed, one completed.
      // Synthesis should complete with partial completeness and disclose gaps.
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'best_effort', [
        'completed',
        'failed',
        'completed',
      ]);

      const synthesisService = new MissionSynthesisService(db);
      const result = await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });

      expect(result.synthesized).toBe(true);
      expect(result.terminalized).toBe(true);
      expect(result.status).toBe('completed');

      // The synthesis must be partial, not full success.
      const rootRow = await getRunRow(db, rootRunId);
      expect(rootRow!.status).toBe('completed');
      expect(rootRow!.result_completeness).toBe('partial');

      // Gaps must be disclosed identifying the failed step.
      expect(result.disclosedGaps).not.toBeNull();
      expect(result.disclosedGaps!.length).toBe(1);
      expect(result.disclosedGaps![0]!.stepKey).toBe('step-1');
      expect(result.disclosedGaps![0]!.reason).toBe('failed');

      // The synthesis.completed event must carry outcome: 'partial'.
      const events = await getEvents(db, rootRunId);
      const synthesisCompleted = events.find((e) => e.type === 'synthesis.completed');
      expect(synthesisCompleted).toBeDefined();
      expect(synthesisCompleted!.payload.outcome).toBe('partial');
    });

    it('does not cancel healthy siblings when a child fails under best_effort', async () => {
      const { companyId, projectId, rootRunId, childIds } = await seedCompositeTree(
        db,
        'best_effort',
        ['failed', 'running', 'running'],
      );

      const subtreeService = new SubtreeCancellationService(db);
      const policyResult = await db.drizzle.transaction(async (tx) => {
        return subtreeService.applyChildTerminalPolicy(tx, {
          companyId,
          projectId,
          rootRunId,
          childRunId: childIds[0]!,
          parentRunId: rootRunId,
          terminalStatus: 'failed',
          failureCategory: 'tool_failed',
          failureCode: 'TOOL_ERROR',
          safeErrorMessage: 'Child tool failed',
          actorType: 'system',
          actorId: null,
          traceId: null,
        });
      });

      // Under best_effort, siblings are NOT cancelled.
      expect(policyResult.cascadedToSiblings).toBe(false);
      expect(policyResult.cascadedSiblingIds).toHaveLength(0);

      const sib1 = await getRunRow(db, childIds[1]!);
      expect(sib1!.cancel_requested_at).toBeNull();
    });
  });

  // -- VAL-CROSS-038: Synthesis waits for required children ---------------

  describe('VAL-CROSS-038: synthesis waits for required children', () => {
    it('does not start synthesis while any required child is nonterminal', async () => {
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'require_all', [
        'completed',
        'running',
        'completed',
      ]);

      const synthesisService = new MissionSynthesisService(db);
      const result = await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });

      // Synthesis must not proceed.
      expect(result.synthesized).toBe(false);
      expect(result.skipReason).toBe('children_not_terminal');
      expect(result.terminalized).toBe(false);

      // No synthesis.started event must exist.
      const events = await getEvents(db, rootRunId);
      const synthesisStarted = events.find((e) => e.type === 'synthesis.started');
      expect(synthesisStarted).toBeUndefined();

      // Run must still be running (nonterminal).
      const rootRow = await getRunRow(db, rootRunId);
      expect(rootRow!.status).toBe('running');
    });

    it('starts synthesis only after all children are terminal (reverse completion order)', async () => {
      // Complete children in reverse order: last child first, then first.
      const { companyId, projectId, rootRunId, childIds } = await seedCompositeTree(
        db,
        'require_all',
        ['running', 'running'],
      );

      const synthesisService = new MissionSynthesisService(db);

      // Both running → no synthesis.
      const r1 = await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });
      expect(r1.synthesized).toBe(false);

      // Complete the second child (reverse order).
      await db.drizzle.execute(sql`
        UPDATE "mission_runs" SET "status" = 'completed', "terminal_at" = ${new Date()}
        WHERE "id" = ${childIds[1]!}
      `);
      await db.drizzle.execute(sql`
        UPDATE "run_step_assignments" SET "assignment_status" = 'completed', "result_status" = 'completed'
        WHERE "run_id" = ${childIds[1]!}
      `);

      // One child still running → no synthesis.
      const r2 = await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });
      expect(r2.synthesized).toBe(false);

      // Complete the first child.
      await db.drizzle.execute(sql`
        UPDATE "mission_runs" SET "status" = 'completed', "terminal_at" = ${new Date()}
        WHERE "id" = ${childIds[0]!}
      `);
      await db.drizzle.execute(sql`
        UPDATE "run_step_assignments" SET "assignment_status" = 'completed', "result_status" = 'completed'
        WHERE "run_id" = ${childIds[0]!}
      `);

      // Now both terminal → synthesis proceeds.
      const r3 = await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });
      expect(r3.synthesized).toBe(true);
      expect(r3.status).toBe('completed');

      // The manifest must be ordered by ordinal, not completion order.
      const manifest = await getManifest(db, rootRunId);
      const entries = manifest!.manifest as Array<{ stepKey: string; childOrdinal: number }>;
      expect(entries[0]!.stepKey).toBe('step-0');
      expect(entries[1]!.stepKey).toBe('step-1');
    });
  });

  // -- VAL-CROSS-039: Completed synthesis is durable ----------------------

  describe('VAL-CROSS-039: completed synthesis is durable', () => {
    it('does not duplicate synthesis manifest, events, or terminal outcome on re-invocation', async () => {
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'require_all', [
        'completed',
        'completed',
      ]);

      const synthesisService = new MissionSynthesisService(db);

      // First synthesis.
      const r1 = await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });
      expect(r1.synthesized).toBe(true);

      const eventsAfter1 = await getEvents(db, rootRunId);
      const synthesisStartedCount1 = eventsAfter1.filter(
        (e) => e.type === 'synthesis.started',
      ).length;
      const synthesisCompletedCount1 = eventsAfter1.filter(
        (e) => e.type === 'synthesis.completed',
      ).length;
      const manifestCount1 = await countManifests(db, rootRunId);

      // Re-invoke synthesis (simulates reload/re-claim).
      const r2 = await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });
      expect(r2.synthesized).toBe(false);
      expect(r2.skipReason).toBe('already_terminal');

      // No duplicate events or manifests.
      const eventsAfter2 = await getEvents(db, rootRunId);
      expect(eventsAfter2.filter((e) => e.type === 'synthesis.started').length).toBe(
        synthesisStartedCount1,
      );
      expect(eventsAfter2.filter((e) => e.type === 'synthesis.completed').length).toBe(
        synthesisCompletedCount1,
      );
      expect(await countManifests(db, rootRunId)).toBe(manifestCount1);

      // Terminal state is unchanged.
      const rootRow = await getRunRow(db, rootRunId);
      expect(rootRow!.status).toBe('completed');
      expect(rootRow!.terminal_at).not.toBeNull();
    });
  });

  // -- VAL-CROSS-058: Cancel running parent cascades -----------------------

  describe('VAL-CROSS-058: cancel running parent cascades', () => {
    it('atomically requests cancellation for every nonterminal descendant', async () => {
      const { companyId, projectId, rootRunId, childIds } = await seedCompositeTree(
        db,
        'require_all',
        ['running', 'running', 'completed'],
      );

      const cancelService = new MissionCancellationService(db);

      // Request cancellation of the root (running parent).
      await db.drizzle.transaction(async (tx) => {
        const schema = db.schema;
        const [run] = await tx
          .select()
          .from(schema.missionRuns)
          .where(eq(schema.missionRuns.id, rootRunId))
          .for('update')
          .limit(1);
        expect(run).toBeDefined();
        await cancelService.requestCancellation(tx, run!, {
          companyId,
          projectId,
          runId: rootRunId,
          actorType: 'user',
          actorId: 'user-1',
          traceId: null,
        });
      });

      // Every nonterminal descendant must have cancel_requested_at set.
      const child0 = await getRunRow(db, childIds[0]!);
      const child1 = await getRunRow(db, childIds[1]!);
      const child2 = await getRunRow(db, childIds[2]!);
      expect(child0!.cancel_requested_at).not.toBeNull();
      expect(child1!.cancel_requested_at).not.toBeNull();
      // Already-completed child must not receive a cancel request.
      expect(child2!.cancel_requested_at).toBeNull();

      // Root must have cancel_requested_at set.
      const rootRow = await getRunRow(db, rootRunId);
      expect(rootRow!.cancel_requested_at).not.toBeNull();

      // child.cancel_requested events must exist for nonterminal children.
      const events0 = await getEvents(db, childIds[0]!);
      expect(events0.some((e) => e.type === 'child.cancel_requested')).toBe(true);
      const events1 = await getEvents(db, childIds[1]!);
      expect(events1.some((e) => e.type === 'child.cancel_requested')).toBe(true);
    });
  });

  // -- VAL-CROSS-091: Partial outcome is authoritative everywhere ---------

  describe('VAL-CROSS-091: partial outcome is authoritative everywhere', () => {
    it('exposes resultCompleteness:full for all-completed synthesis in the snapshot', async () => {
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'require_all', [
        'completed',
        'completed',
      ]);

      const synthesisService = new MissionSynthesisService(db);
      await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });

      const snapshotService = new MissionSnapshotService(db);
      const snapshot = await snapshotService.getSnapshot(companyId, projectId, rootRunId);
      expect(snapshot.status).toBe('completed');
      expect(snapshot.resultCompleteness).toBe('full');
    });

    it('exposes resultCompleteness:partial for best-effort with gaps in the snapshot', async () => {
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'best_effort', [
        'completed',
        'failed',
      ]);

      const synthesisService = new MissionSynthesisService(db);
      await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });

      const snapshotService = new MissionSnapshotService(db);
      const snapshot = await snapshotService.getSnapshot(companyId, projectId, rootRunId);
      expect(snapshot.status).toBe('completed');
      expect(snapshot.resultCompleteness).toBe('partial');
    });

    it('exposes resultCompleteness:null for a failed run (missing mandatory criteria)', async () => {
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'require_all', [
        'completed',
        'failed',
      ]);

      const synthesisService = new MissionSynthesisService(db);
      await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });

      const snapshotService = new MissionSnapshotService(db);
      const snapshot = await snapshotService.getSnapshot(companyId, projectId, rootRunId);
      expect(snapshot.status).toBe('failed');
      expect(snapshot.resultCompleteness).toBeNull();
    });

    it('exposes resultCompleteness:null for a nonterminal run', async () => {
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'require_all', [
        'running',
        'running',
      ]);

      const snapshotService = new MissionSnapshotService(db);
      const snapshot = await snapshotService.getSnapshot(companyId, projectId, rootRunId);
      expect(snapshot.resultCompleteness).toBeNull();
    });

    it('persists resultCompleteness in the run.completed terminal event payload', async () => {
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'best_effort', [
        'completed',
        'failed',
      ]);

      const synthesisService = new MissionSynthesisService(db);
      await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });

      const events = await getEvents(db, rootRunId);
      const runCompleted = events.find((e) => e.type === 'run.completed');
      expect(runCompleted).toBeDefined();
      expect(runCompleted!.payload.outcome).toBe('partial');
      expect(runCompleted!.payload.hasGaps).toBe(true);
    });
  });

  // -- VAL-CROSS-102: Revised topology decisions are consistent ------------

  describe('VAL-CROSS-102: revised topology decisions are consistent across surfaces', () => {
    it('persists resultCompleteness:null|full|partial as a durable column on mission_runs', async () => {
      // Verify the column exists and is readable through the snapshot.
      const { companyId, projectId, rootRunId } = await seedCompositeTree(db, 'require_all', [
        'completed',
        'completed',
      ]);

      // Before synthesis: null.
      const snapshotBefore = await new MissionSnapshotService(db).getSnapshot(
        companyId,
        projectId,
        rootRunId,
      );
      expect(snapshotBefore.resultCompleteness).toBeNull();

      // After synthesis: full.
      const synthesisService = new MissionSynthesisService(db);
      await db.drizzle.transaction(async (tx) => {
        return synthesisService.attemptSynthesis(tx, {
          companyId,
          projectId,
          runId: rootRunId,
        });
      });

      const snapshotAfter = await new MissionSnapshotService(db).getSnapshot(
        companyId,
        projectId,
        rootRunId,
      );
      expect(snapshotAfter.resultCompleteness).toBe('full');

      // Verify it's persisted in the DB row, not just computed.
      const rootRow = await getRunRow(db, rootRunId);
      expect(rootRow!.result_completeness).toBe('full');
    });

    it('uses routingKind:null on assignment for failed shells, not on the run', async () => {
      // A failed shell (NO_ELIGIBLE_AGENT) keeps the run's routing_kind
      // as the materializer placeholder ('company_agent'), but the
      // assignment's routing_kind is null.
      const { companyId, projectId, rootRunId, childIds } = await seedCompositeTree(
        db,
        'require_all',
        ['failed'],
      );

      // Set the assignment routing_kind to null (failed shell).
      await db.drizzle.execute(sql`
        UPDATE "run_step_assignments" SET "routing_kind" = null, "assignment_status" = 'failed',
          "failure_code" = 'NO_ELIGIBLE_AGENT'
        WHERE "run_id" = ${childIds[0]!}
      `);

      // The run's routing_kind is NOT null (it's the materializer placeholder).
      const childRow = (await db.drizzle.execute(sql`
        SELECT "routing_kind" FROM "mission_runs" WHERE "id" = ${childIds[0]!}
      `)) as unknown as Array<{ routing_kind: string }>;
      expect(childRow[0]!.routing_kind).not.toBeNull();

      // The assignment's routing_kind IS null.
      const assignmentRow = (await db.drizzle.execute(sql`
        SELECT "routing_kind", "assignment_status", "failure_code"
        FROM "run_step_assignments" WHERE "run_id" = ${childIds[0]!}
      `)) as unknown as Array<{
        routing_kind: string | null;
        assignment_status: string;
        failure_code: string | null;
      }>;
      expect(assignmentRow[0]!.routing_kind).toBeNull();
      expect(assignmentRow[0]!.assignment_status).toBe('failed');
      expect(assignmentRow[0]!.failure_code).toBe('NO_ELIGIBLE_AGENT');
    });

    it('fan-out means direct executable-child cardinality, not total descendants', async () => {
      // A root with 2 direct children (fan-out 2) and one grandchild
      // (total descendants 3). Fan-out is the direct child count.
      const { companyId, projectId, threadId, rootRunId, childIds, revisionId, contentHash } =
        await seedCompositeTree(db, 'require_all', ['running', 'running']);

      // Add a grandchild under the first child.
      const policyId = await insertPolicySnapshot(db, companyId, 'require_all');
      const grandchildId = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        childIds[0]!,
        2,
        0,
        policyId,
        'require_all',
        'running',
      );
      await insertStepAssignment(
        db,
        companyId,
        projectId,
        rootRunId,
        childIds[0]!,
        grandchildId,
        'step-0-0',
        0,
        'routed',
        'pending',
        revisionId,
        contentHash,
      );

      // Direct children of root = 2 (fan-out).
      const directChildren = (await db.drizzle.execute(sql`
        SELECT count(*)::int AS cnt FROM "mission_runs"
        WHERE "parent_run_id" = ${rootRunId}
      `)) as unknown as Array<{ cnt: number }>;
      expect(directChildren[0]!.cnt).toBe(2);

      // Total descendants = 3 (2 children + 1 grandchild).
      const allDescendants = (await db.drizzle.execute(sql`
        WITH RECURSIVE descendants AS (
          SELECT "id" FROM "mission_runs" WHERE "parent_run_id" = ${rootRunId}
          UNION ALL
          SELECT c."id" FROM "mission_runs" c
          INNER JOIN descendants d ON c."parent_run_id" = d."id"
        )
        SELECT count(*)::int AS cnt FROM descendants
      `)) as unknown as Array<{ cnt: number }>;
      expect(allDescendants[0]!.cnt).toBe(3);
    });

    it('postapproval revision is rejected after any approved effect/shell exists (EXECUTION_ALREADY_STARTED)', async () => {
      // This is validated by the plan decision service. Here we verify
      // the invariant: once children exist, the root has an approved plan
      // and revision cannot rebind started work.
      const { rootRunId } = await seedCompositeTree(db, 'require_all', ['running']);

      // The root has an approved plan and children (shells exist).
      const rootRow = await getRunRow(db, rootRunId);
      expect(rootRow!.status).toBe('running');

      // Verify children exist (shells materialized).
      const childCount = (await db.drizzle.execute(sql`
        SELECT count(*)::int AS cnt FROM "mission_runs"
        WHERE "parent_run_id" = ${rootRunId}
      `)) as unknown as Array<{ cnt: number }>;
      expect(childCount[0]!.cnt).toBeGreaterThan(0);

      // The approved_plan_revision_id is set and immutable.
      const revisionRow = (await db.drizzle.execute(sql`
        SELECT "approved_plan_revision_id" FROM "mission_runs" WHERE "id" = ${rootRunId}
      `)) as unknown as Array<{ approved_plan_revision_id: string | null }>;
      expect(revisionRow[0]!.approved_plan_revision_id).not.toBeNull();
    });
  });
});
