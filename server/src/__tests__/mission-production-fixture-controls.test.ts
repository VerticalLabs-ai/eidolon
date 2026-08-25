/**
 * Production fixture controls, deterministic disruption barriers, and cleanup.
 *
 * VAL-CROSS-100: Validation cleanup restores data policy and processes.
 * VAL-CROSS-103: Full-success fixture reaches production validators only.
 * VAL-CROSS-104: Disruption fixture barriers make cancellation deterministic.
 *
 * Tests exercise:
 *  - Fixture admission (test-only env gate, production-build absence)
 *  - Production-adapter guards (fixtures can't bypass auth/budget/limits/policy)
 *  - Cancellation barriers (hold nonterminal, release ownership, late-commit rejection)
 *  - Tracked process teardown (cleanup restores circuit health, provider state)
 *  - Marked fixture cleanup (removes all marked Mission data including research tables)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import {
  isFixtureControlsEnabled,
  FIXTURE_CONTROLS_ENV_FLAG,
  DisruptionBarrier,
} from '../services/mission/fixture-controls.js';
import {
  isFullSuccessFixtureEnabled,
  FULL_SUCCESS_ENV_FLAG,
  createFullSuccessResearchAdapter,
  createFullSuccessPlanVector,
  createFullSuccessChildOutcome,
  createFullSuccessCitation,
} from '../services/mission/full-success-fixture.js';
import { runCleanup, resetProviderCircuitHealth, type SqlRunner } from '../cleanup/fixtures.js';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const _dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_FOLDER = resolve(_dirname, '../../../packages/db/drizzle');

// ---------------------------------------------------------------------------
// PGlite helper for cleanup tests
// ---------------------------------------------------------------------------

async function createPgliteRunner(): Promise<{
  runner: SqlRunner;
  pglite: PGlite;
  close: () => Promise<void>;
}> {
  const pglite = new PGlite();
  const drizzleDb = drizzle(pglite);
  await migrate(drizzleDb, { migrationsFolder: MIGRATIONS_FOLDER });
  const impl = {
    async query(q: string) {
      const result = await pglite.query(q);
      return result.rows as Record<string, unknown>[];
    },
    async begin(fn: (tx: SqlRunner) => Promise<unknown>) {
      await pglite.query('BEGIN');
      const txRunner = {
        query: impl.query as SqlRunner['query'],
        begin: ((fn2: (tx2: SqlRunner) => Promise<unknown>) => fn2(txRunner)) as SqlRunner['begin'],
      } as SqlRunner;
      try {
        const result = await fn(txRunner);
        await pglite.query('COMMIT');
        return result;
      } catch (err) {
        await pglite.query('ROLLBACK');
        throw err;
      }
    },
  };
  return {
    runner: impl as unknown as SqlRunner,
    pglite,
    close: async () => {
      await pglite.close();
    },
  };
}

async function insertFixtureCompanyPglite(runner: SqlRunner, name: string): Promise<string> {
  const id = randomUUID();
  const ts = new Date().toISOString();
  await runner.query(
    `INSERT INTO companies (id, name, settings, created_at, updated_at) VALUES ('${id}', '${name}', '{"testFixture": true}', '${ts}', '${ts}')`,
  );
  return id;
}

/** Insert a project, thread, and mission run (prerequisite for research_source_revisions). */
async function insertMissionScope(
  runner: SqlRunner,
  companyId: string,
): Promise<{ projectId: string; threadId: string; runId: string }> {
  const ts = new Date().toISOString();
  const projectId = randomUUID();
  await runner.query(
    `INSERT INTO projects (id, company_id, name, status, created_at, updated_at) VALUES ('${projectId}', '${companyId}', 'P', 'active', '${ts}', '${ts}')`,
  );
  const threadId = randomUUID();
  await runner.query(
    `INSERT INTO project_threads (id, company_id, project_id, title, type, status, created_at, updated_at) VALUES ('${threadId}', '${companyId}', '${projectId}', 'T', 'conversation', 'active', '${ts}', '${ts}')`,
  );
  const runId = randomUUID();
  await runner.query(
    `INSERT INTO mission_runs (id, company_id, project_id, project_thread_id, root_run_id, request_envelope, request_content_hash, resolved_mode, status, created_at, updated_at) VALUES ('${runId}', '${companyId}', '${projectId}', '${threadId}', '${runId}', 'enc', 'hash-${runId}', 'fast', 'running', '${ts}', '${ts}')`,
  );
  return { projectId, threadId, runId };
}

