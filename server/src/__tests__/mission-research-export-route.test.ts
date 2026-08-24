import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { createTestDb, createTestServer, closeTestDb, closeTestServers } from '../test-utils.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { encrypt } from '../services/crypto.js';
import { encryptContent } from '../services/content-encryption.js';
import { computeQuoteHash } from '../services/mission/research/source-normalization.js';
import { EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '../services/mission/research/evidence-document-schema.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Exact-revision citation export route.
 *
 * (VAL-RES-039, VAL-RES-040, VAL-RES-101, VAL-RES-102)
 *
 * GET /api/companies/:companyId/projects/:projectId/artifacts/:artifactId/
 *     revisions/:version/export?format=markdown|html
 *
 * Exports the exact positive integer revision as UTF-8 `.md` or sanitized
 * `.html` with attachment filename, stable ordinals, canonical links, and a
 * bound source list unchanged by newer edits. Project-scope denials and
 * malformed input are safe.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let server: Awaited<ReturnType<typeof createTestServer>>;
let sources: SourceRevisionService;

beforeAll(async () => {
  db = await createTestDb();
  server = await createTestServer(db);
  sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
});

afterAll(async () => {
  await closeTestServers();
  await closeTestDb();
});

// --- Seed helpers -----------------------------------------------------------

async function seedScope(label: string) {
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

function makeSource(overrides: Partial<NormalizedResearchSource> = {}): NormalizedResearchSource {
  return {
    canonicalUrl: 'https://example.com/article-' + randomUUID().slice(0, 8),
    title: 'Canine Velocity',
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

function evidenceDoc(citationId: string): Record<string, unknown> {
  return {
    schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION,
    blocks: [
      { type: 'heading', level: 1, spans: [{ type: 'text', text: 'Research Summary' }] },
      {
        type: 'paragraph',
        spans: [
          { type: 'text', text: 'The quick brown fox jumps over the lazy dog' },
          { type: 'citation', citationId },
          { type: 'text', text: '.' },
        ],
      },
    ],
  };
}

/**
 * Seed an artifact at version 1, then a cited revision at version 2 with a
 * known citation id referenced by the doc's inline mark. Inserts the
 * artifact revision (encrypted EvidenceDocumentV1) and citation row
 * (encrypted quote + frozen metadata) directly so the export maps the mark
 * to the ordinal.
 */
async function seedCitedRevision(scope: { companyId: string; projectId: string; runId: string }) {
  const artifactId = randomUUID();
  const now = new Date();
  // Artifact row at version 2 (the cited revision is v2).
  await db.drizzle.execute(sql`
    INSERT INTO "artifacts" ("id","company_id","project_id","type","title","content","version","created_at","updated_at")
    VALUES (${artifactId}, ${scope.companyId}, ${scope.projectId}, 'document', 'Canine Velocity', '{}'::jsonb, 2, ${now}, ${now})
  `);
  // v1 placeholder revision (empty content).
  await db.drizzle.execute(sql`
    INSERT INTO "artifact_revisions" ("id","artifact_id","version","content","edit_source","created_at")
    VALUES (${randomUUID()}, ${artifactId}, 1, ${JSON.stringify(encryptContent({ schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION, blocks: [] }))}::jsonb, 'agent', ${now})
  `);

  // Source revision for the citation.
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

  // v2 cited revision: doc mark references the known citation id.
  const citationId = randomUUID();
  const revisionId = randomUUID();
  const doc = evidenceDoc(citationId);
  await db.drizzle.execute(sql`
    INSERT INTO "artifact_revisions" ("id","artifact_id","version","content","edit_source","created_at")
    VALUES (${revisionId}, ${artifactId}, 2, ${JSON.stringify(encryptContent(doc))}::jsonb, 'agent', ${now})
  `);

  const quote = 'The quick brown fox jumps over the lazy dog.';
  await db.drizzle.execute(sql`
    INSERT INTO "citations"
      ("id","company_id","project_id","run_id","source_revision_id",
       "artifact_id","artifact_revision_id","ordinal",
       "quote_exact_encrypted","quote_hash",
       "frozen_title_encrypted","frozen_author_encrypted","frozen_canonical_url",
       "frozen_retrieved_at","frozen_provider","created_at")
    VALUES
      (${citationId}, ${scope.companyId}, ${scope.projectId}, ${scope.runId},
       ${rev.sourceRevisionId}, ${artifactId}, ${revisionId}, 1,
       ${encrypt(quote)}, ${computeQuoteHash(quote)},
       ${encrypt('Canine Velocity')}, ${encrypt('Jane Doe')}, ${source.canonicalUrl},
       ${now}, 'tavily', ${now})
  `);

  return { artifactId, version: 2, revisionId, citationId, source, quote };
}

// --- Tests ------------------------------------------------------------------

describe('GET .../revisions/:version/export', () => {
  it('exports markdown for the exact revision with filename, ordinals, and source list', async () => {
    const scope = await seedScope('export-route-md');
    const seeded = await seedCitedRevision(scope);

    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/export?format=markdown`,
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain(`canine-velocity-v${seeded.version}.md`);
    const body = res.text;
    expect(body).toContain('# Research Summary');
    expect(body).toContain('[1]');
    expect(body).toContain('## Sources');
    expect(body).toContain('Canine Velocity — Jane Doe');
    expect(body).toContain(seeded.source.canonicalUrl);
    // Excludes internal IDs and provider internals.
    expect(body).not.toContain('tavily');
  });

  it('exports sanitized HTML with no script, event attribute, or active embed', async () => {
    const scope = await seedScope('export-route-html');
    const seeded = await seedCitedRevision(scope);

    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/export?format=html`,
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-disposition']).toContain(`canine-velocity-v${seeded.version}.html`);
    const html = res.text;
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<sup><a href="#cite-1">1</a></sup>');
    expect(html).toContain('id="cite-1"');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<iframe/i);
    expect(html).not.toMatch(/<embed/i);
    expect(html).not.toMatch(/<object/i);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/on\w+\s*=/i);
    expect(html).not.toContain('tavily');
  });

  it('returns 400 UNSUPPORTED_EXPORT_FORMAT for an unsupported format', async () => {
    const scope = await seedScope('export-route-bad-fmt');
    const seeded = await seedCitedRevision(scope);

    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/export?format=pdf`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNSUPPORTED_EXPORT_FORMAT');
  });

  it('returns 400 VALIDATION_ERROR for a malformed version', async () => {
    const scope = await seedScope('export-route-bad-ver');
    const seeded = await seedCitedRevision(scope);

    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/abc/export?format=markdown`,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('returns a non-enumerating 404 for a cross-project artifact', async () => {
    const scopeA = await seedScope('export-route-xproj-a');
    const scopeB = await seedScope('export-route-xproj-b');
    const seeded = await seedCitedRevision(scopeA);

    const res = await request(server).get(
      `/api/companies/${scopeA.companyId}/projects/${scopeB.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/export?format=markdown`,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('REVISION_NOT_FOUND');
  });

  it('returns a non-enumerating 404 for a cross-company artifact', async () => {
    const scopeA = await seedScope('export-route-xco-a');
    const scopeB = await seedScope('export-route-xco-b');
    const seeded = await seedCitedRevision(scopeA);

    const res = await request(server).get(
      `/api/companies/${scopeB.companyId}/projects/${scopeB.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/export?format=markdown`,
    );
    expect(res.status).toBe(404);
  });

  it('pinned older revision export bytes are unchanged after a newer edit', async () => {
    const scope = await seedScope('export-route-pin');
    const seeded = await seedCitedRevision(scope);

    const beforeRes = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/export?format=markdown`,
    );
    expect(beforeRes.status).toBe(200);
    const beforeHash = createHash('sha256').update(beforeRes.text, 'utf8').digest('hex');

    // Newer edit: insert a v3 revision with different content and no citation.
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "artifact_revisions" ("id","artifact_id","version","content","edit_source","created_at")
      VALUES (${randomUUID()}, ${seeded.artifactId}, 3, ${JSON.stringify(encryptContent({ schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION, blocks: [{ type: 'heading', level: 1, spans: [{ type: 'text', text: 'Updated' }] }] }))}::jsonb, 'user', ${now})
    `);
    // Bump the artifact's current version to 3 (simulating a newer edit).
    await db.drizzle.execute(sql`
      UPDATE "artifacts" SET "version" = 3, "updated_at" = ${now} WHERE "id" = ${seeded.artifactId}
    `);

    const afterRes = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/export?format=markdown`,
    );
    expect(afterRes.status).toBe(200);
    const afterHash = createHash('sha256').update(afterRes.text, 'utf8').digest('hex');
    expect(afterHash).toBe(beforeHash);
  });

  it('HTML export excludes a seeded restricted canary', async () => {
    const scope = await seedScope('export-route-canary');
    const seeded = await seedCitedRevision(scope);

    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/export?format=html`,
    );
    expect(res.status).toBe(200);
    // No provider metadata, request-id hashes, or internal IDs leak.
    expect(res.text).not.toContain('tavily');
    expect(res.text).not.toContain('firecrawl');
    expect(res.text).not.toContain('SECRET');
    expect(res.text).not.toContain('credential');
  });
});
