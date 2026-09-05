import { render, screen, fireEvent, act, renderHook as tlRenderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MissionQuestionCard } from '../src/components/projects/MissionQuestionCard';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import { useMissionRunStream as useMissionRunStreamReal } from '../src/lib/mission-stream';
import type { MissionCurrentQuestionSet } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useAnswerMissionRun: vi.fn(),
  useMissionQuestionSets: vi.fn(),
  useMissionRunsPaginated: vi.fn(),
  useMissionRunSnapshot: vi.fn(),
  useMissionRunEvents: vi.fn(),
  useStartMissionRun: vi.fn(),
  useMissionRunStream: vi.fn(),
  useCancelMissionRun: vi.fn(),
  useRetryMissionRun: vi.fn(),
  useMissionRequestText: vi.fn(),
  useSession: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useAnswerMissionRun: mocks.useAnswerMissionRun,
    useMissionQuestionSets: mocks.useMissionQuestionSets,
    useMissionRunsPaginated: mocks.useMissionRunsPaginated,
    useMissionRunSnapshot: mocks.useMissionRunSnapshot,
    useMissionRunEvents: mocks.useMissionRunEvents,
    useStartMissionRun: mocks.useStartMissionRun,
    useMissionRunStream: mocks.useMissionRunStream,
    useCancelMissionRun: mocks.useCancelMissionRun,
    useRetryMissionRun: mocks.useRetryMissionRun,
    useMissionRequestText: mocks.useMissionRequestText,
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

// ── Helpers ───────────────────────────────────────────────────────────────

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    qc,
    ...render(
      <MemoryRouter>
        <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
      </MemoryRouter>,
    ),
  };
}

function defaultMutation() {
  return {
    mutateAsync: vi.fn().mockResolvedValue({ data: { run: { id: 'run-1' } } }),
    isPending: false,
    isError: false,
    error: null,
  };
}

/** A minimal open question set with one required boolean and one optional text. */
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
      {
        questionKey: 'text',
        order: 2,
        type: 'text',
        label: 'Notes',
        help: null,
        required: false,
        default: '',
        options: null,
        validation: { maxLength: 200 },
      },
    ],
    ...overrides,
  };
}

function sessionResult(userId = 'user-1') {
  return {
    isPending: false,
    data: {
      user: { id: userId, name: 'Test User', email: 'test@test', image: '', role: 'admin' },
      session: {
        id: 'sess-1',
        userId,
        activeOrganizationId: null,
        activeOrganizationRole: 'admin',
      },
    },
  };
}

// ── MissionRunList helpers ────────────────────────────────────────────────

function runSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1',
    companyId: 'c1',
    projectId: 'p1',
    status: 'awaiting_input',
    stateVersion: 3,
    lastEventSequence: 4,
    resolvedMode: 'fast',
    policyContentHash: 'abc',
    requestContentHash: 'h1',
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

function runSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'run-1',
    companyId: 'c1',
    projectId: 'p1',
    projectThreadId: 'thread-1',
    rootRunId: 'run-1',
    parentRunId: null,
    retryOfRunId: null,
    depth: 0,
    childOrdinal: null,
    routingKind: 'company_agent',
    status: 'awaiting_input',
    stateVersion: 3,
    lastEventSequence: 4,
    resolvedMode: 'fast',
    modeProfileId: null,
    policySnapshotId: 'policy-1',
    policyContentHash: 'abc',
    requestContentHash: 'h1',
    currentQuestionSetId: 'set-1',
    currentQuestionSet: simpleQuestionSet(),
    currentPlanRevisionId: null,
    approvedPlanRevisionId: null,
    waitingFromStatus: 'planning',
    partialResultPolicy: 'require_all',
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    cancellationDeadlineAt: null,
    failureCategory: null,
    failureCode: null,
    safeErrorMessage: null,
    startedAt: '2026-08-23T10:00:01.000Z',
    terminalAt: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
    attemptCount: 0,
    providerCallCount: 0,
    descendantCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    outputBytes: 0,
    actualCostCents: 0,
    queueHealth: undefined,
    budget: {
      reservedCents: 500,
      settledCents: 0,
      releasedCents: 0,
      costCentsCeiling: 500,
      actualCostCents: 0,
    },
    childSummary: { running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
    artifacts: [],
    links: { ui: '/company/c1/projects/p1?tab=work' },
    ...overrides,
  };
}

