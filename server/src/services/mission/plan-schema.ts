import { z } from 'zod';
import { canonicalHash } from './policy.js';
import { normalizeTextNFC, countCodePoints } from './question-bounds.js';
import { AppError } from '../../middleware/error-handler.js';
import {
  PLAN_CONTRACT_SCHEMA_VERSION,
  PLAN_NODE_KINDS,
  PLAN_REPLAY_CLASSES,
  PLAN_PARTIAL_RESULT_POLICIES,
  PLAN_DEPENDENCY_KINDS,
  PLAN_EXECUTOR_FIELD_MANIFEST,
  type PlanNodeKind,
  type PlanReplayClass,
  type PlanPartialResultPolicy,
  type PlanDependencyKind,
} from '@eidolon/shared';

/**
 * Closed `PlanContentV1` validation, canonicalization, and hashing.
 *
 * (VAL-PLAN-032, 034, 035, 036, 112, 113, 124, 126)
 *
 * This module owns the authoritative versioned Zod plan schema, executable
 * graph validation, Unicode-NFC canonicalization, and the lowercase SHA-256
 * content hash that approval binds. It is a pure domain module: it does not
 * touch Postgres, the API, or the worker. The durable `run_plan_revisions`
 * table and approval binding are owned by later `plans-approval` features;
 * those features persist the `content_hash` produced here.
 *
 * Canonical hash rules (architecture.md):
 *  1. Validate against one versioned Zod plan schema.
 *  2. Hash only the authority fields: `{schemaVersion, objective, steps,
 *     synthesis, planningBudgetCents, partialResultPolicy, limits}`. Steps
 *     include stable step key, parent/ordinal, node kind, title/description,
 *     ordered dependencies, typed input bindings, routing requirements or
 *     concrete agent, exact tool allowlist, replay/side-effect class, expected
 *     outputs, evidence requirements, completion criteria, integer budget,
 *     and step limits. IDs, timestamps, UI expansion state, and generated
 *     prose outside these fields are excluded.
 *  3. Normalize strings to Unicode NFC; reject `undefined`, NaN/infinity,
 *     duplicate keys/options, and non-integer money/token/byte limits.
 *  4. Serialize objects with recursively lexicographically sorted keys;
 *     preserve array order; encode UTF-8 with no whitespace. Set-semantic
 *     arrays (tools, domains, capabilities, declared output names) are sorted
 *     before hashing so reordered equivalent sets produce one hash.
 *  5. Store lowercase SHA-256 hex of those bytes.
 */

/** Schema version for the Phase 1 stable plan content contract. */
export const PLAN_CONTENT_SCHEMA_VERSION = PLAN_CONTRACT_SCHEMA_VERSION;

/** Re-exported for tests and consumers (VAL-PLAN-124). */
export { PLAN_EXECUTOR_FIELD_MANIFEST } from '@eidolon/shared';

/** Named non-authoritative presentation metadata fields (VAL-PLAN-112). */
export const PRESENTATION_METADATA_FIELDS: readonly string[] =
  PLAN_EXECUTOR_FIELD_MANIFEST.presentationFields;

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Maximum Unicode code points in a plan objective/title/description/criteria. */
const MAX_PLAN_TEXT_CODEPOINTS = 2_000;

function codepointRange(min: number, max: number) {
  return (s: string) => {
    const n = countCodePoints(s);
    return n >= min && n <= max;
  };
}

/**
 * Reject Unicode control characters and BiDi override/embedding controls
 * that could cause deceptive rendering. Allows TAB/LF/CR.
 */
/* eslint-disable no-control-regex, no-misleading-character-class */
const UNSAFE_CODEPOINT_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B\u200C\u200D\uFEFF]/;
/* eslint-enable no-control-regex, no-misleading-character-class */

function rejectUnsafeControls(s: string): boolean {
  return !UNSAFE_CODEPOINT_RE.test(s);
}

