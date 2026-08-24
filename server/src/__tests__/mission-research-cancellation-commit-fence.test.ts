import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { executeWithFallback, type FallbackEntry } from '../services/mission/research/fallback.js';
import { executeWithRetry, type RetryConfig } from '../services/mission/research/retry.js';
import {
  ResearchProviderError,
  type ResearchProvider,
  type ResearchRequest,
  type ResearchResult,
  type ResearchCallContext,
  type NormalizedResearchSource,
} from '../services/mission/research/spi.js';
import { DEFAULT_FALLBACK_POLICY } from '../services/mission/research/classification.js';
import { ResearchCircuitBreaker } from '../services/mission/research/circuit-breaker.js';
import { ArtifactCommitService } from '../services/mission/research/artifact-commit-service.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import type { ResearchProviderName } from '../services/mission/research/origins.js';

/**
 * Cancellation aborts research, fences artifact commits, preserves prior
 * evidence, and interrupts research waits.
 *
 * VAL-RES-061: Cancellation aborts research — cancel while provider request
 *              is in flight; API acknowledges promptly, worker aborts
 *              cancellable fetches, no fallback or new attempt starts, run
 *              becomes cancelled.
 * VAL-RES-062: No post-cancel artifact commit — cancellation wins before
 *              synthesis/artifact commit; no artifact, citation, or
 *              provenance becomes visible even if the remote provider later
 *              returns.
 * VAL-RES-063: Cancellation preserves prior evidence — cancel after one
 *              source revision is durably retrieved but before synthesis;
 *              the immutable source attempt and known charge remain
 *              auditable, but no completed artifact is presented.
 * VAL-RES-094: Cancellation interrupts research waits — cancellation during
 *              jitter, Retry-After, or half-open wait clears the wait
 *              promptly, emits no later provider attempt/fallback, and
 *              terminally cancels the same run.
 */

// ---------------------------------------------------------------------------
// Shared helpers (unit-test portion)
// ---------------------------------------------------------------------------

const noSleepConfig: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  sleep: vi.fn(async () => {}),
  random: () => 0.5,
};

function makeSuccessResult(provider: ResearchProviderName = 'tavily'): ResearchResult {
  return {
    logicalCallId: 'call-1',
    provider,
    sources: [
      {
        canonicalUrl: 'https://example.com',
        retrievedAt: new Date().toISOString(),
        rank: 0,
        injectionRiskLabels: [],
      },
    ],
    warnings: [],
  };
}

function makeProvider(
  name: ResearchProviderName,
  behavior: 'success' | 'transient' | 'timeout' | 'quota' | 'cancelled',
): ResearchProvider {
  const error =
    behavior === 'transient'
      ? new ResearchProviderError('PROVIDER_TRANSIENT', 'test', name, 'search')
      : behavior === 'timeout'
        ? new ResearchProviderError('PROVIDER_TIMEOUT', 'test', name, 'search')
        : behavior === 'quota'
          ? new ResearchProviderError('PROVIDER_QUOTA_EXCEEDED', 'test', name, 'search')
          : behavior === 'cancelled'
            ? new ResearchProviderError('CANCELLED', 'test', name, 'search')
            : null;

  return {
    supports: () => true,
    execute: vi.fn(async (): Promise<ResearchResult> => {
      if (behavior === 'success') {
        return makeSuccessResult(name);
      }
      throw error!;
    }),
  };
}

function makeRequest(): ResearchRequest {
  return { operation: 'search', query: 'test', maxResults: 5, timeoutMs: 5000 };
}

function makeEntries(primary: ResearchProvider, fallback?: ResearchProvider): FallbackEntry[] {
  const entries: FallbackEntry[] = [{ provider: primary, name: 'tavily' }];
  if (fallback) {
    entries.push({ provider: fallback, name: 'firecrawl' });
  }
  return entries;
}

// ===========================================================================
// VAL-RES-061: Cancellation aborts research (fallback coordinator)
// ===========================================================================

