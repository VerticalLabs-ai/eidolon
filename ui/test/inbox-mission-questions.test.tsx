import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Inbox } from '../src/pages/Inbox';
import type { InboxItem, InboxResponse } from '../src/lib/api';

const mocks = vi.hoisted(() => ({
  useInbox: vi.fn(),
  useMarkInboxRead: vi.fn(),
  useMarkInboxUnread: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@/lib/hooks', async () => {
  const actual = await vi.importActual('@/lib/hooks');
  return {
    ...actual,
    useInbox: mocks.useInbox,
    useMarkInboxRead: mocks.useMarkInboxRead,
    useMarkInboxUnread: mocks.useMarkInboxUnread,
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

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mocks.navigate,
  };
});

function inboxResponse(items: InboxItem[], meta?: Partial<InboxResponse['meta']>): InboxResponse {
  return {
    data: items,
    meta: {
      pendingApprovals: 0,
      pendingCollaborations: 0,
      pendingThreadItems: 0,
      pendingMissionQuestions: items.filter((i) => i.kind === 'mission_question' && i.actionable)
        .length,
      total: items.length,
      unread: items.filter((i) => !i.readAt).length,
      ...meta,
    },
  };
}

function missionQuestionItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'mission_question:set-1',
    kind: 'mission_question',
    title: 'Mission needs input',
    subtitle: 'Mission is awaiting your answer',
    status: 'open',
    entityType: 'mission_question_set',
    entityId: 'set-1',
    projectId: 'proj-1',
    runId: 'run-1',
    questionSetId: 'set-1',
    actionable: true,
    link: '/company/comp-1/projects/proj-1?tab=work&thread=thread-1&mission=run-1&question=set-1',
    createdAt: '2026-08-23T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

/** Row text elements exclude the detail-pane heading (h2) so row vs detail
 * occurrences can be distinguished. The detail pane auto-renders the
 * selected item, so title/subtitle text appears in both surfaces. */
function rowTextAll(text: string | RegExp): HTMLElement[] {
  return screen.getAllByText(text).filter((el) => el.tagName !== 'H2');
}

/** Assert the inbox header summary surfaces the pending mission question
 * count. The count is split across `<strong>` and text nodes, so match on
 * the surrounding summary span. */
function expectMissionQuestionCountInHeader() {
  const header = screen.getByText(
    (_, el) => el?.tagName === 'SPAN' && (el.textContent ?? '').includes('mission questions'),
  );
  expect(header).toBeInTheDocument();
  expect(header.textContent).toMatch(/1 mission questions/i);
}

function renderInbox(companyId = 'comp-1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  mocks.useMarkInboxRead.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.useMarkInboxUnread.mockReturnValue({ mutate: vi.fn(), isPending: false });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/company/${companyId}/inbox`]}>
        <Routes>
          <Route path="/company/:companyId/inbox" element={<Inbox />} />
          <Route path="/company/:companyId/projects/:projectId" element={<div>project work</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Inbox — mission question needs-attention items', () => {
  it('renders an active mission question item with explicit waiting text (VAL-MODEQ-087, 091)', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem()]),
      isLoading: false,
    });
    renderInbox();

    // The row surface exposes the title (text, not color alone).
    expect(rowTextAll('Mission needs input').length).toBeGreaterThanOrEqual(1);
    // Waiting state is explicit text identifying the input need.
    expect(rowTextAll(/awaiting your answer/i).length).toBeGreaterThanOrEqual(1);
    // Pending mission question count appears in the header summary.
    expectMissionQuestionCountInHeader();
  });

  it('deduplicates to one row per open question set (VAL-MODEQ-089)', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem()]),
      isLoading: false,
    });
    renderInbox();

    // Exactly one row (the detail-pane h2 is filtered out).
    expect(rowTextAll('Mission needs input')).toHaveLength(1);
    expectMissionQuestionCountInHeader();
  });

  it('opens the Project Work Mission question deep link without starting a second run (VAL-MODEQ-088)', async () => {
    const user = userEvent.setup();
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem()]),
      isLoading: false,
    });
    renderInbox();

    // The first (only) item is auto-selected, so the detail-pane Open
    // control is already present. Activating it navigates to the deep link.
    const openButton = await screen.findByRole('button', { name: /^open$/i });
    await user.click(openButton);

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    const target = mocks.navigate.mock.calls[0][0] as string;
    expect(target).toContain('/company/comp-1/projects/proj-1');
    expect(target).toContain('tab=work');
    expect(target).toContain('mission=run-1');
    expect(target).toContain('question=set-1');
  });

  it('retains answered sets as non-actionable resolved history (VAL-MODEQ-090, 120)', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([
        missionQuestionItem({
          id: 'mission_question:set-answered',
          questionSetId: 'set-answered',
          entityId: 'set-answered',
          title: 'Mission question resolved',
          subtitle: 'Set answered',
          status: 'answered',
          actionable: false,
          link: '/company/comp-1/projects/proj-1?tab=work&thread=thread-1&mission=run-1&question=set-answered',
          readAt: '2026-08-23T11:00:00.000Z',
        }),
      ]),
      isLoading: false,
    });
    renderInbox();

    // Resolved history is retained and conveyed as text (VAL-MODEQ-091).
    expect(rowTextAll('Mission question resolved').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/set answered/i).length).toBeGreaterThanOrEqual(1);
    // No active pending mission question remains.
    expect(screen.queryByText(/mission questions/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Mission needs input')).not.toBeInTheDocument();
  });

  it('distinguishes invalidated resolved history with the invalidation reason (VAL-MODEQ-090, 142)', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([
        missionQuestionItem({
          id: 'mission_question:set-inv',
          questionSetId: 'set-inv',
          entityId: 'set-inv',
          title: 'Mission question resolved',
          subtitle: 'Set invalidated (cancelled)',
          status: 'invalidated',
          actionable: false,
          link: '/company/comp-1/projects/proj-1?tab=work&thread=thread-1&mission=run-1&question=set-inv',
          readAt: null,
        }),
      ]),
      isLoading: false,
    });
    renderInbox();

    expect(screen.getAllByText(/set invalidated/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/cancelled/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders nothing for mission questions when the feed is empty', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([]),
      isLoading: false,
    });
    renderInbox();

    expect(screen.queryByText('Mission needs input')).not.toBeInTheDocument();
    expect(screen.queryByText(/mission questions/i)).not.toBeInTheDocument();
  });

  it('renders the mission question item alongside other inbox kinds without cross-contamination', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([
        missionQuestionItem(),
        {
          id: 'approval:ap-1',
          kind: 'approval',
          title: 'Raise marketing budget',
          status: 'pending',
          link: '/company/comp-1/approvals?focus=ap-1',
          createdAt: '2026-08-23T09:00:00.000Z',
          readAt: null,
        } as InboxItem,
      ]),
      isLoading: false,
    });
    renderInbox();

    expect(rowTextAll('Mission needs input').length).toBeGreaterThanOrEqual(1);
    expect(rowTextAll('Raise marketing budget').length).toBeGreaterThanOrEqual(1);
  });
});

describe('Inbox — mission question item accessible semantics', () => {
  it('exposes the Inbox primary heading and a selectable question attention row', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem()]),
      isLoading: false,
    });
    renderInbox();

    expect(screen.getByRole('heading', { name: /inbox/i, level: 1 })).toBeInTheDocument();
    expect(rowTextAll('Mission needs input')).toHaveLength(1);
  });

  it('keyboard activation of the Open control navigates to the deep link (VAL-MODEQ-088)', async () => {
    const user = userEvent.setup();
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem()]),
      isLoading: false,
    });
    renderInbox();

    const openButton = await screen.findByRole('button', { name: /^open$/i });
    openButton.focus();
    expect(openButton).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
});
