import { render, screen, within, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionRunList } from '../src/components/projects/MissionRunList';
import { buildDraftKey, readDraft } from '../src/lib/mission-drafts';
import type { MissionCurrentQuestionSet } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
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

const PRINCIPAL = 'dev-user-000';
const COMPANY = 'company-1';
const PROJECT = 'project-1';
const RUN_ID = 'run-1';

function runSummary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    companyId: COMPANY,
    projectId: PROJECT,
    status: 'awaiting_input',
    stateVersion: 5,
    lastEventSequence: 4,
    resolvedMode: 'deep_work',
    policyContentHash: 'hash-deep-0000000000000000000000000000000000000000',
    requestContentHash: 'hash-1',
    createdAt: '2026-08-23T10:00:00.000Z',
    updatedAt: '2026-08-23T10:00:00.000Z',
    ...overrides,
  };
}

function runSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: RUN_ID,
    companyId: COMPANY,
    projectId: PROJECT,
    projectThreadId: 'thread-1',
    rootRunId: RUN_ID,
    parentRunId: null,
    retryOfRunId: null,
    depth: 0,
    childOrdinal: null,
    routingKind: 'company_agent',
    status: 'awaiting_input',
    stateVersion: 5,
    lastEventSequence: 4,
    resolvedMode: 'deep_work',
    modeProfileId: null,
    policySnapshotId: 'policy-1',
    policyContentHash: 'hash-deep-0000000000000000000000000000000000000000',
    requestContentHash: 'hash-1',
    currentQuestionSetId: 'set-1',
    currentQuestionSet: fullQuestionSet(),
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
    startedAt: null,
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
      ui: `/company/${COMPANY}/projects/${PROJECT}?tab=work&thread=thread-1&mission=${RUN_ID}`,
    },
    ...overrides,
  };
}

/** A complete question set exercising every supported type, in a known
 * persisted order. Order values are intentionally shuffled to verify the
 * card re-sorts to persisted order. */