/** NFC-normalized bounded text field. */
const PlanText = z
  .string()
  .refine(
    codepointRange(1, MAX_PLAN_TEXT_CODEPOINTS),
    `Text must be 1–${MAX_PLAN_TEXT_CODEPOINTS} Unicode code points`,
  )
  .refine(rejectUnsafeControls, 'Text must not contain control or BiDi override characters')
  .transform((s) => normalizeTextNFC(s));

/** Optional NFC-normalized bounded text field. */
const OptionalPlanText = z
  .string()
  .refine(
    codepointRange(0, MAX_PLAN_TEXT_CODEPOINTS),
    `Text must be 0–${MAX_PLAN_TEXT_CODEPOINTS} Unicode code points`,
  )
  .refine(rejectUnsafeControls, 'Text must not contain control or BiDi override characters')
  .transform((s) => normalizeTextNFC(s))
  .optional();

/** Stable step/output key: 1–128 printable ASCII characters. */
const PlanKey = z
  .string()
  .regex(/^[\x21-\x7E]{1,128}$/, 'Key must be 1–128 printable ASCII characters');

/** Nonnegative finite integer (money/token/byte/count limits and budgets). */
const NonnegativeInt = z
  .number()
  .finite('Value must be a finite number')
  .int('Value must be an integer')
  .nonnegative('Value must be nonnegative');

/** Positive integer (e.g. childOrdinal is nonnegative; ordinals use NonnegativeInt). */

// ---------------------------------------------------------------------------
// Routing requirements / concrete agent
// ---------------------------------------------------------------------------

const RoutingRequirements = z
  .object({
    capabilities: z.array(PlanKey),
    requiredTools: z.array(PlanKey),
    requiredDomains: z.array(z.string().min(1)),
    ephemeralAllowed: z.boolean(),
  })
  .strict();

const ConcreteAgent = z
  .object({
    kind: z.literal('concreteAgent'),
    executingAgentId: PlanKey,
  })
  .strict();

const RequirementsRouting = z
  .object({
    kind: z.literal('requirements'),
    routingRequirements: RoutingRequirements,
  })
  .strict();

/** Routing is a closed discriminated union (VAL-PLAN-124). */
const Routing = z.discriminatedUnion('kind', [RequirementsRouting, ConcreteAgent]);

// ---------------------------------------------------------------------------
// Input bindings
// ---------------------------------------------------------------------------

const StepOutputSource = z
  .object({
    kind: z.literal('stepOutput'),
    stepKey: PlanKey,
    output: PlanKey,
  })
  .strict();

const RequestContextSource = z
  .object({
    kind: z.literal('requestContext'),
    key: PlanKey,
  })
  .strict();

const ArtifactSource = z
  .object({
    kind: z.literal('artifact'),
    artifactId: PlanKey,
    revision: z.number().int().nonnegative().optional(),
  })
  .strict();

const InputSource = z.discriminatedUnion('kind', [
  StepOutputSource,
  RequestContextSource,
  ArtifactSource,
]);

const InputBinding = z
  .object({
    name: PlanKey,
    source: InputSource,
  })
  .strict();

// ---------------------------------------------------------------------------
// Evidence requirements
// ---------------------------------------------------------------------------

