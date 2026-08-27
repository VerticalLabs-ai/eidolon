import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  useMissionRunSnapshot,
  useMissionRunEvents,
  useMissionCurrentPlanRevision,
  useMissionRunChildren,
} from '@/lib/hooks';
import type {
  MissionPlanRevision,
  MissionRunSnapshot,
  MissionReplayEvent,
  MissionChildTreeNode,
} from '@/lib/api';
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
  RefreshCw,
} from 'lucide-react';
import {
  deriveChildNodes,
  statusText,
  routingStateText,
  routingAssignmentText,
  statusBadgeClass,
  formatCents,
  isTerminalStatus,
  isLimitFailure,
  limitFailureLabel,
  billingIdentityText,
  parentPolicyConsequenceText,
  aggregateChildCostCents,
  type ChildStatus,
  type DerivedChildNode,
} from './mission-child-tree-helpers';
import { MissionSubtreeCancelDialog } from './MissionSubtreeCancelDialog';
import { MissionCostBreakdown } from './MissionCostBreakdown';

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

// ── Return-focus target (VAL-SUB-105) ─────────────────────────────────────
//
// When a user opens a child subthread and later returns via Back, focus
// must move to the originating child link, or the nearest surviving parent
// heading if the origin is gone. The origin is recorded in sessionStorage
// keyed by root run + principal so it survives reload/navigation.

const RETURN_SCOPE = 'mission-child-tree-return';

interface ReturnTarget {
  originChildRunId: string;
  fallbackHeadingId: string | null;
}

function returnStorageKey(principalId: string, rootRunId: string): string {
  return `${RETURN_SCOPE}:${principalId}:${rootRunId}`;
}

/** Record the originating child for return-focus before subthread navigation. */
function recordReturnTarget(
  principalId: string,
  rootRunId: string,
  originChildRunId: string,
  fallbackHeadingId: string | null,
): void {
  try {
    sessionStorage.setItem(
      returnStorageKey(principalId, rootRunId),
      JSON.stringify({ originChildRunId, fallbackHeadingId } satisfies ReturnTarget),
    );
  } catch {
    // sessionStorage may be unavailable; return-focus is a convenience.
  }
}

