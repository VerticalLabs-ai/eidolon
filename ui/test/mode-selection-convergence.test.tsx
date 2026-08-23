import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMissionComposer } from '../src/components/projects/ChatMissionComposer';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import {
  buildDraftKey,
  writeDraft,
  readDraft,
  clearRunDrafts,
  DRAFT_TTL_MS,
} from '../src/lib/mission-drafts';
import type { MissionCurrentQuestionSet } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useFeatureFlags: vi.fn(),
  useProjectThreads: vi.fn(),
  useCreateThreadItem: vi.fn(),
  useStartMissionRun: vi.fn(),
  useModeProfiles: vi.fn(),
  useSession: vi.fn(),
  useMissionRunsPaginated: vi.fn(),
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useMissionRunStream: vi.fn(),
  useCancelMissionRun: vi.fn(),
  useRetryMissionRun: vi.fn(),
  useMissionRequestText: vi.fn(),
  useAnswerMissionRun: vi.fn(),
  useMissionQuestionSets: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useFeatureFlags: mocks.useFeatureFlags,
    useProjectThreads: mocks.useProjectThreads,
    useCreateThreadItem: mocks.useCreateThreadItem,
    useStartMissionRun: mocks.useStartMissionRun,
    useModeProfiles: mocks.useModeProfiles,
    useMissionRunsPaginated: mocks.useMissionRunsPaginated,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionRunEvents: mocks.useMissionRunEvents,
    useMissionRunStream: mocks.useMissionRunStream,
    useCancelMissionRun: mocks.useCancelMissionRun,
    useRetryMissionRun: mocks.useRetryMissionRun,
    useMissionRequestText: mocks.useMissionRequestText,
    useAnswerMissionRun: mocks.useAnswerMissionRun,
    useMissionQuestionSets: mocks.useMissionQuestionSets,
  };
});

vi.mock('@/lib/ws', () => ({
  useServerEvents: vi.fn(),
  useWebSocket: () => ({ status: 'disconnected' }),
}));

vi.mock('@/lib/auth', () => ({
  useSession: mocks.useSession,
  isLocalTrustedAuth: () => false,
  CLERK_PUBLISHABLE_KEY: '',
}));

// ── Fixtures ─────────────────────────────────────────────────────────────

const thread = {
  id: 'thread-1',
  companyId: 'company-1',
  projectId: 'project-1',
  title: 'General discussion',
  type: 'conversation' as const,
  status: 'active' as const,
  createdByUserId: 'user-1',
  createdByAgentId: null,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T10:00:00.000Z',
};

function sessionResult(userId = 'dev-user-000') {
  return {
    isPending: false,
    data: {
      user: {
        id: userId,
        name: 'Local Operator',
        email: 'local@eidolon.dev',
        image: '',
        role: 'admin',
      },
      session: {
        id: 'local-dev-session',
        userId,
        activeOrganizationId: null,
        activeOrganizationRole: 'admin',
      },
    },
  };
}

function flagsResult(enabled: boolean) {
  return {
    data: { subject: 'company-1', flags: { missionAgentIntelligence: enabled } },
    isLoading: false,
    isError: false,
  };
}

function threadsResult(threads = [thread]) {
  return { data: threads, isLoading: false, isError: false };
}

function createThreadItemResult() {
  return { mutate: vi.fn(), isPending: false, isSuccess: false, isError: false, reset: vi.fn() };
}

function startMissionResult() {
  return { mutate: vi.fn(), isPending: false, isSuccess: false, isError: false, reset: vi.fn() };
}

function modeProfilesResult(profiles: unknown[] = []) {
  return { data: { profiles }, isLoading: false, isError: false };
}

function runSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1',
    companyId: 'company-1',
    projectId: 'project-1',
    status: 'queued',
    stateVersion: 1,
    lastEventSequence: 4,
    resolvedMode: 'deep_work',
    policyContentHash: 'hash-deep-0000000000000000000000000000000000000000',
    requestContentHash: 'hash-1',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    ...overrides,
  };
}

function runSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1',
    companyId: 'company-1',
    projectId: 'project-1',
    projectThreadId: 'thread-1',
    rootRunId: 'run-1',
    parentRunId: null,
    retryOfRunId: null,
    depth: 0,
    childOrdinal: null,
    routingKind: 'company_agent',
    status: 'queued',
    stateVersion: 1,
    lastEventSequence: 4,
    resolvedMode: 'deep_work',
    modeProfileId: null,
    policySnapshotId: 'policy-1',
    policyContentHash: 'hash-deep-0000000000000000000000000000000000000000',
    requestContentHash: 'hash-1',
    currentQuestionSetId: null,
    currentQuestionSet: null,
    currentPlanRevisionId: null,
    approvedPlanRevisionId: null,
    waitingFromStatus: null,
    partialResultPolicy: 'require_all',
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    cancellationDeadlineAt: null,
    failureCategory: null,
    failureCode: null,
    safeErrorMessage: null,
    startedAt: null,
    terminalAt: null,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    attemptCount: 0,
    providerCallCount: 0,
    descendantCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    outputBytes: 0,
    actualCostCents: 0,
    budget: {
      reservedCents: 5000,
      settledCents: 0,
      releasedCents: 0,
      costCentsCeiling: 5000,
      actualCostCents: 0,
    },
    childSummary: { running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
    artifacts: [],
    links: {
      ui: '/company/company-1/projects/project-1?tab=work&thread=thread-1&mission=run-1',
    },
    ...overrides,
  };
}

function listResult(runs: ReturnType<typeof runSummary>[] = [runSummary()]) {
  return {
    data: { pages: [{ runs, nextCursor: null }], pageParams: [undefined] },
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  };
}

function snapshotResult(snapshot: ReturnType<typeof runSnapshot> = runSnapshot()) {
  return { data: snapshot, isLoading: false, isError: false, refetch: vi.fn() };
}

function eventsResult(events: { sequence: number; type: string }[] = []) {
  return { data: { events, nextCursor: 0, latestSequence: 4 }, isLoading: false, isError: false };
}

function streamResult(overrides: Partial<Record<string, unknown>> = {}) {
  return { status: 'connected', lastSequence: 4, gapDetected: false, ...overrides };
}

function cancelMutationResult() {
  return {
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  };
}

function retryMutationResult() {
  return {
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  };
}

function answerMutationResult() {
  return {
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  };
}

function requestTextResult() {
  return undefined;
}

function questionSetsResult() {
  return { data: { questionSets: [] }, isLoading: false, isError: false };
}

function simpleQuestionSet(
  overrides: Partial<MissionCurrentQuestionSet> = {},
): MissionCurrentQuestionSet {
  return {
    id: 'set-1',
    ordinal: 1,
    version: 1,
    status: 'open',
    invalidationReason: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    questions: [
      {
        questionKey: 'bool',
        order: 1,
        type: 'boolean',
        label: 'Approve?',
        help: 'Choose Yes or No.',
        required: true,
        default: null,
        options: null,
        validation: null,
      },
    ],
    ...overrides,
  };
}

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const PRINCIPAL = 'dev-user-000';

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  // jsdom does not implement <dialog> showModal/close; mock them so the
  // native cancel dialog renders as open and persistence is testable.
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  });
  mocks.useSession.mockReturnValue(sessionResult(PRINCIPAL));
  mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
  mocks.useProjectThreads.mockReturnValue(threadsResult());
  mocks.useCreateThreadItem.mockReturnValue(createThreadItemResult());
  mocks.useStartMissionRun.mockReturnValue(startMissionResult());
  mocks.useModeProfiles.mockReturnValue(modeProfilesResult());
  mocks.useMissionRunsPaginated.mockReturnValue(listResult());
  mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
  mocks.useMissionRunEvents.mockReturnValue(eventsResult());
  mocks.useMissionRunStream.mockReturnValue(streamResult());
  mocks.useCancelMissionRun.mockReturnValue(cancelMutationResult());
  mocks.useRetryMissionRun.mockReturnValue(retryMutationResult());
  mocks.useMissionRequestText.mockReturnValue(requestTextResult());
  mocks.useAnswerMissionRun.mockReturnValue(answerMutationResult());
  mocks.useMissionQuestionSets.mockReturnValue(questionSetsResult());
});

