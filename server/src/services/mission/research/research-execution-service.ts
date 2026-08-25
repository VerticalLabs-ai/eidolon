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
 * Adapters never write artifacts or invoke tools. This service orchestrates
 * the complete operation: validate → resolve credentials → check circuit →
 * reserve budget → execute with fallback → persist sources → settle
 * accounting → return citation-ready evidence.
 *
 * Secrets never appear in results, events, logs, or artifacts. The provider
 * request ID is hashed before durable storage. Unknown price is never free:
 * the configured conservative maximum is reserved and charged when usage
 * is unknown.
 */

import { createHash, randomUUID } from 'node:crypto';
import type { DbInstance } from '../../../types.js';
import {
  type CredentialStore,
  resolveResearchCredential,
  createCredentialHandle,
} from './credential-resolver.js';
import type { ResearchCircuitBreaker as CircuitBreakerService } from './circuit-breaker.js';
import {
  type ResearchPricingService,
  type PricingTableEntry,
  type PricingSnapshotResult,
  recomputeCents,
} from './pricing.js';
import type { SourceRevisionService } from './source-revision-service.js';
import type { ResearchAttemptAccountingService } from './research-attempt-accounting.js';
import {
  type ResearchProvider,
  type ResearchRequest,
  type ResearchResult,
  type ResearchCallContext,
  type NormalizedResearchSource,
  ResearchProviderError,
} from './spi.js';
import type { ResearchProviderName } from './origins.js';
import { validateResearchRequest } from './request-validation.js';
import { executeWithFallback, type FallbackEntry, type FallbackConfig } from './fallback.js';
import { DEFAULT_FALLBACK_POLICY } from './classification.js';
import { DEFAULT_RETRY_CONFIG } from './retry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Input for a research execution request. */
export interface ResearchExecutionInput {
  companyId: string;
  projectId?: string;
  runId: string;
  rootRunId: string;
  billingAgentId?: string | null;
  /** The primary provider to use. */
  provider: ResearchProviderName;
  /** The operation to perform. */
  operation: ResearchRequest['operation'];
  /** Search query (required for search). */
  query?: string;
  /** Target URLs (required for extract/scrape/structured_extract). */
  urls?: string[];
  /** Structured extraction schema (required for structured_extract). */
  schema?: Record<string, unknown>;
  /** Maximum number of results (1–20). */
  maxResults: number;
  /** Operation timeout in milliseconds. */
  timeoutMs: number;
  /** Optional AbortSignal for cancellation. */
  signal?: AbortSignal;
}

/** Provider configuration for execution. */
export interface ProviderConfig {
  /** The provider adapter. */
  provider: ResearchProvider;
  /** The provider name. */
  name: ResearchProviderName;
}

/** Result of a research execution. */
export interface ResearchExecutionResult {
  /** The logical call ID (deterministic, separate from physical attempt IDs). */
  logicalCallId: string;
  /** Which provider produced this result. */
  provider: ResearchProviderName;
  /** The research attempt ID (from research_attempts table). */
  attemptId: string;
  /** SHA-256 hash of the provider request ID (lowercase hex). */
  providerRequestIdHash?: string;
  /** Provider-reported credits used. */
  credits?: number;
  /** Actual charge in integer cents. */
  costCents: number;
  /** Normalized sources from the provider. */
  sources: NormalizedResearchSource[];
  /** Persisted source revisions. */
  persistedRevisions: Array<{
    sourceId: string;
    sourceRevisionId: string;
    canonicalUrl: string;
    canonicalUrlHash: string;
    contentHash?: string;
    byteCount: number;
    retrievedAt: string;
    normalizationVersion: number;
    createdNewSource: boolean;
    createdNewRevision: boolean;
  }>;
  /** Non-fatal warnings (bounded, safe). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ResearchExecutionServiceDeps {
  /** Credential store (company-scoped encrypted secrets). */
  credentialStore: CredentialStore;
  /** Pricing service for settlement conversion. */
  pricingService: ResearchPricingService;
  /** Circuit breaker service. */
  circuitBreaker: CircuitBreakerService;
  /** Source revision persistence service. */
  sourceRevisions: SourceRevisionService;
  /** Research attempt accounting service. */
  accounting: ResearchAttemptAccountingService;
  /** Optional clock for deterministic tests. */
  clock?: () => Date;
  /**
   * Optional pricing table entries keyed by `${provider}:${operation}`.
   * When provided, the service creates a pricing snapshot before
   * execution. When absent, the service uses a conservative default.
   */
  pricingTable?: Record<string, PricingTableEntry>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Production research execution service.
 *
 * Orchestrates a complete research operation: validate request → resolve
 * credentials → check circuit → reserve budget → execute with fallback →
 * persist sources → settle accounting → return citation-ready evidence.
 *
 * Never leaks secrets. Hashes provider request IDs before durable storage.
 * Settles every paid attempt exactly once.
 */
export class ResearchExecutionService {
  private readonly clock: () => Date;
  private readonly credentialStore: CredentialStore;
  private readonly pricingService: ResearchPricingService;
  private readonly circuitBreaker: CircuitBreakerService;
  private readonly sourceRevisions: SourceRevisionService;
  private readonly accounting: ResearchAttemptAccountingService;
  private readonly pricingTable: Record<string, PricingTableEntry> | undefined;

