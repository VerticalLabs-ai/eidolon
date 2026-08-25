import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { CitationService } from '../services/mission/research/citation-service.js';
import { ArtifactCommitService } from '../services/mission/research/artifact-commit-service.js';
import { CitationCarryForwardService } from '../services/mission/research/citation-carry-forward-service.js';
import { SourceAvailabilityService } from '../services/mission/research/source-availability-service.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Regression test for fix-ut-m5-date-serialization-sweep.
 *
 * Raw sql`` templates must pass ISO 8601 strings, not Date objects that the
 * pg driver may serialize as Date.toString() (e.g. 'Tue Aug 25 2026
 * 18:31:24 GMT-0500') which PostgreSQL rejects with "time zone 'gmt-0500'
 * not recognized". This test verifies that all 5 affected INSERT paths
 * (research_sources, citations, artifact_provenance,
 * citation_carry_forward_outcomes, research_source_availability_checks)
 * store valid ISO 8601 timestamps.
 *
 * All tests use real Postgres on 127.0.0.1:55322.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

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
    canonicalUrl: 'https://example.com/iso-article',
    title: 'Article',
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

// ---------------------------------------------------------------------------
// Regression: ISO 8601 timestamp serialization across all 5 affected files
// ---------------------------------------------------------------------------

describe('fix-ut-m5-date-serialization-sweep: ISO 8601 timestamp serialization', () => {
  // 1. source-revision-service.ts — research_sources INSERT
  it('research_sources INSERT stores timestamps as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-research-sources');
    const service = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });

    const result = await service.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource(),
    });

    // Read back the stored timestamps from research_sources.
    const [row] = (await db.drizzle.execute(sql`
      SELECT "first_seen_at", "last_seen_at", "created_at", "updated_at"
      FROM "research_sources" WHERE "id" = ${result.sourceId}
    `)) as unknown as {
      first_seen_at: Date;
      last_seen_at: Date;
      created_at: Date;
      updated_at: Date;
    }[];

    expect(row).toBeTruthy();
    // Each stored timestamp must be a valid date (not null, not NaN).
    // If the INSERT had passed a Date.toString() format, PostgreSQL would
    // have rejected it and this row would not exist.
    expect(new Date(row.first_seen_at).toString()).not.toBe('Invalid Date');
    expect(new Date(row.last_seen_at).toString()).not.toBe('Invalid Date');
    expect(new Date(row.created_at).toString()).not.toBe('Invalid Date');
    expect(new Date(row.updated_at).toString()).not.toBe('Invalid Date');
  });

  // 1b. source-revision-service.ts — research_source_revisions INSERT
  it('research_source_revisions INSERT stores created_at as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-source-revisions');
    const service = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });

    const result = await service.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'unique iso revision text' }),
    });

    const [row] = (await db.drizzle.execute(sql`
      SELECT "created_at", "retrieved_at" FROM "research_source_revisions"
      WHERE "id" = ${result.sourceRevisionId}
    `)) as unknown as { created_at: Date; retrieved_at: string }[];

    expect(row).toBeTruthy();
    expect(new Date(row.created_at).toString()).not.toBe('Invalid Date');
  });

  // 1c. source-revision-service.ts — run_research_sources INSERT
  it('run_research_sources INSERT stores created_at as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-run-research-sources');
    const service = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });

    await service.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'run research sources iso text' }),
    });

    const [row] = (await db.drizzle.execute(sql`
      SELECT "created_at" FROM "run_research_sources"
      WHERE "run_id" = ${scope.runId}
      LIMIT 1
    `)) as unknown as { created_at: Date }[];

    expect(row).toBeTruthy();
    expect(new Date(row.created_at).toString()).not.toBe('Invalid Date');
  });

  // 2. citation-service.ts — citations INSERT
  it('citations INSERT stores created_at as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-citations');
    const sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
    const citations = new CitationService({ drizzle: db.drizzle, schema: db.schema });
    const art = await seedArtifact(db, scope.companyId, scope.projectId);

    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'citation iso text here' }),
    });

    const citationId = await citations.persistCitation({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      sourceRevisionId: persisted.sourceRevisionId,
      artifactId: art.artifactId,
      artifactRevisionId: art.revisionId,
      ordinal: 1,
      quote: 'citation iso text here',
      frozenCanonicalUrl: 'https://example.com/iso-article',
      frozenRetrievedAt: '2026-08-24T12:00:00Z',
      frozenProvider: 'tavily',
    });

    const [row] = (await db.drizzle.execute(sql`
      SELECT "created_at" FROM "citations" WHERE "id" = ${citationId}
    `)) as unknown as { created_at: Date }[];

    expect(row).toBeTruthy();
    expect(new Date(row.created_at).toString()).not.toBe('Invalid Date');
  });

  // 3. artifact-commit-service.ts — artifact_provenance INSERT
  it('artifact_provenance INSERT stores created_at and generation_time as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-artifact-provenance');
    const sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
    const commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
    const art = await seedArtifact(db, scope.companyId, scope.projectId);

    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'provenance iso text content' }),
    });

    const generationTime = new Date('2026-08-25T18:31:24.000Z');
    const result = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: { body: 'test content' },
      editSource: 'agent',
      citations: [
        {
          sourceRevisionId: persisted.sourceRevisionId,
          ordinal: 1,
          quote: 'provenance iso text content',
          normalizedSourceText: 'provenance iso text content',
          frozenCanonicalUrl: 'https://example.com/iso-article',
          frozenRetrievedAt: '2026-08-24T12:00:00Z',
          frozenProvider: 'tavily',
        },
      ],
      provenance: {
        generationTime,
        citedSourceRevisionIds: [persisted.sourceRevisionId],
      },
    });

    const [row] = (await db.drizzle.execute(sql`
      SELECT "created_at", "generation_time" FROM "artifact_provenance"
      WHERE "artifact_revision_id" = ${result.artifactRevisionId}
    `)) as unknown as { created_at: Date; generation_time: Date }[];

    expect(row).toBeTruthy();
    expect(new Date(row.created_at).toString()).not.toBe('Invalid Date');
    // generation_time was a Date object passed to raw SQL; verify it stored
    // correctly as the exact injected value.
    expect(new Date(row.generation_time).toISOString()).toBe(generationTime.toISOString());
  });

  // 3b. artifact-commit-service.ts — citations INSERT (inside transaction)
  it('artifact-commit citations INSERT stores created_at as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-artifact-citations');
    const sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
    const commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
    const art = await seedArtifact(db, scope.companyId, scope.projectId);

    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'artifact commit citation iso text' }),
    });

    const result = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: { body: 'test content' },
      editSource: 'agent',
      citations: [
        {
          sourceRevisionId: persisted.sourceRevisionId,
          ordinal: 1,
          quote: 'artifact commit citation iso text',
          normalizedSourceText: 'artifact commit citation iso text',
          frozenCanonicalUrl: 'https://example.com/iso-article',
          frozenRetrievedAt: '2026-08-24T12:00:00Z',
          frozenProvider: 'tavily',
        },
      ],
      provenance: {
        generationTime: new Date('2026-08-25T18:31:24.000Z'),
        citedSourceRevisionIds: [persisted.sourceRevisionId],
      },
    });

    const citationId = result.citationIds[0]!;
    const [row] = (await db.drizzle.execute(sql`
      SELECT "created_at" FROM "citations" WHERE "id" = ${citationId}
    `)) as unknown as { created_at: Date }[];

    expect(row).toBeTruthy();
    expect(new Date(row.created_at).toString()).not.toBe('Invalid Date');
  });

  // 4. citation-carry-forward-service.ts — citation_carry_forward_outcomes INSERT
  it('citation_carry_forward_outcomes INSERT stores created_at as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-carry-forward-outcomes');
    const sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
    const commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
    const carryForward = new CitationCarryForwardService({
      drizzle: db.drizzle,
      schema: db.schema,
    });
    const art = await seedArtifact(db, scope.companyId, scope.projectId);

    // First commit: create an artifact revision with a citation.
    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'carry forward iso text content' }),
    });

    const firstCommit = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: { body: 'original content with carry forward iso text content' },
      editSource: 'agent',
      citations: [
        {
          sourceRevisionId: persisted.sourceRevisionId,
          ordinal: 1,
          quote: 'carry forward iso text content',
          normalizedSourceText: 'carry forward iso text content',
          frozenCanonicalUrl: 'https://example.com/iso-article',
          frozenRetrievedAt: '2026-08-24T12:00:00Z',
          frozenProvider: 'tavily',
        },
      ],
      provenance: {
        generationTime: new Date('2026-08-25T18:31:24.000Z'),
        citedSourceRevisionIds: [persisted.sourceRevisionId],
      },
    });

    // Second commit: carry forward from the first revision.
    const generationTime = new Date('2026-08-25T19:00:00.000Z');
    const result = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: firstCommit.version,
      previousArtifactRevisionId: firstCommit.artifactRevisionId,
      content: { body: 'edited content with carry forward iso text content' },
      editSource: 'user',
      provenance: {
        generationTime,
        citedSourceRevisionIds: [persisted.sourceRevisionId],
      },
    });

    // Verify carry-forward outcomes were written with valid timestamps.
    const rows = (await db.drizzle.execute(sql`
      SELECT "created_at" FROM "citation_carry_forward_outcomes"
      WHERE "new_artifact_revision_id" = ${result.artifactRevisionId}
    `)) as unknown as { created_at: Date }[];

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(new Date(row.created_at).toString()).not.toBe('Invalid Date');
    }

    // Verify artifact_provenance generation_time stored correctly.
    const [provRow] = (await db.drizzle.execute(sql`
      SELECT "generation_time" FROM "artifact_provenance"
      WHERE "artifact_revision_id" = ${result.artifactRevisionId}
    `)) as unknown as { generation_time: Date }[];

    expect(provRow).toBeTruthy();
    expect(new Date(provRow.generation_time).toISOString()).toBe(generationTime.toISOString());
  });

  // 4b. citation-carry-forward-service.ts — citations INSERT (carried forward)
  it('carry-forward citations INSERT stores created_at as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-carry-forward-citations');
    const sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
    const commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
    const carryForward = new CitationCarryForwardService({
      drizzle: db.drizzle,
      schema: db.schema,
    });
    const art = await seedArtifact(db, scope.companyId, scope.projectId);

    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'carry forward citation iso text' }),
    });

    const firstCommit = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: { body: 'original with carry forward citation iso text' },
      editSource: 'agent',
      citations: [
        {
          sourceRevisionId: persisted.sourceRevisionId,
          ordinal: 1,
          quote: 'carry forward citation iso text',
          normalizedSourceText: 'carry forward citation iso text',
          frozenCanonicalUrl: 'https://example.com/iso-article',
          frozenRetrievedAt: '2026-08-24T12:00:00Z',
          frozenProvider: 'tavily',
        },
      ],
      provenance: {
        generationTime: new Date('2026-08-25T18:31:24.000Z'),
        citedSourceRevisionIds: [persisted.sourceRevisionId],
      },
    });

    const result = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: firstCommit.version,
      previousArtifactRevisionId: firstCommit.artifactRevisionId,
      content: { body: 'edited with carry forward citation iso text' },
      editSource: 'user',
      provenance: {
        generationTime: new Date('2026-08-25T19:00:00.000Z'),
        citedSourceRevisionIds: [persisted.sourceRevisionId],
      },
    });

    // Find the carried-forward citation (if any) and verify its created_at.
    const carriedOutcome = result.outcomes.find((o) => o.outcome === 'carried_forward');
    if (carriedOutcome?.newCitationId) {
      const [row] = (await db.drizzle.execute(sql`
        SELECT "created_at" FROM "citations" WHERE "id" = ${carriedOutcome.newCitationId}
      `)) as unknown as { created_at: Date }[];

      expect(row).toBeTruthy();
      expect(new Date(row.created_at).toString()).not.toBe('Invalid Date');
    }
  });

  // 5. source-availability-service.ts — research_source_availability_checks INSERT
  it('research_source_availability_checks INSERT stores created_at as valid ISO 8601', async () => {
    const scope = await seedScope(db, '__mtest__ iso-availability-checks');
    const sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });

    const persisted = await sources.persistSourceRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      logicalCallId: randomUUID(),
      provider: 'tavily',
      operation: 'search',
      source: makeSource({ text: 'availability check iso text' }),
    });

    const fixedTime = new Date('2026-08-25T18:31:24.000Z');
    const service = new SourceAvailabilityService(db, { clock: () => fixedTime });

    const result = await service.recordAvailabilityCheck({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      sourceRevisionId: persisted.sourceRevisionId,
      logicalCallId: randomUUID(),
      idempotencyKey: randomUUID(),
      status: 'available',
      httpStatus: 200,
    });

    // The returned createdAt must be a valid ISO 8601 string.
    expect(result.createdAt).toBe(fixedTime.toISOString());

    // Read back the stored created_at and verify it matches.
    const [row] = (await db.drizzle.execute(sql`
      SELECT "created_at" FROM "research_source_availability_checks"
      WHERE "id" = ${result.id}
    `)) as unknown as { created_at: Date }[];

    expect(row).toBeTruthy();
    expect(new Date(row.created_at).toISOString()).toBe(fixedTime.toISOString());
  });
});
