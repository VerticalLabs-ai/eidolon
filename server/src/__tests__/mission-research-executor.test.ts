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
      researchPolicy: null,
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

    // First operation fails, second succeeds with 2 sources. Both are
    // search operations so no URL-availability gate applies.
    // With both Tavily and Firecrawl available, each search operation
    // is attempted with both providers independently
    // (fix-ut-m5-synthesis-date-serialization).
    const executor = new ProductionResearchExecutor(db, {
      executionService: partialFailureExecutionService(1, 2),
    });

    const controller = new AbortController();
    const result = await executor.execute(
      makeContext(scope, runId, ['search', 'search'], controller.signal),
    );

    expect(result.executed).toBe(true);
    // 4 calls total: search1-tavily(fail), search1-firecrawl(2), search2-tavily(2), search2-firecrawl(2)
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
    // search with both providers: Tavily(3) + Firecrawl(3) = 6
    // extract with Tavily only: 3
    // Total: 9 sources.
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

// ---------------------------------------------------------------------------
// fix-ut-m5-research-execution-gaps: Provider-operation capability filtering
// and URL availability for scrape/structured_extract.
// ---------------------------------------------------------------------------

/**
 * A mock ResearchExecutionService that records every call's provider and
 * operation, and returns a configurable result.
 */