function listResult(runs = [runSummary()]) {
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

function snapshotResult(snapshot = runSnapshot()) {
  return { data: snapshot, isLoading: false, isError: false, refetch: vi.fn() };
}

function eventsResult() {
  return {
    data: { events: [], nextCursor: 0, latestSequence: 4 },
    isLoading: false,
    isError: false,
  };
}

function streamResult(overrides: Partial<Record<string, unknown>> = {}) {
  return { status: 'connected', lastSequence: 4, gapDetected: false, ...overrides };
}

function cancelMutationResult() {
  return { mutateAsync: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() };
}

function retryMutationResult() {
  return { mutateAsync: vi.fn(), isPending: false, isError: false, error: null, reset: vi.fn() };
}

function startResult() {
  return { mutate: vi.fn(), isPending: false, isSuccess: false, isError: false, reset: vi.fn() };
}

// ── MissionQuestionCard — draft & recovery tests ─────────────────────────

describe('MissionQuestionCard — draft persistence & recovery', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.useAnswerMissionRun.mockReturnValue(defaultMutation());
    mocks.useMissionQuestionSets.mockReturnValue({
      data: { questionSets: [], nextCursor: null },
      isLoading: false,
      isError: false,
    });
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  // ── VAL-MODEQ-072: Duplicate-click protection ───────────────────────
  it('disables the submit action while pending to prevent duplicate clicks', () => {
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      isPending: true,
    });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    // The submit button is disabled and shows "Submitting…" while pending.
    const submit = screen.getByRole('button', { name: /Submitting…/ });
    expect(submit).toBeDisabled();
    // The fieldset is also disabled, preventing any input changes.
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeDisabled();
  });

  it('a single submit click produces exactly one answer command', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ data: { run: { id: 'run-1' } } });
    mocks.useAnswerMissionRun.mockReturnValue({ ...defaultMutation(), mutateAsync });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await act(async () => {});
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  // ── VAL-MODEQ-073: Stale run version is rejected ─────────────────────
  it('shows a refresh message on 412 RUN_VERSION_MISMATCH without applying', async () => {
    const mutateAsync = vi.fn().mockRejectedValue({
      status: 412,
      body: { code: 'RUN_VERSION_MISMATCH' },
    });
    mocks.useAnswerMissionRun.mockReturnValue({ ...defaultMutation(), mutateAsync });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await act(async () => {});
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/changed|refresh/i);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });

  // ── VAL-MODEQ-082: Reload restores open questions ────────────────────
  it('restores a local draft from sessionStorage after remount (reload)', () => {
    const { unmount } = renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    // Edit the text field away from the default ('').
    const text = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'my reload-safe draft' } });
    expect(text).toHaveValue('my reload-safe draft');
    // The draft should be in sessionStorage.
    const keys = Object.keys(sessionStorage).filter((k) => k.includes('question-answer'));
    expect(keys.length).toBeGreaterThan(0);
    unmount();
    // Re-render (simulating reload/navigation back).
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    const restored = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(restored).toHaveValue('my reload-safe draft');
  });

  // ── VAL-MODEQ-085: Reload after answering restores progress ──────────
  it('renders an answered set as non-editable with no submit control', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet({ status: 'answered' })}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    expect(screen.getByText('Answered')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit answers/ })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeDisabled();
  });

  // ── VAL-MODEQ-107: Waiting survives navigation ───────────────────────
  it('restores the same open question set after navigation away and back', () => {
    const set = simpleQuestionSet({ id: 'set-nav', version: 2 });
    const { unmount } = renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    expect(screen.getByText(/Set 1 · version 2/)).toBeInTheDocument();
    unmount();
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    expect(screen.getByText(/Set 1 · version 2/)).toBeInTheDocument();
  });

  // ── VAL-MODEQ-108: Recoverable error preserves answers ───────────────
  it('preserves draft values and shows alert after a network error', async () => {
    const mutateAsync = vi.fn().mockRejectedValue({ status: 0, body: {} });
    mocks.useAnswerMissionRun.mockReturnValue({ ...defaultMutation(), mutateAsync });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    const text = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'preserved draft' } });
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await act(async () => {});
    // Error is shown with alert semantics.
    expect(screen.getByRole('alert').textContent).toMatch(/could not|try again|preserved/i);
    // Draft values are retained.
    expect(screen.getByRole('radio', { name: 'Yes' })).toBeChecked();
    expect(text).toHaveValue('preserved draft');
  });

  // ── VAL-MODEQ-109: No misleading optimistic resume ───────────────────
  it('does not mark the set answered or hide the form while submission is pending', () => {
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      isPending: true,
    });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    // The set is still open — no "Answered" badge, submit button present.
    expect(screen.queryByText('Answered')).not.toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Submitting…/ });
    expect(submit).toBeDisabled();
    // The question heading is still visible (the form is not hidden).
    expect(screen.getByRole('heading', { level: 4, name: /Questions/i })).toBeInTheDocument();
  });

  // ── VAL-MODEQ-118: Resume is transcript independent ──────────────────
  it('restores server defaults after clearing browser state (transcript independent)', () => {
    const set = simpleQuestionSet({
      id: 'set-ti',
      version: 1,
      questions: [
        {
          questionKey: 'choice',
          order: 1,
          type: 'single_choice',
          label: 'Which mode?',
          help: null,
          required: true,
          default: 'fast',
          options: [
            { key: 'fast', label: 'Fast' },
            { key: 'deep', label: 'Deep Work' },
          ],
          validation: null,
        },
      ],
    });
    const { unmount } = renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    // Edit away from default.
    fireEvent.click(screen.getByRole('radio', { name: 'Deep Work' }));
    expect(screen.getByRole('radio', { name: 'Deep Work' })).toBeChecked();
    // Clear all browser state.
    sessionStorage.clear();
    unmount();
    // Re-open in a fresh session: server defaults are restored.
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    expect(screen.getByRole('radio', { name: 'Fast' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Deep Work' })).not.toBeChecked();
  });

  // ── VAL-MODEQ-133: Lost answer responses recover with one command identity ──
  it('retains the idempotency key and invalidates the snapshot after a lost response', async () => {
    const mutateAsync = vi
      .fn()
      .mockRejectedValueOnce({ status: 0, body: {} })
      .mockResolvedValueOnce({ data: { run: { id: 'run-1' } } });
    mocks.useAnswerMissionRun.mockReturnValue({ ...defaultMutation(), mutateAsync });
    const { qc } = renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await act(async () => {});
    // The snapshot query was invalidated to check if the answer was applied.
    const snapshotInvalidated = invalidateSpy.mock.calls.some(([arg]) => {
      const key = (arg as { queryKey?: unknown[] }).queryKey;
      return (
        Array.isArray(key) &&
        key[0] === 'mission-run-snapshot' &&
        key[1] === 'c1' &&
        key[2] === 'p1' &&
        key[3] === 'run-1'
      );
    });
    expect(snapshotInvalidated).toBe(true);
    // Resubmit: the same idempotency key is reused (not a new one).
    invalidateSpy.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await act(async () => {});
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    const key1 = mutateAsync.mock.calls[0][0].idempotencyKey;
    const key2 = mutateAsync.mock.calls[1][0].idempotencyKey;
    expect(key1).toBeTruthy();
    expect(key2).toBe(key1);
  });

  // ── VAL-MODEQ-134: Unsubmitted question drafts are local and non-authoritative ──
  it('persists unsubmitted drafts to sessionStorage scoped by principal/run/set/version', () => {
    const mutateAsync = vi.fn();
    mocks.useAnswerMissionRun.mockReturnValue({ ...defaultMutation(), mutateAsync });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet({ id: 'set-scope', version: 2 })}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    const text = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'scoped draft' } });
    // The draft key includes principal, company, project, run, set, version.
    const draftKey = Object.keys(sessionStorage).find(
      (k) => k.includes('question-answer') && k.includes('user-1') && k.includes('run-1'),
    );
    expect(draftKey).toBeTruthy();
    expect(draftKey).toContain('set-scope');
    expect(draftKey).toContain('2');
    // No mutation was issued — the draft is non-authoritative.
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('clears the draft from sessionStorage on successful answer', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ data: { run: { id: 'run-1' } } });
    mocks.useAnswerMissionRun.mockReturnValue({ ...defaultMutation(), mutateAsync });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={simpleQuestionSet()}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    const text = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'to be cleared' } });
    expect(
      Object.keys(sessionStorage).filter((k) => k.includes('question-answer')).length,
    ).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await act(async () => {});
    expect(mutateAsync).toHaveBeenCalled();
    // The draft is cleared after successful submission.
    expect(Object.keys(sessionStorage).filter((k) => k.includes('question-answer')).length).toBe(0);
  });

  it('does not restore a draft for a different principal', () => {
    const set = simpleQuestionSet({ id: 'set-pi', version: 1 });
    const { unmount } = renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    const text = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'user-1 draft' } });
    unmount();
    // A different principal does not see user-1's draft.
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={3}
        principalId="user-2"
      />,
    );
    const restored = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(restored).toHaveValue(''); // default, not user-1's draft
  });

  // ── VAL-MODEQ-134 (version change): new set version does not reuse old draft ──
  it('does not restore a draft from a previous set version', () => {
    const setV1 = simpleQuestionSet({ id: 'set-v', version: 1 });
    const { unmount } = renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={setV1}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    const text = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    fireEvent.change(text, { target: { value: 'v1 draft' } });
    unmount();
    // A new version of the same set should not reuse the old draft.
    const setV2 = simpleQuestionSet({ id: 'set-v', version: 2 });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={setV2}
        stateVersion={3}
        principalId="user-1"
      />,
    );
    const restored = screen.getByRole('textbox', { name: 'Notes' }) as HTMLTextAreaElement;
    expect(restored).toHaveValue(''); // default for v2, not v1 draft
  });
});

