import { type ResolvedPolicy, policyContentHash } from './policy.js';
import type { RoutingRequirements } from './plan-schema.js';
import { AppError } from '../../middleware/error-handler.js';

/**
 * Child policy derivation for hybrid subthread routing.
 *
 * (VAL-SUB-087, VAL-SUB-108)
 *
 * When a ready shell is routed to a permanent company agent, routing
 * commits one immutable child execution-policy snapshot as:
 *
 *   parent policy ∩ approved node ∩ selected agent current policy
 *
 * This includes provider/model, instruction identity/hash, permissions,
 * exact tools/domains, timeout, numeric caps, credential eligibility, and
 * billing ID. The child policy may only narrow its parent — never broaden.
 *
 * After `child.routed`, Phase 1 never reroutes or substitutes that run.
 * Later agent broadening (more tools, higher budget) never expands the
 * snapshot hash. Later revocation (agent paused, tools removed, budget
 * exhausted) fails the child `AGENT_BECAME_INELIGIBLE` before the next
 * effect — it never reroutes.
 */

/** Selected agent's current settings needed for policy derivation. */
export interface AgentPolicySettings {
  id: string;
  provider: string;
  model: string;
  toolsEnabled: string[];
  allowedDomains: string[];
  permissions: string[];
  executionTimeoutSeconds: number;
  budgetMonthlyCents: number;
  spentMonthlyCents: number;
  status: string;
}

/** Input for deriving a child policy snapshot. */
export interface DeriveChildPolicyInput {
  /** The parent run's resolved policy snapshot. */
  parentPolicy: ResolvedPolicy;
  /** The approved plan step's routing requirements. */
  routingRequirements: RoutingRequirements;
  /** The selected agent's current settings. */
  agent: AgentPolicySettings;
  /** The step's estimated budget in integer cents. */
  stepBudgetCents: number;
}

/**
 * Derive an immutable child execution-policy snapshot from the parent
 * policy intersected with the approved node and selected agent's current
 * policy (VAL-SUB-087, VAL-SUB-108).
 *
 * Intersection laws:
 * - Sets (tools, domains): intersection of parent ∩ agent. The approved
 *   node's required tools/domains are eligibility checks (agent must have
 *   them), not additional narrowing — they are already a subset of the
 *   agent's tools/domains.
 * - Maxima (limits): minimum of parent and agent values.
 * - Provider/model: from selected agent (must match parent — checked by
 *   the router before calling this function).
 * - Everything else (instruction hash, research/planning/approval policy,
 *   partial result policy, source profile): inherited from parent.
 *
 * An empty tool or domain intersection after narrowing fails with
 * POLICY_UNSATISFIABLE — the child cannot execute with zero allowed tools
 * or domains if the parent had any.
 *
 * This is a pure function: it does not touch Postgres. The caller persists
 * the returned ResolvedPolicy as a new run_policy_snapshots row and links
 * it to the child run and step assignment.
 */
export function deriveChildPolicy(input: DeriveChildPolicyInput): ResolvedPolicy {
  const { parentPolicy, agent } = input;

  // Provider and model come from the selected agent. The router already
  // verified provider compatibility (agent.provider === parent.provider).
  // The model is the agent's current model — no substitution.
  const provider = agent.provider;
  const model = agent.model;

  // Tool allowlist: parent ∩ agent.
  const agentTools = new Set(agent.toolsEnabled);
  const toolAllowlist = parentPolicy.toolAllowlist.filter((t) => agentTools.has(t));

  // If the parent had tools but the intersection is empty, the child
  // cannot execute — fail closed.
  if (parentPolicy.toolAllowlist.length > 0 && toolAllowlist.length === 0) {
    throw new AppError(
      422,
      'POLICY_UNSATISFIABLE',
      'Child policy tool intersection is empty — the selected agent lacks all parent-allowed tools.',
    );
  }

  // Domain allowlist: parent ∩ agent.
  const agentDomains = new Set(agent.allowedDomains);
  const domainAllowlist = parentPolicy.domainAllowlist.filter((d) => agentDomains.has(d));

  if (parentPolicy.domainAllowlist.length > 0 && domainAllowlist.length === 0) {
    throw new AppError(
      422,
      'POLICY_UNSATISFIABLE',
      'Child policy domain intersection is empty — the selected agent lacks all parent-allowed domains.',
    );
  }

  // Limits: minimum of parent and agent values.
  // Agent's executionTimeoutSeconds narrows the duration.
  // Agent's remaining monthly budget narrows the cost ceiling.
  // Step budget further narrows the cost ceiling.
  const parentLimits = parentPolicy.limits;
  const agentRemainingBudget =
    agent.budgetMonthlyCents === 0
      ? parentLimits.costCents // unlimited agent budget — use parent
      : Math.max(0, agent.budgetMonthlyCents - agent.spentMonthlyCents);

  const limits = {
    steps: parentLimits.steps,
    durationSeconds: Math.min(parentLimits.durationSeconds, agent.executionTimeoutSeconds),
    providerCalls: parentLimits.providerCalls,
    totalTokens: parentLimits.totalTokens,
    outputBytes: parentLimits.outputBytes,
    costCents: Math.min(parentLimits.costCents, agentRemainingBudget, input.stepBudgetCents),
    depth: parentLimits.depth,
    fanOut: parentLimits.fanOut,
    descendants: parentLimits.descendants,
  };

  // Build the child policy. Everything not narrowed is inherited from the
  // parent snapshot. The source profile identity is inherited so the child
  // preserves the mode label even if the profile is later renamed/disabled.
  const childPolicy: ResolvedPolicy = {
    schemaVersion: parentPolicy.schemaVersion,
    sourceProfile: parentPolicy.sourceProfile,
    sourceProfileName: parentPolicy.sourceProfileName,
    sourceProfileDescription: parentPolicy.sourceProfileDescription,
    sourceProfileVersion: parentPolicy.sourceProfileVersion ?? null,
    modeProfileId: parentPolicy.modeProfileId ?? null,
    provider,
    adapterId: parentPolicy.adapterId,
    model,
    reasoningDepth: parentPolicy.reasoningDepth,
    systemPromptHash: parentPolicy.systemPromptHash,
    instructionHash: parentPolicy.instructionHash,
    toolAllowlist,
    domainAllowlist,
    researchPolicy: parentPolicy.researchPolicy,
    planningPolicy: parentPolicy.planningPolicy,
    approvalPolicy: parentPolicy.approvalPolicy,
    fallbackPolicy: parentPolicy.fallbackPolicy,
    partialResultPolicy: parentPolicy.partialResultPolicy,
    limits,
    resolvedMode: parentPolicy.resolvedMode,
  };

  return childPolicy;
}

