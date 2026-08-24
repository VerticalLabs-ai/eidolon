import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { TreeLimitsService, type TreePolicyLimits } from '../services/mission/tree-limits.js';
import { SchedulingService } from '../services/mission/scheduling.js';
import { PLATFORM_HARD_CAPS } from '../services/mission/modes.js';

/**
 * Tree-wide limit enforcement: depth, concurrency, descendants, calls,
 * tokens, and output counters.
 *
 * (VAL-SUB-029, 031, 032, 034, 035, 036, 037, 039, 099, 113)
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
  limits: Partial<TreePolicyLimits> & { durationSeconds?: number; steps?: number } = {},
): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  const fullLimits = {
    costCents: limits.costCents ?? 5000,
    durationSeconds: limits.durationSeconds ?? 3600,
    providerCalls: limits.providerCalls ?? 64,
    totalTokens: limits.totalTokens ?? 500000,
    outputBytes: limits.outputBytes ?? 10485760,
    steps: limits.steps ?? 12,
    depth: limits.depth ?? 2,
    fanOut: limits.fanOut ?? 4,
    descendants: limits.descendants ?? 16,
  };
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "provider", "model", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${id}, ${companyId}, 1, 'anthropic', 'claude-sonnet-4-6', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'require_all', ${JSON.stringify(fullLimits)}::jsonb, ${randomUUID()}, ${now})
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
    providerCallCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    outputBytes?: number;
    descendantCount?: number;
  } = {},
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const status = opts.status ?? 'running';
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "provider_call_count", "descendant_count", "input_tokens", "output_tokens", "output_bytes", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 0, 'require_all', ${isTerminal ? now : null}, ${opts.providerCallCount ?? 0}, ${opts.descendantCount ?? 0}, ${opts.inputTokens ?? 0}, ${opts.outputTokens ?? 0}, ${opts.outputBytes ?? 0}, ${now}, ${now})
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
    providerCallCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    outputBytes?: number;
  } = {},
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const status = opts.status ?? 'queued';
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "provider_call_count", "input_tokens", "output_tokens", "output_bytes", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, ${parentRunId}, ${depth}, ${childOrdinal}, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'deep_work', ${policySnapshotId}, ${status}, 1, 0, 'require_all', ${isTerminal ? now : null}, ${opts.providerCallCount ?? 0}, ${opts.inputTokens ?? 0}, ${opts.outputTokens ?? 0}, ${opts.outputBytes ?? 0}, ${now}, ${now})
  `);
  return runId;
}

async function getRootCounters(db: AnyDb, rootRunId: string) {
  const [row] = await db.drizzle
    .select({
      providerCallCount: db.schema.missionRuns.providerCallCount,
      descendantCount: db.schema.missionRuns.descendantCount,
      inputTokens: db.schema.missionRuns.inputTokens,
      outputTokens: db.schema.missionRuns.outputTokens,
      outputBytes: db.schema.missionRuns.outputBytes,
      stateVersion: db.schema.missionRuns.stateVersion,
      lastEventSequence: db.schema.missionRuns.lastEventSequence,
    })
    .from(db.schema.missionRuns)
    .where(eq(db.schema.missionRuns.id, rootRunId));
  return {
    provider_call_count: row?.providerCallCount ?? 0,
    descendant_count: row?.descendantCount ?? 0,
    input_tokens: row?.inputTokens ?? 0,
    output_tokens: row?.outputTokens ?? 0,
    output_bytes: row?.outputBytes ?? 0,
    state_version: row?.stateVersion ?? 0,
    last_event_sequence: Number(row?.lastEventSequence ?? 0),
  };
}

async function getRunEvents(db: AnyDb, rootRunId: string) {
  const rows = await db.drizzle
    .select({
      sequence: db.schema.runEvents.sequence,
      type: db.schema.runEvents.type,
      payload: db.schema.runEvents.payload,
    })
    .from(db.schema.runEvents)
    .where(eq(db.schema.runEvents.runId, rootRunId))
    .orderBy(db.schema.runEvents.sequence);
  return rows.map((r) => ({
    sequence: Number(r.sequence),
    type: r.type,
    payload: r.payload as Record<string, unknown>,
  }));
}

describe('Tree limits and counters (VAL-SUB-029,031,032,034,035,036,037,039,099,113)', () => {
  let db: AnyDb;
  let treeLimits: TreeLimitsService;
  let scheduling: SchedulingService;

  beforeEach(async () => {
    db = await createTestDb();
    treeLimits = new TreeLimitsService(db, { clock: () => new Date() });
    scheduling = new SchedulingService(db, { clock: () => new Date() });
    enableMissionFlag();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeTestDb();
  });

  // -- VAL-SUB-029: Depth limit is enforced ---------------------------------

  describe('VAL-SUB-029: depth limit enforcement', () => {
    it('admits children at the exact effective depth boundary', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ depth-ok');
      const policyId = await insertPolicySnapshot(db, companyId, { depth: 2 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      // Depth 1 and depth 2 children are within limit.
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.enforceTopologyLimits(tx, {
          rootRunId,
          companyId,
          projectId,
          childDepths: [1, 2],
          policyLimits: TreeLimitsService.toTreePolicyLimits({
            steps: 12,
            durationSeconds: 2700,
            providerCalls: 48,
            totalTokens: 300000,
            outputBytes: 8388608,
            costCents: 5000,
            depth: 2,
            fanOut: 4,
            descendants: 16,
          }),
        });
      });

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.descendant_count).toBe(2);
    });

    it('rejects child creation one level beyond the effective depth limit', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ depth-over');
      const policyId = await insertPolicySnapshot(db, companyId, { depth: 2 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.enforceTopologyLimits(tx, {
            rootRunId,
            companyId,
            projectId,
            childDepths: [1, 2, 3],
            policyLimits: TreeLimitsService.toTreePolicyLimits({
              steps: 12,
              durationSeconds: 2700,
              providerCalls: 48,
              totalTokens: 300000,
              outputBytes: 8388608,
              costCents: 5000,
              depth: 2,
              fanOut: 4,
              descendants: 16,
            }),
          });
        }),
      ).rejects.toThrow(/depth.*exceeds/i);

      // No descendants counted — the entire batch is rejected atomically.
      const counters = await getRootCounters(db, rootRunId);
      expect(counters.descendant_count).toBe(0);
      // Note: limit.exceeded event is emitted inside the transaction but
      // rolled back when the throw causes the transaction to abort. In
      // production, the caller emits the event in a separate committed
      // transaction when failing the run.
    });

    it('tighter mode policy depth limit wins over platform hard cap', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ depth-tight');
      const policyId = await insertPolicySnapshot(db, companyId, { depth: 1 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      // Depth 2 exceeds the tighter limit of 1.
      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.enforceTopologyLimits(tx, {
            rootRunId,
            companyId,
            projectId,
            childDepths: [1, 2],
            policyLimits: TreeLimitsService.toTreePolicyLimits({
              steps: 12,
              durationSeconds: 2700,
              providerCalls: 48,
              totalTokens: 300000,
              outputBytes: 8388608,
              costCents: 5000,
              depth: 1,
              fanOut: 4,
              descendants: 16,
            }),
          });
        }),
      ).rejects.toThrow(/depth.*exceeds/i);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.descendant_count).toBe(0);
    });
  });

  // -- VAL-SUB-032: Root descendant limit is enforced -----------------------

  describe('VAL-SUB-032: root descendant limit', () => {
    it('admits children up to the exact descendant boundary', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ desc-ok');
      const policyId = await insertPolicySnapshot(db, companyId, { descendants: 3 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      await db.drizzle.transaction(async (tx) => {
        await treeLimits.enforceTopologyLimits(tx, {
          rootRunId,
          companyId,
          projectId,
          childDepths: [1, 1, 1],
          policyLimits: TreeLimitsService.toTreePolicyLimits({
            steps: 12,
            durationSeconds: 2700,
            providerCalls: 48,
            totalTokens: 300000,
            outputBytes: 8388608,
            costCents: 5000,
            depth: 2,
            fanOut: 4,
            descendants: 3,
          }),
        });
      });

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.descendant_count).toBe(3);
    });

    it('rejects one-over descendant boundary atomically', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ desc-over');
      const policyId = await insertPolicySnapshot(db, companyId, { descendants: 3 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.enforceTopologyLimits(tx, {
            rootRunId,
            companyId,
            projectId,
            childDepths: [1, 1, 1, 1],
            policyLimits: TreeLimitsService.toTreePolicyLimits({
              steps: 12,
              durationSeconds: 2700,
              providerCalls: 48,
              totalTokens: 300000,
              outputBytes: 8388608,
              costCents: 5000,
              depth: 2,
              fanOut: 4,
              descendants: 3,
            }),
          });
        }),
      ).rejects.toThrow(/descendant.*exceeds/i);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.descendant_count).toBe(0);
    });

    it('counts existing descendants across branches and rejects overshoot', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ desc-existing');
      const policyId = await insertPolicySnapshot(db, companyId, { descendants: 5 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        descendantCount: 4,
      });

      // 4 existing + 2 new = 6 > limit of 5.
      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.enforceTopologyLimits(tx, {
            rootRunId,
            companyId,
            projectId,
            childDepths: [1, 1],
            policyLimits: TreeLimitsService.toTreePolicyLimits({
              steps: 12,
              durationSeconds: 2700,
              providerCalls: 48,
              totalTokens: 300000,
              outputBytes: 8388608,
              costCents: 5000,
              depth: 2,
              fanOut: 4,
              descendants: 5,
            }),
          });
        }),
      ).rejects.toThrow(/descendant.*exceeds/i);

      // 4 existing + 1 new = 5 == limit (OK).
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.enforceTopologyLimits(tx, {
          rootRunId,
          companyId,
          projectId,
          childDepths: [1],
          policyLimits: TreeLimitsService.toTreePolicyLimits({
            steps: 12,
            durationSeconds: 2700,
            providerCalls: 48,
            totalTokens: 300000,
            outputBytes: 8388608,
            costCents: 5000,
            depth: 2,
            fanOut: 4,
            descendants: 5,
          }),
        });
      });

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.descendant_count).toBe(5);
    });
  });

  // -- VAL-SUB-034: Provider-call limit spans the tree ---------------------

  describe('VAL-SUB-034: provider-call limit spans tree', () => {
    it('reserves and counts calls from root and descendants against one root counter', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ calls-ok');
      const policyId = await insertPolicySnapshot(db, companyId, { providerCalls: 5 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);
      const childId = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policyId,
      );

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 5,
        totalTokens: 300000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Reserve 3 root calls + 2 child calls = 5 (at limit).
      for (let i = 0; i < 3; i++) {
        await db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: rootRunId,
            companyId,
            projectId,
            estimatedInputTokens: 100,
            estimatedOutputTokens: 50,
            policyLimits: limits,
          });
        });
      }
      for (let i = 0; i < 2; i++) {
        await db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: childId,
            companyId,
            projectId,
            estimatedInputTokens: 100,
            estimatedOutputTokens: 50,
            policyLimits: limits,
          });
        });
      }

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.provider_call_count).toBe(5);
    });

    it('denies the call that would exceed the root provider-call limit', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ calls-over');
      const policyId = await insertPolicySnapshot(db, companyId, { providerCalls: 3 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        providerCallCount: 2,
      });
      const childId = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policyId,
      );

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 3,
        totalTokens: 300000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // 2 existing + 1 = 3 (at limit, OK).
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.reserveProviderCall(tx, {
          rootRunId,
          runId: childId,
          companyId,
          projectId,
          estimatedInputTokens: 100,
          estimatedOutputTokens: 50,
          policyLimits: limits,
        });
      });

      // 3 + 1 = 4 > limit of 3 (denied).
      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: rootRunId,
            companyId,
            projectId,
            estimatedInputTokens: 100,
            estimatedOutputTokens: 50,
            policyLimits: limits,
          });
        }),
      ).rejects.toThrow(/call.*exceeds/i);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.provider_call_count).toBe(3);
      // Note: limit.exceeded event is rolled back with the denied transaction.
    });
  });

  // -- VAL-SUB-035: Token limit spans the tree ------------------------------

  describe('VAL-SUB-035: token limit spans tree', () => {
    it('counts conservative in-flight tokens from root and descendants', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ tokens-ok');
      const policyId = await insertPolicySnapshot(db, companyId, { totalTokens: 10000 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);
      const childId = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policyId,
      );

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 10000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Reserve 4000 root + 3000 child = 7000 (under limit).
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.reserveProviderCall(tx, {
          rootRunId,
          runId: rootRunId,
          companyId,
          projectId,
          estimatedInputTokens: 2000,
          estimatedOutputTokens: 2000,
          policyLimits: limits,
        });
      });
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.reserveProviderCall(tx, {
          rootRunId,
          runId: childId,
          companyId,
          projectId,
          estimatedInputTokens: 1500,
          estimatedOutputTokens: 1500,
          policyLimits: limits,
        });
      });

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.input_tokens).toBe(3500);
      expect(counters.output_tokens).toBe(3500);
    });

    it('denies a call that would exceed the root token limit', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ tokens-over');
      const policyId = await insertPolicySnapshot(db, companyId, { totalTokens: 5000 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        inputTokens: 2000,
        outputTokens: 2000,
      });

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 5000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // 4000 existing + 2000 estimate = 6000 > limit of 5000 (denied).
      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: rootRunId,
            companyId,
            projectId,
            estimatedInputTokens: 1000,
            estimatedOutputTokens: 1000,
            policyLimits: limits,
          });
        }),
      ).rejects.toThrow(/token.*exceeds/i);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.input_tokens + counters.output_tokens).toBe(4000);
      // Note: limit.exceeded event is rolled back with the denied transaction.
    });
  });

  // -- VAL-SUB-036: Aggregate output bounded without truncation -------------

  describe('VAL-SUB-036: aggregate output bounded without truncation', () => {
    it('accepts output at the exact aggregate boundary', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ out-agg-ok');
      const policyId = await insertPolicySnapshot(db, companyId, { outputBytes: 10000 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        outputBytes: 9000,
      });

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 500000,
        outputBytes: 10000,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // 9000 existing + 1000 new = 10000 == limit (OK).
      let result: { allowed: boolean } | undefined;
      await db.drizzle.transaction(async (tx) => {
        result = await treeLimits.settleProviderCall(tx, {
          rootRunId,
          runId: rootRunId,
          companyId,
          projectId,
          reservationId: randomUUID(),
          actualInputTokens: 100,
          actualOutputTokens: 50,
          actualOutputBytes: 1000,
          policyLimits: limits,
        });
      });
      expect(result!.allowed).toBe(true);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.output_bytes).toBe(10000);
    });

    it('rejects output one byte over remaining aggregate capacity without truncation', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ out-agg-over');
      const policyId = await insertPolicySnapshot(db, companyId, { outputBytes: 10000 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        outputBytes: 9000,
      });

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 500000,
        outputBytes: 10000,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // 9000 existing + 1001 new = 10001 > limit (denied, no truncation).
      let result: { allowed: boolean; remainingAggregate: number } | undefined;
      await db.drizzle.transaction(async (tx) => {
        result = await treeLimits.settleProviderCall(tx, {
          rootRunId,
          runId: rootRunId,
          companyId,
          projectId,
          reservationId: randomUUID(),
          actualInputTokens: 100,
          actualOutputTokens: 50,
          actualOutputBytes: 1001,
          policyLimits: limits,
        });
      });
      expect(result!.allowed).toBe(false);
      expect(result!.remainingAggregate).toBe(1000);

      // Output bytes unchanged — no truncation persisted.
      const counters = await getRootCounters(db, rootRunId);
      expect(counters.output_bytes).toBe(9000);

      const events = await getRunEvents(db, rootRunId);
      const exceeded = events.filter(
        (e) => e.type === 'limit.exceeded' && e.payload.category === 'output_bytes',
      );
      expect(exceeded.length).toBe(1);
    });
  });

  // -- VAL-SUB-037: Oversized child result fails atomically -----------------

  describe('VAL-SUB-037: oversized child result fails atomically', () => {
    it('rejects a child result over 1 MiB even when aggregate capacity remains', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ child-over');
      const policyId = await insertPolicySnapshot(db, companyId);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);
      const childId = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policyId,
      );

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 500000,
        outputBytes: 10485760,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // 1 MiB + 1 byte = 1048577 > per-child cap of 1048576.
      let result: { allowed: boolean; perChildCap: number } | undefined;
      await db.drizzle.transaction(async (tx) => {
        result = await treeLimits.settleProviderCall(tx, {
          rootRunId,
          runId: childId,
          companyId,
          projectId,
          reservationId: randomUUID(),
          actualInputTokens: 100,
          actualOutputTokens: 50,
          actualOutputBytes: 1048577,
          policyLimits: limits,
        });
      });
      expect(result!.allowed).toBe(false);
      expect(result!.perChildCap).toBe(1048576);

      // No output bytes persisted (root aggregate unchanged).
      const counters = await getRootCounters(db, rootRunId);
      expect(counters.output_bytes).toBe(0);
    });

    it('accepts a child result at the exact 1 MiB boundary', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ child-exact');
      const policyId = await insertPolicySnapshot(db, companyId);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);
      const childId = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policyId,
      );

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 500000,
        outputBytes: 10485760,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Exactly 1 MiB = 1048576 (at boundary, OK).
      let result: { allowed: boolean } | undefined;
      await db.drizzle.transaction(async (tx) => {
        result = await treeLimits.settleProviderCall(tx, {
          rootRunId,
          runId: childId,
          companyId,
          projectId,
          reservationId: randomUUID(),
          actualInputTokens: 100,
          actualOutputTokens: 50,
          actualOutputBytes: 1048576,
          policyLimits: limits,
        });
      });
      expect(result!.allowed).toBe(true);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.output_bytes).toBe(1048576);
    });
  });

  // -- VAL-SUB-113: Oversized child results fail without semantic truncation

  describe('VAL-SUB-113: oversized child results fail without truncation', () => {
    it('one byte over child cap fails atomically — no truncated value persisted', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ truncation');
      const policyId = await insertPolicySnapshot(db, companyId);
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);
      const childId = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policyId,
      );

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 500000,
        outputBytes: 10485760,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Exactly at cap (OK).
      await db.drizzle.transaction(async (tx) => {
        const r = await treeLimits.settleProviderCall(tx, {
          rootRunId,
          runId: childId,
          companyId,
          projectId,
          reservationId: randomUUID(),
          actualInputTokens: 10,
          actualOutputTokens: 5,
          actualOutputBytes: 1048576,
          policyLimits: limits,
        });
        expect(r.allowed).toBe(true);
      });

      // One byte over remaining root cap (root has 1048576 already).
      const child2Id = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        1,
        policyId,
      );
      let denied = false;
      await db.drizzle.transaction(async (tx) => {
        const r = await treeLimits.settleProviderCall(tx, {
          rootRunId,
          runId: child2Id,
          companyId,
          projectId,
          reservationId: randomUUID(),
          actualInputTokens: 10,
          actualOutputTokens: 5,
          actualOutputBytes: 1048576, // root already has 1048576; total would be 2097152 > ... wait, cap is 10 MiB
          policyLimits: limits,
        });
        denied = !r.allowed;
      });
      // 1048576 + 1048576 = 2097152 < 10485760 (10 MiB) — should be allowed.
      expect(denied).toBe(false);

      // Now test aggregate overflow: set root to 9 MiB and try 2 MiB child.
      const rootRunId2 = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        outputBytes: 9 * 1024 * 1024, // 9 MiB
      });
      const child3Id = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId2,
        rootRunId2,
        1,
        0,
        policyId,
      );

      let result: { allowed: boolean } | undefined;
      await db.drizzle.transaction(async (tx) => {
        result = await treeLimits.settleProviderCall(tx, {
          rootRunId: rootRunId2,
          runId: child3Id,
          companyId,
          projectId,
          reservationId: randomUUID(),
          actualInputTokens: 10,
          actualOutputTokens: 5,
          actualOutputBytes: 2 * 1024 * 1024, // 2 MiB > 1 MiB per-child cap
          policyLimits: limits,
        });
      });
      expect(result!.allowed).toBe(false);

      // Root aggregate unchanged.
      const counters = await getRootCounters(db, rootRunId2);
      expect(counters.output_bytes).toBe(9 * 1024 * 1024);
    });
  });

  // -- VAL-SUB-031: Running-child concurrency is enforced -------------------

  describe('VAL-SUB-031: running-child concurrency', () => {
    it('enforces root-wide max of 4 running descendants', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ running-root');
      const policyId = await insertPolicySnapshot(db, companyId, { fanOut: 4 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      // Create 4 running children (at limit).
      for (let i = 0; i < 4; i++) {
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
          { status: 'queued' },
        );
        await db.drizzle.transaction(async (tx) => {
          await scheduling.acquireRunningPermits(tx, {
            rootRunId,
            parentRunId: rootRunId,
            runId: childId,
            companyId,
            projectId,
            rootFanOut: 4,
            parentFanOut: 4,
          });
        });
      }

      // countRunningDescendants counts status='running' rows, but permits
      // are held while children are still 'queued'. The permit count is
      // the authoritative concurrency measure.
      const permits = await scheduling.countHeldPermits(
        db.drizzle,
        rootRunId,
        'root_running',
        companyId,
      );
      expect(permits).toBe(4);

      // 5th child should be denied.
      const child5Id = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        4,
        policyId,
        { status: 'queued' },
      );
      await expect(
        db.drizzle.transaction(async (tx) => {
          await scheduling.acquireRunningPermits(tx, {
            rootRunId,
            parentRunId: rootRunId,
            runId: child5Id,
            companyId,
            projectId,
            rootFanOut: 4,
            parentFanOut: 4,
          });
        }),
      ).rejects.toThrow(/Root running permit limit/);
    });

    it('enforces tighter per-parent fan-out', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ running-parent');
      const policyId = await insertPolicySnapshot(db, companyId, { fanOut: 2 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      // Parent fan-out is 2; 3rd child should be denied.
      for (let i = 0; i < 2; i++) {
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
          { status: 'queued' },
        );
        await db.drizzle.transaction(async (tx) => {
          await scheduling.acquireRunningPermits(tx, {
            rootRunId,
            parentRunId: rootRunId,
            runId: childId,
            companyId,
            projectId,
            rootFanOut: 4,
            parentFanOut: 2,
          });
        });
      }

      const child3Id = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        2,
        policyId,
        { status: 'queued' },
      );
      await expect(
        db.drizzle.transaction(async (tx) => {
          await scheduling.acquireRunningPermits(tx, {
            rootRunId,
            parentRunId: rootRunId,
            runId: child3Id,
            companyId,
            projectId,
            rootFanOut: 4,
            parentFanOut: 2,
          });
        }),
      ).rejects.toThrow(/Parent running permit limit/);
    });
  });

  // -- VAL-SUB-039: Limit checks are race safe ------------------------------

  describe('VAL-SUB-039: race-safe limit checks', () => {
    it('concurrent descendant creation does not overshoot the limit', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ race-desc');
      const policyId = await insertPolicySnapshot(db, companyId, { descendants: 2 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 500000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 2,
      });

      // Two concurrent transactions each try to create 2 descendants.
      // Only one should succeed (2 + 2 = 4 > limit of 2).
      const promises = [0, 1].map(() =>
        db.drizzle
          .transaction(async (tx) => {
            await treeLimits.enforceTopologyLimits(tx, {
              rootRunId,
              companyId,
              projectId,
              childDepths: [1, 1],
              policyLimits: limits,
            });
            return 'ok';
          })
          .catch((e: Error) => e.message),
      );

      const results = await Promise.allSettled(promises);
      const oks = results.filter((r) => r.status === 'fulfilled' && r.value === 'ok');
      const errors = results.filter(
        (r) => r.status === 'rejected' || (r.status === 'fulfilled' && r.value !== 'ok'),
      );

      // At most one succeeded; at least one was rejected.
      expect(oks.length).toBeLessThanOrEqual(1);
      expect(errors.length).toBeGreaterThanOrEqual(1);

      // Descendant count never exceeds the limit.
      const counters = await getRootCounters(db, rootRunId);
      expect(counters.descendant_count).toBeLessThanOrEqual(2);
    });

    it('concurrent provider-call reservations do not overshoot the limit', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ race-calls');
      const policyId = await insertPolicySnapshot(db, companyId, { providerCalls: 2 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 2,
        totalTokens: 500000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // 3 concurrent reservations, only 2 should succeed.
      const promises = [0, 1, 2].map(() =>
        db.drizzle
          .transaction(async (tx) => {
            await treeLimits.reserveProviderCall(tx, {
              rootRunId,
              runId: rootRunId,
              companyId,
              projectId,
              estimatedInputTokens: 100,
              estimatedOutputTokens: 50,
              policyLimits: limits,
            });
            return 'ok';
          })
          .catch((e: Error) => e.message),
      );

      const results = await Promise.allSettled(promises);
      const oks = results.filter((r) => r.status === 'fulfilled' && r.value === 'ok');
      expect(oks.length).toBeLessThanOrEqual(2);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.provider_call_count).toBeLessThanOrEqual(2);
    });
  });

  // -- VAL-SUB-099: Root-wide shared counters use exact units ---------------

  describe('VAL-SUB-099: exact units and 80% approaching events', () => {
    it('counts every physical provider attempt with exact integer units', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ exact-units');
      const policyId = await insertPolicySnapshot(db, companyId, { providerCalls: 10 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);
      const childId = await insertChildRun(
        db,
        companyId,
        projectId,
        threadId,
        rootRunId,
        rootRunId,
        1,
        0,
        policyId,
      );

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 10,
        totalTokens: 100000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Reserve 3 calls with exact token estimates.
      for (let i = 0; i < 3; i++) {
        await db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: i === 2 ? childId : rootRunId,
            companyId,
            projectId,
            estimatedInputTokens: 500,
            estimatedOutputTokens: 300,
            policyLimits: limits,
          });
        });
      }

      const counters = await getRootCounters(db, rootRunId);
      // 3 calls, 3 * 500 = 1500 input tokens, 3 * 300 = 900 output tokens.
      expect(counters.provider_call_count).toBe(3);
      expect(counters.input_tokens).toBe(1500);
      expect(counters.output_tokens).toBe(900);
    });

    it('emits exactly one 80% approaching event per category', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ approaching');
      const policyId = await insertPolicySnapshot(db, companyId, { providerCalls: 10 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 10,
        totalTokens: 100000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Reserve calls 1-7 (below 80% threshold of 8).
      for (let i = 0; i < 7; i++) {
        await db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: rootRunId,
            companyId,
            projectId,
            estimatedInputTokens: 100,
            estimatedOutputTokens: 50,
            policyLimits: limits,
          });
        });
      }

      let events = await getRunEvents(db, rootRunId);
      let approaching = events.filter(
        (e) => e.type === 'limit.approaching' && e.payload.category === 'provider_calls',
      );
      expect(approaching.length).toBe(0); // 7 < 8 (80% of 10)

      // 8th call crosses 80% threshold.
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.reserveProviderCall(tx, {
          rootRunId,
          runId: rootRunId,
          companyId,
          projectId,
          estimatedInputTokens: 100,
          estimatedOutputTokens: 50,
          policyLimits: limits,
        });
      });

      events = await getRunEvents(db, rootRunId);
      approaching = events.filter(
        (e) => e.type === 'limit.approaching' && e.payload.category === 'provider_calls',
      );
      expect(approaching.length).toBe(1); // exactly one

      // 9th call — no additional approaching event.
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.reserveProviderCall(tx, {
          rootRunId,
          runId: rootRunId,
          companyId,
          projectId,
          estimatedInputTokens: 100,
          estimatedOutputTokens: 50,
          policyLimits: limits,
        });
      });

      events = await getRunEvents(db, rootRunId);
      approaching = events.filter(
        (e) => e.type === 'limit.approaching' && e.payload.category === 'provider_calls',
      );
      expect(approaching.length).toBe(1); // still exactly one
    });

    it('denies excess without overshoot — counter never exceeds limit', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ no-overshoot');
      const policyId = await insertPolicySnapshot(db, companyId, { providerCalls: 5 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 5,
        totalTokens: 100000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Fill to limit.
      for (let i = 0; i < 5; i++) {
        await db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: rootRunId,
            companyId,
            projectId,
            estimatedInputTokens: 100,
            estimatedOutputTokens: 50,
            policyLimits: limits,
          });
        });
      }

      // Try to exceed.
      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: rootRunId,
            companyId,
            projectId,
            estimatedInputTokens: 100,
            estimatedOutputTokens: 50,
            policyLimits: limits,
          });
        }),
      ).rejects.toThrow(/call.*exceeds/i);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.provider_call_count).toBe(5); // never exceeds
    });

    it('release decrements counters correctly', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ release');
      const policyId = await insertPolicySnapshot(db, companyId, { providerCalls: 10 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 10,
        totalTokens: 100000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Reserve 3 calls.
      for (let i = 0; i < 3; i++) {
        await db.drizzle.transaction(async (tx) => {
          await treeLimits.reserveProviderCall(tx, {
            rootRunId,
            runId: rootRunId,
            companyId,
            projectId,
            estimatedInputTokens: 200,
            estimatedOutputTokens: 100,
            policyLimits: limits,
          });
        });
      }

      let counters = await getRootCounters(db, rootRunId);
      expect(counters.provider_call_count).toBe(3);
      expect(counters.input_tokens).toBe(600);
      expect(counters.output_tokens).toBe(300);

      // Release 1.
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.releaseProviderCall(tx, {
          rootRunId,
          runId: rootRunId,
          companyId,
          projectId,
          reservationId: randomUUID(),
          estimatedInputTokens: 200,
          estimatedOutputTokens: 100,
          policyLimits: limits,
        });
      });

      counters = await getRootCounters(db, rootRunId);
      expect(counters.provider_call_count).toBe(2);
      expect(counters.input_tokens).toBe(400);
      expect(counters.output_tokens).toBe(200);
    });
  });

  // -- VAL-SUB-029/032: Platform hard cap enforcement -----------------------

  describe('platform hard caps', () => {
    it('depth hard cap is 2 regardless of policy', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ hardcap-depth');
      const policyId = await insertPolicySnapshot(db, companyId, { depth: 5 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      // Policy says depth 5, but platform hard cap is 2.
      // Depth 3 should be rejected even though policy allows 5.
      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.enforceTopologyLimits(tx, {
            rootRunId,
            companyId,
            projectId,
            childDepths: [3],
            policyLimits: TreeLimitsService.toTreePolicyLimits({
              steps: 12,
              durationSeconds: 2700,
              providerCalls: 48,
              totalTokens: 300000,
              outputBytes: 8388608,
              costCents: 5000,
              depth: 5,
              fanOut: 4,
              descendants: 16,
            }),
          });
        }),
      ).rejects.toThrow(/depth.*exceeds/i);
    });

    it('descendant hard cap is 16 regardless of policy', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ hardcap-desc');
      const policyId = await insertPolicySnapshot(db, companyId, { descendants: 20 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId);

      // Policy says 20, but platform hard cap is 16.
      // 17 descendants should be rejected.
      await expect(
        db.drizzle.transaction(async (tx) => {
          await treeLimits.enforceTopologyLimits(tx, {
            rootRunId,
            companyId,
            projectId,
            childDepths: Array(17).fill(1),
            policyLimits: TreeLimitsService.toTreePolicyLimits({
              steps: 12,
              durationSeconds: 2700,
              providerCalls: 48,
              totalTokens: 300000,
              outputBytes: 8388608,
              costCents: 5000,
              depth: 2,
              fanOut: 4,
              descendants: 20,
            }),
          });
        }),
      ).rejects.toThrow(/descendant.*exceeds/i);
    });
  });

  // -- Output boundary standalone check -------------------------------------

  describe('checkOutputBoundary standalone', () => {
    it('reports remaining aggregate and per-child cap', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ boundary-check');
      const policyId = await insertPolicySnapshot(db, companyId, { outputBytes: 5000 });
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        outputBytes: 3000,
      });

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 64,
        totalTokens: 500000,
        outputBytes: 5000,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      let result: OutputCheckResult | undefined;
      await db.drizzle.transaction(async (tx) => {
        result = await treeLimits.checkOutputBoundary(
          tx,
          rootRunId,
          companyId,
          projectId,
          1000,
          limits,
        );
      });
      expect(result!.allowed).toBe(true);
      expect(result!.remainingAggregate).toBe(1000);
      expect(result!.perChildCap).toBe(PLATFORM_HARD_CAPS.perSourceBytes);
    });
  });

  // -- Regression: dual approaching-event sequence collision ----------------

  describe('regression: concurrent provider_calls + tokens approaching do not collide', () => {
    it('a single reservation crossing 80% on both provider_calls and tokens emits two distinct-sequence approaching events without unique-constraint collision', async () => {
      const { companyId, projectId, threadId } = await seedScope(db, '__mtest__ dual-approaching');
      // providerCalls limit 10 -> 80% threshold = 8.
      // totalTokens limit 1000 -> 80% threshold = 800.
      const policyId = await insertPolicySnapshot(db, companyId, {
        providerCalls: 10,
        totalTokens: 1000,
      });
      // Start at 7 provider calls (below 80%) and 0 tokens.
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        providerCallCount: 7,
        inputTokens: 0,
        outputTokens: 0,
      });

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 10,
        totalTokens: 1000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // One reservation: +1 call (7->8, crosses 80%) and +800 tokens
      // (0->800, crosses 80%). Both categories cross in the same
      // transaction. Before the fix, both maybeEmitApproaching calls used
      // the same stale rootLastSeq and collided on run_events(run_id,
      // sequence). After the fix, the sequence is threaded between emits.
      await db.drizzle.transaction(async (tx) => {
        await treeLimits.reserveProviderCall(tx, {
          rootRunId,
          runId: rootRunId,
          companyId,
          projectId,
          estimatedInputTokens: 400,
          estimatedOutputTokens: 400,
          policyLimits: limits,
        });
      });

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.provider_call_count).toBe(8);
      expect(counters.input_tokens).toBe(400);
      expect(counters.output_tokens).toBe(400);

      const events = await getRunEvents(db, rootRunId);
      const approaching = events.filter((e) => e.type === 'limit.approaching');
      // Exactly two approaching events, one per category.
      expect(approaching.length).toBe(2);
      const categories = approaching.map((e) => e.payload.category).sort();
      expect(categories).toEqual(['provider_calls', 'tokens']);
      // Sequences are distinct and strictly increasing.
      const seqs = approaching.map((e) => e.sequence);
      expect(seqs[0]).not.toBe(seqs[1]);
      expect(seqs[1]).toBe(seqs[0] + 1);
      // No duplicate sequences across all events.
      const allSeqs = events.map((e) => e.sequence);
      expect(new Set(allSeqs).size).toBe(allSeqs.length);
      // Root lastEventSequence advanced to the last emitted sequence.
      expect(counters.last_event_sequence).toBe(Math.max(...allSeqs));
    });

    it('concurrent dual-cross reservations do not collide on run_events sequence', async () => {
      const { companyId, projectId, threadId } = await seedScope(
        db,
        '__mtest__ dual-approaching-race',
      );
      // providerCalls limit 10 -> 80% threshold = 8.
      // totalTokens limit 1000 -> 80% threshold = 800.
      const policyId = await insertPolicySnapshot(db, companyId, {
        providerCalls: 10,
        totalTokens: 1000,
      });
      // Start at 7 calls (below 80%) and 0 tokens.
      const rootRunId = await insertRootRun(db, companyId, projectId, threadId, policyId, {
        providerCallCount: 7,
        inputTokens: 0,
        outputTokens: 0,
      });

      const limits = TreeLimitsService.toTreePolicyLimits({
        steps: 12,
        durationSeconds: 2700,
        providerCalls: 10,
        totalTokens: 1000,
        outputBytes: 8388608,
        costCents: 5000,
        depth: 2,
        fanOut: 4,
        descendants: 16,
      });

      // Two concurrent reservations, each +1 call and +800 tokens.
      // Winner: 7->8 calls (crosses 80%), 0->800 tokens (crosses 80%).
      //   Emits two approaching events with distinct sequences.
      // Loser: 8->9 calls (OK), but 800+800=1600 > 1000 token limit -> denied.
      // No unique-constraint collision in either case.
      const promises = [0, 1].map(() =>
        db.drizzle
          .transaction(async (tx) => {
            await treeLimits.reserveProviderCall(tx, {
              rootRunId,
              runId: rootRunId,
              companyId,
              projectId,
              estimatedInputTokens: 400,
              estimatedOutputTokens: 400,
              policyLimits: limits,
            });
            return 'ok';
          })
          .catch((e: Error) => e.message),
      );

      const results = await Promise.allSettled(promises);
      const oks = results.filter((r) => r.status === 'fulfilled' && r.value === 'ok');
      // Exactly one succeeds (the other is denied by token limit).
      expect(oks.length).toBe(1);

      const counters = await getRootCounters(db, rootRunId);
      expect(counters.provider_call_count).toBe(8);
      expect(counters.input_tokens).toBe(400);
      expect(counters.output_tokens).toBe(400);

      // The winner emitted two approaching events with distinct sequences,
      // no unique-constraint collision.
      const events = await getRunEvents(db, rootRunId);
      const approaching = events.filter((e) => e.type === 'limit.approaching');
      expect(approaching.length).toBe(2);
      const seqs = approaching.map((e) => e.sequence);
      expect(seqs[0]).not.toBe(seqs[1]);
      const allSeqs = events.map((e) => e.sequence);
      expect(new Set(allSeqs).size).toBe(allSeqs.length);
    });
  });
});

type OutputCheckResult = {
  allowed: boolean;
  remainingAggregate: number;
  perChildCap: number;
  aggregateCap: number;
};