describe('VAL-RES-061: Cancellation aborts research', () => {
  it('aborts before first provider attempt when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const context: ResearchCallContext = { signal: controller.signal };

    const primary = makeProvider('tavily', 'success');
    const fallback = makeProvider('firecrawl', 'success');

    await expect(
      executeWithFallback(
        makeRequest(),
        makeEntries(primary, fallback),
        { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
        context,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // Neither provider was called.
    expect(primary.execute).not.toHaveBeenCalled();
    expect(fallback.execute).not.toHaveBeenCalled();
  });

  it('aborts during in-flight fetch — no fallback attempted', async () => {
    const controller = new AbortController();
    const context: ResearchCallContext = { signal: controller.signal };

    const fallback = makeProvider('firecrawl', 'success');

    // After the primary fails all retries (transient, 3 attempts), the
    // signal is aborted before fallback.
    // We simulate by aborting after the primary's last attempt.
    const wrappedPrimary: ResearchProvider = {
      supports: () => true,
      execute: vi.fn(async () => {
        controller.abort();
        throw new ResearchProviderError('PROVIDER_TRANSIENT', 'fail', 'tavily', 'search');
      }),
    };

    await expect(
      executeWithFallback(
        makeRequest(),
        makeEntries(wrappedPrimary, fallback),
        { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
        context,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // Fallback provider was never called.
    expect(fallback.execute).not.toHaveBeenCalled();
  });

  it('aborts between providers — second provider not called after cancellation', async () => {
    const controller = new AbortController();
    const context: ResearchCallContext = { signal: controller.signal };

    // Primary fails with a fallback-eligible error (quota).
    const primary = makeProvider('tavily', 'quota');
    const fallback = makeProvider('firecrawl', 'success');

    // Abort the signal right after primary fails (simulating cancellation
    // arriving between provider attempts).
    const realExecute = primary.execute;
    primary.execute = vi.fn(async (req, ctx) => {
      const result = realExecute(req, ctx);
      // Abort after the primary attempt returns/throws.
      controller.abort();
      return result;
    });

    await expect(
      executeWithFallback(
        makeRequest(),
        makeEntries(primary, fallback),
        { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
        context,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // Primary was called once (quota is non-retryable).
    expect(primary.execute).toHaveBeenCalledTimes(1);
    // Fallback was NOT called — cancellation prevented it.
    expect(fallback.execute).not.toHaveBeenCalled();
  });

  it('does not start a new attempt after cancellation wins the race', async () => {
    const controller = new AbortController();
    const context: ResearchCallContext = { signal: controller.signal };

    let primaryAttempts = 0;
    const primary: ResearchProvider = {
      supports: () => true,
      execute: vi.fn(async () => {
        primaryAttempts++;
        if (primaryAttempts === 1) {
          // Abort during the first attempt's processing.
          controller.abort();
          throw new ResearchProviderError('PROVIDER_TIMEOUT', 'timeout', 'tavily', 'search');
        }
        return makeSuccessResult('tavily');
      }),
    };
    const fallback = makeProvider('firecrawl', 'success');

    await expect(
      executeWithFallback(
        makeRequest(),
        makeEntries(primary, fallback),
        { fallbackPolicy: DEFAULT_FALLBACK_POLICY, retryConfig: noSleepConfig },
        context,
      ),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // Only one attempt on the primary; no retry, no fallback.
    expect(primary.execute).toHaveBeenCalledTimes(1);
    expect(fallback.execute).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// VAL-RES-094: Cancellation interrupts research waits
// ===========================================================================

describe('VAL-RES-094: Cancellation interrupts research waits', () => {
  it('clears jitter (retry backoff) wait promptly on cancellation', async () => {
    const controller = new AbortController();
    const context: ResearchCallContext = { signal: controller.signal };

    const sleepFn = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      controller.abort();
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
    });

    const config: RetryConfig = { ...noSleepConfig, sleep: sleepFn };
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        throw new ResearchProviderError('PROVIDER_TRANSIENT', 'fail', 'tavily', 'search');
      }
      return makeSuccessResult();
    });

    await expect(executeWithRetry(fn, config, context)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    // Only one attempt; no second attempt after cancellation during jitter.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clears Retry-After wait promptly on cancellation', async () => {
    const controller = new AbortController();
    const context: ResearchCallContext = { signal: controller.signal };

    const sleepFn = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      controller.abort();
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
    });

    const config: RetryConfig = { ...noSleepConfig, sleep: sleepFn };
    let attempt = 0;
    const fn = vi.fn(async () => {
      attempt++;
      if (attempt < 2) {
        throw new ResearchProviderError('PROVIDER_RATE_LIMITED', 'fail', 'tavily', 'search', 3000);
      }
      return makeSuccessResult();
    });

    await expect(executeWithRetry(fn, config, context)).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('clears half-open circuit wait promptly on cancellation — no provider attempt', async () => {
    const controller = new AbortController();
    const sleepFn = vi.fn(async (_ms: number, signal?: AbortSignal) => {
      controller.abort();
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
    });

    const breaker = new ResearchCircuitBreaker(db, {
      clock: () => 1_000_000,
      openDurationMs: 30_000,
      sleep: sleepFn,
    });

    // Open the circuit first.
    await breaker.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    await breaker.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    await breaker.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    await breaker.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');
    await breaker.recordFailure('tavily', 'search', 'PROVIDER_TRANSIENT');

    const health = await breaker.getHealth('tavily', 'search');
    expect(health.open).toBe(true);
    expect(health.retryAfterMs).toBeGreaterThan(0);

    // Waiting for the circuit to become probe-eligible should abort on
    // cancellation.
    await expect(
      breaker.waitForProbeEligibility('tavily', 'search', controller.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });

    // The sleep was called (wait was in progress) then aborted.
    expect(sleepFn).toHaveBeenCalled();
  });
});

// ===========================================================================
// Integration tests (real Postgres)
// ===========================================================================

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let sources: SourceRevisionService;
let commit: ArtifactCommitService;

beforeAll(async () => {
  db = await createTestDb();
  sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
  commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
});

afterAll(async () => {
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedScope(
  label: string,
  status: string = 'running',
  cancelRequested: boolean = false,
) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const threadId = randomUUID();
  const runId = randomUUID();
  const now = new Date();
  const isTerminal = status === 'cancelled' || status === 'completed' || status === 'failed';
  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id","name","status","budget_monthly_cents","spent_monthly_cents","settings","created_at","updated_at")
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{"testFixture": true}'::jsonb, ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id","company_id","name","status","created_at","updated_at")
    VALUES (${projectId}, ${companyId}, ${label}, 'active', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id","company_id","project_id","title","type","status","created_at","updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, ${label}, 'conversation', 'active', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id","company_id","project_id","project_thread_id","root_run_id","parent_run_id","depth","routing_kind","request_envelope","request_content_hash","request_safe_summary","resolved_mode","policy_snapshot_id","status","state_version","last_event_sequence","partial_result_policy","available_at","terminal_at","created_at","updated_at","cancel_requested_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'summary', 'deep_work', null, ${status}, 5, 10, 'require_all', ${now}, ${isTerminal ? now : null}, ${now}, ${now}, ${cancelRequested ? now : null})
  `);
  return { companyId, projectId, threadId, runId, now };
}

async function seedArtifact(db: AnyDb, companyId: string, projectId: string, version = 1) {
  const artifactId = randomUUID();
  const revisionId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "artifacts" ("id","company_id","project_id","type","title","content","version","created_at","updated_at")
    VALUES (${artifactId}, ${companyId}, ${projectId}, 'document', 'Cited Doc', '{}'::jsonb, ${version}, ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "artifact_revisions" ("id","artifact_id","version","content","edit_source","created_at")
    VALUES (${revisionId}, ${artifactId}, ${version}, '{}'::jsonb, 'agent', ${now})
  `);
  return { artifactId, revisionId, version };
}

async function seedSourceRevision(
  db: AnyDb,
  companyId: string,
  projectId: string,
  runId: string,
): Promise<string> {
  const sourceId = randomUUID();
  const revisionId = randomUUID();
  const now = new Date();
  const urlHash = createHash('sha256').update('https://example.com/article').digest('hex');
  await db.drizzle.execute(sql`
    INSERT INTO "research_sources" ("id","company_id","canonical_url","canonical_url_hash","origin_domain","first_seen_at","last_seen_at","created_at","updated_at")
    VALUES (${sourceId}, ${companyId}, 'https://example.com/article', ${urlHash}, 'example.com', ${now}, ${now}, ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "research_source_revisions" ("id","company_id","project_id","source_id","run_id","root_run_id","logical_call_id","provider","operation","provider_request_id_hash","retrieved_at","normalization_version","content_hash","byte_count","normalized_text_encrypted","injection_risk_labels","created_at")
    VALUES (${revisionId}, ${companyId}, ${projectId}, ${sourceId}, ${runId}, ${runId}, ${randomUUID()}, 'tavily', 'search', ${randomUUID()}, ${now}, 1, ${randomUUID()}, 100, null, '[]'::jsonb, ${now})
  `);
  return revisionId;
}

function makeSource(): NormalizedResearchSource {
  return {
    canonicalUrl: 'https://example.com/article',
    title: 'Test Article',
    retrievedAt: new Date().toISOString(),
    rank: 0,
    injectionRiskLabels: [],
    text: 'This is the normalized source text content for testing.',
    contentHash: randomUUID(),
    byteCount: 100,
  };
}

// ===========================================================================
// VAL-RES-062: No post-cancel artifact commit
// ===========================================================================

describe('VAL-RES-062: No post-cancel artifact commit', () => {
  it('rejects artifact commit when run is cancelled — no artifact/citation/provenance', async () => {
    const scope = await seedScope('cancel-commit-fence', 'cancelled');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const sourceRevId = await seedSourceRevision(db, scope.companyId, scope.projectId, scope.runId);

    await expect(
      commit.commitArtifactWithProvenance({
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: scope.runId,
        rootRunId: scope.runId,
        artifactId: art.artifactId,
        expectedVersion: 1,
        content: { body: 'synthesized output' },
        editSource: 'agent',
        editedByAgentId: null,
        citations: [
          {
            sourceRevisionId: sourceRevId,
            ordinal: 1,
            quote: 'test quote',
            frozenCanonicalUrl: 'https://example.com/article',
            frozenRetrievedAt: new Date().toISOString(),
            frozenProvider: 'tavily',
          },
        ],
        provenance: {
          generationTime: new Date(),
          citedSourceRevisionIds: [sourceRevId],
        },
      }),
    ).rejects.toMatchObject({ code: 'RUN_CANCELLED' });

    // Verify no new artifact revision was created.
    const revisions = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int as count FROM "artifact_revisions" WHERE "artifact_id" = ${art.artifactId}
    `)) as unknown as { count: number }[];
    expect(revisions[0].count).toBe(1); // only the seed revision
  });

  it('rejects artifact commit when run is cancel-requested (fence)', async () => {
    const scope = await seedScope('cancel-requested-fence', 'running', true);
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const sourceRevId = await seedSourceRevision(db, scope.companyId, scope.projectId, scope.runId);

    await expect(
      commit.commitArtifactWithProvenance({
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: scope.runId,
        rootRunId: scope.runId,
        artifactId: art.artifactId,
        expectedVersion: 1,
        content: { body: 'late output' },
        editSource: 'agent',
        citations: [
          {
            sourceRevisionId: sourceRevId,
            ordinal: 1,
            quote: 'test quote',
            frozenCanonicalUrl: 'https://example.com/article',
            frozenRetrievedAt: new Date().toISOString(),
            frozenProvider: 'tavily',
          },
        ],
        provenance: {
          generationTime: new Date(),
          citedSourceRevisionIds: [sourceRevId],
        },
      }),
    ).rejects.toMatchObject({ code: 'RUN_CANCELLED' });
  });

  it('allows artifact commit when run is running (positive control)', async () => {
    const scope = await seedScope('running-commit-ok', 'running', false);
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const sourceRevId = await seedSourceRevision(db, scope.companyId, scope.projectId, scope.runId);

    const result = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: { body: 'normal output' },
      editSource: 'agent',
      citations: [
        {
          sourceRevisionId: sourceRevId,
          ordinal: 1,
          quote: 'test quote',
          normalizedSourceText:
            'this is the source text containing the test quote for verification',
          frozenCanonicalUrl: 'https://example.com/article',
          frozenRetrievedAt: new Date().toISOString(),
          frozenProvider: 'tavily',
        },
      ],
      provenance: {
        generationTime: new Date(),
        citedSourceRevisionIds: [sourceRevId],
      },
    });

    expect(result.artifactRevisionId).toBeDefined();
    expect(result.version).toBe(2);
    expect(result.citationIds).toHaveLength(1);
    expect(result.provenanceId).toBeDefined();
  });
});

// ===========================================================================
// VAL-RES-063: Cancellation preserves prior evidence
// ===========================================================================

describe('VAL-RES-063: Cancellation preserves prior evidence', () => {
  it('source revision remains auditable after cancellation; no artifact presented', async () => {
    const scope = await seedScope('preserve-evidence', 'cancelled');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);

    // Persist a source revision BEFORE cancellation (simulating evidence
    // retrieved during research before the cancel took effect).
    const sourceRevId = await seedSourceRevision(db, scope.companyId, scope.projectId, scope.runId);

    // The source revision remains in the database (immutable).
    const sourceRows = (await db.drizzle.execute(sql`
      SELECT "id","provider","operation","retrieved_at" FROM "research_source_revisions"
      WHERE "id" = ${sourceRevId} AND "company_id" = ${scope.companyId} AND "project_id" = ${scope.projectId}
    `)) as unknown as { id: string; provider: string; operation: string; retrieved_at: Date }[];
    expect(sourceRows).toHaveLength(1);
    expect(sourceRows[0].provider).toBe('tavily');

    // Attempting to commit an artifact after cancellation is fenced.
    await expect(
      commit.commitArtifactWithProvenance({
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: scope.runId,
        rootRunId: scope.runId,
        artifactId: art.artifactId,
        expectedVersion: 1,
        content: { body: 'late synthesis' },
        editSource: 'agent',
        citations: [
          {
            sourceRevisionId: sourceRevId,
            ordinal: 1,
            quote: 'test quote',
            frozenCanonicalUrl: 'https://example.com/article',
            frozenRetrievedAt: new Date().toISOString(),
            frozenProvider: 'tavily',
          },
        ],
        provenance: {
          generationTime: new Date(),
          citedSourceRevisionIds: [sourceRevId],
        },
      }),
    ).rejects.toMatchObject({ code: 'RUN_CANCELLED' });

    // No new artifact revisions, citations, or provenance rows.
    const revCount = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int as count FROM "artifact_revisions" WHERE "artifact_id" = ${art.artifactId}
    `)) as unknown as { count: number }[];
    expect(revCount[0].count).toBe(1);

    const citationCount = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int as count FROM "citations" WHERE "run_id" = ${scope.runId}
    `)) as unknown as { count: number }[];
    expect(citationCount[0].count).toBe(0);

    const provenanceCount = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int as count FROM "artifact_provenance" WHERE "run_id" = ${scope.runId}
    `)) as unknown as { count: number }[];
    expect(provenanceCount[0].count).toBe(0);
  });

  it('prior evidence persists through source revision service — retrievable after cancel', async () => {
    const scope = await seedScope('evidence-persist', 'running');

    // Persist a source revision while running.
    const result = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      providerRequestIdHash: randomUUID(),
      source: makeSource(),
      rank: 0,
      relevanceScore: 0.95,
    });

    expect(result.sourceRevisionId).toBeDefined();

    // Now cancel the run.
    await db.drizzle.execute(sql`
      UPDATE "mission_runs" SET "status" = 'cancelled', "terminal_at" = ${new Date()}, "updated_at" = ${new Date()}
      WHERE "id" = ${scope.runId}
    `);

    // The source revision is still retrievable (immutable, auditable).
    const rows = (await db.drizzle.execute(sql`
      SELECT "id","provider","operation" FROM "research_source_revisions"
      WHERE "id" = ${result.sourceRevisionId} AND "company_id" = ${scope.companyId}
    `)) as unknown as { id: string; provider: string; operation: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe('tavily');
  });
});