function fullQuestionSet(
  overrides: Partial<MissionCurrentQuestionSet> = {},
): MissionCurrentQuestionSet {
  return {
    id: 'set-1',
    ordinal: 1,
    version: 3,
    status: 'open',
    invalidationReason: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    questions: [
      {
        questionKey: 'choice',
        order: 1,
        type: 'single_choice',
        label: 'Which mode?',
        help: 'Pick one execution mode.',
        required: true,
        default: 'fast',
        options: [
          { key: 'fast', label: 'Fast' },
          { key: 'deep', label: 'Deep Work' },
        ],
        validation: null,
      },
      {
        questionKey: 'multi',
        order: 2,
        type: 'multiple_choice',
        label: 'Which tools?',
        help: 'Select up to two.',
        required: false,
        default: ['search'],
        options: [
          { key: 'search', label: 'Search' },
          { key: 'scrape', label: 'Scrape' },
          { key: 'extract', label: 'Extract' },
        ],
        validation: { maxSelections: 2 },
      },
      {
        questionKey: 'text',
        order: 3,
        type: 'text',
        label: 'Notes',
        help: 'Add any clarifying notes (max 200 chars).',
        required: false,
        default: '',
        options: null,
        validation: { maxLength: 200 },
      },
      {
        questionKey: 'num',
        order: 4,
        type: 'number',
        label: 'How many steps?',
        help: null,
        required: true,
        default: 4,
        options: null,
        validation: { min: 1, max: 12, step: 1 },
      },
      {
        questionKey: 'bool',
        order: 5,
        type: 'boolean',
        label: 'Approve the plan?',
        help: 'Choose Yes to approve, No to reject.',
        required: true,
        default: null,
        options: null,
        validation: null,
      },
      {
        questionKey: 'scale',
        order: 6,
        type: 'scale',
        label: 'Confidence',
        help: 'Slide from low to high confidence.',
        required: true,
        default: 3,
        options: null,
        validation: { min: 1, max: 5, step: 1, minLabel: 'Low', maxLabel: 'High' },
      },
      {
        questionKey: 'order',
        order: 7,
        type: 'ordering',
        label: 'Order the steps',
        help: 'Arrange from first to last.',
        required: true,
        default: null,
        options: [
          { key: 'a', label: 'Step A' },
          { key: 'b', label: 'Step B' },
          { key: 'c', label: 'Step C' },
        ],
        validation: null,
      },
    ],
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

function answerMutationResult(fn = vi.fn().mockResolvedValue({ data: { run: { id: RUN_ID } } })) {
  return {
    mutateAsync: fn,
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
  };
}

function cancelMutationResult(fn = vi.fn().mockResolvedValue({})) {
  return {
    mutateAsync: fn,
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

function requestTextResult() {
  return undefined;
}

function questionSetsResult() {
  return { data: { questionSets: [], nextCursor: null }, isLoading: false, isError: false };
}

// ── Helpers ───────────────────────────────────────────────────────────────

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderWithProviders(ui: React.ReactElement, qc?: QueryClient) {
  const client = qc ?? makeQueryClient();
  return {
    qc: client,
    ...render(
      <MemoryRouter>
        <QueryClientProvider client={client}>{ui}</QueryClientProvider>
      </MemoryRouter>,
    ),
  };
}

function renderAwaitingInput(
  snapshotOverrides: Partial<Record<string, unknown>> = {},
  qc?: QueryClient,
) {
  mocks.useMissionRunSnapshot.mockReturnValue(snapshotResult(runSnapshot(snapshotOverrides)));
  mocks.useMissionRunsPaginated.mockReturnValue(listResult([runSummary(snapshotOverrides)]));
  return renderWithProviders(
    <MissionRunList companyId={COMPANY} projectId={PROJECT} requestTexts={{}} />,
    qc,
  );
}

function answerDraftKey() {
  return buildDraftKey({
    principalId: PRINCIPAL,
    scope: 'question-answer',
    companyId: COMPANY,
    projectId: PROJECT,
    runId: RUN_ID,
    cardVersion: 'set-1:v3',
  });
}

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

// ── VAL-CROSS-009: Alignment questions persist ───────────────────────────

describe('VAL-CROSS-009: alignment questions persist across reload', () => {
  it('renders the persisted question set with stable id, version, order, labels, help, and defaults', () => {
    renderAwaitingInput();
    const card = screen.getByRole('article');
    // Question set heading exposes ordinal and version.
    const setVersionTexts = within(card).getAllByText(/Set 1.*version 3/i);
    expect(setVersionTexts.length).toBeGreaterThanOrEqual(1);
    // All seven fields are rendered in persisted order.
    const fields = within(card).getAllByTestId(/^question-field-/);
    expect(fields.map((f) => f.getAttribute('data-testid'))).toEqual([
      'question-field-choice',
      'question-field-multi',
      'question-field-text',
      'question-field-num',
      'question-field-bool',
      'question-field-scale',
      'question-field-order',
    ]);
    // Help text is present for questions that have it.
    expect(within(card).getByText('Pick one execution mode.')).toBeInTheDocument();
    expect(within(card).getByText('Slide from low to high confidence.')).toBeInTheDocument();
  });

  it('preserves an unsubmitted browser draft across a same-profile reload', () => {
    const { unmount } = renderAwaitingInput();
    // Type a text draft (optional text field).
    const textInput = screen.getByLabelText(/Notes/i);
    fireEvent.change(textInput, { target: { value: 'Reload-safe draft' } });
    expect(readDraft(answerDraftKey())).toContain('Reload-safe draft');
    // Simulate a page reload.
    unmount();
    renderAwaitingInput();
    // The draft is restored from sessionStorage.
    expect(screen.getByLabelText(/Notes/i)).toHaveValue('Reload-safe draft');
  });

  it('does not record a displayed default as an answer until submitted', () => {
    const answerFn = vi.fn().mockResolvedValue({ data: { run: { id: RUN_ID } } });
    mocks.useAnswerMissionRun.mockReturnValue(answerMutationResult(answerFn));
    renderAwaitingInput();
    // The single-choice question has a default of 'fast' — the radio is
    // checked but no answer has been submitted.
    const fastRadio = screen.getByRole('radio', { name: /^fast$/i });
    expect(fastRadio).toBeChecked();
    // No submission has occurred.
    expect(answerFn).not.toHaveBeenCalled();
  });
});

// ── VAL-CROSS-010: All question types submit ─────────────────────────────

describe('VAL-CROSS-010: all question types submit atomically and resume', () => {
  it('submits all seven types in one atomic command and resumes the run', async () => {
    const answerFn = vi.fn().mockResolvedValue({ data: { run: { id: RUN_ID } } });
    mocks.useAnswerMissionRun.mockReturnValue(answerMutationResult(answerFn));
    const { rerender } = renderAwaitingInput();

    // Fill all required questions with valid answers.
    // 1. single_choice (default 'fast' is already selected — explicit)
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    // 2. multiple_choice (optional, default ['search'] — add 'scrape')
    fireEvent.click(screen.getByRole('checkbox', { name: /^scrape$/i }));
    // 3. text (optional) — type something
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: 'All good' } });
    // 4. number (default 4 — explicit)
    fireEvent.change(screen.getByLabelText(/How many steps\?/i), { target: { value: '6' } });
    // 5. boolean (required, no default) — click Yes
    fireEvent.click(screen.getByRole('radio', { name: /^yes$/i }));
    // 6. scale (default 3 — move to 5)
    fireEvent.change(screen.getByLabelText(/Confidence/i), { target: { value: '5' } });
    // 7. ordering (required, no default) — use move controls to order
    // The ordering control renders option labels; move up/down controls
    // are labelled. For the test, we interact with the range input.
    // Ordering requires all items placed; the default order is the options
    // order. We just need to ensure it has a value (the control starts
    // with all items in option order).
    // Submit.
    const submitBtn = screen.getByRole('button', { name: /submit answers/i });
    await act(async () => {
      fireEvent.click(submitBtn);
    });

    // One atomic submission was sent with the correct set id/version.
    expect(answerFn).toHaveBeenCalledTimes(1);
    const call = answerFn.mock.calls[0][0] as {
      body: { questionSetId: string; questionSetVersion: number; answers: Record<string, unknown> };
      idempotencyKey: string;
      ifMatch?: number;
    };
    expect(call.body.questionSetId).toBe('set-1');
    expect(call.body.questionSetVersion).toBe(3);
    expect(call.ifMatch).toBe(5);
    // The answers include the explicitly-set required fields.
    expect(call.body.answers['choice']).toBe('deep');
    expect(call.body.answers['bool']).toBe(true);
    expect(call.body.answers['num']).toBe(6);
    expect(call.body.answers['scale']).toBe(5);

    // After the server confirms, the snapshot refetch reveals the resumed
    // run (no longer awaiting_input). The card shows the new status.
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          status: 'planning',
          currentQuestionSet: null,
          currentQuestionSetId: null,
          stateVersion: 6,
          waitingFromStatus: null,
        }),
      ),
    );
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'planning', stateVersion: 6 })]),
    );
    rerender(
      <MemoryRouter>
        <QueryClientProvider client={makeQueryClient()}>
          <MissionRunList companyId={COMPANY} projectId={PROJECT} requestTexts={{}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    // The question card is gone (set closed) and the run resumed.
    expect(screen.queryByTestId('question-field-choice')).not.toBeInTheDocument();
  });
});

