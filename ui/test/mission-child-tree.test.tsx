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
/** Valid UUID for an indexed synthetic child run id. */
function rid(prefix: string): string {
  // prefix is a single hex char; build a valid UUID v4-like string.
  return `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${prefix.repeat(12)}`;
}

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
      kind: 'requirements',
      routingRequirements: {
        capabilities: ['research'],
        requiredTools: ['research.search'],
        requiredDomains: [],
        ephemeralAllowed: true,
      },
    },
    toolAllowlist: ['research.search'],
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
    descendantCount: 2,
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
    childSummary: { running: 1, completed: 1, failed: 0, cancelled: 0, total: 2 },
    artifacts: [],
    links: {
      ui: `/company/${COMPANY}/projects/${PROJECT}?tab=work&thread=${THREAD}&mission=${ROOT_RUN}`,
    },
    resultCompleteness: null,
    ...overrides,
  };
}

function childSnapshot(
  runId: string,
  overrides: Partial<MissionRunSnapshot> = {},
): MissionRunSnapshot {
  return {
    ...rootSnapshot({ id: runId, parentRunId: ROOT_RUN, rootRunId: ROOT_RUN, depth: 1 }),
    status: 'running',
    stateVersion: 3,
    lastEventSequence: 5,
    childOrdinal: 1,
    descendantCount: 1,
    childSummary: { running: 0, completed: 0, failed: 0, cancelled: 0, total: 1 },
    ...overrides,
  };
}

function childEvents(): {
  events: MissionReplayEvent[];
  nextCursor: number;
  latestSequence: number;
} {
  return {
    events: [
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
      evt(3, 'child.started', { stepKey: 'grand-step', agentId: AGENT_ID }),
    ],
    nextCursor: 4,
    latestSequence: 3,
  };
}

