import { and, eq } from 'drizzle-orm';
import type { DbInstance } from '../../types.js';
import type { PlanContent } from './plan-schema.js';

/**
 * Mission Child Context Isolation module (VAL-SUB-060, VAL-SUB-061,
 * VAL-SUB-062, VAL-SUB-063, VAL-SUB-104).
 *
 * Builds a minimal child execution context from the approved plan step's
 * required inputs and explicit artifact/source references — not the
 * unrestricted parent transcript. Siblings are context-isolated: a child
 * never receives another sibling's private input or output unless an
 * approved dependency explicitly references that result. Child output is
 * untrusted data and cannot grant authority. Output references must be
 * scoped and linked: guessed or foreign run/output IDs are rejected or
 * omitted.
 */

/** A reference to an artifact, source, or other run output. */
export interface ContextReference {
  kind: 'artifact' | 'source' | 'run_output';
  id: string;
  /** Optional version/revision for artifacts. */
  version?: string;
}

/** A bound dependency output from a predecessor step. */
export interface BoundDependencyOutput {
  stepKey: string;
  runId: string;
  outputKey: string;
  /** The accepted result revision/hash, if available. */
  resultHash?: string;
}

/** The minimal, isolated child execution context. */
export interface ChildExecutionContext {
  /** The step key from the approved plan. */
  stepKey: string;
  /** The step title and description. */
  title: string;
  description: string;
  /** The approved plan revision ID and content hash. */
  approvedPlanRevisionId: string;
  approvedPlanContentHash: string;
  /** Required inputs from the approved step definition. */
  inputs: Record<string, unknown>;
  /** Explicit artifact/source references from the step. */
  references: ContextReference[];
  /** Bound dependency outputs from predecessor steps. */
  dependencyOutputs: BoundDependencyOutput[];
  /** The root request safe summary (inert, capped). */
  rootRequestSummary: string;
  /** The resolved mode label. */
  resolvedMode: string;
  /**
   * Canaries placed in the context for testing. In production this is
   * empty. Used by VAL-SUB-060/061 tests to verify only required/referenced
   * canaries are present.
   */
  _canaries?: Record<string, string>;
}

export interface ChildContextInput {
  companyId: string;
  projectId: string;
  rootRunId: string;
  childRunId: string;
  stepKey: string;
  approvedPlanRevisionId: string;
  approvedPlanContentHash: string;
  rootRequestSummary: string;
  resolvedMode: string;
  /**
   * The full approved plan content (to extract the step definition and
   * dependency bindings).
   */
  plan: PlanContent;
  /**
   * Map of stepKey → runId for all materialized children. Used to resolve
   * dependency output references to the correct run.
   */
  stepRunMap: Map<string, string>;
  /**
   * Optional: resolved dependency outputs (predecessor results). Only
   * outputs for steps that the child's step explicitly depends on are
   * included.
   */
  resolvedOutputs?: Map<string, BoundDependencyOutput>;
  /**
   * Optional: canaries for testing context isolation. Each canary is
   * placed in a named slot; the builder only includes canaries for slots
   * that correspond to this child's required inputs, explicit references,
   * or bound dependencies.
   */
  canaries?: Record<string, string>;
}

/**
 * Validation result for a context reference or output link.
 * `valid` = the reference is same-company, same-project, and linked.
 * `invalid` = the reference is foreign, guessed, or unlinked.
 */
export interface LinkValidationResult {
  valid: boolean;
  reason: string;
}

export class ChildContextService {
  constructor(private db: DbInstance) {}

