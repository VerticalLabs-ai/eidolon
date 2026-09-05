import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { ArtifactCommitService } from '../services/mission/research/artifact-commit-service.js';
import { CitationCarryForwardService } from '../services/mission/research/citation-carry-forward-service.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * Verified citation carry-forward and revision restoration.
 *
 * (VAL-RES-034, VAL-RES-099, VAL-CROSS-042)
 *
 * Edits and restorations create new immutable revisions and new citation
 * identities only when locators still verify. Unverifiable citations remain
 * historical and are marked not carried forward.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let sources: SourceRevisionService;
let commit: ArtifactCommitService;
let carryForward: CitationCarryForwardService;

beforeAll(async () => {
  db = await createTestDb();
  sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
  commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
  carryForward = new CitationCarryForwardService({ drizzle: db.drizzle, schema: db.schema });
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

/**
 * Commit an initial revision with citations and return the result.
 */
async function commitInitialWithCitations(
  scope: { companyId: string; projectId: string; runId: string },
  art: { artifactId: string },
  content: Record<string, unknown>,
  citations: Array<{
    sourceRevisionId: string;
    ordinal: number;
    quote: string;
    sourceText: string;
    frozenCanonicalUrl: string;
    frozenRetrievedAt: string;
    frozenContentHash?: string;
    artifactLocator: Record<string, unknown>;
  }>,
) {
  return commit.commitArtifactWithProvenance({
    companyId: scope.companyId,
    projectId: scope.projectId,
    runId: scope.runId,
    rootRunId: scope.runId,
    artifactId: art.artifactId,
    expectedVersion: 1,
    content,
    editSource: 'agent',
    message: 'initial synthesis',
    citations: citations.map((c) => ({
      sourceRevisionId: c.sourceRevisionId,
      ordinal: c.ordinal,
      quote: c.quote,
      normalizedSourceText: c.sourceText,
      frozenCanonicalUrl: c.frozenCanonicalUrl,
      frozenRetrievedAt: c.frozenRetrievedAt,
      frozenProvider: 'tavily',
      frozenContentHash: c.frozenContentHash,
      frozenTitle: 'Source Title',
      artifactLocator: c.artifactLocator,
    })),
    provenance: {
      policyHash: 'a'.repeat(64),
      producingStepKey: 'step-research',
      generationTime: new Date(),
      citedSourceRevisionIds: citations.map((c) => c.sourceRevisionId),
    },
  });
}

async function countRows(table: string, where: string): Promise<number> {
  const rows = (await db.drizzle.execute(
    sql.raw(`SELECT count(*)::int AS c FROM "${table}" WHERE ${where}`),
  )) as unknown as { c: number }[];
  return rows[0]?.c ?? 0;
}

// ---------------------------------------------------------------------------
// Tests: carry-forward on edit (VAL-RES-034, VAL-CROSS-042)
// ---------------------------------------------------------------------------

describe('CitationCarryForwardService.commitWithCarryForward (VAL-RES-034, VAL-CROSS-042)', () => {
  it('carries forward citations whose cited passage is unchanged in the new revision', async () => {
    const scope = await seedScope(db, '__mtest__ carry-unchanged');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'alpha passage content');
    const rev2 = await seedSourceRevision(scope, 'beta passage content');

    // Initial revision: two citation marks in two blocks.
    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'placeholder-1', text: 'alpha passage content' }],
        },
        {
          blockId: 'b2',
          spans: [{ type: 'citation', citationId: 'placeholder-2', text: 'beta passage content' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scope, art, contentV1, [
      {
        sourceRevisionId: rev1.sourceRevisionId,
        ordinal: 1,
        quote: 'alpha passage content',
        sourceText: 'alpha passage content',
        frozenCanonicalUrl: rev1.canonicalUrl,
        frozenRetrievedAt: rev1.retrievedAt,
        frozenContentHash: rev1.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
      {
        sourceRevisionId: rev2.sourceRevisionId,
        ordinal: 2,
        quote: 'beta passage content',
        sourceText: 'beta passage content',
        frozenCanonicalUrl: rev2.canonicalUrl,
        frozenRetrievedAt: rev2.retrievedAt,
        frozenContentHash: rev2.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b2' },
      },
    ]);
    expect(initial.version).toBe(2);

    // New revision: both blocks unchanged (same citation marks).
    const contentV2 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'placeholder-1', text: 'alpha passage content' }],
        },
        {
          blockId: 'b2',
          spans: [{ type: 'citation', citationId: 'placeholder-2', text: 'beta passage content' }],
        },
      ],
    };

    const result = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: initial.artifactRevisionId,
      content: contentV2,
      editSource: 'user',
      message: 'edit preserving citations',
      provenance: {
        policyHash: 'b'.repeat(64),
        producingStepKey: 'step-edit',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId, rev2.sourceRevisionId],
      },
    });

    expect(result.version).toBe(3);
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.every((o) => o.outcome === 'carried_forward')).toBe(true);

    // New citation rows are bound to the new revision with distinct IDs.
    const newCites = (await db.drizzle.execute(sql`
      SELECT "id","ordinal","source_revision_id","artifact_revision_id"
      FROM "citations" WHERE "artifact_revision_id" = ${result.artifactRevisionId}
      ORDER BY "ordinal" ASC
    `)) as unknown as {
      id: string;
      ordinal: number;
      source_revision_id: string;
      artifact_revision_id: string;
    }[];
    expect(newCites).toHaveLength(2);
    expect(newCites[0].source_revision_id).toBe(rev1.sourceRevisionId);
    expect(newCites[1].source_revision_id).toBe(rev2.sourceRevisionId);
    expect(
      newCites.every((c) => c.id !== initial.citationIds[0] && c.id !== initial.citationIds[1]),
    ).toBe(true);

    // Carry-forward outcomes recorded.
    const outcomes = (await db.drizzle.execute(sql`
      SELECT "previous_citation_id","new_citation_id","outcome","reason"
      FROM "citation_carry_forward_outcomes"
      WHERE "new_artifact_revision_id" = ${result.artifactRevisionId}
      ORDER BY "created_at"
    `)) as unknown as {
      previous_citation_id: string;
      new_citation_id: string | null;
      outcome: string;
      reason: string | null;
    }[];
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.outcome === 'carried_forward')).toBe(true);
    expect(outcomes.every((o) => o.new_citation_id !== null)).toBe(true);
  });

  it('does NOT carry forward citations whose cited passage was changed (stale outcome)', async () => {
    const scope = await seedScope(db, '__mtest__ carry-changed');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'original passage text');
    const rev2 = await seedSourceRevision(scope, 'stable passage text');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'original passage text' }],
        },
        {
          blockId: 'b2',
          spans: [{ type: 'citation', citationId: 'c2', text: 'stable passage text' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scope, art, contentV1, [
      {
        sourceRevisionId: rev1.sourceRevisionId,
        ordinal: 1,
        quote: 'original passage text',
        sourceText: 'original passage text',
        frozenCanonicalUrl: rev1.canonicalUrl,
        frozenRetrievedAt: rev1.retrievedAt,
        frozenContentHash: rev1.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
      {
        sourceRevisionId: rev2.sourceRevisionId,
        ordinal: 2,
        quote: 'stable passage text',
        sourceText: 'stable passage text',
        frozenCanonicalUrl: rev2.canonicalUrl,
        frozenRetrievedAt: rev2.retrievedAt,
        frozenContentHash: rev2.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b2' },
      },
    ]);

    // New revision: b1 citation mark REMOVED (passage changed), b2 unchanged.
    const contentV2 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'text', text: 'rewritten passage without citation' }],
        },
        {
          blockId: 'b2',
          spans: [{ type: 'citation', citationId: 'c2', text: 'stable passage text' }],
        },
      ],
    };

    const result = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: initial.artifactRevisionId,
      content: contentV2,
      editSource: 'user',
      message: 'edit changing b1',
      provenance: {
        policyHash: 'c'.repeat(64),
        producingStepKey: 'step-edit',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev2.sourceRevisionId],
      },
    });

    expect(result.version).toBe(3);
    expect(result.outcomes).toHaveLength(2);

    // First citation (b1) not carried forward; second (b2) carried forward.
    const notCarried = result.outcomes.find((o) => o.outcome === 'not_carried_forward');
    const carried = result.outcomes.find((o) => o.outcome === 'carried_forward');
    expect(notCarried).toBeDefined();
    expect(carried).toBeDefined();
    expect(notCarried!.reason).toContain('ARTIFACT_LOCATOR');
    expect(notCarried!.newCitationId).toBeUndefined();
    expect(carried!.newCitationId).toBeDefined();

    // Only one new citation row (the carried one).
    const newCites = (await db.drizzle.execute(sql`
      SELECT "source_revision_id" FROM "citations"
      WHERE "artifact_revision_id" = ${result.artifactRevisionId}
    `)) as unknown as { source_revision_id: string }[];
    expect(newCites).toHaveLength(1);
    expect(newCites[0].source_revision_id).toBe(rev2.sourceRevisionId);

    // The original citation for b1 remains historical (bound to initial revision).
    const historicalCites = (await db.drizzle.execute(sql`
      SELECT "source_revision_id","artifact_revision_id" FROM "citations"
      WHERE "artifact_revision_id" = ${initial.artifactRevisionId}
      ORDER BY "ordinal"
    `)) as unknown as { source_revision_id: string; artifact_revision_id: string }[];
    expect(historicalCites).toHaveLength(2);
    expect(historicalCites[0].source_revision_id).toBe(rev1.sourceRevisionId);

    // Outcome for b1 is not_carried_forward with a reason.
    const outcomes = (await db.drizzle.execute(sql`
      SELECT "outcome","reason" FROM "citation_carry_forward_outcomes"
      WHERE "new_artifact_revision_id" = ${result.artifactRevisionId}
      ORDER BY "created_at"
    `)) as unknown as { outcome: string; reason: string | null }[];
    expect(outcomes).toHaveLength(2);
    expect(outcomes.some((o) => o.outcome === 'not_carried_forward' && o.reason)).toBe(true);
    expect(outcomes.some((o) => o.outcome === 'carried_forward')).toBe(true);
  });

  it('creates distinct citation rows with new citation IDs (no ID reuse)', async () => {
    const scope = await seedScope(db, '__mtest__ carry-distinct-ids');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'distinct passage');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'distinct passage' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scope, art, contentV1, [
      {
        sourceRevisionId: rev1.sourceRevisionId,
        ordinal: 1,
        quote: 'distinct passage',
        sourceText: 'distinct passage',
        frozenCanonicalUrl: rev1.canonicalUrl,
        frozenRetrievedAt: rev1.retrievedAt,
        frozenContentHash: rev1.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
    ]);

    const result = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: initial.artifactRevisionId,
      content: contentV1,
      editSource: 'user',
      provenance: {
        policyHash: 'd'.repeat(64),
        producingStepKey: 'step-edit',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId],
      },
    });

    // The new citation ID is different from the original.
    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].newCitationId).not.toBe(initial.citationIds[0]);
    expect(result.outcomes[0].newCitationId).toBeDefined();
  });

  it('stable historical links: original citations remain bound to their original revision', async () => {
    const scope = await seedScope(db, '__mtest__ carry-historical-links');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'historical passage');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'historical passage' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scope, art, contentV1, [
      {
        sourceRevisionId: rev1.sourceRevisionId,
        ordinal: 1,
        quote: 'historical passage',
        sourceText: 'historical passage',
        frozenCanonicalUrl: rev1.canonicalUrl,
        frozenRetrievedAt: rev1.retrievedAt,
        frozenContentHash: rev1.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
    ]);

    // Edit: remove the citation mark.
    const contentV2 = {
      blocks: [{ blockId: 'b1', spans: [{ type: 'text', text: 'no citation' }] }],
    };

    const result = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: initial.artifactRevisionId,
      content: contentV2,
      editSource: 'user',
      provenance: {
        policyHash: 'e'.repeat(64),
        producingStepKey: 'step-edit',
        generationTime: new Date(),
        citedSourceRevisionIds: [],
      },
    });

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].outcome).toBe('not_carried_forward');

    // The original citation row is STILL bound to the initial revision.
    const originalCite = (await db.drizzle.execute(sql`
      SELECT "id","artifact_revision_id","source_revision_id"
      FROM "citations" WHERE "id" = ${initial.citationIds[0]}
    `)) as unknown as { id: string; artifact_revision_id: string; source_revision_id: string }[];
    expect(originalCite).toHaveLength(1);
    expect(originalCite[0].artifact_revision_id).toBe(initial.artifactRevisionId);
    expect(originalCite[0].source_revision_id).toBe(rev1.sourceRevisionId);

    // No new citations in the new revision.
    const newCites = await countRows(
      'citations',
      `artifact_revision_id = '${result.artifactRevisionId}'`,
    );
    expect(newCites).toBe(0);
  });

  it('rejects a stale expected-version with no partial rows', async () => {
    const scope = await seedScope(db, '__mtest__ carry-stale-version');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'stale version passage');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'stale version passage' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scope, art, contentV1, [
      {
        sourceRevisionId: rev1.sourceRevisionId,
        ordinal: 1,
        quote: 'stale version passage',
        sourceText: 'stale version passage',
        frozenCanonicalUrl: rev1.canonicalUrl,
        frozenRetrievedAt: rev1.retrievedAt,
        frozenContentHash: rev1.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
    ]);

    const beforeOutcomes = await countRows(
      'citation_carry_forward_outcomes',
      `company_id = '${scope.companyId}'`,
    );

    // Attempt carry-forward with stale expectedVersion=2 (but current is already 2, so this would advance to 3).
    // First do a successful carry-forward to advance to 3.
    const result1 = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: initial.artifactRevisionId,
      content: contentV1,
      editSource: 'user',
      provenance: {
        policyHash: 'f'.repeat(64),
        producingStepKey: 'step-edit',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId],
      },
    });
    expect(result1.version).toBe(3);

    // Now attempt another carry-forward with stale expectedVersion=2 (current is 3).
    await expect(
      carryForward.commitWithCarryForward({
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: scope.runId,
        rootRunId: scope.runId,
        artifactId: art.artifactId,
        expectedVersion: 2,
        previousArtifactRevisionId: result1.artifactRevisionId,
        content: contentV1,
        editSource: 'user',
        provenance: {
          policyHash: '1'.repeat(64),
          producingStepKey: 'step-edit',
          generationTime: new Date(),
          citedSourceRevisionIds: [rev1.sourceRevisionId],
        },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_VERSION_CONFLICT' });

    // No extra outcomes were written for the failed attempt.
    const afterOutcomes = await countRows(
      'citation_carry_forward_outcomes',
      `company_id = '${scope.companyId}'`,
    );
    expect(afterOutcomes).toBe(beforeOutcomes + 1); // only the successful one
  });

  it('rejects a cross-tenant carry-forward with no partial rows', async () => {
    const scopeA = await seedScope(db, '__mtest__ carry-tenant-a');
    const scopeB = await seedScope(db, '__mtest__ carry-tenant-b');
    const artA = await seedArtifact(db, scopeA.companyId, scopeA.projectId);
    const revA = await seedSourceRevision(scopeA, 'tenant a passage');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'tenant a passage' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scopeA, artA, contentV1, [
      {
        sourceRevisionId: revA.sourceRevisionId,
        ordinal: 1,
        quote: 'tenant a passage',
        sourceText: 'tenant a passage',
        frozenCanonicalUrl: revA.canonicalUrl,
        frozenRetrievedAt: revA.retrievedAt,
        frozenContentHash: revA.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
    ]);

    // Company B attempts to carry forward company A's artifact.
    await expect(
      carryForward.commitWithCarryForward({
        companyId: scopeB.companyId,
        projectId: scopeB.projectId,
        runId: scopeB.runId,
        rootRunId: scopeB.runId,
        artifactId: artA.artifactId,
        expectedVersion: 2,
        previousArtifactRevisionId: initial.artifactRevisionId,
        content: contentV1,
        editSource: 'user',
        provenance: {
          policyHash: '2'.repeat(64),
          producingStepKey: 'step-edit',
          generationTime: new Date(),
          citedSourceRevisionIds: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Tests: revision restoration (VAL-RES-099)
// ---------------------------------------------------------------------------

describe('CitationCarryForwardService.restoreRevision (VAL-RES-099)', () => {
  it('restoring a cited revision creates a new revision with verified citation rows', async () => {
    const scope = await seedScope(db, '__mtest__ restore-basic');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'restore passage one');
    const rev2 = await seedSourceRevision(scope, 'restore passage two');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'restore passage one' }],
        },
        {
          blockId: 'b2',
          spans: [{ type: 'citation', citationId: 'c2', text: 'restore passage two' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scope, art, contentV1, [
      {
        sourceRevisionId: rev1.sourceRevisionId,
        ordinal: 1,
        quote: 'restore passage one',
        sourceText: 'restore passage one',
        frozenCanonicalUrl: rev1.canonicalUrl,
        frozenRetrievedAt: rev1.retrievedAt,
        frozenContentHash: rev1.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
      {
        sourceRevisionId: rev2.sourceRevisionId,
        ordinal: 2,
        quote: 'restore passage two',
        sourceText: 'restore passage two',
        frozenCanonicalUrl: rev2.canonicalUrl,
        frozenRetrievedAt: rev2.retrievedAt,
        frozenContentHash: rev2.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b2' },
      },
    ]);

    // Edit: remove all citation marks (advance to v3).
    const contentV2 = {
      blocks: [{ blockId: 'b1', spans: [{ type: 'text', text: 'no citations' }] }],
    };
    const edited = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: initial.artifactRevisionId,
      content: contentV2,
      editSource: 'user',
      message: 'edit removing citations',
      provenance: {
        policyHash: '3'.repeat(64),
        producingStepKey: 'step-edit',
        generationTime: new Date(),
        citedSourceRevisionIds: [],
      },
    });
    expect(edited.version).toBe(3);
    expect(edited.outcomes.every((o) => o.outcome === 'not_carried_forward')).toBe(true);

    // Now RESTORE the initial revision (v2). The restored content has the
    // citation marks, so all citations should carry forward.
    const restored = await carryForward.restoreRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 3,
      restoreFromRevisionId: initial.artifactRevisionId,
      editSource: 'user',
      message: 'restoring initial revision',
      provenance: {
        policyHash: '4'.repeat(64),
        producingStepKey: 'step-restore',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId, rev2.sourceRevisionId],
      },
    });

    expect(restored.version).toBe(4);
    expect(restored.outcomes).toHaveLength(2);
    expect(restored.outcomes.every((o) => o.outcome === 'carried_forward')).toBe(true);

    // New citation rows are bound to the restored revision.
    const restoredCites = (await db.drizzle.execute(sql`
      SELECT "source_revision_id","artifact_revision_id","ordinal"
      FROM "citations" WHERE "artifact_revision_id" = ${restored.artifactRevisionId}
      ORDER BY "ordinal"
    `)) as unknown as {
      source_revision_id: string;
      artifact_revision_id: string;
      ordinal: number;
    }[];
    expect(restoredCites).toHaveLength(2);
    expect(restoredCites[0].source_revision_id).toBe(rev1.sourceRevisionId);
    expect(restoredCites[1].source_revision_id).toBe(rev2.sourceRevisionId);
  });

  it('restoration creates a NEW immutable revision (not a reuse of the old one)', async () => {
    const scope = await seedScope(db, '__mtest__ restore-new-revision');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'new revision passage');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'new revision passage' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scope, art, contentV1, [
      {
        sourceRevisionId: rev1.sourceRevisionId,
        ordinal: 1,
        quote: 'new revision passage',
        sourceText: 'new revision passage',
        frozenCanonicalUrl: rev1.canonicalUrl,
        frozenRetrievedAt: rev1.retrievedAt,
        frozenContentHash: rev1.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
    ]);

    const restored = await carryForward.restoreRevision({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      restoreFromRevisionId: initial.artifactRevisionId,
      editSource: 'system',
      message: 'restoration',
      provenance: {
        policyHash: '5'.repeat(64),
        producingStepKey: 'step-restore',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId],
      },
    });

    // New version, new revision ID.
    expect(restored.version).toBe(3);
    expect(restored.artifactRevisionId).not.toBe(initial.artifactRevisionId);

    // Both revisions exist in artifact_revisions (seed v1, initial commit v2, restored v3).
    const revs = (await db.drizzle.execute(sql`
      SELECT "id","version" FROM "artifact_revisions"
      WHERE "artifact_id" = ${art.artifactId} ORDER BY "version"
    `)) as unknown as { id: string; version: number }[];
    expect(revs).toHaveLength(3);
    expect(revs[2].version).toBe(3);
    expect(revs[2].id).toBe(restored.artifactRevisionId);
  });

  it('restoration from a non-existent revision fails with no partial rows', async () => {
    const scope = await seedScope(db, '__mtest__ restore-not-found');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);

    const beforeRevisions = await countRows(
      'artifact_revisions',
      `artifact_id = '${art.artifactId}'`,
    );

    await expect(
      carryForward.restoreRevision({
        companyId: scope.companyId,
        projectId: scope.projectId,
        runId: scope.runId,
        rootRunId: scope.runId,
        artifactId: art.artifactId,
        expectedVersion: 1,
        restoreFromRevisionId: randomUUID(),
        editSource: 'system',
        provenance: {
          policyHash: '6'.repeat(64),
          producingStepKey: 'step-restore',
          generationTime: new Date(),
          citedSourceRevisionIds: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'REVISION_NOT_FOUND' });

    const afterRevisions = await countRows(
      'artifact_revisions',
      `artifact_id = '${art.artifactId}'`,
    );
    expect(afterRevisions).toBe(beforeRevisions);
  });
});

