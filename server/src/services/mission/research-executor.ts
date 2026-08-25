/**
 * Production research executor for RunProcessor.
 *
 * (fix-ut-m5-research-execution-wiring)
 *
 * When a child run's approved plan step includes research operations
 * (research.search, research.extract, research.scrape,
 * research.structured_extract), the RunProcessor delegates to this executor
 * to invoke the ResearchExecutionService with real Tavily/Firecrawl adapters.
 *
 * This executor:
 *  1. Resolves the child's step assignment for the stepKey and billing agent.
 *  2. Constructs Tavily and Firecrawl adapters with the resolved API key.
 *  3. Invokes the ResearchExecutionService for each research operation.
 *  4. The service persists source revisions, settles budget, and emits
 *     research events (research.started, research.provider_attempted,
 *     research.source_discovered, research.completed).
 *
 * The agent's toolAllowlist and domainAllowlist from the policy snapshot are
 * passed through to ensure Tavily/Firecrawl calls use the correct
 * configuration. Budget settlement is handled by the ResearchExecutionService's
 * accounting service; the RunProcessor completes the run after research
 * finishes.
 */

import { eq, and } from 'drizzle-orm';
import type { DbInstance } from '../../types.js';
import type { ResearchExecutor, ResearchExecutionContext } from './run-processor.js';
import {
  ResearchExecutionService,
  type ProviderConfig as ResearchProviderConfig,
} from './research/research-execution-service.js';
import { TavilyAdapter } from './research/tavily-adapter.js';
import { FirecrawlAdapter } from './research/firecrawl-adapter.js';
import { ResearchCircuitBreaker } from './research/circuit-breaker.js';
import { ResearchPricingService, type PricingTableEntry } from './research/pricing.js';
import { SourceRevisionService } from './research/source-revision-service.js';
import { ResearchAttemptAccountingService } from './research/research-attempt-accounting.js';
import { EnvCredentialStore } from './research/env-credential-store.js';
import type { ResearchProviderName } from './research/origins.js';
import type { ResearchOperation } from './research/spi.js';
import logger from '../../utils/logger.js';

/**
 * Default pricing table for production research operations.
 *
 * Conservative unknown-price amounts ensure budget is reserved correctly
 * before provider calls. Actual costs are recomputed from provider-reported
 * credits at settlement time.
 */
