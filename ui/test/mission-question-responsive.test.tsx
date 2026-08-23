import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMissionComposer } from '../src/components/projects/ChatMissionComposer';
import { MissionQuestionCard } from '../src/components/projects/MissionQuestionCard';
import type { MissionCurrentQuestionSet } from '../src/lib/api';

// ── Mocks ────────────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  useFeatureFlags: vi.fn(),
  useProjectThreads: vi.fn(),
  useCreateThreadItem: vi.fn(),
  useStartMissionRun: vi.fn(),
  useModeProfiles: vi.fn(),
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
    useAnswerMissionRun: mocks.useAnswerMissionRun,
    useMissionQuestionSets: mocks.useMissionQuestionSets,
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

vi.mock('@/lib/ws', () => ({
  useServerEvents: vi.fn(),
  useWebSocket: () => ({ status: 'disconnected' }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

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
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    reset: vi.fn(),
  };
}

function startMissionResult() {
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    reset: vi.fn(),
  };
}

function modeProfilesResult(profiles: unknown[] = []) {
  return { data: { profiles }, isLoading: false, isError: false };
}

function defaultAnswerMutation() {
  return {
    mutateAsync: vi.fn().mockResolvedValue({ data: { run: { id: 'run-1' } } }),
    isPending: false,
    isError: false,
    error: null,
  };
}

function questionSetsResult() {
  return {
    data: { questionSets: [], nextCursor: null },
    isLoading: false,
    isError: false,
  };
}

const longLabelProfile = {
  id: 'profile-long',
  companyId: 'company-1',
  slug: 'extended-research-and-analysis-mode',
  name: 'Extended Research and Analysis Mode with Full Citation Support',
  description:
    'A comprehensive multi-step research mode that performs deep analysis with full citation support, evidence gathering, and structured synthesis for complex analytical workflows.',
  enabled: true,
  version: 1,
  order: 0,
  incompatibilityReason: null,
};

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

/** A complete question set exercising every supported type with long labels. */
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
        order: '1' as unknown as number,
        type: 'boolean',
        label: 'Approve the proposed comprehensive multi-step research plan?',
        help: 'Choose Yes to approve the plan and proceed with execution, or No to reject and cancel.',
        required: true,
        default: null,
        options: null,
        validation: null,
      } as unknown as MissionCurrentQuestionSet['questions'][number],
      {
        questionKey: 'choice',
        order: '2' as unknown as number,
        type: 'single_choice',
        label: 'Which execution mode should the agent use for this task?',
        help: 'Pick one execution mode. Each mode has different limits for steps, duration, and cost.',
        required: true,
        default: 'fast',
        options: [
          { key: 'fast', label: 'Fast — short bounded work with minimal planning' },
          { key: 'deep', label: 'Deep Work — structured planning with parallel children' },
        ],
        validation: null,
      } as unknown as MissionCurrentQuestionSet['questions'][number],
      {
        questionKey: 'multi',
        order: '3' as unknown as number,
        type: 'multiple_choice',
        label: 'Which tools should be available to the agent during execution?',
        help: 'Select up to two tools. The agent will only have access to the selected tools.',
        required: false,
        default: ['search'],
        options: [
          { key: 'search', label: 'Web Search — relevance-ranked search results' },
          { key: 'scrape', label: 'Page Scrape — full page content extraction' },
          { key: 'extract', label: 'Structured Extract — schema-driven extraction' },
        ],
        validation: { maxSelections: 2 },
      } as unknown as MissionCurrentQuestionSet['questions'][number],
      {
        questionKey: 'text',
        order: '4' as unknown as number,
        type: 'text',
        label: 'Additional context and clarifying notes for the agent',
        help: 'Add any clarifying notes (max 200 chars). These will be included in the agent context.',
        required: false,
        default: '',
        options: null,
        validation: { maxLength: 200 },
      } as unknown as MissionCurrentQuestionSet['questions'][number],
      {
        questionKey: 'num',
        order: '5' as unknown as number,
        type: 'number',
        label: 'How many steps should the plan contain at maximum?',
        help: null,
        required: true,
        default: 4,
        options: null,
        validation: { min: 1, max: 12, step: 1 },
      } as unknown as MissionCurrentQuestionSet['questions'][number],
      {
        questionKey: 'scale',
        order: '6' as unknown as number,
        type: 'scale',
        label: 'Confidence level in the proposed approach',
        help: 'Slide from low to high confidence. This helps calibrate the agent risk tolerance.',
        required: true,
        default: 3,
        options: null,
        validation: { min: 1, max: 5, step: 1, minLabel: 'Low', maxLabel: 'High' },
      } as unknown as MissionCurrentQuestionSet['questions'][number],
      {
        questionKey: 'order',
        order: '7' as unknown as number,
        type: 'ordering',
        label: 'Order the following execution steps from first to last',
        help: 'Arrange the steps in the order they should be executed. Use the move buttons to reorder.',
        required: true,
        default: null,
        options: [
          { key: 'a', label: 'Gather initial requirements and context from sources' },
          { key: 'b', label: 'Analyze gathered data and identify key patterns' },
          { key: 'c', label: 'Synthesize findings into a structured report' },
        ],
        validation: null,
      } as unknown as MissionCurrentQuestionSet['questions'][number],
    ],
  };
}

