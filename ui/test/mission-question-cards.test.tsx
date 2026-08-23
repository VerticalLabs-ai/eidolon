import { render, screen, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionQuestionCard } from '../src/components/projects/MissionQuestionCard';
import { MissionQuestionHistory } from '../src/components/projects/MissionQuestionHistory';
import type { MissionCurrentQuestionSet } from '../src/lib/api';

const mocks = vi.hoisted(() => ({
  useAnswerMissionRun: vi.fn(),
  useMissionQuestionSets: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useAnswerMissionRun: mocks.useAnswerMissionRun,
    useMissionQuestionSets: mocks.useMissionQuestionSets,
  };
});

vi.mock('@/lib/ws', () => ({
  useServerEvents: vi.fn(),
  useWebSocket: () => ({ status: 'disconnected' }),
}));

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  );
}

function defaultMutation() {
  return {
    mutateAsync: vi.fn().mockResolvedValue({ data: { run: { id: 'run-1' } } }),
    isPending: false,
    isError: false,
    error: null,
  };
}

/** A complete question set exercising every supported type, in a known
 * persisted order. Order values are intentionally shuffled to verify the
 * card re-sorts to persisted order (VAL-MODEQ-045). */
function fullQuestionSet(): MissionCurrentQuestionSet {
  return {
    id: 'set-1',
    ordinal: 1,
    version: 3,
    status: 'open',
    invalidationReason: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    questions: [
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
  };
}

describe('MissionQuestionCard — typed question cards', () => {
  beforeEach(() => {
    mocks.useAnswerMissionRun.mockReturnValue(defaultMutation());
    mocks.useMissionQuestionSets.mockReturnValue({
      data: { questionSets: [], nextCursor: null },
      isLoading: false,
      isError: false,
    });
  });

  it('renders every type in persisted order (VAL-MODEQ-045)', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
      />,
    );
    const fields = screen.getAllByTestId(/^question-field-/);
    expect(fields.map((f) => f.getAttribute('data-testid'))).toEqual([
      'question-field-choice', // order 1
      'question-field-multi', // order 2
      'question-field-text', // order 3
      'question-field-num', // order 4
      'question-field-bool', // order 5
      'question-field-scale', // order 6
      'question-field-order', // order 7
    ]);
  });

  it('renders scale endpoint labels and current value (VAL-MODEQ-051)', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
      />,
    );
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    // Default value 3 is prepopulated and displayed.
    expect(screen.getByText(/Current value: 3/)).toBeInTheDocument();
    const range = screen.getByRole('slider', { name: 'Confidence' });
    expect(range).toHaveAttribute('min', '1');
    expect(range).toHaveAttribute('max', '5');
    expect(range).toHaveAttribute('step', '1');
  });

  it('persisted defaults are visibly prepopulated (VAL-MODEQ-054)', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
      />,
    );
    // single_choice default 'fast' is selected.
    expect(screen.getByRole('radio', { name: 'Fast' })).toBeChecked();
    // multiple_choice default ['search'] is checked.
    expect(screen.getByRole('checkbox', { name: 'Search' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Scrape' })).not.toBeChecked();
    // number default 4.
    expect(screen.getByRole('spinbutton', { name: 'How many steps?' })).toHaveValue(4);
    // boolean has no default → neither selected.
    expect(screen.getByRole('radio', { name: 'Yes' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'No' })).not.toBeChecked();
  });

  it('help text is present and associated with its control (VAL-MODEQ-053)', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
      />,
    );
    const help = screen.getByText('Pick one execution mode.');
    const radios = screen.getAllByRole('radio', { name: 'Fast' });
    // The help id is referenced by the group's aria-describedby.
    const group = radios[0].closest('[role="radiogroup"]');
    expect(group?.getAttribute('aria-describedby')).toContain(help.id);
  });

  it('editing a value marks it as a local draft without submitting (VAL-MODEQ-068)', () => {
    const mutateAsync = vi.fn().mockResolvedValue({ data: { run: { id: 'run-1' } } });
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      mutateAsync,
    });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
      />,
    );
    // Edit the number field away from the default (4 → 7).
    const num = screen.getByRole('spinbutton', { name: 'How many steps?' }) as HTMLInputElement;
    fireEvent.change(num, { target: { value: '7' } });
    expect(num).toHaveValue(7);
    // A draft indicator appears for the edited field.
    const field = screen.getByTestId('question-field-num');
    expect(within(field).getByText('Draft')).toBeInTheDocument();
    // No answer mutation has been issued yet.
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('submitting sends one atomic answer command with set id/version and If-Match', async () => {
    const mutateAsync = vi.fn().mockResolvedValue({ data: { run: { id: 'run-1' } } });
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      mutateAsync,
    });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
      />,
    );
    // Provide the required boolean answer (no default).
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.body.questionSetId).toBe('set-1');
    expect(arg.body.questionSetVersion).toBe(3);
    expect(arg.ifMatch).toBe(5);
    expect(arg.body.answers['bool']).toBe(true);
    // Defaults that were left unchanged are still submitted as explicit
    // values (they are part of the definition's default and the user
    // submitted the set).
    expect(arg.body.answers['choice']).toBe('fast');
  });

  it('a required unanswered question blocks submission and surfaces a field error', async () => {
    const mutateAsync = vi.fn();
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      mutateAsync,
    });
    // A set where the required boolean has no default and is left unanswered.
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await vi.waitFor(() =>
      expect(screen.getByText('This question is required.')).toBeInTheDocument(),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('an invalidated set is closed and non-actionable (VAL-MODEQ-076)', () => {
    const mutateAsync = vi.fn();
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      mutateAsync,
    });
    const set = fullQuestionSet();
    set.status = 'invalidated';
    set.invalidationReason = 'Replaced by a newer set.';
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={5}
      />,
    );
    // The invalidated badge and reason are shown.
    expect(screen.getByText('Invalidated')).toBeInTheDocument();
    expect(screen.getByText(/Replaced by a newer set\./)).toBeInTheDocument();
    // No submit control is rendered.
    expect(screen.queryByRole('button', { name: /Submit answers/ })).not.toBeInTheDocument();
    // All inputs are disabled.
    expect(screen.getByRole('slider', { name: 'Confidence' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: 'How many steps?' })).toBeDisabled();
  });

  it('ordering provides non-drag move controls and reorders on click (VAL-MODEQ-094)', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
      />,
    );
    // The persisted order is a, b, c.
    const field = screen.getByTestId('question-field-order');
    const rows = within(field).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Move "Step A" down using its move-down button.
    const moveDownA = within(rows[0]).getByRole('button', { name: /Move Step A down/ });
    fireEvent.click(moveDownA);
    const after = within(field).getAllByRole('listitem');
    expect(within(after[0]).getByText('Step B')).toBeInTheDocument();
    expect(within(after[1]).getByText('Step A')).toBeInTheDocument();
  });
});

