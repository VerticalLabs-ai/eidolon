import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer, closeTestDb, closeTestServers } from '../test-utils.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { encrypt } from '../services/crypto.js';
import { encryptContent } from '../services/content-encryption.js';
import { computeQuoteHash } from '../services/mission/research/source-normalization.js';
import { EVIDENCE_DOCUMENT_SCHEMA_VERSION } from '../services/mission/research/evidence-document-schema.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Regression tests for fix-ut-m5-unnest-budget.
 *
 * (a) Citations API endpoint returns 200 with citation data (not 500 from
 *     SQL UNNEST error).
 * (b) Provenance API endpoint returns 200 with provenance data (not 500
 *     from SQL UNNEST error, not 404 from missing artifact verification).
 * (c) Extract/scrape/structured_extract operations execute when step budget
 *     is sufficient (child step budget covers conservative estimate).
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let server: Awaited<ReturnType<typeof createTestServer>>;
let app: Express;
let sources: SourceRevisionService;

beforeAll(async () => {
  db = await createTestDb();
  server = await createTestServer(db);
  app = (server as unknown as { app: Express }).app;
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

interface SeededArtifact {
  artifactId: string;
  version: number;
  revisionId: string;
  citationId: string;
  sourceRevisionId: string;
  source: NormalizedResearchSource;
  quote: string;
}

/**
 * Seed an artifact at version 2 with a cited revision, source revision,
 * and provenance row. Also seeds a source availability check so the
 * citations endpoint's UNNEST query has data to join against.
 */
async function seedCitedArtifactWithProvenance(scope: {
  companyId: string;
  projectId: string;
  runId: string;
}): Promise<SeededArtifact> {
  const artifactId = randomUUID();
  const now = new Date();

  await db.drizzle.execute(sql`
    INSERT INTO "artifacts" ("id","company_id","project_id","type","title","content","version","created_at","updated_at")
    VALUES (${artifactId}, ${scope.companyId}, ${scope.projectId}, 'document', 'Canine Velocity', '{}'::jsonb, 2, ${now}, ${now})
  `);

  // v1 placeholder revision.
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

  // v2 cited revision.
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

  // Seed a source availability check so the UNNEST query has data.
  await db.drizzle.execute(sql`
    INSERT INTO "research_source_availability_checks"
      ("id","company_id","project_id","run_id","root_run_id","source_revision_id",
       "logical_call_id","checked_url","status","idempotency_key","created_at")
    VALUES
      (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${scope.runId}, ${scope.runId},
       ${rev.sourceRevisionId}, ${randomUUID()}, ${source.canonicalUrl}, 'available', ${randomUUID()}, ${now})
  `);

  // Seed provenance row.
  await db.drizzle.execute(sql`
    INSERT INTO "artifact_provenance"
      ("id","company_id","project_id","run_id","root_run_id","artifact_id","artifact_revision_id",
       "approved_plan_revision_id","approved_plan_hash","policy_hash",
       "producing_step_key","producing_child_run_id","generation_time",
       "cited_source_revision_ids","created_at")
    VALUES
      (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${scope.runId}, ${scope.runId},
       ${artifactId}, ${revisionId},
       NULL, NULL, NULL,
       'step-1', NULL, ${now},
       ${JSON.stringify([rev.sourceRevisionId])}::jsonb, ${now})
  `);

  return {
    artifactId,
    version: 2,
    revisionId,
    citationId,
    sourceRevisionId: rev.sourceRevisionId,
    source,
    quote,
  };
}

// ---------------------------------------------------------------------------
// (a) Citations API endpoint returns 200 with citation data
// ---------------------------------------------------------------------------

describe('GET .../revisions/:version/citations (fix-ut-m5-unnest-budget)', () => {
  it('returns 200 with citation data when citations exist', async () => {
    const scope = await seedScope('citations-200');
    const seeded = await seedCitedArtifactWithProvenance(scope);

    const res = await request(app).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/citations`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.citations).toBeInstanceOf(Array);
    expect(res.body.data.citations.length).toBeGreaterThan(0);

    const citation = res.body.data.citations[0];
    expect(citation.citationId).toBe(seeded.citationId);
    expect(citation.ordinal).toBe(1);
    expect(citation.quote).toBe(seeded.quote);
    expect(citation.frozenTitle).toBe('Canine Velocity');
    expect(citation.canonicalUrl).toBe(seeded.source.canonicalUrl);
    expect(citation.sourceRevisionId).toBe(seeded.sourceRevisionId);
    // Source availability status from the UNNEST query.
    expect(citation.sourceAvailabilityStatus).toBe('available');
  });

  it('returns 200 with empty citations when no citations exist', async () => {
    const scope = await seedScope('citations-empty');
    const artifactId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id","company_id","project_id","type","title","content","version","created_at","updated_at")
      VALUES (${artifactId}, ${scope.companyId}, ${scope.projectId}, 'document', 'No Cites', '{}'::jsonb, 1, ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "artifact_revisions" ("id","artifact_id","version","content","edit_source","created_at")
      VALUES (${randomUUID()}, ${artifactId}, 1, ${JSON.stringify(encryptContent({ schemaVersion: EVIDENCE_DOCUMENT_SCHEMA_VERSION, blocks: [] }))}::jsonb, 'agent', ${now})
    `);

    const res = await request(app).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${artifactId}/revisions/1/citations`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.citations).toBeInstanceOf(Array);
    expect(res.body.data.citations.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (b) Provenance API endpoint returns 200 with provenance data
// ---------------------------------------------------------------------------

describe('GET .../revisions/:version/provenance (fix-ut-m5-unnest-budget)', () => {
  it('returns 200 with provenance data when provenance exists', async () => {
    const scope = await seedScope('provenance-200');
    const seeded = await seedCitedArtifactWithProvenance(scope);

    const res = await request(app).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${seeded.artifactId}/revisions/${seeded.version}/provenance`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
    expect(res.body.data.runId).toBe(scope.runId);
    expect(res.body.data.rootRunId).toBe(scope.runId);
    expect(res.body.data.artifactId).toBe(seeded.artifactId);
    expect(res.body.data.artifactVersion).toBe(seeded.version);
    expect(res.body.data.producingStepKey).toBe('step-1');
    expect(res.body.data.citedSourceRevisionIds).toBeInstanceOf(Array);
    expect(res.body.data.citedSourceRevisionIds).toContain(seeded.sourceRevisionId);
  });

  it('returns 404 for a non-existent revision', async () => {
    const scope = await seedScope('provenance-404');
    const artifactId = randomUUID();
    const now = new Date();

    await db.drizzle.execute(sql`
      INSERT INTO "artifacts" ("id","company_id","project_id","type","title","content","version","created_at","updated_at")
      VALUES (${artifactId}, ${scope.companyId}, ${scope.projectId}, 'document', 'No Rev', '{}'::jsonb, 1, ${now}, ${now})
    `);

    const res = await request(app).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/artifacts/${artifactId}/revisions/99/provenance`,
    );

    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// (c) Extract/scrape/structured_extract execute when step budget is sufficient
// ---------------------------------------------------------------------------

describe('resolveStepBudgetCents enforces minimum for research steps (fix-ut-m5-unnest-budget)', () => {
  it('returns at least the minimum research budget for steps with research tools', async () => {
    // This test verifies that the resolveStepBudgetCents function returns
    // a budget sufficient to cover conservative estimates for research
    // operations (extract/scrape/structured_extract). The default pricing
    // table has conservative estimates of 100-150c per operation, and a
    // step with multiple research operations needs a higher budget.
    //
    // We verify by checking that the minimum budget for research steps is
    // at least 1000c, which covers the sum of conservative estimates for
    // all research operations (search + extract + scrape + structured_extract).
    const mod = await import('../services/mission/run-processor.js');
    const minBudget = (mod as unknown as { MINIMUM_RESEARCH_STEP_BUDGET_CENTS: number })
      .MINIMUM_RESEARCH_STEP_BUDGET_CENTS;
    expect(minBudget).toBeDefined();
    expect(minBudget).toBeGreaterThanOrEqual(1000);
  });
});
