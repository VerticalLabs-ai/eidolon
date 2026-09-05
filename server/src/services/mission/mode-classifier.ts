/**
 * Deterministic Auto mode complexity classifier.
 *
 * Auto uses a deterministic complexity classifier over validated request
 * metadata (request text + structured context). It does NOT use retrieved
 * external content — classification is complete before any research is
 * performed, and later research content cannot change the resolved mode.
 *
 * (VAL-MODEQ-021, VAL-MODEQ-022, VAL-MODEQ-023, VAL-MODEQ-024,
 *  VAL-MODEQ-025, VAL-MODEQ-146, VAL-CROSS-007)
 *
 * The classifier records schema `mission-mode-classifier/v1` and every
 * matching deterministic reason from the ordered enum:
 *
 *   explicit_research, explicit_evidence, explicit_citations,
 *   multiple_deliverables, dependencies, multiple_agents,
 *   irreversible_tool, simple
 *
 * `simple` appears only when no other reason matches. Analyst wins if any
 * of its first three reasons match, otherwise Deep Work wins any complexity
 * reason, and Fast wins `simple`. Fast complexity uses the same classifier
 * version and ordered matching reasons.
 */

/** Classifier schema version, recorded in `mode.resolved` events. */
export const CLASSIFIER_VERSION = 'mission-mode-classifier/v1' as const;

/**
 * Ordered reason enum. The order is significant: reasons are collected and
 * emitted in this order. `simple` is always last and appears only when no
 * other reason matches.
 */
export const CLASSIFIER_REASON_ORDER = [
  'explicit_research',
  'explicit_evidence',
  'explicit_citations',
  'multiple_deliverables',
  'dependencies',
  'multiple_agents',
  'irreversible_tool',
  'simple',
] as const;

export type ClassifierReason = (typeof CLASSIFIER_REASON_ORDER)[number];

/** Reasons that select Analyst (first three in the enum). */
const ANALYST_REASONS: ReadonlySet<ClassifierReason> = new Set([
  'explicit_research',
  'explicit_evidence',
  'explicit_citations',
]);

/** Reasons that select Deep Work (complexity reasons, non-Analyst). */
const DEEP_WORK_REASONS: ReadonlySet<ClassifierReason> = new Set([
  'multiple_deliverables',
  'dependencies',
  'multiple_agents',
  'irreversible_tool',
]);

/** The concrete mode that Auto resolves to. */
export type AutoResolvedMode = 'fast' | 'deep_work' | 'analyst';

/** Validated request metadata — the sole input to the classifier. */
export interface RequestMetadata {
  /** NFC-normalized request text. */
  text: string;
  /** Structured context fields carrying explicit complexity signals. */
  context?: Record<string, unknown>;
}

/** Result of classifying a request. */
export interface ClassificationResult {
  /** Classifier schema version. */
  classifierVersion: typeof CLASSIFIER_VERSION;
  /** The concrete mode Auto resolves to. */
  resolvedMode: AutoResolvedMode;
  /** All matching reasons in enum order (never includes `simple` alongside others). */
  reasons: ClassifierReason[];
}

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------

/**
 * Text keyword patterns for explicit research/evidence/citation needs.
 * Case-insensitive, word-boundary anchored. These detect explicit user
 * intent in the request text — the user's own validated input, not external
 * or retrieved content.
 */
const RESEARCH_KEYWORDS = /\bresearch\b|\binvestigate\b|\blook\s+up\b/i;
const EVIDENCE_KEYWORDS = /\bevidence\b|\bprove\b|\bdemonstrate\b|\bsubstantiate\b/i;
const CITATIONS_KEYWORDS = /\bcite\b|\bcitation\b|\bsources?\b|\breference\b/i;

/**
 * Check a boolean context field. Only explicit `true` triggers the signal;
 * `false`, missing, or non-boolean values do not.
 */
function isExplicitFlag(context: Record<string, unknown> | undefined, key: string): boolean {
  return context?.[key] === true;
}

/**
 * Check if a context field is a non-empty array (for dependencies,
 * irreversible tools) or an array with length > 1 (for deliverables, agents).
 */
function isArrayWithMinLength(
  context: Record<string, unknown> | undefined,
  key: string,
  minLength: number,
): boolean {
  const val = context?.[key];
  return Array.isArray(val) && val.length >= minLength;
}

/**
 * Detect all matching reasons from request metadata, in enum order.
 * Does NOT include `simple` — that is added by the caller only when no
 * other reason matches.
 */
function detectReasons(metadata: RequestMetadata): ClassifierReason[] {
  const { text, context } = metadata;
  const reasons: ClassifierReason[] = [];

  // explicit_research: context flag OR text keyword.
  if (isExplicitFlag(context, 'research') || RESEARCH_KEYWORDS.test(text)) {
    reasons.push('explicit_research');
  }

  // explicit_evidence: context flag OR text keyword.
  if (isExplicitFlag(context, 'evidence') || EVIDENCE_KEYWORDS.test(text)) {
    reasons.push('explicit_evidence');
  }

  // explicit_citations: context flag OR text keyword.
  if (isExplicitFlag(context, 'citations') || CITATIONS_KEYWORDS.test(text)) {
    reasons.push('explicit_citations');
  }

  // multiple_deliverables: context.deliverables array with length > 1.
  if (isArrayWithMinLength(context, 'deliverables', 2)) {
    reasons.push('multiple_deliverables');
  }

  // dependencies: context.dependencies array with length > 0.
  if (isArrayWithMinLength(context, 'dependencies', 1)) {
    reasons.push('dependencies');
  }

  // multiple_agents: context.agents array with length > 1.
  if (isArrayWithMinLength(context, 'agents', 2)) {
    reasons.push('multiple_agents');
  }

  // irreversible_tool: context.irreversibleTools array with length > 0.
  if (isArrayWithMinLength(context, 'irreversibleTools', 1)) {
    reasons.push('irreversible_tool');
  }

  return reasons;
}

/**
 * Determine the winning concrete mode from matching reasons.
 *
 * - Analyst wins if any of its first three reasons match.
 * - Otherwise Deep Work wins any complexity reason.
 * - Otherwise Fast wins (simple).
 */
function resolveModeFromReasons(reasons: ClassifierReason[]): AutoResolvedMode {
  if (reasons.some((r) => ANALYST_REASONS.has(r))) {
    return 'analyst';
  }
  if (reasons.some((r) => DEEP_WORK_REASONS.has(r))) {
    return 'deep_work';
  }
  return 'fast';
}

/**
 * Classify validated request metadata into a concrete mode + ordered reasons.
 *
 * This is a pure, deterministic function. The same input always produces the
 * same output. It never receives or considers external/retrieved content.
 *
 * `simple` is included in the reasons only when no other reason matches.
 */
export function classifyRequest(metadata: RequestMetadata): ClassificationResult {
  const detected = detectReasons(metadata);
  const reasons: ClassifierReason[] = detected.length > 0 ? detected : ['simple'];
  const resolvedMode = resolveModeFromReasons(reasons);

  return {
    classifierVersion: CLASSIFIER_VERSION,
    resolvedMode,
    reasons,
  };
}

/**
 * Check whether a classification indicates complex work (any non-simple
 * reason). Used by Fast mode to determine whether planning/approval is
 * required. Fast complexity uses the same classifier version and ordered
 * matching reasons as Auto.
 */
export function isComplex(reasons: ClassifierReason[]): boolean {
  return reasons.some((r) => r !== 'simple');
}