function childPlan(): MissionPlanRevision {
  return revision(
    planContent([
      rootStep({ stepKey: 'child-a-step', title: 'Child A root step' }),
      childStep('grand-step', 'child-a-step', 1, 'Grandchild step'),
    ]),
  );
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

describe('MissionChildTree', () => {
  it('renders nothing when the root has no approved plan', () => {
    const { container } = renderTree(revision(planContent([rootStep()])), []);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the approved plan has no child steps', () => {
    const plan = planContent([rootStep()]);
    const { container } = renderTree(revision(plan), []);
    expect(container).toBeEmptyDOMElement();
  });

  it('preserves stable child identity: run id, step title, depth, status', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
      childStep('child-b-step', 'root-step', 2, 'Write summary'),
    ]);
    const events = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.created', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        parentStepKey: 'root-step',
        childOrdinal: 2,
        depth: 1,
        assignmentStatus: 'pending_dependencies',
      }),
    ];
    renderTree(revision(plan), events);

    const nodeA = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(nodeA).getByText(CHILD_A)).toBeInTheDocument();
    expect(within(nodeA).getByText(/Depth 1/i)).toBeInTheDocument();
    // No started event → honest "Queued" status (not optimistic).
    expect(within(nodeA).getByText('Queued')).toBeInTheDocument();
  });

  it('labels ephemeral children explicitly and company-agent children by agent', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
      childStep('child-b-step', 'root-step', 2, 'Write summary'),
    ]);
    const events = [
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
      evt(3, 'child.created', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        parentStepKey: 'root-step',
        childOrdinal: 2,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(4, 'child.routed', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        executingAgentId: null,
        routingKind: 'ephemeral',
        billingAgentId: AGENT_ID,
      }),
    ];
    renderTree(revision(plan), events);

    const nodeA = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(nodeA).getByText('Company agent')).toBeInTheDocument();
    // AGENT_ID now appears in both the routing line and the billing identity.
    expect(within(nodeA).getAllByText(AGENT_ID).length).toBeGreaterThanOrEqual(1);
    // No ineligible candidate leakage.
    expect(within(nodeA).queryByText(/candidate/i)).not.toBeInTheDocument();

    const nodeB = screen.getByRole('listitem', { name: /Step 2: Write summary/i });
    expect(within(nodeB).getByText('Ephemeral')).toBeInTheDocument();
  });

  it('renders every child status as explicit text', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Queued step'),
      childStep('child-b-step', 'root-step', 2, 'Running step'),
      childStep('child-c-step', 'root-step', 3, 'Awaiting step'),
      childStep('child-d-step', 'root-step', 4, 'Synthesis step'),
      childStep('child-e-step', 'root-step', 5, 'Completed step'),
      childStep('child-f-step', 'root-step', 6, 'Failed step'),
      childStep('child-g-step', 'root-step', 7, 'Cancelled step'),
    ]);
    const mk = (seq: number, step: string, runId: string) =>
      evt(seq, 'child.created', {
        childRunId: runId,
        stepKey: step,
        parentStepKey: 'root-step',
        childOrdinal: 0,
        depth: 1,
        assignmentStatus: 'pending_routing',
      });
    const QA = rid('a');
    const QB = rid('b');
    const QC = rid('c');
    const QD = rid('d');
    const QE = rid('e');
    const QF = rid('f');
    const QG = rid('1');
    const events = [
      mk(1, 'child-a-step', QA),
      mk(2, 'child-b-step', QB),
      evt(3, 'child.started', { stepKey: 'child-b-step' }),
      mk(4, 'child-c-step', QC),
      evt(5, 'descendant.progressed', {
        descendantRunId: QC,
        sourceSequence: 1,
        sourceEventType: 'questions.requested',
        sourcePayload: { runId: QC },
      }),
      mk(6, 'child-d-step', QD),
      evt(7, 'descendant.progressed', {
        descendantRunId: QD,
        sourceSequence: 2,
        sourceEventType: 'run.status_changed',
        sourcePayload: { status: 'synthesizing' },
      }),
      mk(8, 'child-e-step', QE),
      evt(9, 'child.completed', { stepKey: 'child-e-step', costCents: 150 }),
      mk(10, 'child-f-step', QF),
      evt(11, 'child.failed', {
        stepKey: 'child-f-step',
        childRunId: QF,
        category: 'provider_permanent',
        code: 'PROVIDER_PERMANENT',
        safeErrorMessage: 'Provider rejected the request.',
      }),
      mk(12, 'child-g-step', QG),
      evt(13, 'child.cancel_requested', { stepKey: 'child-g-step' }),
    ];
    renderTree(revision(plan), events);

    expect(screen.getByText('Queued')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('Awaiting input')).toBeInTheDocument();
    expect(screen.getByText('Synthesizing')).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('shows "Needs input" for an awaiting-input child and surfaces the question link', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.started', { stepKey: 'child-a-step' }),
      evt(3, 'descendant.progressed', {
        descendantRunId: CHILD_A,
        sourceSequence: 5,
        sourceEventType: 'questions.requested',
        sourcePayload: { runId: CHILD_A, questionSetId: 'qs-1' },
      }),
    ];
    renderTree(revision(plan), events);

    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText('Needs input')).toBeInTheDocument();
    // The subthread link targets the child run.
    const link = within(node).getByRole('link', { name: /Open subthread for Gather sources/i });
    expect(link.getAttribute('href')).toContain(`mission=${CHILD_A}`);
  });

  it('does not optimistically advance status beyond committed events', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    // Only child.created exists — no started/completed. Honest state is Queued.
    const events = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
    ];
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText('Queued')).toBeInTheDocument();
    expect(within(node).queryByText('Running')).not.toBeInTheDocument();
    expect(within(node).queryByText('Completed')).not.toBeInTheDocument();
  });

  it('renders coherent routing states: pending dependencies, pending routing, routed, no eligible agent', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Dep step', {
        dependencies: ['root-step'],
      }),
      childStep('child-b-step', 'root-step', 2, 'Ready step'),
      childStep('child-c-step', 'root-step', 3, 'Routed step'),
      childStep('child-d-step', 'root-step', 4, 'Exhausted step'),
    ]);
    const events = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_dependencies',
      }),
      evt(2, 'child.created', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        parentStepKey: 'root-step',
        childOrdinal: 2,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(3, 'child.created', {
        childRunId: rid('c'),
        stepKey: 'child-c-step',
        parentStepKey: 'root-step',
        childOrdinal: 3,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(4, 'child.routed', {
        childRunId: rid('c'),
        stepKey: 'child-c-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(5, 'child.created', {
        childRunId: rid('d'),
        stepKey: 'child-d-step',
        parentStepKey: 'root-step',
        childOrdinal: 4,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(6, 'child.failed', {
        childRunId: rid('d'),
        stepKey: 'child-d-step',
        category: 'policy',
        code: 'NO_ELIGIBLE_AGENT',
        safeErrorMessage: 'No eligible agent available for this step.',
      }),
    ];
    renderTree(revision(plan), events);

    const dep = screen.getByRole('listitem', { name: /Step 1: Dep step/i });
    expect(within(dep).getByText('Pending dependencies')).toBeInTheDocument();

    const ready = screen.getByRole('listitem', { name: /Step 2: Ready step/i });
    expect(within(ready).getByText('Pending routing')).toBeInTheDocument();

    const routed = screen.getByRole('listitem', { name: /Step 3: Routed step/i });
    expect(within(routed).getByText('Routed')).toBeInTheDocument();

    const exhausted = screen.getByRole('listitem', { name: /Step 4: Exhausted step/i });
    expect(within(exhausted).getByText('No eligible agent')).toBeInTheDocument();
    expect(within(exhausted).getByText('Failed')).toBeInTheDocument();
    // No routing kind leaked for the exhausted shell.
    expect(within(exhausted).queryByText('Ephemeral')).not.toBeInTheDocument();
    expect(within(exhausted).queryByText('Company agent')).not.toBeInTheDocument();
  });

  it('navigates to depth two by expanding a child and inspecting a grandchild', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = [
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
    ];
    // When Child A is expanded, fetch its snapshot + events + plan.
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: childSnapshot(CHILD_A),
      isLoading: false,
      isError: false,
    });
    mocks.useMissionRunEvents.mockReturnValue({
      data: childEvents(),
      isLoading: false,
      isError: false,
    });
    mocks.useMissionCurrentPlanRevision.mockReturnValue({
      data: childPlan(),
      isLoading: false,
      isError: false,
    });

    renderTree(revision(plan), events);

    // Root breadcrumb is present.
    expect(screen.getByRole('heading', { name: /Child tree/i })).toBeInTheDocument();

    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    const expand = within(node).getByRole('button', {
      name: /Expand descendants for Gather sources/i,
    });
    await user.click(expand);

    // Grandchild appears (depth two), retaining root + parent labels.
    const grand = await screen.findByRole('listitem', { name: /Step 1: Grandchild step/i });
    expect(within(grand).getByText(GRANDCHILD)).toBeInTheDocument();
    expect(within(grand).getByText(/Depth 2/i)).toBeInTheDocument();
    expect(within(grand).getByText('Running')).toBeInTheDocument();
    // Parent breadcrumb link back to Child A.
    expect(screen.getByText(/Gather sources/i)).toBeInTheDocument();
  });

  it('restores expanded node ids after reload via sessionStorage', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
    ];
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: childSnapshot(CHILD_A),
      isLoading: false,
      isError: false,
    });
    mocks.useMissionRunEvents.mockReturnValue({
      data: childEvents(),
      isLoading: false,
      isError: false,
    });
    mocks.useMissionCurrentPlanRevision.mockReturnValue({
      data: childPlan(),
      isLoading: false,
      isError: false,
    });

    // First render: expand the child.
    const { unmount } = renderTree(revision(plan), events);
    const expand = screen.getByRole('button', { name: /Expand descendants for Gather sources/i });
    await user.click(expand);
    await screen.findByRole('listitem', { name: /Step 1: Grandchild step/i });
    unmount();

    // Simulate reload: sessionStorage persists, component re-mounts.
    renderTree(revision(plan), events);
    // The grandchild is restored without re-expanding.
    expect(
      await screen.findByRole('listitem', { name: /Step 1: Grandchild step/i }),
    ).toBeInTheDocument();
    // The expand control now collapses.
    expect(
      screen.getByRole('button', { name: /Collapse descendants for Gather sources/i }),
    ).toBeInTheDocument();
  });

  it('correlates UI fields with the authoritative event-derived data (cost, routing, run id)', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = [
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
    ];
    renderTree(revision(plan), events);

    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText(CHILD_A)).toBeInTheDocument();
    expect(within(node).getByText('Company agent')).toBeInTheDocument();
    // AGENT_ID now appears in both the routing line and the billing identity.
    expect(within(node).getAllByText(AGENT_ID).length).toBeGreaterThanOrEqual(1);
    expect(within(node).getByText('Completed')).toBeInTheDocument();
    expect(within(node).getByText('$2.50')).toBeInTheDocument();
    expect(within(node).getByText(/3 sources/i)).toBeInTheDocument();
  });

  it('shows safe failure details without secrets for a failed child', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      evt(2, 'child.failed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        category: 'tool_failed',
        code: 'TOOL_FAILED',
        safeErrorMessage: 'The extraction tool returned an invalid schema.',
      }),
    ];
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText('Failed')).toBeInTheDocument();
    expect(
      within(node).getByText(/extraction tool returned an invalid schema/i),
    ).toBeInTheDocument();
    expect(within(node).getByText(/Code: TOOL_FAILED/i)).toBeInTheDocument();
    // No secret material leaked.
    expect(within(node).queryByText(/sk-|api[_-]?key|password/i)).not.toBeInTheDocument();
  });
});
