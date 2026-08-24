/**
 * Pure derivation helpers for the Mission child tree
 * (VAL-SUB-020, 024, 025, 068, 069, 089, 093).
 *
 * These functions are framework-free projections of authoritative server
 * state: the approved plan topology plus committed journal events. The
 * browser never invents identity, routing, status, cost, or progress —
 * every derived field comes from committed events or the plan (VAL-SUB-025).
 */

import type { MissionPlanContent, MissionPlanStep, MissionReplayEvent } from '@/lib/api';

// ── Types ─────────────────────────────────────────────────────────────────

/** Lifecycle status shown for a child node, derived from committed events. */
export type ChildStatus =
  'queued' | 'running' | 'awaiting_input' | 'synthesizing' | 'completed' | 'failed' | 'cancelled';

/** Stable routing label derived from `child.created`/`child.routed`/`child.failed`. */
export type RoutingLabel =
  | { kind: 'pending_dependencies' }
  | { kind: 'pending_routing' }
  | { kind: 'routed'; routingKind: 'company_agent' | 'ephemeral'; agentId: string | null }
  | { kind: 'no_eligible_agent' };

/** A child node derived from the plan topology + committed journal events. */
export interface DerivedChildNode {
  stepKey: string;
  parentStepKey: string | null;
  childOrdinal: number;
  nodeKind: 'root' | 'child';
  depth: number;
  title: string;
  description: string;
  /** Child run id from `child.created`. Null before materialization. */
  childRunId: string | null;
  /** Routing label derived from `child.created`/`child.routed`/`child.failed`. */
  routing: RoutingLabel;
  /** Lifecycle status derived from lifecycle events. */
  status: ChildStatus;
  /** True when a mirrored `questions.requested` indicates the child needs input. */
  needsInput: boolean;
  /** Actual cost in integer cents from `child.completed`. */
  costCents: number | null;
  /** Output summary from `child.completed`. */
  outputSummary: string | null;
  /** Safe failure category from `child.failed`. */
  failureCategory: string | null;
  /** Safe failure code from `child.failed`. */
  failureCode: string | null;
  /** Safe failure message from `child.failed`. */
  safeErrorMessage: string | null;
}

// ── Text helpers (text always accompanies color) ──────────────────────────