beforeEach(() => {
  mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
  mocks.useProjectThreads.mockReturnValue(threadsResult());
  mocks.useCreateThreadItem.mockReturnValue(createThreadItemResult());
  mocks.useStartMissionRun.mockReturnValue(startMissionResult());
  mocks.useModeProfiles.mockReturnValue(modeProfilesResult([longLabelProfile]));
  mocks.useAnswerMissionRun.mockReturnValue(defaultAnswerMutation());
  mocks.useMissionQuestionSets.mockReturnValue(questionSetsResult());
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('VAL-MODEQ-102: Mobile selector remains usable', () => {
  it('Chat/Mission segmented control allows wrapping at narrow widths', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const segmented = screen.getByRole('radiogroup', { name: /chat or mission/i });
    // The segmented control container must allow wrapping so labels stack
    // at very narrow viewports instead of overflowing.
    expect(segmented.querySelector('div')?.className).toMatch(/flex-wrap/);
  });

  it('Chat/Mission labels do not use whitespace-nowrap', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const labels = screen.getAllByText(/chat|mission/i);
    for (const label of labels) {
      expect(label.className).not.toMatch(/whitespace-nowrap/);
    }
  });

  it('mode choices stack vertically and do not use fixed widths', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    // Select Mission to reveal mode choices
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    missionRadio.closest('label')?.click();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    // Mode choices container should use vertical stacking (space-y)
    expect(modeGroup.querySelector('div')?.className).toMatch(/space-y/);
    // No fixed-width classes on choice containers
    const choices = modeGroup.querySelectorAll('input[type="radio"]');
    for (const choice of choices) {
      const container = choice.closest('div.rounded-md');
      if (container) {
        expect(container.className).not.toMatch(/w-\[\d+px\]|w-\[\d+rem\]/);
      }
    }
  });

  it('mode choice descriptions reflow with break-words', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    missionRadio.closest('label')?.click();
    // The long-label profile's description should be present and reflow
    const desc = screen.getByText(/comprehensive multi-step research mode/i);
    // Description paragraph should allow text wrapping
    expect(desc.className).toMatch(/break-words|leading-relaxed|text-xs/);
  });

  it('effective summary ceiling and label wrap without fixed widths', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    missionRadio.closest('label')?.click();
    const summary = screen.getByLabelText(/effective mode summary/i);
    // The summary's flex row should allow wrapping
    const flexRow = summary.querySelector('div.flex');
    if (flexRow) {
      expect(flexRow.className).toMatch(/flex-wrap/);
    }
    // No fixed widths
    expect(summary.className).not.toMatch(/w-\[\d+px\]/);
  });
});

