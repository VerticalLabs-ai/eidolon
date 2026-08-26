import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { SynthesisArtifactCreator } from '../services/mission/synthesis-artifact-creator.js';
import { ArtifactCommitService } from '../services/mission/research/artifact-commit-service.js';
import { CitationService } from '../services/mission/research/citation-service.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { createCitationIdentity } from '../services/mission/research/citation-identity.js';
import type { ChatMessage, CompletionResult, ProviderConfig } from '../providers/types.js';

/**
 * Regression tests for fix-ut-m5-citation-quote-validation.
 *
 * Bug: ArtifactCommitService rejects all citations with QUOTE_NOT_FOUND
 * because the quote (source title or URL) does not appear verbatim in the
 * normalized source text. The LLM-generated synthesis references sources by
 * number/URL, but citation records were created with a quote field that
 * must match source text exactly (SHA-256 quote hash validation).
 *
 * Fix: Citations are created from source metadata (source revision ID,
 * title, URL, provider) without requiring a verbatim quote match. The
 * quote field is optional in the citation creation path.
 *
 * Tests:
 *  (a) citations created from source metadata without requiring exact quotes
 *  (b) artifact committed with citations and provenance
 *  (c) createCitationIdentity accepts optional quote (metadata-only citation)
 *  (d) existing quote-based citations still work (backward compatible)
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let sources: SourceRevisionService;
let commit: ArtifactCommitService;
let citations: CitationService;

beforeAll(async () => {
  db = await createTestDb();
  sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
  commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
  citations = new CitationService({ drizzle: db.drizzle, schema: db.schema });
});

afterAll(async () => {
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Seed helpers (mirrors mission-synthesis-artifact-wiring.test.ts)
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
): Promise<string> {
  const runId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "routing_kind", "request_envelope", "request_content_hash", "resolved_mode", "policy_snapshot_id", "status", "state_version", "last_event_sequence", "partial_result_policy", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', 'encrypted', ${randomUUID()}, 'deep_work', ${policySnapshotId}, 'running', 1, 0, 'require_all', ${now}, ${now})
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

async function setupTree(
  db: AnyDb,
  label: string,
  childCount: number,
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
  );
  const { revisionId, contentHash } = await insertPlanRevision(
    db,
    scope.companyId,
    scope.projectId,
    rootRunId,
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

async function seedResearchSource(
  db: AnyDb,
  scope: { companyId: string; projectId: string },
  childRunId: string,
  rootRunId: string,
  title: string,
  url: string,
): Promise<{
  sourceRevisionId: string;
  canonicalUrl: string;
  retrievedAt: string;
  contentHash: string | null;
}> {
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
    retrievedAt: persisted.retrievedAt,
    contentHash: persisted.contentHash ?? null,
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

async function countRows(table: string, where: string): Promise<number> {
  const rows = (await db.drizzle.execute(
    sql.raw(`SELECT count(*)::int AS c FROM "${table}" WHERE ${where}`),
  )) as unknown as { c: number }[];
  return rows[0]?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fix-ut-m5-citation-quote-validation: metadata-only citations without exact quotes', () => {
  it('createCitationIdentity accepts undefined quote (metadata-only citation)', () => {
    const identity = createCitationIdentity({
      companyId: 'comp-1',
      projectId: 'proj-1',
      runId: 'run-1',
      sourceRevisionId: 'src-rev-1',
      artifactId: 'art-1',
      artifactRevisionId: 'art-rev-1',
      ordinal: 1,
      // No quote field — metadata-only citation
      frozenCanonicalUrl: 'https://example.com/article',
      frozenRetrievedAt: '2026-08-24T12:00:00Z',
      frozenProvider: 'tavily',
    });

    expect(identity.sourceRevisionId).toBe('src-rev-1');
    expect(identity.artifactRevisionId).toBe('art-rev-1');
    expect(identity.ordinal).toBe(1);
    expect(identity.quote).toBe('');
    expect(identity.quoteHash).toBeTruthy();
    expect(identity.quoteHash.length).toBe(64);
    expect(identity.charStart).toBeUndefined();
    expect(identity.charEnd).toBeUndefined();
    expect(identity.frozenCanonicalUrl).toBe('https://example.com/article');
    expect(identity.frozenProvider).toBe('tavily');
  });

  it('createCitationIdentity accepts empty string quote (metadata-only citation)', () => {
    const identity = createCitationIdentity({
      companyId: 'comp-1',
      projectId: 'proj-1',
      runId: 'run-1',
      sourceRevisionId: 'src-rev-1',
      artifactId: 'art-1',
      artifactRevisionId: 'art-rev-1',
      ordinal: 1,
      quote: '',
      frozenCanonicalUrl: 'https://example.com/article',
      frozenRetrievedAt: '2026-08-24T12:00:00Z',
      frozenProvider: 'tavily',
    });

    expect(identity.quote).toBe('');
    expect(identity.quoteHash).toBeTruthy();
    expect(identity.quoteHash.length).toBe(64);
  });

  it('createCitationIdentity still validates quotes when provided (backward compatible)', () => {
    const identity = createCitationIdentity({
      companyId: 'comp-1',
      projectId: 'proj-1',
      runId: 'run-1',
      sourceRevisionId: 'src-rev-1',
      artifactId: 'art-1',
      artifactRevisionId: 'art-rev-1',
      ordinal: 1,
      quote: 'beta',
      normalizedSourceText: 'alpha beta gamma',
      frozenCanonicalUrl: 'https://example.com/article',
      frozenRetrievedAt: '2026-08-24T12:00:00Z',
      frozenProvider: 'tavily',
    });

    expect(identity.quote).toBe('beta');
    expect(identity.charStart).toBe(6);
    expect(identity.charEnd).toBe(10);
  });

  it('createCitationIdentity still rejects QUOTE_NOT_FOUND when quote is provided but not in source', () => {
    expect(() =>
      createCitationIdentity({
        companyId: 'comp-1',
        projectId: 'proj-1',
        runId: 'run-1',
        sourceRevisionId: 'src-rev-1',
        artifactId: 'art-1',
        artifactRevisionId: 'art-rev-1',
        ordinal: 1,
        quote: 'nonexistent text',
        normalizedSourceText: 'alpha beta gamma',
        frozenCanonicalUrl: 'https://example.com/article',
        frozenRetrievedAt: '2026-08-24T12:00:00Z',
        frozenProvider: 'tavily',
      }),
    ).toThrow(/QUOTE_NOT_FOUND/);
  });
});

describe('fix-ut-m5-citation-quote-validation: synthesis creates citations from source metadata', () => {
  it('citations created from source metadata without requiring exact quotes', async () => {
    const tree = await setupTree(db, '__mtest__ cite-metadata-only', 1);
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    // Seed a research source whose title does NOT appear in the source text.
    // The old code used the title as the quote, which caused QUOTE_NOT_FOUND.
    const rev = await seedResearchSource(
      db,
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'Metadata Title Not In Text',
      'https://example.com/metadata-only',
    );

    // Create artifact with citations using the synthesis artifact creator.
    // The creator now omits the quote field, so citations are metadata-only.
    const creator = new SynthesisArtifactCreator(db, {
      providerCall: mockProviderCall(),
      artifactCommitService: commit,
    });

    const result = await creator.createSynthesisArtifact({
      companyId: tree.companyId,
      projectId: tree.projectId,
      runId: tree.rootRunId,
      rootRunId: tree.rootRunId,
      approvedPlanRevisionId: tree.revisionId,
      approvedContentHash: tree.contentHash,
      policySnapshotId: tree.policyId,
    });

    expect(result).not.toBeNull();
    expect(result!.citationIds.length).toBe(1);

    // Verify the citation row has an empty quote but valid frozen metadata.
    const citeRows = (await db.drizzle.execute(sql`
      SELECT "source_revision_id", "ordinal", "quote_hash",
             "frozen_canonical_url", "frozen_provider", "char_start", "char_end"
      FROM "citations"
      WHERE "artifact_revision_id" = ${result!.artifactRevisionId}
      ORDER BY "ordinal" ASC
    `)) as unknown as Array<{
      source_revision_id: string;
      ordinal: number;
      quote_hash: string;
      frozen_canonical_url: string;
      frozen_provider: string;
      char_start: number | null;
      char_end: number | null;
    }>;

    expect(citeRows).toHaveLength(1);
    expect(citeRows[0].source_revision_id).toBe(rev.sourceRevisionId);
    expect(citeRows[0].frozen_canonical_url).toBe('https://example.com/metadata-only');
    expect(citeRows[0].frozen_provider).toBe('tavily');
    // No char offsets for metadata-only citations.
    expect(citeRows[0].char_start).toBeNull();
    expect(citeRows[0].char_end).toBeNull();
    // Quote hash is still present (SHA-256 of empty string).
    expect(citeRows[0].quote_hash.length).toBe(64);
  });

  it('artifact committed with citations and provenance after synthesis', async () => {
    const tree = await setupTree(db, '__mtest__ cite-prov-commit', 2);
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    // Seed 2 research sources with titles that don't appear in source text.
    await seedResearchSource(
      db,
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'First Source Title',
      'https://example.com/first',
    );
    await seedResearchSource(
      db,
      scope,
      tree.childRunIds[1]!,
      tree.rootRunId,
      'Second Source Title',
      'https://example.com/second',
    );

    const creator = new SynthesisArtifactCreator(db, {
      providerCall: mockProviderCall(),
      artifactCommitService: commit,
    });

    const result = await creator.createSynthesisArtifact({
      companyId: tree.companyId,
      projectId: tree.projectId,
      runId: tree.rootRunId,
      rootRunId: tree.rootRunId,
      approvedPlanRevisionId: tree.revisionId,
      approvedContentHash: tree.contentHash,
      policySnapshotId: tree.policyId,
    });

    expect(result).not.toBeNull();
    expect(result!.artifactId).toBeTruthy();
    expect(result!.artifactRevisionId).toBeTruthy();
    expect(result!.citationIds.length).toBe(2);
    expect(result!.provenanceId).toBeTruthy();

    // Verify artifact_provenance row was created.
    const provCount = await countRows(
      'artifact_provenance',
      `artifact_revision_id = '${result!.artifactRevisionId}'`,
    );
    expect(provCount).toBe(1);

    // Verify provenance binds to the run and plan.
    const provRows = (await db.drizzle.execute(sql`
      SELECT "run_id", "root_run_id", "approved_plan_revision_id",
             "approved_plan_hash", "producing_step_key", "cited_source_revision_ids"
      FROM "artifact_provenance"
      WHERE "artifact_revision_id" = ${result!.artifactRevisionId}
    `)) as unknown as Array<{
      run_id: string;
      root_run_id: string;
      approved_plan_revision_id: string | null;
      approved_plan_hash: string | null;
      producing_step_key: string | null;
      cited_source_revision_ids: string[];
    }>;

    expect(provRows).toHaveLength(1);
    expect(provRows[0].run_id).toBe(tree.rootRunId);
    expect(provRows[0].root_run_id).toBe(tree.rootRunId);
    expect(provRows[0].approved_plan_revision_id).toBe(tree.revisionId);
    expect(provRows[0].approved_plan_hash).toBe(tree.contentHash);
    expect(provRows[0].producing_step_key).toBe('synthesis');
    expect(provRows[0].cited_source_revision_ids.length).toBe(2);

    // Verify both citations exist.
    const citeCount = await countRows(
      'citations',
      `artifact_revision_id = '${result!.artifactRevisionId}'`,
    );
    expect(citeCount).toBe(2);
  });

  it('uses fallback content when LLM call fails and still creates metadata-only citations', async () => {
    const tree = await setupTree(db, '__mtest__ cite-fallback', 1);
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    await seedResearchSource(
      db,
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'Fallback Source',
      'https://example.com/fallback',
    );

    const failingProviderCall = vi.fn(async () => {
      throw new Error('LLM call failed');
    });

    const creator = new SynthesisArtifactCreator(db, {
      providerCall: failingProviderCall,
      artifactCommitService: commit,
    });

    const result = await creator.createSynthesisArtifact({
      companyId: tree.companyId,
      projectId: tree.projectId,
      runId: tree.rootRunId,
      rootRunId: tree.rootRunId,
      approvedPlanRevisionId: tree.revisionId,
      approvedContentHash: tree.contentHash,
      policySnapshotId: tree.policyId,
    });

    // Artifact is still created with fallback content and metadata-only citations.
    expect(result).not.toBeNull();
    expect(result!.artifactRevisionId).toBeTruthy();
    expect(result!.citationIds.length).toBe(1);
    expect(result!.provenanceId).toBeTruthy();
  });
});

describe('fix-ut-m5-citation-quote-validation: CitationService.persistCitation with optional quote', () => {
  it('persists a metadata-only citation without a quote', async () => {
    const scope = await seedScope(db, '__mtest__ cite-service-no-quote');
    const runId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id","company_id","project_id","project_thread_id","root_run_id","parent_run_id","depth","routing_kind","request_envelope","request_content_hash","request_safe_summary","resolved_mode","policy_snapshot_id","status","state_version","last_event_sequence","partial_result_policy","available_at","created_at","updated_at")
      VALUES (${runId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${runId}, null, 0, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'summary', 'deep_work', null, 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
    `);

    const artifactId = randomUUID();
    const revisionId = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id","company_id","project_id","type","title","content","version","created_at","updated_at")
      VALUES (${artifactId}, ${scope.companyId}, ${scope.projectId}, 'document', 'Doc', '{}'::jsonb, 1, ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "artifact_revisions" ("id","artifact_id","version","content","edit_source","created_at")
      VALUES (${revisionId}, ${artifactId}, 1, '{}'::jsonb, 'agent', ${now})
    `);

    const source = {
      canonicalUrl: 'https://example.com/no-quote-source',
      title: 'No Quote Source',
      author: 'Author',
      publishedAt: '2026-08-24T00:00:00Z',
      rank: 0,
      score: 0.9,
      retrievedAt: '2026-08-24T12:00:00Z',
      mimeType: 'text/html',
      language: 'en',
      text: 'Some content that does not contain the title.',
      byteCount: 50,
      injectionRiskLabels: [] as never[],
    };

    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId,
      rootRunId: runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });

    // Persist citation without a quote field.
    const citationId = await citations.persistCitation({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId,
      sourceRevisionId: persisted.sourceRevisionId,
      artifactId,
      artifactRevisionId: revisionId,
      ordinal: 1,
      // No quote field — metadata-only citation
      frozenCanonicalUrl: 'https://example.com/no-quote-source',
      frozenRetrievedAt: '2026-08-24T12:00:00Z',
      frozenProvider: 'tavily',
    });

    expect(citationId).toBeTruthy();

    // Verify the citation row.
    const rows = (await db.drizzle.execute(sql`
      SELECT "quote_hash", "char_start", "char_end", "frozen_canonical_url"
      FROM "citations" WHERE "id" = ${citationId}
    `)) as unknown as Array<{
      quote_hash: string;
      char_start: number | null;
      char_end: number | null;
      frozen_canonical_url: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].quote_hash.length).toBe(64);
    expect(rows[0].char_start).toBeNull();
    expect(rows[0].char_end).toBeNull();
    expect(rows[0].frozen_canonical_url).toBe('https://example.com/no-quote-source');
  });
});