afterEach(() => {
  vi.useRealTimers();
});

// ── VAL-CROSS-006: Built-in mode selection and snapshot ──────────────────

describe('VAL-CROSS-006: built-in mode selection and immutable snapshot', () => {
  it('offers Auto, Fast, Deep Work, and Analyst in fixed order with readable summaries', () => {
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    const group = screen.getByRole('radiogroup', { name: /mission mode/i });
    const radios = within(group).getAllByRole('radio');
    const names = radios.map((r) => r.getAttribute('aria-label'));
    expect(names).toEqual(['Auto', 'Fast', 'Deep Work', 'Analyst']);
    // Each built-in exposes a readable description (effective summary).
    expect(within(group).getByText(/Short, bounded work/i)).toBeInTheDocument();
    expect(within(group).getByText(/Structured planning and approval/i)).toBeInTheDocument();
    expect(within(group).getByText(/evidence-oriented research/i)).toBeInTheDocument();
  });

  it('the run card shows the resolved mode and immutable policy identity from the snapshot', () => {
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    // Resolved mode comes from the authoritative snapshot, capitalized.
    expect(within(card).getByText(/Mode:/i).parentElement).toHaveTextContent('deep work');
    // Immutable policy identity is shown (short hash prefix).
    expect(within(card).getByTestId('run-policy-identity')).toHaveTextContent('hash-deep');
  });

  it('changing the composer mode after start does not alter the existing run card mode or policy hash', () => {
    const { rerender } = render(
      <>
        <ChatMissionComposer companyId="company-1" projectId="project-1" />
        <MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />
      </>,
      { wrapper },
    );
    // The existing run was started with Deep Work.
    const card = screen.getByRole('article');
    expect(within(card).getByText(/Mode:/i).parentElement).toHaveTextContent('deep work');
    const policyBefore = within(card).getByTestId('run-policy-identity').textContent;
    // Switch the composer to Mission and select Fast.
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    fireEvent.click(screen.getByRole('radio', { name: /^fast$/i }));
    expect(screen.getByRole('radio', { name: /^fast$/i })).toHaveAttribute('aria-checked', 'true');
    // Re-render to flush any derived state; the existing run card is unchanged.
    rerender(
      <>
        <ChatMissionComposer companyId="company-1" projectId="project-1" />
        <MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />
      </>,
    );
    const cardAfter = screen.getByRole('article');
    expect(within(cardAfter).getByText(/Mode:/i).parentElement).toHaveTextContent('deep work');
    expect(within(cardAfter).getByTestId('run-policy-identity').textContent).toBe(policyBefore);
  });

  it('records the chosen custom profile on the run snapshot (modeProfileId)', () => {
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          resolvedMode: 'custom',
          modeProfileId: 'profile-a',
          policyContentHash: 'hash-custom-000000000000000000000000000000000000',
        }),
      ),
    );
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([
        runSummary({
          resolvedMode: 'custom',
          policyContentHash: 'hash-custom-000000000000000000000000000000000000',
        }),
      ]),
    );
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    const card = screen.getByRole('article');
    expect(within(card).getByTestId('run-policy-identity')).toHaveTextContent('hash-custom');
  });
});

// ── VAL-CROSS-084: Mission drafts are scoped and safely expired ──────────