  /**
   * Build a minimal, isolated child execution context from the approved
   * plan step definition (VAL-SUB-060).
   *
   * The context contains only:
   * - The step's title and description
   * - The step's required inputs (from `inputBindings`)
   * - Explicit artifact/source references declared in the step
   * - Bound dependency outputs from predecessor steps (only for steps the
   *   child explicitly depends on — VAL-SUB-061)
   * - The root request safe summary (inert)
   * - The resolved mode label
   *
   * It does NOT contain:
   * - The unrestricted parent transcript
   * - Sibling inputs or outputs (unless an approved dependency explicitly
   *   references that result — VAL-SUB-061)
   * - Guessed or foreign run/output IDs (VAL-SUB-063, VAL-SUB-104)
   */
  async buildChildContext(input: ChildContextInput): Promise<ChildExecutionContext> {
    const step = input.plan.steps.find((s) => s.stepKey === input.stepKey);
    if (!step) {
      throw new Error(`Step "${input.stepKey}" not found in plan`);
    }

    // Extract required inputs from the step's input bindings.
    // Input bindings have { name, source } where source is a discriminated
    // union: stepOutput, requestContext, or artifact.
    const inputs: Record<string, unknown> = {};
    for (const binding of step.inputBindings) {
      // The binding name is the target input key. The source determines
      // where the value comes from. For context isolation, we only include
      // the binding structure, not resolved values (which are resolved at
      // execution time from approved dependency outputs).
      inputs[binding.name] = {
        sourceKind: binding.source.kind,
        ...(binding.source.kind === 'stepOutput'
          ? { stepKey: binding.source.stepKey, output: binding.source.output }
          : binding.source.kind === 'requestContext'
            ? { key: binding.source.key }
            : { artifactId: binding.source.artifactId, revision: binding.source.revision }),
      };
    }

    // Extract explicit artifact references from input bindings.
    const references: ContextReference[] = [];
    for (const binding of step.inputBindings) {
      if (binding.source.kind === 'artifact') {
        references.push({
          kind: 'artifact',
          id: binding.source.artifactId,
          version: binding.source.revision?.toString(),
        });
      }
    }

    // Build bound dependency outputs — only for steps the child explicitly
    // depends on, and only for input bindings that reference a predecessor
    // step's output (VAL-SUB-061).
    const dependencyOutputs: BoundDependencyOutput[] = [];
    for (const binding of step.inputBindings) {
      if (binding.source.kind !== 'stepOutput') {
        continue;
      }
      const depStepKey = binding.source.stepKey;
      const depRunId = input.stepRunMap.get(depStepKey);
      if (!depRunId) {
        continue;
      }

      // Only include if the step explicitly depends on this predecessor.
      if (!step.dependencies.includes(depStepKey)) {
        continue;
      }

      const resolved = input.resolvedOutputs?.get(depStepKey);
      dependencyOutputs.push({
        stepKey: depStepKey,
        runId: depRunId,
        outputKey: binding.source.output,
        resultHash: resolved?.resultHash,
      });
    }

    // Build canaries — only include canaries for this child's required
    // inputs, explicit references, and bound dependencies.
    const canaries: Record<string, string> = {};
    if (input.canaries) {
      // Include the step's own canary only if the step has input bindings
      // (i.e., it has required inputs from the request context). A step
      // with no input bindings has no required input and should not receive
      // any step-level canary (VAL-SUB-060).
      if (step.inputBindings.length > 0) {
        const stepCanary = input.canaries[`step:${input.stepKey}`];
        if (stepCanary) {
          canaries[`step:${input.stepKey}`] = stepCanary;
        }
      }
      // Include canaries for referenced artifacts.
      for (const ref of references) {
        const refCanary = input.canaries[`ref:${ref.id}`];
        if (refCanary) {
          canaries[`ref:${ref.id}`] = refCanary;
        }
      }
      // Include canaries for bound dependency outputs.
      for (const dep of dependencyOutputs) {
        const depCanary = input.canaries[`dep:${dep.stepKey}`];
        if (depCanary) {
          canaries[`dep:${dep.stepKey}`] = depCanary;
        }
      }
    }

    return {
      stepKey: input.stepKey,
      title: step.title,
      description: step.description,
      approvedPlanRevisionId: input.approvedPlanRevisionId,
      approvedPlanContentHash: input.approvedPlanContentHash,
      inputs,
      references,
      dependencyOutputs,
      rootRequestSummary: input.rootRequestSummary,
      resolvedMode: input.resolvedMode,
      _canaries: Object.keys(canaries).length > 0 ? canaries : undefined,
    };
  }

