/**
 * Research fallback audit events (VAL-CROSS-033).
 *
 * When the preferred provider exhausts eligible retries for a retryable
 * timeout/throttle/unavailable condition, the allowed secondary provider
 * is attempted once according to policy and the Mission can continue;
 * fallback must not occur for cancellation, unsafe URL, policy denial,
 * invalid input, or exhausted budget.
 *
 * Evidence: Ordered `research.provider_attempted`, retry,
 * `research.provider_fallback`, and completion events for a retryable
 * case, plus separate denied-case events showing no secondary attempt.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestDb, closeTestDb } from '../test-utils.js';
import { ResearchExecutionService } from '../services/mission/research/research-execution-service.js';
import { ResearchCircuitBreaker as CircuitBreakerService } from '../services/mission/research/circuit-breaker.js';
import {
  ResearchPricingService,
  type PricingTableEntry,
} from '../services/mission/research/pricing.js';
import { SourceRevisionService } from '../services/mission/research/source-revision-service.js';
import { ResearchAttemptAccountingService } from '../services/mission/research/research-attempt-accounting.js';
import {
  ResearchProviderError,
  type ResearchProvider,
  type ResearchRequest,
  type ResearchResult,
  type ResearchCallContext,
} from '../services/mission/research/spi.js';
import type { CredentialStore } from '../services/mission/research/credential-resolver.js';
import type { ResearchProviderName } from '../services/mission/research/origins.js';

type AnyDb = Awaited<ReturnType<typeof createTestDb>>;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

class MockCredentialStore implements CredentialStore {
  private secrets = new Map<string, string>();
  set(companyId: string, provider: string, key: string): void {
    this.secrets.set(`${companyId}:${provider}`, key);
  }
  async getSecret(companyId: string, providerName: string): Promise<string | undefined> {
    return this.secrets.get(`${companyId}:${providerName}`);
  }
}

/** A mock provider that fails N times then succeeds, or always fails. */
class MockProvider implements ResearchProvider {
  private callCount = 0;
  constructor(
    private name: ResearchProviderName,
    private config:
      | { type: 'fail-then-succeed'; failTimes: number; errorCode: string }
      | { type: 'always-fail'; errorCode: string }
      | { type: 'always-succeed' },
  ) {}
  supports(): boolean {
    return true;
  }
  getCallCount(): number {
    return this.callCount;
  }
  async execute(_request: ResearchRequest, _context: ResearchCallContext): Promise<ResearchResult> {
    this.callCount++;
    if (this.config.type === 'always-succeed') {
      return {
        logicalCallId: 'call-1',
        provider: this.name,
        providerRequestId: `${this.name}-req-${this.callCount}`,
        credits: 1,
        sources: [
          {
            canonicalUrl: 'https://example.com/source',
            retrievedAt: new Date().toISOString(),
            rank: 0,
            injectionRiskLabels: [],
          },
        ],
        warnings: [],
      };
    }
    if (this.config.type === 'fail-then-succeed') {
      if (this.callCount <= this.config.failTimes) {
        throw new ResearchProviderError(
          this.config.errorCode as ResearchProviderError['code'],
          `Provider ${this.name} attempt ${this.callCount} failed`,
          this.name,
          'search',
        );
      }
      return {
        logicalCallId: 'call-1',
        provider: this.name,
        providerRequestId: `${this.name}-req-${this.callCount}`,
        credits: 1,
        sources: [
          {
            canonicalUrl: 'https://example.com/source',
            retrievedAt: new Date().toISOString(),
            rank: 0,
            injectionRiskLabels: [],
          },
        ],
        warnings: [],
      };
    }
    // always-fail
    throw new ResearchProviderError(
      this.config.errorCode as ResearchProviderError['code'],
      `Provider ${this.name} always fails`,
      this.name,
      'search',
    );
  }
}

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
  await db.drizzle.execute(sql`
    INSERT INTO "mission_runs" ("id", "company_id", "project_id", "project_thread_id", "root_run_id", "parent_run_id", "depth", "child_ordinal", "status", "state_version", "last_event_sequence", "routing_kind", "billing_agent_id", "request_content_hash", "mode_profile_id", "resolved_mode", "policy_snapshot_id", "request_envelope", "request_safe_summary", "actual_cost_cents", "provider_call_count", "descendant_count", "input_tokens", "output_tokens", "output_bytes", "attempt_count", "created_at", "updated_at")
    VALUES (${runId}, ${companyId}, ${projectId}, ${threadId}, ${rootRunId}, NULL, 0, 0, 'running', 1, 0, 'company_agent', ${billingAgentId}, 'hash123', NULL, 'analyst', NULL, '{}'::jsonb, 'test'::text, 0, 0, 0, 0, 0, 0, 0, ${now}, ${now})
  `);

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

  return { companyId, projectId, runId, rootRunId, billingAgentId };
}

