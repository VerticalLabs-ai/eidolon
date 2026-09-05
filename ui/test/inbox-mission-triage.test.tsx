import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Inbox } from '../src/pages/Inbox';
import type { InboxItem, InboxResponse } from '../src/lib/api';

/**
 * Governance surface convergence — Inbox triage cannot resolve a Mission
 * action (VAL-CROSS-087). Marking a Mission question/approval item read or
 * archived never answers, approves, rejects, cancels, or hides it from the
 * pending-action filter; only the domain command resolves it, independently
 * of read state.
 */

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
      user: { id: 'dev-user-000', name: 'Op', email: 'l@e.dev', image: '', role: 'admin' },
      session: {
        id: 's',
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
  return { ...actual, useNavigate: () => mocks.navigate };
});

function inboxResponse(items: InboxItem[], meta?: Partial<InboxResponse['meta']>): InboxResponse {
  return {
    data: items,
    meta: {
      pendingApprovals: items.filter((i) => i.kind === 'approval').length,
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

function missionApprovalItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'approval:ap-mission',
    kind: 'approval',
    title: 'Mission plan approval — revision 1',
    subtitle: 'Approve or reject the Mission plan',
    status: 'pending',
    entityType: 'approval',
    entityId: 'ap-mission',
    projectId: 'proj-1',
    runId: 'run-1',
    actionable: true,
    link: '/company/comp-1/approvals?focus=ap-mission',
    createdAt: '2026-08-23T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

function renderInbox(companyId = 'comp-1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/company/${companyId}/inbox`]}>
        <Routes>
          <Route path="/company/:companyId/inbox" element={<Inbox />} />
          <Route path="/company/:companyId/projects/:projectId" element={<div>project work</div>} />
          <Route path="/company/:companyId/approvals" element={<div>approvals</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useMarkInboxRead.mockReturnValue({ mutate: vi.fn(), isPending: false });
  mocks.useMarkInboxUnread.mockReturnValue({ mutate: vi.fn(), isPending: false });
});

describe('VAL-CROSS-087: Inbox triage cannot resolve a Mission action', () => {
  it('shows an explicit needs-action indicator for an actionable mission question, independent of read state', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem({ readAt: null })]),
      isLoading: false,
    });
    renderInbox();
    // Needs-action indicator is present for an unread actionable item.
    expect(screen.getByText(/needs action/i)).toBeInTheDocument();
  });

  it('keeps the needs-action indicator after the item is marked read', () => {
    // The same item, now read, remains actionable — triage does not resolve it.
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem({ readAt: '2026-08-23T11:00:00.000Z' })]),
      isLoading: false,
    });
    renderInbox();
    expect(screen.getByText(/needs action/i)).toBeInTheDocument();
    // The pending mission question count still includes the read-but-actionable item.
    const header = screen.getByText(
      (_, el) => el?.tagName === 'SPAN' && (el.textContent ?? '').includes('mission questions'),
    );
    expect(header).toBeInTheDocument();
    expect(header.textContent).toMatch(/1 mission questions/i);
  });

  it('explains in the detail pane that triage does not resolve the Mission question', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem()]),
      isLoading: false,
    });
    renderInbox();
    // The detail pane auto-renders the selected item.
    expect(screen.getByText(/marking this read or archived does not answer/i)).toBeInTheDocument();
    // The Open control (domain-command path) remains available.
    expect(screen.getByRole('button', { name: /^open$/i })).toBeInTheDocument();
  });

  it('marks read via triage without firing a Mission domain command', () => {
    const markReadMutate = vi.fn();
    mocks.useMarkInboxRead.mockReturnValue({ mutate: markReadMutate, isPending: false });
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem()]),
      isLoading: false,
    });
    renderInbox();
    // Activating the header "Mark all read" only triages inbox rows — it
    // does not answer/approve/reject/cancel the Mission action.
    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }));
    expect(markReadMutate).toHaveBeenCalledWith(['mission_question:set-1']);
    // No navigation to a domain-command surface was triggered by triage.
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('shows the needs-action indicator for an actionable mission approval item', () => {
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionApprovalItem()]),
      isLoading: false,
    });
    renderInbox();
    expect(screen.getByText(/needs action/i)).toBeInTheDocument();
  });

  it('keyboard activation of Open navigates to the domain-command surface (not triage)', async () => {
    const user = userEvent.setup();
    mocks.useInbox.mockReturnValue({
      data: inboxResponse([missionQuestionItem()]),
      isLoading: false,
    });
    renderInbox();
    const openButton = screen.getByRole('button', { name: /^open$/i });
    openButton.focus();
    await user.keyboard('{Enter}');
    expect(mocks.navigate).toHaveBeenCalledTimes(1);
  });
});
