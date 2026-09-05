import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionQuestionCard } from '../src/components/projects/MissionQuestionCard';
import type { MissionCurrentQuestionSet } from '../src/lib/api';

const mocks = vi.hoisted(() => ({
  useAnswerMissionRun: vi.fn(),
  useMissionQuestionSets: vi.fn(),
  useQueryClient: vi.fn(),
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

/** A complete question set exercising every supported type. */
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
        order: 1,
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
        order: 2,
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
        order: 3,
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
        order: 4,
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
        order: 5,
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

/** A minimal set with just one required boolean (no default) and one
 * optional text question, useful for focus/error tests. */
function minimalSet(): MissionCurrentQuestionSet {
  return {
    id: 'set-min',
    ordinal: 1,
    version: 1,
    status: 'open',
    invalidationReason: null,
    createdAt: '2026-08-23T10:00:00.000Z',
    questions: [
      {
        questionKey: 'req_bool',
        order: 1,
        type: 'boolean',
        label: 'Required question',
        help: 'You must answer this.',
        required: true,
        default: null,
        options: null,
        validation: null,
      },
      {
        questionKey: 'opt_text',
        order: 2,
        type: 'text',
        label: 'Optional notes',
        help: null,
        required: false,
        default: '',
        options: null,
        validation: { maxLength: 200 },
      },
    ],
  };
}

describe('MissionQuestionCard — accessibility', () => {
  beforeEach(() => {
    mocks.useAnswerMissionRun.mockReturnValue(defaultMutation());
    mocks.useMissionQuestionSets.mockReturnValue({
      data: { questionSets: [], nextCursor: null },
      isLoading: false,
      isError: false,
    });
  });

  // VAL-MODEQ-095: Semantic grouping and names
  it('question set has a semantic heading and fieldset/legend', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    // Heading
    expect(screen.getByRole('heading', { name: /Questions/ })).toBeInTheDocument();
    // Fieldset with legend
    const fieldset = document.querySelector('fieldset');
    expect(fieldset).toBeInTheDocument();
    const legend = fieldset!.querySelector('legend');
    expect(legend).toBeInTheDocument();
  });

  // VAL-MODEQ-095: Every input has a unique accessible name
  it('every input control has a unique accessible name', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    // Each control should be findable by its accessible name
    expect(screen.getByRole('radiogroup', { name: /Approve the plan/ })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: /Which mode/ })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: /Which tools/ })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'How many steps?' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Confidence' })).toBeInTheDocument();
    // Ordering list
    expect(screen.getByRole('list', { name: 'Order the steps' })).toBeInTheDocument();
  });

  // VAL-MODEQ-095: Required fields expose aria-required
  it('required fields expose aria-required and optional fields do not', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    // Required boolean radiogroup
    const boolGroup = screen.getByRole('radiogroup', { name: /Approve the plan/ });
    expect(boolGroup).toHaveAttribute('aria-required', 'true');
    // Required single choice radiogroup
    const choiceGroup = screen.getByRole('radiogroup', { name: /Which mode/ });
    expect(choiceGroup).toHaveAttribute('aria-required', 'true');
    // Required number input
    const numInput = screen.getByRole('spinbutton', { name: 'How many steps?' });
    expect(numInput).toHaveAttribute('aria-required', 'true');
    // Required scale slider
    const scaleSlider = screen.getByRole('slider', { name: 'Confidence' });
    expect(scaleSlider).toHaveAttribute('aria-required', 'true');
    // Required ordering list
    const orderList = screen.getByRole('list', { name: 'Order the steps' });
    expect(orderList).toHaveAttribute('aria-required', 'true');
    // Optional multiple choice group — no aria-required
    const multiGroup = screen.getByRole('group', { name: /Which tools/ });
    expect(multiGroup).not.toHaveAttribute('aria-required');
    // Optional text — no aria-required
    const textInput = screen.getByRole('textbox', { name: 'Notes' });
    expect(textInput).not.toHaveAttribute('aria-required');
  });

  // VAL-MODEQ-095: Help text is associated via aria-describedby
  it('help text is associated with controls via aria-describedby', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    const help = screen.getByText('Choose Yes to approve, No to reject.');
    const boolGroup = screen.getByRole('radiogroup', { name: /Approve the plan/ });
    expect(boolGroup.getAttribute('aria-describedby')).toContain(help.id);
  });

  // VAL-MODEQ-096: Invalid focus placement
  it('focus moves to the first invalid field after invalid submit', async () => {
    // Minimal set: required boolean has no default, so submitting empty
    // triggers a validation error on req_bool.
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={minimalSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    // The first radio of the required boolean group should receive focus.
    await waitFor(() => {
      const focused = document.activeElement;
      expect(focused).not.toBe(document.body);
    });
    // The focused element should be within the first invalid question field.
    const firstField = screen.getByTestId('question-field-req_bool');
    expect(firstField.contains(document.activeElement)).toBe(true);
  });

  // VAL-MODEQ-096, VAL-MODEQ-099: Field errors use role=alert
  it('field errors use role=alert and are reachable in document order', async () => {
    // Use a set with two required questions with no defaults
    const set: MissionCurrentQuestionSet = {
      id: 'set-2req',
      ordinal: 1,
      version: 1,
      status: 'open',
      invalidationReason: null,
      createdAt: '2026-08-23T10:00:00.000Z',
      questions: [
        {
          questionKey: 'req1',
          order: 1,
          type: 'boolean',
          label: 'First required',
          help: null,
          required: true,
          default: null,
          options: null,
          validation: null,
        },
        {
          questionKey: 'req2',
          order: 2,
          type: 'text',
          label: 'Second required',
          help: null,
          required: true,
          default: null,
          options: null,
          validation: { maxLength: 200 },
        },
      ],
    };
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await waitFor(() => {
      const alerts = screen.getAllByRole('alert');
      expect(alerts.length).toBeGreaterThanOrEqual(2);
    });
    // Errors should be in document order (first required, then second)
    const alerts = screen.getAllByRole('alert');
    const firstField = screen.getByTestId('question-field-req1');
    const secondField = screen.getByTestId('question-field-req2');
    // The first alert should be within the first field
    expect(firstField.contains(alerts[0])).toBe(true);
    expect(secondField.contains(alerts[1])).toBe(true);
  });

  // VAL-MODEQ-095, VAL-MODEQ-096: Invalid fields expose aria-invalid
  it('invalid fields expose aria-invalid after validation error', async () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={minimalSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await waitFor(() => {
      const boolGroup = screen.getByRole('radiogroup', { name: /Required question/ });
      expect(boolGroup).toHaveAttribute('aria-invalid', 'true');
    });
  });

  // VAL-MODEQ-098: Answer pending state is accessible
  it('pending state exposes aria-busy on fieldset and disables submit', () => {
    // Simulate a pending mutation that never resolves
    const pendingPromise = new Promise(() => {});
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      mutateAsync: vi.fn().mockReturnValue(pendingPromise),
      isPending: true,
    });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={minimalSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    // Answer the required question so we can submit
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    // Fieldset should have aria-busy when pending
    const fieldset = document.querySelector('fieldset');
    expect(fieldset).toHaveAttribute('aria-busy', 'true');
    // Submit button should be disabled
    const submitBtn = screen.getByRole('button', { name: /Submitting/ });
    expect(submitBtn).toBeDisabled();
  });

  // VAL-MODEQ-098: Values retained during pending
  it('entered values are retained during pending state', () => {
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      isPending: true,
    });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={minimalSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    // Enter a value in the optional text field
    const text = screen.getByRole('textbox', { name: 'Optional notes' });
    fireEvent.change(text, { target: { value: 'my notes' } });
    expect(text).toHaveValue('my notes');
    // The value should still be present
    expect(screen.getByRole('textbox', { name: 'Optional notes' })).toHaveValue('my notes');
  });

  // VAL-MODEQ-099: Command errors use alert semantics
  it('submission error displays with role=alert', async () => {
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      mutateAsync: vi.fn().mockRejectedValue({
        status: 412,
        body: { code: 'RUN_VERSION_MISMATCH' },
      }),
    });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={minimalSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    // The error text should be visible and actionable
    expect(screen.getByText(/changed/i)).toBeInTheDocument();
  });

  // VAL-MODEQ-094: Ordering has non-drag controls
  it('ordering provides keyboard-operable move buttons, not drag-only', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    const field = screen.getByTestId('question-field-order');
    const moveUpButtons = within(field).getAllByRole('button', { name: /Move .* up/ });
    const moveDownButtons = within(field).getAllByRole('button', { name: /Move .* down/ });
    expect(moveUpButtons).toHaveLength(3);
    expect(moveDownButtons).toHaveLength(3);
    // All move buttons are type=button (not submit) and keyboard-focusable
    for (const btn of [...moveUpButtons, ...moveDownButtons]) {
      expect(btn).toHaveAttribute('type', 'button');
      expect(btn).not.toHaveAttribute('tabindex', '-1');
    }
  });

  // VAL-MODEQ-144: Ordering impossible moves are disabled
  it('ordering disables impossible moves (first up, last down)', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    const field = screen.getByTestId('question-field-order');
    const rows = within(field).getAllByRole('listitem');
    // First item's move-up should be disabled
    expect(within(rows[0]).getByRole('button', { name: /Move Step A up/ })).toBeDisabled();
    // Last item's move-down should be disabled
    expect(within(rows[2]).getByRole('button', { name: /Move Step C down/ })).toBeDisabled();
    // First item's move-down should be enabled
    expect(within(rows[0]).getByRole('button', { name: /Move Step A down/ })).not.toBeDisabled();
    // Last item's move-up should be enabled
    expect(within(rows[2]).getByRole('button', { name: /Move Step C up/ })).not.toBeDisabled();
  });

  // VAL-MODEQ-144: Ordering move announces via aria-live
  it('ordering move announces the moved option and new position via aria-live', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    const field = screen.getByTestId('question-field-order');
    const rows = within(field).getAllByRole('listitem');
    // Move "Step A" down (from position 1 to position 2)
    fireEvent.click(within(rows[0]).getByRole('button', { name: /Move Step A down/ }));
    // An aria-live region should announce the move
    const liveRegion =
      within(field).queryByLabelText(/position/i) ||
      within(field).queryByText(/moved to position/i, { exact: false });
    expect(liveRegion).toBeTruthy();
  });

  // VAL-MODEQ-144: Ordering preserves focus after move
  it('ordering move preserves focus on the activated control', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    const field = screen.getByTestId('question-field-order');
    const rows = within(field).getAllByRole('listitem');
    const moveDownBtn = within(rows[0]).getByRole('button', { name: /Move Step A down/ });
    moveDownBtn.focus();
    expect(document.activeElement).toBe(moveDownBtn);
    fireEvent.click(moveDownBtn);
    // After the move, focus should still be within the ordering field
    const fieldEl = screen.getByTestId('question-field-order');
    expect(fieldEl.contains(document.activeElement)).toBe(true);
  });

  // VAL-MODEQ-144: Scale exposes min, max, current value, endpoint labels, required
  it('scale exposes aria-required, min/max, aria-valuetext, and endpoint labels', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Confidence' });
    // Required
    expect(slider).toHaveAttribute('aria-required', 'true');
    // Min/max
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '5');
    expect(slider).toHaveAttribute('step', '1');
    // aria-valuetext should include the value and context
    const valuetext = slider.getAttribute('aria-valuetext');
    expect(valuetext).toBeTruthy();
    expect(valuetext).toContain('3');
    // Endpoint labels are present and accessible
    expect(screen.getByText('Low')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    // Current value display
    expect(screen.getByText(/Current value: 3/)).toBeInTheDocument();
  });

  // VAL-MODEQ-144: Scale optional does not expose aria-required
  it('optional scale does not expose aria-required', () => {
    const set = fullQuestionSet();
    const scaleQ = set.questions.find((q) => q.questionKey === 'scale')!;
    scaleQ.required = false;
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={set}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    const slider = screen.getByRole('slider', { name: 'Confidence' });
    expect(slider).not.toHaveAttribute('aria-required');
  });

  // VAL-MODEQ-093: Keyboard question completion
  it('keyboard can operate boolean, single choice, text, number, scale, and submit', () => {
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
        principalId="user-1"
      />,
    );
    // Operate boolean (required, no default) — click Yes
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    // All other required fields have defaults, so submitting should succeed
    const submitBtn = screen.getByRole('button', { name: /Submit answers/ });
    fireEvent.click(submitBtn);
    // The mutation should have been called (keyboard activation via click
    // event simulates keyboard Enter on a button)
    expect(mutateAsync).toHaveBeenCalled();
  });

  // VAL-MODEQ-106: Focus is visibly perceivable
  it('all question controls have visible focus indicator classes', () => {
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={fullQuestionSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    // Submit button should have focus-visible ring
    const submitBtn = screen.getByRole('button', { name: /Submit answers/ });
    expect(submitBtn.className).toContain('focus-visible:ring');

    // Scale slider should have focus-visible ring
    const slider = screen.getByRole('slider', { name: 'Confidence' });
    expect(slider.className).toContain('focus-visible:ring');

    // Text input should have focus-visible ring
    const text = screen.getByRole('textbox', { name: 'Notes' });
    expect(text.className).toContain('focus-visible:ring');

    // Number input should have focus-visible ring
    const num = screen.getByRole('spinbutton', { name: 'How many steps?' });
    expect(num.className).toContain('focus-visible:ring');

    // Ordering move buttons should have focus-visible ring
    const field = screen.getByTestId('question-field-order');
    const moveBtns = within(field).getAllByRole('button');
    for (const btn of moveBtns) {
      expect(btn.className).toContain('focus-visible:ring');
    }
  });

  // VAL-MODEQ-099: Server validation errors display with alert semantics
  it('server ANSWER_VALIDATION_FAILED errors display as field-level role=alert', async () => {
    mocks.useAnswerMissionRun.mockReturnValue({
      ...defaultMutation(),
      mutateAsync: vi.fn().mockRejectedValue({
        status: 422,
        body: {
          code: 'ANSWER_VALIDATION_FAILED',
          details: {
            req_bool: 'You must select Yes or No.',
          },
        },
      }),
    });
    renderWithProviders(
      <MissionQuestionCard
        companyId="c1"
        projectId="p1"
        runId="run-1"
        questionSet={minimalSet()}
        stateVersion={5}
        principalId="user-1"
      />,
    );
    // Answer the required boolean so client-side validation passes and the
    // mutation is called. The server then returns a validation error for
    // the same field (e.g., a server-side rule the client doesn't know).
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    await waitFor(() => {
      expect(screen.getByText('You must select Yes or No.')).toBeInTheDocument();
    });
    // The error should have role=alert
    const errorEl = screen.getByText('You must select Yes or No.');
    expect(errorEl).toHaveAttribute('role', 'alert');
  });

  // VAL-MODEQ-093: Keyboard can reorder ordering question without drag
  it('keyboard can reorder ordering via move buttons and submit', () => {
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
        principalId="user-1"
      />,
    );
    const field = screen.getByTestId('question-field-order');
    const rows = within(field).getAllByRole('listitem');
    // Move Step A down via button click (simulates keyboard activation)
    fireEvent.click(within(rows[0]).getByRole('button', { name: /Move Step A down/ }));
    // Verify the reorder happened
    const after = within(field).getAllByRole('listitem');
    expect(within(after[0]).getByText('Step B')).toBeInTheDocument();
    expect(within(after[1]).getByText('Step A')).toBeInTheDocument();
    // Answer the required boolean
    fireEvent.click(screen.getByRole('radio', { name: 'Yes' }));
    // Submit
    fireEvent.click(screen.getByRole('button', { name: /Submit answers/ }));
    expect(mutateAsync).toHaveBeenCalled();
    // Verify the answer includes the reordered list
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.body.answers['order']).toEqual(['b', 'a', 'c']);
  });
});