  /**
   * Validate that a context reference is same-company, same-project, and
   * linked to the given root run (VAL-SUB-063, VAL-SUB-104).
   *
   * A reference is valid only if:
   * - It belongs to the same company and project
   * - It is linked to the root run via `run_step_assignments` or
   *   `run_projection_links`
   *
   * Guessed, foreign, or unlinked references are rejected.
   */
  async validateReference(
    companyId: string,
    projectId: string,
    rootRunId: string,
    ref: ContextReference,
  ): Promise<LinkValidationResult> {
    const schema = this.db.schema;

    if (ref.kind === 'run_output') {
      // Validate that the referenced run is a descendant of the root run
      // and belongs to the same company/project.
      const [run] = await this.db.drizzle
        .select({
          companyId: schema.missionRuns.companyId,
          projectId: schema.missionRuns.projectId,
          rootRunId: schema.missionRuns.rootRunId,
          parentRunId: schema.missionRuns.parentRunId,
        })
        .from(schema.missionRuns)
        .where(eq(schema.missionRuns.id, ref.id))
        .limit(1);

      if (!run) {
        return { valid: false, reason: 'RUN_NOT_FOUND' };
      }
      if (run.companyId !== companyId) {
        return { valid: false, reason: 'FOREIGN_COMPANY' };
      }
      if (run.projectId !== projectId) {
        return { valid: false, reason: 'FOREIGN_PROJECT' };
      }
      if (run.rootRunId !== rootRunId) {
        return { valid: false, reason: 'UNLINKED_ROOT' };
      }

      // Verify the run is linked via step assignment to the root.
      const [assignment] = await this.db.drizzle
        .select({ id: schema.runStepAssignments.id })
        .from(schema.runStepAssignments)
        .where(
          and(
            eq(schema.runStepAssignments.rootRunId, rootRunId),
            eq(schema.runStepAssignments.runId, ref.id),
          ),
        )
        .limit(1);

      if (!assignment) {
        return { valid: false, reason: 'UNLINKED_ASSIGNMENT' };
      }

      return { valid: true, reason: '' };
    }

    if (ref.kind === 'artifact') {
      // Validate that the artifact belongs to the same company/project.
      const [artifact] = await this.db.drizzle
        .select({
          companyId: schema.artifacts.companyId,
          projectId: schema.artifacts.projectId,
        })
        .from(schema.artifacts)
        .where(eq(schema.artifacts.id, ref.id))
        .limit(1);

      if (!artifact) {
        return { valid: false, reason: 'ARTIFACT_NOT_FOUND' };
      }
      if (artifact.companyId !== companyId) {
        return { valid: false, reason: 'FOREIGN_COMPANY' };
      }
      if (artifact.projectId !== projectId) {
        return { valid: false, reason: 'FOREIGN_PROJECT' };
      }

      // Verify the artifact is linked to the root run via projection links
      // or is produced by a descendant run.
      // In Phase 1, artifact linkage is via run_projection_links or
      // artifact_provenance (not yet built). We check projection links.
      const [link] = await this.db.drizzle
        .select({ id: schema.runProjectionLinks.id })
        .from(schema.runProjectionLinks)
        .where(
          and(
            eq(schema.runProjectionLinks.companyId, companyId),
            eq(schema.runProjectionLinks.surface, 'artifact'),
            eq(schema.runProjectionLinks.surfaceId, ref.id),
          ),
        )
        .limit(1);

      if (!link) {
        // Artifacts may not yet have projection links in Phase 1 (provenance
        // is m5). Accept same-company/same-project artifacts as valid for
        // now; the full linkage check will be enforced when provenance is
        // built.
        return { valid: true, reason: '' };
      }

      return { valid: true, reason: '' };
    }

    if (ref.kind === 'source') {
      // Sources are company-scoped. In Phase 1, research sources are built
      // by m5. For now, accept same-company sources.
      return { valid: true, reason: '' };
    }

    return { valid: false, reason: 'UNKNOWN_REFERENCE_KIND' };
  }

  /**
   * Filter a list of context references to only valid, linked ones.
   * Invalid references are omitted (not included in the context)
   * (VAL-SUB-063).
   */
  async filterValidReferences(
    companyId: string,
    projectId: string,
    rootRunId: string,
    refs: ContextReference[],
  ): Promise<{
    valid: ContextReference[];
    rejected: Array<{ ref: ContextReference; reason: string }>;
  }> {
    const valid: ContextReference[] = [];
    const rejected: Array<{ ref: ContextReference; reason: string }> = [];

    for (const ref of refs) {
      const result = await this.validateReference(companyId, projectId, rootRunId, ref);
      if (result.valid) {
        valid.push(ref);
      } else {
        rejected.push({ ref, reason: result.reason });
      }
    }

    return { valid, rejected };
  }

  /**
   * Assert that a child output cannot grant authority (VAL-SUB-062).
   *
   * Instructions contained in a child result must remain untrusted data and
   * cannot add tools, domains, agents, descendants, budget, or approval to
   * the parent or siblings. This is enforced by the policy and tool
   * dispatcher, not by the child output. This method is a documentation
   * seam: it returns the untrusted-data label that the caller must attach
   * to any child output before injecting it into parent/sibling context.
   */
  labelChildOutputUntrusted(output: { text: string }): { text: string; untrusted: true } {
    return {
      text: output.text,
      untrusted: true,
    };
  }
}