/** Read and clear the pending return-focus target, if any. */
function readReturnTarget(principalId: string, rootRunId: string): ReturnTarget | null {
  try {
    const raw = sessionStorage.getItem(returnStorageKey(principalId, rootRunId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<ReturnTarget>;
    if (typeof parsed.originChildRunId === 'string') {
      return {
        originChildRunId: parsed.originChildRunId,
        fallbackHeadingId:
          typeof parsed.fallbackHeadingId === 'string' ? parsed.fallbackHeadingId : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove the pending return-focus target after it has been consumed. */
function clearReturnTarget(principalId: string, rootRunId: string): void {
  try {
    sessionStorage.removeItem(returnStorageKey(principalId, rootRunId));
  } catch {
    // sessionStorage may be unavailable; silent failure is safe.
  }
}

/** Escape a string for safe use in a CSS attribute selector. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

// ── Status icon (text always accompanies color) ───────────────────────────

/** Format an ISO timestamp as a readable date-time string (VAL-SUB-074). */
function formatTime(iso: string | null): string {
  if (!iso) {
    return '';
  }
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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
        parts.push(`${counts.running} child${counts.running === 1 ? '' : 'ren'} running`);
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
  rootBillingAgentId = null,
}: {
  companyId: string;
  projectId: string;
  runId: string;
  snapshot: MissionRunSnapshot;
  events: MissionReplayEvent[];
  planRevision: MissionPlanRevision | null | undefined;
  principalId?: string;
  /** Root initiating billing-agent id. Ephemeral children bill this agent
   *  (VAL-SUB-101). Null when unknown; the breakdown still reconciles root
   *  totals. */
  rootBillingAgentId?: string | null;
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
  const childSettledCents = useMemo(() => aggregateChildCostCents(nodes), [nodes]);
  const sectionRef = useRef<HTMLElement>(null);

  // Server-authoritative child tree from the /children endpoint
  // (VAL-M1-015..036). The hook fetches the tree and invalidates on
  // child.* SSE events (VAL-M1-027, VAL-M1-028).
  const childrenQuery = useMissionRunChildren(companyId, projectId, runId, {
    enabled: !!runId,
  });

  // Return-focus restoration (VAL-SUB-105): after Back navigation, move
  // focus to the originating child link, or the nearest surviving parent
  // heading if the origin is gone. The target is consumed once.
  //
  // Two triggers:
  // 1. Mount / nodes-arrival — handles full page reload and fresh mount
  //    after Back (the section may not be ready immediately, so retries
  //    cover async snapshot/event fetches).
  // 2. `popstate` — handles SPA Back/Forward where the root card stays
  //    mounted (the run list keeps it in the DOM) and no remount occurs.
  useEffect(() => {
    const target = readReturnTarget(principalId, runId);
    if (!target) {
      return;
    }
    const section = sectionRef.current;
    if (!section) {
      return;
    }
    let cancelled = false;
    const originSelector = `[data-return-origin="${cssEscape(target.originChildRunId)}"]`;
    const attempt = (retries: number) => {
      if (cancelled) {
        return;
      }
      const link = section.querySelector<HTMLElement>(originSelector);
      if (link) {
        link.focus();
        if (typeof link.scrollIntoView === 'function') {
          link.scrollIntoView({ block: 'center' });
        }
        clearReturnTarget(principalId, runId);
        return;
      }
      if (retries > 0) {
        setTimeout(() => attempt(retries - 1), 60);
        return;
      }
      // Origin gone: focus the nearest surviving parent heading, then the
      // tree heading as a final fallback (VAL-SUB-105).
      const fb = target.fallbackHeadingId
        ? section.querySelector<HTMLElement>(`#${cssEscape(target.fallbackHeadingId)}`)
        : null;
      const heading =
        fb ?? section.querySelector<HTMLElement>(`#child-tree-heading-${cssEscape(runId)}`);
      heading?.focus();
      clearReturnTarget(principalId, runId);
    };
    attempt(6);
    return () => {
      cancelled = true;
    };
  }, [principalId, runId, nodes.length]);

  // SPA Back/Forward: the root card stays mounted in the run list, so the
  // mount effect above does not re-run. Listen for `popstate` to restore
  // focus synchronously (the tree is already rendered at that point).
  useEffect(() => {
    function onPopState() {
      const target = readReturnTarget(principalId, runId);
      if (!target) {
        return;
      }
      const section = sectionRef.current;
      if (!section) {
        return;
      }
      const link = section.querySelector<HTMLElement>(
        `[data-return-origin="${cssEscape(target.originChildRunId)}"]`,
      );
      if (link) {
        link.focus();
        if (typeof link.scrollIntoView === 'function') {
          link.scrollIntoView({ block: 'center' });
        }
        clearReturnTarget(principalId, runId);
        return;
      }
      const fb = target.fallbackHeadingId
        ? section.querySelector<HTMLElement>(`#${cssEscape(target.fallbackHeadingId)}`)
        : null;
      const heading =
        fb ?? section.querySelector<HTMLElement>(`#child-tree-heading-${cssEscape(runId)}`);
      heading?.focus();
      clearReturnTarget(principalId, runId);
    }
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [principalId, runId]);

  // Loading state: show a skeleton while the /children endpoint fetches
  // (VAL-M1-031). The tree does not flash empty content before data arrives.
  if (childrenQuery.isLoading) {
    return (
      <section
        data-testid="mission-child-tree"
        aria-busy="true"
        className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"
      >
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>Loading child tree…</span>
        </div>
      </section>
    );
  }

  // Error state: show an error message with a retry button (VAL-M1-032).
  if (childrenQuery.isError) {
    return (
      <section
        data-testid="mission-child-tree"
        className="mt-3 rounded-xl border border-error/20 bg-error/5 p-3"
      >
        <div className="flex items-center gap-2 text-sm text-error">
          <XCircle className="h-4 w-4" aria-hidden="true" />
          <span>Failed to load child tree</span>
          <button
            type="button"
            onClick={() => childrenQuery.refetch()}
            className="ml-auto inline-flex items-center gap-1 rounded-lg border border-error/30 px-2 py-1 text-xs font-medium text-error transition-colors hover:bg-error/10 focus-visible:ring-2 focus-visible:ring-error/40 focus-visible:outline-none"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Retry
          </button>
        </div>
      </section>
    );
  }

  // Empty state: show "No child runs" when the run has no children
  // (VAL-M1-033). The server tree has an empty children array.
  if (nodes.length === 0 && childrenQuery.data && childrenQuery.data.children.length === 0) {
    return (
      <section
        data-testid="mission-child-tree"
        className="mt-3 rounded-xl border border-white/[0.08] bg-white/[0.025] p-3"
      >
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Layers className="h-4 w-4" aria-hidden="true" />
          <span>No child runs</span>
        </div>
      </section>
    );
  }

  if (!planRevision || !snapshot.approvedPlanRevisionId || nodes.length === 0) {
    return null;
  }

  const maxDepth = planRevision.content.limits.depth ?? 0;
  const rootHeadingId = `child-tree-heading-${runId}`;

  return (
    <section
      ref={sectionRef}
      id={`mission-child-tree-${runId}`}
      data-testid="mission-child-tree"
      aria-labelledby={rootHeadingId}
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
          id={rootHeadingId}
          tabIndex={-1}
          className="text-sm font-semibold text-text-primary font-display focus-visible:outline-none"
        >
          Child tree
        </h4>
        <span className="text-xs text-text-muted" data-testid="child-tree-count">
          {nodes.length} child{nodes.length === 1 ? '' : 'ren'}
        </span>
      </div>
      {/* Root cost reconciliation with billing identities (VAL-SUB-101). */}
      <MissionCostBreakdown snapshot={snapshot} childSettledCents={childSettledCents} />
      <ChildNodeList
        companyId={companyId}
        projectId={projectId}
        rootRunId={runId}
        rootThreadId={snapshot.projectThreadId}
        nodes={nodes}
        depth={1}
        maxDepth={maxDepth}
        principalId={principalId}
        rootBillingAgentId={rootBillingAgentId}
        partialResultPolicy={snapshot.partialResultPolicy}
        parentHeadingId={rootHeadingId}
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
  rootBillingAgentId,
  partialResultPolicy,
  parentHeadingId,
}: {
  companyId: string;
  projectId: string;
  rootRunId: string;
  rootThreadId: string;
  nodes: DerivedChildNode[];
  depth: number;
  maxDepth: number;
  principalId: string;
  rootBillingAgentId: string | null;
  partialResultPolicy: string;
  parentHeadingId: string;
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
          rootBillingAgentId={rootBillingAgentId}
          partialResultPolicy={partialResultPolicy}
          parentHeadingId={parentHeadingId}
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
  rootBillingAgentId,
  partialResultPolicy,
  parentHeadingId,
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
  rootBillingAgentId: string | null;
  partialResultPolicy: string;
  parentHeadingId: string;
}) {
  // Stable heading id for this node, used as the focus-return fallback for
  // its own descendants (VAL-SUB-105) and for scroll targeting.
  const headingId = `child-node-${node.childRunId ?? node.stepKey}`;
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

  // Authoritative child snapshot: provides state_version for stale-action
  // protection on subtree cancellation (VAL-SUB-083), subthreadId for the
  // projection-recovering state (VAL-SUB-103), and resultCompleteness /
  // terminalAt / actualCostCents for authoritative detail rendering
  // (VAL-SUB-074, VAL-SUB-100). The hook is disabled when no child run id
  // exists so unmaterialized shells do not fetch.
  const childSnapshotQuery = useMissionRunSnapshot(
    companyId,
    projectId,
    node.childRunId ?? undefined,
  );
  const childSnapshot = childSnapshotQuery.data as MissionRunSnapshot | undefined;

  const [cancelOpen, setCancelOpen] = useState(false);

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

  // Subthread projection recovery (VAL-SUB-103): when the child exists but
  // has no usable subthread projection, show a bounded recovering state
  // instead of the normal open-subthread link. The link reappears once the
  // projection is repaired (snapshot refetch yields a non-null subthreadId).
  const subthreadRecovering =
    !!node.childRunId && !!childSnapshot && (childSnapshot.subthreadId ?? null) === null;

  // Subtree cancellation (VAL-SUB-096): only authorized, nonterminal children
  // with a materialized run id expose a direct subtree cancel control.
  const canCancelSubtree =
    !!node.childRunId && !isTerminalStatus(node.status) && !subthreadRecovering;

  return (
    <li
      className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 w-full max-w-full min-w-0 break-words overflow-hidden"
      aria-label={`Step ${ordinal}: ${node.title}`}
    >
      <ChildNodeHeader node={node} ordinal={ordinal} depth={depth} headingId={headingId} />
      <ChildRoutingLine node={node} />
      <ChildNodeDetails
        node={node}
        partialResultPolicy={partialResultPolicy}
        childSnapshot={childSnapshot}
        billingIdentity={billingIdentityText(node.routing, rootBillingAgentId)}
      />
      <ChildNodeActions
        node={node}
        canExpand={canExpand}
        isExpanded={isExpanded}
        subthreadHref={subthreadHref}
        subthreadRecovering={subthreadRecovering}
        canCancelSubtree={canCancelSubtree}
        expandBtnRef={expandBtnRef}
        onToggle={toggleExpanded}
        onCancelSubtree={() => setCancelOpen(true)}
        principalId={principalId}
        rootRunId={rootRunId}
        parentHeadingId={parentHeadingId}
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
            rootBillingAgentId={rootBillingAgentId}
            partialResultPolicy={partialResultPolicy}
            parentHeadingId={headingId}
          />
        </div>
      )}

      {/* Subtree cancellation confirmation (VAL-SUB-096, VAL-SUB-083). */}
      {node.childRunId && (
        <MissionSubtreeCancelDialog
          companyId={companyId}
          projectId={projectId}
          runId={node.childRunId}
          childTitle={node.title}
          open={cancelOpen}
          onClose={() => setCancelOpen(false)}
          onRefreshChild={() => childSnapshotQuery.refetch()}
        />
      )}
    </li>
  );
}

/** Node header: status icon, ordinal, title, status badge, needs-input, depth.
 * The heading level reflects tree depth (h5 at depth 1, h6 at depth 2) so
 * the document outline mirrors the nesting (VAL-SUB-075). */
function ChildNodeHeader({
  node,
  ordinal,
  depth,
  headingId,
}: {
  node: DerivedChildNode;
  ordinal: number;
  depth: number;
  headingId: string;
}) {
  // Heading level: root tree is h4; depth 1 → h5, depth 2 → h6, capped at h6.
  const level = Math.min(4 + depth, 6);
  const HeadingTag = `h${level}` as 'h5' | 'h6';
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mb-1 min-w-0">
      <ChildStatusIcon status={node.status} />
      <span className="text-xs tabular-nums text-text-muted shrink-0">{ordinal}.</span>
      <HeadingTag
        className="text-sm font-medium text-text-primary break-words min-w-0 focus-visible:outline-none"
        id={headingId}
        tabIndex={-1}
      >
        {node.title}
      </HeadingTag>
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
function ChildNodeDetails({
  node,
  partialResultPolicy,
  childSnapshot,
  billingIdentity,
}: {
  node: DerivedChildNode;
  partialResultPolicy: string;
  childSnapshot?: MissionRunSnapshot;
  billingIdentity: { label: string; agentId: string | null } | null;
}) {
  // Authoritative timing/cost from the child snapshot when available; fall
  // back to event-derived cost (VAL-SUB-074, VAL-SUB-073).
  const terminalAt = childSnapshot?.terminalAt ?? null;
  const actualCostCents =
    childSnapshot?.actualCostCents ?? (node.costCents !== null ? node.costCents : null);
  const resultCompleteness = childSnapshot?.resultCompleteness ?? null;
  const showTerminalTime = terminalAt !== null && isTerminalStatus(node.status);

  return (
    <>
      {node.childRunId && (
        <p className="text-xs text-text-muted mb-1 break-words">
          Run: <code className="font-mono break-all">{node.childRunId}</code>
        </p>
      )}
      {/* Billing identity (VAL-SUB-101). */}
      {billingIdentity && (
        <p className="text-xs text-text-secondary mb-1 break-words" data-testid="child-billing">
          {billingIdentity.label}
          {billingIdentity.agentId && (
            <>
              {' '}
              <span className="font-mono break-all text-text-primary">
                {billingIdentity.agentId}
              </span>
            </>
          )}
        </p>
      )}
      {actualCostCents !== null && actualCostCents > 0 && (
        <p className="text-xs text-text-secondary mb-1 break-words" data-testid="child-cost">
          Cost:{' '}
          <span className="tabular-nums text-text-primary">{formatCents(actualCostCents)}</span>
        </p>
      )}
      {/* Authoritative timing for terminal children (VAL-SUB-074). */}
      {showTerminalTime && <ChildTerminalTime status={node.status} terminalAt={terminalAt!} />}
      {node.outputSummary && (
        <p className="text-xs text-text-secondary mb-1 break-words" data-testid="child-output">
          Output: <span className="text-text-primary">{node.outputSummary}</span>
        </p>
      )}
      {/* Partial completion is authoritative (VAL-SUB-100). */}
      {node.status === 'completed' && resultCompleteness === 'partial' && (
        <p
          className="text-xs text-warning mb-1 break-words"
          role="status"
          data-testid="child-partial-result"
        >
          Completed with partial results
        </p>
      )}
      {/* Safe failure details without secrets (VAL-SUB-074). */}
      {node.status === 'failed' && node.safeErrorMessage && (
        <ChildFailureDetail node={node} partialResultPolicy={partialResultPolicy} />
      )}
    </>
  );
}

/** Authoritative terminal timestamp for a terminal child (VAL-SUB-074). */
function ChildTerminalTime({ status, terminalAt }: { status: ChildStatus; terminalAt: string }) {
  const label =
    status === 'failed' ? 'Failed at' : status === 'cancelled' ? 'Cancelled at' : 'Completed at';
  return (
    <p className="text-xs text-text-secondary mb-1 break-words" data-testid="child-terminal-time">
      {label}: <time dateTime={terminalAt}>{formatTime(terminalAt)}</time>
    </p>
  );
}

/** Safe failure drill-down: limit label, category/code, policy consequence,
 * and root-retry direction. No prompts, credentials, or provider bodies
 * (VAL-SUB-074). Terminal children expose no Retry control. */
function ChildFailureDetail({
  node,
  partialResultPolicy,
}: {
  node: DerivedChildNode;
  partialResultPolicy: string;
}) {
  const consequence = parentPolicyConsequenceText(partialResultPolicy, node);
  return (
    <div
      role="alert"
      className="mt-1 rounded-md border border-error/20 bg-error/10 px-2 py-1.5"
      data-testid="child-failure"
    >
      <p className="text-xs text-error font-medium mb-0.5">Child failed</p>
      {isLimitFailure(node) && (
        <p className="text-xs text-error font-medium mb-0.5" data-testid="child-limit-label">
          {limitFailureLabel(node)}
        </p>
      )}
      <p className="text-sm text-text-primary break-words">{node.safeErrorMessage}</p>
      {node.failureCategory && (
        <p className="mt-0.5 text-xs text-text-primary">Category: {node.failureCategory}</p>
      )}
      {node.failureCode && (
        <p className="mt-0.5 text-xs text-text-primary">Code: {node.failureCode}</p>
      )}
      {consequence && (
        <p className="mt-0.5 text-xs text-text-secondary" data-testid="child-policy-consequence">
          {consequence}
        </p>
      )}
      <p className="mt-0.5 text-xs text-text-secondary" data-testid="child-retry-direction">
        To recover, use Retry Mission on the root run.
      </p>
    </div>
  );
}

/** Expand/collapse descendants + open subthread + cancel subtree actions
 * (VAL-SUB-026, 027, 096, 103, 105). */
function ChildNodeActions({
  node,
  canExpand,
  isExpanded,
  subthreadHref,
  subthreadRecovering,
  canCancelSubtree,
  expandBtnRef,
  onToggle,
  onCancelSubtree,
  principalId,
  rootRunId,
  parentHeadingId,
}: {
  node: DerivedChildNode;
  canExpand: boolean;
  isExpanded: boolean;
  subthreadHref: string | null;
  subthreadRecovering: boolean;
  canCancelSubtree: boolean;
  expandBtnRef: React.Ref<HTMLButtonElement>;
  onToggle: () => void;
  onCancelSubtree: () => void;
  principalId: string;
  rootRunId: string;
  parentHeadingId: string;
}) {
  // Record the originating child before subthread navigation so Back can
  // restore focus to this link (or the nearest surviving parent heading)
  // (VAL-SUB-105).
  function handleOpenSubthread() {
    if (node.childRunId) {
      recordReturnTarget(principalId, rootRunId, node.childRunId, parentHeadingId);
    }
  }

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
      {subthreadRecovering ? (
        <span
          className="inline-flex items-center gap-1 text-xs font-medium text-warning"
          role="status"
          aria-live="polite"
          data-testid="child-subthread-recovering"
        >
          <RefreshCw className="h-3.5 w-3.5 motion-reduce:animate-none" aria-hidden="true" />
          Recovering subthread…
        </span>
      ) : (
        subthreadHref &&
        node.childRunId && (
          <Link
            to={subthreadHref}
            onClick={handleOpenSubthread}
            data-return-origin={node.childRunId}
            className="inline-flex items-center gap-1 text-xs font-medium text-accent underline hover:text-accent/80 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none rounded"
            aria-label={`Open subthread for ${node.title}`}
          >
            Open subthread
          </Link>
        )
      )}
      {canCancelSubtree && (
        <button
          type="button"
          onClick={onCancelSubtree}
          aria-label={`Cancel subtree for ${node.title}`}
          className="inline-flex items-center gap-1 rounded-lg border border-error/30 bg-error/10 px-2.5 py-1 text-xs font-medium text-error transition-colors hover:bg-error/20 focus-visible:ring-2 focus-visible:ring-error/40 focus-visible:outline-none motion-reduce:transition-none"
        >
          <Ban className="h-3.5 w-3.5" aria-hidden="true" />
          Cancel subtree
        </button>
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
  rootBillingAgentId,
  partialResultPolicy,
  parentHeadingId,
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
  rootBillingAgentId: string | null;
  partialResultPolicy: string;
  parentHeadingId: string;
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
      rootBillingAgentId={rootBillingAgentId}
      partialResultPolicy={partialResultPolicy}
      parentHeadingId={parentHeadingId}
    />
  );
}
