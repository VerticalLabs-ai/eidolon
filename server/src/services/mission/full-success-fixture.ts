/**
 * Nonproduction full-success fixture (`full-success-v1`).
 *
 * (VAL-CROSS-103)
 *
 * Deterministically supplies request classification, question generation,
 * PlanContentV1, child outcomes, normalized research evidence, and
 * supported citations through test-controlled adapters at declared seams,
 * while still executing production command, policy, hash, approval, routing,
 * evidence, artifact, projection, and UI code.
 *
 * It cannot bypass authorization, budgets, limits, network policy, or commit
 * validation and is unavailable in production builds.
 *
 * This module is gated by the `MISSION_FULL_SUCCESS_FIXTURE` environment
 * variable. It can only be constructed when that variable is set to `'1'`.
 * The production worker entry point and API server never set this variable.
 *
 * The fixture adapters implement the same `ResearchProvider` SPI as the
 * production Tavily and Firecrawl adapters. They produce deterministic
 * normalized sources, but all downstream validation, normalization,
 * persistence, citation binding, and artifact commit remain production code
 * paths.
 */

import { createHash } from 'node:crypto';
import type {
  ResearchProvider,
  ResearchRequest,
  ResearchResult,
  ResearchCallContext,
  NormalizedResearchSource,
  ResearchOperation,
} from './research/spi.js';
import type { ResearchProviderName } from './research/origins.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from './plan-schema.js';

/** Environment flag that enables the full-success fixture. */
export const FULL_SUCCESS_ENV_FLAG = 'MISSION_FULL_SUCCESS_FIXTURE';

/** Returns true only when the full-success fixture is explicitly enabled. */
export function isFullSuccessFixtureEnabled(): boolean {
  return process.env[FULL_SUCCESS_ENV_FLAG] === '1';
}

/**
 * Assert that the full-success fixture is enabled. Throws if called in
 * production.
 * @internal
 */
export function assertFullSuccessFixtureEnabled(): void {
  if (!isFullSuccessFixtureEnabled()) {
    throw new Error(
      `Full-success fixture is test-only. Set ${FULL_SUCCESS_ENV_FLAG}=1 to enable. ` +
        'Production routes cannot accept fixture-supplied adapters or plan vectors.',
    );
  }
}

// ---------------------------------------------------------------------------
// Full-success research adapter
// ---------------------------------------------------------------------------

/**
 * Test-only research adapter that implements the `ResearchProvider` SPI.
 *
 * Produces deterministic normalized sources with all required fields:
 * canonical HTTPS URL, title, content hash, byte count, injection-risk
 * labels, and retrieval timestamp. The adapter does NOT bypass network
 * policy — it produces fixed HTTPS URLs and never accepts arbitrary origins.
 *
 * All downstream validation, normalization, persistence, citation binding,
 * and artifact commit remain production code paths.
 *
 * (VAL-CROSS-103)
 */
export class FullSuccessResearchAdapter implements ResearchProvider {
  constructor() {
    assertFullSuccessFixtureEnabled();
  }

  supports(operation: ResearchOperation): boolean {
    return operation === 'search' || operation === 'extract';
  }

  async execute(request: ResearchRequest, context: ResearchCallContext): Promise<ResearchResult> {
    assertFullSuccessFixtureEnabled();

    const logicalCallId = context.logicalCallId ?? `full-success-${Date.now()}`;
    const retrievedAt = new Date().toISOString();

    // Produce deterministic normalized sources with fixed HTTPS URLs.
    // The adapter does NOT use the query content to construct URLs — it
    // always returns the same fixed sources, preventing SSRF or origin
    // override through the query parameter.
    const sources: NormalizedResearchSource[] = [
      {
        canonicalUrl: 'https://example.com/full-success-source-1',
        title: 'Full Success Source 1',
        author: 'Test Author',
        publishedAt: '2026-01-15T00:00:00.000Z',
        rank: 0,
        score: 0.95,
        retrievedAt,
        mimeType: 'text/html',
        language: 'en',
        text: 'This is deterministic normalized content from the full-success fixture. It contains factual claims that should be cited in the generated artifact.',
        contentHash: createHash('sha256')
          .update(
            'This is deterministic normalized content from the full-success fixture. It contains factual claims that should be cited in the generated artifact.',
          )
          .digest('hex'),
        byteCount: 120,
        providerMetadata: {
          fixture: 'full-success-v1',
          provider: 'tavily',
        },
        injectionRiskLabels: [],
      },
      {
        canonicalUrl: 'https://example.com/full-success-source-2',
        title: 'Full Success Source 2',
        author: 'Test Author 2',
        publishedAt: '2026-02-20T00:00:00.000Z',
        rank: 1,
        score: 0.88,
        retrievedAt,
        mimeType: 'text/html',
        language: 'en',
        text: 'A second deterministic source providing additional evidence for the research artifact.',
        contentHash: createHash('sha256')
          .update(
            'A second deterministic source providing additional evidence for the research artifact.',
          )
          .digest('hex'),
        byteCount: 80,
        providerMetadata: {
          fixture: 'full-success-v1',
          provider: 'tavily',
        },
        injectionRiskLabels: [],
      },
    ];

    return {
      logicalCallId,
      provider: 'tavily' as ResearchProviderName,
      providerRequestId: `full-success-req-${logicalCallId}`,
      credits: 1,
      sources,
      warnings: [],
    };
  }
}

/**
 * Create a full-success research adapter. Throws if the fixture is disabled.
 */