describe('VAL-MODEQ-103: Mobile questions remain usable', () => {
  it('question card section uses full width and break-words', () => {
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
    const heading = screen.getByRole('heading', { name: /questions/i });
    const section = heading.closest('section');
    expect(section).toBeTruthy();
    expect(section!.className).toMatch(/w-full|max-w-full|break-words/);
  });

  it('question labels reflow with flex-wrap and break-words', () => {
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
    // Long boolean label
    const boolLabel = screen.getByText(/approve the proposed comprehensive/i);
    // The label container should use flex-wrap
    const labelContainer = boolLabel.closest('div.flex');
    expect(labelContainer?.className).toMatch(/flex-wrap/);
    // The label text itself should break
    expect(boolLabel.className).toMatch(/break-words/);
  });

  it('help text reflows with break-words', () => {
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
    const help = screen.getByText(/choose yes to approve the plan/i);
    expect(help.className).toMatch(/break-words/);
  });

  it('boolean control allows wrapping at narrow widths', () => {
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
    const boolGroup = screen.getByRole('radiogroup', { name: /approve the proposed/i });
    // The boolean control container should allow wrapping so Yes/No can
    // stack vertically at very narrow widths.
    expect(boolGroup.className).toMatch(/flex-wrap/);
  });

  it('ordering move buttons do not shrink and labels can wrap', () => {
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
    for (const row of rows) {
      const moveBtns = within(row).getAllByRole('button');
      for (const btn of moveBtns) {
        // Move buttons must not shrink so they remain operable
        expect(btn.className).toMatch(/shrink-0/);
      }
      // The label span should allow wrapping
      const labelSpan = row.querySelector('span.break-words, span.flex-1');
      expect(labelSpan).toBeTruthy();
      if (labelSpan) {
        expect(labelSpan.className).toMatch(/break-words|min-w-0/);
      }
    }
  });

  it('scale control labels do not force overflow', () => {
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
    const slider = screen.getByRole('slider', { name: /confidence level/i });
    const container = slider.closest('div.flex');
    // Labels should be shrink-0 and slider flex-1
    const labels = container?.querySelectorAll('span.shrink-0');
    expect(labels?.length).toBeGreaterThanOrEqual(2);
    expect(slider.className).toMatch(/flex-1/);
  });

  it('no question text uses whitespace-nowrap', () => {
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
    const section = screen.getByRole('heading', { name: /questions/i }).closest('section');
    const nowrapEls = section?.querySelectorAll('[class*="whitespace-nowrap"]');
    expect(nowrapEls?.length ?? 0).toBe(0);
  });
});

describe('VAL-MODEQ-104: Mobile action remains reachable', () => {
  it('submit button is not position fixed or sticky', () => {
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
    const submitBtn = screen.getByRole('button', { name: /submit answers/i });
    // The button must not use sticky/fixed positioning that could obscure
    // content above it when the on-screen keyboard reduces viewport height.
    expect(submitBtn.className).not.toMatch(/sticky|fixed/);
    // The button's container should also not be sticky/fixed
    const container = submitBtn.closest('div');
    if (container) {
      expect(container.className).not.toMatch(/sticky|fixed/);
    }
  });

  it('submit button is within normal document flow (no absolute positioning)', () => {
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
    const submitBtn = screen.getByRole('button', { name: /submit answers/i });
    expect(submitBtn.className).not.toMatch(/absolute/);
  });
});