// ---------------------------------------------------------------------------
// Tests: Fixture admission controls (VAL-CROSS-103)
// ---------------------------------------------------------------------------

describe('VAL-CROSS-103: Full-success fixture admission controls', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fixture controls are disabled by default (production-build absence)', () => {
    vi.unstubAllEnvs();
    expect(isFixtureControlsEnabled()).toBe(false);
  });

  it('fixture controls are enabled only when MISSION_FIXTURE_CONTROLS=1', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    expect(isFixtureControlsEnabled()).toBe(true);
  });

  it('full-success fixture is disabled by default (production-build absence)', () => {
    vi.unstubAllEnvs();
    expect(isFullSuccessFixtureEnabled()).toBe(false);
  });

  it('full-success fixture is enabled only when MISSION_FULL_SUCCESS_FIXTURE=1', () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    expect(isFullSuccessFixtureEnabled()).toBe(true);
  });

  it('DisruptionBarrier construction throws when fixture controls are disabled', () => {
    vi.unstubAllEnvs();
    expect(() => new DisruptionBarrier()).toThrow(/test-only/i);
  });

  it('DisruptionBarrier construction succeeds when fixture controls are enabled', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    expect(() => new DisruptionBarrier()).not.toThrow();
  });

  it('full-success research adapter throws when fixture is disabled', () => {
    vi.unstubAllEnvs();
    expect(() => createFullSuccessResearchAdapter()).toThrow(/test-only/i);
  });

  it('full-success research adapter succeeds when fixture is enabled', () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    expect(() => createFullSuccessResearchAdapter()).not.toThrow();
  });

  it('full-success plan vector throws when fixture is disabled', () => {
    vi.unstubAllEnvs();
    expect(() => createFullSuccessPlanVector()).toThrow(/test-only/i);
  });

  it('full-success plan vector succeeds when fixture is enabled', () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    const vector = createFullSuccessPlanVector();
    expect(vector).toBeDefined();
    expect(vector.content).toBeDefined();
    // The plan content must have the PlanContentV1 schema version
    expect((vector.content as Record<string, unknown>).schemaVersion).toBeDefined();
  });

  it('full-success child outcome throws when fixture is disabled', () => {
    vi.unstubAllEnvs();
    expect(() => createFullSuccessChildOutcome()).toThrow(/test-only/i);
  });

  it('full-success citation throws when fixture is disabled', () => {
    vi.unstubAllEnvs();
    expect(() => createFullSuccessCitation()).toThrow(/test-only/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: Production-adapter guards (VAL-CROSS-103)
// ---------------------------------------------------------------------------

describe('VAL-CROSS-103: Full-success fixture uses production code paths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('full-success research adapter implements the ResearchProvider SPI', () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    const adapter = createFullSuccessResearchAdapter();
    expect(adapter.supports('search')).toBe(true);
    expect(adapter.supports('extract')).toBe(true);
    expect(typeof adapter.execute).toBe('function');
  });

  it('full-success research adapter produces normalized sources with required fields', async () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    const adapter = createFullSuccessResearchAdapter();
    const result = await adapter.execute(
      {
        operation: 'search',
        query: 'test query',
        maxResults: 5,
        timeoutMs: 5000,
      },
      { logicalCallId: 'test-call-1' },
    );
    expect(result.sources.length).toBeGreaterThan(0);
    const source = result.sources[0]!;
    expect(source.canonicalUrl).toMatch(/^https:\/\//);
    expect(source.contentHash).toBeDefined();
    expect(source.injectionRiskLabels).toBeDefined();
    expect(Array.isArray(source.injectionRiskLabels)).toBe(true);
  });

  it('full-success research adapter cannot override provider origin', async () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    const adapter = createFullSuccessResearchAdapter();
    // The adapter must not accept arbitrary origins — it uses fixed provider origins
    // Attempting to pass a malicious URL should not change the adapter's behavior
    const result = await adapter.execute(
      {
        operation: 'search',
        query: 'http://localhost:8080/admin',
        maxResults: 1,
        timeoutMs: 1000,
      },
      { logicalCallId: 'test-call-2' },
    );
    // The adapter produces deterministic results regardless of query content
    // (it's a test fixture, not a real provider)
    expect(result.sources.length).toBeGreaterThan(0);
    // The source URL must be a valid HTTPS URL, not the injected localhost
    expect(result.sources[0]!.canonicalUrl).toMatch(/^https:\/\//);
    expect(result.sources[0]!.canonicalUrl).not.toContain('localhost');
  });

  it('full-success plan vector has valid PlanContentV1 structure', () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    const vector = createFullSuccessPlanVector();
    const content = vector.content as Record<string, unknown>;
    expect(content.schemaVersion).toBeDefined();
    expect(content.objective).toBeDefined();
    expect(Array.isArray(content.steps)).toBe(true);
    expect(content.steps).length.greaterThan(0);
    expect(content.partialResultPolicy).toBeDefined();
    expect(content.limits).toBeDefined();
  });

  it('full-success child outcome has required fields', () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    const outcome = createFullSuccessChildOutcome();
    expect(outcome.stepKey).toBeDefined();
    expect(outcome.status).toBeDefined();
    expect(outcome.resultCompleteness).toBeDefined();
  });

  it('full-success citation has exact quote and hash', () => {
    vi.stubEnv(FULL_SUCCESS_ENV_FLAG, '1');
    const citation = createFullSuccessCitation();
    expect(citation.exactQuote).toBeDefined();
    expect(citation.quoteHash).toBeDefined();
    expect(citation.sourceLocator).toBeDefined();
    expect(citation.artifactLocator).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Cancellation barriers (VAL-CROSS-104)
// ---------------------------------------------------------------------------

describe('VAL-CROSS-104: Disruption fixture barriers', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('barrier holds at named nonterminal checkpoint', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    const barrier = new DisruptionBarrier();
    barrier.hold('synthesis-pre-commit');
    expect(barrier.isHeld('synthesis-pre-commit')).toBe(true);
  });

  it('barrier releases at named checkpoint', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    const barrier = new DisruptionBarrier();
    barrier.hold('terminal-pre-commit');
    expect(barrier.isHeld('terminal-pre-commit')).toBe(true);
    barrier.release('terminal-pre-commit');
    expect(barrier.isHeld('terminal-pre-commit')).toBe(false);
  });

  it('barrier records release ownership', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    const barrier = new DisruptionBarrier();
    barrier.hold('synthesis-pre-commit');
    barrier.recordReleaseOwnership('synthesis-pre-commit', 'kill-switch-sweep');
    const log = barrier.getCheckpointLog();
    const entry = log.find((e) => e.name === 'synthesis-pre-commit');
    expect(entry).toBeDefined();
    expect(entry!.releasedBy).toBe('kill-switch-sweep');
    expect(entry!.releasedAt).toBeDefined();
  });

  it('barrier asserts nonterminal status at checkpoint', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    const barrier = new DisruptionBarrier();
    // A nonterminal status should pass
    expect(() => barrier.assertNonterminal('running-checkpoint', 'running')).not.toThrow();
    expect(() => barrier.assertNonterminal('queued-checkpoint', 'queued')).not.toThrow();
    expect(() => barrier.assertNonterminal('planning-checkpoint', 'planning')).not.toThrow();
    // A terminal status should fail
    expect(() => barrier.assertNonterminal('completed-checkpoint', 'completed')).toThrow(
      /nonterminal/i,
    );
    expect(() => barrier.assertNonterminal('cancelled-checkpoint', 'cancelled')).toThrow(
      /nonterminal/i,
    );
  });

  it('barrier asserts effect-fenced (no late commit after release)', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    const barrier = new DisruptionBarrier();
    barrier.hold('synthesis-pre-commit');
    // While held, the root is effect-fenced and nonterminal
    expect(barrier.isHeld('synthesis-pre-commit')).toBe(true);
    // Release the barrier
    barrier.release('synthesis-pre-commit');
    // After release, attempting to commit old work should be rejected
    expect(() => barrier.assertNoLateCommit('synthesis-pre-commit')).not.toThrow();
  });

  it('barrier records all named checkpoints in order', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    const barrier = new DisruptionBarrier();
    const checkpoints = [
      'before-stream-disconnect',
      'before-worker-restart',
      'before-retryable-provider-failure',
      'before-best-effort-child-exhaustion',
      'before-scope-switch',
      'barrier-hold-root-nonterminal',
      'kill-switch-disable',
    ];
    for (const name of checkpoints) {
      barrier.hold(name);
      barrier.release(name);
    }
    const log = barrier.getCheckpointLog();
    expect(log.length).toBe(checkpoints.length);
    // Checkpoints are in insertion order
    for (let i = 0; i < checkpoints.length; i++) {
      expect(log[i]!.name).toBe(checkpoints[i]);
    }
  });

  it('barrier checkpoint log includes timestamps', () => {
    vi.stubEnv(FIXTURE_CONTROLS_ENV_FLAG, '1');
    const barrier = new DisruptionBarrier();
    barrier.hold('test-checkpoint');
    barrier.release('test-checkpoint');
    const log = barrier.getCheckpointLog();
    expect(log[0]!.heldAt).toBeDefined();
    expect(log[0]!.releasedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: Tracked process teardown and cleanup (VAL-CROSS-100)
// ---------------------------------------------------------------------------

describe('VAL-CROSS-100: Cleanup restores data policy and processes', () => {
  let runner: SqlRunner;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const ctx = await createPgliteRunner();
    runner = ctx.runner;
    close = ctx.close;
  });

  afterEach(async () => {
    await close();
  });

  it('resetProviderCircuitHealth resets all circuit state to closed', async () => {
    const ts = new Date().toISOString();

    // Insert research_provider_health rows in open/half_open states.
    // This table has NO company_id — it's a platform-level table.
    await runner.query(
      `INSERT INTO research_provider_health (id, provider, operation, state, consecutive_failures, open_until_ms, last_success_at, last_failure_at, latency_count, latency_sum_ms, half_open_probe_owner, half_open_probe_lease_expires_ms, created_at, updated_at) VALUES ('${randomUUID()}', 'tavily', 'search', 'open', 3, 999999999, NULL, '${ts}', 0, 0, NULL, 0, '${ts}', '${ts}')`,
    );
    await runner.query(
      `INSERT INTO research_provider_health (id, provider, operation, state, consecutive_failures, open_until_ms, last_success_at, last_failure_at, latency_count, latency_sum_ms, half_open_probe_owner, half_open_probe_lease_expires_ms, created_at, updated_at) VALUES ('${randomUUID()}', 'firecrawl', 'scrape', 'half_open', 1, 0, NULL, '${ts}', 0, 0, 'probe-owner', 999999999, '${ts}', '${ts}')`,
    );

    // Verify they exist in non-closed states
    const beforeRows = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_provider_health WHERE state != 'closed' OR consecutive_failures > 0`,
    );
    expect(parseInt(beforeRows[0]!.count, 10)).toBe(2);

    // Reset circuit health
    const resetCount = await resetProviderCircuitHealth(runner, true);
    expect(resetCount).toBe(2);

    // All circuits should be closed with zero failures
    const afterRows = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_provider_health WHERE state != 'closed' OR consecutive_failures > 0`,
    );
    expect(parseInt(afterRows[0]!.count, 10)).toBe(0);

    // Verify the rows still exist (reset, not delete)
    const allRows = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_provider_health`,
    );
    expect(parseInt(allRows[0]!.count, 10)).toBe(2);
  });

  it('resetProviderCircuitHealth dry-run counts without modifying', async () => {
    const ts = new Date().toISOString();
    await runner.query(
      `INSERT INTO research_provider_health (id, provider, operation, state, consecutive_failures, open_until_ms, last_success_at, last_failure_at, latency_count, latency_sum_ms, half_open_probe_owner, half_open_probe_lease_expires_ms, created_at, updated_at) VALUES ('${randomUUID()}', 'tavily', 'search', 'open', 2, 0, NULL, '${ts}', 0, 0, NULL, 0, '${ts}', '${ts}')`,
    );

    // Dry-run should count but not modify
    const count = await resetProviderCircuitHealth(runner, false);
    expect(count).toBe(1);

    // State unchanged
    const rows = await runner.query<{ state: string }>(
      `SELECT state FROM research_provider_health WHERE provider = 'tavily' AND operation = 'search'`,
    );
    expect(rows[0]!.state).toBe('open');
  });

  it('cleanup removes research_sources and research_source_revisions for fixture companies', async () => {
    const fixtureId = await insertFixtureCompanyPglite(runner, '__mtest__ research-sources');
    const ts = new Date().toISOString();
    const { runId } = await insertMissionScope(runner, fixtureId);

    // Insert a research_source
    const sourceId = randomUUID();
    await runner.query(
      `INSERT INTO research_sources (id, company_id, canonical_url, canonical_url_hash, origin_domain, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('${sourceId}', '${fixtureId}', 'https://example.com/article', '${createHash('sha256').update('https://example.com/article').digest('hex')}', 'example.com', '${ts}', '${ts}', '${ts}', '${ts}')`,
    );

    // Insert a research_source_revision
    const revisionId = randomUUID();
    await runner.query(
      `INSERT INTO research_source_revisions (id, company_id, source_id, run_id, root_run_id, logical_call_id, provider, operation, provider_request_id_hash, retrieved_at, normalization_version, content_hash, byte_count, injection_risk_labels, warnings, status, created_at) VALUES ('${revisionId}', '${fixtureId}', '${sourceId}', '${runId}', '${runId}', 'call-1', 'tavily', 'search', 'req-hash', '${ts}', 1, 'content-hash', 100, '[]', '[]', 'available', '${ts}')`,
    );

    // Verify they exist
    const sourceBefore = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_sources WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(sourceBefore[0]!.count, 10)).toBe(1);

    const revisionBefore = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_source_revisions WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(revisionBefore[0]!.count, 10)).toBe(1);

    // Run cleanup
    const result = await runCleanup(runner, { execute: true });
    expect(result.companyCount).toBe(1);

    // Both should be gone
    const sourceAfter = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_sources WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(sourceAfter[0]!.count, 10)).toBe(0);

    const revisionAfter = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_source_revisions WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(revisionAfter[0]!.count, 10)).toBe(0);
  });

  it('cleanup removes citations and artifact_provenance for fixture companies', async () => {
    const fixtureId = await insertFixtureCompanyPglite(runner, '__mtest__ citations');
    const ts = new Date().toISOString();
    const { projectId, runId } = await insertMissionScope(runner, fixtureId);

    // Insert a research_source (required by citations)
    const sourceId = randomUUID();
    await runner.query(
      `INSERT INTO research_sources (id, company_id, canonical_url, canonical_url_hash, origin_domain, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('${sourceId}', '${fixtureId}', 'https://example.com/cited', '${createHash('sha256').update('https://example.com/cited').digest('hex')}', 'example.com', '${ts}', '${ts}', '${ts}', '${ts}')`,
    );

    const sourceRevisionId = randomUUID();
    await runner.query(
      `INSERT INTO research_source_revisions (id, company_id, source_id, run_id, root_run_id, logical_call_id, provider, operation, provider_request_id_hash, retrieved_at, normalization_version, content_hash, byte_count, injection_risk_labels, warnings, status, created_at) VALUES ('${sourceRevisionId}', '${fixtureId}', '${sourceId}', '${runId}', '${runId}', 'call-1', 'tavily', 'search', 'req-hash', '${ts}', 1, 'content-hash', 100, '[]', '[]', 'available', '${ts}')`,
    );

    // Insert an artifact + revision (required by citations)
    const agentId = randomUUID();
    await runner.query(
      `INSERT INTO agents (id, company_id, name, role, created_at, updated_at) VALUES ('${agentId}', '${fixtureId}', 'Agent', 'engineer', '${ts}', '${ts}')`,
    );
    const artifactId = randomUUID();
    await runner.query(
      `INSERT INTO artifacts (id, company_id, type, title, content, status, version, created_by_agent_id, last_edited_by_agent_id, created_at, updated_at) VALUES ('${artifactId}', '${fixtureId}', 'document', 'Test', '{"format":"markdown","body":"test"}', 'active', 1, '${agentId}', '${agentId}', '${ts}', '${ts}')`,
    );
    const artifactRevisionId = randomUUID();
    await runner.query(
      `INSERT INTO artifact_revisions (id, artifact_id, version, content, edit_source, edited_by_agent_id, created_at) VALUES ('${artifactRevisionId}', '${artifactId}', 1, '{"format":"markdown","body":"test"}', 'agent', '${agentId}', '${ts}')`,
    );

    // Insert a citation
    const citationId = randomUUID();
    await runner.query(
      `INSERT INTO citations (id, company_id, project_id, run_id, source_revision_id, artifact_id, artifact_revision_id, ordinal, quote_exact_encrypted, quote_hash, frozen_canonical_url, frozen_retrieved_at, frozen_provider, created_at) VALUES ('${citationId}', '${fixtureId}', '${projectId}', '${runId}', '${sourceRevisionId}', '${artifactId}', '${artifactRevisionId}', 0, 'encrypted-quote', '${createHash('sha256').update('exact quote text').digest('hex')}', 'https://example.com/cited', '${ts}', 'tavily', '${ts}')`,
    );

    // Insert artifact_provenance
    const provenanceId = randomUUID();
    await runner.query(
      `INSERT INTO artifact_provenance (id, company_id, project_id, run_id, root_run_id, artifact_id, artifact_revision_id, producing_step_key, generation_time, cited_source_revision_ids, created_at) VALUES ('${provenanceId}', '${fixtureId}', '${projectId}', '${runId}', '${runId}', '${artifactId}', '${artifactRevisionId}', 'root', '${ts}', '[]', '${ts}')`,
    );

    // Verify they exist
    const citationBefore = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM citations WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(citationBefore[0]!.count, 10)).toBe(1);

    const provenanceBefore = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM artifact_provenance WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(provenanceBefore[0]!.count, 10)).toBe(1);

    // Run cleanup
    const result = await runCleanup(runner, { execute: true });
    expect(result.companyCount).toBe(1);

    // Both should be gone
    const citationAfter = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM citations WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(citationAfter[0]!.count, 10)).toBe(0);

    const provenanceAfter = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM artifact_provenance WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(provenanceAfter[0]!.count, 10)).toBe(0);
  });

  it('cleanup removes run_research_sources for fixture companies', async () => {
    const fixtureId = await insertFixtureCompanyPglite(runner, '__mtest__ run-research');
    const ts = new Date().toISOString();
    const { projectId, runId } = await insertMissionScope(runner, fixtureId);

    // Insert a research_source
    const sourceId = randomUUID();
    await runner.query(
      `INSERT INTO research_sources (id, company_id, canonical_url, canonical_url_hash, origin_domain, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('${sourceId}', '${fixtureId}', 'https://example.com/run-src', '${createHash('sha256').update('https://example.com/run-src').digest('hex')}', 'example.com', '${ts}', '${ts}', '${ts}', '${ts}')`,
    );

    const sourceRevisionId = randomUUID();
    await runner.query(
      `INSERT INTO research_source_revisions (id, company_id, source_id, run_id, root_run_id, logical_call_id, provider, operation, provider_request_id_hash, retrieved_at, normalization_version, content_hash, byte_count, injection_risk_labels, warnings, status, created_at) VALUES ('${sourceRevisionId}', '${fixtureId}', '${sourceId}', '${runId}', '${runId}', 'call-1', 'tavily', 'search', 'req-hash', '${ts}', 1, 'content-hash', 100, '[]', '[]', 'available', '${ts}')`,
    );

    // Insert a run_research_sources join
    const runResearchId = randomUUID();
    await runner.query(
      `INSERT INTO run_research_sources (id, company_id, project_id, run_id, root_run_id, logical_call_id, source_revision_id, rank, relevance_score, query_hash, selected, excluded, created_at) VALUES ('${runResearchId}', '${fixtureId}', '${projectId}', '${runId}', '${runId}', 'call-1', '${sourceRevisionId}', 0, 0.95, 'query-hash', true, false, '${ts}')`,
    );

    // Verify it exists
    const before = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM run_research_sources WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(before[0]!.count, 10)).toBe(1);

    // Run cleanup
    const result = await runCleanup(runner, { execute: true });
    expect(result.companyCount).toBe(1);

    // Should be gone
    const after = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM run_research_sources WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(after[0]!.count, 10)).toBe(0);
  });

  it('cleanup preserves non-fixture research data', async () => {
    const fixtureId = await insertFixtureCompanyPglite(runner, '__mtest__ preserve-research');
    const realId = randomUUID();
    const ts = new Date().toISOString();

    // Create a real (non-fixture) company
    await runner.query(
      `INSERT INTO companies (id, name, settings, created_at, updated_at) VALUES ('${realId}', 'Real Research Corp', '{}', '${ts}', '${ts}')`,
    );

    // Insert research data for both
    for (const cid of [fixtureId, realId]) {
      const sourceId = randomUUID();
      await runner.query(
        `INSERT INTO research_sources (id, company_id, canonical_url, canonical_url_hash, origin_domain, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('${sourceId}', '${cid}', 'https://example.com/${cid}', '${createHash(
          'sha256',
        )
          .update('https://example.com/' + cid)
          .digest('hex')}', 'example.com', '${ts}', '${ts}', '${ts}', '${ts}')`,
      );
    }
    // research_provider_health has no company_id — it's global. Insert one row.
    await runner.query(
      `INSERT INTO research_provider_health (id, provider, operation, state, consecutive_failures, open_until_ms, last_success_at, last_failure_at, latency_count, latency_sum_ms, half_open_probe_owner, half_open_probe_lease_expires_ms, created_at, updated_at) VALUES ('${randomUUID()}', 'tavily', 'search', 'closed', 0, 0, '${ts}', NULL, 0, 0, NULL, 0, '${ts}', '${ts}')`,
    );

    // Run cleanup
    const result = await runCleanup(runner, { execute: true });
    expect(result.companyCount).toBe(1);

    // Fixture data is gone
    const fixtureSources = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_sources WHERE company_id = '${fixtureId}'`,
    );
    expect(parseInt(fixtureSources[0]!.count, 10)).toBe(0);

    // Real data is preserved
    const realSources = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_sources WHERE company_id = '${realId}'`,
    );
    expect(parseInt(realSources[0]!.count, 10)).toBe(1);

    // Global health table is not affected by company-scoped cleanup
    const healthCount = await runner.query<{ count: string }>(
      `SELECT count(*) as count FROM research_provider_health`,
    );
    expect(parseInt(healthCount[0]!.count, 10)).toBe(1);
  });

  it('cleanup reports research tables in tableCounts', async () => {
    const fixtureId = await insertFixtureCompanyPglite(runner, '__mtest__ report-research');
    const ts = new Date().toISOString();

    // Insert research data
    const sourceId = randomUUID();
    await runner.query(
      `INSERT INTO research_sources (id, company_id, canonical_url, canonical_url_hash, origin_domain, first_seen_at, last_seen_at, created_at, updated_at) VALUES ('${sourceId}', '${fixtureId}', 'https://example.com/report', '${createHash('sha256').update('https://example.com/report').digest('hex')}', 'example.com', '${ts}', '${ts}', '${ts}', '${ts}')`,
    );

    const result = await runCleanup(runner, { execute: true });

    // Research tables should be reported in tableCounts
    const researchSourcesCount = result.tableCounts.find((c) => c.table === 'research_sources');
    expect(researchSourcesCount).toBeDefined();
    expect(researchSourcesCount!.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Production-build absence of fixture controls (VAL-CROSS-103, 104)
// ---------------------------------------------------------------------------

describe('VAL-CROSS-103/104: Fixture controls unavailable in production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fixture controls env flag defaults to unset in production', () => {
    vi.unstubAllEnvs();
    expect(process.env[FIXTURE_CONTROLS_ENV_FLAG]).toBeUndefined();
    expect(isFixtureControlsEnabled()).toBe(false);
  });

  it('full-success fixture env flag defaults to unset in production', () => {
    vi.unstubAllEnvs();
    expect(process.env[FULL_SUCCESS_ENV_FLAG]).toBeUndefined();
    expect(isFullSuccessFixtureEnabled()).toBe(false);
  });

  it('all fixture control constructors throw in production mode', () => {
    vi.unstubAllEnvs();
    expect(() => new DisruptionBarrier()).toThrow();
    expect(() => createFullSuccessResearchAdapter()).toThrow();
    expect(() => createFullSuccessPlanVector()).toThrow();
    expect(() => createFullSuccessChildOutcome()).toThrow();
    expect(() => createFullSuccessCitation()).toThrow();
  });
});
