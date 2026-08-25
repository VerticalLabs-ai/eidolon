/**
 * Research execution service: production orchestration of provider calls,
 * credential resolution, budget reservation, source persistence, and
 * accounting settlement.
 *
 * (architecture.md: Research module, VAL-RES-002..005, VAL-RES-089,
 *  VAL-CROSS-031, VAL-CROSS-032)
 *
 * The ResearchExecutionService ties together:
 *  - request validation (request-validation.ts)
 *  - credential resolution (credential-resolver.ts)
 *  - circuit breaker state (circuit-breaker.ts)
 *  - budget reservation + settlement (research-attempt-accounting.ts)
 *  - adapter execution with retry/fallback (fallback.ts)
 *  - source normalization + persistence (source-revision-service.ts)
 *  - pricing conversion (pricing.ts)
 *
 * Tests use mocked HTTP transport, DNS, and an in-memory credential store
 * for deterministic contract verification. Production integration tests
 * with real Tavily/Firecrawl/Anthropic credentials are in a separate
 * gated test file.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { ResearchExecutionService } from '../services/mission/research/research-execution-service.js';
import { TavilyAdapter } from '../services/mission/research/tavily-adapter.js';
import { FirecrawlAdapter } from '../services/mission/research/firecrawl-adapter.js';
import { ResearchCircuitBreaker as CircuitBreakerService } from '../services/mission/research/circuit-breaker.js';
import {
  ResearchPricingService,
  type PricingTableEntry,
} from '../services/mission/research/pricing.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { ResearchAttemptAccountingService } from '../services/mission/research/research-attempt-accounting.js';
import type { CredentialStore } from '../services/mission/research/credential-resolver.js';
import type { FetchFn } from '../services/mission/research/spi.js';
import type { ResearchProviderName } from '../services/mission/research/origins.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** In-memory credential store for deterministic tests. */
class MockCredentialStore implements CredentialStore {
  private secrets = new Map<string, string>();
  set(companyId: string, provider: string, key: string): void {
    this.secrets.set(`${companyId}:${provider}`, key);
  }
  async getSecret(companyId: string, providerName: string): Promise<string | undefined> {
    return this.secrets.get(`${companyId}:${providerName}`);
  }
}

/** Create a mock fetch that returns a canned Tavily search response. */
function mockTavilySearchFetch(requestId = 'tavily-req-123'): FetchFn {
  return vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const body = init?.body ? JSON.parse(init.body as string) : {};
    return new Response(
      JSON.stringify({
        query: body.query,
        results: [
          {
            title: 'Example Source',
            url: 'https://example.com/article',
            content: 'This is the normalized content of the article.',
            score: 0.95,
            id: 'result-1',
          },
        ],
        response_time: 0.5,
        usage: { credits: 1 },
        request_id: requestId,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as FetchFn;
}

/** Create a mock fetch that returns a canned Firecrawl search response. */
function mockFirecrawlSearchFetch(requestId = 'firecrawl-req-456'): FetchFn {
  return vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          web: [
            {
              title: 'Firecrawl Page',
              description: 'A test page',
              url: 'https://example.com/firecrawl-page',
              markdown: '## Firecrawl Result\n\nThis is the content.',
              metadata: {
                url: 'https://example.com/firecrawl-page',
                title: 'Firecrawl Page',
                description: 'A test page',
                statusCode: 200,
                language: 'en',
              },
            },
          ],
        },
        id: requestId,
        creditsUsed: 1,
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    );
  }) as unknown as FetchFn;
}

