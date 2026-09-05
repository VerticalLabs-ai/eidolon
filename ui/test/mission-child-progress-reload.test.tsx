import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionChildTree } from '../src/components/projects/MissionChildTree';
import type {
  MissionPlanRevision,
  MissionPlanContent,
  MissionRunSnapshot,
  MissionReplayEvent,
} from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────
//
// VAL-CROSS-027: child progress survives reload. These tests render the
// authoritative child tree from durable plan + events + snapshot fixtures,
// then simulate a browser reload (unmount + remount with the *same*
// authoritative fixtures) and assert that statuses, costs, failures,
// completed output, lineage, and subthread links are reconstructed without
// resetting progress, losing state, or duplicating child shells.

const mocks = vi.hoisted(() => ({
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useMissionCurrentPlanRevision: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/hooks');
  return {
    ...actual,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionRunEvents: mocks.useMissionRunEvents,
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
  };
});

vi.mock('@/lib/auth', () => ({
  useSession: () => ({
    isPending: false,
    data: {
      user: {
        id: 'dev-user-000',
        name: 'Local Operator',
        email: 'local@eidolon.dev',
        image: '',
        role: 'admin',
      },
      session: {
        id: 'local-dev-session',
        userId: 'dev-user-000',
        activeOrganizationId: null,
        activeOrganizationRole: 'admin',
      },
    },
  }),
  isLocalTrustedAuth: () => false,
  CLERK_PUBLISHABLE_KEY: '',
}));

// ── Fixtures ──────────────────────────────────────────────────────────────

const COMPANY = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const THREAD = '33333333-3333-4333-8333-333333333333';
const ROOT_RUN = '44444444-4444-4444-8444-444444444444';
const CHILD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const GRANDCHILD = '55555555-5555-4555-8555-555555555555';
const AGENT_ID = '66666666-6666-4666-8666-666666666666';

function rootStep(
  overrides: Partial<MissionPlanContent['steps'][number]> = {},
): MissionPlanContent['steps'][number] {
  return {
    stepKey: 'root-step',
    parentStepKey: null,
    childOrdinal: 0,
    nodeKind: 'root',
    title: 'Root step',
    description: 'Root execution.',
    dependencies: [],
    inputBindings: [],
    routing: { kind: 'concreteAgent', executingAgentId: AGENT_ID },
    toolAllowlist: [],
    replayClass: 'read_only' as const,
    sideEffecting: false,
    expectedOutputs: ['out'],
    evidenceRequirements: { citationsRequired: false },
    completionCriteria: 'done',
    budgetCents: 100,
    limits: {},
    ...overrides,
  };
}

function childStep(
  stepKey: string,
  parentStepKey: string,
  ordinal: number,
  title: string,
  overrides: Partial<MissionPlanContent['steps'][number]> = {},
): MissionPlanContent['steps'][number] {
  return {
    stepKey,
    parentStepKey,
    childOrdinal: ordinal,
    nodeKind: 'child',
    title,
    description: `${title} description.`,
    dependencies: [],
    inputBindings: [],
    routing: {
      kind: 'company_agent' as const,
      executingAgentId: AGENT_ID,
    },
    toolAllowlist: [],
    replayClass: 'read_only' as const,
    sideEffecting: false,
    expectedOutputs: ['childOut'],
    evidenceRequirements: { citationsRequired: false },
    completionCriteria: 'done',
    budgetCents: 200,
    limits: {},
    ...overrides,
  };
}

function planContent(steps: MissionPlanContent['steps'][number][]): MissionPlanContent {
  return {
    schemaVersion: 1,
    objective: 'Multi-step mission.',
    steps,
    synthesis: {
      instructions: 'Merge outputs.',
      declaredInputs: [],
      declaredOutput: 'final',
      evidenceRequirements: { citationsRequired: false },
      completionCriteria: 'all done',
      budgetCents: 100,
    },
    planningBudgetCents: 50,
    partialResultPolicy: 'require_all',
    limits: {
      steps: 12,
      durationSeconds: 2700,
      providerCalls: 48,
      totalTokens: 300000,
      outputBytes: 8388608,
      costCents: 5000,
      depth: 2,
      fanOut: 4,
      descendants: 12,
    },
  };
}

function revision(content: MissionPlanContent): MissionPlanRevision {
  return {
    id: 'plan-rev-1',
    revision: 1,
    status: 'approved',
    contentHash: 'h'.repeat(64),
    parentRevisionId: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    content,
  };
}

function evt(sequence: number, type: string, payload: Record<string, unknown>): MissionReplayEvent {
  return {
    sequence,
    type,
    schemaVersion: 1,
    payload,
    commandId: null,
    actorType: 'system',
    actorId: null,
    traceId: null,
    occurredAt: '2026-08-23T10:01:00.000Z',
  };
}

function rootSnapshot(overrides: Partial<MissionRunSnapshot> = {}): MissionRunSnapshot {
  return {
    id: ROOT_RUN,
    companyId: COMPANY,
    projectId: PROJECT,
    projectThreadId: THREAD,
    rootRunId: ROOT_RUN,
    parentRunId: null,
    retryOfRunId: null,
    depth: 0,
    childOrdinal: null,
    routingKind: 'company_agent',
    status: 'running',
    stateVersion: 8,
    lastEventSequence: 20,
    resolvedMode: 'deep_work',
    modeProfileId: null,
    policySnapshotId: 'pol-1',
    policyContentHash: 'p'.repeat(64),
    requestContentHash: 'r'.repeat(64),
    currentQuestionSetId: null,
    currentPlanRevisionId: 'plan-rev-1',
    approvedPlanRevisionId: 'plan-rev-1',
    waitingFromStatus: null,
    partialResultPolicy: 'require_all',
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    cancellationDeadlineAt: null,
    failureCategory: null,
    failureCode: null,
    safeErrorMessage: null,
    startedAt: '2026-08-23T10:01:00.000Z',
    terminalAt: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:05:00.000Z',
    attemptCount: 1,
    providerCallCount: 2,
    descendantCount: 3,
    inputTokens: 1000,
    outputTokens: 500,
    outputBytes: 2048,
    actualCostCents: 300,
    budget: {
      reservedCents: 5000,
      settledCents: 300,
      releasedCents: 0,
      costCentsCeiling: 5000,
      actualCostCents: 300,
    },
    childSummary: { running: 2, completed: 0, failed: 0, cancelled: 0, total: 2 },
    artifacts: [],
    links: {
      ui: `/company/${COMPANY}/projects/${PROJECT}?tab=work&thread=${THREAD}&mission=${ROOT_RUN}`,
    },
    resultCompleteness: null,
    ...overrides,
  };
}

/** A child/grandchild snapshot. Defaults match `overrides.status`. */
function descendantSnapshot(
  runId: string,
  depth: number,
  ordinal: number,
  overrides: Partial<MissionRunSnapshot> = {},
): MissionRunSnapshot {
  return {
    ...rootSnapshot({
      id: runId,
      parentRunId: depth === 1 ? ROOT_RUN : CHILD_A,
      rootRunId: ROOT_RUN,
      depth,
      childOrdinal: ordinal,
      routingKind: 'company_agent',
    }),
    status: 'running',
    stateVersion: 3,
    lastEventSequence: 5,
    descendantCount: depth === 1 ? 1 : 0,
    childSummary: { running: 0, completed: 0, failed: 0, cancelled: 0, total: depth === 1 ? 1 : 0 },
    actualCostCents: 0,
    subthreadId: `thread-${runId.slice(0, 4)}`,
    ...overrides,
  };
}

/** Build the ChildSubtree payload for an expanded child: events + plan. */
function childSubtreePayload(
  childEvents: MissionReplayEvent[],
  childPlan: MissionPlanRevision,
): {
  events: { events: MissionReplayEvent[]; nextCursor: number; latestSequence: number };
  plan: MissionPlanRevision;
} {
  const latest = childEvents.reduce((max, e) => Math.max(max, e.sequence), 0);
  return {
    events: { events: childEvents, nextCursor: latest + 1, latestSequence: latest },
    plan: childPlan,
  };
}

/**
 * Scope a status assertion to a node's own header so a nested expanded
 * subtree (whose badges live inside the same `<li>`) does not collide.
 * The header is the first direct child `<div>` of the `<li>`.
 */
/**
 * Scope a status assertion to a node's own header so a nested expanded
 * subtree (whose badges live inside the same `<li>`) does not collide.
 * The header is the first direct child `<div>` of the `<li>`.
 */
function ownStatusBadge(node: HTMLElement, status: string): HTMLElement {
  const header = node.querySelector<HTMLElement>(':scope > div');
  if (!header) {
    throw new Error('child node header not found');
  }
  return within(header).getByTestId(`child-status-${status}`);
}

interface MockConfig {
  /** Authoritative snapshots keyed by run id. */
  snapshots?: Record<string, MissionRunSnapshot>;
  /** The expanded child's events payload (only one child expanded per test). */
  subtreeEvents?: { events: MissionReplayEvent[]; nextCursor: number; latestSequence: number };
  /** Run id of the expanded child whose subtree events/plan should load. */
  expandedChildRunId?: string;
  /** The expanded child's plan revision. */
  subtreePlan?: MissionPlanRevision;
}

/**
 * Wire the mocked hooks to dispatch authoritative snapshot/events/plan
 * data by run id. Each card correlates with its own durable snapshot
 * (VAL-CROSS-027). Unknown run ids get undefined (unmaterialized shells).
 */
function configureMocks(cfg: MockConfig): void {
  const snaps = cfg.snapshots ?? {};
  mocks.useMissionRunSnapshot.mockImplementation((_c, _p, runId) => {
    const data = runId ? snaps[runId] : undefined;
    return { data, isLoading: false, isError: false };
  });
  mocks.useMissionRunEvents.mockImplementation((_c, _p, runId) => {
    if (runId && runId === cfg.expandedChildRunId && cfg.subtreeEvents) {
      return { data: cfg.subtreeEvents, isLoading: false, isError: false };
    }
    return { data: undefined, isLoading: false, isError: false };
  });
  mocks.useMissionCurrentPlanRevision.mockImplementation(() => ({
    data: cfg.subtreePlan ?? undefined,
    isLoading: false,
    isError: false,
  }));
}

function renderTree(
  planRev: MissionPlanRevision,
  events: MissionReplayEvent[],
  snapshot = rootSnapshot(),
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MissionChildTree
          companyId={COMPANY}
          projectId={PROJECT}
          runId={ROOT_RUN}
          snapshot={snapshot}
          events={events}
          planRevision={planRev}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.open = true;
  }) as unknown as typeof HTMLDialogElement.prototype.showModal;
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.open = false;
  }) as unknown as typeof HTMLDialogElement.prototype.close;
  mocks.useMissionRunSnapshot.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
  mocks.useMissionRunEvents.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  mocks.useMissionCurrentPlanRevision.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('MissionChildTree reload (VAL-CROSS-027)', () => {
  // ── Active depth-two tree ───────────────────────────────────────────────

  it('reconstructs an active depth-two tree after reload without resetting progress or duplicating children', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
      childStep('child-b-step', 'root-step', 2, 'Write summary'),
    ]);
    const events: MissionReplayEvent[] = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
      evt(4, 'child.created', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        parentStepKey: 'root-step',
        childOrdinal: 2,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(5, 'child.routed', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(6, 'child.started', { stepKey: 'child-b-step' }),
    ];

    // Authoritative child snapshots: both running, with incurred cost
    // reconstructed from durable snapshot state (not events). Child A also
    // has a materialized grandchild (depth two) fetched on expand.
    const childASnap = descendantSnapshot(CHILD_A, 1, 1, {
      status: 'running',
      actualCostCents: 180,
      subthreadId: 'thread-a',
      descendantCount: 1,
    });
    const childBSnap = descendantSnapshot(CHILD_B, 1, 2, {
      status: 'running',
      actualCostCents: 90,
      subthreadId: 'thread-b',
      descendantCount: 0,
    });
    const grandSnap = descendantSnapshot(GRANDCHILD, 2, 1, {
      status: 'running',
      actualCostCents: 0,
      subthreadId: 'thread-grand',
    });

    const grandEvents: MissionReplayEvent[] = [
      evt(1, 'child.created', {
        childRunId: GRANDCHILD,
        stepKey: 'grand-step',
        parentStepKey: 'child-a-step',
        childOrdinal: 1,
        depth: 2,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.routed', {
        childRunId: GRANDCHILD,
        stepKey: 'grand-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'grand-step' }),
    ];
    const grandPlan = revision(
      planContent([
        rootStep({ stepKey: 'child-a-step', title: 'Child A root step' }),
        childStep('grand-step', 'child-a-step', 1, 'Grandchild step'),
      ]),
    );
    const subtree = childSubtreePayload(grandEvents, grandPlan);

    // Snapshot hook dispatches by run id so each card correlates with its
    // own authoritative snapshot.
    configureMocks({
      snapshots: { [CHILD_A]: childASnap, [CHILD_B]: childBSnap, [GRANDCHILD]: grandSnap },
      expandedChildRunId: CHILD_A,
      subtreeEvents: subtree.events,
      subtreePlan: subtree.plan,
    });

    // First render: expand Child A to materialize depth two.
    const { unmount } = renderTree(revision(plan), events, rootSnapshot());
    await user.click(
      screen.getByRole('button', { name: /Expand descendants for Gather sources/i }),
    );
    const grandBefore = await screen.findByRole('listitem', {
      name: /Step 1: Grandchild step/i,
    });
    expect(within(grandBefore).getByText(GRANDCHILD)).toBeInTheDocument();
    expect(within(grandBefore).getByText('Running')).toBeInTheDocument();

    // Capture pre-reload authoritative correlation.
    const nodeABefore = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    const nodeBBefore = screen.getByRole('listitem', { name: /Step 2: Write summary/i });
    expect(within(nodeABefore).getByText(CHILD_A)).toBeInTheDocument();
    expect(ownStatusBadge(nodeABefore, 'running')).toBeInTheDocument();
    expect(within(nodeABefore).getByText('$1.80')).toBeInTheDocument(); // snapshot cost
    expect(within(nodeBBefore).getByText(CHILD_B)).toBeInTheDocument();
    expect(ownStatusBadge(nodeBBefore, 'running')).toBeInTheDocument();
    expect(within(nodeBBefore).getByText('$0.90')).toBeInTheDocument();
    // No completed children yet.
    expect(screen.queryByTestId('child-status-completed')).not.toBeInTheDocument();
    // Exactly two depth-1 child cards (no duplicate shells).
    expect(screen.getAllByText(/Depth 1/i).length).toBe(2);

    // Simulate reload: sessionStorage persists (expansion state), component
    // re-mounts with the SAME authoritative fixtures.
    unmount();
    renderTree(revision(plan), events, rootSnapshot());

    // The grandchild is restored (expansion persisted) without re-expanding.
    const grandAfter = await screen.findByRole('listitem', {
      name: /Step 1: Grandchild step/i,
    });
    expect(within(grandAfter).getByText(GRANDCHILD)).toBeInTheDocument();
    expect(within(grandAfter).getByText(/Depth 2/i)).toBeInTheDocument();
    // Progress not reset: grandchild still Running (not Queued).
    expect(within(grandAfter).getByText('Running')).toBeInTheDocument();

    // Stable parent/child run IDs and ordinals, no duplicate shells.
    const nodeAAfter = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    const nodeBAfter = screen.getByRole('listitem', { name: /Step 2: Write summary/i });
    expect(within(nodeAAfter).getByText(CHILD_A)).toBeInTheDocument();
    expect(within(nodeBAfter).getByText(CHILD_B)).toBeInTheDocument();
    expect(within(nodeAAfter).getAllByText(CHILD_A).length).toBe(1);
    expect(within(nodeBAfter).getAllByText(CHILD_B).length).toBe(1);
    expect(within(nodeAAfter).getByText(/Depth 1/i)).toBeInTheDocument();
    expect(within(nodeBAfter).getByText(/Depth 1/i)).toBeInTheDocument();
    // Exactly two depth-1 cards after reload (no duplicates).
    expect(screen.getAllByText(/Depth 1/i).length).toBe(2);

    // Statuses not reset: both still Running, costs reconstructed from
    // durable snapshot state.
    expect(ownStatusBadge(nodeAAfter, 'running')).toBeInTheDocument();
    expect(within(nodeAAfter).getByText('$1.80')).toBeInTheDocument();
    expect(ownStatusBadge(nodeBAfter, 'running')).toBeInTheDocument();
    expect(within(nodeBAfter).getByText('$0.90')).toBeInTheDocument();
    // Completed child count unchanged (still zero).
    expect(screen.queryByTestId('child-status-completed')).not.toBeInTheDocument();
  });

  // ── Terminal depth-two tree ─────────────────────────────────────────────

  it('reconstructs a terminal depth-two tree after reload preserving costs, failures, and completed output', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
      childStep('child-b-step', 'root-step', 2, 'Write summary'),
    ]);
    const events: MissionReplayEvent[] = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
      evt(4, 'child.completed', {
        stepKey: 'child-a-step',
        costCents: 250,
        outputSummary: '3 sources',
      }),
      evt(5, 'child.created', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        parentStepKey: 'root-step',
        childOrdinal: 2,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(6, 'child.routed', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(7, 'child.started', { stepKey: 'child-b-step' }),
      evt(8, 'child.failed', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        category: 'tool_failed',
        code: 'TOOL_FAILED',
        safeErrorMessage: 'The extraction tool returned an invalid schema.',
      }),
    ];

    const childASnap = descendantSnapshot(CHILD_A, 1, 1, {
      status: 'completed',
      actualCostCents: 250,
      terminalAt: '2026-08-23T10:30:00.000Z',
      resultCompleteness: 'full',
      subthreadId: 'thread-a',
      descendantCount: 1,
      stateVersion: 6,
      lastEventSequence: 8,
    });
    const childBSnap = descendantSnapshot(CHILD_B, 1, 2, {
      status: 'failed',
      actualCostCents: 40,
      terminalAt: '2026-08-23T10:31:00.000Z',
      failureCategory: 'tool_failed',
      failureCode: 'TOOL_FAILED',
      safeErrorMessage: 'The extraction tool returned an invalid schema.',
      subthreadId: 'thread-b',
      descendantCount: 0,
      stateVersion: 5,
      lastEventSequence: 7,
    });
    const grandSnap = descendantSnapshot(GRANDCHILD, 2, 1, {
      status: 'completed',
      actualCostCents: 120,
      terminalAt: '2026-08-23T10:28:00.000Z',
      resultCompleteness: 'full',
      subthreadId: 'thread-grand',
      stateVersion: 4,
      lastEventSequence: 4,
    });

    const grandEvents: MissionReplayEvent[] = [
      evt(1, 'child.created', {
        childRunId: GRANDCHILD,
        stepKey: 'grand-step',
        parentStepKey: 'child-a-step',
        childOrdinal: 1,
        depth: 2,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.routed', {
        childRunId: GRANDCHILD,
        stepKey: 'grand-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'grand-step' }),
      evt(4, 'child.completed', {
        stepKey: 'grand-step',
        costCents: 120,
        outputSummary: 'draft',
      }),
    ];
    const grandPlan = revision(
      planContent([
        rootStep({ stepKey: 'child-a-step', title: 'Child A root step' }),
        childStep('grand-step', 'child-a-step', 1, 'Grandchild step'),
      ]),
    );
    const subtree = childSubtreePayload(grandEvents, grandPlan);

    configureMocks({
      snapshots: { [CHILD_A]: childASnap, [CHILD_B]: childBSnap, [GRANDCHILD]: grandSnap },
      expandedChildRunId: CHILD_A,
      subtreeEvents: subtree.events,
      subtreePlan: subtree.plan,
    });

    // First render: expand Child A to materialize the completed grandchild.
    const { unmount } = renderTree(revision(plan), events, rootSnapshot());
    await user.click(
      screen.getByRole('button', { name: /Expand descendants for Gather sources/i }),
    );
    const grandBefore = await screen.findByRole('listitem', {
      name: /Step 1: Grandchild step/i,
    });
    expect(within(grandBefore).getByText('Completed')).toBeInTheDocument();
    expect(within(grandBefore).getByText('$1.20')).toBeInTheDocument();
    expect(within(grandBefore).getByText(/draft/i)).toBeInTheDocument();

    // Capture pre-reload terminal correlation.
    const nodeABefore = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    const nodeBBefore = screen.getByRole('listitem', { name: /Step 2: Write summary/i });
    expect(ownStatusBadge(nodeABefore, 'completed')).toBeInTheDocument();
    expect(within(nodeABefore).getByText('$2.50')).toBeInTheDocument();
    expect(within(nodeABefore).getByText(/3 sources/i)).toBeInTheDocument();
    expect(ownStatusBadge(nodeBBefore, 'failed')).toBeInTheDocument();
    expect(
      within(nodeBBefore).getByText(/extraction tool returned an invalid schema/i),
    ).toBeInTheDocument();
    expect(within(nodeBBefore).getByText(/Code: TOOL_FAILED/i)).toBeInTheDocument();
    // One completed depth-1 child before reload.
    expect(screen.getAllByTestId('child-status-completed').length).toBeGreaterThanOrEqual(1);

    // Simulate reload with the SAME authoritative fixtures.
    unmount();
    renderTree(revision(plan), events, rootSnapshot());

    // Grandchild restored: completed, cost + output preserved.
    const grandAfter = await screen.findByRole('listitem', {
      name: /Step 1: Grandchild step/i,
    });
    expect(within(grandAfter).getByText(GRANDCHILD)).toBeInTheDocument();
    expect(within(grandAfter).getByText(/Depth 2/i)).toBeInTheDocument();
    expect(within(grandAfter).getByText('Completed')).toBeInTheDocument();
    expect(within(grandAfter).getByText('$1.20')).toBeInTheDocument();
    expect(within(grandAfter).getByText(/draft/i)).toBeInTheDocument();

    // Stable run IDs / ordinals / depth, no duplicate shells.
    const nodeAAfter = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    const nodeBAfter = screen.getByRole('listitem', { name: /Step 2: Write summary/i });
    expect(within(nodeAAfter).getAllByText(CHILD_A).length).toBe(1);
    expect(within(nodeBAfter).getAllByText(CHILD_B).length).toBe(1);
    expect(within(nodeAAfter).getByText(/Depth 1/i)).toBeInTheDocument();
    expect(within(nodeBAfter).getByText(/Depth 1/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Depth 1/i).length).toBe(2);

    // Terminal statuses, costs, output, and safe failure preserved.
    expect(ownStatusBadge(nodeAAfter, 'completed')).toBeInTheDocument();
    expect(within(nodeAAfter).getByText('$2.50')).toBeInTheDocument();
    expect(within(nodeAAfter).getByText(/3 sources/i)).toBeInTheDocument();
    expect(ownStatusBadge(nodeBAfter, 'failed')).toBeInTheDocument();
    expect(
      within(nodeBAfter).getByText(/extraction tool returned an invalid schema/i),
    ).toBeInTheDocument();
    expect(within(nodeBAfter).getByText(/Code: TOOL_FAILED/i)).toBeInTheDocument();

    // Completed child count unchanged after reload (exactly one depth-1
    // completed card). Count Completed badges that are status badges
    // (data-testid child-status-completed) — one for Child A and one for
    // the grandchild.
    expect(screen.getAllByTestId('child-status-completed').length).toBe(2);
    // No Retry control on terminal children (no progress reset path).
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  // ── Authoritative snapshot correlation ──────────────────────────────────

  it('reload correlates displayed cost with the authoritative snapshot, not only the event', async () => {
    // The completed event reports costCents: 100, but the authoritative
    // snapshot reports actualCostCents: 250 (e.g. late settlement). The
    // card must show the authoritative snapshot value and keep it after
    // reload (VAL-CROSS-027: correlate cards with authoritative snapshots).
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events: MissionReplayEvent[] = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
      evt(4, 'child.completed', { stepKey: 'child-a-step', costCents: 100, outputSummary: 'ok' }),
    ];
    const snap = descendantSnapshot(CHILD_A, 1, 1, {
      status: 'completed',
      actualCostCents: 250,
      terminalAt: '2026-08-23T10:30:00.000Z',
      resultCompleteness: 'full',
      subthreadId: 'thread-a',
    });
    configureMocks({ snapshots: { [CHILD_A]: snap } });

    const { unmount } = renderTree(revision(plan), events, rootSnapshot());
    const nodeBefore = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(nodeBefore).getByText('$2.50')).toBeInTheDocument(); // snapshot wins

    unmount();
    renderTree(revision(plan), events, rootSnapshot());
    const nodeAfter = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(nodeAfter).getByText('$2.50')).toBeInTheDocument();
    // The event-only value ($1.00) is never shown.
    expect(screen.queryByText('$1.00')).not.toBeInTheDocument();
  });

  // ── Lineage + subthread link correlation ────────────────────────────────

  it('reload preserves lineage and subthread deep links to the same child run ids', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
      childStep('child-b-step', 'root-step', 2, 'Write summary'),
    ]);
    const events: MissionReplayEvent[] = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
      evt(4, 'child.created', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        parentStepKey: 'root-step',
        childOrdinal: 2,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(5, 'child.routed', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(6, 'child.started', { stepKey: 'child-b-step' }),
    ];
    const childASnap = descendantSnapshot(CHILD_A, 1, 1, {
      status: 'running',
      actualCostCents: 0,
      subthreadId: 'thread-a',
      descendantCount: 1,
    });
    const childBSnap = descendantSnapshot(CHILD_B, 1, 2, {
      status: 'running',
      actualCostCents: 0,
      subthreadId: 'thread-b',
      descendantCount: 0,
    });
    const grandSnap = descendantSnapshot(GRANDCHILD, 2, 1, {
      status: 'running',
      actualCostCents: 0,
      subthreadId: 'thread-grand',
    });
    const grandEvents: MissionReplayEvent[] = [
      evt(1, 'child.created', {
        childRunId: GRANDCHILD,
        stepKey: 'grand-step',
        parentStepKey: 'child-a-step',
        childOrdinal: 1,
        depth: 2,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.routed', {
        childRunId: GRANDCHILD,
        stepKey: 'grand-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'grand-step' }),
    ];
    const grandPlan = revision(
      planContent([
        rootStep({ stepKey: 'child-a-step', title: 'Child A root step' }),
        childStep('grand-step', 'child-a-step', 1, 'Grandchild step'),
      ]),
    );
    const subtree = childSubtreePayload(grandEvents, grandPlan);

    configureMocks({
      snapshots: { [CHILD_A]: childASnap, [CHILD_B]: childBSnap, [GRANDCHILD]: grandSnap },
      expandedChildRunId: CHILD_A,
      subtreeEvents: subtree.events,
      subtreePlan: subtree.plan,
    });

    const { unmount } = renderTree(revision(plan), events, rootSnapshot());
    await user.click(
      screen.getByRole('button', { name: /Expand descendants for Gather sources/i }),
    );
    // Capture subthread deep links before reload.
    const linkABefore = screen.getByRole('link', { name: /Open subthread for Gather sources/i });
    const linkGrandBefore = await screen.findByRole('link', {
      name: /Open subthread for Grandchild step/i,
    });
    expect(linkABefore.getAttribute('href')).toContain(`mission=${CHILD_A}`);
    expect(linkGrandBefore.getAttribute('href')).toContain(`mission=${GRANDCHILD}`);
    expect(linkABefore.getAttribute('href')).toContain(`thread=${THREAD}`);

    // Reload with the same authoritative fixtures.
    unmount();
    renderTree(revision(plan), events, rootSnapshot());

    const linkAAfter = screen.getByRole('link', { name: /Open subthread for Gather sources/i });
    const linkBAfter = screen.getByRole('link', { name: /Open subthread for Write summary/i });
    const linkGrandAfter = await screen.findByRole('link', {
      name: /Open subthread for Grandchild step/i,
    });
    // Lineage unchanged: same root thread, same child run ids.
    expect(linkAAfter.getAttribute('href')).toContain(`mission=${CHILD_A}`);
    expect(linkBAfter.getAttribute('href')).toContain(`mission=${CHILD_B}`);
    expect(linkGrandAfter.getAttribute('href')).toContain(`mission=${GRANDCHILD}`);
    expect(linkAAfter.getAttribute('href')).toContain(`thread=${THREAD}`);
    expect(linkGrandAfter.getAttribute('href')).toContain(`thread=${THREAD}`);
    // Depth labels preserved (lineage unchanged).
    expect(screen.getAllByText(/Depth 1/i).length).toBe(2);
    expect(screen.getByText(/Depth 2/i)).toBeInTheDocument();
  });
});