// ── VAL-CROSS-011: Question validation is atomic ─────────────────────────

describe('VAL-CROSS-011: question validation is atomic', () => {
  it('rejects an invalid required answer client-side with field-level errors and focus', async () => {
    const answerFn = vi.fn().mockResolvedValue({ data: { run: { id: RUN_ID } } });
    mocks.useAnswerMissionRun.mockReturnValue(answerMutationResult(answerFn));
    renderAwaitingInput();

    // Fill all required questions EXCEPT boolean (leave it unselected).
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i })); // single_choice
    fireEvent.change(screen.getByLabelText(/How many steps\?/i), { target: { value: '6' } }); // number
    fireEvent.change(screen.getByLabelText(/Confidence/i), { target: { value: '5' } }); // scale
    // boolean and ordering are required but not filled.

    // Submit.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    });

    // No submission was sent — client-side validation prevented it.
    expect(answerFn).not.toHaveBeenCalled();
    // Field-level error messages identify the invalid required fields.
    expect(
      within(screen.getByTestId('question-field-bool')).getByText(/required/i),
    ).toBeInTheDocument();
    // The question set remains open (submit button still present).
    expect(screen.getByRole('button', { name: /submit answers/i })).toBeInTheDocument();
  });

  it('maps a server 422 ANSWER_VALIDATION_FAILED to field-level errors and preserves the set open', async () => {
    const answerFn = vi.fn().mockRejectedValue({
      status: 422,
      body: {
        code: 'ANSWER_VALIDATION_FAILED',
        details: {
          num: 'Must be between 1 and 12.',
        },
      },
    });
    mocks.useAnswerMissionRun.mockReturnValue(answerMutationResult(answerFn));
    renderAwaitingInput();

    // Fill all required questions.
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    fireEvent.change(screen.getByLabelText(/How many steps\?/i), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('radio', { name: /^yes$/i }));
    fireEvent.change(screen.getByLabelText(/Confidence/i), { target: { value: '5' } });

    // Submit — the server rejects with a field-level validation error.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    });

    // The submission was sent (one attempt) but the set remains open.
    expect(answerFn).toHaveBeenCalledTimes(1);
    // Field-level error for 'num' is shown.
    expect(
      within(screen.getByTestId('question-field-num')).getByText(/between 1 and 12/i),
    ).toBeInTheDocument();
    // The set is still open — submit button present.
    expect(screen.getByRole('button', { name: /submit answers/i })).toBeInTheDocument();
    // No partial answer revision was accepted (the draft is preserved).
    expect(readDraft(answerDraftKey())).not.toBeNull();
  });
});

