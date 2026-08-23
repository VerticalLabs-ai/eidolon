import { useMissionCurrentPlanRevision } from '@/lib/hooks';
import { formatCents } from '@/lib/format';
import type { MissionPlanRevision, MissionPlanRouting, MissionPlanStep } from '@/lib/api';

/**
 * Mission plan authority card.
 *
 * Renders the immutable current plan revision's objective, ordered
 * topology (steps + dependencies), routing authority vs execution
 * assignment, exact tool allowlist, expected outputs, completion criteria,
 * and honest pre/post-routing agent labels from authoritative server
 * content (VAL-PLAN-008, 011, 012, 013, 014, 015, 016, 017, 125).
 *
 * The card never infers routing or authority from missing fields. It
 * renders only what the server's immutable revision carries; a missing
 * current plan revision renders nothing. Status text is always paired with
 * text, never color alone.
 *
 * Accessibility:
 * - A semantic heading identifies the plan and its revision.
 * - Steps are an ordered list (`<ol>`) preserving plan order.
 * - Dependencies are an ordered list per step.
 * - Tools, expected outputs, and capabilities are lists with explicit labels.
 * - Routing labels are explicit text: "Pending routing" for unassigned
 *   requirements routing and "Assigned to <agent>" for concrete assignment,
 *   so pre- and post-routing labels cannot mislead (VAL-PLAN-125).
 */
export function MissionPlanCard({
  companyId,
  projectId,
  runId,
  currentPlanRevisionId,
  resolvedMode,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  currentPlanRevisionId: string | null;
  /** Run resolved mode, used only for the Analyst evidence-plan invariant
   *  label (VAL-PLAN-008). The plan content itself is authoritative. */
  resolvedMode: string;
}) {
  const planQuery = useMissionCurrentPlanRevision(
    companyId,
    projectId,
    runId,
    currentPlanRevisionId,
  );

  // No current plan revision pointer: render nothing.
  if (!currentPlanRevisionId) {
    return null;
  }

  // Loading and no prior data: render nothing yet (the card appears once
  // content is available). A failed fetch with prior data keeps the stale
  // card visible via placeholderData.
  if (!planQuery.data) {
    return null;
  }

  const revision = planQuery.data as MissionPlanRevision | null;
  if (!revision) {
    return null;
  }

  const isApproved = revision.status === 'approved';
  const headingText = isApproved ? 'Approved plan' : 'Proposed plan';
  const hashPrefix = revision.contentHash.slice(0, 12);

  return (
    <section
      id={`mission-plan-revision-${revision.id}`}
      aria-labelledby={`plan-heading-${revision.id}`}
      data-testid="mission-plan-card"
      className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 w-full max-w-full break-words"
    >
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4
          id={`plan-heading-${revision.id}`}
          className="text-sm font-semibold text-text-primary font-display"
        >
          {headingText}
        </h4>
        <span className="text-xs text-text-muted" data-testid="plan-revision">
          Revision {revision.revision}
        </span>
        <span className="text-xs text-text-muted font-mono" data-testid="plan-hash">
          {hashPrefix}
        </span>
      </div>

      <PlanObjective revision={revision} />
      <PlanSteps revision={revision} />
      <PlanSynthesis revision={revision} />
      <PlanBudgetSummary revision={revision} />
      <PlanLimits revision={revision} />
      <PlanPartialPolicy revision={revision} />
      <PlanHashDetails revision={revision} />
      <PlanAnalystEvidenceNotice resolvedMode={resolvedMode} revision={revision} />
    </section>
  );
}

/** Render the plan objective (VAL-PLAN-011). */
function PlanObjective({ revision }: { revision: MissionPlanRevision }) {
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-text-secondary mb-0.5">Objective</p>
      <p className="text-sm text-text-primary break-words">{revision.content.objective}</p>
    </div>
  );
}

/** Render the ordered steps with dependencies, routing, tools, outputs, and
 *  completion criteria (VAL-PLAN-012, 013, 014, 015, 016, 017, 125). */
function PlanSteps({ revision }: { revision: MissionPlanRevision }) {
  const steps = revision.content.steps;
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-text-secondary mb-1">Steps</p>
      <ol aria-label="Plan steps" className="space-y-2">
        {steps.map((step, index) => (
          <PlanStepItem key={step.stepKey} step={step} ordinal={index + 1} />
        ))}
      </ol>
    </div>
  );
}

