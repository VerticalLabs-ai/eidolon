import type { ChatMessage, CompletionResult, ProviderConfig } from '../../providers/types.js';
import { resolveProviderApiKey } from '../provider-key.js';
import { getProvider } from '../../providers/index.js';
import type { PlanGenerator, PlanGeneratorOutcome, PlannerContext } from './planner.js';
import { PLAN_CONTENT_SCHEMA_VERSION } from './plan-schema.js';

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
 * Production plan generator.
 *
 * In production, this is the real LLM-backed generator. It calls the Anthropic
 * Messages API with a planning-specific system prompt, parses the structured
 * JSON response into a `PlanGeneratorOutcome` of kind `'plan'`, and returns
 * the raw plan content for downstream production schema validation,
 * canonicalization, hashing, and atomic publication by `PlannerService`.
 *
 * It uses `resolveProviderApiKey()` and `getProvider()` exactly as
 * `RunProcessor.defaultProviderCall` does, so server-level key fallback and
 * the registered Anthropic adapter are reused. Production routes NEVER
 * construct `PlannerTestHarness`: the `MISSION_PLANNER_HARNESS` env gate
 * stays closed in production, and the worker entry point wires this class.
 *
 * The generator does not validate the plan graph itself — that is the
 * responsibility of `PlanPublicationService` through the closed
 * `PlanContentV1` schema. A malformed or unparseable response is returned as
 * a `malformed` outcome so `PlannerService` can apply bounded retry.
 */
export class ProductionPlanGenerator implements PlanGenerator {
  /** Provider/model used for planning. Hardened to Anthropic Claude Sonnet. */
  private readonly provider = 'anthropic';
  private readonly model: string;
  /** Injectable provider call for testing. Production uses the real registry. */
  private readonly providerCall?: (
    messages: ChatMessage[],
    config: ProviderConfig,
  ) => Promise<CompletionResult>;

  constructor(opts?: {
    model?: string;
    providerCall?: (messages: ChatMessage[], config: ProviderConfig) => Promise<CompletionResult>;
  }) {
    this.model = opts?.model ?? 'claude-sonnet-4-6';
    this.providerCall = opts?.providerCall;
  }