// ---------------------------------------------------------------------------
// Tests: listOutcomes
// ---------------------------------------------------------------------------

describe('CitationCarryForwardService.listOutcomes', () => {
  it('lists carry-forward outcomes scoped by company and project', async () => {
    const scope = await seedScope(db, '__mtest__ list-outcomes');
    const art = await seedArtifact(db, scope.companyId, scope.projectId);
    const rev1 = await seedSourceRevision(scope, 'list outcomes passage');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'list outcomes passage' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scope, art, contentV1, [
      {
        sourceRevisionId: rev1.sourceRevisionId,
        ordinal: 1,
        quote: 'list outcomes passage',
        sourceText: 'list outcomes passage',
        frozenCanonicalUrl: rev1.canonicalUrl,
        frozenRetrievedAt: rev1.retrievedAt,
        frozenContentHash: rev1.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
    ]);

    const result = await carryForward.commitWithCarryForward({
      companyId: scope.companyId,
      projectId: scope.projectId,
      runId: scope.runId,
      rootRunId: scope.runId,
      artifactId: art.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: initial.artifactRevisionId,
      content: contentV1,
      editSource: 'user',
      provenance: {
        policyHash: '7'.repeat(64),
        producingStepKey: 'step-edit',
        generationTime: new Date(),
        citedSourceRevisionIds: [rev1.sourceRevisionId],
      },
    });

    const outcomes = await carryForward.listOutcomes(
      scope.companyId,
      scope.projectId,
      result.artifactRevisionId,
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toBe('carried_forward');
    expect(outcomes[0].newCitationId).toBeDefined();
  });

  it('returns empty for a cross-scope revision', async () => {
    const scopeA = await seedScope(db, '__mtest__ list-cross-a');
    const scopeB = await seedScope(db, '__mtest__ list-cross-b');
    const artA = await seedArtifact(db, scopeA.companyId, scopeA.projectId);
    const revA = await seedSourceRevision(scopeA, 'cross scope passage');

    const contentV1 = {
      blocks: [
        {
          blockId: 'b1',
          spans: [{ type: 'citation', citationId: 'c1', text: 'cross scope passage' }],
        },
      ],
    };

    const initial = await commitInitialWithCitations(scopeA, artA, contentV1, [
      {
        sourceRevisionId: revA.sourceRevisionId,
        ordinal: 1,
        quote: 'cross scope passage',
        sourceText: 'cross scope passage',
        frozenCanonicalUrl: revA.canonicalUrl,
        frozenRetrievedAt: revA.retrievedAt,
        frozenContentHash: revA.contentHash,
        artifactLocator: { artifactVersion: 2, blockId: 'b1' },
      },
    ]);

    const result = await carryForward.commitWithCarryForward({
      companyId: scopeA.companyId,
      projectId: scopeA.projectId,
      runId: scopeA.runId,
      rootRunId: scopeA.runId,
      artifactId: artA.artifactId,
      expectedVersion: 2,
      previousArtifactRevisionId: initial.artifactRevisionId,
      content: contentV1,
      editSource: 'user',
      provenance: {
        policyHash: '8'.repeat(64),
        producingStepKey: 'step-edit',
        generationTime: new Date(),
        citedSourceRevisionIds: [revA.sourceRevisionId],
      },
    });

    // Company B cannot see company A's outcomes.
    const outcomes = await carryForward.listOutcomes(
      scopeB.companyId,
      scopeB.projectId,
      result.artifactRevisionId,
    );
    expect(outcomes).toHaveLength(0);
  });
});
