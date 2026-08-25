import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { ProductionResearchExecutor } from '../services/mission/research-executor.js';
import type { ResearchExecutionContext } from '../services/mission/run-processor.js';
import type { ResearchExecutionService } from '../services/mission/research/research-execution-service.js';

/**
 * ProductionResearchExecutor unit tests.
 *
 * (fix-ut-m5-research-attempt-transaction)
 *
 * Verifies that:
 *  (a) execute() returns { executed: false, sourceCount: 0 } when ALL
 *      research operations fail, so the run can fall through to the LLM
 *      provider call path or be failed with a proper error.
 *  (b) execute() returns { executed: true, sourceCount: N } only when at
 *      least one operation succeeds.
 *
 * The internally-constructed ResearchExecutionService is replaced with a
 * mock via the test seam (ProductionResearchExecutorDeps.executionService).
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;

beforeEach(async () => {
  // Stub env so EnvCredentialStore returns a key for the primary provider.
  vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
  vi.stubEnv('FIRECRAWL_API_KEY', 'test-firecrawl-key');
  db = await createTestDb();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Seeding helpers (minimal: company, project, thread, run, step assignment)
// ---------------------------------------------------------------------------

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

async function seedRun(
  db: AnyDb,
  scope: { companyId: string; projectId: string; threadId: string },
  billingAgentId: string | null,
): Promise<{ runId: string; assignmentId: string }> {
  const runId = randomUUID();
  const now = new Date();

  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "request_safe_summary", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "available_at", "billing_agent_id", "created_at", "updated_at")
    VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, NULL, 0, 'company_agent', 'enc', 'hash', 'Root', 'deep_work', 'running', 1, 0, 'require_all', NULL, ${billingAgentId}, ${now}, ${now})
  `);

  // No step assignment seeded — the executor resolves billingAgentId as
  // null when no assignment is found, which is acceptable for these tests.
  return { runId, assignmentId: '' };
}

function makeContext(
  scope: { companyId: string; projectId: string },
  runId: string,
  operations: string[],
  signal: AbortSignal,
): ResearchExecutionContext {
  return {
    claim: {
      runId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      leaseOwner: 'test-worker',
      leaseToken: 'test-token',
      leaseExpiresAt: new Date(Date.now() + 30000),
      claimedFromStatus: 'queued',
      status: 'running',
      stateVersion: 1,
      lastEventSequence: 0,
      attemptCount: 0,
      isRecovery: false,
    },
    run: {
      id: runId,
      companyId: scope.companyId,
      projectId: scope.projectId,
      status: 'running',
      stateVersion: 1,
      lastEventSequence: 0,
      attemptCount: 0,
      cancelRequestedAt: null,
      policySnapshotId: null,
      requestEnvelope: null,
      initiatingAgentId: null,
      createdAt: new Date(),
      parentRunId: runId,
      rootRunId: runId,
      approvedPlanRevisionId: null,
    },
    policy: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      limits: { durationSeconds: 300 },
      toolAllowlist: ['research.search'],
      domainAllowlist: [],
    },
    requestText: 'test query',
    operations: operations as never,
    signal,
  };
}

/** A mock ResearchExecutionService whose executeResearch always throws. */
function failingExecutionService(): ResearchExecutionService {
  return {
    executeResearch: vi.fn(async () => {
      throw new Error('provider call failed');
    }),
  } as unknown as ResearchExecutionService;
}

/** A mock ResearchExecutionService that succeeds with N sources. */
function succeedingExecutionService(sourceCount: number): ResearchExecutionService {
  return {
    executeResearch: vi.fn(async () => ({
      sources: Array.from({ length: sourceCount }, (_, i) => ({
        canonicalUrl: `https://example.com/${i}`,
        title: `Source ${i}`,
        retrievedAt: new Date().toISOString(),
        injectionRiskLabels: [],
        contentHash: randomUUID(),
        byteCount: 100,
      })),
      logicalCallId: randomUUID(),
      providerRequestIdHash: null,
      reportedCredits: 1,
      costCents: 10,
    })),
  } as unknown as ResearchExecutionService;
}

/** A mock that fails the first N calls and succeeds after. */
function partialFailureExecutionService(
  failCount: number,
  sourceCount: number,
): ResearchExecutionService {
  let calls = 0;
  return {
    executeResearch: vi.fn(async () => {
      calls += 1;
      if (calls <= failCount) {
        throw new Error(`provider call ${calls} failed`);
      }
      return {
        sources: Array.from({ length: sourceCount }, (_, i) => ({
          canonicalUrl: `https://example.com/${i}`,
          title: `Source ${i}`,
          retrievedAt: new Date().toISOString(),
          injectionRiskLabels: [],
          contentHash: randomUUID(),
          byteCount: 100,
        })),
        logicalCallId: randomUUID(),
        providerRequestIdHash: null,
        reportedCredits: 1,
        costCents: 10,
      };
    }),
  } as unknown as ResearchExecutionService;
}

describe('fix-ut-m5-research-attempt-transaction: ProductionResearchExecutor.execute()', () => {
  it('returns executed=false when all research operations fail', async () => {
    const scope = await seedScope(db, '__mtest__ executor-all-fail');
    const { runId } = await seedRun(db, scope, null);

    const executor = new ProductionResearchExecutor(db, {
      executionService: failingExecutionService(),
    });

    const controller = new AbortController();
    const result = await executor.execute(
      makeContext(scope, runId, ['search', 'extract'], controller.signal),
    );

    expect(result.executed).toBe(false);
    expect(result.sourceCount).toBe(0);
  });

  it('returns executed=true when at least one operation succeeds', async () => {
    const scope = await seedScope(db, '__mtest__ executor-partial');
    const { runId } = await seedRun(db, scope, null);

    // First operation fails, second succeeds with 2 sources.
    const executor = new ProductionResearchExecutor(db, {
      executionService: partialFailureExecutionService(1, 2),
    });

    const controller = new AbortController();
    const result = await executor.execute(
      makeContext(scope, runId, ['search', 'extract'], controller.signal),
    );

    expect(result.executed).toBe(true);
    expect(result.sourceCount).toBe(2);
  });

  it('returns executed=true with correct sourceCount when all operations succeed', async () => {
    const scope = await seedScope(db, '__mtest__ executor-all-ok');
    const { runId } = await seedRun(db, scope, null);

    const executor = new ProductionResearchExecutor(db, {
      executionService: succeedingExecutionService(3),
    });

    const controller = new AbortController();
    const result = await executor.execute(
      makeContext(scope, runId, ['search', 'extract'], controller.signal),
    );

    expect(result.executed).toBe(true);
    // Two operations, each returning 3 sources.
    expect(result.sourceCount).toBe(6);
  });

  it('returns executed=false when no credential is available (early return)', async () => {
    // Remove the env stubs so EnvCredentialStore returns undefined.
    vi.unstubAllEnvs();

    const scope = await seedScope(db, '__mtest__ executor-no-cred');
    const { runId } = await seedRun(db, scope, null);

    const executor = new ProductionResearchExecutor(db, {
      executionService: failingExecutionService(),
    });

    const controller = new AbortController();
    const result = await executor.execute(makeContext(scope, runId, ['search'], controller.signal));

    expect(result.executed).toBe(false);
    expect(result.sourceCount).toBe(0);
  });
});