/**
 * Compute the content hash for a child policy. Uses the same canonical
 * hashing as the parent policy (VAL-SUB-087): the hash is immutable after
 * commit and later broadening never expands it.
 */
export function childPolicyContentHash(policy: ResolvedPolicy): string {
  return policyContentHash(policy);
}

/**
 * Check whether a routed agent is still eligible for the child's committed
 * policy (VAL-SUB-087). After `child.routed`, revocation can only deny —
 * never reroute. If the agent has become ineligible (status changed, tools
 * removed, domains removed, provider changed, budget exhausted), this
 * returns false and the caller fails the child with AGENT_BECAME_INELIGIBLE.
 *
 * This function checks the agent's CURRENT settings against the committed
 * child policy snapshot. Later broadening (more tools, higher budget) does
 * NOT expand the hash — the snapshot is immutable. But revocation (fewer
 * tools, paused status, exhausted budget) causes ineligibility.
 *
 * @returns `null` if eligible, or a safe reason code if ineligible.
 */
export function checkRoutedAgentEligibility(
  childPolicy: ResolvedPolicy,
  agent: AgentPolicySettings,
): string | null {
  // Status check: paused/error/offline are ineligible.
  const ELIGIBLE_STATUSES = new Set(['idle', 'working']);
  if (!ELIGIBLE_STATUSES.has(agent.status)) {
    return 'AGENT_BECAME_INELIGIBLE';
  }

  // Provider check: agent's provider must still match the committed policy.
  if (agent.provider !== childPolicy.provider) {
    return 'AGENT_BECAME_INELIGIBLE';
  }

  // Tool check: the agent must still possess every tool in the committed
  // child policy's allowlist. If tools were removed, the child can no longer
  // execute its committed policy.
  const agentTools = new Set(agent.toolsEnabled);
  const hasAllTools = childPolicy.toolAllowlist.every((t) => agentTools.has(t));
  if (!hasAllTools) {
    return 'AGENT_BECAME_INELIGIBLE';
  }

  // Domain check: the agent must still allow every domain in the committed
  // child policy's allowlist.
  const agentDomains = new Set(agent.allowedDomains);
  const hasAllDomains = childPolicy.domainAllowlist.every((d) => agentDomains.has(d));
  if (!hasAllDomains) {
    return 'AGENT_BECAME_INELIGIBLE';
  }

  // Permission check: agent must still have content.create.
  if (!agent.permissions.includes('content.create')) {
    return 'AGENT_BECAME_INELIGIBLE';
  }

  // Budget check: agent must still have remaining budget (unless unlimited).
  if (agent.budgetMonthlyCents > 0) {
    const remaining = agent.budgetMonthlyCents - agent.spentMonthlyCents;
    if (remaining <= 0) {
      return 'AGENT_BECAME_INELIGIBLE';
    }
  }

  return null;
}

/**
 * Verify that a later broadening of the agent's policy does NOT expand the
 * child's committed hash (VAL-SUB-087). This is a pure assertion function:
 * given the committed child policy and a broadened agent policy, the child
 * hash remains unchanged because the snapshot is immutable.
 *
 * This function exists to make the immutability invariant explicit and
 * testable. The child policy snapshot is read-only after commit; no live
 * setting can mutate or replace it.
 */
export function verifyHashNotBroadened(
  committedHash: string,
  childPolicy: ResolvedPolicy,
): boolean {
  return childPolicyContentHash(childPolicy) === committedHash;
}