// ── MissionRunList — question-load failure (VAL-MODEQ-143) ───────────────

describe('MissionRunList — question-load failure (VAL-MODEQ-143)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.useMissionRunsPaginated.mockReturnValue(listResult());
    mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult());
    mocks.useMissionRunEvents.mockReturnValue(eventsResult());
    mocks.useStartMissionRun.mockReturnValue(startResult());
    mocks.useMissionRunStream.mockReturnValue(streamResult());
    mocks.useCancelMissionRun.mockReturnValue(cancelMutationResult());
    mocks.useRetryMissionRun.mockReturnValue(retryMutationResult());
    mocks.useMissionRequestText.mockReturnValue(undefined);
    mocks.useSession.mockReturnValue(sessionResult());
    mocks.useMissionQuestionSets.mockReturnValue({
      data: { questionSets: [], nextCursor: null },
      isLoading: false,
      isError: false,
    });
    mocks.useAnswerMissionRun.mockReturnValue(defaultMutation());
  });

  afterEach(() => {
    sessionStorage.clear();
  });

  it('shows an accessible Retry when the snapshot fails and the run is awaiting input', () => {
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <MissionRunList companyId="c1" projectId="p1" requestTexts={{}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    // The run is awaiting input (from the list row), so the question-load
    // failure should show an accessible Retry, not an empty success.
    expect(screen.getByRole('heading', { name: 'Questions unavailable' })).toBeInTheDocument();
    // An accessible Retry button is present.
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();
  });

  it('does not render an empty question success when the snapshot load fails', () => {
    mocks.useMissionRunSnapshot.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: vi.fn(),
    });
    render(
      <MemoryRouter>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <MissionRunList companyId="c1" projectId="p1" requestTexts={{}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    // No question form is rendered (no submit button).
    expect(screen.queryByRole('button', { name: /Submit answers/ })).not.toBeInTheDocument();
  });
});