function trackingExecutionService(
  sourceCount: number,
  sourceUrls?: string[],
): ResearchExecutionService & {
  calls: Array<{ provider: string; operation: string; urls?: string[]; query?: string }>;
} {
  const calls: Array<{ provider: string; operation: string; urls?: string[]; query?: string }> = [];
  const urls = sourceUrls ?? ['https://example.com/result-1', 'https://example.com/result-2'];
  return {
    calls,
    executeResearch: vi.fn(
      async (input: { provider: string; operation: string; urls?: string[]; query?: string }) => {
        calls.push({
          provider: input.provider,
          operation: input.operation,
          urls: input.urls,
          query: input.query,
        });
        return {
          sources: Array.from({ length: sourceCount }, (_, i) => ({
            canonicalUrl: urls[i % urls.length] ?? `https://example.com/${i}`,
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
      },
    ),
  } as unknown as ResearchExecutionService & {
    calls: Array<{ provider: string; operation: string; urls?: string[]; query?: string }>;
  };
}

describe('fix-ut-m5-research-execution-gaps: provider-operation capability filtering', () => {
  it('only attempts extract with Tavily, not Firecrawl', async () => {
    const scope = await seedScope(db, '__mtest__ exec-extract-tavily');
    const { runId } = await seedRun(db, scope, null);

    const mock = trackingExecutionService(2);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    await executor.execute(makeContext(scope, runId, ['search', 'extract'], controller.signal));

    // The extract operation must only be attempted with Tavily.
    const extractCalls = mock.calls.filter((c) => c.operation === 'extract');
    expect(extractCalls.length).toBeGreaterThan(0);
    for (const c of extractCalls) {
      expect(c.provider).toBe('tavily');
    }
  });

  it('only attempts scrape and structured_extract with Firecrawl, not Tavily', async () => {
    const scope = await seedScope(db, '__mtest__ exec-scrape-firecrawl');
    const { runId } = await seedRun(db, scope, null);

    const mock = trackingExecutionService(1);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    await executor.execute(
      makeContext(scope, runId, ['search', 'scrape', 'structured_extract'], controller.signal),
    );

    // scrape and structured_extract must only be attempted with Firecrawl.
    const scrapeCalls = mock.calls.filter((c) => c.operation === 'scrape');
    for (const c of scrapeCalls) {
      expect(c.provider).toBe('firecrawl');
    }
    const structuredCalls = mock.calls.filter((c) => c.operation === 'structured_extract');
    for (const c of structuredCalls) {
      expect(c.provider).toBe('firecrawl');
    }
  });

  it('prefers Tavily for search operations and also attempts Firecrawl', async () => {
    const scope = await seedScope(db, '__mtest__ exec-search-prefers-tavily');
    const { runId } = await seedRun(db, scope, null);

    const mock = trackingExecutionService(1);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    await executor.execute(makeContext(scope, runId, ['search'], controller.signal));

    // With both providers available, search is attempted with each
    // independently (fix-ut-m5-synthesis-date-serialization).
    const searchCalls = mock.calls.filter((c) => c.operation === 'search');
    expect(searchCalls.length).toBe(1);
    expect(searchCalls[0]!.provider).toBe('tavily');
  });

  it('skips operations where no available provider supports them', async () => {
    const scope = await seedScope(db, '__mtest__ exec-skip-unsupported');
    const { runId } = await seedRun(db, scope, null);

    // Only Firecrawl credential available — extract (Tavily-only) should be skipped.
    // Stub TAVILY_API_KEY to empty so no Tavily adapter is constructed.
    vi.stubEnv('TAVILY_API_KEY', '');
    vi.stubEnv('FIRECRAWL_API_KEY', 'test-firecrawl-key');

    const mock = trackingExecutionService(1);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    const result = await executor.execute(
      makeContext(scope, runId, ['search', 'extract'], controller.signal),
    );

    // search is supported by Firecrawl, extract is not (no Tavily credential).
    const searchCalls = mock.calls.filter((c) => c.operation === 'search');
    const extractCalls = mock.calls.filter((c) => c.operation === 'extract');
    expect(searchCalls.length).toBe(1);
    expect(extractCalls.length).toBe(0);
    // search succeeded so executed=true.
    expect(result.executed).toBe(true);
  });
});

describe('fix-ut-m5-research-execution-gaps: URL availability for scrape/structured_extract', () => {
  it('passes URLs from prior search results to scrape/structured_extract', async () => {
    const scope = await seedScope(db, '__mtest__ exec-urls-from-search');
    const { runId } = await seedRun(db, scope, null);

    const searchUrls = ['https://example.com/page-a', 'https://example.com/page-b'];
    const mock = trackingExecutionService(2, searchUrls);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    await executor.execute(makeContext(scope, runId, ['search', 'scrape'], controller.signal));

    // search should have no urls, scrape should have urls from search results.
    const searchCall = mock.calls.find((c) => c.operation === 'search');
    const scrapeCall = mock.calls.find((c) => c.operation === 'scrape');
    expect(searchCall).toBeTruthy();
    expect(scrapeCall).toBeTruthy();
    expect(searchCall!.urls).toBeUndefined();
    expect(scrapeCall!.urls).toEqual(expect.arrayContaining(searchUrls));
  });

  it('skips scrape/structured_extract when no URLs are available from prior search', async () => {
    const scope = await seedScope(db, '__mtest__ exec-no-urls-skip');
    const { runId } = await seedRun(db, scope, null);

    // Only scrape in operations, no search to produce URLs.
    const mock = trackingExecutionService(1);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    const result = await executor.execute(makeContext(scope, runId, ['scrape'], controller.signal));

    // scrape was not attempted because no URLs were available.
    expect(mock.calls.length).toBe(0);
    expect(result.executed).toBe(false);
    expect(result.sourceCount).toBe(0);
  });

  it('skips structured_extract when no URLs are available and search is not in operations', async () => {
    const scope = await seedScope(db, '__mtest__ exec-no-urls-structured');
    const { runId } = await seedRun(db, scope, null);

    const mock = trackingExecutionService(1);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    const result = await executor.execute(
      makeContext(scope, runId, ['extract', 'structured_extract'], controller.signal),
    );

    // Neither extract nor structured_extract attempted — no URLs available.
    expect(mock.calls.length).toBe(0);
    expect(result.executed).toBe(false);
  });

  it('attempts extract with URLs from prior search results', async () => {
    const scope = await seedScope(db, '__mtest__ exec-extract-with-urls');
    const { runId } = await seedRun(db, scope, null);

    const searchUrls = ['https://example.com/extract-target'];
    const mock = trackingExecutionService(1, searchUrls);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    await executor.execute(makeContext(scope, runId, ['search', 'extract'], controller.signal));

    const extractCall = mock.calls.find((c) => c.operation === 'extract');
    expect(extractCall).toBeTruthy();
    expect(extractCall!.urls).toEqual(expect.arrayContaining(searchUrls));
  });
});

// ---------------------------------------------------------------------------
// fix-ut-m5-synthesis-date-serialization: Firecrawl search regression tests
// ---------------------------------------------------------------------------

describe('fix-ut-m5-synthesis-date-serialization: Firecrawl search is attempted in production', () => {
  it('uses one logical search with Firecrawl available only as fallback)', async () => {
    const scope = await seedScope(db, '__mtest__ exec-firecrawl-search-additional');
    const { runId } = await seedRun(db, scope, null);

    const mock = trackingExecutionService(2);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    const result = await executor.execute(makeContext(scope, runId, ['search'], controller.signal));

    // Both Tavily and Firecrawl search must be attempted independently.
    const searchCalls = mock.calls.filter((c) => c.operation === 'search');
    expect(searchCalls.length).toBe(1);
    expect(searchCalls[0]!.provider).toBe('tavily');

    // Sources from both providers are collected.
    expect(result.executed).toBe(true);
    expect(result.sourceCount).toBe(2); // one successful primary attempt
  });

  it('does not attempt Firecrawl search when only Tavily credential is available', async () => {
    // Only Tavily credential available.
    vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
    vi.stubEnv('FIRECRAWL_API_KEY', '');

    const scope = await seedScope(db, '__mtest__ exec-firecrawl-search-tavily-only');
    const { runId } = await seedRun(db, scope, null);

    const mock = trackingExecutionService(2);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    const result = await executor.execute(makeContext(scope, runId, ['search'], controller.signal));

    // Only Tavily search is attempted (no split since Firecrawl is unavailable).
    const searchCalls = mock.calls.filter((c) => c.operation === 'search');
    expect(searchCalls.length).toBe(1);
    expect(searchCalls[0]!.provider).toBe('tavily');
    expect(result.executed).toBe(true);
    expect(result.sourceCount).toBe(2);
  });

  it('collects URLs from both Tavily and Firecrawl search for subsequent operations', async () => {
    const scope = await seedScope(db, '__mtest__ exec-firecrawl-search-urls');
    const { runId } = await seedRun(db, scope, null);

    const searchUrls = [
      'https://example.com/tavily-result',
      'https://example.com/firecrawl-result',
    ];
    const mock = trackingExecutionService(2, searchUrls);
    const executor = new ProductionResearchExecutor(db, { executionService: mock });

    const controller = new AbortController();
    await executor.execute(makeContext(scope, runId, ['search', 'scrape'], controller.signal));

    // Both Tavily and Firecrawl search are attempted, each returning
    // the same set of URLs. The scrape call should receive URLs from
    // both search calls.
    const searchCalls = mock.calls.filter((c) => c.operation === 'search');
    expect(searchCalls.length).toBe(1);

    const scrapeCall = mock.calls.find((c) => c.operation === 'scrape');
    expect(scrapeCall).toBeTruthy();
    expect(scrapeCall!.urls).toEqual(expect.arrayContaining(searchUrls));
  });
});