/** Human-readable status text (never color alone). */
export function statusText(status: ChildStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'awaiting_input':
      return 'Awaiting input';
    case 'synthesizing':
      return 'Synthesizing';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Stable routing state label (VAL-SUB-089). */
export function routingStateText(label: RoutingLabel): string {
  switch (label.kind) {
    case 'pending_dependencies':
      return 'Pending dependencies';
    case 'pending_routing':
      return 'Pending routing';
    case 'routed':
      return 'Routed';
    case 'no_eligible_agent':
      return 'No eligible agent';
  }
}

/** Assignment label for a routed child (VAL-SUB-069). Null before routing. */
export function routingAssignmentText(label: RoutingLabel): string | null {
  if (label.kind !== 'routed') {
    return null;
  }
  return label.routingKind === 'ephemeral' ? 'Ephemeral' : 'Company agent';
}

/** Badge color class for a status (text always accompanies color). */
export function statusBadgeClass(status: ChildStatus): string {
  switch (status) {
    case 'completed':
      return 'bg-success/10 text-success border-success/20';
    case 'failed':
      return 'bg-error/10 text-error border-error/20';
    case 'cancelled':
      return 'bg-warning/10 text-warning border-warning/20';
    case 'running':
    case 'synthesizing':
      return 'bg-neon-cyan/10 text-neon-cyan border-neon-cyan/20';
    case 'awaiting_input':
      return 'bg-warning/10 text-warning border-warning/20';
    default:
      return 'bg-white/[0.06] text-text-secondary border-white/[0.08]';
  }
}

/** Format integer cents as a currency string. */
export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Whether a lifecycle status is terminal. */
export function isTerminalStatus(status: ChildStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

// ── Derivation ────────────────────────────────────────────────────────────

/** Whether a step has any required dependencies (gates readiness). */
function hasRequiredDependencies(step: MissionPlanStep): boolean {
  return step.dependencies.length > 0;
}

/** Initial derived node for a plan step, before any events are applied. */
function initialNode(step: MissionPlanStep, hasRequiredDeps: boolean): DerivedChildNode {
  return {
    stepKey: step.stepKey,
    parentStepKey: step.parentStepKey,
    childOrdinal: step.childOrdinal,
    nodeKind: step.nodeKind,
    depth: 0,
    title: step.title,
    description: step.description,
    childRunId: null,
    routing: hasRequiredDeps ? { kind: 'pending_dependencies' } : { kind: 'pending_routing' },
    status: 'queued',
    needsInput: false,
    costCents: null,
    outputSummary: null,
    failureCategory: null,
    failureCode: null,
    safeErrorMessage: null,
  };
}

/**
 * Seed a derived node from a `child.created` event, enriched with the plan
 * step's title/topology. Returns null when the step is not a known non-root
 * plan step.
 */
function seedNodeFromCreated(
  stepByKey: Map<string, MissionPlanStep>,
  payload: Record<string, unknown>,
): DerivedChildNode | null {
  const stepKey = payload.stepKey as string | undefined;
  if (!stepKey) {
    return null;
  }
  const step = stepByKey.get(stepKey);
  if (!step) {
    return null;
  }
  const assignmentStatus = (payload.assignmentStatus as string | undefined) ?? 'pending_routing';
  const node = initialNode(step, hasRequiredDependencies(step));
  node.childRunId = (payload.childRunId as string | undefined) ?? null;
  node.depth = (payload.depth as number | undefined) ?? 0;
  node.routing =
    assignmentStatus === 'pending_dependencies'
      ? { kind: 'pending_dependencies' }
      : { kind: 'pending_routing' };
  return node;
}

/**
 * Derive the ordered child nodes for a run from its approved plan topology
 * and committed journal events. Only steps with a `child.created` event
 * (materialized children) are included — a plan that has not yet been
 * materialized produces no tree nodes.
 *
 * Events are applied in sequence order so the latest committed event for
 * a step wins. The browser never advances status beyond what the server
 * committed (VAL-SUB-025).
 */
export function deriveChildNodes(
  plan: MissionPlanContent,
  events: MissionReplayEvent[],
): DerivedChildNode[] {
  const stepByKey = new Map<string, MissionPlanStep>();
  for (const step of plan.steps) {
    if (step.parentStepKey !== null) {
      stepByKey.set(step.stepKey, step);
    }
  }

  const nodes = new Map<string, DerivedChildNode>();
  const runToStep = new Map<string, string>();

  for (const event of events) {
    const payload = event.payload ?? {};

    if (event.type === 'child.created') {
      const node = seedNodeFromCreated(stepByKey, payload);
      if (!node || !node.stepKey) {
        continue;
      }
      nodes.set(node.stepKey, node);
      if (node.childRunId) {
        runToStep.set(node.childRunId, node.stepKey);
      }
      continue;
    }

    if (event.type === 'descendant.progressed') {
      const descendantRunId = (payload.descendantRunId as string | undefined) ?? undefined;
      const targetStepKey = descendantRunId ? runToStep.get(descendantRunId) : undefined;
      const target = targetStepKey ? nodes.get(targetStepKey) : undefined;
      if (target) {
        applyDescendantEvent(
          target,
          (payload.sourceEventType as string | undefined) ?? undefined,
          (payload.sourcePayload as Record<string, unknown> | undefined) ?? {},
        );
      }
      continue;
    }

    const stepKey = (payload.stepKey as string | undefined) ?? undefined;
    const node = stepKey ? nodes.get(stepKey) : undefined;
    if (node) {
      applyChildEvent(node, event.type, payload);
    }
  }

  return Array.from(nodes.values()).sort((a, b) => a.childOrdinal - b.childOrdinal);
}

/**
 * Apply a `child.*` / `execution.*` lifecycle event to a derived node.
 * Terminal statuses are never overwritten by a non-terminal event
 * (VAL-SUB-025).
 */
function applyChildEvent(
  node: DerivedChildNode,
  type: string,
  payload: Record<string, unknown>,
): void {
  switch (type) {
    case 'child.routed': {
      const routingKind = (payload.routingKind as string | undefined) ?? 'company_agent';
      node.routing = {
        kind: 'routed',
        routingKind: routingKind === 'ephemeral' ? 'ephemeral' : 'company_agent',
        agentId: (payload.executingAgentId as string | null | undefined) ?? null,
      };
      return;
    }
    case 'child.started':
    case 'execution.progress': {
      if (!isTerminalStatus(node.status)) {
        node.status = 'running';
      }
      return;
    }
    case 'child.completed': {
      node.status = 'completed';
      node.costCents = (payload.costCents as number | undefined) ?? node.costCents;
      node.outputSummary = (payload.outputSummary as string | undefined) ?? node.outputSummary;
      return;
    }
    case 'child.failed': {
      const code = (payload.code as string | undefined) ?? null;
      node.status = 'failed';
      node.failureCategory = (payload.category as string | undefined) ?? node.failureCategory;
      node.failureCode = code ?? node.failureCode;
      node.safeErrorMessage =
        (payload.safeErrorMessage as string | undefined) ?? node.safeErrorMessage;
      if (code === 'NO_ELIGIBLE_AGENT') {
        node.routing = { kind: 'no_eligible_agent' };
      }
      return;
    }
    case 'child.cancel_requested': {
      if (!isTerminalStatus(node.status)) {
        node.status = 'cancelled';
      }
      return;
    }
    default:
      return;
  }
}

/** Map a mirrored `run.status_changed` status string to a ChildStatus. */
function statusFromMirror(next: string | undefined): ChildStatus | null {
  switch (next) {
    case 'awaiting_input':
      return 'awaiting_input';
    case 'synthesizing':
      return 'synthesizing';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * Apply a mirrored `descendant.progressed` event to the matching child
 * node. Status/question changes are only applied when consistent with the
 * node's current lifecycle (terminal statuses are never reopened,
 * VAL-SUB-025).
 */
function applyDescendantEvent(
  target: DerivedChildNode,
  sourceEventType: string | undefined,
  sourcePayload: Record<string, unknown>,
): void {
  if (sourceEventType === 'run.status_changed') {
    const next = statusFromMirror(sourcePayload.status as string | undefined);
    if (!next) {
      return;
    }
    if (isTerminalStatus(target.status) && !isTerminalStatus(next)) {
      return;
    }
    target.status = next;
    if (next === 'awaiting_input') {
      target.needsInput = true;
    }
    return;
  }
  if (sourceEventType === 'questions.requested') {
    if (!isTerminalStatus(target.status)) {
      target.status = 'awaiting_input';
      target.needsInput = true;
    }
    return;
  }
  if (sourceEventType === 'run.completed') {
    target.status = 'completed';
    return;
  }
  if (sourceEventType === 'run.failed') {
    target.status = 'failed';
    target.failureCategory =
      (sourcePayload.category as string | undefined) ?? target.failureCategory;
    target.failureCode = (sourcePayload.code as string | undefined) ?? target.failureCode;
    target.safeErrorMessage =
      (sourcePayload.safeErrorMessage as string | undefined) ?? target.safeErrorMessage;
    return;
  }
  if (sourceEventType === 'run.cancel_requested' || sourceEventType === 'run.cancelled') {
    if (!isTerminalStatus(target.status)) {
      target.status = 'cancelled';
    }
  }
}
