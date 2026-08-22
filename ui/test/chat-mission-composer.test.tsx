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
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useFeatureFlags: mocks.useFeatureFlags,
    useProjectThreads: mocks.useProjectThreads,
    useCreateThreadItem: mocks.useCreateThreadItem,
    useStartMissionRun: mocks.useStartMissionRun,
  };
});

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

describe('ChatMissionComposer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    mocks.useProjectThreads.mockReturnValue(threadsResult());
    mocks.useCreateThreadItem.mockReturnValue(createThreadItemResult());
    mocks.useStartMissionRun.mockReturnValue(startMissionResult());
  });

  // VAL-RUN-001 / VAL-CROSS-001: Mission entry is visible when enabled
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

  it('reveals mode selector and guidance after selecting Mission', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    // Mode selector not visible initially
    expect(screen.queryByLabelText(/mission mode/i)).not.toBeInTheDocument();
    // Select Mission
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    // Mode selector appears
    expect(screen.getByLabelText(/mission mode/i)).toBeInTheDocument();
    // Guidance text appears
    expect(screen.getByText(/mission sends an asynchronous/i)).toBeInTheDocument();
  });

  it('can return to Chat from Mission without leaving the project', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    expect(screen.getByLabelText(/mission mode/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /chat/i }));
    expect(screen.queryByLabelText(/mission mode/i)).not.toBeInTheDocument();
  });

  // VAL-RUN-002 / VAL-CROSS-054: Disabled flag hides Mission
  it('hides Mission control when the feature flag is disabled', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('radio', { name: /mission/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/mission mode/i)).not.toBeInTheDocument();
  });

  it('does not render a Mission start action or placeholder when disabled', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('button', { name: /start mission/i })).not.toBeInTheDocument();
  });

  // VAL-RUN-003: Malformed flag fails closed
  it('hides Mission when the flag query errors (malformed config fails closed)', () => {
    mocks.useFeatureFlags.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('radio', { name: /mission/i })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /chat/i })).toBeInTheDocument();
  });

  it('hides Mission while flags are loading (fail-closed default)', () => {
    mocks.useFeatureFlags.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.queryByRole('radio', { name: /mission/i })).not.toBeInTheDocument();
  });

  // VAL-RUN-004 / VAL-RUN-005: Legacy Chat remains usable
  it('shows a Chat input and send button when flag is disabled', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument();
  });

  it('posts a Chat message through the legacy thread-item path', () => {
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
    // Chat is selected by default
    const input = screen.getByLabelText(/chat message/i);
    fireEvent.change(input, { target: { value: 'Chat alongside Mission' } });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'comment', content: 'Chat alongside Mission' }),
    );
    // Mission start was not called
    expect(mocks.useStartMissionRun().mutate).not.toHaveBeenCalled();
  });

  // VAL-CROSS-005: Chat remains independent
  it('preserves Chat draft when switching to Mission and back', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    const chatInput = screen.getByLabelText(/chat message/i);
    fireEvent.change(chatInput, { target: { value: 'My chat draft' } });
    // Switch to Mission
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    // Chat input is hidden; Mission request input is visible
    expect(screen.queryByLabelText(/chat message/i)).not.toBeInTheDocument();
    const missionInput = screen.getByLabelText(/mission request/i);
    fireEvent.change(missionInput, { target: { value: 'My mission draft' } });
    // Switch back to Chat
    fireEvent.click(screen.getByRole('radio', { name: /chat/i }));
    // Chat draft is preserved
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('My chat draft');
    // Switch to Mission again — Mission draft is preserved
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('My mission draft');
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

  // VAL-RUN-007: Entry remains project scoped
  it('does not carry drafts from a different project', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const { unmount } = render(
      <ChatMissionComposer companyId="company-1" projectId="project-1" />,
      { wrapper },
    );
    fireEvent.change(screen.getByLabelText(/chat message/i), {
      target: { value: 'Project 1 draft' },
    });
    // Unmount and render a fresh instance for a different project
    unmount();
    render(<ChatMissionComposer companyId="company-1" projectId="project-2" />, { wrapper });
    expect(screen.getByLabelText(/chat message/i)).toHaveValue('');
  });

  // VAL-RUN-008 / VAL-CROSS-002: Mission controls have accessible names and keyboard operability
  it('exposes an accessible name for the Chat/Mission control group', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    const group = screen.getByRole('radiogroup', { name: /chat or mission/i });
    expect(group).toBeInTheDocument();
  });

  it('exposes accessible names for the request input, mode selector, and start action', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    expect(screen.getByLabelText(/mission request/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/mission mode/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start mission/i })).toBeInTheDocument();
  });

  it('disables the Chat send button when the input is empty', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(false));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    expect(screen.getByRole('button', { name: /send/i })).toBeDisabled();
  });

  it('disables the Mission start button when the request is empty', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    expect(screen.getByRole('button', { name: /start mission/i })).toBeDisabled();
  });

  it('enables the Mission start button when the request has text and a thread is selected', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Analyze the quarterly report' },
    });
    expect(screen.getByRole('button', { name: /start mission/i })).not.toBeDisabled();
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
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Research competitor pricing' },
    });
    fireEvent.change(screen.getByLabelText(/mission mode/i), {
      target: { value: 'deep_work' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    const call = mutate.mock.calls[0][0];
    expect(call.body.projectThreadId).toBe('thread-1');
    expect(call.body.mode).toBe('deep_work');
    expect(call.body.request.text).toBe('Research competitor pricing');
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
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
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

  // Keyboard operability
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

    // Tab to the radiogroup and select Mission
    const missionRadio = screen.getByRole('radio', { name: /mission/i });
    await user.click(missionRadio);
    expect(screen.getByLabelText(/mission mode/i)).toBeInTheDocument();

    // Type a request
    const requestInput = screen.getByLabelText(/mission request/i);
    await user.type(requestInput, 'Keyboard mission request');

    // Click start
    await user.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].body.request.text).toBe('Keyboard mission request');
  });

  it('offers all four built-in modes in the mode selector', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    const selector = screen.getByLabelText(/mission mode/i) as HTMLSelectElement;
    const values = Array.from(selector.options).map((o) => o.value);
    expect(values).toEqual(expect.arrayContaining(['auto', 'fast', 'deep_work', 'analyst']));
  });

  it('shows a provisional finite budget preview before Auto resolves', () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    render(<ChatMissionComposer companyId="company-1" projectId="project-1" />, { wrapper });
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));

    expect(screen.getByText(/provisional hard ceiling/i)).toBeInTheDocument();
    expect(screen.getByText(/\$100\.00/)).toBeInTheDocument();
    expect(screen.getByText(/auto will resolve/i)).toBeInTheDocument();
  });

  it('resolves the preview for a concrete mode and preserves a lowered limit in the start payload', () => {
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
    fireEvent.click(screen.getByRole('radio', { name: /mission/i }));
    fireEvent.change(screen.getByLabelText(/mission mode/i), { target: { value: 'fast' } });

    expect(screen.getByText(/effective hard ceiling/i)).toBeInTheDocument();
    expect(screen.getByText(/\$5\.00/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/maximum mission cost/i), {
      target: { value: '2.50' },
    });
    expect(screen.getByText(/\$2\.50/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/mission request/i), {
      target: { value: 'Bounded request' },
    });
    fireEvent.keyDown(screen.getByLabelText(/mission request/i), { key: 'Enter', code: 'Enter' });
    fireEvent.submit(screen.getByRole('button', { name: /start mission/i }).closest('form')!);

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].body.limits).toEqual({ costCents: 250 });
  });

  // VAL-RUN-130 / Normative Boundary 2: a lost network response followed by
  // a second activation must replay the SAME logical start command, not a
  // fresh one, so the server's exactly-one-outcome guarantee holds and no
  // duplicate run is created.
  it('reuses the same start idempotency key across recoverable re-submissions', async () => {
    mocks.useFeatureFlags.mockReturnValue(flagsResult(true));
    const mutateSpy = vi.fn();
    // Simulate a recoverable start error (network/lost response): the
    // mutation is not pending and reports an error so the draft and key
    // are preserved for resubmission.
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
    const input = screen.getByLabelText(/mission request/i);
    await user.type(input, 'Analyze the quarterly report');

    // First activation: server may have applied the command but the
    // response was lost.
    await user.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutateSpy).toHaveBeenCalledTimes(1);
    const firstKey = mutateSpy.mock.calls[0][0].idempotencyKey;
    expect(firstKey).toBeTruthy();

    // The draft is preserved on a recoverable error (VAL-RUN-096).
    expect(screen.getByLabelText(/mission request/i)).toHaveValue('Analyze the quarterly report');

    // Second activation: must replay the identical logical start with the
    // SAME idempotency key so the server returns the original run instead
    // of creating a duplicate (VAL-RUN-052, VAL-RUN-016).
    await user.click(screen.getByRole('button', { name: /start mission/i }));
    expect(mutateSpy).toHaveBeenCalledTimes(2);
    const secondKey = mutateSpy.mock.calls[1][0].idempotencyKey;
    expect(secondKey).toBe(firstKey);
  });
});
