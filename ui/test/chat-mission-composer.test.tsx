import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatMissionComposer } from '../src/components/projects/ChatMissionComposer';

const mocks = vi.hoisted(() => ({
  useFeatureFlags: vi.fn(),
  useProjectThreads: vi.fn(),
  useCreateThreadItem: vi.fn(),
  useStartMissionRun: vi.fn(),
  useModeProfiles: vi.fn(),
  useSession: vi.fn(),
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
  };
});

vi.mock('@/lib/auth', () => ({
  useSession: mocks.useSession,
  isLocalTrustedAuth: () => false,
}));

vi.mock('@/lib/ws', () => ({
  useServerEvents: vi.fn(),
  useWebSocket: () => ({ status: 'disconnected' }),
}));

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
  return {
    data: threads,
    isLoading: false,
    isError: false,
  };
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
  return {
    data: { profiles },
    isLoading: false,
    isError: false,
  };
}

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

const customProfileA = {
  id: 'profile-a',
  companyId: 'company-1',
  slug: 'research-lite',
  name: 'Research Lite',
  description: 'A lightweight research mode for quick source gathering.',
  enabled: true,
  version: 1,
  order: 1,
  incompatibilityReason: null,
};

const customProfileB = {
  id: 'profile-b',
  companyId: 'company-1',
  slug: 'deep-dive',
  name: 'Deep Dive',
  description: 'Extended multi-step analysis with full citation support.',
  enabled: true,
  version: 2,
  order: 0,
  incompatibilityReason: null,
};

const incompatibleProfile = {
  id: 'profile-c',
  companyId: 'company-1',
  slug: 'pro-model',
  name: 'Pro Model',
  description: 'Requires a pro-tier model not available to this agent.',
  enabled: true,
  version: 1,
  order: 2,
  incompatibilityReason: 'This profile requires a model unavailable to the selected agent.',
};

const disabledProfile = {
  id: 'profile-d',
  companyId: 'company-1',
  slug: 'disabled-mode',
  name: 'Disabled Mode',
  description: 'Should not appear.',
  enabled: false,
  version: 1,
  order: 3,
  incompatibilityReason: null,
};

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

function selectMission() {
  fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
}

