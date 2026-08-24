import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { CitationService } from '../services/mission/research/citation-service.js';
import { freezeDisplayMetadata } from '../services/mission/research/frozen-metadata.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Historical provenance freezes display metadata (VAL-RES-113) and citations
 * bind to the exact immutable source revision (VAL-RES-097). A later
 * re-retrieval with different metadata does not rewrite a historical
 * citation's frozen display metadata.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let sources: SourceRevisionService;
let citations: CitationService;

beforeAll(async () => {
  db = await createTestDb();
  sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
  citations = new CitationService({ drizzle: db.drizzle, schema: db.schema });
});

afterAll(async () => {
  await closeTestDb();
});

async function seedScope(db: AnyDb, label: string) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const threadId = randomUUID();
  const runId = randomUUID();
  const now = new Date();
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
    INSERT INTO "mission_runs" ("id","company_id","project_id","project_thread_id","root_run_id","parent_run_id","depth","routing_kind","request_envelope","request_content_hash","request_safe_summary","resolved_mode","policy_snapshot_id","status","state_version","last_event_sequence","partial_result_policy","available_at","created_at","updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'summary', 'deep_work', null, 'queued', 1, 0, 'require_all', ${now}, ${now}, ${now})
  `);
  return { companyId, projectId, threadId, runId };
}

async function seedArtifact(db: AnyDb, companyId: string, projectId: string) {
  const artifactId = randomUUID();
  const revisionId = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "artifacts" ("id","company_id","project_id","type","title","content","version","created_at","updated_at")
    VALUES (${artifactId}, ${companyId}, ${projectId}, 'document', 'Cited Doc', '{}'::jsonb, 1, ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "artifact_revisions" ("id","artifact_id","version","content","edit_source","created_at")
    VALUES (${revisionId}, ${artifactId}, 1, '{}'::jsonb, 'agent', ${now})
  `);
  return { artifactId, revisionId };
}

function makeSource(overrides: Partial<NormalizedResearchSource> = {}): NormalizedResearchSource {
  return {
    canonicalUrl: 'https://example.com/frozen-article',
    title: 'Original Title',
    author: 'Jane Doe',
    publishedAt: '2026-08-24T00:00:00Z',
    rank: 0,
    score: 0.9,
    retrievedAt: '2026-08-24T12:00:00Z',
    mimeType: 'text/html',
    language: 'en',
    text: 'The quick brown fox jumps over the lazy dog.',
    byteCount: 44,
    injectionRiskLabels: [],
    ...overrides,
  };
}

describe('freezeDisplayMetadata (VAL-RES-113)', () => {
  it('captures a bounded frozen snapshot with a version and timestamp', () => {
    const f = freezeDisplayMetadata({
      title: 'Title',
      author: 'Author',
      canonicalUrl: 'https://example.com/a',
      retrievedAt: '2026-08-24T12:00:00Z',
      provider: 'tavily',
      contentHash: 'abc',
    });
    expect(f.title).toBe('Title');
    expect(f.canonicalUrl).toBe('https://example.com/a');
    expect(f.provider).toBe('tavily');
    expect(f.frozenAt).toBeTruthy();
  });

  it('drops non-string and overlong fields', () => {
    const f = freezeDisplayMetadata({
      title: 'x'.repeat(1000),
      author: null,
      canonicalUrl: 'https://example.com/a',
      retrievedAt: '2026-08-24T12:00:00Z',
      provider: 'tavily',
    });
    expect((f.title ?? '').length).toBeLessThanOrEqual(500);
    expect(f.author).toBeUndefined();
  });
});