describe('VAL-CROSS-084: scoped and safely expired drafts', () => {
  it('clears a chat draft after the 24-hour TTL on reload', () => {
    vi.useFakeTimers({ now: new Date('2026-08-23T10:00:00.000Z') });
    const { unmount } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Persisted chat draft' },
    });
    expect(
      readDraft(
        buildDraftKey({
          principalId: PRINCIPAL,
          scope: 'chat',
          companyId: 'company-1',
          projectId: 'project-1',
          threadId: 'thread-1',
        }),
      ),
    ).toBe('Persisted chat draft');
    unmount();
    // Advance past the 24-hour TTL.
    vi.advanceTimersByTime(DRAFT_TTL_MS + 1);
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('');
  });

  it('survives a same-profile reload within the 24-hour TTL', () => {
    vi.useFakeTimers({ now: new Date('2026-08-23T10:00:00.000Z') });
    const { unmount } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'TTL chat draft' },
    });
    unmount();
    // A short reload interval, well within 24h.
    vi.advanceTimersByTime(60_000);
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('TTL chat draft');
  });

  it('clears run-scoped question drafts when the run terminalizes', () => {
    const qset = simpleQuestionSet();
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(runSnapshot({ status: 'awaiting_input', currentQuestionSet: qset })),
    );
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'awaiting_input' })]),
    );
    const { rerender } = render(
      <MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />,
      { wrapper },
    );
    // Type a question answer draft (boolean → click Yes option).
    const yesRadio = screen.getByRole('radio', { name: /yes/i });
    fireEvent.click(yesRadio);
    const answerKey = buildDraftKey({
      principalId: PRINCIPAL,
      scope: 'question-answer',
      companyId: 'company-1',
      projectId: 'project-1',
      runId: 'run-1',
      cardVersion: 'set-1:v1',
    });
    expect(readDraft(answerKey)).not.toBeNull();
    // Run terminalizes (cancelled).
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          status: 'cancelled',
          terminalAt: '2026-08-20T10:05:00.000Z',
          currentQuestionSet: null,
        }),
      ),
    );
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'cancelled' })]),
    );
    rerender(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />);
    expect(readDraft(answerKey)).toBeNull();
  });

  it('clearRunDrafts removes only drafts scoped to that run', () => {
    const answerKey = buildDraftKey({
      principalId: PRINCIPAL,
      scope: 'question-answer',
      companyId: 'company-1',
      projectId: 'project-1',
      runId: 'run-1',
      cardVersion: 'set-1:v1',
    });
    const otherRunKey = buildDraftKey({
      principalId: PRINCIPAL,
      scope: 'question-answer',
      companyId: 'company-1',
      projectId: 'project-1',
      runId: 'run-2',
      cardVersion: 'set-2:v1',
    });
    writeDraft(answerKey, '{"bool":true}');
    writeDraft(otherRunKey, '{"bool":false}');
    clearRunDrafts({
      principalId: PRINCIPAL,
      companyId: 'company-1',
      projectId: 'project-1',
      runId: 'run-1',
    });
    expect(readDraft(answerKey)).toBeNull();
    expect(readDraft(otherRunKey)).not.toBeNull();
  });

  it('persists the cancellation reason across reload and clears it on confirm', async () => {
    const user = userEvent.setup();
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult(runSnapshot({ status: 'queued' })));
    mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary({ status: 'queued' })]));
    const { unmount } = render(
      <MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />,
      { wrapper },
    );
    // Open the cancel dialog and type a reason.
    fireEvent.click(screen.getByRole('button', { name: /cancel run-1/i }));
    const reasonField = await screen.findByLabelText(/reason/i);
    await user.type(reasonField, 'Wrong scope');
    // Simulate a reload (unmount + fresh render) while the dialog is open.
    unmount();
    render(<MissionRunList companyId="company-1" projectId="project-1" requestTexts={{}} />, {
      wrapper,
    });
    // Re-open the dialog: the reason should be restored from storage.
    fireEvent.click(screen.getByRole('button', { name: /cancel run-1/i }));
    const restoredReason = await screen.findByLabelText(/reason/i);
    expect(restoredReason).toHaveValue('Wrong scope');
    // Confirm cancellation: the draft should be cleared.
    await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
    const cancelKey = buildDraftKey({
      principalId: PRINCIPAL,
      scope: 'cancel-reason',
      companyId: 'company-1',
      projectId: 'project-1',
      runId: 'run-1',
    });
    expect(readDraft(cancelKey)).toBeNull();
  });
});
