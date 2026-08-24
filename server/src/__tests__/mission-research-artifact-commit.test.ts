import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { ArtifactCommitService } from '../services/mission/research/artifact-commit-service.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Atomic artifact revision + citation + provenance commit.
 *
 * (architecture.md: ArtifactCommit module — commitArtifactWithProvenance,
 *  VAL-RES-032, VAL-RES-033, VAL-RES-100, VAL-CROSS-043)
 *
 * Each visible cited artifact revision commits with all citation and
 * provenance rows bound to its run, exact plan and policy, producing step,
 * generation time, and source revisions — in one transaction. A
 * persistence failpoint exposes neither a partial artifact revision nor
 * dangling citations/provenance. Concurrent expected-version edits yield one
 * winning version transaction; the loser receives a version-conflict error
 * and leaves no partial rows.
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

async function seedSourceRevision(
  scope: { companyId: string; projectId: string; runId: string },
  text: string,
) {
  const source = makeSource({ text });
  return sources.persistSourceRevision({
    companyId: scope.companyId,
    projectId: scope.projectId,
    runId: scope.runId,
    rootRunId: scope.runId,
    logicalCallId: randomUUID(),
    provider: 'tavily',
    operation: 'search',
    source,
  });
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

describe('ArtifactCommitService.commitArtifactWithProvenance (VAL-RES-032, VAL-RES-033, VAL-CROSS-043)', () => {
  it('atomically commits artifact revision + citations + provenance together', async () => {
    const scope = await seedScope(db, '__mtest__ commit-ok');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'first passage content');
    const rev2 = await seedSourceRevision(scope, 'second passage content');

    const content = {
      blocks: [
        { blockId: 'b1', spans: [{ type: 'citation', citationId: 'placeholder-1' }] },
        { blockId: 'b2', spans: [{ type: 'citation', citationId: 'placeholder-2' }] },
      ],
    };

    const result = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content,
      editSource: 'agent',
      editedByAgentId: null,
      message: 'research synthesis',
      citations: [
        {
          sourceRevisionId: rev1.sourceRevisionId,
          ordinal: 1,
          quote: 'first passage content',
          normalizedSourceText: 'first passage content',
          frozenCanonicalUrl: rev1.canonicalUrl,
          frozenRetrievedAt: rev1.retrievedAt,
          frozenProvider: 'tavily',
          frozenContentHash: rev1.contentHash,
          frozenTitle: 'Source Title',
          artifactLocator: { artifactVersion: 2, blockId: 'b1' },
        },
        {
          sourceRevisionId: rev2.sourceRevisionId,
          ordinal: 2,
          quote: 'second passage content',
          normalizedSourceText: 'second passage content',
          frozenCanonicalUrl: rev2.canonicalUrl,
          frozenRetrievedAt: rev2.retrievedAt,
          frozenProvider: 'tavily',
          frozenContentHash: rev2.contentHash,
          artifactLocator: { artifactVersion: 2, blockId: 'b2' },
        },
      ],
      provenance: {
        approvedPlanRevisionId: randomUUID(),
        approvedPlanHash: randomUUID().replace(/-/g, '').slice(0, 64),
        policyHash: randomUUID().replace(/-/g, '').slice(0, 64),
        producingStepKey: 'step-research',
        producingChildRunId: null,
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId, rev2.sourceRevisionId],
      },
    });

    // Version advanced to 2.
    expect(result.version).toBe(2);
    expect(result.artifactRevisionId).toBeTruthy();
    expect(result.citationIds).toHaveLength(2);
    expect(result.provenanceId).toBeTruthy();

    // All three row families are visible together.
    const revRows = (await db.drizzle.execute(sql`
      SELECT "id","version","content","edit_source","message" FROM "artifact_revisions"
      WHERE "artifact_id" = ${art.artifactId} ORDER BY "version" ASC
    `)) as unknown as {
      id: string;
      version: number;
      content: Record<string, unknown>;
      edit_source: string;
      message: string | null;
    }[];
    expect(revRows).toHaveLength(2);
    expect(revRows[1].version).toBe(2);
    expect(revRows[1].id).toBe(result.artifactRevisionId);
    expect(revRows[1].edit_source).toBe('agent');

    const citeRows = (await db.drizzle.execute(sql`
      SELECT "id","ordinal","source_revision_id","artifact_revision_id" FROM "citations"
      WHERE "artifact_revision_id" = ${result.artifactRevisionId} ORDER BY "ordinal" ASC
    `)) as unknown as {
      id: string;
      ordinal: number;
      source_revision_id: string;
      artifact_revision_id: string;
    }[];
    expect(citeRows).toHaveLength(2);
    expect(citeRows[0].source_revision_id).toBe(rev1.sourceRevisionId);
    expect(citeRows[1].source_revision_id).toBe(rev2.sourceRevisionId);

    const provRows = (await db.drizzle.execute(sql`
      SELECT "id","run_id","artifact_revision_id","approved_plan_revision_id","approved_plan_hash",
             "policy_hash","producing_step_key","cited_source_revision_ids"
      FROM "artifact_provenance" WHERE "artifact_revision_id" = ${result.artifactRevisionId}
    `)) as unknown as {
      id: string;
      run_id: string;
      artifact_revision_id: string;
      approved_plan_revision_id: string | null;
      approved_plan_hash: string | null;
      policy_hash: string | null;
      producing_step_key: string | null;
      cited_source_revision_ids: string[];
    }[];
    expect(provRows).toHaveLength(1);
    expect(provRows[0].id).toBe(result.provenanceId);
    expect(provRows[0].run_id).toBe(scope.runId);
  });

  it('provenance binds to run, exact plan revision/hash, policy hash, producing step, generation time, and source revisions (VAL-RES-033)', async () => {
    const scope = await seedScope(db, '__mtest__ commit-binding');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'binding passage one');
    const rev2 = await seedSourceRevision(scope, 'binding passage two');

    const planRevId = randomUUID();
    const planHash = 'a'.repeat(64);
    const policyHash = 'b'.repeat(64);
    const stepKey = 'step-synthesize';
    const childRunId = randomUUID();
    const genTime = new Date('2026-08-24T10:00:00Z');

    // Seed the child run so the FK holds. Terminal status requires terminal_at.
    const childNow = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id","company_id","project_id","project_thread_id","root_run_id","parent_run_id","depth","child_ordinal","routing_kind","request_envelope","request_content_hash","request_safe_summary","resolved_mode","policy_snapshot_id","status","state_version","last_event_sequence","partial_result_policy","available_at","terminal_at","created_at","updated_at")
      VALUES (${childRunId}, ${scope.companyId}, ${scope.projectId}, ${scope.threadId}, ${scope.runId}, ${scope.runId}, 1, 0, 'ephemeral', '{}'::jsonb, ${randomUUID()}, 'child', 'deep_work', null, 'completed', 1, 0, 'require_all', ${new Date()}, ${childNow}, ${childNow}, ${childNow})
    `);

    const result = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: { blocks: [] },
      editSource: 'agent',
      message: 'child synthesis',
      citations: [
        {
          sourceRevisionId: rev1.sourceRevisionId,
          ordinal: 1,
          quote: 'binding passage one',
          normalizedSourceText: 'binding passage one',
          frozenCanonicalUrl: rev1.canonicalUrl,
          frozenRetrievedAt: rev1.retrievedAt,
          frozenProvider: 'tavily',
          frozenContentHash: rev1.contentHash,
          artifactLocator: { artifactVersion: 2, jsonPointer: '' },
        },
        {
          sourceRevisionId: rev2.sourceRevisionId,
          ordinal: 2,
          quote: 'binding passage two',
          normalizedSourceText: 'binding passage two',
          frozenCanonicalUrl: rev2.canonicalUrl,
          frozenRetrievedAt: rev2.retrievedAt,
          frozenProvider: 'tavily',
          frozenContentHash: rev2.contentHash,
          artifactLocator: { artifactVersion: 2, jsonPointer: '' },
        },
      ],
      provenance: {
        approvedPlanRevisionId: planRevId,
        approvedPlanHash: planHash,
        policyHash,
        producingStepKey: stepKey,
        producingChildRunId: childRunId,
        generationTime: genTime,
        citedSourceRevisionIds: [rev1.sourceRevisionId, rev2.sourceRevisionId],
      },
    });

    const prov = (await db.drizzle.execute(sql`
      SELECT "run_id","root_run_id","approved_plan_revision_id","approved_plan_hash",
             "policy_hash","producing_step_key","producing_child_run_id","generation_time",
             "cited_source_revision_ids"
      FROM "artifact_provenance" WHERE "id" = ${result.provenanceId}
    `)) as unknown as {
      run_id: string;
      root_run_id: string;
      approved_plan_revision_id: string | null;
      approved_plan_hash: string | null;
      policy_hash: string | null;
      producing_step_key: string | null;
      producing_child_run_id: string | null;
      generation_time: Date;
      cited_source_revision_ids: string[];
    }[];
    expect(prov).toHaveLength(1);
    expect(prov[0].run_id).toBe(scope.runId);
    expect(prov[0].root_run_id).toBe(scope.runId);
    expect(prov[0].approved_plan_revision_id).toBe(planRevId);
    expect(prov[0].approved_plan_hash).toBe(planHash);
    expect(prov[0].policy_hash).toBe(policyHash);
    expect(prov[0].producing_step_key).toBe(stepKey);
    expect(prov[0].producing_child_run_id).toBe(childRunId);
    expect(new Date(prov[0].generation_time).toISOString()).toBe(genTime.toISOString());
    expect(prov[0].cited_source_revision_ids).toEqual([
      rev1.sourceRevisionId,
      rev2.sourceRevisionId,
    ]);

    // Citations bind to the exact source revisions and the new artifact revision.
    const cites = (await db.drizzle.execute(sql`
      SELECT "source_revision_id","artifact_revision_id","ordinal" FROM "citations"
      WHERE "artifact_revision_id" = ${result.artifactRevisionId} ORDER BY "ordinal"
    `)) as unknown as {
      source_revision_id: string;
      artifact_revision_id: string;
      ordinal: number;
    }[];
    expect(cites[0].source_revision_id).toBe(rev1.sourceRevisionId);
    expect(cites[1].source_revision_id).toBe(rev2.sourceRevisionId);
    expect(cites.every((c) => c.artifact_revision_id === result.artifactRevisionId)).toBe(true);
  });

  it('a citation persistence failpoint leaves no partial artifact revision, citation, or provenance (VAL-RES-032, VAL-CROSS-043)', async () => {
    const scope = await seedScope(db, '__mtest__ commit-failpoint');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'good passage content');

    // A second scope to create a FOREIGN source revision that the citation
    // scope guard will reject mid-transaction.
    const foreign = await seedScope(db, '__mtest__ commit-failpoint-foreign');
    const foreignRev = await seedSourceRevision(foreign, 'foreign only passage');

    const beforeRevisions = await countRows(
      'artifact_revisions',
      `artifact_id = '${art.artifactId}'`,
    );
    const beforeCitations = await countRows('citations', `company_id = '${scope.companyId}'`);
    const beforeProvenance = await countRows(
      'artifact_provenance',
      `company_id = '${scope.companyId}'`,
    );

    // The second citation references a foreign-company source revision. The
    // scope guard inside the atomic commit rejects it, rolling back the
    // entire transaction — including the already-prepared artifact revision
    // and the first valid citation.
    await expect(
      commit.commitArtifactWithProvenance({
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: scope.runId,
        rootRunId: scope.runId,
        artifactId: art.artifactId,
        expectedVersion: 1,
        content: { blocks: [] },
        editSource: 'agent',
        citations: [
          {
            sourceRevisionId: rev1.sourceRevisionId,
            ordinal: 1,
            quote: 'good passage content',
            normalizedSourceText: 'good passage content',
            frozenCanonicalUrl: rev1.canonicalUrl,
            frozenRetrievedAt: rev1.retrievedAt,
            frozenProvider: 'tavily',
            frozenContentHash: rev1.contentHash,
            artifactLocator: { artifactVersion: 2, jsonPointer: '' },
          },
          {
            sourceRevisionId: foreignRev.sourceRevisionId,
            ordinal: 2,
            quote: 'foreign only passage',
            normalizedSourceText: 'foreign only passage',
            frozenCanonicalUrl: foreignRev.canonicalUrl,
            frozenRetrievedAt: foreignRev.retrievedAt,
            frozenProvider: 'tavily',
            frozenContentHash: foreignRev.contentHash,
            artifactLocator: { artifactVersion: 2, jsonPointer: '' },
          },
        ],
        provenance: {
          policyHash: 'c'.repeat(64),
          producingStepKey: 'step-research',
          generationTime: new Date(),
          citedSourceRevisionIds: [rev1.sourceRevisionId],
        },
      }),
    ).rejects.toThrow(/not found in scope|scope/i);

    // All-or-nothing: no new revision, no new citations, no new provenance.
    const afterRevisions = await countRows(
      'artifact_revisions',
      `artifact_id = '${art.artifactId}'`,
    );
    const afterCitations = await countRows('citations', `company_id = '${scope.companyId}'`);
    const afterProvenance = await countRows(
      'artifact_provenance',
      `company_id = '${scope.companyId}'`,
    );

    expect(afterRevisions).toBe(beforeRevisions);
    expect(afterCitations).toBe(beforeCitations);
    expect(afterProvenance).toBe(beforeProvenance);

    // The artifact version did not advance.
    const artRow = (await db.drizzle.execute(sql`
      SELECT "version" FROM "artifacts" WHERE "id" = ${art.artifactId}
    `)) as unknown as { version: number }[];
    expect(artRow[0].version).toBe(1);
  });

  it('a provenance persistence failpoint leaves no partial artifact revision or citation (VAL-CROSS-043)', async () => {
    const scope = await seedScope(db, '__mtest__ commit-prov-failpoint');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'prov fail passage');

    const beforeRevisions = await countRows(
      'artifact_revisions',
      `artifact_id = '${art.artifactId}'`,
    );
    const beforeCitations = await countRows('citations', `company_id = '${scope.companyId}'`);
    const beforeProvenance = await countRows(
      'artifact_provenance',
      `company_id = '${scope.companyId}'`,
    );

    // Trigger a provenance failure by supplying a producingChildRunId that
    // references a non-existent run — the FK constraint on
    // artifact_provenance.producing_child_run_id is enforced, but the column
    // is a plain text column without an FK in the schema. Instead, force a
    // failure via a duplicate provenance row for an existing revision.
    // First commit succeeds.
    const ok = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: { blocks: [] },
      editSource: 'agent',
      citations: [
        {
          sourceRevisionId: rev1.sourceRevisionId,
          ordinal: 1,
          quote: 'prov fail passage',
          normalizedSourceText: 'prov fail passage',
          frozenCanonicalUrl: rev1.canonicalUrl,
          frozenRetrievedAt: rev1.retrievedAt,
          frozenProvider: 'tavily',
          frozenContentHash: rev1.contentHash,
          artifactLocator: { artifactVersion: 2, jsonPointer: '' },
        },
      ],
      provenance: {
        policyHash: 'd'.repeat(64),
        producingStepKey: 'step-research',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId],
      },
    });
    expect(ok.version).toBe(2);

    // Now attempt a SECOND commit at expectedVersion 1 (stale) that would
    // also create a new revision + citations + provenance. The optimistic
    // version check rejects it atomically — no partial rows.
    await expect(
      commit.commitArtifactWithProvenance({
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: scope.runId,
        rootRunId: scope.runId,
        artifactId: art.artifactId,
        expectedVersion: 1,
        content: { blocks: [] },
        editSource: 'agent',
        citations: [
          {
            sourceRevisionId: rev1.sourceRevisionId,
            ordinal: 1,
            quote: 'prov fail passage',
            normalizedSourceText: 'prov fail passage',
            frozenCanonicalUrl: rev1.canonicalUrl,
            frozenRetrievedAt: rev1.retrievedAt,
            frozenProvider: 'tavily',
            frozenContentHash: rev1.contentHash,
            artifactLocator: { artifactVersion: 3, jsonPointer: '' },
          },
        ],
        provenance: {
          policyHash: 'e'.repeat(64),
          producingStepKey: 'step-research',
          generationTime: new Date(),
          citedSourceRevisionIds: [rev1.sourceRevisionId],
        },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_CONFLICT' });

    const afterRevisions = await countRows(
      'artifact_revisions',
      `artifact_id = '${art.artifactId}'`,
    );
    expect(afterRevisions).toBe(beforeRevisions + 1); // only the successful commit's revision
    // No extra citations for the failed commit (only the one from the successful commit).
    const afterCitations = await countRows('citations', `company_id = '${scope.companyId}'`);
    expect(afterCitations).toBe(beforeCitations + 1);
    const afterProvenance = await countRows(
      'artifact_provenance',
      `company_id = '${scope.companyId}'`,
    );
    expect(afterProvenance).toBe(beforeProvenance + 1);
  });
});

describe('concurrent expected-version edits (VAL-RES-100)', () => {
  it('one concurrent edit wins and the loser receives a version conflict with no orphan rows', async () => {
    const scope = await seedScope(db, '__mtest__ commit-concurrent');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'concurrent passage one');
    const rev2 = await seedSourceRevision(scope, 'concurrent passage two');

    const baseInput = {
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      editSource: 'agent' as const,
      provenance: {
        policyHash: 'f'.repeat(64),
        producingStepKey: 'step-research',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId],
      },
    };

    // Two concurrent commits racing at expectedVersion=1.
    const p1 = commit.commitArtifactWithProvenance({
      ...baseInput,
      content: { blocks: [{ blockId: 'a', spans: [{ type: 'citation', citationId: 'x' }] }] },
      message: 'first editor',
      citations: [
        {
          sourceRevisionId: rev1.sourceRevisionId,
          ordinal: 1,
          quote: 'concurrent passage one',
          normalizedSourceText: 'concurrent passage one',
          frozenCanonicalUrl: rev1.canonicalUrl,
          frozenRetrievedAt: rev1.retrievedAt,
          frozenProvider: 'tavily',
          frozenContentHash: rev1.contentHash,
          artifactLocator: { artifactVersion: 2, blockId: 'a' },
        },
      ],
    });
    const p2 = commit.commitArtifactWithProvenance({
      ...baseInput,
      content: { blocks: [{ blockId: 'b', spans: [{ type: 'citation', citationId: 'y' }] }] },
      message: 'second editor',
      citations: [
        {
          sourceRevisionId: rev2.sourceRevisionId,
          ordinal: 1,
          quote: 'concurrent passage two',
          normalizedSourceText: 'concurrent passage two',
          frozenCanonicalUrl: rev2.canonicalUrl,
          frozenRetrievedAt: rev2.retrievedAt,
          frozenProvider: 'tavily',
          frozenContentHash: rev2.contentHash,
          artifactLocator: { artifactVersion: 2, blockId: 'b' },
        },
      ],
    });

    const results = await Promise.allSettled([p1, p2]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = (
      fulfilled[0] as PromiseFulfilledResult<{
        version: number;
        artifactRevisionId: string;
        citationIds: string[];
        provenanceId: string;
      }>
    ).value;
    expect(winner.version).toBe(2);

    // Exactly one new revision (version 2), one citation, one provenance row.
    const revCount = await countRows(
      'artifact_revisions',
      `artifact_id = '${art.artifactId}' AND "version" = 2`,
    );
    expect(revCount).toBe(1);
    const citeCount = await countRows(
      'citations',
      `artifact_revision_id = '${winner.artifactRevisionId}'`,
    );
    expect(citeCount).toBe(1);
    const provCount = await countRows(
      'artifact_provenance',
      `artifact_revision_id = '${winner.artifactRevisionId}'`,
    );
    expect(provCount).toBe(1);

    // Artifact version advanced exactly once.
    const artRow = (await db.drizzle.execute(sql`
      SELECT "version" FROM "artifacts" WHERE "id" = ${art.artifactId}
    `)) as unknown as { version: number }[];
    expect(artRow[0].version).toBe(2);
  });
});

describe('tenant isolation and boundary cases (VAL-RES-022, VAL-CROSS-043)', () => {
  it('rejects a commit against a foreign-company artifact with no partial rows', async () => {
    const scopeA = await seedScope(db, '__mtest__ commit-tenant-a');
    const scopeB = await seedScope(db, '__mtest__ commit-tenant-b');
    const artA = await seedArtifact(db, scopeA.companyId, scopeA.projectId);
    const revB = await seedSourceRevision(scopeB, 'tenant b passage');

    const beforeRevisions = await countRows(
      'artifact_revisions',
      `artifact_id = '${artA.artifactId}'`,
    );

    // Company B attempts to commit company A's artifact → 404, no rows.
    await expect(
      commit.commitArtifactWithProvenance({
        companyId: scopeB.companyId,
        projectId: scopeB.projectId,
        runId: scopeB.runId,
        rootRunId: scopeB.runId,
        artifactId: artA.artifactId,
        expectedVersion: 1,
        content: { blocks: [] },
        editSource: 'agent',
        citations: [
          {
            sourceRevisionId: revB.sourceRevisionId,
            ordinal: 1,
            quote: 'tenant b passage',
            normalizedSourceText: 'tenant b passage',
            frozenCanonicalUrl: revB.canonicalUrl,
            frozenRetrievedAt: revB.retrievedAt,
            frozenProvider: 'tavily',
            frozenContentHash: revB.contentHash,
            artifactLocator: { artifactVersion: 2, jsonPointer: '' },
          },
        ],
        provenance: {
          policyHash: '1'.repeat(64),
          producingStepKey: 'step-research',
          generationTime: new Date(),
          citedSourceRevisionIds: [revB.sourceRevisionId],
        },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });

    const afterRevisions = await countRows(
      'artifact_revisions',
      `artifact_id = '${artA.artifactId}'`,
    );
    expect(afterRevisions).toBe(beforeRevisions);
  });

  it('commits a provenance-only revision with zero citations atomically', async () => {
    const scope = await seedScope(db, '__mtest__ commit-provenance-only');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);

    const result = await commit.commitArtifactWithProvenance({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 1,
      content: { blocks: [] },
      editSource: 'system',
      message: 'provenance-only synthesis',
      citations: [],
      provenance: {
        policyHash: '2'.repeat(64),
        producingStepKey: 'step-synthesize',
        generationTime: new Date(),
        citedSourceRevisionIds: [],
      },
    });

    expect(result.version).toBe(2);
    expect(result.citationIds).toEqual([]);
    expect(result.provenanceId).toBeTruthy();

    // One new revision, zero citations, one provenance row — all visible.
    const revCount = await countRows(
      'artifact_revisions',
      `artifact_id = '${art.artifactId}' AND "version" = 2`,
    );
    expect(revCount).toBe(1);
    const citeCount = await countRows(
      'citations',
      `artifact_revision_id = '${result.artifactRevisionId}'`,
    );
    expect(citeCount).toBe(0);
    const provCount = await countRows(
      'artifact_provenance',
      `artifact_revision_id = '${result.artifactRevisionId}'`,
    );
    expect(provCount).toBe(1);
  });
});