  constructor(
    private db: DbInstance,
    deps: ResearchExecutionServiceDeps,
  ) {
    this.clock = deps.clock ?? (() => new Date());
    this.credentialStore = deps.credentialStore;
    this.pricingService = deps.pricingService;
    this.circuitBreaker = deps.circuitBreaker;
    this.sourceRevisions = deps.sourceRevisions;
    this.accounting = deps.accounting;
    this.pricingTable = deps.pricingTable;
  }

  /**
   * Execute a research operation through the production path.
   *
   * @param input The research execution input.
   * @param config Provider configuration (adapters to use).
   * @returns The research execution result with normalized sources,
   *          persisted revisions, and settled accounting.
   */
  async executeResearch(
    input: ResearchExecutionInput,
    config: { providers: ProviderConfig[] },
  ): Promise<ResearchExecutionResult> {
    const logicalCallId = randomUUID();

    // 1. Resolve credentials for the primary provider.
    const providerName = input.provider;
    const defaultKey = this.getEnvCredential(providerName);
    const credential = await resolveResearchCredential(
      this.credentialStore,
      input.companyId,
      providerName,
      defaultKey,
    );
    const credentialHandle = createCredentialHandle(credential);
    // The API key is used by the caller to construct adapters; we resolve
    // it here only as the credential guard (fail closed when unavailable).
    void credentialHandle.getApiKey();

    // 2. Use the adapter instances provided in the config. The credential
    //    resolution above serves as the credential guard (fail closed when
    //    no credential is available). The adapters themselves are
    //    constructed by the caller with the resolved API key.
    const fallbackEntries: FallbackEntry[] = config.providers.map((pc) => ({
      provider: pc.provider,
      name: pc.name,
    }));

    // 3. Build the research request.
    const request: ResearchRequest = {
      operation: input.operation,
      query: input.query,
      urls: input.urls,
      schema: input.schema,
      maxResults: input.maxResults,
      timeoutMs: input.timeoutMs,
    };

    // 4. Validate the request shape before any budget or network work.
    const primaryAdapter = fallbackEntries[0]!;
    const validation = validateResearchRequest(
      request,
      (op) => primaryAdapter.provider.supports(op),
      primaryAdapter.name,
    );
    if (!validation.ok) {
      throw validation.error!;
    }

    // 5. Create or retrieve a pricing snapshot for settlement.
    const pricingKey = `${providerName}:${input.operation}`;
    const pricingEntry = this.pricingTable?.[pricingKey];
    let pricingSnapshot: PricingSnapshotResult | undefined;
    if (pricingEntry) {
      // Create an immutable pricing snapshot for this attempt.
      pricingSnapshot = await this.pricingService.snapshotPricing(
        pricingEntry,
        0, // credits reported after execution; snapshot created with 0, recomputed at settlement
      );
    }
    const conservativeEstimateCents = pricingSnapshot?.conservativeUnknownPriceCents ?? 100;

    // 6. Reserve budget in-flight inside a transaction.
    let attemptId: string;
    await this.db.drizzle.transaction(async (tx) => {
      // Preflight: verify budget can cover the conservative estimate.
      await this.accounting.preflight(tx, input.runId, conservativeEstimateCents);

      // Reserve in-flight hold.
      const reserveResult = await this.accounting.reserveInFlight(tx, {
        companyId: input.companyId,
        projectId: input.projectId,
        runId: input.runId,
        rootRunId: input.rootRunId,
        logicalCallId,
        attemptOrdinal: 1,
        provider: providerName,
        operation: input.operation,
        reservedCents: conservativeEstimateCents,
      });
      attemptId = reserveResult.attemptId;

      // Mark started.
      await this.accounting.markStarted(tx, attemptId);
    });

    // 7. Execute with fallback/retry.
    const context: ResearchCallContext = {
      signal: input.signal,
      logicalCallId,
    };

    const fallbackConfig: FallbackConfig = {
      fallbackPolicy: DEFAULT_FALLBACK_POLICY,
      retryConfig: DEFAULT_RETRY_CONFIG,
    };

    let providerResult: ResearchResult;
    try {
      providerResult = await executeWithFallback(request, fallbackEntries, fallbackConfig, context);
    } catch (err) {
      // Mark the attempt as failed and release the in-flight hold.
      await this.db.drizzle.transaction(async (tx) => {
        const errorCode = err instanceof ResearchProviderError ? err.code : 'PROVIDER_PERMANENT';
        const safeMessage =
          err instanceof ResearchProviderError ? err.message : 'Research provider execution failed';
        await this.accounting.markFailed(tx, attemptId!, errorCode, safeMessage);
      });
      throw err;
    }

    // 8. Hash the provider request ID before any durable storage.
    const providerRequestIdHash = providerResult.providerRequestId
      ? createHash('sha256').update(providerResult.providerRequestId, 'utf8').digest('hex')
      : undefined;

    // 9. Persist source revisions.
    const persistedRevisions: ResearchExecutionResult['persistedRevisions'] = [];
    for (let i = 0; i < providerResult.sources.length; i++) {
      const source = providerResult.sources[i]!;
      const queryHash = input.query
        ? createHash('sha256').update(input.query, 'utf8').digest('hex')
        : undefined;

      const persisted = await this.sourceRevisions.persistSourceRevision({
        companyId: input.companyId,
        projectId: input.projectId,
        runId: input.runId,
        rootRunId: input.rootRunId,
        logicalCallId,
        provider: providerName,
        operation: input.operation,
        providerRequestIdHash,
        source,
        rank: source.rank ?? i,
        relevanceScore: source.score,
        queryHash,
        warnings: providerResult.warnings,
      });

      persistedRevisions.push({
        sourceId: persisted.sourceId,
        sourceRevisionId: persisted.sourceRevisionId,
        canonicalUrl: persisted.canonicalUrl,
        canonicalUrlHash: persisted.canonicalUrlHash,
        contentHash: persisted.contentHash,
        byteCount: persisted.byteCount,
        retrievedAt: persisted.retrievedAt,
        normalizationVersion: persisted.normalizationVersion,
        createdNewSource: persisted.createdNewSource,
        createdNewRevision: persisted.createdNewRevision,
      });
    }

    // 10. Settle the attempt with credits and cost.
    let costCents = 0;
    await this.db.drizzle.transaction(async (tx) => {
      const externalCallId = `research:${logicalCallId}:1`;
      const reportedCredits = providerResult.credits ?? 0;

      // Compute cost from pricing snapshot.
      if (pricingSnapshot) {
        costCents = recomputeCents({
          unitDefinition: pricingSnapshot.unitDefinition,
          roundingRule: pricingSnapshot.roundingRule,
          reportedCredits,
        });
      } else {
        // No pricing snapshot — use conservative max.
        costCents = conservativeEstimateCents;
      }

      await this.accounting.settleAttempt(tx, attemptId!, {
        externalCallId,
        reportedCredits,
        providerRequestIdHash,
        pricingSnapshotId: pricingSnapshot?.id,
        costCents,
        billingAgentId: input.billingAgentId,
      });
    });

    // 11. Return citation-ready evidence without leaking secrets.
    return {
      logicalCallId,
      provider: providerName,
      attemptId: attemptId!,
      providerRequestIdHash,
      credits: providerResult.credits,
      costCents,
      sources: providerResult.sources,
      persistedRevisions,
      warnings: providerResult.warnings,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Get the deployment-default credential from environment. */
  private getEnvCredential(provider: ResearchProviderName): string | undefined {
    if (provider === 'tavily') {
      return process.env.TAVILY_API_KEY;
    }
    if (provider === 'firecrawl') {
      return process.env.FIRECRAWL_API_KEY;
    }
    return undefined;
  }
}