const EvidenceRequirements = z
  .object({
    citationsRequired: z.boolean(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const PlanLimits = z
  .object({
    steps: NonnegativeInt,
    durationSeconds: NonnegativeInt,
    providerCalls: NonnegativeInt,
    totalTokens: NonnegativeInt,
    outputBytes: NonnegativeInt,
    costCents: NonnegativeInt,
    depth: NonnegativeInt,
    fanOut: NonnegativeInt,
    descendants: NonnegativeInt,
  })
  .strict();

const StepLimits = z
  .object({
    durationSeconds: NonnegativeInt.optional(),
    providerCalls: NonnegativeInt.optional(),
    totalTokens: NonnegativeInt.optional(),
    outputBytes: NonnegativeInt.optional(),
    costCents: NonnegativeInt.optional(),
    depth: NonnegativeInt.optional(),
    fanOut: NonnegativeInt.optional(),
    descendants: NonnegativeInt.optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Step and synthesis
// ---------------------------------------------------------------------------

const Step = z
  .object({
    stepKey: PlanKey,
    parentStepKey: PlanKey.nullable(),
    childOrdinal: NonnegativeInt,
    nodeKind: z.enum([...PLAN_NODE_KINDS] as [PlanNodeKind, ...PlanNodeKind[]]),
    title: PlanText,
    description: PlanText,
    dependencies: z.array(PlanKey),
    /**
     * Optional per-dependency kind map. Keys are step keys from
     * `dependencies`; values are `'required'` (default) or `'optional'`.
     * An optional edge may supply a typed unavailable value when the
     * predecessor fails or is absent (VAL-SUB-003, VAL-SUB-107).
     */
    dependencyKinds: z
      .record(
        PlanKey,
        z.enum([...PLAN_DEPENDENCY_KINDS] as [PlanDependencyKind, ...PlanDependencyKind[]]),
      )
      .optional(),
    inputBindings: z.array(InputBinding),
    routing: Routing,
    toolAllowlist: z.array(PlanKey),
    replayClass: z.enum([...PLAN_REPLAY_CLASSES] as [PlanReplayClass, ...PlanReplayClass[]]),
    sideEffecting: z.boolean(),
    expectedOutputs: z.array(PlanKey),
    evidenceRequirements: EvidenceRequirements,
    completionCriteria: PlanText,
    budgetCents: NonnegativeInt,
    limits: StepLimits,
  })
  .strict();

const Synthesis = z
  .object({
    instructions: PlanText,
    declaredInputs: z.array(StepOutputSource),
    declaredOutput: PlanKey,
    evidenceRequirements: EvidenceRequirements,
    completionCriteria: PlanText,
    budgetCents: NonnegativeInt,
  })
  .strict();

// ---------------------------------------------------------------------------
// Presentation metadata (non-authoritative, separately named)
// ---------------------------------------------------------------------------

const PresentationMetadata = z
  .object({
    cardTitle: OptionalPlanText,
    summary: OptionalPlanText,
  })
  .strict()
  .optional();

// ---------------------------------------------------------------------------
// PlanContentV1
// ---------------------------------------------------------------------------

/**
 * The closed `PlanContentV1` executable schema (VAL-PLAN-124).
 *
 * Unknown authority fields are rejected via `.strict()`; presentation metadata
 * is separately named and excluded from the content hash (VAL-PLAN-112).
 */
export const PlanContentV1 = z
  .object({
    schemaVersion: z.literal(PLAN_CONTENT_SCHEMA_VERSION),
    objective: PlanText,
    steps: z.array(Step).min(1, 'Plan must contain at least one executable step'),
    synthesis: Synthesis,
    planningBudgetCents: NonnegativeInt,
    partialResultPolicy: z.enum([...PLAN_PARTIAL_RESULT_POLICIES] as [
      PlanPartialResultPolicy,
      ...PlanPartialResultPolicy[],
    ]),
    limits: PlanLimits,
    presentationMetadata: PresentationMetadata,
  })
  .strict();

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type RoutingRequirements = z.infer<typeof RoutingRequirements>;
export type ConcreteAgent = z.infer<typeof ConcreteAgent>;
export type Routing = z.infer<typeof Routing>;
export type InputBinding = z.infer<typeof InputBinding>;
export type InputSource = z.infer<typeof InputSource>;
export type EvidenceRequirements = z.infer<typeof EvidenceRequirements>;
export type PlanLimits = z.infer<typeof PlanLimits>;
export type StepLimits = z.infer<typeof StepLimits>;
export type PlanStep = z.infer<typeof Step>;
export type PlanSynthesis = z.infer<typeof Synthesis>;
export type PlanContent = z.infer<typeof PlanContentV1>;

// Re-export closed enum types for consumers.
export type {
  PlanNodeKind,
  PlanReplayClass,
  PlanPartialResultPolicy,
  PlanDependencyKind,
} from '@eidolon/shared';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse and structurally validate raw plan content against the closed
 * `PlanContentV1` schema. Strings are NFC-normalized; numeric limits are
 * required to be finite integers; unknown authority fields are rejected.
 *
 * Throws `AppError(400, VALIDATION_ERROR)` on any structural failure
 * (VAL-PLAN-036, VAL-PLAN-124).
 */
export function parsePlanContent(raw: unknown): PlanContent {
  const result = PlanContentV1.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid plan content: ${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Executable graph validation (VAL-PLAN-113)
// ---------------------------------------------------------------------------

/** Collect all output names declared by a step. */
function declaredStepOutputs(step: PlanStep): Set<string> {
  return new Set(step.expectedOutputs);
}

/** Build the step-key index, rejecting duplicate step keys. */
function indexSteps(content: PlanContent): Map<string, PlanStep> {
  const byKey = new Map<string, PlanStep>();
  for (const step of content.steps) {
    if (byKey.has(step.stepKey)) {
      throw new AppError(422, 'PLAN_GRAPH_INVALID', `Duplicate step key: ${step.stepKey}`);
    }
    byKey.set(step.stepKey, step);
  }
  return byKey;
}

/** Validate dependency edges (no self/unknown/duplicate) and return adjacency. */
function validateDependencyEdges(
  content: PlanContent,
  stepKeys: Set<string>,
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const step of content.steps) {
    const seen = new Set<string>();
    const edges: string[] = [];
    for (const dep of step.dependencies) {
      if (dep === step.stepKey) {
        throw new AppError(422, 'PLAN_GRAPH_INVALID', `Self-dependency on step: ${step.stepKey}`);
      }
      if (!stepKeys.has(dep)) {
        throw new AppError(
          422,
          'PLAN_GRAPH_INVALID',
          `Unknown dependency edge: ${step.stepKey} -> ${dep}`,
        );
      }
      if (seen.has(dep)) {
        throw new AppError(
          422,
          'PLAN_GRAPH_INVALID',
          `Duplicate dependency edge: ${step.stepKey} -> ${dep}`,
        );
      }
      seen.add(dep);
      edges.push(dep);
    }
    adjacency.set(step.stepKey, edges);
  }
  return adjacency;
}

/** Detect a cycle via DFS coloring; throw if one is found. */
function detectCycles(stepKeys: Set<string>, adjacency: Map<string, string[]>): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const key of stepKeys) {
    color.set(key, WHITE);
  }
  const dfs = (u: string): boolean => {
    color.set(u, GRAY);
    for (const v of adjacency.get(u) ?? []) {
      const c = color.get(v);
      if (c === GRAY) {
        return true;
      }
      if (c === WHITE && dfs(v)) {
        return true;
      }
    }
    color.set(u, BLACK);
    return false;
  };
  for (const key of stepKeys) {
    if (color.get(key) === WHITE && dfs(key)) {
      throw new AppError(
        422,
        'PLAN_GRAPH_INVALID',
        `Cyclic dependency detected involving step: ${key}`,
      );
    }
  }
}

/** Build the output-name → declaring-step map, rejecting duplicate outputs. */
function indexDeclaredOutputs(content: PlanContent): Map<string, string> {
  const owners = new Map<string, string>();
  for (const step of content.steps) {
    for (const out of step.expectedOutputs) {
      if (owners.has(out)) {
        throw new AppError(422, 'PLAN_GRAPH_INVALID', `Duplicate declared output: ${out}`);
      }
      owners.set(out, step.stepKey);
    }
  }
  return owners;
}

/** Validate that step input bindings reference declared outputs. */
function validateInputBindings(content: PlanContent, byKey: Map<string, PlanStep>): void {
  for (const step of content.steps) {
    for (const binding of step.inputBindings) {
      if (binding.source.kind !== 'stepOutput') {
        continue;
      }
      const target = byKey.get(binding.source.stepKey);
      if (!target) {
        throw new AppError(
          422,
          'PLAN_GRAPH_INVALID',
          `Input binding references unknown step: ${binding.source.stepKey}`,
        );
      }
      if (!declaredStepOutputs(target).has(binding.source.output)) {
        throw new AppError(
          422,
          'PLAN_GRAPH_INVALID',
          `Input binding references undeclared output: ${binding.source.output} on step ${binding.source.stepKey}`,
        );
      }
    }
  }
}

/** Validate that synthesis declared inputs reference declared outputs. */
function validateSynthesisInputs(content: PlanContent, byKey: Map<string, PlanStep>): void {
  for (const input of content.synthesis.declaredInputs) {
    const target = byKey.get(input.stepKey);
    if (!target) {
      throw new AppError(
        422,
        'PLAN_GRAPH_INVALID',
        `Synthesis references unknown step: ${input.stepKey}`,
      );
    }
    if (!declaredStepOutputs(target).has(input.output)) {
      throw new AppError(
        422,
        'PLAN_GRAPH_INVALID',
        `Synthesis references undeclared output: ${input.output} on step ${input.stepKey}`,
      );
    }
  }
}

/** Validate that enforced planning/step/synthesis budgets fit the cost ceiling. */
function validateBudgetTotals(content: PlanContent): void {
  const stepBudgetSum = content.steps.reduce((acc, s) => acc + s.budgetCents, 0);
  const synthesisBudget = content.synthesis.budgetCents;
  const totalEnforced = content.planningBudgetCents + stepBudgetSum + synthesisBudget;
  if (totalEnforced > content.limits.costCents) {
    throw new AppError(
      422,
      'PLAN_GRAPH_INVALID',
      `Enforced budgets (${content.planningBudgetCents} planning + ${stepBudgetSum} steps + ${synthesisBudget} synthesis = ${totalEnforced}) exceed cost ceiling ${content.limits.costCents}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Topology validation (VAL-SUB-085, VAL-SUB-106)
// ---------------------------------------------------------------------------

/**
 * Validate the parent-child topology of an approved plan.
 *
 * Rejects (VAL-SUB-106):
 * - `parentStepKey` references a non-existent step (missing/foreign parent).
 * - Parent-chain cycles (a step whose ancestor chain loops back).
 * - `childOrdinal` duplicates under the same parent (duplicate ordinals).
 * - Depth exceeding `plan.limits.depth` (root depth 0, child = parent + 1).
 *
 * Rejects (VAL-SUB-085):
 * - Direct executable-child count at any node exceeding the effective
 *   fan-out (`plan.limits.fanOut` or the step's own `limits.fanOut`).
 *
 * Does NOT enforce a single root (milestone-3 flat plans with multiple
 * root-level steps remain valid). Only non-root steps (parentStepKey !==
 * null) are validated for parent references and ordinals.
 *
 * Throws `AppError(422, PLAN_GRAPH_INVALID)` on any topology failure.
 */
function validateTopology(content: PlanContent, byKey: Map<string, PlanStep>): void {
  // 1. Parent reference validation: every non-null parentStepKey must exist.
  for (const step of content.steps) {
    if (step.parentStepKey !== null && !byKey.has(step.parentStepKey)) {
      throw new AppError(
        422,
        'PLAN_GRAPH_INVALID',
        `Step "${step.stepKey}" references missing parent step: ${step.parentStepKey}`,
      );
    }
  }

  // 2. Parent-chain cycle detection (follow parentStepKey links).
  for (const step of content.steps) {
    if (step.parentStepKey === null) {
      continue;
    }
    const seen = new Set<string>();
    let current: string | null = step.stepKey;
    while (current !== null) {
      if (seen.has(current)) {
        throw new AppError(
          422,
          'PLAN_GRAPH_INVALID',
          `Parent-chain cycle detected involving step: ${step.stepKey}`,
        );
      }
      seen.add(current);
      const node: PlanStep | undefined = current === step.stepKey ? step : byKey.get(current);
      if (!node) {
        break; // missing parent already reported above
      }
      current = node.parentStepKey;
    }
  }

  // 3. Compute depth for each step and validate against plan depth limit.
  const depthCache = new Map<string, number>();
  function computeDepth(stepKey: string): number {
    if (depthCache.has(stepKey)) {
      return depthCache.get(stepKey)!;
    }
    const step = byKey.get(stepKey);
    if (!step || step.parentStepKey === null) {
      depthCache.set(stepKey, 0);
      return 0;
    }
    const d = computeDepth(step.parentStepKey) + 1;
    depthCache.set(stepKey, d);
    return d;
  }
  const maxDepth = content.limits.depth;
  for (const step of content.steps) {
    const d = computeDepth(step.stepKey);
    if (d > maxDepth) {
      throw new AppError(
        422,
        'PLAN_GRAPH_INVALID',
        `Step "${step.stepKey}" at depth ${d} exceeds plan depth limit ${maxDepth}`,
      );
    }
  }

  // 4. Sibling-unique childOrdinal under each parent.
  const ordinalsByParent = new Map<string, Set<number>>();
  for (const step of content.steps) {
    if (step.parentStepKey === null) {
      continue;
    }
    const parent = step.parentStepKey;
    let set = ordinalsByParent.get(parent);
    if (!set) {
      set = new Set<number>();
      ordinalsByParent.set(parent, set);
    }
    if (set.has(step.childOrdinal)) {
      throw new AppError(
        422,
        'PLAN_GRAPH_INVALID',
        `Duplicate child ordinal ${step.childOrdinal} under parent "${parent}" (step "${step.stepKey}")`,
      );
    }
    set.add(step.childOrdinal);
  }

  // 5. Fan-out validation: per-parent direct child count <= effective fan-out
  // (VAL-SUB-085). The effective fan-out for a parent is the minimum of the
  // plan-level fan-out and the parent step's own fan-out limit (if set).
  const childCountByParent = new Map<string, number>();
  for (const step of content.steps) {
    if (step.parentStepKey === null) {
      continue;
    }
    const parent = step.parentStepKey;
    childCountByParent.set(parent, (childCountByParent.get(parent) ?? 0) + 1);
  }
  const planFanOut = content.limits.fanOut;
  for (const [parentKey, count] of childCountByParent) {
    const parentStep = byKey.get(parentKey);
    const stepFanOut = parentStep?.limits?.fanOut;
    const effectiveFanOut =
      stepFanOut !== undefined ? Math.min(planFanOut, stepFanOut) : planFanOut;
    if (count > effectiveFanOut) {
      throw new AppError(
        422,
        'PLAN_GRAPH_INVALID',
        `Step "${parentKey}" has ${count} direct children, exceeding effective fan-out ${effectiveFanOut}`,
      );
    }
  }

  // 6. Descendant count validation: total non-root steps <= plan descendants
  // limit.
  const descendantCount = content.steps.filter((s) => s.parentStepKey !== null).length;
  if (descendantCount > content.limits.descendants) {
    throw new AppError(
      422,
      'PLAN_GRAPH_INVALID',
      `Plan has ${descendantCount} descendant steps, exceeding descendants limit ${content.limits.descendants}`,
    );
  }
}

/**
 * Validate that dependencyKinds keys are a subset of the step's dependencies
 * (VAL-SUB-003). Throws `AppError(422, PLAN_GRAPH_INVALID)` on any unknown
 * dependency kind key.
 */
function validateDependencyKinds(content: PlanContent): void {
  for (const step of content.steps) {
    if (!step.dependencyKinds) {
      continue;
    }
    const deps = new Set(step.dependencies);
    for (const key of Object.keys(step.dependencyKinds)) {
      if (!deps.has(key)) {
        throw new AppError(
          422,
          'PLAN_GRAPH_INVALID',
          `Step "${step.stepKey}" declares dependencyKinds for non-dependency: ${key}`,
        );
      }
    }
  }
}

/**
 * Validate the closed executable plan graph (VAL-PLAN-113, VAL-SUB-085,
 * VAL-SUB-106).
 *
 * Rejects: zero executable steps (enforced by the schema), self/unknown/
 * duplicate dependency edges, cycles, impossible routing, synthesis
 * references to undeclared outputs, input bindings to undeclared outputs,
 * totals that omit enforced planning/synthesis costs, invalid topology
 * (missing/foreign parents, parent-chain cycles, duplicate ordinals, depth
 * exceeding the plan limit), fan-out exceeding the effective limit, and
 * descendant count exceeding the plan limit.
 *
 * Throws `AppError(422, PLAN_GRAPH_INVALID)` on any graph failure.
 */
export function validatePlanGraph(content: PlanContent): PlanContent {
  const byKey = indexSteps(content);
  const stepKeys = new Set(byKey.keys());
  const adjacency = validateDependencyEdges(content, stepKeys);
  detectCycles(stepKeys, adjacency);
  // Impossible routing is already rejected by the schema (discriminated union
  // requires either requirements or a concrete agent id).
  indexDeclaredOutputs(content);
  validateInputBindings(content, byKey);
  validateSynthesisInputs(content, byKey);
  validateBudgetTotals(content);
  validateTopology(content, byKey);
  validateDependencyKinds(content);
  return content;
}

/**
 * Parse and fully validate plan content (structure + executable graph).
 * Returns the canonical NFC-normalized plan (VAL-PLAN-113, VAL-PLAN-124).
 */
export function validatePlan(raw: unknown): PlanContent {
  return validatePlanGraph(parsePlanContent(raw));
}

// ---------------------------------------------------------------------------
// Canonicalization and hashing (VAL-PLAN-032, 034, 035, 112)
// ---------------------------------------------------------------------------

/** Sort a copy of an array of strings lexicographically (set semantics). */
function sortedCopy(arr: readonly string[]): string[] {
  return [...arr].sort();
}

/** Canonicalize routing so set-semantic arrays are sorted. */
function canonicalRouting(routing: Routing): unknown {
  if (routing.kind === 'concreteAgent') {
    return { kind: 'concreteAgent', executingAgentId: routing.executingAgentId };
  }
  const r = routing.routingRequirements;
  return {
    kind: 'requirements',
    routingRequirements: {
      capabilities: sortedCopy(r.capabilities),
      requiredTools: sortedCopy(r.requiredTools),
      requiredDomains: sortedCopy(r.requiredDomains),
      ephemeralAllowed: r.ephemeralAllowed,
    },
  };
}

/** Canonicalize an input binding (preserve order; source is already closed). */
function canonicalInputBinding(binding: InputBinding): unknown {
  return { name: binding.name, source: binding.source };
}

/** Canonicalize a step: preserve ordered arrays, sort set-semantic arrays. */
function canonicalStep(step: PlanStep): unknown {
  return {
    stepKey: step.stepKey,
    parentStepKey: step.parentStepKey,
    childOrdinal: step.childOrdinal,
    nodeKind: step.nodeKind,
    title: step.title,
    description: step.description,
    dependencies: step.dependencies, // ordered
    dependencyKinds: step.dependencyKinds, // optional; stripped when undefined
    inputBindings: step.inputBindings.map(canonicalInputBinding), // ordered
    routing: canonicalRouting(step.routing),
    toolAllowlist: sortedCopy(step.toolAllowlist), // set
    replayClass: step.replayClass,
    sideEffecting: step.sideEffecting,
    expectedOutputs: sortedCopy(step.expectedOutputs), // set
    evidenceRequirements: step.evidenceRequirements,
    completionCriteria: step.completionCriteria,
    budgetCents: step.budgetCents,
    limits: step.limits,
  };
}

/** Canonicalize synthesis. */
function canonicalSynthesis(synthesis: PlanSynthesis): unknown {
  return {
    instructions: synthesis.instructions,
    declaredInputs: synthesis.declaredInputs, // ordered
    declaredOutput: synthesis.declaredOutput,
    evidenceRequirements: synthesis.evidenceRequirements,
    completionCriteria: synthesis.completionCriteria,
    budgetCents: synthesis.budgetCents,
  };
}

/**
 * Recursively normalize every string leaf to Unicode NFC. Canonicalization
 * owns NFC normalization independent of parse so that equivalent content
 * differing only in Unicode canonical representation hashes identically
 * (VAL-PLAN-034).
 */
function nfcNormalizeStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.normalize('NFC');
  }
  if (Array.isArray(value)) {
    return value.map(nfcNormalizeStrings);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>)) {
      out[k] = nfcNormalizeStrings((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/**
 * Produce the canonical authority object for a plan. Presentation metadata is
 * excluded. Strings are Unicode-NFC normalized; set-semantic arrays are
 * sorted; ordered arrays (steps, dependencies, inputBindings, declaredInputs)
 * preserve order. Object keys are left unsorted here — `canonicalHash` sorts
 * keys recursively when serializing (VAL-PLAN-034, VAL-PLAN-035,
 * VAL-PLAN-112).
 */
export function canonicalPlanContent(content: PlanContent): Record<string, unknown> {
  const canonical: Record<string, unknown> = {
    schemaVersion: content.schemaVersion,
    objective: content.objective,
    steps: content.steps.map(canonicalStep),
    synthesis: canonicalSynthesis(content.synthesis),
    planningBudgetCents: content.planningBudgetCents,
    partialResultPolicy: content.partialResultPolicy,
    limits: content.limits,
  };
  return nfcNormalizeStrings(canonical) as Record<string, unknown>;
}

/**
 * Lowercase SHA-256 hex of the canonical UTF-8 serialization of the plan's
 * authority fields. Equivalent content (modulo object-key order, Unicode NFC,
 * and set-semantic array order) hashes identically; material changes produce
 * a different hash (VAL-PLAN-032, 034, 035, 112).
 */
export function planContentHash(content: PlanContent): string {
  return canonicalHash(canonicalPlanContent(content));
}

// ---------------------------------------------------------------------------
// Approval budget arithmetic (VAL-PLAN-126)
// ---------------------------------------------------------------------------

/**
 * Inputs to approval-time budget arithmetic. All values are integer cents.
 */
export interface ApprovalBudgetArithmeticInput {
  /** Root reservation currently held for the Mission. */
  rootReserved: number;
  /** Planning authority already settled (consumed) against the root hold. */
  settledPlanning: number;
  /** Planning authority currently in-flight against the root hold. */
  inFlightPlanning: number;
  /** The validated plan content. */
  plan: PlanContent;
}

/**
 * Reproducible approval budget arithmetic (VAL-PLAN-126).
 *
 * `residual = rootReserved - settledPlanning - inFlightPlanning`.
 * Approval earmarks only the residual execution envelope, which is
 * `sum(stepBudgetCents) + synthesisBudgetCents`. `planningBudgetCents`
 * reports planning authority already reserved/consumed and is never
 * double-counted into the execution envelope. The proposal is budget-safe
 * iff `executionEnvelope <= residual`.
 */
export function validateApprovalBudgetArithmetic(input: ApprovalBudgetArithmeticInput): {
  residualCents: number;
  executionEnvelopeCents: number;
  ok: boolean;
} {
  const residualCents = input.rootReserved - input.settledPlanning - input.inFlightPlanning;
  const stepBudgetSum = input.plan.steps.reduce((acc, s) => acc + s.budgetCents, 0);
  const executionEnvelopeCents = stepBudgetSum + input.plan.synthesis.budgetCents;
  const ok = executionEnvelopeCents <= residualCents;
  return { residualCents, executionEnvelopeCents, ok };
}
