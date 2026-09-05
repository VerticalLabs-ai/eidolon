import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer, closeTestDb, closeTestServers } from '../test-utils.js';
import { SynthesisArtifactCreator } from '../services/mission/synthesis-artifact-creator.js';
import { ArtifactCommitService } from '../services/mission/research/artifact-commit-service.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';

/**
 * Regression tests for fix-ut-m5-artifact-id-source-aggregation.
 *
 * Issue 1: Artifact ID shows as null in API /artifacts response. The
 * artifact exists in the database (artifact.committed event present,
 * SynthesisArtifactCreator logs artifactId), but the API serializer
 * returns a null artifact ID. This prevents direct artifact access, UI
 * display, citation/provenance navigation, deep linking, and export.
 *
 * Issue 2: Root-level /sources endpoint returns 0 sources. Sources are
 * only visible at child run level. The root run's sources endpoint should
 * aggregate child sources (query run_research_sources by root_run_id).
 *
 * All tests use real Postgres on 127.0.0.1:55322.
 */

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

let db: AnyDb;
let server: Awaited<ReturnType<typeof createTestServer>>;
let sources: SourceRevisionService;
let commit: ArtifactCommitService;

beforeAll(async () => {
  db = await createTestDb();
  server = await createTestServer(db);
  sources = new SourceRevisionService({ drizzle: db.drizzle, schema: db.schema });
  commit = new ArtifactCommitService({ drizzle: db.drizzle, schema: db.schema });
});

afterAll(async () => {
  await closeTestServers();
  await closeTestDb();
});

// ---------------------------------------------------------------------------
// Seed helpers (mirrors mission-synthesis-artifact-wiring.test.ts)
// ---------------------------------------------------------------------------

