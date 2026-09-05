import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, createTestServer, closeTestDb, closeTestServers } from '../test-utils.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import type { NormalizedResearchSource } from '../services/mission/research/spi.js';

/**
 * GET /api/companies/:companyId/projects/:projectId/mission-runs/:runId/sources
 *
 * Provider-neutral, bounded source summaries for the Mission source UI
 * (feature m5-f09-research-progress-source-ui; VAL-RES-001, VAL-RES-018,
 * VAL-RES-041, VAL-RES-047, VAL-RES-076, VAL-RES-105, VAL-RES-117,
 * VAL-CROSS-030, VAL-CROSS-034). Exposes only safe summary fields, plaintext
 * risk labels/warnings, exclusion metadata, and the latest availability-check
 * status — never full content, display metadata, credentials, or raw
 * provider payloads. Cross-scope run ids return a non-enumerating 404.
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
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${runId}, null, 0, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'summary', 'analyst', null, 'running', 5, 10, 'require_all', ${now}, ${now}, ${now})
  `);
  return { companyId, projectId, threadId, runId, now };
}

function makeSource(overrides: Partial<NormalizedResearchSource> = {}): NormalizedResearchSource {
  return {
    canonicalUrl: 'https://example.com/article-' + randomUUID().slice(0, 8),
    title: 'Quarterly Revenue Report',
    author: 'Jane Doe',
    publishedAt: '2026-08-24T00:00:00Z',
    rank: 0,
    score: 0.9,
    retrievedAt: '2026-08-24T12:00:00Z',
    mimeType: 'text/html',
    language: 'en',
    text: 'Revenue grew 12 percent year over year.',
    byteCount: 40,
    injectionRiskLabels: [],
    ...overrides,
  };
}

async function persistSource(
  scope: { companyId: string; projectId: string; runId: string },
  overrides: Partial<NormalizedResearchSource> = {},
  opts: {
    provider?: string;
    operation?: string;
    rank?: number;
    warnings?: string[];
  } = {},
) {
  return sources.persistSourceRevision({
    companyId: scope.companyId,
    projectId: scope.projectId,
    runId: scope.runId,
    rootRunId: scope.runId,
    logicalCallId: randomUUID(),
    provider: opts.provider ?? 'tavily',
    operation: opts.operation ?? 'search',
    source: makeSource(overrides),
    rank: opts.rank,
    warnings: opts.warnings,
  });
}

describe('GET .../mission-runs/:runId/sources', () => {
  it('returns provider-neutral bounded source summaries for both providers', async () => {
    const scope = await seedScope('sources-route-neutral');
    await persistSource(scope, {}, { provider: 'tavily', operation: 'search', rank: 0 });
    await persistSource(scope, {}, { provider: 'firecrawl', operation: 'scrape', rank: 1 });

    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/mission-runs/${scope.runId}/sources`,
    );
    expect(res.status).toBe(200);
    const list = res.body.data.sources as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    // Provider names appear as bounded metadata only.
    expect(list.map((s) => s.provider).sort()).toEqual(['firecrawl', 'tavily']);
    // Safe summary fields are present.
    for (const s of list) {
      expect(typeof s.sourceRevisionId).toBe('string');
      expect(typeof s.canonicalUrl).toBe('string');
      expect(typeof s.status).toBe('string');
      expect(Array.isArray(s.injectionRiskLabels)).toBe(true);
      expect(Array.isArray(s.warnings)).toBe(true);
      expect(typeof s.excluded).toBe('boolean');
    }
    // No full content, encrypted fields, or credentials are exposed.
    expect(JSON.stringify(res.body)).not.toContain('normalizedText');
    expect(JSON.stringify(res.body)).not.toContain('encrypted');
    expect(JSON.stringify(res.body)).not.toContain('title_encrypted');
    expect(JSON.stringify(res.body)).not.toContain('tvly-');
    expect(JSON.stringify(res.body)).not.toContain('Bearer ');
  });

  it('exposes injection risk labels and warnings for high-risk content', async () => {
    const scope = await seedScope('sources-route-risk');
    await persistSource(
      scope,
      { injectionRiskLabels: ['instruction_override', 'secret_exfiltration'] },
      { warnings: ['Content flagged as high-risk.'] },
    );

    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/mission-runs/${scope.runId}/sources`,
    );
    expect(res.status).toBe(200);
    const s = (res.body.data.sources as Array<Record<string, unknown>>)[0]!;
    expect(s.injectionRiskLabels).toEqual(['instruction_override', 'secret_exfiltration']);
    expect(s.warnings).toEqual(['Content flagged as high-risk.']);
  });

  it('exposes the latest availability-check status for an unavailable source', async () => {
    const scope = await seedScope('sources-route-unavail');
    const rev = await persistSource(scope);

    // Record an availability check marking the source unavailable.
    await db.drizzle.execute(sql`
      INSERT INTO "research_source_availability_checks"
        ("id","company_id","project_id","run_id","root_run_id","source_revision_id",
         "logical_call_id","attempt_id","checked_url","status","http_status",
         "warning","idempotency_key","created_at")
      VALUES
        (${randomUUID()}, ${scope.companyId}, ${scope.projectId}, ${scope.runId},
         ${scope.runId}, ${rev.sourceRevisionId},
         ${randomUUID()}, null, ${rev.canonicalUrl}, 'unavailable', 404,
         'Source unreachable', ${randomUUID()}, NOW())
    `);

    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/mission-runs/${scope.runId}/sources`,
    );
    expect(res.status).toBe(200);
    const s = (res.body.data.sources as Array<Record<string, unknown>>)[0]!;
    expect(s.latestAvailabilityStatus).toBe('unavailable');
    expect(typeof s.latestAvailabilityCheckedAt).toBe('string');
  });

  it('returns a non-enumerating 404 for a cross-project run id', async () => {
    // Two projects in the SAME company; the run belongs to project A.
    const companyId = randomUUID();
    const now = new Date();
    await db.drizzle.execute(sql`
      INSERT INTO "companies" ("id","name","status","budget_monthly_cents","spent_monthly_cents","settings","created_at","updated_at")
      VALUES (${companyId}, 'sources-route-xproj', 'active', 100000, 0, '{"testFixture": true}'::jsonb, ${now}, ${now})
    `);
    const projectA = randomUUID();
    const projectB = randomUUID();
    for (const pid of [projectA, projectB]) {
      await db.drizzle.execute(sql`
        INSERT INTO "projects" ("id","company_id","name","status","created_at","updated_at")
        VALUES (${pid}, ${companyId}, ${pid}, 'active', ${now}, ${now})
      `);
    }
    const threadA = randomUUID();
    const runA = randomUUID();
    await db.drizzle.execute(sql`
      INSERT INTO "project_threads" ("id","company_id","project_id","title","type","status","created_at","updated_at")
      VALUES (${threadA}, ${companyId}, ${projectA}, 'a', 'conversation', 'active', ${now}, ${now})
    `);
    await db.drizzle.execute(sql`
      INSERT INTO "mission_runs" ("id","company_id","project_id","project_thread_id","root_run_id","parent_run_id","depth","routing_kind","request_envelope","request_content_hash","request_safe_summary","resolved_mode","policy_snapshot_id","status","state_version","last_event_sequence","partial_result_policy","available_at","created_at","updated_at")
      VALUES (${runA}, ${companyId}, ${projectA}, ${threadA}, ${runA}, null, 0, 'company_agent', '{}'::jsonb, ${randomUUID()}, 'summary', 'analyst', null, 'running', 5, 10, 'require_all', ${now}, ${now}, ${now})
    `);
    const scopeA = { companyId, projectId: projectA, runId: runA };
    await persistSource(scopeA);

    // Request the run through project B's route (same company).
    const res = await request(server).get(
      `/api/companies/${companyId}/projects/${projectB}/mission-runs/${runA}/sources`,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('returns a non-enumerating 404 for a cross-company run id', async () => {
    const scopeA = await seedScope('sources-route-xco-a');
    const scopeB = await seedScope('sources-route-xco-b');
    await persistSource(scopeA);

    const res = await request(server).get(
      `/api/companies/${scopeB.companyId}/projects/${scopeB.projectId}/mission-runs/${scopeA.runId}/sources`,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('RUN_NOT_FOUND');
  });

  it('returns an empty source list for a run with no sources', async () => {
    const scope = await seedScope('sources-route-empty');
    const res = await request(server).get(
      `/api/companies/${scope.companyId}/projects/${scope.projectId}/mission-runs/${scope.runId}/sources`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.sources).toEqual([]);
    expect(res.body.data.runId).toBe(scope.runId);
  });
});
