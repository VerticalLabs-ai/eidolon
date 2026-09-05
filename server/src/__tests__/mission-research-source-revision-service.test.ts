import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import {
  SourceRevisionService,
  type PersistSourceRevisionInput,
} from '../services/mission/research/source-revision-service.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';
import {
  computeCanonicalUrlHash,
  computeContentHash,
  SOURCE_NORMALIZATION_VERSION,
} from '../services/mission/research/source-normalization.js';

/**
 * Tenant-local dedup, content-hash dedup, changed-source-revision versioning,
 * bounded source summaries, and frozen historical metadata.
 *
 * VAL-RES-019: canonical URL deduplication.
 * VAL-RES-020: content-hash deduplication.
 * VAL-RES-021: changed source revision.
 * VAL-RES-022: tenant-local deduplication (no cross-company dedup).
 * VAL-RES-098: source metadata is normalized and bounded.
 * VAL-RES-112: source normalization is versioned and deterministic.
 * VAL-RES-113: historical provenance freezes display metadata.
 * VAL-CROSS-034: the source API is bounded (summaries only, scoped).
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let service: SourceRevisionService;

beforeAll(async () => {
  db = await createTestDb();
  service = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
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

function makeSource(overrides: Partial<NormalizedResearchSource> = {}): NormalizedResearchSource {
  return {
    canonicalUrl: 'https://example.com/article',
    title: 'Article',
    author: 'Jane Doe',
    publishedAt: '2026-08-24T00:00:00Z',
    rank: 0,
    score: 0.9,
    retrievedAt: '2026-08-24T12:00:00Z',
    mimeType: 'text/html',
    language: 'en',
    text: 'The quick brown fox.',
    byteCount: 20,
    injectionRiskLabels: [],
    ...overrides,
  };
}

function makeInput(
  scope: { companyId: string; projectId: string; runId: string },
  source: NormalizedResearchSource,
  overrides: Partial<PersistSourceRevisionInput> = {},
): PersistSourceRevisionInput {
  return {
    companyId: scope.companyId,
    projectId: scope.projectId,
    runId: scope.runId,
    rootRunId: scope.runId,
    logicalCallId: randomUUID(),
    provider: 'tavily',
    operation: 'search',
    source,
    rank: source.rank,
    relevanceScore: source.score,
    ...overrides,
  };
}

async function countRows(db: AnyDb, table: string, where: string): Promise<number> {
  const res = await db.drizzle.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.raw(where)}`,
  );
  const rows = res as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------

describe('SourceRevisionService: canonical URL dedup (VAL-RES-019)', () => {
  it('reuses one source identity for the same canonical URL within a company', async () => {
    const scope = await seedScope(db, '__mtest__ url-dedup');
    const source = makeSource();
    const a = await service.persistSourceRevision(makeInput(scope, source));
    const b = await service.persistSourceRevision(
      makeInput(scope, source, { logicalCallId: randomUUID() }),
    );
    expect(a.sourceId).toBe(b.sourceId);
    expect(a.createdNewSource).toBe(true);
    expect(b.createdNewSource).toBe(false);
    const n = await countRows(db, 'research_sources', `"company_id" = '${scope.companyId}'`);
    expect(n).toBe(1);
  });
});

describe('SourceRevisionService: content-hash dedup (VAL-RES-020)', () => {
  it('reuses an existing immutable revision for unchanged content', async () => {
    const scope = await seedScope(db, '__mtest__ content-dedup');
    const source = makeSource();
    const a = await service.persistSourceRevision(makeInput(scope, source));
    const b = await service.persistSourceRevision(
      makeInput(scope, source, { logicalCallId: randomUUID() }),
    );
    expect(a.sourceRevisionId).toBe(b.sourceRevisionId);
    expect(a.createdNewRevision).toBe(true);
    expect(b.createdNewRevision).toBe(false);
    const n = await countRows(db, 'research_source_revisions', `"source_id" = '${a.sourceId}'`);
    expect(n).toBe(1);
  });
});

describe('SourceRevisionService: changed source revision (VAL-RES-021, VAL-RES-112)', () => {
  it('creates a new immutable revision when content changes', async () => {
    const scope = await seedScope(db, '__mtest__ changed-revision');
    const a = await service.persistSourceRevision(
      makeInput(scope, makeSource({ text: 'first content' })),
    );
    const b = await service.persistSourceRevision(
      makeInput(scope, makeSource({ text: 'second content' }), { logicalCallId: randomUUID() }),
    );
    expect(a.sourceId).toBe(b.sourceId);
    expect(a.sourceRevisionId).not.toBe(b.sourceRevisionId);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(b.createdNewRevision).toBe(true);
    const n = await countRows(db, 'research_source_revisions', `"source_id" = '${a.sourceId}'`);
    expect(n).toBe(2);
  });

  it('stores the normalization version on each revision (VAL-RES-112)', async () => {
    const scope = await seedScope(db, '__mtest__ norm-version');
    const a = await service.persistSourceRevision(makeInput(scope, makeSource()));
    expect(a.normalizationVersion).toBe(SOURCE_NORMALIZATION_VERSION);
  });
});

describe('SourceRevisionService: tenant-local dedup (VAL-RES-022)', () => {
  it('does not dedup across companies — same URL in two companies yields two sources', async () => {
    const scopeA = await seedScope(db, '__mtest__ tenant-a');
    const scopeB = await seedScope(db, '__mtest__ tenant-b');
    const url = 'https://example.com/tenant-local-unique';
    const source = makeSource({ canonicalUrl: url });
    const a = await service.persistSourceRevision(makeInput(scopeA, source));
    const b = await service.persistSourceRevision(makeInput(scopeB, source));
    expect(a.sourceId).not.toBe(b.sourceId);
    // Same canonical URL hash, but separate company-scoped rows.
    const hash = computeCanonicalUrlHash(url);
    const rowA = (await db.drizzle.execute(
      sql`SELECT "canonical_url_hash" FROM "research_sources" WHERE "id" = ${a.sourceId}`,
    )) as unknown as { canonical_url_hash: string }[];
    const rowB = (await db.drizzle.execute(
      sql`SELECT "canonical_url_hash" FROM "research_sources" WHERE "id" = ${b.sourceId}`,
    )) as unknown as { canonical_url_hash: string }[];
    expect(rowA[0].canonical_url_hash).toBe(hash);
    expect(rowB[0].canonical_url_hash).toBe(hash);
    const n = await countRows(db, 'research_sources', `"canonical_url_hash" = '${hash}'`);
    expect(n).toBe(2);
  });
});

describe('SourceRevisionService: bounded source summaries (VAL-CROSS-034, VAL-RES-098)', () => {
  it('listRunSourceSummaries returns only safe summary fields, scoped by run', async () => {
    const scope = await seedScope(db, '__mtest__ bounded-api');
    const text = 'secret document content canary';
    await service.persistSourceRevision(makeInput(scope, makeSource({ text })));
    const summaries = await service.listRunSourceSummaries(
      scope.companyId,
      scope.projectId,
      scope.runId,
    );
    expect(summaries).toHaveLength(1);
    const s = summaries[0];
    expect(s.canonicalUrl).toBe('https://example.com/article');
    expect(s.contentHash).toBe(computeContentHash(text));
    expect(s.byteCount).toBeGreaterThan(0);
    // No full content, title, author, or normalized text in the summary.
    const json = JSON.stringify(s);
    expect(json).not.toContain('secret document content canary');
    expect(json).not.toContain('Jane Doe');
    expect('normalizedText' in s).toBe(false);
    expect('title' in s).toBe(false);
    expect('author' in s).toBe(false);
  });

  it('listRunSourceSummaries returns nothing for a foreign company/project (VAL-RES-022)', async () => {
    const scope = await seedScope(db, '__mtest__ bounded-scope');
    const other = await seedScope(db, '__mtest__ bounded-other');
    await service.persistSourceRevision(makeInput(scope, makeSource()));
    const foreign = await service.listRunSourceSummaries(
      other.companyId,
      other.projectId,
      scope.runId,
    );
    expect(foreign).toHaveLength(0);
  });

  it('getSourceRevision returns null for a cross-company revision id', async () => {
    const scopeA = await seedScope(db, '__mtest__ get-scope-a');
    const scopeB = await seedScope(db, '__mtest__ get-scope-b');
    const a = await service.persistSourceRevision(makeInput(scopeA, makeSource()));
    const foreign = await service.getSourceRevision(
      scopeB.companyId,
      scopeB.projectId,
      a.sourceRevisionId,
    );
    expect(foreign).toBeNull();
    const own = await service.getSourceRevision(
      scopeA.companyId,
      scopeA.projectId,
      a.sourceRevisionId,
    );
    expect(own).not.toBeNull();
    expect(own?.sourceRevisionId).toBe(a.sourceRevisionId);
  });
});

describe('SourceRevisionService: deterministic and restart-stable (VAL-RES-112)', () => {
  it('produces the same content hash and canonical URL hash for the same input', async () => {
    const scope = await seedScope(db, '__mtest__ deterministic');
    const a = await service.persistSourceRevision(
      makeInput(scope, makeSource({ text: 'caf\u00e9 content' })),
    );
    expect(a.contentHash).toBe(computeContentHash('caf\u00e9 content'));
    expect(a.canonicalUrlHash).toBe(computeCanonicalUrlHash('https://example.com/article'));
  });
});