  async generate(ctx: PlannerContext, signal: AbortSignal): Promise<PlanGeneratorOutcome> {
    if (signal.aborted) {
      return {
        kind: 'failure',
        category: 'timeout',
        code: 'PLANNER_ABORTED',
        safeMessage: 'Planner generation was cancelled before the provider call.',
      };
    }

    const apiKey = resolveProviderApiKey(this.provider, undefined);
    if (!apiKey) {
      return {
        kind: 'failure',
        category: 'provider_permanent',
        code: 'PLANNER_NO_API_KEY',
        safeMessage: 'No Anthropic API key configured for the planner.',
      };
    }

    const messages = buildPlannerMessages(ctx);
    const config: ProviderConfig = { apiKey, model: this.model, maxTokens: 8192 };

    let result: CompletionResult;
    try {
      const callFn =
        this.providerCall ??
        ((msgs: ChatMessage[], cfg: ProviderConfig) => getProvider(this.provider).chat(msgs, cfg));
      result = await callFn(messages, config);
    } catch (err) {
      if (signal.aborted) {
        return {
          kind: 'failure',
          category: 'timeout',
          code: 'PLANNER_ABORTED',
          safeMessage: 'Planner generation was cancelled during the provider call.',
        };
      }
      const message = err instanceof Error ? err.message : 'unknown error';
      const isPermanent = /authentication|invalid API key|401/i.test(message);
      const isRateLimited = /rate limit|429|overloaded|529/i.test(message);
      return {
        kind: 'failure',
        category: isPermanent
          ? 'provider_permanent'
          : isRateLimited
            ? 'provider_transient'
            : 'provider_transient',
        code: isPermanent ? 'PLANNER_AUTH_FAILED' : 'PLANNER_PROVIDER_ERROR',
        safeMessage: `Planner provider call failed: ${message}`,
      };
    }

    if (signal.aborted) {
      return {
        kind: 'failure',
        category: 'timeout',
        code: 'PLANNER_ABORTED',
        safeMessage: 'Planner generation was cancelled after the provider call.',
      };
    }

    const content = result.content?.trim();
    if (!content) {
      return {
        kind: 'malformed',
        raw: content,
        code: 'PLANNER_EMPTY_OUTPUT',
        safeMessage: 'Planner produced an empty response.',
      };
    }

    const parsed = parsePlannerJson(content);
    if (!parsed.ok) {
      return {
        kind: 'malformed',
        raw: content,
        code: 'PLANNER_MALFORMED',
        safeMessage: parsed.reason,
      };
    }

    return {
      kind: 'plan',
      content: parsed.value,
      generatedBy: {
        source: 'production-plan-generator',
        provider: this.provider,
        model: this.model,
        schemaVersion: PLAN_CONTENT_SCHEMA_VERSION,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        finishReason: result.finishReason,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Planning prompt construction and response parsing
// ---------------------------------------------------------------------------

/**
 * Build the chat messages for the planning LLM call: a planning-specific
 * system prompt describing the closed `PlanContentV1` contract, plus a user
 * turn carrying the run request and resolved mode.
 */
function buildPlannerMessages(ctx: PlannerContext): ChatMessage[] {
  const system = PLANNER_SYSTEM_PROMPT;
  const user = [
    'Generate a structured execution plan as a single valid JSON object for the following Mission.',
    '',
    `Resolved mode: ${ctx.resolvedMode}`,
    `Run ID: ${ctx.runId}`,
    '',
    'Mission request:',
    ctx.requestText || '(no request text provided)',
    '',
    'Return ONLY the JSON object. Do not include prose, explanations, or markdown fences.',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * System prompt that instructs the model to produce a `PlanContentV1`-shaped
 * JSON object. The downstream `PlanContentV1` Zod schema is the authority; this
 * prompt guides the model toward the closed contract without authorizing it to
 * broaden execution authority.
 */
const PLANNER_SYSTEM_PROMPT = [
  'You are a Mission planning assistant for the Eidolon platform.',
  'Your task is to produce a structured, reviewable execution plan that a human operator will approve before any work begins.',
  '',
  `The response MUST be a single JSON object conforming to the PlanContentV1 contract (schemaVersion: ${PLAN_CONTENT_SCHEMA_VERSION}).`,
  'Do not execute any work. Do not call tools. Do not include text outside the JSON object.',
  '',
  'PlanContentV1 shape (all fields required unless noted):',
  '{',
  '  "schemaVersion": number (must be the constant above),',
  '  "objective": string (1–2000 Unicode code points, the single clear objective),',
  '  "steps": array of step objects (at least one), each with:',
  '    "stepKey": string (1–128 printable ASCII),',
  '    "parentStepKey": string | null,',
  '    "childOrdinal": nonnegative integer,',
  '    "nodeKind": one of "root"|"branch"|"leaf",',
  '    "title": string, "description": string,',
  '    "dependencies": array of step keys (ordered),',
  '    "inputBindings": array of { "name": string, "source": { ... } },',
  '    "routing": { "kind": "requirements", "routingRequirements": { "capabilities": [...], "requiredTools": [...], "requiredDomains": [...], "ephemeralAllowed": boolean } }',
  '             OR { "kind": "concreteAgent", "executingAgentId": string },',
  '    "toolAllowlist": array of tool keys,',
  '    "replayClass": one of "read_only"|"idempotent_write"|"non_replayable",',
  '    "sideEffecting": boolean,',
  '    "expectedOutputs": array of output keys,',
  '    "evidenceRequirements": { "citationsRequired": boolean },',
  '    "completionCriteria": string,',
  '    "budgetCents": nonnegative integer,',
  '    "limits": { optional per-step limits }',
  '  "synthesis": { "instructions": string, "declaredInputs": [{ "kind":"stepOutput","stepKey":string,"output":string }], "declaredOutput": string, "evidenceRequirements": { "citationsRequired": boolean }, "completionCriteria": string, "budgetCents": nonnegative integer },',
  '  "planningBudgetCents": nonnegative integer,',
  '  "partialResultPolicy": one of "require_all"|"best_effort",',
  '  "limits": { "steps":int, "durationSeconds":int, "providerCalls":int, "totalTokens":int, "outputBytes":int, "costCents":int, "depth":int, "fanOut":int, "descendants":int },',
  '  "presentationMetadata": { "cardTitle"?:string, "summary"?:string } (optional)',
  '}',
  '',
  'Rules:',
  "- Keep the plan within the mode's limits. Prefer fewer, well-defined steps.",
  '- Use stable, unique step keys. Preserve real dependencies in the "dependencies" arrays.',
  '- Set "sideEffecting" true only for steps that mutate external state; choose the matching "replayClass".',
  '- Do not authorize irreversible work or broaden capabilities beyond what the request requires.',
  '- For Analyst-mode requests, set "citationsRequired": true where external factual claims will be made.',
  '- Output ONLY the JSON object.',
].join('\n');

interface ParsedPlan {
  ok: boolean;
  value: unknown;
  reason: string;
}

/**
 * Parse the planner LLM response into a JSON object. Strips optional markdown
 * fences and extracts the first balanced JSON object. Returns a malformed
 * result if the content is not a parseable JSON object.
 */
function parsePlannerJson(content: string): ParsedPlan {
  const stripped = stripCodeFences(content).trim();
  if (!stripped) {
    return { ok: false, value: null, reason: 'Planner output was empty after stripping fences.' };
  }

  // Fast path: direct parse.
  let candidate = stripped;
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    // Fallback: extract the first balanced { ... } object.
    const extracted = extractFirstJsonObject(stripped);
    if (extracted === null) {
      return {
        ok: false,
        value: stripped,
        reason: 'Planner output did not contain a parseable JSON object.',
      };
    }
    candidate = extracted;
    try {
      value = JSON.parse(candidate);
    } catch (err) {
      return {
        ok: false,
        value: stripped,
        reason: `Planner output JSON parse failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      };
    }
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      ok: false,
      value: stripped,
      reason: 'Planner output JSON was not an object.',
    };
  }

  return { ok: true, value, reason: '' };
}

/** Strip leading/trailing markdown code fences if present. */
function stripCodeFences(content: string): string {
  const match = content.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i);
  return match ? match[1] : content;
}

/**
 * Extract the first top-level balanced JSON object from a string. Returns the
 * raw substring or null if no balanced object is found.
 */
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}
