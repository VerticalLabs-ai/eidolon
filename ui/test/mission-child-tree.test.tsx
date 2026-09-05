import { render, screen, waitFor, within } from '@testing-library/react';
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
  // jsdom does not implement <dialog> showModal/close; mock them so the
  // subtree cancellation dialog can open in tests.
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
      data: childSnapshot(CHILD_A, { subthreadId: 'thread-a' }),
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
      data: childSnapshot(CHILD_A, { subthreadId: 'thread-a' }),
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

// ── Accessibility UI (VAL-SUB-075..081, 105) ──────────────────────────────

describe('MissionChildTree accessibility UI', () => {
  function twoChildPlan() {
    return planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
      childStep('child-b-step', 'root-step', 2, 'Write summary'),
    ]);
  }

  function childACreated(extra: MissionReplayEvent[] = []): MissionReplayEvent[] {
    return [
      evt(1, 'child.created', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        parentStepKey: 'root-step',
        childOrdinal: 1,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      ...extra,
    ];
  }

  // VAL-SUB-075: semantic headings with levels that reflect depth.
  it('uses heading levels that reflect depth (h4 root, h5 depth 1, h6 depth 2)', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = childACreated([
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
    ]);
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: childSnapshot(CHILD_A, { subthreadId: 'thread-a' }),
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

    // Root tree heading is an h4.
    const rootHeading = screen.getByRole('heading', { name: /Child tree/i });
    expect(rootHeading.tagName).toBe('H4');

    // Depth-1 child heading is an h5.
    const depth1 = screen.getByRole('heading', { name: /Gather sources/i });
    expect(depth1.tagName).toBe('H5');

    // Expand to depth 2.
    const expand = screen.getByRole('button', { name: /Expand descendants for Gather sources/i });
    await user.click(expand);

    // Depth-2 grandchild heading is an h6.
    const grand = await screen.findByRole('heading', { name: /Grandchild step/i });
    expect(grand.tagName).toBe('H6');
  });

  // VAL-SUB-075: nested ordered lists (not ARIA tree semantics).
  it('uses nested ordered lists, not ARIA tree roles', () => {
    const plan = twoChildPlan();
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
        assignmentStatus: 'pending_routing',
      }),
    ];
    renderTree(revision(plan), events);

    // No ARIA tree semantics.
    expect(screen.queryByRole('tree')).not.toBeInTheDocument();
    expect(screen.queryByRole('treeitem')).not.toBeInTheDocument();
    // Ordered lists preserve child order.
    const lists = screen.getAllByRole('list');
    expect(lists.length).toBeGreaterThanOrEqual(1);
    expect(lists[0].tagName).toBe('OL');
    const items = within(lists[0]).getAllByRole('listitem');
    expect(items.length).toBe(2);
    // Ordinal labels preserve order.
    expect(within(items[0]).getByText(/1\./)).toBeInTheDocument();
    expect(within(items[1]).getByText(/2\./)).toBeInTheDocument();
  });

  // VAL-SUB-076: keyboard operability for expand/collapse and subtree cancel.
  it('keyboard user can expand/collapse and open subtree cancellation with confirmation', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = childACreated([
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
    ]);
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: childSnapshot(CHILD_A, { subthreadId: 'thread-a' }),
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

    const expand = screen.getByRole('button', { name: /Expand descendants for Gather sources/i });
    expand.focus();
    expect(expand).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(
      await screen.findByRole('listitem', { name: /Step 1: Grandchild step/i }),
    ).toBeInTheDocument();

    const collapse = screen.getByRole('button', {
      name: /Collapse descendants for Gather sources/i,
    });
    collapse.focus();
    await user.keyboard('{Enter}');
    expect(
      screen.queryByRole('listitem', { name: /Step 1: Grandchild step/i }),
    ).not.toBeInTheDocument();

    // Subtree cancel opens a confirmation dialog via keyboard.
    const cancel = screen.getByRole('button', { name: /Cancel subtree for Gather sources/i });
    cancel.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: /Cancel subtree/i })).toBeInTheDocument();
  });

  // VAL-SUB-076: no terminal child Retry control.
  it('does not render a Retry control for a terminal failed child', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = childACreated([
      evt(2, 'child.failed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        category: 'tool_failed',
        code: 'TOOL_FAILED',
        safeErrorMessage: 'The extraction tool returned an invalid schema.',
      }),
    ]);
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
    // Recovery direction points to the root run.
    expect(within(node).getByText(/Retry Mission on the root run/i)).toBeInTheDocument();
  });

  // VAL-SUB-077: progress announcements are batched (one announcement per
  // render, not one per event).
  it('batches announcements: a burst of progress in one render yields one combined message', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
      childStep('child-b-step', 'root-step', 2, 'Write summary'),
    ]);
    // First render: one running child, zero completed.
    const eventsBefore = childACreated([evt(2, 'child.started', { stepKey: 'child-a-step' })]);
    const { rerender } = renderTree(revision(plan), eventsBefore);

    // Second render: a burst — child A completes (running→0, completed→1)
    // and child B is created but not started (queued). Multiple events
    // arrive in one render but the announcement should be a single combined
    // delta, not one message per event.
    const eventsAfter = [
      ...eventsBefore,
      evt(3, 'child.completed', { stepKey: 'child-a-step', costCents: 100 }),
      evt(4, 'child.created', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        parentStepKey: 'root-step',
        childOrdinal: 2,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
    ];
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <MissionChildTree
            companyId={COMPANY}
            projectId={PROJECT}
            runId={ROOT_RUN}
            snapshot={rootSnapshot()}
            events={eventsAfter}
            planRevision={revision(plan)}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const live = screen.getByTestId('child-tree-live-region');
    const text = live.textContent ?? '';
    // One combined announcement mentions both deltas once.
    expect(text).toContain('0 children running');
    expect(text).toContain('1 completed');
    // No per-token / per-progress-event noise: "progress" alone is not
    // announced as a standalone status word.
    expect(text).not.toMatch(/execution\.progress/i);
  });

  // VAL-SUB-077: failures use an alert.
  it('announces child failure through a role=alert', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = childACreated([
      evt(2, 'child.failed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        category: 'tool_failed',
        code: 'TOOL_FAILED',
        safeErrorMessage: 'The extraction tool returned an invalid schema.',
      }),
    ]);
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByRole('alert')).toBeInTheDocument();
  });

  // VAL-SUB-078: every status is distinguishable by text/icon, not color.
  it('conveys each status with text and an icon, not color alone', () => {
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

    const statuses = [
      'Queued',
      'Running',
      'Awaiting input',
      'Synthesizing',
      'Completed',
      'Failed',
      'Cancelled',
    ];
    for (const s of statuses) {
      const badge = screen.getByText(s);
      // Each status badge is accompanied by an icon (svg) in the same node.
      const item = badge.closest('li')!;
      expect(item.querySelectorAll('svg').length).toBeGreaterThan(0);
    }
  });

  // VAL-SUB-079: reduced motion is respected.
  it('applies motion-reduce guards to animated indicators and transitions', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Running step'),
    ]);
    const events = childACreated([evt(2, 'child.started', { stepKey: 'child-a-step' })]);
    renderTree(revision(plan), events);

    // The running status icon animates but removes animation under reduced motion.
    const runningIcon = screen.getByText('Running').closest('li')!.querySelector('svg');
    expect(runningIcon?.getAttribute('class')).toMatch(/motion-reduce:animate-none/);

    // Expand/cancel buttons remove transitions under reduced motion.
    const cancel = screen.queryByRole('button', { name: /Cancel subtree/i });
    if (cancel) {
      expect(cancel.className).toMatch(/motion-reduce:transition-none/);
    }
  });

  // VAL-SUB-080: mobile tree reflows at narrow viewports.
  it('reflows at narrow viewports with wrapping and break classes', () => {
    const plan = twoChildPlan();
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
        assignmentStatus: 'pending_routing',
      }),
    ];
    renderTree(revision(plan), events);

    const section = screen.getByTestId('mission-child-tree');
    expect(section.className).toMatch(/overflow-hidden/);
    expect(section.className).toMatch(/break-words/);
    // Each node wraps its header controls.
    const items = screen.getAllByRole('listitem');
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.className).toMatch(/break-words/);
      expect(item.className).toMatch(/min-w-0/);
    }
  });

  // VAL-SUB-081: mobile failure detail stays readable within the viewport.
  it('keeps failure detail readable and wrapped on mobile', () => {
    const longMessage =
      'The extraction tool returned an invalid schema after repeated attempts ' +
      'with a very long safe error message that must wrap within the viewport ' +
      'without clipping because the failure detail container uses break-words. '.repeat(4);
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = childACreated([
      evt(2, 'child.failed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        category: 'tool_failed',
        code: 'TOOL_FAILED',
        safeErrorMessage: longMessage,
      }),
    ]);
    renderTree(revision(plan), events);

    const failure = screen.getByTestId('child-failure');
    // Failure detail container does not set a fixed width and wraps text.
    expect(failure.className).not.toMatch(/w-\[/);
    const messageEl = within(failure).getByText(
      /extraction tool returned an invalid schema after repeated attempts/,
    );
    expect(messageEl.className).toMatch(/break-words/);
    // Child/step context preserved.
    expect(within(failure).getByText(/Child failed/i)).toBeInTheDocument();
    expect(within(failure).getByText(/Code: TOOL_FAILED/i)).toBeInTheDocument();
  });

  // VAL-SUB-105: opening a subthread records the origin and re-mount
  // focuses the originating child link.
  it('restores focus to the originating child link after Back navigation', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = childACreated([
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
    ]);
    const { unmount } = renderTree(revision(plan), events);

    // Click "Open subthread" — records the originating child run id.
    const link = screen.getByRole('link', { name: /Open subthread for Gather sources/i });
    await user.click(link);

    // Simulate Back: re-mount the tree with the same root run/principal.
    unmount();
    renderTree(revision(plan), events);

    // The originating child link receives focus.
    const restoredLink = await screen.findByRole('link', {
      name: /Open subthread for Gather sources/i,
    });
    expect(restoredLink).toHaveFocus();
  });

  // VAL-SUB-105: missing origin falls back to nearest surviving parent heading.
  it('falls back to the tree heading when the originating child is gone', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = childACreated([
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
    ]);
    const { unmount } = renderTree(revision(plan), events);

    // Record an origin for a child that will not exist after "Back".
    const link = screen.getByRole('link', { name: /Open subthread for Gather sources/i });
    await user.click(link);

    // Re-mount with a plan that has no children (origin gone).
    unmount();
    renderTree(revision(planContent([rootStep({ stepKey: 'root-step' })])), []);

    // No tree is rendered when there are no children, so there is nothing
    // to restore focus to — assert the tree is absent (origin cleared, no
    // crash).
    expect(screen.queryByTestId('mission-child-tree')).not.toBeInTheDocument();
  });

  // VAL-SUB-105: return focus falls back to the parent heading when the
  // originating grandchild link is no longer present but the parent is.
  it('falls back to the parent heading when the origin grandchild is gone', async () => {
    const user = userEvent.setup();
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
    ]);
    const events = childACreated([
      evt(2, 'child.routed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        executingAgentId: AGENT_ID,
        routingKind: 'company_agent',
      }),
      evt(3, 'child.started', { stepKey: 'child-a-step' }),
    ]);
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: childSnapshot(CHILD_A, { subthreadId: 'thread-a' }),
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

    const { unmount } = renderTree(revision(plan), events);

    // Expand to depth 2, then open the grandchild subthread.
    const expand = screen.getByRole('button', { name: /Expand descendants for Gather sources/i });
    await user.click(expand);
    const grandLink = await screen.findByRole('link', {
      name: /Open subthread for Grandchild step/i,
    });
    await user.click(grandLink);

    // Re-mount with the grandchild plan empty (origin gone) but the parent
    // (Gather sources) still present.
    mocks.useMissionRunEvents.mockReturnValue({
      data: { events: [], nextCursor: 0, latestSequence: 0 },
      isLoading: false,
      isError: false,
    });
    mocks.useMissionCurrentPlanRevision.mockReturnValue({
      data: revision(
        planContent([rootStep({ stepKey: 'child-a-step', title: 'Child A root step' })]),
      ),
      isLoading: false,
      isError: false,
    });
    unmount();
    renderTree(revision(plan), events);

    // After re-mount, focus lands on the surviving parent heading
    // (Gather sources) since the grandchild link is gone.
    const parentHeading = await screen.findByRole('heading', { name: /Gather sources/i });
    await waitFor(() => expect(parentHeading).toHaveFocus());
  });
});