async function getRunEvents(db: AnyDb, runId: string) {
  const rows = (await db.drizzle.execute(sql`
    SELECT "sequence", "type", "payload"
    FROM "run_events" WHERE "run_id" = ${runId}
    ORDER BY "sequence" ASC
  `)) as unknown as Array<{
    sequence: string | number;
    type: string;
    payload: Record<string, unknown>;
  }>;
  return rows.map((r) => ({ ...r, sequence: Number(r.sequence) }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VAL-CROSS-033: Research fallback remains auditable', () => {
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

  it('emits ordered provider_attempted, retry, provider_fallback, and completion events for a retryable timeout case', async () => {
    const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
      db,
      '__mtest__ fallback-audit-timeout',
    );
    credentialStore.set(companyId, 'tavily', 'test-tavily-key');
    credentialStore.set(companyId, 'firecrawl', 'test-firecrawl-key');

    // Tavily: PROVIDER_TIMEOUT is retryable → 3 attempts, then fallback to Firecrawl
    const tavily = new MockProvider('tavily', {
      type: 'always-fail',
      errorCode: 'PROVIDER_TIMEOUT',
    });
    const firecrawl = new MockProvider('firecrawl', { type: 'always-succeed' });

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
      {
        providers: [
          { provider: tavily, name: 'tavily' },
          { provider: firecrawl, name: 'firecrawl' },
        ],
      },
    );

    // Firecrawl succeeded
    expect(result.provider).toBe('firecrawl');
    expect(tavily.getCallCount()).toBe(3); // 3 retry attempts
    expect(firecrawl.getCallCount()).toBe(1); // one fallback attempt

    // Verify ordered run events
    const events = await getRunEvents(db, runId);
    const eventTypes = events.map((e) => e.type);

    // Must contain research events in order
    expect(eventTypes).toContain('research.started');
    expect(eventTypes).toContain('research.provider_attempted');
    expect(eventTypes).toContain('research.provider_fallback');
    expect(eventTypes).toContain('research.completed');

    // Verify ordering: started → provider_attempted → fallback → provider_attempted → completed
    const startedIdx = eventTypes.indexOf('research.started');
    const firstAttemptIdx = eventTypes.indexOf('research.provider_attempted');
    const fallbackIdx = eventTypes.indexOf('research.provider_fallback');
    const lastAttemptIdx = eventTypes.lastIndexOf('research.provider_attempted');
    const completedIdx = eventTypes.indexOf('research.completed');

    expect(startedIdx).toBeLessThan(firstAttemptIdx);
    expect(firstAttemptIdx).toBeLessThan(fallbackIdx);
    expect(fallbackIdx).toBeLessThan(lastAttemptIdx);
    expect(lastAttemptIdx).toBeLessThan(completedIdx);

    // Verify the fallback event names the from/to providers
    const fallbackEvent = events.find((e) => e.type === 'research.provider_fallback');
    expect(fallbackEvent!.payload).toMatchObject({
      fromProvider: 'tavily',
      toProvider: 'firecrawl',
    });

    // Verify provider_attempted events carry the provider name and attempt number
    const attemptEvents = events.filter((e) => e.type === 'research.provider_attempted');
    expect(attemptEvents.length).toBeGreaterThanOrEqual(4); // 3 tavily + 1 firecrawl
    // First 3 attempts are tavily
    for (let i = 0; i < 3; i++) {
      expect(attemptEvents[i]!.payload).toMatchObject({
        provider: 'tavily',
        attempt: i + 1,
        isFallback: false,
      });
    }
    // 4th attempt is firecrawl (fallback)
    expect(attemptEvents[3]!.payload).toMatchObject({
      provider: 'firecrawl',
      attempt: 1,
      isFallback: true,
    });

    // Verify sequences are strictly monotonic
    for (let i = 1; i < events.length; i++) {
      expect(events[i].sequence).toBeGreaterThan(events[i - 1].sequence);
    }
  });

  it('emits no provider_fallback or secondary attempt for cancellation (denied case)', async () => {
    const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
      db,
      '__mtest__ fallback-audit-cancel',
    );
    credentialStore.set(companyId, 'tavily', 'test-tavily-key');
    credentialStore.set(companyId, 'firecrawl', 'test-firecrawl-key');

    const tavily = new MockProvider('tavily', {
      type: 'always-fail',
      errorCode: 'CANCELLED',
    });
    const firecrawl = new MockProvider('firecrawl', { type: 'always-succeed' });

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
        {
          providers: [
            { provider: tavily, name: 'tavily' },
            { provider: firecrawl, name: 'firecrawl' },
          ],
        },
      ),
    ).rejects.toThrow();

    // CANCELLED is not retryable and not fallback-eligible
    expect(tavily.getCallCount()).toBe(1);
    expect(firecrawl.getCallCount()).toBe(0);

    const events = await getRunEvents(db, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain('research.started');
    expect(eventTypes).toContain('research.provider_attempted');
    expect(eventTypes).toContain('research.failed');
    // No fallback event
    expect(eventTypes).not.toContain('research.provider_fallback');
    // Only one provider_attempted (no secondary)
    const attemptCount = eventTypes.filter((t) => t === 'research.provider_attempted').length;
    expect(attemptCount).toBe(1);
  });

  it('emits no provider_fallback or secondary attempt for invalid input (denied case)', async () => {
    const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
      db,
      '__mtest__ fallback-audit-invalid',
    );
    credentialStore.set(companyId, 'tavily', 'test-tavily-key');
    credentialStore.set(companyId, 'firecrawl', 'test-firecrawl-key');

    const tavily = new MockProvider('tavily', {
      type: 'always-fail',
      errorCode: 'INVALID_REQUEST',
    });
    const firecrawl = new MockProvider('firecrawl', { type: 'always-succeed' });

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
        {
          providers: [
            { provider: tavily, name: 'tavily' },
            { provider: firecrawl, name: 'firecrawl' },
          ],
        },
      ),
    ).rejects.toThrow();

    expect(tavily.getCallCount()).toBe(1);
    expect(firecrawl.getCallCount()).toBe(0);

    const events = await getRunEvents(db, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain('research.failed');
    expect(eventTypes).not.toContain('research.provider_fallback');
    const attemptCount = eventTypes.filter((t) => t === 'research.provider_attempted').length;
    expect(attemptCount).toBe(1);
  });

  it('emits no provider_fallback or secondary attempt for budget exhaustion (denied case)', async () => {
    const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
      db,
      '__mtest__ fallback-audit-budget',
    );
    credentialStore.set(companyId, 'tavily', 'test-tavily-key');
    credentialStore.set(companyId, 'firecrawl', 'test-firecrawl-key');

    const tavily = new MockProvider('tavily', {
      type: 'always-fail',
      errorCode: 'BUDGET_EXHAUSTED',
    });
    const firecrawl = new MockProvider('firecrawl', { type: 'always-succeed' });

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
        {
          providers: [
            { provider: tavily, name: 'tavily' },
            { provider: firecrawl, name: 'firecrawl' },
          ],
        },
      ),
    ).rejects.toThrow();

    expect(tavily.getCallCount()).toBe(1);
    expect(firecrawl.getCallCount()).toBe(0);

    const events = await getRunEvents(db, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain('research.failed');
    expect(eventTypes).not.toContain('research.provider_fallback');
    const attemptCount = eventTypes.filter((t) => t === 'research.provider_attempted').length;
    expect(attemptCount).toBe(1);
  });

  it('emits no provider_fallback or secondary attempt for policy denial (denied case)', async () => {
    const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
      db,
      '__mtest__ fallback-audit-policy',
    );
    credentialStore.set(companyId, 'tavily', 'test-tavily-key');
    credentialStore.set(companyId, 'firecrawl', 'test-firecrawl-key');

    const tavily = new MockProvider('tavily', {
      type: 'always-fail',
      errorCode: 'POLICY_DENIED',
    });
    const firecrawl = new MockProvider('firecrawl', { type: 'always-succeed' });

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
        {
          providers: [
            { provider: tavily, name: 'tavily' },
            { provider: firecrawl, name: 'firecrawl' },
          ],
        },
      ),
    ).rejects.toThrow();

    expect(tavily.getCallCount()).toBe(1);
    expect(firecrawl.getCallCount()).toBe(0);

    const events = await getRunEvents(db, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain('research.failed');
    expect(eventTypes).not.toContain('research.provider_fallback');
    const attemptCount = eventTypes.filter((t) => t === 'research.provider_attempted').length;
    expect(attemptCount).toBe(1);
  });

  it('emits no provider_fallback for auth failure (denied case)', async () => {
    const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
      db,
      '__mtest__ fallback-audit-auth',
    );
    credentialStore.set(companyId, 'tavily', 'test-tavily-key');
    credentialStore.set(companyId, 'firecrawl', 'test-firecrawl-key');

    const tavily = new MockProvider('tavily', {
      type: 'always-fail',
      errorCode: 'PROVIDER_AUTHENTICATION_FAILED',
    });
    const firecrawl = new MockProvider('firecrawl', { type: 'always-succeed' });

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
        {
          providers: [
            { provider: tavily, name: 'tavily' },
            { provider: firecrawl, name: 'firecrawl' },
          ],
        },
      ),
    ).rejects.toThrow();

    expect(tavily.getCallCount()).toBe(1);
    expect(firecrawl.getCallCount()).toBe(0);

    const events = await getRunEvents(db, runId);
    const eventTypes = events.map((e) => e.type);

    expect(eventTypes).toContain('research.failed');
    expect(eventTypes).not.toContain('research.provider_fallback');
    const attemptCount = eventTypes.filter((t) => t === 'research.provider_attempted').length;
    expect(attemptCount).toBe(1);
  });

  it('does not leak secrets in research events', async () => {
    const { companyId, projectId, runId, rootRunId, billingAgentId } = await seedRunWithBudget(
      db,
      '__mtest__ fallback-audit-secrets',
    );
    credentialStore.set(companyId, 'tavily', 'SECRET-TAVILY-KEY');
    credentialStore.set(companyId, 'firecrawl', 'SECRET-FIRECRAWL-KEY');

    const tavily = new MockProvider('tavily', {
      type: 'always-fail',
      errorCode: 'PROVIDER_TIMEOUT',
    });
    const firecrawl = new MockProvider('firecrawl', { type: 'always-succeed' });

    await executionService.executeResearch(
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
      {
        providers: [
          { provider: tavily, name: 'tavily' },
          { provider: firecrawl, name: 'firecrawl' },
        ],
      },
    );

    const events = await getRunEvents(db, runId);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('SECRET-TAVILY-KEY');
    expect(serialized).not.toContain('SECRET-FIRECRAWL-KEY');
  });
});
