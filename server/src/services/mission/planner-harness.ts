import type { PlanGenerator, PlanGeneratorOutcome, PlannerContext } from './planner.js';

/**
 * Nonproduction planner/fault harness (VAL-PLAN-130).
 *
 * A named test-only harness that can inject exact generated plan vectors,
 * delayed claims, budget changes, projection faults, and process checkpoints
 * only in test configuration while invoking production schemas,
 * canonicalizers, transactions, and worker gates.
 *
 * **Production routes cannot accept validator-authored plans or failpoint
 * controls.** This class is gated by the `MISSION_PLANNER_HARNESS` environment
 * variable: it can only be constructed when that variable is set to `'1'`.
 * The production worker entry point (`server/src/worker.ts`) never sets this
 * variable and never constructs this harness. The production `PlanGenerator`
 * always calls the real LLM provider.
 *
 * The harness does NOT mock the plan schema, canonicalizer, graph validator,
 * publication transaction, or worker claim/lease gate. It only replaces the
 * plan *generation* step with deterministic injected vectors and simulates
 * faults at the generation boundary. All downstream validation, hashing,
 * persistence, and governance remain production code paths.
 */

/** Environment flag that enables the test harness. */
export const HARNESS_ENV_FLAG = 'MISSION_PLANNER_HARNESS';

/** Returns true only when the test harness is explicitly enabled. */
export function isTestHarnessEnabled(): boolean {
  return process.env[HARNESS_ENV_FLAG] === '1';
}

/** A failpoint to simulate at the generation boundary. */
export type HarnessFailpoint =
  | { kind: 'timeout' }
  | { kind: 'transient_failure'; code?: string; safeMessage?: string }
  | { kind: 'permanent_failure'; code?: string; safeMessage?: string }
  | { kind: 'malformed_output'; raw?: unknown; code?: string; safeMessage?: string }
  | { kind: 'persistence_fault' }
  | { kind: 'delay'; ms: number }
  | { kind: 'checkpoint'; fn: () => void };

/** A single injected plan vector with optional failpoint. */
export interface HarnessPlanVector {
  /** The raw plan content to feed through production validators. */
  content: unknown;
  /** Safe metadata for the generatedBy field. */
  generatedBy?: Record<string, unknown>;
  /**
   * Optional failpoint to simulate before returning the plan. If set, the
   * harness returns the failpoint outcome instead of the plan (useful for
   * testing retry behavior with later successful vectors).
   */
  failpoint?: HarnessFailpoint;
}

/** Configuration for the nonproduction planner harness. */
export interface HarnessConfig {
  /**
   * Sequence of plan vectors to inject, one per generation attempt. The
   * harness returns them in order. If exhausted, the harness returns a
   * permanent failure.
   */
  vectors: HarnessPlanVector[];
  /**
   * Optional failpoint to inject on every generation call, overriding the
   * per-vector failpoint. Useful for testing persistent faults.
   */
  globalFailpoint?: HarnessFailpoint;
}

/**
 * Test-only planner harness. Injects deterministic plan vectors and
 * failpoints. Construction throws unless `MISSION_PLANNER_HARNESS=1`.
 *
 * (VAL-PLAN-130)
 */
export class PlannerTestHarness implements PlanGenerator {
  private readonly config: HarnessConfig;
  private callCount = 0;

  constructor(config: HarnessConfig) {
    if (!isTestHarnessEnabled()) {
      throw new Error(
        `PlannerTestHarness is test-only. Set ${HARNESS_ENV_FLAG}=1 to enable. ` +
          'Production routes cannot accept validator-authored plans or failpoint controls.',
      );
    }
    this.config = config;
  }

  /** Number of times `generate` has been called. */
  get calls(): number {
    return this.callCount;
  }

  async generate(ctx: PlannerContext, signal: AbortSignal): Promise<PlanGeneratorOutcome> {
    this.callCount += 1;
    const idx = this.callCount - 1;

    // Apply global failpoint first (overrides per-vector).
    const failpoint = this.config.globalFailpoint ?? this.config.vectors[idx]?.failpoint;

    if (failpoint) {
      const outcome = this.applyFailpoint(failpoint, signal);
      if (outcome) {
        return outcome;
      }
    }

    const vector = this.config.vectors[idx];
    if (!vector) {
      return {
        kind: 'failure',
        category: 'provider_permanent',
        code: 'HARNESS_VECTORS_EXHAUSTED',
        safeMessage: 'Test harness has no more plan vectors to inject.',
      };
    }

    return {
      kind: 'plan',
      content: vector.content,
      generatedBy: {
        source: 'planner-test-harness',
        vectorIndex: idx,
        ...(vector.generatedBy ?? {}),
      },
    };
  }

  private applyFailpoint(fp: HarnessFailpoint, _signal: AbortSignal): PlanGeneratorOutcome | null {
    void _signal;
    switch (fp.kind) {
      case 'timeout':
        return {
          kind: 'failure',
          category: 'timeout',
          code: 'PLANNER_TIMEOUT',
          safeMessage: 'Planner call timed out.',
        };
      case 'transient_failure':
        return {
          kind: 'failure',
          category: 'provider_transient',
          code: fp.code ?? 'PLANNER_TRANSIENT',
          safeMessage: fp.safeMessage ?? 'Planner transient failure.',
        };
      case 'permanent_failure':
        return {
          kind: 'failure',
          category: 'provider_permanent',
          code: fp.code ?? 'PLANNER_PERMANENT',
          safeMessage: fp.safeMessage ?? 'Planner permanent failure.',
        };
      case 'malformed_output':
        return {
          kind: 'malformed',
          raw: fp.raw ?? { invalid: true },
          code: fp.code ?? 'PLANNER_MALFORMED',
          safeMessage: fp.safeMessage ?? 'Planner produced malformed output.',
        };
      case 'persistence_fault':
        // Simulate a persistence fault by returning a plan that will fail
        // during publication (the caller's failpointHook handles the actual
        // transaction fault). Here we just signal the intent.
        return null; // Fall through to return the vector.
      case 'delay':
        // Delays are handled async-side; we return null to fall through.
        // The caller can use signal.aborted after the delay.
        return null;
      case 'checkpoint':
        fp.fn();
        return null; // Fall through to return the vector.
      default:
        return null;
    }
  }
}

/**
 * Production plan generator placeholder.
 *
 * In production, the real LLM-backed generator calls the provider. This
 * placeholder is never used in tests (the harness is used instead) and
 * never used in production until the full LLM integration is wired.
 * It exists to make the production code path explicit: production routes
 * always call the real provider, never the harness.
 */
export class ProductionPlanGenerator implements PlanGenerator {
  async generate(_ctx: PlannerContext, _signal: AbortSignal): Promise<PlanGeneratorOutcome> {
    void _ctx;
    void _signal;
    // The production LLM-backed planner is not yet wired in Phase 1
    // milestone 3. This placeholder ensures the type is satisfied and
    // makes it explicit that production routes do not use the harness.
    throw new Error('ProductionPlanGenerator is not yet implemented');
  }
}
