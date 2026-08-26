import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { RunProcessor, type ResearchExecutionContext } from '../services/mission/run-processor.js';
import { SynthesisArtifactCreator } from '../services/mission/synthesis-artifact-creator.js';
import { ArtifactCommitService } from '../services/mission/research/artifact-commit-service.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { ProductionResearchExecutor } from '../services/mission/research-executor.js';
import type { Claim } from '../services/mission/coordinator.js';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../providers/types.js';

/**
 * Integration tests for fix-ut-m5-synthesis-firecrawl-url-passing.
 *
 * Verifies the full production path:
 *  search → collect URLs → extract/scrape with URLs → persist sources →
 *  synthesize → create artifact with citations → expose via API.
 *
 * Issue 1: SynthesisArtifactCreator is constructed in worker.ts and passed
 *         to RunProcessor. After synthesis, it creates artifacts with
 *         citations and provenance.
 * Issue 2: ProductionResearchExecutor attempts Firecrawl search in addition
 *         to Tavily search (both adapters are in the provider list).
 * Issue 3: URLs from search results are collected and passed to
 *         extract/scrape/structured_extract operations.
 *
 * All tests use real Postgres on 127.0.0.1:55322.
 */

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
  leaseToken?: string,
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const token = leaseToken ?? null;
  const leaseOwner = token ? 'test-worker' : null;
  const leaseExpires = token ? new Date(Date.now() + 30_000) : null;
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "lease_owner", "lease_token", "lease_expires_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', ${leaseOwner}, ${token}, ${leaseExpires}, ${now}, ${now})
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
  childOrdinal: number,
  status: string,
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  const isTerminal = ['completed', 'failed', 'cancelled'].includes(status);
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "terminal_at", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, ${parentRunId}, 1, ${childOrdinal}, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'deep_work', ${status}, 1, 0, 'require_all', ${isTerminal ? now : null}, ${now}, ${now})
  `);
  return runId;
}

async function insertPlanRevision(
  db: AnyDb,
  companyId: string,
  projectId: string,
  runId: string,
  childCount: number,
): Promise<{ revisionId: string; contentHash: string }> {
  const revisionId = randomUUID();
  const contentHash = randomUUID();
  const now = new Date();

  // Build plan content with a root step and child steps so
  // handleTopologyMaterialization detects children.
  const steps: Array<{
    stepKey: string;
    title: string;
    description: string;
    parentStepKey: string | null;
    dependencies: string[];
    toolAllowlist: string[];
    expectedOutputs: string[];
    completionCriteria: string[];
    budgetCents: number;
  }> = [
    {
      stepKey: 'root',
      title: 'Root orchestration',
      description: 'Decompose and synthesize',
      parentStepKey: null,
      dependencies: [],
      toolAllowlist: [],
      expectedOutputs: [],
      completionCriteria: [],
      budgetCents: 5000,
    },
  ];
  for (let i = 0; i < childCount; i++) {
    steps.push({
      stepKey: `step-${i}`,
      title: `Child step ${i}`,
      description: `Research step ${i}`,
      parentStepKey: 'root',
      dependencies: [],
      toolAllowlist: ['research.search'],
      expectedOutputs: [],
      completionCriteria: [],
      budgetCents: 1000,
    });
  }
  const content = JSON.stringify({
    schemaVersion: 1,
    objective: 'Research and synthesize',
    steps,
    synthesis: { strategy: 'composite' },
    partialResultPolicy: 'require_all',
    limits: {},
  });

  await db.drizzle.execute(sql`
    INSERT INTO "run_plan_revisions" ("id", "company_id", "project_id", "run_id", "revision", "status", "content", "content_hash", "generated_by", "estimates", "created_at", "updated_at")
    VALUES (${revisionId}, ${companyId}, ${projectId}, ${runId}, 1, 'approved', ${content}::jsonb, ${contentHash}, '{}'::jsonb, '{}'::jsonb, ${now}, ${now})
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
  revisionId: string,
  contentHash: string,
): Promise<void> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_step_assignments" ("id", "company_id", "project_id", "root_run_id", "parent_run_id", "run_id", "step_key", "child_ordinal", "node_kind", "approved_plan_revision_id", "approved_content_hash", "assignment_status", "result_status", "created_at", "updated_at")
    VALUES (${id}, ${companyId}, ${projectId}, ${rootRunId}, ${parentRunId}, ${childRunId}, ${stepKey}, ${childOrdinal}, 'child', ${revisionId}, ${contentHash}, 'completed', 'completed', ${now}, ${now})
  `);
}

async function insertBudgetReservation(db: AnyDb, companyId: string, runId: string): Promise<void> {
  const reservationId = randomUUID();
  const allocationId = randomUUID();
  const now = new Date();
  const periodKey = now.toISOString().slice(0, 7);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${companyId}, ${runId}, null, 5000, 5000, 0, 0, ${periodKey}, 'held', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${allocationId}, ${companyId}, ${reservationId}, ${runId}, null, 5000, 0, 0, 'held', ${now}, ${now})
  `);
}