/** One plan step with all authority-bearing fields. */
function PlanStepItem({ step, ordinal }: { step: MissionPlanStep; ordinal: number }) {
  return (
    <li
      className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 w-full max-w-full break-words"
      aria-label={`Step ${ordinal}: ${step.title}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
        <span className="text-xs tabular-nums text-text-muted shrink-0">{ordinal}.</span>
        <h5 className="text-sm font-medium text-text-primary break-words">{step.title}</h5>
        <span className="text-xs text-text-muted">({step.nodeKind})</span>
      </div>
      <p className="text-xs text-text-secondary mb-2 break-words">{step.description}</p>

      <StepDependencies step={step} />
      <StepRouting step={step} />
      <StepTools step={step} />
      <StepExpectedOutputs step={step} />
      <StepCompletionCriteria step={step} />
      <StepBudget step={step} />
      <StepEvidence step={step} />
    </li>
  );
}

/** Render a step's ordered dependencies (VAL-PLAN-013). Dependencies are
 *  presented as a single labeled line in array order so the steps
 *  `<ol>` keeps only step-level listitems and the dependency order is
 *  still visible. */
function StepDependencies({ step }: { step: MissionPlanStep }) {
  return (
    <p className="text-xs text-text-secondary mb-1.5 break-words">
      {step.dependencies.length === 0
        ? 'No dependencies'
        : `Depends on ${step.dependencies.join(', ')}`}
    </p>
  );
}

/** Render a step's routing authority vs execution assignment with honest
 *  pre/post-routing labels (VAL-PLAN-014, VAL-PLAN-125). */
function StepRouting({ step }: { step: MissionPlanStep }) {
  return (
    <div className="mb-1.5">
      <p className="text-xs font-medium text-text-secondary inline">Routing: </p>
      <RoutingLabel routing={step.routing} />
    </div>
  );
}

/**
 * Honest routing label (VAL-PLAN-125).
 *
 * - `requirements`: the step is not yet assigned to a concrete agent. Label
 *   "Pending routing" and list the required capabilities so the user sees
 *   the routing authority without implying an assignment.
 * - `concreteAgent`: the step is assigned to a specific executing agent.
 *   Label "Assigned to <executingAgentId>" so the user sees the execution
 *   assignment without implying it is still pending.
 */
function RoutingLabel({ routing }: { routing: MissionPlanRouting }) {
  if (routing.kind === 'concreteAgent') {
    return (
      <span className="text-xs text-text-primary" data-testid="routing-assigned">
        Assigned to {routing.executingAgentId}
      </span>
    );
  }
  const r = routing.routingRequirements;
  return (
    <span data-testid="routing-pending">
      <span className="text-xs text-text-primary">Pending routing</span>
      <span className="text-xs text-text-muted">
        {' '}
        (capabilities: {r.capabilities.join(', ') || 'none'}
        {r.ephemeralAllowed ? '; ephemeral allowed' : ''})
      </span>
    </span>
  );
}

/** Render the exact tool allowlist (VAL-PLAN-015). Each tool is its own
 *  element so exact tool names are individually queryable and the steps
 *  `<ol>` keeps only step-level listitems. */
function StepTools({ step }: { step: MissionPlanStep }) {
  return (
    <div className="mb-1.5">
      <p className="text-xs font-medium text-text-secondary inline">Tools: </p>
      {step.toolAllowlist.length === 0 ? (
        <span className="text-xs text-text-muted">None</span>
      ) : (
        <span aria-label={`Tools for ${step.stepKey}`}>
          {step.toolAllowlist.map((tool, i) => (
            <span key={tool}>
              <span className="text-xs text-text-primary font-mono">{tool}</span>
              {i < step.toolAllowlist.length - 1 ? (
                <span className="text-xs text-text-muted">, </span>
              ) : null}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** Render the expected outputs (VAL-PLAN-016). Each output is its own
 *  element so exact output names are individually queryable. */
function StepExpectedOutputs({ step }: { step: MissionPlanStep }) {
  return (
    <div className="mb-1.5">
      <p className="text-xs font-medium text-text-secondary inline">Expected outputs: </p>
      {step.expectedOutputs.length === 0 ? (
        <span className="text-xs text-text-muted">None</span>
      ) : (
        <span aria-label={`Expected outputs for ${step.stepKey}`}>
          {step.expectedOutputs.map((out, i) => (
            <span key={out}>
              <span className="text-xs text-text-primary font-mono">{out}</span>
              {i < step.expectedOutputs.length - 1 ? (
                <span className="text-xs text-text-muted">, </span>
              ) : null}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/** Render the completion criteria (VAL-PLAN-017). */
function StepCompletionCriteria({ step }: { step: MissionPlanStep }) {
  return (
    <div className="mb-1.5">
      <p className="text-xs font-medium text-text-secondary inline">Completion criteria: </p>
      <span className="text-xs text-text-primary break-words">{step.completionCriteria}</span>
    </div>
  );
}

/** Render the step budget as an integer-cent currency amount, including
 *  zero (VAL-PLAN-018). The value is always an exact currency string
 *  derived from integer cents; no hidden or floating-point estimate. */
function StepBudget({ step }: { step: MissionPlanStep }) {
  return (
    <div className="mb-1.5" data-testid="step-budget">
      <p className="text-xs font-medium text-text-secondary inline">Budget: </p>
      <span className="text-xs tabular-nums text-text-primary">
        {formatCents(step.budgetCents)}
      </span>
    </div>
  );
}

/** Render evidence requirements (VAL-PLAN-008). */
function StepEvidence({ step }: { step: MissionPlanStep }) {
  if (!step.evidenceRequirements?.citationsRequired) {
    return null;
  }
  return <p className="text-xs text-text-secondary mb-1">Citations required</p>;
}

/** Render the synthesis section. */
function PlanSynthesis({ revision }: { revision: MissionPlanRevision }) {
  const syn = revision.content.synthesis;
  return (
    <div className="mb-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 w-full max-w-full break-words">
      <h5 className="text-sm font-medium text-text-primary mb-1">Synthesis</h5>
      <p className="text-xs text-text-secondary mb-1.5 break-words">{syn.instructions}</p>
      <div className="mb-1.5">
        <p className="text-xs font-medium text-text-secondary inline">Declared output: </p>
        <span className="text-xs text-text-primary font-mono">{syn.declaredOutput}</span>
      </div>
      <div className="mb-1.5">
        <p className="text-xs font-medium text-text-secondary inline">Completion criteria: </p>
        <span className="text-xs text-text-primary break-words">{syn.completionCriteria}</span>
      </div>
      {syn.evidenceRequirements?.citationsRequired && (
        <p className="text-xs text-text-secondary">Citations required</p>
      )}
    </div>
  );
}

/**
 * Analyst evidence-plan notice (VAL-PLAN-008).
 *
 * An Analyst-mode run always proposes an evidence plan: the plan's
 * synthesis (and at least one step) requires citations. When the run is
 * Analyst mode, surface an explicit, accessible notice that this is an
 * evidence-bearing plan. The notice is derived from the authoritative plan
 * content (evidenceRequirements.citationsRequired), not from the mode
 * label alone.
 */
function PlanAnalystEvidenceNotice({
  resolvedMode,
  revision,
}: {
  resolvedMode: string;
  revision: MissionPlanRevision;
}) {
  if (resolvedMode !== 'analyst') {
    return null;
  }
  const synthesisCites = revision.content.synthesis.evidenceRequirements?.citationsRequired;
  const anyStepCites = revision.content.steps.some(
    (s) => s.evidenceRequirements?.citationsRequired,
  );
  if (!synthesisCites && !anyStepCites) {
    return null;
  }
  return (
    <p
      className="mt-2 text-xs text-text-secondary"
      role="status"
      data-testid="analyst-evidence-notice"
    >
      Evidence plan: external factual claims require citations.
    </p>
  );
}

/**
 * Total estimated Mission budget, reconciled from the immutable plan
 * content (VAL-PLAN-019).
 *
 * The total equals the sum of displayed step budgets plus the separately
 * budgeted planning and synthesis amounts. Every value is an exact
 * integer-cent currency string; no hidden or floating-point estimate. The
 * step subtotal, planning, and synthesis amounts are shown separately so a
 * reviewer can reconcile the arithmetic against the authoritative plan
 * snapshot.
 */
function PlanBudgetSummary({ revision }: { revision: MissionPlanRevision }) {
  const stepSubtotal = revision.content.steps.reduce((sum, s) => sum + s.budgetCents, 0);
  const planning = revision.content.planningBudgetCents;
  const synthesis = revision.content.synthesis.budgetCents;
  const total = stepSubtotal + planning + synthesis;
  return (
    <div className="mb-3">
      <p className="text-xs font-medium text-text-secondary mb-1">Estimated budget</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-text-muted">Step budgets</dt>
        <dd className="tabular-nums text-text-primary" data-testid="plan-step-budget-subtotal">
          {formatCents(stepSubtotal)}
        </dd>
        <dt className="text-text-muted">Planning</dt>
        <dd className="tabular-nums text-text-primary" data-testid="plan-planning-budget">
          {formatCents(planning)}
        </dd>
        <dt className="text-text-muted">Synthesis</dt>
        <dd className="tabular-nums text-text-primary" data-testid="plan-synthesis-budget">
          {formatCents(synthesis)}
        </dd>
        <dt className="text-text-secondary font-medium">Total</dt>
        <dd className="tabular-nums text-text-primary font-medium" data-testid="plan-total-budget">
          {formatCents(total)}
        </dd>
      </dl>
    </div>
  );
}

/** Format a duration in seconds as a compact human-readable string with the
 *  exact seconds value, e.g. `2,700s (45m 0s)`. */
function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${seconds.toLocaleString('en-US')}s (${minutes}m ${remainingSeconds}s)`;
}

/** Format a byte count as a compact binary size with the exact byte value,
 *  e.g. `8 MiB (8,388,608 bytes)`. */
function formatBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${mib} MiB (${bytes.toLocaleString('en-US')} bytes)`;
}

/**
 * Applicable plan limits, available before a decision (VAL-PLAN-020).
 *
 * Each value is reconciled to the authoritative plan/policy snapshot. The
 * limits are the immutable revision's `limits` object; the total cost limit
 * is rendered as exact currency from integer cents.
 */
function PlanLimits({ revision }: { revision: MissionPlanRevision }) {
  const limits = revision.content.limits;
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Steps', value: limits.steps.toLocaleString('en-US') },
    { label: 'Duration', value: formatDuration(limits.durationSeconds) },
    { label: 'Provider calls', value: limits.providerCalls.toLocaleString('en-US') },
    { label: 'Total tokens', value: limits.totalTokens.toLocaleString('en-US') },
    { label: 'Persisted output', value: formatBytes(limits.outputBytes) },
    { label: 'Total cost', value: formatCents(limits.costCents) },
    { label: 'Depth', value: limits.depth.toLocaleString('en-US') },
    { label: 'Fan-out', value: limits.fanOut.toLocaleString('en-US') },
    { label: 'Descendants', value: limits.descendants.toLocaleString('en-US') },
  ];
  return (
    <div className="mb-3" data-testid="plan-limits">
      <p className="text-xs font-medium text-text-secondary mb-1">Limits</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-text-muted">{row.label}</dt>
            <dd className="tabular-nums text-text-primary">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** Human-readable mapping for the closed partial-result policy set. */
function partialPolicyLabel(policy: 'require_all' | 'best_effort'): string {
  return policy === 'require_all'
    ? 'Require all steps to complete before synthesis.'
    : 'Best effort: permit partial results when a step fails.';
}

/**
 * The partial-result policy, in plain language, before approval
 * (VAL-PLAN-021). The value comes from the immutable plan content, not a
 * client-inferred transition.
 */
function PlanPartialPolicy({ revision }: { revision: MissionPlanRevision }) {
  const policy = revision.content.partialResultPolicy;
  return (
    <div className="mb-3" data-testid="plan-partial-policy">
      <p className="text-xs font-medium text-text-secondary inline">Partial-result policy: </p>
      <span className="text-xs text-text-primary break-words">{partialPolicyLabel(policy)}</span>
    </div>
  );
}

/**
 * The immutable revision number and full lowercase SHA-256 content hash
 * (VAL-PLAN-022). The revision is always visible in the card header; the
 * full 64-character hash is available through a clearly labelled details
 * control so the card stays compact while the exact hash remains inspectable
 * before approval. The hash is rendered verbatim from the authoritative
 * revision and never recomputed in the browser.
 */
function PlanHashDetails({ revision }: { revision: MissionPlanRevision }) {
  return (
    <details className="mb-2" data-testid="plan-hash-details">
      <summary className="text-xs text-text-muted cursor-pointer select-none">
        Content hash and revision
      </summary>
      <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
        <dt className="text-text-muted">Revision</dt>
        <dd className="tabular-nums text-text-primary">{revision.revision}</dd>
        <dt className="text-text-muted">Content hash</dt>
        <dd>
          <code className="text-xs text-text-primary font-mono break-all">
            {revision.contentHash}
          </code>
        </dd>
      </dl>
    </details>
  );
}