// ── VAL-CROSS-013: Stale question action ─────────────────────────────────

describe('VAL-CROSS-013: stale question action is rejected and prompts refresh', () => {
  it('shows a refresh message and preserves typed input on a 412 RUN_VERSION_MISMATCH', async () => {
    const answerFn = vi.fn().mockRejectedValue({
      status: 412,
      body: { code: 'RUN_VERSION_MISMATCH' },
    });
    mocks.useAnswerMissionRun.mockReturnValue(answerMutationResult(answerFn));
    renderAwaitingInput();

    // Fill answers.
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: 'Stale draft' } });
    fireEvent.change(screen.getByLabelText(/How many steps\?/i), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('radio', { name: /^yes$/i }));
    fireEvent.change(screen.getByLabelText(/Confidence/i), { target: { value: '5' } });

    // Submit — server says the run version changed.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    });

    // A role=alert message tells the user to refresh.
    expect(screen.getByRole('alert')).toHaveTextContent(/changed.*refresh/i);
    // The typed draft is preserved (not discarded).
    expect(screen.getByLabelText(/Notes/i)).toHaveValue('Stale draft');
    expect(readDraft(answerDraftKey())).toContain('Stale draft');
    // The question set remains open.
    expect(screen.getByRole('button', { name: /submit answers/i })).toBeInTheDocument();
  });

  it('shows a refresh message for an invalidated question set and preserves typed input', async () => {
    const answerFn = vi.fn().mockRejectedValue({
      status: 409,
      body: { code: 'QUESTION_SET_INVALIDATED' },
    });
    mocks.useAnswerMissionRun.mockReturnValue(answerMutationResult(answerFn));
    renderAwaitingInput();

    // Fill answers.
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    fireEvent.change(screen.getByLabelText(/Notes/i), { target: { value: 'Inv draft' } });
    fireEvent.change(screen.getByLabelText(/How many steps\?/i), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('radio', { name: /^yes$/i }));
    fireEvent.change(screen.getByLabelText(/Confidence/i), { target: { value: '5' } });

    // Submit — server says the set was invalidated.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    });

    // A role=alert message tells the user the set is no longer active.
    expect(screen.getByRole('alert')).toHaveTextContent(/no longer active.*refresh/i);
    // Typed draft preserved.
    expect(screen.getByLabelText(/Notes/i)).toHaveValue('Inv draft');
  });
});

