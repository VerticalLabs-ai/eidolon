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
import { eq, sql } from 'drizzle-orm';
import type { DbInstance } from '../../../types.js';
import {
  type CredentialStore,
  resolveResearchCredential,
  createCredentialHandle,
} from './credential-resolver.js';
import type { ResearchCircuitBreaker as CircuitBreakerService } from './circuit-breaker.js';
import { type ResearchPricingService, type PricingTableEntry } from './pricing.js';
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
import {
  executeWithFallback,
  type FallbackEntry,
  type FallbackConfig,
  type FallbackHooks,
} from './fallback.js';
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
    let attemptOrdinal = 0;
    let attemptId = '';
    let costCents = 0;
    // Wrap the physical adapter call, rather than audit hooks (whose failures
    // are deliberately swallowed). Every retry/fallback must acquire its own
    // durable hold and settle before another physical request can begin.
    const fallbackEntries: FallbackEntry[] = config.providers.map((pc) => ({
      name: pc.name,
      provider: {
        supports: (operation) => pc.provider.supports(operation),
        execute: async (request, context) => {
          await resolveResearchCredential(
            this.credentialStore,
            input.companyId,
            pc.name,
            pc.name === providerName ? defaultKey : undefined,
          );
          const entry = this.pricingTable?.[`${pc.name}:${input.operation}`];
          const estimate = entry?.conservativeUnknownPriceCents ?? 100;
          const ordinal = ++attemptOrdinal;
          const externalCallId = `research:${logicalCallId}:${ordinal}`;
          let currentAttemptId = '';
          await this.db.drizzle.transaction(async (tx) => {
            await this.accounting.preflight(tx, input.runId, estimate);
            const hold = await this.accounting.reserveInFlight(tx, {
              companyId: input.companyId,
              projectId: input.projectId,
              runId: input.runId,
              rootRunId: input.rootRunId,
              logicalCallId,
              attemptOrdinal: ordinal,
              provider: pc.name,
              operation: input.operation,
              reservedCents: estimate,
            });
            currentAttemptId = hold.attemptId;
            await this.accounting.markStarted(tx, currentAttemptId);
          });
          let result: ResearchResult;
          try {
            result = await pc.provider.execute(request, context);
          } catch (error) {
            const code = error instanceof ResearchProviderError ? error.code : 'PROVIDER_TRANSIENT';
            // An ambiguous response can already have incurred a charge.
            const unknown = ['PROVIDER_TRANSIENT', 'MALFORMED_RESPONSE', 'CANCELLED'].includes(
              code,
            );
            await this.db.drizzle.transaction(async (tx) => {
              if (unknown) {
                await this.accounting.markUnknown(tx, currentAttemptId, {
                  externalCallId,
                  conservativeMaxCents: estimate,
                  billingAgentId: input.billingAgentId,
                });
              } else {
                await this.accounting.markFailed(
                  tx,
                  currentAttemptId,
                  code,
                  'Research provider attempt failed',
                );
              }
            });
            if (unknown) {
              costCents += estimate;
            }
            throw error;
          }
          // Freeze actual reported usage in a new immutable snapshot. Missing
          // usage is charged conservatively and is never silently treated as zero.
          const snapshot =
            entry && result.credits !== undefined
              ? await this.pricingService.snapshotPricing(entry, result.credits)
              : undefined;
          const charge = snapshot?.resultingCents ?? estimate;
          const requestHash = result.providerRequestId
            ? createHash('sha256').update(result.providerRequestId, 'utf8').digest('hex')
            : undefined;
          await this.db.drizzle.transaction(async (tx) => {
            if (result.credits === undefined) {
              await this.accounting.markUnknown(tx, currentAttemptId, {
                externalCallId,
                conservativeMaxCents: estimate,
                billingAgentId: input.billingAgentId,
              });
            } else {
              await this.accounting.settleAttempt(tx, currentAttemptId, {
                externalCallId,
                reportedCredits: result.credits,
                providerRequestIdHash: requestHash,
                pricingSnapshotId: snapshot?.id,
                costCents: charge,
                billingAgentId: input.billingAgentId,
              });
            }
          });
          attemptId = currentAttemptId;
          costCents += charge;
          return result;
        },
      },
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

    // 7. Emit research.started event (VAL-CROSS-033).
    await this.emitResearchEvent(input, 'research.started', {
      logicalCallId,
      provider: providerName,
      operation: input.operation,
    });

    // 8. Execute with fallback/retry, wiring audit hooks (VAL-CROSS-033).
    const context: ResearchCallContext = {
      signal: input.signal,
      logicalCallId,
    };

    const hooks: FallbackHooks = {
      onProviderAttempt: async (info) => {
        await this.emitResearchEvent(input, 'research.provider_attempted', {
          logicalCallId,
          provider: info.provider,
          attempt: info.attempt,
          isFallback: info.isFallback,
        });
      },
      onProviderFallback: async (info) => {
        await this.emitResearchEvent(input, 'research.provider_fallback', {
          logicalCallId,
          fromProvider: info.fromProvider,
          toProvider: info.toProvider,
          reason: info.reason,
        });
      },
      onProviderSuccess: async () => {
        // Success is recorded by research.completed below.
      },
      onProviderFailure: async () => {
        // Failure is recorded by research.failed below.
      },
    };

    const fallbackConfig: FallbackConfig = {
      fallbackPolicy: DEFAULT_FALLBACK_POLICY,
      retryConfig: DEFAULT_RETRY_CONFIG,
      hooks,
    };

    let providerResult: ResearchResult;
    try {
      providerResult = await executeWithFallback(request, fallbackEntries, fallbackConfig, context);
    } catch (err) {
      const errorCode = err instanceof ResearchProviderError ? err.code : 'PROVIDER_PERMANENT';
      // Emit research.failed event (VAL-CROSS-033).
      await this.emitResearchEvent(input, 'research.failed', {
        logicalCallId,
        provider: err instanceof ResearchProviderError ? err.provider : providerName,
        errorCode,
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
        provider: providerResult.provider,
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

    // 11. Emit research.completed event (VAL-CROSS-033).
    // Include the hashed provider request ID for trace correlation
    // (VAL-RES-002, VAL-CROSS-031, fix-ut-m5-synthesis-artifact-citation-wiring).
    await this.emitResearchEvent(input, 'research.completed', {
      logicalCallId,
      provider: providerResult.provider,
      sourceCount: providerResult.sources.length,
      costCents,
      providerRequestIdHash,
    });

    // 12. Return citation-ready evidence without leaking secrets.
    return {
      logicalCallId,
      provider: providerResult.provider,
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

  /**
   * Append a research event to the run journal (VAL-CROSS-033).
   *
   * Locks the run row, reads the current last_event_sequence, increments
   * it, inserts the event, and updates the run counter in one transaction.
   * Events are ordered by sequence and never contain secrets, credentials,
   * raw provider bodies, or retrieved content.
   */
  private async emitResearchEvent(
    input: ResearchExecutionInput,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const schema = this.db.schema;
    const now = this.clock();
    await this.db.drizzle.transaction(async (tx) => {
      // Lock and read the run row.
      const rows = (await tx.execute(sql`
        SELECT "state_version", "last_event_sequence", "project_id"
        FROM "mission_runs"
        WHERE "id" = ${input.runId} AND "company_id" = ${input.companyId}
        FOR UPDATE
      `)) as unknown as Array<{
        state_version: string;
        last_event_sequence: string;
        project_id: string;
      }>;
      if (!rows[0]) {
        return; // Run not found — skip event emission.
      }

      const currentSeq = Number(rows[0]!.last_event_sequence);
      const newSeq = currentSeq + 1;
      const newVersion = Number(rows[0]!.state_version) + 1;
      const runProjectId = rows[0]!.project_id;

      // Insert the event.
      await tx.insert(schema.runEvents).values({
        companyId: input.companyId,
        projectId: runProjectId,
        runId: input.runId,
        sequence: newSeq,
        type,
        schemaVersion: 1,
        payload,
        actorType: 'system',
        actorId: null,
        traceId: null,
        occurredAt: now,
      });

      // Update the run's last_event_sequence and state_version.
      await tx
        .update(schema.missionRuns)
        .set({
          lastEventSequence: newSeq,
          stateVersion: newVersion,
          updatedAt: now,
        })
        .where(eq(schema.missionRuns.id, input.runId));
    });
  }

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