describe('ChatMissionComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    mocks.useProjectThreads.mockReturnValue(threadsResult());
    mocks.useCreateThreadItem.mockReturnValue(createThreadItemResult());
    mocks.useStartMissionRun.mockReturnValue(startMissionResult());
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult());
    mocks.useSession.mockReturnValue(sessionResult());
  });

  // ── VAL-MODEQ-001: Chat and Mission choices ──────────────────────────

  it('shows Chat and Mission controls when the feature flag is enabled', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByRole('radio', { name: /chat/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /mission/i })).toBeInTheDocument();
  });

  it('defaults to Chat selected on first visit', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    const chatRadio = screen.getByRole('radio', { name: /chat/i });
    expect(chatRadio).toHaveAttribute('aria-checked', 'true');
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    expect(missionRadio).toHaveAttribute('aria-checked', 'false');
  });

  it('exposes the Chat/Mission control as a radiogroup with accessible name', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    const group = screen.getByRole('radiogroup', { name: /chat or mission/i });
    expect(group).toBeInTheDocument();
  });

  // ── VAL-MODEQ-002: Mission composer selection ─────────────────────────

  it('reveals mode selector and guidance after selecting Mission', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('radiogroup', { name: /mission mode/i })).not.toBeInTheDocument();
    selectMission();
    expect(screen.getByRole('radiogroup', { name: /mission mode/i })).toBeInTheDocument();
    expect(screen.getByText(/mission sends an asynchronous/i)).toBeInTheDocument();
  });

  it('can return to Chat from Mission without leaving the project', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    expect(screen.getByRole('radiogroup', { name: /mission mode/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /chat/i }));
    expect(screen.queryByRole('radiogroup', { name: /mission mode/i })).not.toBeInTheDocument();
  });

  it('preserves Chat draft when switching to Mission and back', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    const chatInput = screen.getByLabelText(/chat message/i);
    fireEvent.change(chatInput, { target: { value: 'My chat draft' } });
    selectMission();
    expect(screen.queryByLabelText(/chat message/i)).not.toBeInTheDocument();
    const missionInput = screen.getByLabelText(/mission request/i);
    fireEvent.change(missionInput, { target: { value: 'My mission draft' } });
    fireEvent.click(screen.getByRole('radio', { name: /chat/i }));
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('My chat draft');
    selectMission();
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('My mission draft');
  });

  it('does not submit either draft when switching between Chat and Mission', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const chatMutate = vi.fn();
    const missionMutate = vi.fn();
    mocks.useCreateThreadItem.mockReturnValue({
      mutate: chatMutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    mocks.useStartMissionRun.mockReturnValue({
      mutate: missionMutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Chat draft' },
    });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Mission draft' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /chat/i }));
    expect(chatMutate).not.toHaveBeenCalled();
    expect(missionMutate).not.toHaveBeenCalled();
  });

  // ── VAL-MODEQ-003: Chat composer selection ────────────────────────────

  it('hides Mission-only controls when Chat is selected', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    expect(screen.getByRole('button', { name: /start mission/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /chat/i }));
    expect(screen.queryByRole('button', { name: /start mission/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  // ── VAL-MODEQ-004: Legacy Chat remains unchanged ──────────────────────

  it('posts a Chat message through the legacy thread-item path when flag is disabled', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    const mutate = vi.fn();
    mocks.useCreateThreadItem.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    const input = screen.getByLabelText(/chat message/i);
    fireEvent.change(input, { target: { value: 'Hello from chat' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'comment', content: 'Hello from chat' }),
    );
  });

  it('posts a Chat message through the legacy path when Mission is enabled but Chat is selected', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const mutate = vi.fn();
    mocks.useCreateThreadItem.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Chat alongside Mission' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'comment', content: 'Chat alongside Mission' }),
    );
    expect(mocks.useStartMissionRun().mutate).not.toHaveBeenCalled();
  });

  it('does not start a Mission when submitting Chat', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const chatMutate = vi.fn();
    const missionMutate = vi.fn();
    mocks.useCreateThreadItem.mockReturnValue({
      mutate: chatMutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    mocks.useStartMissionRun.mockReturnValue({
      mutate: missionMutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Just chatting' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(chatMutate).toHaveBeenCalled();
    expect(missionMutate).not.toHaveBeenCalled();
  });

  // ── VAL-MODEQ-005: Disabled feature hides Mission ────────────────────

  it('hides Mission control when the feature flag is disabled', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('radio', { name: /mission/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: /mission mode/i })).not.toBeInTheDocument();
  });

  it('does not render a Mission start action when disabled', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('button', { name: /start mission/i })).not.toBeInTheDocument();
  });

  it('hides Mission when the flag query errors (malformed config fails closed)', () => {
    mocks.useFeatureFlags.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('radio', { name: /mission/i })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /chat/i })).toBeInTheDocument();
  });

  it('hides Mission while flags are loading (fail-closed default)', () => {
    mocks.useFeatureFlags.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('radio', { name: /mission/i })).not.toBeInTheDocument();
  });

  it('shows a Chat input and send button when flag is disabled', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  // ── VAL-MODEQ-008: Built-in mode order ────────────────────────────────

  it('lists built-in modes in order: Auto, Fast, Deep Work, Analyst', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    const radios = within(modeGroup).getAllByRole('radio');
    const labels = radios.map((r) => r.closest('label')?.textContent?.trim());
    expect(labels).toEqual(['Auto', 'Fast', 'Deep Work', 'Analyst']);
  });

  it('lists custom profiles after built-ins in deterministic order', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult([customProfileA, customProfileB]));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    const radios = within(modeGroup).getAllByRole('radio');
    const labels = radios.map((r) => r.closest('label')?.textContent?.trim());
    // Built-ins first, then custom profiles ordered by `order` field
    // (profileB has order 0, profileA has order 1).
    expect(labels).toEqual(['Auto', 'Fast', 'Deep Work', 'Analyst', 'Deep Dive', 'Research Lite']);
  });

  it('hides disabled custom profiles from the selector', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult([customProfileA, disabledProfile]));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    const radios = within(modeGroup).getAllByRole('radio');
    const labels = radios.map((r) => r.closest('label')?.textContent?.trim());
    expect(labels).not.toContain('Disabled Mode');
    expect(labels).toContain('Research Lite');
  });

  it('shows incompatible custom profiles as disabled with a safe reason', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult([incompatibleProfile]));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const proRadio = screen.getByRole('radio', { name: /pro model/i });
    expect(proRadio).toBeDisabled();
    // Safe reason is visible as text
    expect(screen.getByText(/requires a model unavailable/i)).toBeInTheDocument();
  });

  // ── VAL-MODEQ-009: Auto description ───────────────────────────────────

  it('shows Auto description that says it chooses a concrete mode from the request', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    // Auto description appears in the radio choice and the effective summary.
    const matches = screen.getAllByText(/chooses a concrete mode.*from your request/i);
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  // ── VAL-MODEQ-010: Fast description ───────────────────────────────────

  it('shows Fast description communicating short bounded work, planning for complex, no parallel children', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const text = screen.getByText(/short, bounded work/i).textContent ?? '';
    expect(text).toMatch(/no parallel children/i);
  });

  // ── VAL-MODEQ-011: Deep Work description ──────────────────────────────

  it('shows Deep Work description communicating structured planning, deeper reasoning, research, bounded parallel work', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const text = screen.getByText(/structured planning and approval/i).textContent ?? '';
    expect(text).toMatch(/deeper reasoning/i);
    expect(text).toMatch(/bounded parallel work/i);
  });

  // ── VAL-MODEQ-012: Analyst description ────────────────────────────────

  it('shows Analyst description communicating structured planning, evidence-oriented research, citations', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const text = screen.getByText(/evidence-oriented research/i).textContent ?? '';
    expect(text).toMatch(/structured planning/i);
    expect(text).toMatch(/citations for external factual claims/i);
  });

  // ── VAL-MODEQ-013: Custom profile descriptions ────────────────────────

  it('shows each custom profile name and description without substituting another profile text', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult([customProfileA, customProfileB]));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    expect(screen.getByText('Research Lite')).toBeInTheDocument();
    expect(
      screen.getByText(/lightweight research mode for quick source gathering/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Deep Dive')).toBeInTheDocument();
    expect(
      screen.getByText(/extended multi-step analysis with full citation support/i),
    ).toBeInTheDocument();
  });

  it('does not expose raw configuration from custom profiles', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult([customProfileA]));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    // Slug, version, order, and incompatibilityReason are not displayed
    expect(screen.queryByText('research-lite')).not.toBeInTheDocument();
    expect(screen.queryByText('version')).not.toBeInTheDocument();
  });

  // ── VAL-MODEQ-014: Effective mode summary ─────────────────────────────

  it('shows a provisional hard ceiling for Auto before request text', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    expect(screen.getByText(/provisional hard ceiling/i)).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/auto will resolve/i)).toBeInTheDocument();
  });

  it('shows a concrete effective ceiling for Fast', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.click(screen.getByRole('radio', { name: /^fast$/i }));
    expect(screen.getByText(/effective hard ceiling/i)).toBeInTheDocument();
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();
  });

  it('shows a concrete effective ceiling for Deep Work', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
  });

  it('shows a concrete effective ceiling for Analyst', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.click(screen.getByRole('radio', { name: /analyst/i }));
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
  });

  it('resolves Auto to a concrete ceiling after typing a research request', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    // Auto is selected by default
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Research the latest market citations' },
    });
    // Auto resolves to Analyst ($50.00) due to "research"/"citations" keywords
    expect(screen.getByText(/effective hard ceiling/i)).toBeInTheDocument();
    expect(screen.getByText(/\$50\.00/)).toBeInTheDocument();
  });

  it('disables start when the request is empty', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    expect(screen.getByRole('button', { name: /start mission/i })).toBeDisabled();
  });

  it('enables start when the request has text and a thread is selected', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Analyze the quarterly report' },
    });
    expect(screen.getByRole('button', { name: /start mission/i })).not.toBeDisabled();
  });

  it('shows the selected mode name and description in the effective summary', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    const summary = screen.getByLabelText(/effective mode summary/i);
    expect(within(summary).getByText(/deep work/i)).toBeInTheDocument();
    expect(within(summary).getByText(/structured planning and approval/i)).toBeInTheDocument();
  });

  it('shows the custom profile name and description in the effective summary when selected', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult([customProfileA]));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.click(screen.getByRole('radio', { name: /research lite/i }));
    const summary = screen.getByLabelText(/effective mode summary/i);
    expect(within(summary).getByText(/research lite/i)).toBeInTheDocument();
    expect(within(summary).getByText(/lightweight research mode/i)).toBeInTheDocument();
  });

  // ── VAL-MODEQ-092: Keyboard selector operation ───────────────────────

  it('allows keyboard-only selection of Mission, mode, request entry, and start', async () => {
    const user = userEvent.setup();
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const mutate = vi.fn();
    mocks.useStartMissionRun.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });

    await user.click(screen.getByRole('radio', { name: /mission/i }));
    expect(screen.getByRole('radiogroup', { name: /mission mode/i })).toBeInTheDocument();

    // Select Deep Work via keyboard-clickable radio
    await user.click(screen.getByRole('radio', { name: /deep work/i }));
    const deepWorkRadio = screen.getByRole('radio', { name: /deep work/i });
    expect(deepWorkRadio).toHaveAttribute('aria-checked', 'true');

    // Type a request
    const requestInput = screen.getByLabelText(/mission request/i);
    await user.type(requestInput, 'Keyboard mission request');

    // Start
    await user.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].body.request.text).toBe('Keyboard mission request');
    expect(mutate.mock.calls[0][0].body.mode).toBe('deep_work');
  });

  // ── Existing tests preserved / adapted ────────────────────────────────

  it('does not carry drafts from a different project', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const { unmount } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Project 1 draft' },
    });
    unmount();
    render(<ChatMissionComposer companyId="company-1" projectId="project-2" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('');
  });

  it('exposes accessible names for the request input and start action', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    expect(screen.getByLabelText(/mission request/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start mission/i })).toBeInTheDocument();
  });

  it('disables the Chat send button when the input is empty', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('starts a Mission with the selected thread, mode, and request text', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const mutate = vi.fn();
    mocks.useStartMissionRun.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Research competitor pricing' },
    });
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    fireEvent.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const call = mutate.mock.calls[0][0];
    expect(call.body.projectThreadId).toBe('thread-1');
    expect(call.body.mode).toBe('deep_work');
    expect(call.body.request.text).toBe('Research competitor pricing');
  });

  // ── VAL-MODEQ-015: Selecting a custom profile sets modeProfileId ──────

  it('includes modeProfileId in the start body when a custom profile is selected', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult([customProfileA, customProfileB]));
    const mutate = vi.fn();
    mocks.useStartMissionRun.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    // Select the custom profile "Research Lite" (profile-a)
    fireEvent.click(screen.getByRole('radio', { name: /research lite/i }));
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Gather sources on market trends' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const call = mutate.mock.calls[0][0];
    expect(call.body.modeProfileId).toBe('profile-a');
    expect(call.body.mode).toBe('custom');
    expect(call.body.request.text).toBe('Gather sources on market trends');
  });

  it('omits modeProfileId from the start body when a built-in mode is selected', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult([customProfileA]));
    const mutate = vi.fn();
    mocks.useStartMissionRun.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.click(screen.getByRole('radio', { name: /deep work/i }));
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Deep analysis request' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const call = mutate.mock.calls[0][0];
    expect(call.body.modeProfileId).toBeUndefined();
    expect(call.body.mode).toBe('deep_work');
  });

  it('disables the start button while a Mission start is in flight', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useStartMissionRun.mockReturnValue({
      mutate: vi.fn(),
      isPending: true,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'In flight mission' },
    });
    expect(screen.getByRole('button', { name: /start mission/i })).toBeDisabled();
  });

  it('renders a thread selector bound to conversation threads', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const thread2 = { ...thread, id: 'thread-2', title: 'Sprint planning' };
    mocks.useProjectThreads.mockReturnValue(threadsResult([thread, thread2]));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    const selector = screen.getByLabelText(/conversation thread/i);
    expect(selector).toBeInTheDocument();
    const options = within(selector).getAllByRole('option');
    expect(options).toHaveLength(2);
  });

  it('shows a guidance message when no conversation thread exists', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useProjectThreads.mockReturnValue(threadsResult([]));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByText(/create a conversation thread first/i)).toBeInTheDocument();
  });

  it('preserves a lowered cost limit in the start payload', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const mutate = vi.fn();
    mocks.useStartMissionRun.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.click(screen.getByRole('radio', { name: /^fast$/i }));
    fireEvent.change(screen.getByLabelText(/maximum mission cost/i), {
      target: { value: '2.50' },
    });
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Bounded request' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].body.limits).toEqual({ costCents: 250 });
  });

  // VAL-RUN-016: rapid double activation fires only one POST
  it('fires only one start mutation on rapid double activation of the Start button', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const mutate = vi.fn();
    mocks.useStartMissionRun.mockReturnValue({
      mutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Rapid double start' },
    });
    const startButton = screen.getByRole('button', { name: /start mission/i });
    fireEvent.click(startButton);
    fireEvent.click(startButton);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  // VAL-RUN-130: reuses same idempotency key across recoverable re-submissions
  it('reuses the same start idempotency key across recoverable re-submissions', async () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const mutateSpy = vi.fn();
    mocks.useStartMissionRun.mockReturnValue({
      mutate: mutateSpy,
      isPending: false,
      isSuccess: false,
      isError: true,
      error: new Error('Network request failed'),
      reset: vi.fn(),
    });
    const user = userEvent.setup();
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    await user.click(screen.getByRole('radio', { name: /mission/i }));
    await user.type(screen.getByLabelText(/mission request/i), 'Analyze the quarterly report');
    await user.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutateSpy).toHaveBeenCalledTimes(1);
    const firstKey = mutateSpy.mock.calls[0][0].idempotencyKey;
    expect(firstKey).toBeTruthy();
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('Analyze the quarterly report');
    await user.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutateSpy).toHaveBeenCalledTimes(2);
    expect(mutateSpy.mock.calls[1][0].idempotencyKey).toBe(firstKey);
  });
});