async function seedScope(label: string) {
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

async function insertPolicySnapshot(companyId: string): Promise<string> {
  const id = randomUUID();
  const now = new Date();
  await db.drizzle.execute(sql`
    INSERT INTO "run_policy_snapshots" ("id", "company_id", "schema_version", "provider", "model", "tool_allowlist", "domain_allowlist", "research_policy", "planning_policy", "approval_policy", "fallback_policy", "partial_result_policy", "limits", "content_hash", "created_at")
    VALUES (${id}, ${companyId}, 1, 'anthropic', 'claude-sonnet-4-6', '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'require_all', '{"costCents": 5000, "durationSeconds": 3600, "providerCalls": 64, "totalTokens": 500000, "outputBytes": 10485760, "steps": 12, "depth": 2, "fanOut": 4, "descendants": 16}'::jsonb, ${randomUUID()}, ${now})
  `);
  return id;
}

async function insertRootRun(
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

async function insertBudgetReservation(companyId: string, runId: string): Promise<void> {
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

/** Set up a complete composite tree with approved plan, root run, and children. */
async function setupTree(
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
  const scope = await seedScope(label);
  const policyId = await insertPolicySnapshot(scope.companyId);
  const rootRunId = await insertRootRun(scope.companyId, scope.projectId, scope.threadId, policyId);
  const { revisionId, contentHash } = await insertPlanRevision(
    scope.companyId,
    scope.projectId,
    rootRunId,
  );
  await db.drizzle.execute(sql`
    UPDATE "mission_runs" SET "approved_plan_revision_id" = ${revisionId} WHERE "id" = ${rootRunId}
  `);
  await insertBudgetReservation(scope.companyId, rootRunId);

  const childRunIds: string[] = [];
  for (let i = 0; i < childCount; i++) {
    const childRunId = await insertChildRun(
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
  scope: { companyId: string; projectId: string },
  childRunId: string,
  rootRunId: string,
  title: string,
  url: string,
) {
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

  return sources.persistSourceRevision({
    companyId: scope.companyId,
    projectId: scope.projectId,
    runId: childRunId,
    rootRunId,
    logicalCallId: randomUUID(),
    provider: 'tavily',
    operation: 'search',
    source,
  });
}

function mockProviderCall() {
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

// ---------------------------------------------------------------------------
// Issue 1: Artifact ID is non-null in /artifacts response
// ---------------------------------------------------------------------------

describe('fix-ut-m5-artifact-id-source-aggregation: artifact API response includes non-null id', () => {
  it('returns a non-null artifactId in the /artifacts response for the root run', async () => {
    const tree = await setupTree('__mtest__ artifact-id-non-null', 2);
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    // Seed research sources for both children.
    await seedResearchSource(
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'Source A',
      'https://example.com/a',
    );
    await seedResearchSource(
      scope,
      tree.childRunIds[1]!,
      tree.rootRunId,
      'Source B',
      'https://example.com/b',
    );

    // Create synthesis artifact via SynthesisArtifactCreator (as the worker does).
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

    // Query the /artifacts API endpoint for the root run.
    const res = await request(server).get(
      `/api/companies/${tree.companyId}/projects/${tree.projectId}/mission-runs/${tree.rootRunId}/artifacts`,
    );

    expect(res.status).toBe(200);
    const artifacts = res.body.data.artifacts as Array<Record<string, unknown>>;
    expect(artifacts.length).toBeGreaterThanOrEqual(1);

    // The artifactId must be non-null (the bug: it was returning null).
    const artifact = artifacts[0]!;
    expect(artifact.artifactId).not.toBeNull();
    expect(artifact.artifactId).not.toBeUndefined();
    expect(typeof artifact.artifactId).toBe('string');
    expect(artifact.artifactId).toBe(result!.artifactId);

    // The artifactRevisionId must also be non-null for citation/provenance
    // navigation and deep linking.
    expect(artifact.artifactRevisionId).not.toBeNull();
    expect(typeof artifact.artifactRevisionId).toBe('string');
    expect(artifact.artifactRevisionId).toBe(result!.artifactRevisionId);

    // Citation count should be present and match.
    expect(artifact.citationCount).toBe(result!.citationIds.length);
  });

  it('returns 404 for a cross-scope run id in /artifacts', async () => {
    const tree = await setupTree('__mtest__ artifact-xscope', 1);
    const otherCompanyId = randomUUID();
    const otherProjectId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
      VALUES (${otherCompanyId}, 'other', 'active', 100000, 0, '{"testFixture": true}'::jsonb, ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
      VALUES (${otherProjectId}, ${otherCompanyId}, 'other', 'active', ${now}, ${now})
    `);

    const res = await request(server).get(
      `/api/companies/${otherCompanyId}/projects/${otherProjectId}/mission-runs/${tree.rootRunId}/artifacts`,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Issue 2: Root-level /sources endpoint aggregates child sources
// ---------------------------------------------------------------------------

describe('fix-ut-m5-artifact-id-source-aggregation: root-level /sources aggregates child sources', () => {
  it('returns aggregated sources from child runs at the root level', async () => {
    const tree = await setupTree('__mtest__ sources-aggregation', 3);
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    // Seed research sources for each child run (linked via run_research_sources
    // with run_id = childRunId, root_run_id = rootRunId).
    await seedResearchSource(
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'Child Source 1',
      'https://example.com/child-1',
    );
    await seedResearchSource(
      scope,
      tree.childRunIds[1]!,
      tree.rootRunId,
      'Child Source 2',
      'https://example.com/child-2',
    );
    await seedResearchSource(
      scope,
      tree.childRunIds[2]!,
      tree.rootRunId,
      'Child Source 3',
      'https://example.com/child-3',
    );

    // Query the /sources API endpoint for the ROOT run.
    const res = await request(server).get(
      `/api/companies/${tree.companyId}/projects/${tree.projectId}/mission-runs/${tree.rootRunId}/sources`,
    );

    expect(res.status).toBe(200);
    const sourceList = res.body.data.sources as Array<Record<string, unknown>>;

    // The root run should aggregate all child sources (3 sources across 3 children).
    expect(sourceList.length).toBe(3);

    // Each source should have a valid sourceRevisionId and canonicalUrl.
    for (const s of sourceList) {
      expect(typeof s.sourceRevisionId).toBe('string');
      expect(typeof s.canonicalUrl).toBe('string');
    }

    // The canonical URLs should include all child source URLs.
    const urls = sourceList.map((s) => s.canonicalUrl).sort();
    expect(urls).toEqual(
      [
        'https://example.com/child-1',
        'https://example.com/child-2',
        'https://example.com/child-3',
      ].sort(),
    );
  });

  it('returns sources for a child run directly (backward compatibility)', async () => {
    const tree = await setupTree('__mtest__ sources-child-direct', 2);
    const scope = { companyId: tree.companyId, projectId: tree.projectId };

    await seedResearchSource(
      scope,
      tree.childRunIds[0]!,
      tree.rootRunId,
      'Child A Source',
      'https://example.com/child-a',
    );
    await seedResearchSource(
      scope,
      tree.childRunIds[1]!,
      tree.rootRunId,
      'Child B Source',
      'https://example.com/child-b',
    );

    // Query the /sources API endpoint for a CHILD run.
    const res = await request(server).get(
      `/api/companies/${tree.companyId}/projects/${tree.projectId}/mission-runs/${tree.childRunIds[0]}/sources`,
    );

    expect(res.status).toBe(200);
    const sourceList = res.body.data.sources as Array<Record<string, unknown>>;
    expect(sourceList.length).toBe(1);
    expect(sourceList[0]!.canonicalUrl).toBe('https://example.com/child-a');
  });

  it('returns 404 for a cross-scope run id in /sources', async () => {
    const tree = await setupTree('__mtest__ sources-xscope', 1);
    const otherCompanyId = randomUUID();
    const otherProjectId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
      VALUES (${otherCompanyId}, 'other-s', 'active', 100000, 0, '{"testFixture": true}'::jsonb, ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
      VALUES (${otherProjectId}, ${otherCompanyId}, 'other-s', 'active', ${now}, ${now})
    `);

    const res = await request(server).get(
      `/api/companies/${otherCompanyId}/projects/${otherProjectId}/mission-runs/${tree.rootRunId}/sources`,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });
});
