/**
 * Mission plan content contract — shared client contract.
 *
 * Publishes the closed `PlanContentV1` executable schema shape so that API,
 * UI, and worker clients consume the same contract without importing server
 * internals. The server's `plan-schema.ts` is the authoritative source; this
 * contract is kept in sync so clients and server agree on the closed set of
 * node kinds, replay classes, partial-result policies, and the executor
 * field-consumption manifest.
 *
 * (VAL-PLAN-124) `PlanContentV1` is a closed executable schema: unknown
 * authority fields are rejected by the server, and presentation metadata is
 * separately named and non-authoritative. (VAL-PLAN-112) Every
 * decision-relevant plan field is hash-bound; only explicitly named
 * presentation metadata is excluded and ignored by workers.
 *
 * Schema version 1 is the Phase 1 stable contract.
 */

/** The closed set of plan node kinds. */
export const PLAN_NODE_KINDS = ['root', 'child'] as const;
export type PlanNodeKind = (typeof PLAN_NODE_KINDS)[number];

/** The closed set of tool/external-call replay classes. */
export const PLAN_REPLAY_CLASSES = ['read_only', 'idempotent_write', 'non_replayable'] as const;
export type PlanReplayClass = (typeof PLAN_REPLAY_CLASSES)[number];

/** The closed set of partial-result policies. */
export const PLAN_PARTIAL_RESULT_POLICIES = ['require_all', 'best_effort'] as const;
export type PlanPartialResultPolicy = (typeof PLAN_PARTIAL_RESULT_POLICIES)[number];

/** The closed set of routing kinds for an executable step. */
export const PLAN_ROUTING_KINDS = ['requirements', 'concreteAgent'] as const;
export type PlanRoutingKind = (typeof PLAN_ROUTING_KINDS)[number];

/** The closed set of input-binding source kinds. */
export const PLAN_INPUT_SOURCE_KINDS = ['stepOutput', 'requestContext', 'artifact'] as const;
export type PlanInputSourceKind = (typeof PLAN_INPUT_SOURCE_KINDS)[number];

/** Contract schema version for stable evolution. */
export const PLAN_CONTRACT_SCHEMA_VERSION = 1;

/**
 * The authoritative plan field-consumption manifest. The executor (worker)
 * reads exactly these authority fields; presentation metadata is excluded
 * and has no execution effect (VAL-PLAN-112).
 */
export interface PlanExecutorFieldManifest {
  schemaVersion: number;
  /** Every authority field the executor consumes. */
  authorityFields: readonly string[];
  /** Non-authoritative presentation fields, excluded from hashing/execution. */
  presentationFields: readonly string[];
}

/**
 * The published Mission plan content contract. Mirrors the server's
 * `PlanContentV1` closed schema. When the server schema changes, this
 * contract must be updated in the same commit.
 */
export interface MissionPlanContract {
  schemaVersion: number;
  nodeKinds: readonly PlanNodeKind[];
  replayClasses: readonly PlanReplayClass[];
  partialResultPolicies: readonly PlanPartialResultPolicy[];
  routingKinds: readonly PlanRoutingKind[];
  inputSourceKinds: readonly PlanInputSourceKind[];
  /** Top-level authority fields of PlanContentV1 (hash-bound). */
  contentAuthorityFields: readonly string[];
  /** Per-step authority fields (hash-bound). */
  stepAuthorityFields: readonly string[];
  /** Synthesis authority fields (hash-bound). */
  synthesisAuthorityFields: readonly string[];
  /** Named non-authoritative presentation metadata fields. */
  presentationFields: readonly string[];
}

/** Top-level authority fields of PlanContentV1 (VAL-PLAN-124). */
const CONTENT_AUTHORITY_FIELDS = [
  'schemaVersion',
  'objective',
  'steps',
  'synthesis',
  'planningBudgetCents',
  'partialResultPolicy',
  'limits',
] as const;

/** Per-step authority fields (VAL-PLAN-124). */
const STEP_AUTHORITY_FIELDS = [
  'stepKey',
  'parentStepKey',
  'childOrdinal',
  'nodeKind',
  'title',
  'description',
  'dependencies',
  'inputBindings',
  'routing',
  'toolAllowlist',
  'replayClass',
  'sideEffecting',
  'expectedOutputs',
  'evidenceRequirements',
  'completionCriteria',
  'budgetCents',
  'limits',
] as const;

/** Synthesis authority fields (VAL-PLAN-124). */
const SYNTHESIS_AUTHORITY_FIELDS = [
  'instructions',
  'declaredInputs',
  'declaredOutput',
  'evidenceRequirements',
  'completionCriteria',
  'budgetCents',
] as const;

/** Named non-authoritative presentation metadata fields (VAL-PLAN-112). */
const PRESENTATION_FIELDS = ['cardTitle', 'summary'] as const;

/**
 * The complete Mission plan content contract.
 */
export const MISSION_PLAN_CONTRACT: MissionPlanContract = {
  schemaVersion: PLAN_CONTRACT_SCHEMA_VERSION,
  nodeKinds: PLAN_NODE_KINDS,
  replayClasses: PLAN_REPLAY_CLASSES,
  partialResultPolicies: PLAN_PARTIAL_RESULT_POLICIES,
  routingKinds: PLAN_ROUTING_KINDS,
  inputSourceKinds: PLAN_INPUT_SOURCE_KINDS,
  contentAuthorityFields: CONTENT_AUTHORITY_FIELDS,
  stepAuthorityFields: STEP_AUTHORITY_FIELDS,
  synthesisAuthorityFields: SYNTHESIS_AUTHORITY_FIELDS,
  presentationFields: PRESENTATION_FIELDS,
};

/**
 * The executor field-consumption manifest. The worker reads exactly the
 * authority fields; presentation metadata is excluded and has no execution
 * effect (VAL-PLAN-112, VAL-PLAN-124).
 */
export const PLAN_EXECUTOR_FIELD_MANIFEST: PlanExecutorFieldManifest = {
  schemaVersion: PLAN_CONTRACT_SCHEMA_VERSION,
  authorityFields: [
    ...CONTENT_AUTHORITY_FIELDS,
    ...STEP_AUTHORITY_FIELDS.map((f) => `steps[].${f}`),
    ...SYNTHESIS_AUTHORITY_FIELDS.map((f) => `synthesis.${f}`),
  ],
  presentationFields: PRESENTATION_FIELDS,
};