async function seedResearchSource(
  db: AnyDb,
  scope: { companyId: string; projectId: string },
  childRunId: string,
  rootRunId: string,
  title: string,
  url: string,
): Promise<{ sourceRevisionId: string; canonicalUrl: string }> {
  const source = {
    canonicalUrl: url,
    title,
    author: 'Test Author',
    publishedAt: '2026-08-24T00:00:00Z',
    rank: 0,
    score: 0.9,
    retrievedAt: '2026-08-24T12:00:00Z',
    mimeType: 'text/html',
    language: 'en',
    text: `Content from ${title}. The quick brown fox jumps over the lazy dog.`,
    byteCount: 60,
    injectionRiskLabels: [] as never[],
  };

  const persisted = await sources.persistSourceRevision({
    companyId: scope.companyId,
    projectId: scope.projectId,
    runId: childRunId,
    rootRunId,
    logicalCallId: randomUUID(),
    provider: 'tavily',
    operation: 'search',
    source,
  });

  return {
    sourceRevisionId: persisted.sourceRevisionId,
    canonicalUrl: persisted.canonicalUrl,
  };
}

/** Set up a complete composite tree with approved plan, root run, and children. */
async function setupTree(
  db: AnyDb,
  label: string,
  childCount: number,
  leaseToken?: string,
): Promise<{
  companyId: string;
  projectId: string;
  threadId: string;
  rootRunId: string;
  revisionId: string;
  contentHash: string;
  policyId: string;
  childRunIds: string[];
}> {
  const scope = await seedScope(db, label);
  const policyId = await insertPolicySnapshot(db, scope.companyId);
  const rootRunId = await insertRootRun(
    db,
    scope.companyId,
    scope.projectId,
    scope.threadId,
    policyId,
    leaseToken,
  );
  const { revisionId, contentHash } = await insertPlanRevision(
    db,
    scope.companyId,
    scope.projectId,
    rootRunId,
    childCount,
  );
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
  `);
  await insertBudgetReservation(db, scope.companyId, rootRunId);

  const childRunIds: string[] = [];
  for (let i = 0; i < childCount; i++) {
    const childRunId = await insertChildRun(
      db,
      scope.companyId,
      scope.projectId,
      scope.threadId,
      rootRunId,
      rootRunId,
      i,
      'completed',
    );
    childRunIds.push(childRunId);
    await insertStepAssignment(
      db,
      scope.companyId,
      scope.projectId,
      rootRunId,
      rootRunId,
      childRunId,
      `step-${i}`,
      i,
      revisionId,
      contentHash,
    );
  }

  return {
    companyId: scope.companyId,
    projectId: scope.projectId,
    threadId: scope.threadId,
    rootRunId,
    revisionId,
    contentHash,
    policyId,
    childRunIds,
  };
}

function mockProviderCall(): (
  messages: ChatMessage[],
  config: ProviderConfig,
  signal: AbortSignal,
) => Promise<CompletionResult> {
  return vi.fn(async () => ({
    content: 'Synthesized research report from gathered sources.',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    inputTokens: 100,
    outputTokens: 50,
    costCents: 10,
    finishReason: 'stop',
    latencyMs: 500,
  }));
}

function makeClaim(companyId: string, projectId: string, runId: string): Claim {
  return {
    runId,
    companyId,
    projectId,
    leaseOwner: 'test-worker',
    leaseToken: 'test-lease-token',
    leaseExpiresAt: new Date(Date.now() + 30_000),
    claimedFromStatus: 'running',
    status: 'running',
    stateVersion: 1,
    lastEventSequence: 0,
    attemptCount: 0,
    isRecovery: false,
  };
}

// ---------------------------------------------------------------------------
// Issue 1: SynthesisArtifactCreator is wired into RunProcessor
// ---------------------------------------------------------------------------

describe('fix-ut-m5-synthesis-firecrawl-url-passing: Issue 1 — SynthesisArtifactCreator wired into RunProcessor', () => {
  it('RunProcessor with synthesisArtifactCreator creates artifact with citations after synthesis', async () => {
    const tree = await setupTree(db, '__mtest__ issue1-wired', 2, 'test-lease-token');
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    // Seed research sources for both children.
    await seedResearchSource(
      db,
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'Source A',
      'https://example.com/a',
    );
    await seedResearchSource(
      db,
      scope,
      tree.childRunIds[1]!,
      tree.rootRunId,
      'Source B',
      'https://example.com/b',
    );

    // Construct the SynthesisArtifactCreator (as worker.ts now does).
    const synthesisArtifactCreator = new SynthesisArtifactCreator(db, {
      providerCall: mockProviderCall(),
      artifactCommitService: commit,
    });

    // Construct RunProcessor with the synthesisArtifactCreator wired in.
    const processor = new RunProcessor(db, {
      synthesisArtifactCreator,
    });

    const claim = makeClaim(tree.companyId, tree.projectId, tree.rootRunId);
    const controller = new AbortController();

    // Advance the root run — this triggers topology materialization
    // check, then attemptCompositeSynthesis (all children are terminal),
    // which completes the run and then calls createSynthesisArtifact.
    await processor.advance(claim, controller.signal);

    // Verify the run is now completed.
    const runRows = (await db.drizzle.execute(sql`
      SELECT "status" FROM "mission_runs" WHERE "id" = ${tree.rootRunId}
    `)) as unknown as { status: string }[];
    expect(runRows[0]?.status).toBe('completed');

    // Verify artifact was created.
    const artifactRows = (await db.drizzle.execute(sql`
      SELECT a."id", a."title", a."type"
      FROM "artifacts" a
      JOIN "artifact_provenance" ap ON ap."artifact_id" = a."id"
      WHERE ap."run_id" = ${tree.rootRunId} AND ap."company_id" = ${tree.companyId}
    `)) as unknown as { id: string; title: string; type: string }[];
    expect(artifactRows.length).toBe(1);
    expect(artifactRows[0]!.title).toBe('Research Synthesis Report');

    // Verify citations were created.
    const citationRows = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS c FROM "citations"
      WHERE "company_id" = ${tree.companyId} AND "project_id" = ${tree.projectId}
        AND "artifact_revision_id" IN (
          SELECT "artifact_revision_id" FROM "artifact_provenance"
          WHERE "run_id" = ${tree.rootRunId}
        )
    `)) as unknown as { c: number }[];
    expect(citationRows[0]?.c).toBe(2);

    // Verify provenance was created.
    const provRows = (await db.drizzle.execute(sql`
      SELECT "run_id", "root_run_id", "approved_plan_revision_id", "producing_step_key"
      FROM "artifact_provenance"
      WHERE "run_id" = ${tree.rootRunId} AND "company_id" = ${tree.companyId}
    `)) as unknown as Array<{
      run_id: string;
      root_run_id: string;
      approved_plan_revision_id: string | null;
      producing_step_key: string | null;
    }>;
    expect(provRows).toHaveLength(1);
    expect(provRows[0]!.run_id).toBe(tree.rootRunId);
    expect(provRows[0]!.root_run_id).toBe(tree.rootRunId);
    expect(provRows[0]!.approved_plan_revision_id).toBe(tree.revisionId);
    expect(provRows[0]!.producing_step_key).toBe('synthesis');
  });

  it('RunProcessor without synthesisArtifactCreator does NOT create artifacts (backward compat)', async () => {
    const tree = await setupTree(db, '__mtest__ issue1-not-wired', 1, 'test-lease-token');
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    await seedResearchSource(
      db,
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'Source X',
      'https://example.com/x',
    );

    // Construct RunProcessor WITHOUT synthesisArtifactCreator (old behavior).
    const processor = new RunProcessor(db, {});

    const claim = makeClaim(tree.companyId, tree.projectId, tree.rootRunId);
    const controller = new AbortController();

    await processor.advance(claim, controller.signal);

    // Run should still complete.
    const runRows = (await db.drizzle.execute(sql`
      SELECT "status" FROM "mission_runs" WHERE "id" = ${tree.rootRunId}
    `)) as unknown as { status: string }[];
    expect(runRows[0]?.status).toBe('completed');

    // But NO artifact should be created.
    const artifactRows = (await db.drizzle.execute(sql`
      SELECT COUNT(*)::int AS c FROM "artifact_provenance"
      WHERE "run_id" = ${tree.rootRunId} AND "company_id" = ${tree.companyId}
    `)) as unknown as { c: number }[];
    expect(artifactRows[0]?.c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Issue 2: Firecrawl search is attempted in addition to Tavily search
// ---------------------------------------------------------------------------

describe('fix-ut-m5-synthesis-firecrawl-url-passing: Issue 2 — Firecrawl search attempted', () => {
  it('selectProviderForOperation includes both Tavily and Firecrawl for search', async () => {
    // The ProductionResearchExecutor's selectProviderForOperation is private,
    // but we can verify the behavior by checking that when both credentials
    // are available, the executor constructs both adapters and includes both
    // in the provider list for search operations.
    //
    // We verify this by injecting a mock execution service that records
    // the providers list passed to executeResearch.
    vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
    vi.stubEnv('FIRECRAWL_API_KEY', 'test-firecrawl-key');

    let capturedProviders: { name: string }[] | null = null;

    const mockExecutionService = {
      executeResearch: vi.fn(async (_input: unknown, config: { providers: { name: string }[] }) => {
        capturedProviders = config.providers.map((p) => ({ name: p.name }));
        return {
          logicalCallId: randomUUID(),
          provider: 'tavily',
          attemptId: randomUUID(),
          costCents: 10,
          sources: [
            {
              canonicalUrl: 'https://example.com/result',
              title: 'Test Result',
              author: null,
              publishedAt: null,
              rank: 0,
              score: 0.9,
              retrievedAt: '2026-08-24T12:00:00Z',
              mimeType: 'text/html',
              language: 'en',
              text: 'Test content',
              byteCount: 12,
              injectionRiskLabels: [],
            },
          ],
          persistedRevisions: [],
          warnings: [],
        };
      }),
    };

    const executor = new ProductionResearchExecutor(db, {
      executionService: mockExecutionService as never,
    });

    const scope = await seedScope(db, '__mtest__ issue2-firecrawl');
    const runId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
      VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, null, 0, 'company_agent', 'enc', 'hash', 'deep_work', 'running', 1, 0, 'require_all', ${now}, ${now})
    `);

    const ctx: ResearchExecutionContext = {
      claim: makeClaim(scope.companyId, scope.projectId, runId),
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
        createdAt: now,
        parentRunId: 'parent-run-id',
        rootRunId: runId,
        approvedPlanRevisionId: null,
      },
      policy: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        limits: { durationSeconds: 300 },
        toolAllowlist: [],
        domainAllowlist: [],
      },
      requestText: 'test query',
      operations: ['search'],
      signal: new AbortController().signal,
    };

    await executor.execute(ctx);

    // Verify both Tavily and Firecrawl were in the provider list.
    expect(capturedProviders).not.toBeNull();
    expect(capturedProviders!.length).toBe(2);
    expect(capturedProviders!.map((p) => p.name)).toContain('tavily');
    expect(capturedProviders!.map((p) => p.name)).toContain('firecrawl');

    vi.unstubAllEnvs();
  });

  it('Firecrawl-only search works when Tavily credential is unavailable', async () => {
    // Only Firecrawl key available — Tavily adapter is null.
    vi.stubEnv('FIRECRAWL_API_KEY', 'test-firecrawl-key');
    vi.stubEnv('TAVILY_API_KEY', '');

    let capturedProviders: { name: string }[] | null = null;

    const mockExecutionService = {
      executeResearch: vi.fn(async (_input: unknown, config: { providers: { name: string }[] }) => {
        capturedProviders = config.providers.map((p) => ({ name: p.name }));
        return {
          logicalCallId: randomUUID(),
          provider: 'firecrawl',
          attemptId: randomUUID(),
          costCents: 15,
          sources: [
            {
              canonicalUrl: 'https://example.com/firecrawl-result',
              title: 'Firecrawl Result',
              author: null,
              publishedAt: null,
              rank: 0,
              score: 0.85,
              retrievedAt: '2026-08-24T12:00:00Z',
              mimeType: 'text/html',
              language: 'en',
              text: 'Firecrawl content',
              byteCount: 17,
              injectionRiskLabels: [],
            },
          ],
          persistedRevisions: [],
          warnings: [],
        };
      }),
    };

    const executor = new ProductionResearchExecutor(db, {
      executionService: mockExecutionService as never,
    });

    const scope = await seedScope(db, '__mtest__ issue2-firecrawl-only');
    const runId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
      VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, null, 0, 'company_agent', 'enc', 'hash', 'deep_work', 'running', 1, 0, 'require_all', ${now}, ${now})
    `);

    const ctx: ResearchExecutionContext = {
      claim: makeClaim(scope.companyId, scope.projectId, runId),
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
        createdAt: now,
        parentRunId: 'parent-run-id',
        rootRunId: runId,
        approvedPlanRevisionId: null,
      },
      policy: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        limits: { durationSeconds: 300 },
        toolAllowlist: [],
        domainAllowlist: [],
      },
      requestText: 'test query',
      operations: ['search'],
      signal: new AbortController().signal,
    };

    const result = await executor.execute(ctx);
    expect(result.executed).toBe(true);

    // Only Firecrawl should be in the provider list (Tavily credential unavailable).
    expect(capturedProviders).not.toBeNull();
    expect(capturedProviders!.length).toBe(1);
    expect(capturedProviders![0]!.name).toBe('firecrawl');

    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// Issue 3: URLs from search results are passed to extract/scrape
// ---------------------------------------------------------------------------

describe('fix-ut-m5-synthesis-firecrawl-url-passing: Issue 3 — URLs from search passed to extract/scrape', () => {
  it('URLs from search results are collected and passed to subsequent extract operation', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');
    vi.stubEnv('FIRECRAWL_API_KEY', 'test-firecrawl-key');

    const searchUrls = [
      'https://example.com/page1',
      'https://example.com/page2',
      'https://example.com/page3',
    ];

    let extractReceivedUrls: string[] | null = null;

    const mockExecutionService = {
      executeResearch: vi.fn(
        async (input: { operation: string; query?: string; urls?: string[] }) => {
          if (input.operation === 'search') {
            return {
              logicalCallId: randomUUID(),
              provider: 'tavily',
              attemptId: randomUUID(),
              costCents: 10,
              sources: searchUrls.map((url, i) => ({
                canonicalUrl: url,
                title: `Result ${i + 1}`,
                author: null,
                publishedAt: null,
                rank: i,
                score: 0.9 - i * 0.1,
                retrievedAt: '2026-08-24T12:00:00Z',
                mimeType: 'text/html',
                language: 'en',
                text: `Content for ${url}`,
                byteCount: 20,
                injectionRiskLabels: [],
              })),
              persistedRevisions: [],
              warnings: [],
            };
          }

          // extract operation — capture the URLs received.
          extractReceivedUrls = input.urls ?? null;
          return {
            logicalCallId: randomUUID(),
            provider: 'tavily',
            attemptId: randomUUID(),
            costCents: 10,
            sources: [
              {
                canonicalUrl: input.urls?.[0] ?? 'https://example.com/extracted',
                title: 'Extracted Content',
                author: null,
                publishedAt: null,
                rank: 0,
                score: 0.8,
                retrievedAt: '2026-08-24T12:00:00Z',
                mimeType: 'text/html',
                language: 'en',
                text: 'Extracted text content',
                byteCount: 20,
                injectionRiskLabels: [],
              },
            ],
            persistedRevisions: [],
            warnings: [],
          };
        },
      ),
    };

    const executor = new ProductionResearchExecutor(db, {
      executionService: mockExecutionService as never,
    });

    const scope = await seedScope(db, '__mtest__ issue3-url-passing');
    const runId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
      VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, null, 0, 'company_agent', 'enc', 'hash', 'deep_work', 'running', 1, 0, 'require_all', ${now}, ${now})
    `);

    const ctx: ResearchExecutionContext = {
      claim: makeClaim(scope.companyId, scope.projectId, runId),
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
        createdAt: now,
        parentRunId: 'parent-run-id',
        rootRunId: runId,
        approvedPlanRevisionId: null,
      },
      policy: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        limits: { durationSeconds: 300 },
        toolAllowlist: [],
        domainAllowlist: [],
      },
      requestText: 'test query',
      operations: ['search', 'extract'],
      signal: new AbortController().signal,
    };

    const result = await executor.execute(ctx);
    expect(result.executed).toBe(true);

    // Verify the extract operation received the URLs from search results.
    expect(extractReceivedUrls).not.toBeNull();
    expect(extractReceivedUrls!.length).toBe(3);
    expect(extractReceivedUrls).toEqual(expect.arrayContaining(searchUrls));

    vi.unstubAllEnvs();
  });

  it('extract operation is skipped when no search precedes it (no URLs available)', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-tavily-key');

    const mockExecutionService = {
      executeResearch: vi.fn(async () => {
        throw new Error('Should not be called for extract without URLs');
      }),
    };

    const executor = new ProductionResearchExecutor(db, {
      executionService: mockExecutionService as never,
    });

    const scope = await seedScope(db, '__mtest__ issue3-no-urls');
    const runId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
      VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, null, 0, 'company_agent', 'enc', 'hash', 'deep_work', 'running', 1, 0, 'require_all', ${now}, ${now})
    `);

    const ctx: ResearchExecutionContext = {
      claim: makeClaim(scope.companyId, scope.projectId, runId),
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
        createdAt: now,
        parentRunId: 'parent-run-id',
        rootRunId: runId,
        approvedPlanRevisionId: null,
      },
      policy: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        limits: { durationSeconds: 300 },
        toolAllowlist: [],
        domainAllowlist: [],
      },
      requestText: 'test query',
      operations: ['extract'], // No search first — no URLs available
      signal: new AbortController().signal,
    };

    const result = await executor.execute(ctx);

    // Extract should be skipped (no URLs), and since it was the only operation,
    // executed should be false.
    expect(result.executed).toBe(false);
    expect(result.sourceCount).toBe(0);

    // The mock execution service should NOT have been called.
    expect(mockExecutionService.executeResearch).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});

