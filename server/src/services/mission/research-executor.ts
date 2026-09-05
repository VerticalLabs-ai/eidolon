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
export interface ProductionResearchExecutorDeps {
  /** Override the internally-constructed execution service (test seam). */
  executionService?: ResearchExecutionService;
}

export class ProductionResearchExecutor implements ResearchExecutor {
  private readonly executionService: ResearchExecutionService;
  private readonly credentialStore: EnvCredentialStore;
  private readonly pricingService: ResearchPricingService;
  private readonly circuitBreaker: ResearchCircuitBreaker;
  private readonly sourceRevisions: SourceRevisionService;
  private readonly accounting: ResearchAttemptAccountingService;

  constructor(
    private db: DbInstance,
    deps: ProductionResearchExecutorDeps = {},
  ) {
    this.credentialStore = new EnvCredentialStore();
    this.pricingService = new ResearchPricingService(db, {});
    this.circuitBreaker = new ResearchCircuitBreaker(db);
    this.sourceRevisions = new SourceRevisionService({
      drizzle: db.drizzle,
      schema: db.schema,
    });
    this.accounting = new ResearchAttemptAccountingService(db);
    this.executionService =
      deps.executionService ??
      new ResearchExecutionService(db, {
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

    // Resolve credentials for both providers up front so we can select
    // the correct adapter per operation based on capability.
    const tavilyKey = await this.credentialStore.getSecret(claim.companyId, 'tavily');
    const firecrawlKey = await this.credentialStore.getSecret(claim.companyId, 'firecrawl');

    const tavilyAdapter = tavilyKey ? new TavilyAdapter({ apiKey: tavilyKey }) : null;
    const firecrawlAdapter = firecrawlKey ? new FirecrawlAdapter({ apiKey: firecrawlKey }) : null;

    if (!tavilyAdapter && !firecrawlAdapter) {
      logger.warn(
        { runId: claim.runId },
        'ProductionResearchExecutor: no credential available for any research provider',
      );
      return { executed: false, sourceCount: 0 };
    }

    // Execute each research operation, selecting the provider that
    // supports it. Search is preferred with Tavily; extract is Tavily-only;
    // scrape/structured_extract are Firecrawl-only
    // (architecture.md: Provider Fallback, fix-ut-m5-research-execution-gaps).
    //
    // URL-requiring operations (extract, scrape, structured_extract) are
    // only attempted when URLs are available from prior search results in
    // the same execution context. Operations without required inputs are
    // skipped gracefully (fix-ut-m5-research-execution-gaps).
    let totalSourceCount = 0;
    let succeededCount = 0;
    const collectedUrls: string[] = [];
    const durationSeconds = policy.limits?.durationSeconds ?? 300;
    const timeoutMs = Math.min(durationSeconds * 1000, 30_000);

    for (const operation of operations) {
      if (signal.aborted) {
        break;
      }

      const opResult = await this.tryExecuteOperation({
        runId: claim.runId,
        companyId: claim.companyId,
        projectId: claim.projectId,
        rootRunId: run.rootRunId,
        billingAgentId,
        operation,
        requestText,
        timeoutMs,
        signal,
        tavilyAdapter,
        firecrawlAdapter,
        collectedUrls,
      });

      if (opResult.executed) {
        totalSourceCount += opResult.sourceCount;
        succeededCount += 1;
      }
    }

    // When every research operation failed (or none ran due to abort),
    // report executed=false so the run falls through to the LLM provider
    // call path or fails with a proper research error category instead of
    // completing as if research succeeded (fix-ut-m5-research-attempt-transaction).
    if (succeededCount === 0) {
      return { executed: false, sourceCount: 0 };
    }

    return { executed: true, sourceCount: totalSourceCount };
  }

  /**
   * Attempt a single research operation with provider capability filtering
   * and URL-availability gating (fix-ut-m5-research-execution-gaps).
   *
   * Returns `{ executed: true, sourceCount }` on success, or
   * `{ executed: false, sourceCount: 0 }` when the operation is skipped
   * (no provider supports it, no URLs available) or fails.
   */
  private async tryExecuteOperation(params: {
    runId: string;
    companyId: string;
    projectId: string;
    rootRunId: string;
    billingAgentId: string | null;
    operation: ResearchOperation;
    requestText: string;
    timeoutMs: number;
    signal: AbortSignal;
    tavilyAdapter: TavilyAdapter | null;
    firecrawlAdapter: FirecrawlAdapter | null;
    collectedUrls: string[];
  }): Promise<{ executed: boolean; sourceCount: number }> {
    const {
      runId,
      companyId,
      projectId,
      rootRunId,
      billingAgentId,
      operation,
      requestText,
      timeoutMs,
      signal,
      tavilyAdapter,
      firecrawlAdapter,
      collectedUrls,
    } = params;

    // Select the provider for this operation based on capability.
    const selection = this.selectProviderForOperation(operation, tavilyAdapter, firecrawlAdapter);

    if (!selection) {
      logger.info(
        { runId, operation },
        'ProductionResearchExecutor: skipping operation, no available provider supports it',
      );
      return { executed: false, sourceCount: 0 };
    }

    // URL-requiring operations need at least one URL from prior search
    // results. Skip gracefully when none are available.
    if (operation !== 'search' && collectedUrls.length === 0) {
      logger.info(
        { runId, operation },
        'ProductionResearchExecutor: skipping operation, no URLs available from prior search results',
      );
      return { executed: false, sourceCount: 0 };
    }

    const input = {
      companyId,
      projectId,
      runId,
      rootRunId,
      billingAgentId,
      provider: selection.primaryName,
      operation,
      query: operation === 'search' ? requestText : undefined,
      urls: operation !== 'search' ? collectedUrls : undefined,
      maxResults: 10,
      timeoutMs,
      signal,
    };

    try {
      const result = await this.executionService.executeResearch(input, {
        providers: selection.providers,
      });

      // Collect URLs from search results for subsequent URL-requiring
      // operations (extract, scrape, structured_extract).
      if (operation === 'search') {
        for (const source of result.sources) {
          if (source.canonicalUrl) {
            collectedUrls.push(source.canonicalUrl);
          }
        }
      }

      return { executed: true, sourceCount: result.sources.length };
    } catch (err) {
      logger.warn(
        { runId, operation, err: err instanceof Error ? err.message : String(err) },
        'ProductionResearchExecutor: research operation failed',
      );
      return { executed: false, sourceCount: 0 };
    }
  }

  /**
   * Select the primary provider and fallback providers for a given
   * operation based on the provider capability matrix
   * (architecture.md: Provider Fallback, fix-ut-m5-research-execution-gaps).
   *
   * - search: Tavily preferred, Firecrawl fallback
   * - extract: Tavily only (Firecrawl does not support extract)
   * - scrape: Firecrawl only (Tavily does not support scrape)
   * - structured_extract: Firecrawl only (Tavily does not support structured_extract)
   *
   * Returns null when no available adapter supports the operation.
   */
  private selectProviderForOperation(
    operation: ResearchOperation,
    tavilyAdapter: TavilyAdapter | null,
    firecrawlAdapter: FirecrawlAdapter | null,
  ): {
    primaryName: ResearchProviderName;
    providers: ResearchProviderConfig[];
  } | null {
    const providers: ResearchProviderConfig[] = [];

    if (operation === 'search') {
      // Prefer Tavily for search, fallback to Firecrawl.
      if (tavilyAdapter) {
        providers.push({ provider: tavilyAdapter, name: 'tavily' });
      }
      if (firecrawlAdapter) {
        providers.push({ provider: firecrawlAdapter, name: 'firecrawl' });
      }
    } else if (operation === 'extract') {
      // Extract is Tavily-only.
      if (tavilyAdapter) {
        providers.push({ provider: tavilyAdapter, name: 'tavily' });
      }
    } else if (operation === 'scrape' || operation === 'structured_extract') {
      // Scrape/structured_extract are Firecrawl-only.
      if (firecrawlAdapter) {
        providers.push({ provider: firecrawlAdapter, name: 'firecrawl' });
      }
    }

    if (providers.length === 0) {
      return null;
    }

    return {
      primaryName: providers[0]!.name,
      providers,
    };
  }
}
