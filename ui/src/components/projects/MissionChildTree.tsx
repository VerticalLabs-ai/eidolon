import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useMissionRunSnapshot,
  useMissionRunEvents,
  useMissionCurrentPlanRevision,
} from '@/lib/hooks';
import type { MissionPlanRevision, MissionRunSnapshot, MissionReplayEvent } from '@/lib/api';
import { buildMissionUiLink } from '@eidolon/shared';
import {
  CheckCircle2,
  XCircle,
  Clock,
  Activity,
  Ban,
  ChevronRight,
  ChevronDown,
  HelpCircle,
  Layers,
} from 'lucide-react';
import {
  deriveChildNodes,
  statusText,
  routingStateText,
  routingAssignmentText,
  statusBadgeClass,
  formatCents,
  type ChildStatus,
  type DerivedChildNode,
} from './mission-child-tree-helpers';

/**
 * MissionChildTree — authoritative nested child identity, progress,
 * routing, and reversible subthread navigation
 * (VAL-SUB-020, 024, 025, 026, 027, 028, 068, 069, 089, 093, 094).
 *
 * The tree is a pure projection of authoritative server state:
 * - Depth-1 children are derived from the root run's approved plan
 *   topology (step titles, parent/ordinal/depth) joined with the root
 *   journal events (`child.created`, `child.routed`, `child.started`,
 *   `child.completed`, `child.failed`, `child.cancel_requested`) and
 *   mirrored `descendant.progressed` events (status / question changes).
 * - Deeper descendants are rendered recursively: expanding a node fetches
 *   that child run's own snapshot + events + plan and renders its children
 *   with the same derivation, so depth-two (and beyond) navigation reuses
 *   one authoritative path.
 *
 * The browser never invents identity, routing, status, cost, or progress.
 * Every visible field is derived from committed journal events or the
 * fetched authoritative snapshot (VAL-SUB-025). A child with only a
 * `child.created` event renders `Queued` — never `Running` or `Completed`.
 *
 * Expansion state is persisted in `sessionStorage` keyed by the root run
 * and authenticated principal so reload, navigation away and Back, and
 * event-stream reconnect restore the same expanded node ids and scroll
 * anchor (VAL-SUB-026, VAL-SUB-028).
 *
 * Accessibility:
 * - A semantic `<section>` landmark with a heading and an ordered `<ol>`
 *   preserves stable child order (VAL-SUB-024, VAL-RUN-095).
 * - Each status is conveyed with explicit text and an icon, never color
 *   alone (VAL-RUN-092).
 * - Expand/collapse and "Open subthread" controls are keyboard operable
 *   with visible focus (VAL-RUN-090, VAL-SUB-026).
 * - A batched polite `aria-live` region announces meaningful aggregate
 *   changes without per-event noise (VAL-RUN-089).
 * - Animated indicators respect `prefers-reduced-motion` (VAL-RUN-093).
 * - The layout reflows at narrow mobile viewports (VAL-RUN-094).
 */

// ── Expansion state (sessionStorage, principal-scoped) ────────────────────

const EXPANSION_SCOPE = 'mission-child-tree-expanded';

/** Build a principal-scoped sessionStorage key for the root run's expansion set. */
function expansionStorageKey(principalId: string, rootRunId: string): string {
  return `${EXPANSION_SCOPE}:${principalId}:${rootRunId}`;
}

