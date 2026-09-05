import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { ArtifactCommitService } from '../services/mission/research/artifact-commit-service.js';
import { CitationCarryForwardService } from '../services/mission/research/citation-carry-forward-service.js';
import { ExportRevisionService } from '../services/mission/research/export-revision-service.js';
import { EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '../services/mission/research/evidence-document-schema.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Exact-revision export data loading (VAL-RES-039, VAL-RES-101, VAL-RES-102).
 *
 * The export revision service loads the pinned revision content and its
 * bound citations with frozen display metadata, scoped by company/project.
 * Cross-scope reads are non-enumerating (null). A newer edit does not
 * change the older revision's export data.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let sources: SourceRevisionService;
let commit: ArtifactCommitService;
let carryForward: CitationCarryForwardService;
let exportSvc: ExportRevisionService;

beforeAll(async () => {
  db = await createTestDb();
  sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
  commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
  carryForward = new CitationCarryForwardService({ drizzle: db.drizzle, schema: db.schema });
  exportSvc = new ExportRevisionService({ drizzle: db.drizzle, schema: db.schema });
});

afterAll(async () => {
  await closeTestDb();
});

// --- Seed helpers -----------------------------------------------------------

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
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'summary', 'deep_work', null, 'running', 5, 10, 'require_all', ${now}, ${now}, ${now})
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