export function createFullSuccessResearchAdapter(): FullSuccessResearchAdapter {
  return new FullSuccessResearchAdapter();
}

// ---------------------------------------------------------------------------
// Full-success plan vector
// ---------------------------------------------------------------------------

/** A deterministic plan vector for the full-success fixture. */
export interface FullSuccessPlanVector {
  /** The raw plan content to feed through production validators. */
  content: unknown;
  /** Safe metadata for the generatedBy field. */
  generatedBy: Record<string, unknown>;
}

/**
 * Create a deterministic PlanContentV1 vector for the full-success fixture.
 *
 * The plan content is a valid PlanContentV1 object that will be validated
 * through production schemas, canonicalizers, and the publication
 * transaction. It does NOT bypass plan validation, approval binding, or
 * budget reservation.
 *
 * (VAL-CROSS-103)
 */
export function createFullSuccessPlanVector(): FullSuccessPlanVector {
  assertFullSuccessFixtureEnabled();

  const content = {
    schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
    objective: 'Research and synthesize evidence from the full-success fixture',
    steps: [
      {
        stepKey: 'research-step',
        parentStepKey: null,
        childOrdinal: 0,
        nodeKind: 'root' as const,
        title: 'Research Phase',
        description: 'Gather deterministic research evidence from the fixture adapter',
        dependencies: [],
        inputBindings: [],
        routing: {
          kind: 'requirements' as const,
          routingRequirements: {
            capabilities: ['research'],
            requiredTools: ['research.search'],
            requiredDomains: [],
            ephemeralAllowed: true,
          },
        },
        toolAllowlist: ['research.search'],
        replayClass: 'read_only' as const,
        sideEffecting: false,
        expectedOutputs: ['research-evidence'],
        evidenceRequirements: {
          citationsRequired: true,
        },
        completionCriteria: 'At least one source with a valid citation',
        budgetCents: 100,
        limits: {},
      },
    ],
    synthesis: {
      instructions: 'Synthesize the research evidence into a cited artifact',
      declaredInputs: [
        {
          kind: 'stepOutput' as const,
          stepKey: 'research-step',
          output: 'research-evidence',
        },
      ],
      declaredOutput: 'cited-artifact',
      evidenceRequirements: {
        citationsRequired: true,
      },
      completionCriteria: 'Artifact with at least one inline citation',
      budgetCents: 100,
    },
    planningBudgetCents: 50,
    partialResultPolicy: 'require_all' as const,
    limits: {
      steps: 4,
      durationSeconds: 300,
      providerCalls: 6,
      totalTokens: 32000,
      outputBytes: 1048576,
      costCents: 500,
      depth: 0,
      fanOut: 0,
      descendants: 0,
    },
    presentationMetadata: {
      cardTitle: 'Full Success Research Mission',
      summary: 'Deterministic research and synthesis with cited evidence',
    },
  };

  return {
    content,
    generatedBy: {
      source: 'full-success-fixture',
      fixture: 'full-success-v1',
    },
  };
}

// ---------------------------------------------------------------------------
// Full-success child outcome
// ---------------------------------------------------------------------------

/** A deterministic child outcome for the full-success fixture. */
export interface FullSuccessChildOutcome {
  /** The step key this outcome belongs to. */
  stepKey: string;
  /** The outcome status. */
  status: 'completed' | 'failed' | 'cancelled';
  /** Result completeness. */
  resultCompleteness: 'full' | 'partial' | null;
  /** The output produced by the child. */
  output: string;
  /** Whether the child produced evidence. */
  hasEvidence: boolean;
}

/**
 * Create a deterministic child outcome for the full-success fixture.
 *
 * (VAL-CROSS-103)
 */
export function createFullSuccessChildOutcome(): FullSuccessChildOutcome {
  assertFullSuccessFixtureEnabled();

  return {
    stepKey: 'research-step',
    status: 'completed',
    resultCompleteness: 'full',
    output: 'Deterministic child output with research evidence',
    hasEvidence: true,
  };
}

// ---------------------------------------------------------------------------
// Full-success citation
// ---------------------------------------------------------------------------

/** A deterministic citation for the full-success fixture. */
export interface FullSuccessCitation {
  /** The exact quote from the source. */
  exactQuote: string;
  /** SHA-256 hash of the exact quote. */
  quoteHash: string;
  /** The normalized source locator. */
  sourceLocator: {
    kind: 'web';
    canonicalUrl: string;
    textQuote: { exact: string; prefix: string; suffix: string };
  };
  /** The artifact locator. */
  artifactLocator: { artifactVersion: number; jsonPointer: string };
  /** The citation ordinal. */
  ordinal: number;
}

/**
 * Create a deterministic citation for the full-success fixture.
 *
 * The citation has an exact quote, SHA-256 quote hash, normalized source
 * locator, and artifact locator — all required fields for production citation
 * validation.
 *
 * (VAL-CROSS-103)
 */
export function createFullSuccessCitation(): FullSuccessCitation {
  assertFullSuccessFixtureEnabled();

  const exactQuote = 'This is deterministic normalized content from the full-success fixture.';
  const quoteHash = createHash('sha256').update(exactQuote).digest('hex');

  return {
    exactQuote,
    quoteHash,
    sourceLocator: {
      kind: 'web',
      canonicalUrl: 'https://example.com/full-success-source-1',
      textQuote: {
        exact: exactQuote,
        prefix: '',
        suffix: '',
      },
    },
    artifactLocator: {
      artifactVersion: 1,
      jsonPointer: '/body/0',
    },
    ordinal: 0,
  };
}