/** Seed a company, project, run, and budget allocation for testing. */
async function seedRunWithBudget(db: AnyDb, label: string) {
  const companyId = randomUUID();
  const projectId = randomUUID();
  const threadId = randomUUID();
  const runId = randomUUID();
  const rootRunId = runId;
  const billingAgentId = randomUUID();
  const now = new Date();

  await db.drizzle.execute(sql`
    INSERT INTO "companies" ("id", "name", "status", "budget_monthly_cents", "spent_monthly_cents", "settings", "created_at", "updated_at")
    VALUES (${companyId}, ${label}, 'active', 100000, 0, '{"testFixture": true}'::jsonb, ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "projects" ("id", "company_id", "name", "status", "created_at", "updated_at")
    VALUES (${projectId}, ${companyId}, 'P', 'active', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "project_threads" ("id", "company_id", "project_id", "title", "type", "status", "created_at", "updated_at")
    VALUES (${threadId}, ${companyId}, ${projectId}, 'T', 'conversation', 'active', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "agents" ("id", "company_id", "name", "role", "provider", "model", "status", "max_concurrent_tasks", "budget_monthly_cents", "spent_monthly_cents", "created_at", "updated_at")
    VALUES (${billingAgentId}, ${companyId}, 'A', 'engineer', 'anthropic', 'claude-sonnet-4-6', 'idle', 1, 50000, 0, ${now}, ${now})
  `);

  // Insert a mission run.
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "status", "state_version", "last_event_sequence", "routing_kind", "billing_agent_id", "request_content_hash", "mode_profile_id", "resolved_mode", "policy_snapshot_id", "request_envelope", "request_safe_summary", "actual_cost_cents", "provider_call_count", "descendant_count", "input_tokens", "output_tokens", "output_bytes", "attempt_count", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, NULL, 0, 0, 'running', 1, 0, 'company_agent', ${billingAgentId}, 'hash123', NULL, 'analyst', NULL, '{}'::jsonb, 'test'::text, 0, 0, 0, 0, 0, 0, 0, ${now}, ${now})
  `);

  // Insert a budget reservation and allocation.
  const reservationId = randomUUID();
  const allocationId = randomUUID();
  await db.drizzle.execute(sql`
    INSERT INTO "budget_reservations" ("id", "company_id", "run_id", "billing_agent_id", "requested_cents", "reserved_cents", "settled_cents", "released_cents", "period_key", "status", "created_at", "updated_at")
    VALUES (${reservationId}, ${companyId}, ${runId}, ${billingAgentId}, 5000, 5000, 0, 0, '2026-08', 'held', ${now}, ${now})
  `);
  await db.drizzle.execute(sql`
    INSERT INTO "budget_allocations" ("id", "company_id", "root_reservation_id", "run_id", "billing_agent_id", "allocated_cents", "settled_cents", "released_cents", "status", "created_at", "updated_at")
    VALUES (${allocationId}, ${companyId}, ${reservationId}, ${runId}, ${billingAgentId}, 5000, 0, 0, 'held', ${now}, ${now})
  `);

  return { companyId, projectId, runId, rootRunId, billingAgentId, allocationId };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ResearchExecutionService', () => {
  let db: AnyDb;
  let credentialStore: MockCredentialStore;
  let pricingService: ResearchPricingService;
  let circuitBreaker: CircuitBreakerService;
  let sourceRevisions: SourceRevisionService;
  let accounting: ResearchAttemptAccountingService;
  let executionService: ResearchExecutionService;
  let pricingTable: Record<string, PricingTableEntry>;

  beforeEach(async () => {
    db = await createTestDb();
    credentialStore = new MockCredentialStore();
    pricingService = new ResearchPricingService(db, {});
    circuitBreaker = new CircuitBreakerService(db);
    sourceRevisions = new SourceRevisionService({
      drizzle: db.drizzle,
      schema: db.schema,
    });
    accounting = new ResearchAttemptAccountingService(db);
    pricingTable = {
      'tavily:search': {
        provider: 'tavily',
        operation: 'search',
        pricingTableVersion: 'v1',
        currency: 'USD',
        unitDefinition: { unit: 'credit', priceNumerator: '10', priceDenominator: '1' },
        roundingRule: 'round_half_up',
        conservativeUnknownPriceCents: 100,
      },
      'firecrawl:search': {
        provider: 'firecrawl',
        operation: 'search',
        pricingTableVersion: 'v1',
        currency: 'USD',
        unitDefinition: { unit: 'credit', priceNumerator: '15', priceDenominator: '1' },
        roundingRule: 'round_half_up',
        conservativeUnknownPriceCents: 150,
      },
    };
    executionService = new ResearchExecutionService(db, {
      credentialStore,
      pricingService,
      circuitBreaker,
      sourceRevisions,
      accounting,
      pricingTable,
    });
  });

  afterEach(async () => {
    await closeTestDb();
  });

  describe('executeResearch — Tavily search', () => {
    it('normalizes sources, persists revisions, settles credits, and returns citation-ready evidence', async () => {
      const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
        db,
        '__mtest__ tavily-search',
      );
      credentialStore.set(companyId, 'tavily', 'test-tavily-key');

      const mockFetch = mockTavilySearchFetch('tavily-req-abc');
      const tavilyAdapter = new TavilyAdapter({ apiKey: 'test-tavily-key', fetch: mockFetch });

      const result = await executionService.executeResearch(
        {
          companyId,
          projectId,
          runId,
          rootRunId,
          billingAgentId,
          provider: 'tavily',
          operation: 'search',
          query: 'test query',
          maxResults: 5,
          timeoutMs: 15000,
        },
        { providers: [{ provider: tavilyAdapter, name: 'tavily' }] },
      );

      // Should return normalized sources.
      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.sources[0]!.canonicalUrl).toBe('https://example.com/article');
      expect(result.sources[0]!.contentHash).toBeDefined();
      expect(result.sources[0]!.byteCount).toBeGreaterThan(0);

      // Should have persisted source revisions.
      expect(result.persistedRevisions.length).toBeGreaterThan(0);
      const rev = result.persistedRevisions[0]!;
      expect(rev.sourceRevisionId).toBeDefined();
      expect(rev.canonicalUrl).toBe('https://example.com/article');
      expect(rev.contentHash).toBeDefined();

      // Should have settled the attempt with credits and cost.
      expect(result.attemptId).toBeDefined();
      expect(result.providerRequestIdHash).toBeDefined();
      expect(result.credits).toBe(1);
      expect(result.costCents).toBeGreaterThan(0);

      // Should NOT leak the API key.
      expect(JSON.stringify(result)).not.toContain('test-tavily-key');
    });

    it('hashes the provider request ID before durable storage', async () => {
      const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
        db,
        '__mtest__ tavily-req-hash',
      );
      credentialStore.set(companyId, 'tavily', 'test-key');

      const mockFetch = mockTavilySearchFetch('tavily-req-xyz');
      const tavilyAdapter = new TavilyAdapter({ apiKey: 'test-key', fetch: mockFetch });

      const result = await executionService.executeResearch(
        {
          companyId,
          projectId,
          runId,
          rootRunId,
          billingAgentId,
          provider: 'tavily',
          operation: 'search',
          query: 'test',
          maxResults: 5,
          timeoutMs: 15000,
        },
        { providers: [{ provider: tavilyAdapter, name: 'tavily' }] },
      );

      // The raw request ID should NOT appear in the result.
      expect(JSON.stringify(result)).not.toContain('tavily-req-xyz');
      // The hash should be a SHA-256 hex.
      expect(result.providerRequestIdHash).toMatch(/^[0-9a-f]{64}$/);
      // Verify the hash is correct.
      const expectedHash = createHash('sha256').update('tavily-req-xyz', 'utf8').digest('hex');
      expect(result.providerRequestIdHash).toBe(expectedHash);
    });
  });

  describe('executeResearch — Firecrawl search', () => {
    it('normalizes Firecrawl results with credits and request ID hash', async () => {
      const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
        db,
        '__mtest__ firecrawl-search',
      );
      credentialStore.set(companyId, 'firecrawl', 'test-firecrawl-key');

      const mockFetch = mockFirecrawlSearchFetch('firecrawl-req-def');
      const firecrawlAdapter = new FirecrawlAdapter({
        apiKey: 'test-firecrawl-key',
        fetch: mockFetch,
      });

      const result = await executionService.executeResearch(
        {
          companyId,
          projectId,
          runId,
          rootRunId,
          billingAgentId,
          provider: 'firecrawl',
          operation: 'search',
          query: 'firecrawl test',
          maxResults: 5,
          timeoutMs: 15000,
        },
        { providers: [{ provider: firecrawlAdapter, name: 'firecrawl' }] },
      );

      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.credits).toBe(1);
      expect(result.costCents).toBe(15);
      expect(result.providerRequestIdHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(result)).not.toContain('test-firecrawl-key');
    });
  });

  describe('executeResearch — credential guards', () => {
    it('fails with PROVIDER_CREDENTIAL_UNAVAILABLE when no credential is configured', async () => {
      const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
        db,
        '__mtest__ no-cred',
      );
      // Ensure no env credential is available either.
      vi.stubEnv('TAVILY_API_KEY', '');

      const tavilyAdapter = new TavilyAdapter({
        apiKey: 'should-not-be-used',
        fetch: mockTavilySearchFetch(),
      });

      await expect(
        executionService.executeResearch(
          {
            companyId,
            projectId,
            runId,
            rootRunId,
            billingAgentId,
            provider: 'tavily',
            operation: 'search',
            query: 'test',
            maxResults: 5,
            timeoutMs: 15000,
          },
          { providers: [{ provider: tavilyAdapter, name: 'tavily' }] },
        ),
      ).rejects.toThrow(/CREDENTIAL_UNAVAILABLE|credential/i);

      vi.unstubAllEnvs();
    });
  });

  describe('executeResearch — redaction', () => {
    it('never leaks the API key in the result, sources, or persisted revisions', async () => {
      const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
        db,
        '__mtest__ redaction',
      );
      credentialStore.set(companyId, 'tavily', 'SECRET-KEY-DO-NOT-LEAK');

      const mockFetch = mockTavilySearchFetch();
      const tavilyAdapter = new TavilyAdapter({
        apiKey: 'SECRET-KEY-DO-NOT-LEAK',
        fetch: mockFetch,
      });

      const result = await executionService.executeResearch(
        {
          companyId,
          projectId,
          runId,
          rootRunId,
          billingAgentId,
          provider: 'tavily',
          operation: 'search',
          query: 'test',
          maxResults: 5,
          timeoutMs: 15000,
        },
        { providers: [{ provider: tavilyAdapter, name: 'tavily' }] },
      );

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('SECRET-KEY-DO-NOT-LEAK');
      expect(serialized).not.toContain('test-tavily-key');
    });
  });
});