function makeSource(overrides: Partial<NormalizedResearchSource> = {}): NormalizedResearchSource {
  return {
    canonicalUrl: 'https://example.com/article-' + randomUUID().slice(0, 8),
    title: 'Source Title',
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

function evidenceDoc(): Record<string, unknown> {
  return {
    schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
    blocks: [
      {
        type: 'heading',
        level: 1,
        spans: [{ type: 'text', text: 'Research Summary' }],
      },
      {
        type: 'paragraph',
        spans: [
          { type: 'text', text: 'The quick brown fox jumps over the lazy dog' },
          { type: 'citation', citationId: 'pending' },
          { type: 'text', text: '.' },
        ],
      },
    ],
  };
}

// --- Tests ------------------------------------------------------------------

describe('ExportRevisionService', () => {
  it('loads the exact revision content and bound citations scoped by project', async () => {
    const scope = await seedScope(db, 'export-scope');
    const art = await seedArtifact(db, scope.companyId, scope.projectId, 1);
    const source = makeSource();
    const rev = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });

    const doc = evidenceDoc();
    const result = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: doc,
      editSource: 'agent',
      citations: [
        {
          sourceRevisionId: rev.sourceRevisionId,
          ordinal: 1,
          quote: 'The quick brown fox jumps over the lazy dog.',
          frozenTitle: 'Source Title',
          frozenAuthor: 'Jane Doe',
          frozenCanonicalUrl: source.canonicalUrl,
          frozenRetrievedAt: '2026-08-24T12:00:00.000Z',
          frozenProvider: 'tavily',
          artifactLocator: { jsonPointer: '/blocks/1/spans/1' },
        },
      ],
      provenance: {
        generationTime: new Date(),
        citedSourceRevisionIds: [rev.sourceRevisionId],
      },
    });

    // Fix the citation mark in the doc to reference the real citation id.
    // The commit wrote the citation with a known ordinal; the export maps
    // citationId -> ordinal, so we re-commit with the mark pointing at the
    // real citation id by carrying forward.
    const realCitationId = result.citationIds[0];
    const docWithId: Record<string, unknown> = {
      schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      blocks: [
        {
          type: 'heading',
          level: 1,
          spans: [{ type: 'text', text: 'Research Summary' }],
        },
        {
          type: 'paragraph',
          spans: [
            { type: 'text', text: 'The quick brown fox jumps over the lazy dog' },
            { type: 'citation', citationId: realCitationId },
            { type: 'text', text: '.' },
          ],
        },
      ],
    };
    // Restore: create a new revision (v2) from the corrected content,
    // carrying the citation forward.
    const restored = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: result.artifactRevisionId,
      content: docWithId,
      editSource: 'agent',
      provenance: {
        generationTime: new Date(),
        citedSourceRevisionIds: [rev.sourceRevisionId],
      },
    });

    const data = await exportSvc.loadExportData(
      scope.companyId,
      scope.projectId,
      art.artifactId,
      restored.version,
    );
    expect(data).not.toBeNull();
    expect(data!.title).toBe('Cited Doc');
    expect(data!.version).toBe(restored.version);
    expect(data!.content.schemaVersion).toBe(EVIDENCE_DOCUMENT_SCHEMA_VERSION);
    expect(data!.citations.length).toBe(1);
    expect(data!.citations[0].ordinal).toBe(1);
    expect(data!.citations[0].quote).toBe('The quick brown fox jumps over the lazy dog.');
    expect(data!.citations[0].frozenTitle).toBe('Source Title');
    expect(data!.citations[0].frozenAuthor).toBe('Jane Doe');
    expect(data!.citations[0].canonicalUrl).toBe(source.canonicalUrl);
  });

  it('returns null for a cross-project artifact (non-enumerating)', async () => {
    const scopeA = await seedScope(db, 'export-a');
    const scopeB = await seedScope(db, 'export-b');
    const art = await seedArtifact(db, scopeA.companyId, scopeA.projectId, 1);
    const data = await exportSvc.loadExportData(
      scopeB.companyId,
      scopeB.projectId,
      art.artifactId,
      1,
    );
    expect(data).toBeNull();
  });

  it('returns null for a cross-company artifact (non-enumerating)', async () => {
    const scopeA = await seedScope(db, 'export-co-a');
    const scopeB = await seedScope(db, 'export-co-b');
    const art = await seedArtifact(db, scopeA.companyId, scopeA.projectId, 1);
    const data = await exportSvc.loadExportData(
      scopeB.companyId,
      scopeB.projectId,
      art.artifactId,
      1,
    );
    expect(data).toBeNull();
  });

  it('returns null for a nonexistent version', async () => {
    const scope = await seedScope(db, 'export-missing');
    const art = await seedArtifact(db, scope.companyId, scope.projectId, 1);
    const data = await exportSvc.loadExportData(
      scope.companyId,
      scope.projectId,
      art.artifactId,
      999,
    );
    expect(data).toBeNull();
  });

  it('pinned older revision export data is unchanged after a newer edit', async () => {
    const scope = await seedScope(db, 'export-pin');
    const art = await seedArtifact(db, scope.companyId, scope.projectId, 1);
    const source = makeSource();
    const rev = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source,
    });

    const docV1 = evidenceDoc();
    const result = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: docV1,
      editSource: 'agent',
      citations: [
        {
          sourceRevisionId: rev.sourceRevisionId,
          ordinal: 1,
          quote: 'The quick brown fox jumps over the lazy dog.',
          frozenTitle: 'Source Title',
          frozenAuthor: 'Jane Doe',
          frozenCanonicalUrl: source.canonicalUrl,
          frozenRetrievedAt: '2026-08-24T12:00:00.000Z',
          frozenProvider: 'tavily',
        },
      ],
      provenance: {
        generationTime: new Date(),
        citedSourceRevisionIds: [rev.sourceRevisionId],
      },
    });

    // Snapshot the v2 export (the committed revision is v2).
    const before = await exportSvc.loadExportData(
      scope.companyId,
      scope.projectId,
      art.artifactId,
      result.version,
    );
    expect(before).not.toBeNull();

    // Newer edit: create a v3 with different content and no carried citation.
    const newerDoc: Record<string, unknown> = {
      schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
      blocks: [{ type: 'heading', level: 1, spans: [{ type: 'text', text: 'Updated Content' }] }],
    };
    await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: result.version,
      previousArtifactRevisionId: result.artifactRevisionId,
      content: newerDoc,
      editSource: 'user',
      provenance: {
        generationTime: new Date(),
        citedSourceRevisionIds: [],
      },
    });

    // The older revision's export data is unchanged (pinned to its version).
    const after = await exportSvc.loadExportData(
      scope.companyId,
      scope.projectId,
      art.artifactId,
      result.version,
    );
    expect(after).not.toBeNull();
    expect(after!.citations.length).toBe(before!.citations.length);
    expect(after!.citations[0].quote).toBe(before!.citations[0].quote);
    expect(after!.content).toEqual(before!.content);
  });
});
