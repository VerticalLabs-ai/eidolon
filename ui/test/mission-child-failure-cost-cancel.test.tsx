import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  useCancelMissionRun: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/lib/hooks');
  return {
    ...actual,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionRunEvents: mocks.useMissionRunEvents,
    useMissionCurrentPlanRevision: mocks.useMissionCurrentPlanRevision,
    useCancelMissionRun: mocks.useCancelMissionRun,
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
const AGENT_ID = '66666666-6666-4666-8666-666666666666';
const SUBTHREAD_A = '77777777-7777-4777-8777-777777777777';

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
    descendantCount: 0,
    childSummary: { running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
    subthreadId: SUBTHREAD_A,
    ...overrides,
  };
}

/** A cancel mutation stub. Returns a controllable mutateAsync. */
function cancelMutationStub(impl: (args: unknown) => Promise<unknown> = async () => ({})) {
  return {
    mutateAsync: vi.fn(impl),
    isPending: false,
    isError: false,
    error: null as unknown,
    reset: vi.fn(),
  };
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
          rootBillingAgentId={AGENT_ID}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  // jsdom does not implement <dialog> showModal/close; mock them so the
  // native dialog renders as open and focus management is testable.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.useMissionRunSnapshot.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as never);
  mocks.useMissionRunEvents.mockReturnValue({ data: undefined, isLoading: false, isError: false });
  mocks.useMissionCurrentPlanRevision.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
  mocks.useCancelMissionRun.mockReturnValue(cancelMutationStub());
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('MissionChildTree — child failure, cost, cancellation, repair', () => {
  it('VAL-SUB-040: surfaces a limit failure with a safe limit category and no hang', () => {
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
        category: 'limit',
        code: 'LIMIT_EXCEEDED',
        safeErrorMessage: 'The descendant budget limit was reached.',
      }),
    ];
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText('Failed')).toBeInTheDocument();
    expect(within(node).getByText(/Limit reached/i)).toBeInTheDocument();
    expect(within(node).getByText(/descendant budget limit was reached/i)).toBeInTheDocument();
  });

  it('VAL-SUB-040: a limit.exceeded event on a child marks it failed with the limit category', () => {
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
      evt(3, 'limit.exceeded', {
        stepKey: 'child-a-step',
        childRunId: CHILD_A,
        category: 'limit',
        code: 'TIME_LIMIT',
        safeErrorMessage: 'Wall-time limit exceeded for this child.',
      }),
    ];
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText('Failed')).toBeInTheDocument();
    expect(within(node).getByText(/Limit reached/i)).toBeInTheDocument();
  });

  it('VAL-SUB-074: a failed child shows safe details, timing/cost, and no child Retry control', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources', {
        budgetCents: 250,
      }),
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
      evt(3, 'child.completed', {
        stepKey: 'child-a-step',
        costCents: 90,
        outputSummary: 'partial',
      }),
      evt(4, 'child.failed', {
        childRunId: CHILD_A,
        stepKey: 'child-a-step',
        category: 'provider_permanent',
        code: 'PROVIDER_PERMANENT',
        safeErrorMessage: 'The provider rejected the request.',
      }),
    ];
    mocks.useMissionRunSnapshot.mockImplementation((...args: unknown[]) => {
      const runId = args[2] as string;
      if (runId === CHILD_A) {
        return {
          data: childSnapshot(CHILD_A, {
            status: 'failed',
            stateVersion: 7,
            terminalAt: '2026-08-23T10:09:00.000Z',
            actualCostCents: 90,
            failureCategory: 'provider_permanent',
            failureCode: 'PROVIDER_PERMANENT',
            safeErrorMessage: 'The provider rejected the request.',
          }),
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        } as never;
      }
      return undefined as never;
    });
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText('Failed')).toBeInTheDocument();
    expect(within(node).getByText(/provider rejected the request/i)).toBeInTheDocument();
    expect(within(node).getByText(/Code: PROVIDER_PERMANENT/i)).toBeInTheDocument();
    // Timing is shown from the authoritative child snapshot.
    expect(within(node).getByText(/Failed at/i)).toBeInTheDocument();
    // Cost is shown.
    expect(within(node).getByText('$0.90')).toBeInTheDocument();
    // No Retry control on a terminal child.
    expect(within(node).queryByRole('button', { name: /Retry/i })).not.toBeInTheDocument();
    // The legal recovery direction points to a root-level Retry Mission.
    expect(within(node).getByText(/Retry Mission/i)).toBeInTheDocument();
  });

  it('VAL-SUB-074: a failed child under require-all shows the parent-policy consequence', () => {
    const plan = planContent([
      rootStep({ stepKey: 'root-step' }),
      childStep('child-a-step', 'root-step', 1, 'Gather sources'),
      childStep('child-b-step', 'root-step', 2, 'Write summary', {
        dependencies: ['child-a-step'],
      }),
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
        safeErrorMessage: 'Tool failed.',
      }),
    ];
    renderTree(revision(plan), events, rootSnapshot({ partialResultPolicy: 'require_all' }));
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    // require_all stops dependents.
    expect(within(node).getByText(/remaining dependents are stopped/i)).toBeInTheDocument();
  });

  it('VAL-SUB-100: a best-effort completed child with partial results labels "Completed with partial results"', () => {
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
      evt(2, 'child.completed', { stepKey: 'child-a-step', costCents: 100, outputSummary: '2/3' }),
    ];
    mocks.useMissionRunSnapshot.mockImplementation((...args: unknown[]) => {
      const runId = args[2] as string;
      if (runId === CHILD_A) {
        return {
          data: childSnapshot(CHILD_A, { status: 'completed', resultCompleteness: 'partial' }),
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        } as never;
      }
      return undefined as never;
    });
    renderTree(revision(plan), events, rootSnapshot({ partialResultPolicy: 'best_effort' }));
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText('Completed')).toBeInTheDocument();
    expect(within(node).getByText(/Completed with partial results/i)).toBeInTheDocument();
  });

  it('VAL-SUB-096: a nonterminal child exposes a Cancel subtree control with consequence-aware confirmation', async () => {
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
      evt(2, 'child.started', { stepKey: 'child-a-step' }),
    ];
    const mutate = vi.fn(async () => ({}));
    mocks.useCancelMissionRun.mockReturnValue({
      mutateAsync: mutate,
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    });
    mocks.useMissionRunSnapshot.mockImplementation((...args: unknown[]) => {
      const runId = args[2] as string;
      if (runId === CHILD_A) {
        return {
          data: childSnapshot(CHILD_A, { status: 'running', stateVersion: 5 }),
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        } as never;
      }
      return undefined as never;
    });
    renderTree(revision(plan), events);

    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    const cancelBtn = within(node).getByRole('button', {
      name: /Cancel subtree for Gather sources/i,
    });
    // No cancel command is issued before confirmation.
    expect(mutate).not.toHaveBeenCalled();

    await user.click(cancelBtn);
    // Confirmation names the affected child and consequence.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Cancel subtree/i)).toBeInTheDocument();
    expect(within(dialog).getByText(CHILD_A)).toBeInTheDocument();
    expect(within(dialog).getByText(/descendants will be cancelled/i)).toBeInTheDocument();

    // Type a reason and confirm.
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/i }), 'Not needed');
    await user.click(within(dialog).getByRole('button', { name: /Confirm cancellation/i }));

    // Exactly one cancel command, with If-Match state version.
    expect(mutate).toHaveBeenCalledTimes(1);
    const call = mutate.mock.calls[0][0] as {
      reason: string;
      idempotencyKey: string;
      ifMatch?: number;
    };
    expect(call.reason).toBe('Not needed');
    expect(call.ifMatch).toBe(5);
    expect(call.idempotencyKey.length).toBeGreaterThan(0);
  });

  it('VAL-SUB-096: duplicate confirm clicks stay single while pending', async () => {
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
    let resolve: (v: unknown) => void = () => {};
    const mutate = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    mocks.useCancelMissionRun.mockReturnValue({
      mutateAsync: mutate,
      isPending: true,
      isError: false,
      error: null,
      reset: vi.fn(),
    });
    mocks.useMissionRunSnapshot.mockImplementation((...args: unknown[]) => {
      const runId = args[2] as string;
      if (runId === CHILD_A) {
        return {
          data: childSnapshot(CHILD_A, { status: 'running', stateVersion: 5 }),
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        } as never;
      }
      return undefined as never;
    });
    renderTree(revision(plan), events);

    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    await user.click(
      within(node).getByRole('button', { name: /Cancel subtree for Gather sources/i }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/i }), 'Dup');
    const confirm = within(dialog).getByRole('button', { name: /Confirm cancellation/i });
    await user.click(confirm);
    await user.click(confirm);
    // While pending, the confirm control is disabled and only one command
    // is issued once it resolves.
    expect(mutate).toHaveBeenCalledTimes(1);
    resolve({});
  });

  it('VAL-SUB-083: a stale subtree cancel shows a refresh message and preserves navigable context', async () => {
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
      evt(2, 'child.started', { stepKey: 'child-a-step' }),
    ];
    const mutate = vi.fn(async () => {
      throw { status: 412, body: { code: 'RUN_VERSION_MISMATCH' } };
    });
    mocks.useCancelMissionRun.mockReturnValue({
      mutateAsync: mutate,
      isPending: false,
      isError: false,
      error: null,
      reset: vi.fn(),
    });
    mocks.useMissionRunSnapshot.mockImplementation((...args: unknown[]) => {
      const runId = args[2] as string;
      if (runId === CHILD_A) {
        return {
          data: childSnapshot(CHILD_A, { status: 'running', stateVersion: 5 }),
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        } as never;
      }
      return undefined as never;
    });
    renderTree(revision(plan), events);

    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    await user.click(
      within(node).getByRole('button', { name: /Cancel subtree for Gather sources/i }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: /Reason/i }), 'Stale');
    await user.click(within(dialog).getByRole('button', { name: /Confirm cancellation/i }));

    // A stale-version error surfaces an accessible alert with refresh guidance.
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/may have changed/i)).toBeInTheDocument();
    // A refresh control is offered inside the dialog.
    expect(screen.getByRole('button', { name: /Refresh/i })).toBeInTheDocument();
    // The typed reason is preserved for resubmission.
    expect(
      (within(dialog).getByRole('textbox', { name: /Reason/i }) as HTMLTextAreaElement).value,
    ).toBe('Stale');
    // The failure/progress context remains navigable outside the dialog.
    expect(node).toBeInTheDocument();
  });

  it('VAL-RUN-109: cancelling a parent cascades to visible descendants (cancel_requested → cancelled)', () => {
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
      evt(2, 'child.started', { stepKey: 'child-a-step' }),
      evt(3, 'child.created', {
        childRunId: CHILD_B,
        stepKey: 'child-b-step',
        parentStepKey: 'root-step',
        childOrdinal: 2,
        depth: 1,
        assignmentStatus: 'pending_routing',
      }),
      // Parent cancellation cascades child.cancel_requested to every child.
      evt(4, 'child.cancel_requested', { stepKey: 'child-a-step' }),
      evt(5, 'child.cancel_requested', { stepKey: 'child-b-step' }),
    ];
    renderTree(revision(plan), events);
    const nodeA = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    const nodeB = screen.getByRole('listitem', { name: /Step 2: Write summary/i });
    expect(within(nodeA).getByText('Cancelled')).toBeInTheDocument();
    expect(within(nodeB).getByText('Cancelled')).toBeInTheDocument();
  });

  it('VAL-SUB-101: shows a root cost breakdown with ceiling/reserved/settled/released/remaining and per-child billing identities', () => {
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
      evt(3, 'child.completed', { stepKey: 'child-a-step', costCents: 120, outputSummary: 'ok' }),
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
        executingAgentId: null,
        routingKind: 'ephemeral',
        billingAgentId: AGENT_ID,
      }),
    ];
    renderTree(
      revision(plan),
      events,
      rootSnapshot({
        actualCostCents: 200,
        budget: {
          reservedCents: 5000,
          settledCents: 200,
          releasedCents: 50,
          costCentsCeiling: 5000,
          actualCostCents: 200,
        },
      }),
    );

    // Root breakdown with all required reconciling fields.
    const breakdown = screen.getByTestId('mission-cost-breakdown');
    expect(within(breakdown).getByText(/Ceiling/i)).toBeInTheDocument();
    expect(within(breakdown).getByText(/Reserved/i)).toBeInTheDocument();
    expect(within(breakdown).getByText(/Settled/i)).toBeInTheDocument();
    expect(within(breakdown).getByText(/Released/i)).toBeInTheDocument();
    expect(within(breakdown).getByText(/Remaining/i)).toBeInTheDocument();
    // Ceiling and settled reconcile exactly (ceiling $50.00, settled $2.00).
    // Ceiling and reserved are both $50.00 here (full reservation).
    expect(within(breakdown).getAllByText('$50.00')).toHaveLength(2);
    expect(within(breakdown).getByText('$2.00')).toBeInTheDocument();
    // Remaining = reserved - settled - released = 5000 - 200 - 50 = 4750c.
    expect(within(breakdown).getByText('$47.50')).toBeInTheDocument();

    // Billing identities: company-agent child bills its executing agent;
    // ephemeral child bills the root initiating billing agent.
    const nodeA = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(nodeA).getByText(/Bills agent/i)).toBeInTheDocument();
    const billingA = within(nodeA).getByTestId('child-billing');
    expect(within(billingA).getByText(AGENT_ID)).toBeInTheDocument();
    const nodeB = screen.getByRole('listitem', { name: /Step 2: Write summary/i });
    expect(within(nodeB).getByText(/Bills root agent/i)).toBeInTheDocument();
  });

  it('VAL-SUB-103: a child without a subthread projection shows a bounded recovering state', () => {
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
    mocks.useMissionRunSnapshot.mockImplementation((...args: unknown[]) => {
      const runId = args[2] as string;
      if (runId === CHILD_A) {
        return {
          // Child exists but has no subthread projection.
          data: childSnapshot(CHILD_A, { subthreadId: null }),
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        } as never;
      }
      return undefined as never;
    });
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node).getByText(/Recovering subthread/i)).toBeInTheDocument();
    // The normal "Open subthread" link is not shown while recovering.
    expect(
      within(node).queryByRole('link', { name: /Open subthread for Gather sources/i }),
    ).not.toBeInTheDocument();
  });

  it('VAL-SUB-103: after projection repair the subthread link appears once and the child is not re-executed', () => {
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
    mocks.useMissionRunSnapshot.mockImplementation((...args: unknown[]) => {
      const runId = args[2] as string;
      if (runId === CHILD_A) {
        return {
          // Projection repaired: subthread now present.
          data: childSnapshot(CHILD_A, { subthreadId: SUBTHREAD_A }),
          isLoading: false,
          isError: false,
          refetch: vi.fn(),
        } as never;
      }
      return undefined as never;
    });
    renderTree(revision(plan), events);
    const node = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(
      within(node).getByRole('link', { name: /Open subthread for Gather sources/i }),
    ).toBeInTheDocument();
    expect(within(node).queryByText(/Recovering subthread/i)).not.toBeInTheDocument();
  });

  it('VAL-SUB-073: child identity, status, and cost survive a re-render (reload) from authoritative events', () => {
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
      evt(3, 'child.completed', {
        stepKey: 'child-a-step',
        costCents: 250,
        outputSummary: '3 sources',
      }),
    ];
    const { unmount } = renderTree(revision(plan), events);
    const node1 = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node1).getByText(CHILD_A)).toBeInTheDocument();
    expect(within(node1).getByText('Completed')).toBeInTheDocument();
    expect(within(node1).getByText('$2.50')).toBeInTheDocument();
    unmount();

    // Simulate reload: same authoritative events re-render the same fields.
    renderTree(revision(plan), events);
    const node2 = screen.getByRole('listitem', { name: /Step 1: Gather sources/i });
    expect(within(node2).getByText(CHILD_A)).toBeInTheDocument();
    expect(within(node2).getByText('Completed')).toBeInTheDocument();
    expect(within(node2).getByText('$2.50')).toBeInTheDocument();
  });
});