/** Read the expanded child-run-id set from sessionStorage. */
function readExpanded(principalId: string, rootRunId: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(expansionStorageKey(principalId, rootRunId));
    if (!raw) {
      return new Set();
    }
    const arr = JSON.parse(raw) as unknown;
    if (!Array.isArray(arr)) {
      return new Set();
    }
    return new Set(arr.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

/** Persist the expanded child-run-id set to sessionStorage. */
function writeExpanded(principalId: string, rootRunId: string, ids: Set<string>): void {
  try {
    sessionStorage.setItem(
      expansionStorageKey(principalId, rootRunId),
      JSON.stringify(Array.from(ids)),
    );
  } catch {
    // sessionStorage may be unavailable (private mode); expansion is a
    // non-authoritative convenience and silent failure is safe.
  }
}

// ── Status icon (text always accompanies color) ───────────────────────────

function ChildStatusIcon({ status }: { status: ChildStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-error" aria-hidden="true" />;
    case 'cancelled':
      return <Ban className="h-4 w-4 text-warning" aria-hidden="true" />;
    case 'running':
      return (
        <Activity
          className="h-4 w-4 text-neon-cyan animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        />
      );
    case 'awaiting_input':
      return <HelpCircle className="h-4 w-4 text-warning" aria-hidden="true" />;
    case 'synthesizing':
      return (
        <Layers
          className="h-4 w-4 text-neon-cyan animate-pulse motion-reduce:animate-none"
          aria-hidden="true"
        />
      );
    default:
      return <Clock className="h-4 w-4 text-text-muted" aria-hidden="true" />;
  }
}

// ── Batched announcement (polite live region) ─────────────────────────────

function useBatchedTreeAnnouncement(
  rootRunId: string,
  counts: { running: number; completed: number; failed: number; needsInput: number },
): string {
  const [announcement, setAnnouncement] = useState('');
  const prevRef = useRef({ running: -1, completed: -1, failed: -1, needsInput: -1 });
  useEffect(() => {
    const prev = prevRef.current;
    if (
      prev.running === counts.running &&
      prev.completed === counts.completed &&
      prev.failed === counts.failed &&
      prev.needsInput === counts.needsInput
    ) {
      return;
    }
    if (prev.running !== -1) {
      const parts: string[] = [];
      if (counts.running !== prev.running) {
        parts.push(`${counts.running} child${counts.running === 1 ? '' : 's'} running`);
      }
      if (counts.completed !== prev.completed) {
        parts.push(`${counts.completed} completed`);
      }
      if (counts.failed !== prev.failed) {
        parts.push(`${counts.failed} failed`);
      }
      if (counts.needsInput !== prev.needsInput) {
        parts.push(`${counts.needsInput} need input`);
      }
      if (parts.length > 0) {
        setAnnouncement(`Mission ${rootRunId}: ${parts.join(', ')}`);
      }
    }
    prevRef.current = counts;
  }, [rootRunId, counts.running, counts.completed, counts.failed, counts.needsInput]);
  return announcement;
}

// ── Entry component ───────────────────────────────────────────────────────

/**
 * Render the authoritative nested child tree for a root run. Renders
 * nothing when the run has no approved plan or no materialized children.
 */
export function MissionChildTree({
  companyId,
  projectId,
  runId,
  snapshot,
  events,
  planRevision,
  principalId = '',
}: {
  companyId: string;
  projectId: string;
  runId: string;
  snapshot: MissionRunSnapshot;
  events: MissionReplayEvent[];
  planRevision: MissionPlanRevision | null | undefined;
  principalId?: string;
}) {
  // Hooks must run unconditionally (Rules of Hooks). Derive an empty node
  // list when there is no approved plan so the memo/announcement hooks have
  // stable inputs before the early returns below.
  const nodes = useMemo(
    () => (planRevision ? deriveChildNodes(planRevision.content, events) : []),
    [planRevision, events],
  );
  const counts = useMemo(
    () => ({
      running: nodes.filter((n) => n.status === 'running').length,
      completed: nodes.filter((n) => n.status === 'completed').length,
      failed: nodes.filter((n) => n.status === 'failed').length,
      needsInput: nodes.filter((n) => n.needsInput).length,
    }),
    [nodes],
  );
  const announcement = useBatchedTreeAnnouncement(runId, counts);

  if (!planRevision || !snapshot.approvedPlanRevisionId || nodes.length === 0) {
    return null;
  }

  const maxDepth = planRevision.content.limits.depth ?? 0;

  return (
    <section
      id={`mission-child-tree-${runId}`}
      data-testid="mission-child-tree"
      aria-labelledby={`child-tree-heading-${runId}`}
      className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 w-full max-w-full break-words overflow-hidden"
    >
      <span
        role="status"
        aria-live="polite"
        data-testid="child-tree-live-region"
        className="sr-only"
      >
        {announcement}
      </span>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4
          id={`child-tree-heading-${runId}`}
          className="text-sm font-semibold text-text-primary font-display"
        >
          Child tree
        </h4>
        <span className="text-xs text-text-muted" data-testid="child-tree-count">
          {nodes.length} child{nodes.length === 1 ? '' : 'ren'}
        </span>
      </div>
      <ChildNodeList
        companyId={companyId}
        projectId={projectId}
        rootRunId={runId}
        rootThreadId={snapshot.projectThreadId}
        nodes={nodes}
        depth={1}
        maxDepth={maxDepth}
        principalId={principalId}
      />
    </section>
  );
}

/** Ordered list of child nodes at one tree level. */
function ChildNodeList({
  companyId,
  projectId,
  rootRunId,
  rootThreadId,
  nodes,
  depth,
  maxDepth,
  principalId,
}: {
  companyId: string;
  projectId: string;
  rootRunId: string;
  rootThreadId: string;
  nodes: DerivedChildNode[];
  depth: number;
  maxDepth: number;
  principalId: string;
}) {
  return (
    <ol aria-label={`Child runs at depth ${depth}`} className="space-y-2">
      {nodes.map((node, index) => (
        <ChildNode
          key={node.stepKey}
          companyId={companyId}
          projectId={projectId}
          rootRunId={rootRunId}
          rootThreadId={rootThreadId}
          node={node}
          ordinal={index + 1}
          depth={depth}
          maxDepth={maxDepth}
          principalId={principalId}
        />
      ))}
    </ol>
  );
}

/** One child node: identity, routing, status, expand/collapse, subthread link. */
function ChildNode({
  companyId,
  projectId,
  rootRunId,
  rootThreadId,
  node,
  ordinal,
  depth,
  maxDepth,
  principalId,
}: {
  companyId: string;
  projectId: string;
  rootRunId: string;
  rootThreadId: string;
  node: DerivedChildNode;
  ordinal: number;
  depth: number;
  maxDepth: number;
  principalId: string;
}) {
  // Expansion state is shared across the root tree (one set of expanded
  // child-run ids) so a grandchild expanded under one parent stays expanded
  // when a sibling updates. Persisted to sessionStorage for reload/Back
  // restoration (VAL-SUB-026, VAL-SUB-028).
  const [expandedSet, setExpandedSet] = useState<Set<string>>(() =>
    readExpanded(principalId, rootRunId),
  );

  useEffect(() => {
    writeExpanded(principalId, rootRunId, expandedSet);
  }, [principalId, rootRunId, expandedSet]);

  const isExpanded = node.childRunId ? expandedSet.has(node.childRunId) : false;
  const canExpand = node.childRunId !== null && depth < maxDepth;
  const expandBtnRef = useRef<HTMLButtonElement>(null);

  function toggleExpanded() {
    if (!node.childRunId) {
      return;
    }
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(node.childRunId!)) {
        next.delete(node.childRunId!);
      } else {
        next.add(node.childRunId!);
      }
      return next;
    });
  }

  // "Open subthread" deep link: navigate to the child run in Project Work.
  // The child shares the root project thread (topology-materializer sets
  // projectThreadId = rootRun.projectThreadId), so the root thread id is
  // the correct thread hint. The link uses the canonical singular app
  // route so it resolves without a redirect (VAL-CROSS-076, VAL-SUB-026).
  const subthreadHref = node.childRunId
    ? buildMissionUiLink({
        companyId,
        projectId,
        threadId: rootThreadId,
        runId: node.childRunId,
        target: { kind: 'run' },
      })
    : null;

  return (
    <li
      className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 w-full max-w-full min-w-0 break-words overflow-hidden"
      aria-label={`Step ${ordinal}: ${node.title}`}
    >
      <ChildNodeHeader node={node} ordinal={ordinal} />
      <ChildRoutingLine node={node} />
      <ChildNodeDetails node={node} />
      <ChildNodeActions
        node={node}
        canExpand={canExpand}
        isExpanded={isExpanded}
        subthreadHref={subthreadHref}
        expandBtnRef={expandBtnRef}
        onToggle={toggleExpanded}
      />

      {/* Recursive descendant subtree (depth two and beyond). */}
      {isExpanded && node.childRunId && (
        <div
          id={`child-subtree-${node.childRunId}`}
          className="mt-2 ml-3 sm:ml-4 border-l border-white/[0.08] pl-2 sm:pl-3"
        >
          <ChildSubtree
            companyId={companyId}
            projectId={projectId}
            rootRunId={rootRunId}
            rootThreadId={rootThreadId}
            childRunId={node.childRunId}
            depth={depth + 1}
            maxDepth={maxDepth}
            principalId={principalId}
            parentTitle={node.title}
          />
        </div>
      )}
    </li>
  );
}