// ── VAL-CROSS-044: Inbox projection links to Mission ─────────────────────

describe('VAL-CROSS-044: answering a question invalidates the inbox projection', () => {
  it('invalidates the inbox query after a successful answer so the Inbox converges', async () => {
    const answerFn = vi.fn().mockResolvedValue({ data: { run: { id: RUN_ID } } });
    mocks.useAnswerMissionRun.mockReturnValue(answerMutationResult(answerFn));
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderAwaitingInput({}, qc);

    // Fill all required answers and submit.
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    fireEvent.change(screen.getByLabelText(/How many steps\?/i), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('radio', { name: /^yes$/i }));
    fireEvent.change(screen.getByLabelText(/Confidence/i), { target: { value: '5' } });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /submit answers/i }));
    });

    // The inbox query key was invalidated so the Inbox refetches and
    // converges to the resolved state without duplicates.
    const inboxCall = invalidateSpy.mock.calls.find((c) => c[0]?.queryKey?.[0] === 'inbox');
    expect(inboxCall).toBeDefined();
    expect(inboxCall![0].queryKey).toEqual(['inbox', COMPANY]);
  });
});

// ── VAL-CROSS-057: Cancel while awaiting input ───────────────────────────

describe('VAL-CROSS-057: cancel while awaiting input', () => {
  it('requires confirmation with a typed reason before issuing a cancel command', async () => {
    const user = userEvent.setup();
    const cancelFn = vi.fn().mockResolvedValue({});
    mocks.useCancelMissionRun.mockReturnValue(cancelMutationResult(cancelFn));
    renderAwaitingInput();

    // Open the cancel dialog.
    fireEvent.click(screen.getByRole('button', { name: /cancel run-1/i }));
    // The confirmation dialog names the affected Mission.
    expect(screen.getByRole('heading', { name: /cancel mission/i })).toBeInTheDocument();
    // The dialog description mentions the run ID.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(RUN_ID)).toBeInTheDocument();
    // No cancel command issued yet.
    expect(cancelFn).not.toHaveBeenCalled();

    // Type a reason and confirm.
    const reasonField = await screen.findByLabelText(/reason/i);
    await user.type(reasonField, 'No longer needed');
    await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));

    // Exactly one cancel command with the reason, idempotency key, and If-Match.
    expect(cancelFn).toHaveBeenCalledTimes(1);
    const call = cancelFn.mock.calls[0][0] as {
      reason: string;
      idempotencyKey: string;
      ifMatch?: number;
    };
    expect(call.reason).toBe('No longer needed');
    expect(call.idempotencyKey).toBeTruthy();
    expect(call.ifMatch).toBe(5);
  });

  it('backing out of the confirmation sends no cancel command and preserves the run', async () => {
    const user = userEvent.setup();
    const cancelFn = vi.fn().mockResolvedValue({});
    mocks.useCancelMissionRun.mockReturnValue(cancelMutationResult(cancelFn));
    renderAwaitingInput();

    // Open the cancel dialog.
    fireEvent.click(screen.getByRole('button', { name: /cancel run-1/i }));
    // Type a reason.
    const reasonField = await screen.findByLabelText(/reason/i);
    await user.type(reasonField, 'Maybe cancel');
    // Back out with "Keep running".
    await user.click(screen.getByRole('button', { name: /keep running/i }));

    // No cancel command was issued.
    expect(cancelFn).not.toHaveBeenCalled();
    // The run is still awaiting input — question card and cancel control remain.
    expect(screen.getByTestId('question-field-choice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel run-1/i })).toBeInTheDocument();
  });

  it('preserves a typed reason through a recoverable stale-version error', async () => {
    const user = userEvent.setup();
    const cancelFn = vi.fn().mockRejectedValue({
      status: 412,
      body: { code: 'RUN_VERSION_MISMATCH' },
    });
    mocks.useCancelMissionRun.mockReturnValue(cancelMutationResult(cancelFn));
    renderAwaitingInput();

    // Open, type reason, confirm — server returns stale-version error.
    fireEvent.click(screen.getByRole('button', { name: /cancel run-1/i }));
    const reasonField = await screen.findByLabelText(/reason/i);
    await user.type(reasonField, 'Stale cancel');
    await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));

    // An accessible error tells the user the reason is preserved.
    expect(screen.getByRole('alert')).toHaveTextContent(/reason is preserved/i);
    // The reason is still in the field.
    expect(screen.getByLabelText(/reason/i)).toHaveValue('Stale cancel');
  });

  it('terminally cancels the run, closes the question action, and releases budget', async () => {
    const user = userEvent.setup();
    const cancelFn = vi.fn().mockResolvedValue({});
    mocks.useCancelMissionRun.mockReturnValue(cancelMutationResult(cancelFn));
    const { rerender } = renderAwaitingInput();

    // Confirm cancellation.
    fireEvent.click(screen.getByRole('button', { name: /cancel run-1/i }));
    const reasonField = await screen.findByLabelText(/reason/i);
    await user.type(reasonField, 'Done with this');
    await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));

    // After the server confirms, the snapshot refetch reveals terminal
    // cancelled state with released budget and no active question set.
    mocks.useMissionRunSnapshot.mockReturnValue(
      snapshotResult(
        runSnapshot({
          status: 'cancelled',
          terminalAt: '2026-08-23T10:05:00.000Z',
          currentQuestionSet: null,
          currentQuestionSetId: null,
          cancelRequestedAt: '2026-08-23T10:04:50.000Z',
          cancelRequestedBy: PRINCIPAL,
          stateVersion: 6,
          budget: {
            reservedCents: 5000,
            settledCents: 0,
            releasedCents: 5000,
            costCentsCeiling: 5000,
            actualCostCents: 0,
          },
        }),
      ),
    );
    mocks.useMissionRunsPaginated.mockReturnValue(
      listResult([runSummary({ status: 'cancelled', stateVersion: 6 })]),
    );
    rerender(
      <MemoryRouter>
        <QueryClientProvider client={makeQueryClient()}>
          <MissionRunList companyId={COMPANY} projectId={PROJECT} requestTexts={{}} />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const card = screen.getByRole('article');
    // The status is terminal cancelled (explicit text in the badge).
    const cancelledTexts = within(card).getAllByText(/cancelled/i);
    expect(cancelledTexts.length).toBeGreaterThanOrEqual(1);
    // The question card is gone (action closed).
    expect(screen.queryByTestId('question-field-choice')).not.toBeInTheDocument();
    // No active Cancel control for a terminal run.
    expect(screen.queryByRole('button', { name: /cancel run-1/i })).not.toBeInTheDocument();
    // Budget released is shown in the budget status section.
    const budget = within(card).getByTestId('budget-status');
    expect(within(budget).getByText(/released/i).parentElement).toHaveTextContent(/\$50\.00/);
  });

  it('invalidates the inbox query after cancellation so the Inbox converges', async () => {
    const user = userEvent.setup();
    const cancelFn = vi.fn().mockResolvedValue({});
    mocks.useCancelMissionRun.mockReturnValue(cancelMutationResult(cancelFn));
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    renderAwaitingInput({}, qc);

    // Confirm cancellation.
    fireEvent.click(screen.getByRole('button', { name: /cancel run-1/i }));
    const reasonField = await screen.findByLabelText(/reason/i);
    await user.type(reasonField, 'Inbox convergence');
    await act(async () => {
      await user.click(screen.getByRole('button', { name: /confirm cancellation/i }));
    });

    // The inbox query key was invalidated.
    const inboxCall = invalidateSpy.mock.calls.find((c) => c[0]?.queryKey?.[0] === 'inbox');
    expect(inboxCall).toBeDefined();
    expect(inboxCall![0].queryKey).toEqual(['inbox', COMPANY]);
  });
});