// ── Stream hook — question event dedup (VAL-MODEQ-086) ───────────────────

const hookQc = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
function hookWrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={hookQc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

class MockEventSourceClass {
  url: string;
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  listeners = new Map<string, Set<(ev: MessageEvent) => void>>();
  closeFn = vi.fn();
  static lastInstance: MockEventSourceClass | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSourceClass.lastInstance = this;
  }
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  close(): void {
    this.readyState = 2;
    this.closeFn();
  }
  simulateEvent(type: string, data: string, id: string): void {
    const msg = new MessageEvent(type, { data });
    Object.defineProperty(msg, 'lastEventId', { value: id });
    for (const fn of this.listeners.get(type) ?? []) {
      fn(msg);
    }
  }
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
}

describe('useMissionRunStream — question event dedup (VAL-MODEQ-086)', () => {
  let originalEventSource: typeof EventSource;

  beforeEach(() => {
    originalEventSource = global.EventSource;
    MockEventSourceClass.lastInstance = null;
    hookQc.clear();
  });
  afterEach(() => {
    global.EventSource = originalEventSource;
  });

  it('deduplicates questions.requested and questions.answered on reconnect', async () => {
    global.EventSource = MockEventSourceClass as unknown as typeof EventSource;
    const { result } = tlRenderHook(() => useMissionRunStreamReal('c1', 'p1', 'run-1'), {
      wrapper: hookWrapper,
    });
    await act(async () => {
      MockEventSourceClass.lastInstance?.simulateOpen();
    });
    const es = MockEventSourceClass.lastInstance!;
    // Initial replay: questions.requested at seq 2.
    await act(async () => {
      es.simulateEvent(
        'questions.requested',
        JSON.stringify({ sequence: 2, type: 'questions.requested' }),
        '2',
      );
    });
    expect(result.current.lastSequence).toBe(2);
    // questions.answered at seq 3.
    await act(async () => {
      es.simulateEvent(
        'questions.answered',
        JSON.stringify({ sequence: 3, type: 'questions.answered' }),
        '3',
      );
    });
    expect(result.current.lastSequence).toBe(3);
    // Reconnect: duplicate seq 2 and 3 arrive again — they are dropped.
    await act(async () => {
      es.simulateEvent(
        'questions.requested',
        JSON.stringify({ sequence: 2, type: 'questions.requested' }),
        '2',
      );
      es.simulateEvent(
        'questions.answered',
        JSON.stringify({ sequence: 3, type: 'questions.answered' }),
        '3',
      );
    });
    // Last sequence is still 3 — no duplication.
    expect(result.current.lastSequence).toBe(3);
    expect(result.current.gapDetected).toBe(false);
  });
});