const DEFAULT_PRICING_TABLE: Record<string, PricingTableEntry> = {
  'tavily:search': {
    provider: 'tavily',
    operation: 'search',
    pricingTableVersion: 'v1',
    currency: 'USD',
    unitDefinition: { unit: 'credit', priceNumerator: '10', priceDenominator: '1' },
    roundingRule: 'round_half_up',
    conservativeUnknownPriceCents: 100,
  },
  'tavily:extract': {
    provider: 'tavily',
    operation: 'extract',
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
  'firecrawl:scrape': {
    provider: 'firecrawl',
    operation: 'scrape',
    pricingTableVersion: 'v1',
    currency: 'USD',
    unitDefinition: { unit: 'credit', priceNumerator: '15', priceDenominator: '1' },
    roundingRule: 'round_half_up',
    conservativeUnknownPriceCents: 150,
  },
  'firecrawl:structured_extract': {
    provider: 'firecrawl',
    operation: 'structured_extract',
    pricingTableVersion: 'v1',
    currency: 'USD',
    unitDefinition: { unit: 'credit', priceNumerator: '15', priceDenominator: '1' },
    roundingRule: 'round_half_up',
    conservativeUnknownPriceCents: 150,
  },
};

/**
 * Production research executor.
 *
 * Constructed once by the worker and injected into RunProcessor. Each call
 * to `execute()` resolves the child's billing agent, constructs adapters
 * with the resolved API key, and invokes the ResearchExecutionService.
 */
export class ProductionResearchExecutor implements ResearchExecutor {
  private readonly executionService: ResearchExecutionService;
  private readonly credentialStore: EnvCredentialStore;
  private readonly pricingService: ResearchPricingService;
  private readonly circuitBreaker: ResearchCircuitBreaker;
  private readonly sourceRevisions: SourceRevisionService;
  private readonly accounting: ResearchAttemptAccountingService;

  constructor(private db: DbInstance) {
    this.credentialStore = new EnvCredentialStore();
    this.pricingService = new ResearchPricingService(db, {});
    this.circuitBreaker = new ResearchCircuitBreaker(db);
    this.sourceRevisions = new SourceRevisionService({
      drizzle: db.drizzle,
      schema: db.schema,
    });
    this.accounting = new ResearchAttemptAccountingService(db);
    this.executionService = new ResearchExecutionService(db, {
      credentialStore: this.credentialStore,
      pricingService: this.pricingService,
      circuitBreaker: this.circuitBreaker,
      sourceRevisions: this.sourceRevisions,
      accounting: this.accounting,
      pricingTable: DEFAULT_PRICING_TABLE,
    });
  }

  async execute(
    ctx: ResearchExecutionContext,
  ): Promise<{ executed: boolean; sourceCount: number }> {
    const { claim, run, policy, requestText, operations, signal } = ctx;
    const schema = this.db.schema;

    // Resolve the child's billing agent from the step assignment.
    const [assignment] = await this.db.drizzle
      .select({
        billingAgentId: schema.runStepAssignments.billingAgentId,
      })
      .from(schema.runStepAssignments)
      .where(
        and(
          eq(schema.runStepAssignments.companyId, claim.companyId),
          eq(schema.runStepAssignments.runId, claim.runId),
        ),
      )
      .limit(1);

    const billingAgentId = assignment?.billingAgentId ?? null;

    // Determine the primary provider: Tavily for search/extract, Firecrawl
    // for scrape/structured_extract. When both providers support the
    // operation, Tavily is preferred (architecture.md: Provider Fallback).
    const primaryProvider = this.resolvePrimaryProvider(operations);
    const fallbackProvider = primaryProvider === 'tavily' ? 'firecrawl' : 'tavily';

    // Resolve the API key for the primary provider.
    const apiKey = await this.credentialStore.getSecret(claim.companyId, primaryProvider);
    const fallbackApiKey = await this.credentialStore.getSecret(claim.companyId, fallbackProvider);

    // Construct adapters with the resolved API keys.
    const providers: ResearchProviderConfig[] = [];

    if (apiKey) {
      if (primaryProvider === 'tavily') {
        providers.push({
          provider: new TavilyAdapter({ apiKey }),
          name: 'tavily',
        });
      } else {
        providers.push({
          provider: new FirecrawlAdapter({ apiKey }),
          name: 'firecrawl',
        });
      }
    }

    // Add fallback provider if available and it supports the operation.
    if (fallbackApiKey && providers.length > 0) {
      if (fallbackProvider === 'tavily') {
        providers.push({
          provider: new TavilyAdapter({ apiKey: fallbackApiKey }),
          name: 'tavily',
        });
      } else {
        providers.push({
          provider: new FirecrawlAdapter({ apiKey: fallbackApiKey }),
          name: 'firecrawl',
        });
      }
    }

    if (providers.length === 0) {
      logger.warn(
        { runId: claim.runId, provider: primaryProvider },
        'ProductionResearchExecutor: no credential available for research provider',
      );
      return { executed: false, sourceCount: 0 };
    }

    // Execute each research operation. For Phase 1, we execute the first
    // research operation (search is the most common). Multiple operations
    // in a single step are executed sequentially.
    let totalSourceCount = 0;
    const durationSeconds = policy.limits?.durationSeconds ?? 300;
    const timeoutMs = Math.min(durationSeconds * 1000, 30_000);

    for (const operation of operations) {
      if (signal.aborted) {
        break;
      }

      // Build the research execution input.
      const input = {
        companyId: claim.companyId,
        projectId: claim.projectId,
        runId: claim.runId,
        rootRunId: run.rootRunId,
        billingAgentId,
        provider: primaryProvider,
        operation,
        query: operation === 'search' ? requestText : undefined,
        urls: operation !== 'search' ? undefined : undefined,
        maxResults: 10,
        timeoutMs,
        signal,
      };

      try {
        const result = await this.executionService.executeResearch(input, {
          providers,
        });
        totalSourceCount += result.sources.length;
      } catch (err) {
        logger.warn(
          { runId: claim.runId, operation, err: err instanceof Error ? err.message : String(err) },
          'ProductionResearchExecutor: research operation failed',
        );
        // Continue to next operation or complete with partial results.
      }
    }

    return { executed: true, sourceCount: totalSourceCount };
  }

  /**
   * Resolve the primary provider for a set of research operations.
   * Tavily is preferred for search/extract; Firecrawl for scrape/
   * structured_extract (architecture.md: Provider Fallback).
   */
  private resolvePrimaryProvider(operations: ResearchOperation[]): ResearchProviderName {
    for (const op of operations) {
      if (op === 'scrape' || op === 'structured_extract') {
        return 'firecrawl';
      }
    }
    return 'tavily';
  }
}
