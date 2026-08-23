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

function modeProfilesError() {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    error: new Error('Failed to load mode profiles'),
    refetch: vi.fn().mockResolvedValue({ data: { profiles: [] } }),
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

describe('Mission mode drafts and registry (VAL-MODEQ-121/122/125/149)', () => {
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

  // ── VAL-MODEQ-121: Mission mode defaults and draft isolation ──────────

  it('defaults to Auto as the Mission mode on first entry', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    expect(screen.getByRole('radio', { name: /^auto$/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps separate Chat and Mission drafts per thread', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const thread2 = { ...thread, id: 'thread-2', title: 'Sprint planning' };
    mocks.useProjectThreads.mockReturnValue(threadsResult([thread, thread2]));
    const { unmount } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Chat on thread-1' },
    });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Mission on thread-1' },
    });
    unmount();
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('Chat on thread-1');
    fireEvent.change(screen.getByLabelText(/conversation thread/i), {
      target: { value: 'thread-2' },
    });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('');
    selectMission();
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('');
  });

  it('clears only the Mission draft on successful submission, leaving the Chat draft intact', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const missionMutate = vi.fn();
    mocks.useStartMissionRun.mockReturnValue({
      mutate: missionMutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    const { rerender } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'My chat draft' },
    });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'My mission draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start mission/i }));
    mocks.useStartMissionRun.mockReturnValue({
      mutate: missionMutate,
      isPending: false,
      isSuccess: true,
      isError: false,
      reset: vi.fn(),
    });
    rerender(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('');
    fireEvent.click(screen.getByRole('radio', { name: /chat/i }));
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('My chat draft');
  });

  it('reveals no prior-scope text when navigating to a different project', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const { unmount } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Project 1 chat draft' },
    });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Project 1 mission draft' },
    });
    unmount();
    render(<ChatMissionComposer companyId="company-1" projectId="project-2" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('');
    selectMission();
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('');
  });

  it('reveals no prior-principal text after logout (principal change)', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useSession.mockReturnValue(sessionResult('user-alpha'));
    const { unmount } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'User alpha chat draft' },
    });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'User alpha mission draft' },
    });
    unmount();
    mocks.useSession.mockReturnValue(sessionResult('user-beta'));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('');
    selectMission();
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('');
  });

  // ── VAL-MODEQ-122: Mode-registry failure fails closed and recovers ────

  it('shows an accessible error and Retry when mode profiles fail to load', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesError());
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('disables Mission start when the mode registry fails', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesError());
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'A valid mission request' },
    });
    expect(screen.getByRole('button', { name: /start mission/i })).toBeDisabled();
  });

  it('keeps legacy Chat usable when the mode registry fails', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesError());
    const chatMutate = vi.fn();
    mocks.useCreateThreadItem.mockReturnValue({
      mutate: chatMutate,
      isPending: false,
      isSuccess: false,
      isError: false,
      reset: vi.fn(),
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Chat still works' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(chatMutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'comment', content: 'Chat still works' }),
    );
  });

  it('preserves the Mission draft across registry failure and Retry', async () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const refetchSpy = vi.fn().mockResolvedValue({ data: { profiles: [customProfileA] } });
    mocks.useModeProfiles.mockReturnValue({ ...modeProfilesError(), refetch: refetchSpy });
    const user = userEvent.setup();
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    await user.click(screen.getByRole('radio', { name: /mission/i }));
    await user.type(screen.getByLabelText(/mission request/i), 'Important mission draft');
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('Important mission draft');
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(refetchSpy).toHaveBeenCalled();
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('Important mission draft');
  });

  it('does not expose a stale foreign profile on registry failure', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useModeProfiles.mockReturnValue(modeProfilesError());
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    expect(within(modeGroup).queryAllByRole('radio')).toHaveLength(0);
    expect(within(modeGroup).getByRole('alert')).toBeInTheDocument();
  });

  it('Retry button is keyboard operable with an explicit accessible name (VAL-MODEQ-122)', async () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const refetchSpy = vi.fn().mockResolvedValue({ data: { profiles: [] } });
    mocks.useModeProfiles.mockReturnValue({ ...modeProfilesError(), refetch: refetchSpy });
    const user = userEvent.setup();
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    await user.click(screen.getByRole('radio', { name: /mission/i }));
    // The error alert is announced via role=alert
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent(/could not be loaded/i);
    // The Retry button has an explicit accessible name for assistive technology
    const retryBtn = screen.getByRole('button', { name: /retry loading mission modes/i });
    expect(retryBtn).toBeInTheDocument();
    // Keyboard-focus the Retry button and activate it with Enter
    retryBtn.focus();
    expect(retryBtn).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(refetchSpy).toHaveBeenCalled();
  });

  // ── VAL-MODEQ-125: Custom-profile ordering and identity are stable ────

  it('orders custom profiles by normalized display name with profile-ID tie-break', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const profiles = [
      { ...customProfileB, id: 'p-beta', name: 'Beta', order: 0 },
      { ...customProfileA, id: 'p-gamma', name: 'Gamma', order: 1 },
      { ...customProfileA, id: 'p-alpha', name: 'Alpha', order: 2 },
    ];
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult(profiles));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    const radios = within(modeGroup).getAllByRole('radio');
    const labels = radios.map((r) => r.closest('label')?.textContent?.trim());
    expect(labels).toEqual(['Auto', 'Fast', 'Deep Work', 'Analyst', 'Alpha', 'Beta', 'Gamma']);
  });

  it('uses profile-ID tie-break when display names collide', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const profiles = [
      { ...customProfileA, id: 'p-zeta', name: 'Same Name', slug: 'zeta', order: 0 },
      { ...customProfileA, id: 'p-alpha', name: 'Same Name', slug: 'alpha', order: 1 },
    ];
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult(profiles));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    const radios = within(modeGroup).getAllByRole('radio');
    const customRadios = radios.slice(4);
    const labels = customRadios.map((r) => r.closest('label')?.textContent?.trim());
    expect(labels[0]).toContain('Same Name');
    expect(labels[1]).toContain('Same Name');
    const accessibleNames = customRadios.map((r) => r.getAttribute('aria-label') ?? '');
    expect(new Set(accessibleNames).size).toBeGreaterThan(1);
  });

  it('never duplicates profiles across reload (deduplicates by profile ID)', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const profiles = [
      { ...customProfileA, id: 'p-dup', name: 'Duplicate', order: 0 },
      { ...customProfileA, id: 'p-dup', name: 'Duplicate', order: 1 },
    ];
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult(profiles));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    selectMission();
    const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
    const radios = within(modeGroup).getAllByRole('radio');
    const dupRadios = radios.filter((r) => r.closest('label')?.textContent?.trim() === 'Duplicate');
    expect(dupRadios).toHaveLength(1);
  });

  it('preserves stable order across re-render', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const profiles = [
      { ...customProfileA, id: 'p-charlie', name: 'Charlie', order: 0 },
      { ...customProfileA, id: 'p-alpha', name: 'Alpha', order: 1 },
      { ...customProfileA, id: 'p-bravo', name: 'Bravo', order: 2 },
    ];
    mocks.useModeProfiles.mockReturnValue(modeProfilesResult(profiles));
    const { rerender } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    selectMission();
    const getLabels = () => {
      const modeGroup = screen.getByRole('radiogroup', { name: /mission mode/i });
      return within(modeGroup)
        .getAllByRole('radio')
        .map((r) => r.closest('label')?.textContent?.trim());
    };
    const firstOrder = getLabels();
    rerender(<ChatMissionComposer companyId="company-1" projectId="project-1" />);
    const secondOrder = getLabels();
    expect(secondOrder).toEqual(firstOrder);
    expect(secondOrder).toEqual([
      'Auto',
      'Fast',
      'Deep Work',
      'Analyst',
      'Alpha',
      'Bravo',
      'Charlie',
    ]);
  });

  // ── VAL-MODEQ-149: Browser drafts are principal isolated ──────────────

  it('stores drafts in sessionStorage with the principal ID in the key', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useSession.mockReturnValue(sessionResult('user-principal-1'));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Principal 1 draft' },
    });
    let foundKey = false;
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key && key.includes('user-principal-1')) {
        foundKey = true;
        break;
      }
    }
    expect(foundKey).toBe(true);
  });

  it('does not allow a different principal to read the prior principal drafts', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useSession.mockReturnValue(sessionResult('user-principal-1'));
    const { unmount } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Principal 1 chat' },
    });
    selectMission();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Principal 1 mission' },
    });
    unmount();
    mocks.useSession.mockReturnValue(sessionResult('user-principal-2'));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('');
    selectMission();
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('');
  });

  it('draft values do not appear in URLs or cross-tab broadcasts', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    mocks.useSession.mockReturnValue(sessionResult('user-principal-1'));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Secret chat draft content' },
    });
    expect(window.location.href).not.toContain('Secret chat draft content');
    expect(localStorage.getItem('Secret chat draft content')).toBeNull();
  });
});