describe('VAL-MODEQ-105: Reduced motion is respected', () => {
  it('Chat/Mission segmented control transitions have motion-reduce', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const labels = screen
      .getAllByText(/chat|mission/i)
      .filter((el) => el.className.includes('transition-colors'));
    // Should find the two segmented control labels with transition-colors
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const label of labels) {
      expect(label.className).toMatch(/motion-reduce:transition-none/);
    }
  });

  it('mode selector choice transitions have motion-reduce', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    missionRadio.closest('label')?.click();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    // Each mode choice container with transition-colors needs motion-reduce
    const transitionEls = modeGroup.querySelectorAll('[class*="transition-colors"]');
    expect(transitionEls.length).toBeGreaterThan(0);
    for (const el of transitionEls) {
      expect(el.getAttribute('class') ?? '').toMatch(/motion-reduce:transition-none/);
    }
  });

  it('question card submit button transitions have motion-reduce', () => {
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
    const submitBtn = screen.getByRole('button', { name: /submit answers/i });
    expect(submitBtn.className).toMatch(/motion-reduce:transition-none/);
  });

  it('question card has no animate- classes that lack motion-reduce', () => {
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
    const section = screen.getByRole('heading', { name: /questions/i }).closest('section');
    const animatedEls = section?.querySelectorAll('[class*="animate-"]');
    for (const el of animatedEls ?? []) {
      const cls = el.getAttribute('class') ?? '';
      // Any animated element must have a motion-reduce disable
      expect(cls).toMatch(/motion-reduce:animate-none|motion-reduce:transition-none/);
    }
  });

  it('mode selector has no animate- classes that lack motion-reduce', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    missionRadio.closest('label')?.click();
    const composer = screen.getByTestId('chat-mission-composer');
    const animatedEls = composer.querySelectorAll('[class*="animate-"]');
    for (const el of animatedEls ?? []) {
      const cls = el.getAttribute('class') ?? '';
      expect(cls).toMatch(/motion-reduce:animate-none|motion-reduce:transition-none/);
    }
  });
});

describe('VAL-MODEQ-145: Questions and selectors reflow at zoom', () => {
  it('no element in the composer uses fixed pixel widths', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    missionRadio.closest('label')?.click();
    const composer = screen.getByTestId('chat-mission-composer');
    // No fixed pixel/rem widths that would prevent reflow at 320px + 200% zoom
    const fixedWidthEls = composer.querySelectorAll('[class*="w-["]');
    for (const el of fixedWidthEls ?? []) {
      const cls = el.getAttribute('class') ?? '';
      // Allow max-w-[calc(100vw-...)] which is responsive, not fixed
      expect(cls).not.toMatch(/w-\[\d+px\]|w-\[\d+rem\]/);
    }
  });

  it('no element in the question card uses fixed pixel widths', () => {
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
    const section = screen.getByRole('heading', { name: /questions/i }).closest('section');
    const fixedWidthEls = section?.querySelectorAll('[class*="w-["]');
    for (const el of fixedWidthEls ?? []) {
      const cls = el.getAttribute('class') ?? '';
      expect(cls).not.toMatch(/w-\[\d+px\]|w-\[\d+rem\]/);
    }
  });

  it('all text content in question card uses break-words or leading classes for reflow', () => {
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
    // The section container itself should have break-words or max-w-full
    const section = screen.getByRole('heading', { name: /questions/i }).closest('section');
    expect(section!.className).toMatch(/break-words|max-w-full|w-full/);
  });

  it('composer container does not set overflow-x-hidden or overflow-hidden that clips content', () => {
    renderWithProviders(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    missionRadio.closest('label')?.click();
    const composer = screen.getByTestId('chat-mission-composer');
    // The composer section itself should not clip overflow horizontally
    // (clipping would hide content instead of letting it reflow)
    expect(composer.className).not.toMatch(/overflow-x-hidden|overflow-hidden/);
  });

  it('all controls remain operable (no disabled-by-class, no pointer-events-none)', () => {
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
    const submitBtn = screen.getByRole('button', { name: /submit answers/i });
    expect(submitBtn).not.toBeDisabled();
    expect(submitBtn.className).not.toMatch(/pointer-events-none/);
    // All radios should be operable
    const radios = screen.getAllByRole('radio');
    for (const radio of radios) {
      expect(radio.className).not.toMatch(/pointer-events-none/);
    }
  });
});