describe('CitationService: frozen historical metadata (VAL-RES-097, VAL-RES-113)', () => {
  it('binds a citation to the exact source revision and freezes display metadata', async () => {
    const scope = await seedScope(db, '__mtest__ cite-frozen');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const source = makeSource({ text: 'The quick brown fox jumps.' });
    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });
    const citationId = await citations.persistCitation({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      sourceRevisionId: persisted.sourceRevisionId,
      artifactId: art.artifactId,
      artifactRevisionId: art.revisionId,
      ordinal: 1,
      quote: 'The quick brown fox jumps.',
      frozenTitle: 'Original Title',
      frozenAuthor: 'Jane Doe',
      frozenCanonicalUrl: source.canonicalUrl,
      frozenRetrievedAt: source.retrievedAt,
      frozenProvider: 'tavily',
      frozenContentHash: persisted.contentHash,
    });
    expect(citationId).toBeTruthy();

    const frozen = await citations.getFrozenMetadata(scope.companyId, scope.projectId, citationId);
    expect(frozen).not.toBeNull();
    expect(frozen?.title).toBe('Original Title');
    expect(frozen?.author).toBe('Jane Doe');
    expect(frozen?.canonicalUrl).toBe('https://example.com/frozen-article');
    expect(frozen?.provider).toBe('tavily');
  });

  it('historical frozen metadata does not change after a newer revision with different metadata (VAL-RES-113)', async () => {
    const scope = await seedScope(db, '__mtest__ cite-historical');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const source = makeSource({ text: 'first passage content', title: 'Original Title' });
    const rev1 = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });
    const citationId = await citations.persistCitation({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      sourceRevisionId: rev1.sourceRevisionId,
      artifactId: art.artifactId,
      artifactRevisionId: art.revisionId,
      ordinal: 1,
      quote: 'first passage content',
      frozenTitle: 'Original Title',
      frozenCanonicalUrl: source.canonicalUrl,
      frozenRetrievedAt: source.retrievedAt,
      frozenProvider: 'tavily',
      frozenContentHash: rev1.contentHash,
    });

    // A later re-retrieval of the same URL produces a NEW revision with a
    // different title and content. The citation must NOT retarget it.
    const rev2 = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'second passage content', title: 'Updated Title' }),
    });
    expect(rev2.sourceId).toBe(rev1.sourceId);
    expect(rev2.sourceRevisionId).not.toBe(rev1.sourceRevisionId);

    const frozen = await citations.getFrozenMetadata(scope.companyId, scope.projectId, citationId);
    expect(frozen?.title).toBe('Original Title');
    expect(frozen?.title).not.toBe('Updated Title');
    // The citation is still bound to the original revision.
    const cited = await citations.getCitation(scope.companyId, scope.projectId, citationId);
    expect(cited?.sourceRevisionId).toBe(rev1.sourceRevisionId);
    expect(cited?.sourceRevisionId).not.toBe(rev2.sourceRevisionId);
  });

  it('rejects an ambiguous repeated quote without a locator (VAL-RES-097)', async () => {
    const scope = await seedScope(db, '__mtest__ cite-ambiguous');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const text = 'alpha beta alpha gamma';
    const source = makeSource({ text });
    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });
    await expect(
      citations.persistCitation({
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: scope.runId,
        sourceRevisionId: persisted.sourceRevisionId,
        artifactId: art.artifactId,
        artifactRevisionId: art.revisionId,
        ordinal: 1,
        quote: 'alpha',
        normalizedSourceText: text,
        frozenCanonicalUrl: source.canonicalUrl,
        frozenRetrievedAt: source.retrievedAt,
        frozenProvider: 'tavily',
      }),
    ).rejects.toThrow(/AMBIGUOUS/);
  });

  it('accepts a repeated quote with a disambiguating locator (VAL-RES-097)', async () => {
    const scope = await seedScope(db, '__mtest__ cite-locator');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const text = 'alpha beta alpha gamma';
    const source = makeSource({ text });
    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });
    const citationId = await citations.persistCitation({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      sourceRevisionId: persisted.sourceRevisionId,
      artifactId: art.artifactId,
      artifactRevisionId: art.revisionId,
      ordinal: 1,
      quote: 'alpha',
      locator: { charStart: 0, charEnd: 5 },
      normalizedSourceText: text,
      frozenCanonicalUrl: source.canonicalUrl,
      frozenRetrievedAt: source.retrievedAt,
      frozenProvider: 'tavily',
    });
    const cited = await citations.getCitation(scope.companyId, scope.projectId, citationId);
    expect(cited?.charStart).toBe(0);
    expect(cited?.charEnd).toBe(5);
  });

  it('returns null for a cross-scope citation read (VAL-RES-022)', async () => {
    const scopeA = await seedScope(db, '__mtest__ cite-scope-a');
    const scopeB = await seedScope(db, '__mtest__ cite-scope-b');
    const art = await seedArtifact(db, scopeA.companyId, scopeA.projectId);
    const source = makeSource({ text: 'unique passage here' });
    const persisted = await sources.persistSourceRevision({
      companyId: scopeA.companyId,
      projectId: scopeA.projectId,
      runId: scopeA.runId,
      rootRunId: scopeA.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });
    const citationId = await citations.persistCitation({
      companyId: scopeA.companyId,
      projectId: scopeA.projectId,
      runId: scopeA.runId,
      sourceRevisionId: persisted.sourceRevisionId,
      artifactId: art.artifactId,
      artifactRevisionId: art.revisionId,
      ordinal: 1,
      quote: 'unique passage here',
      frozenCanonicalUrl: source.canonicalUrl,
      frozenRetrievedAt: source.retrievedAt,
      frozenProvider: 'tavily',
    });
    const foreign = await citations.getCitation(scopeB.companyId, scopeB.projectId, citationId);
    expect(foreign).toBeNull();
  });

  it('rejects persisting a citation that binds to a foreign-company source revision (VAL-RES-022)', async () => {
    const scopeA = await seedScope(db, '__mtest__ cite-foreign-src-a');
    const scopeB = await seedScope(db, '__mtest__ cite-foreign-src-b');
    const artB = await seedArtifact(db, scopeB.companyId, scopeB.projectId);
    const source = makeSource({ text: 'unique foreign source text' });
    // Source revision belongs to company A.
    const persistedA = await sources.persistSourceRevision({
      companyId: scopeA.companyId,
      projectId: scopeA.projectId,
      runId: scopeA.runId,
      rootRunId: scopeA.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });
    // Company B attempts to cite company A's source revision → rejected.
    await expect(
      citations.persistCitation({
        companyId: scopeB.companyId,
        projectId: scopeB.projectId,
        runId: scopeB.runId,
        sourceRevisionId: persistedA.sourceRevisionId,
        artifactId: artB.artifactId,
        artifactRevisionId: artB.revisionId,
        ordinal: 1,
        quote: 'unique foreign source text',
        normalizedSourceText: 'unique foreign source text',
        frozenCanonicalUrl: source.canonicalUrl,
        frozenRetrievedAt: source.retrievedAt,
        frozenProvider: 'tavily',
      }),
    ).rejects.toThrow(/not found in scope/);
  });
});