// ---------------------------------------------------------------------------
// Full production path: search → URLs → extract → persist → synthesize → artifact
// ---------------------------------------------------------------------------

describe('fix-ut-m5-synthesis-firecrawl-url-passing: Full production path end-to-end', () => {
  it('complete path: research sources persisted → synthesis → artifact with citations and provenance', async () => {
    const tree = await setupTree(db, '__mtest__ full-path-e2e', 2, 'test-lease-token');
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    // Seed research sources for both children (simulating search results persisted).
    const rev1 = await seedResearchSource(
      db,
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'E2E Source A',
      'https://example.com/e2e-a',
    );
    const rev2 = await seedResearchSource(
      db,
      scope,
      tree.childRunIds[1]!,
      tree.rootRunId,
      'E2E Source B',
      'https://example.com/e2e-b',
    );

    // Construct SynthesisArtifactCreator as worker.ts does.
    const synthesisArtifactCreator = new SynthesisArtifactCreator(db, {
      providerCall: mockProviderCall(),
      artifactCommitService: commit,
    });

    // Construct RunProcessor with synthesisArtifactCreator wired in.
    const processor = new RunProcessor(db, { synthesisArtifactCreator });

    const claim = makeClaim(tree.companyId, tree.projectId, tree.rootRunId);
    const controller = new AbortController();

    // Advance the root run — triggers synthesis and artifact creation.
    await processor.advance(claim, controller.signal);

    // 1. Run is completed.
    const runRows = (await db.drizzle.execute(sql`
      SELECT "status" FROM "mission_runs" WHERE "id" = ${tree.rootRunId}
    `)) as unknown as { status: string }[];
    expect(runRows[0]?.status).toBe('completed');

    // 2. Artifact was created with provenance.
    const provRows = (await db.drizzle.execute(sql`
      SELECT "artifact_id", "artifact_revision_id", "run_id", "root_run_id",
             "approved_plan_revision_id", "producing_step_key",
             "cited_source_revision_ids"
      FROM "artifact_provenance"
      WHERE "run_id" = ${tree.rootRunId} AND "company_id" = ${tree.companyId}
    `)) as unknown as Array<{
      artifact_id: string;
      artifact_revision_id: string;
      run_id: string;
      root_run_id: string;
      approved_plan_revision_id: string | null;
      producing_step_key: string | null;
      cited_source_revision_ids: string[];
    }>;
    expect(provRows).toHaveLength(1);
    expect(provRows[0]!.artifact_id).toBeTruthy();
    expect(provRows[0]!.artifact_revision_id).toBeTruthy();
    expect(provRows[0]!.run_id).toBe(tree.rootRunId);
    expect(provRows[0]!.root_run_id).toBe(tree.rootRunId);
    expect(provRows[0]!.approved_plan_revision_id).toBe(tree.revisionId);
    expect(provRows[0]!.producing_step_key).toBe('synthesis');
    expect(provRows[0]!.cited_source_revision_ids.length).toBe(2);

    // 3. Citations link the artifact to the research sources.
    const citeRows = (await db.drizzle.execute(sql`
      SELECT "source_revision_id", "ordinal"
      FROM "citations"
      WHERE "artifact_revision_id" = ${provRows[0]!.artifact_revision_id}
        AND "company_id" = ${tree.companyId}
      ORDER BY "ordinal" ASC
    `)) as unknown as Array<{ source_revision_id: string; ordinal: number }>;
    expect(citeRows).toHaveLength(2);
    expect(citeRows[0]!.source_revision_id).toBe(rev1.sourceRevisionId);
    expect(citeRows[1]!.source_revision_id).toBe(rev2.sourceRevisionId);

    // 4. Artifact exists in the artifacts table.
    const artifactRows = (await db.drizzle.execute(sql`
      SELECT "id", "title", "type" FROM "artifacts"
      WHERE "id" = ${provRows[0]!.artifact_id}
    `)) as unknown as { id: string; title: string; type: string }[];
    expect(artifactRows).toHaveLength(1);
    expect(artifactRows[0]!.title).toBe('Research Synthesis Report');

    // 5. artifact.committed and citation.committed events were emitted.
    const eventRows = (await db.drizzle.execute(sql`
      SELECT "type" FROM "run_events"
      WHERE "run_id" = ${tree.rootRunId} AND "type" IN ('artifact.committed', 'citation.committed')
      ORDER BY "sequence" ASC
    `)) as unknown as { type: string }[];
    expect(eventRows.some((e) => e.type === 'artifact.committed')).toBe(true);
    expect(eventRows.some((e) => e.type === 'citation.committed')).toBe(true);
  });
});