describe('MissionQuestionHistory — reviewable history (VAL-MODEQ-110)', () => {
  beforeEach(() => {
    mocks.useAnswerMissionRun.mockReturnValue(defaultMutation());
  });

  it('renders an ordered, non-editable record of answered and invalidated sets', () => {
    mocks.useMissionQuestionSets.mockReturnValue({
      data: {
        questionSets: [
          {
            id: 'set-1',
            ordinal: 1,
            version: 2,
            status: 'answered',
            invalidationReason: null,
            promptContextHash: null,
            createdAt: '2026-08-23T10:00:00.000Z',
            answeredAt: '2026-08-23T10:05:00.000Z',
            invalidatedAt: null,
            questions: [
              {
                id: 'q1',
                questionKey: 'mode',
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
            answers: [
              {
                id: 'a1',
                questionKey: 'mode',
                answerRevision: 1,
                value: 'deep',
                contentHash: 'hash-1',
                actorType: 'user',
                actorId: 'user-1',
                createdAt: '2026-08-23T10:05:00.000Z',
              },
            ],
          },
          {
            id: 'set-2',
            ordinal: 2,
            version: 1,
            status: 'invalidated',
            invalidationReason: 'Replaced after scope change.',
            promptContextHash: null,
            createdAt: '2026-08-23T11:00:00.000Z',
            answeredAt: null,
            invalidatedAt: '2026-08-23T11:02:00.000Z',
            questions: [
              {
                id: 'q2',
                questionKey: 'notes',
                order: 1,
                type: 'text',
                label: 'Notes',
                help: null,
                required: false,
                default: '',
                options: null,
                validation: { maxLength: 200 },
              },
            ],
            answers: [],
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<MissionQuestionHistory companyId="c1" projectId="p1" runId="run-1" />);
    expect(screen.getByText('Question history')).toBeInTheDocument();
    // Answered set shows the accepted answer value, not the default.
    expect(screen.getByText('Deep Work')).toBeInTheDocument();
    // Invalidated set shows the closure reason and no editable controls.
    expect(screen.getByText(/Replaced after scope change\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submit answers/ })).not.toBeInTheDocument();
    // Unsubmitted defaults are not shown as submitted values: the
    // invalidated set's optional 'Notes' question shows an em dash.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders nothing when there is no history', () => {
    mocks.useMissionQuestionSets.mockReturnValue({
      data: { questionSets: [], nextCursor: null },
      isLoading: false,
      isError: false,
    });
    const { container } = renderWithProviders(
      <MissionQuestionHistory companyId="c1" projectId="p1" runId="run-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows restricted marker for redacted viewer answer values', () => {
    mocks.useMissionQuestionSets.mockReturnValue({
      data: {
        questionSets: [
          {
            id: 'set-1',
            ordinal: 1,
            version: 1,
            status: 'answered',
            invalidationReason: null,
            promptContextHash: null,
            createdAt: '2026-08-23T10:00:00.000Z',
            answeredAt: '2026-08-23T10:05:00.000Z',
            invalidatedAt: null,
            questions: [
              {
                id: 'q1',
                questionKey: 'secret',
                order: 1,
                type: 'text',
                label: 'Secret',
                help: null,
                required: true,
                default: '',
                options: null,
                validation: null,
              },
            ],
            answers: [
              {
                id: 'a1',
                questionKey: 'secret',
                answerRevision: 1,
                value: { redacted: true },
                contentHash: 'hash-1',
                actorType: 'user',
                actorId: 'user-1',
                createdAt: '2026-08-23T10:05:00.000Z',
              },
            ],
          },
        ],
        nextCursor: null,
      },
      isLoading: false,
      isError: false,
    });
    renderWithProviders(<MissionQuestionHistory companyId="c1" projectId="p1" runId="run-1" />);
    expect(screen.getByText(/restricted/)).toBeInTheDocument();
  });
});