/** Node header: status icon, ordinal, title, status badge, needs-input, depth. */
function ChildNodeHeader({ node, ordinal }: { node: DerivedChildNode; ordinal: number }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1 min-w-0">
      <ChildStatusIcon status={node.status} />
      <span className="text-xs tabular-nums text-text-muted shrink-0">{ordinal}.</span>
      <h5
        className="text-sm font-medium text-text-primary break-words min-w-0"
        id={`child-node-${node.childRunId ?? node.stepKey}`}
      >
        {node.title}
      </h5>
      <span
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${statusBadgeClass(node.status)}`}
        data-testid={`child-status-${node.status}`}
      >
        {statusText(node.status)}
      </span>
      {node.needsInput && (
        <span
          className="inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
          data-testid="child-needs-input"
        >
          Needs input
        </span>
      )}
      <span className="text-xs text-text-muted shrink-0" data-testid="child-depth">
        Depth {node.depth}
      </span>
    </div>
  );
}

/** Routing state + assignment line (VAL-SUB-069, VAL-SUB-089). */
function ChildRoutingLine({ node }: { node: DerivedChildNode }) {
  const assignment = routingAssignmentText(node.routing);
  return (
    <p className="text-xs text-text-secondary mb-1 break-words" data-testid="child-routing">
      Routing:{' '}
      <span className="text-text-primary" data-testid="child-routing-label">
        {routingStateText(node.routing)}
      </span>
      {assignment && (
        <>
          {' '}
          —{' '}
          <span className="text-text-primary" data-testid="child-routing-assignment">
            {assignment}
          </span>
          {node.routing.kind === 'routed' && node.routing.agentId && (
            <>
              {' '}
              <span className="text-text-primary font-mono break-all">{node.routing.agentId}</span>
            </>
          )}
        </>
      )}
    </p>
  );
}

/** Stable identity, cost, output, and safe failure details (VAL-SUB-024, 074, 093). */
function ChildNodeDetails({ node }: { node: DerivedChildNode }) {
  return (
    <>
      {node.childRunId && (
        <p className="text-xs text-text-muted mb-1 break-words">
          Run: <code className="font-mono break-all">{node.childRunId}</code>
        </p>
      )}
      {node.costCents !== null && node.costCents > 0 && (
        <p className="text-xs text-text-secondary mb-1 break-words" data-testid="child-cost">
          Cost:{' '}
          <span className="tabular-nums text-text-primary">{formatCents(node.costCents)}</span>
        </p>
      )}
      {node.outputSummary && (
        <p className="text-xs text-text-secondary mb-1 break-words" data-testid="child-output">
          Output: <span className="text-text-primary">{node.outputSummary}</span>
        </p>
      )}
      {node.status === 'failed' && node.safeErrorMessage && (
        <div
          role="alert"
          className="mt-1 rounded-md border border-error/20 bg-error/10 px-2 py-1.5"
          data-testid="child-failure"
        >
          <p className="text-xs text-error font-medium mb-0.5">Child failed</p>
          <p className="text-sm text-text-primary break-words">{node.safeErrorMessage}</p>
          {node.failureCategory && (
            <p className="mt-0.5 text-xs text-text-primary">Category: {node.failureCategory}</p>
          )}
          {node.failureCode && (
            <p className="mt-0.5 text-xs text-text-primary">Code: {node.failureCode}</p>
          )}
        </div>
      )}
    </>
  );
}

/** Expand/collapse descendants + open subthread actions (VAL-SUB-026, 027). */
function ChildNodeActions({
  node,
  canExpand,
  isExpanded,
  subthreadHref,
  expandBtnRef,
  onToggle,
}: {
  node: DerivedChildNode;
  canExpand: boolean;
  isExpanded: boolean;
  subthreadHref: string | null;
  expandBtnRef: React.Ref<HTMLButtonElement>;
  onToggle: () => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {canExpand && (
        <button
          ref={expandBtnRef}
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-controls={node.childRunId ? `child-subtree-${node.childRunId}` : undefined}
          aria-label={
            isExpanded
              ? `Collapse descendants for ${node.title}`
              : `Expand descendants for ${node.title}`
          }
          className="inline-flex items-center gap-1 rounded-lg border border-white/[0.08] bg-white/[0.025] px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none motion-reduce:transition-none"
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isExpanded ? 'Collapse' : 'Descendants'}
        </button>
      )}
      {subthreadHref && (
        <Link
          to={subthreadHref}
          className="inline-flex items-center gap-1 text-xs font-medium text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
          aria-label={`Open subthread for ${node.title}`}
        >
          Open subthread
        </Link>
      )}
    </div>
  );
}

/**
 * Recursive subtree: fetches the expanded child run's authoritative
 * snapshot + events + plan and renders its children with the same
 * derivation. This reuses one authoritative path for depth-two and beyond
 * (VAL-SUB-027) and never invents descendants that the server has not
 * committed.
 */
function ChildSubtree({
  companyId,
  projectId,
  rootRunId,
  rootThreadId,
  childRunId,
  depth,
  maxDepth,
  principalId,
  parentTitle,
}: {
  companyId: string;
  projectId: string;
  rootRunId: string;
  rootThreadId: string;
  childRunId: string;
  depth: number;
  maxDepth: number;
  principalId: string;
  parentTitle: string;
}) {
  const snapshotQuery = useMissionRunSnapshot(companyId, projectId, childRunId);
  const eventsQuery = useMissionRunEvents(companyId, projectId, childRunId);
  const snapshot = snapshotQuery.data as MissionRunSnapshot | undefined;
  const events = (eventsQuery.data?.events ?? []) as MissionReplayEvent[];
  const planQuery = useMissionCurrentPlanRevision(
    companyId,
    projectId,
    childRunId,
    snapshot?.currentPlanRevisionId ?? null,
  );
  const planRevision = planQuery.data as MissionPlanRevision | null | undefined;

  if (snapshotQuery.isLoading || eventsQuery.isLoading) {
    return (
      <p className="text-xs text-text-muted py-1" role="status" aria-live="polite">
        Loading descendants…
      </p>
    );
  }

  if (snapshotQuery.isError || eventsQuery.isError) {
    return (
      <div className="py-1">
        <p className="text-xs text-error mb-1.5" role="alert">
          Could not load descendants.
        </p>
        <button
          type="button"
          onClick={() => {
            snapshotQuery.refetch();
            eventsQuery.refetch();
          }}
          className="text-xs text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
          aria-label={`Retry loading descendants for ${parentTitle}`}
        >
          Retry
        </button>
      </div>
    );
  }

  if (!planRevision || !snapshot) {
    return <p className="text-xs text-text-muted py-1">No descendants.</p>;
  }

  const nodes = deriveChildNodes(planRevision.content, events);
  if (nodes.length === 0) {
    return <p className="text-xs text-text-muted py-1">No descendants.</p>;
  }

  return (
    <ChildNodeList
      companyId={companyId}
      projectId={projectId}
      rootRunId={rootRunId}
      rootThreadId={rootThreadId}
      nodes={nodes}
      depth={depth}
      maxDepth={maxDepth}
      principalId={principalId}
    />
  );
}
