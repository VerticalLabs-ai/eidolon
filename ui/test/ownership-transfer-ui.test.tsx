import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyMembers } from '../src/pages/CompanyMembers';

// ── jsdom polyfill: HTMLDialogElement.showModal / close ───────────────────
// jsdom does not implement <dialog> showModal/close. The Modal component
// calls these in a useEffect. Stub them so the modal content renders.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal =
    HTMLDialogElement.prototype.showModal ||
    function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  HTMLDialogElement.prototype.close =
    HTMLDialogElement.prototype.close ||
    function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
}

// ── Module mocks ──────────────────────────────────────────────────────────

// Keep real types/classes (ApiError, Role, etc.) but mock the API functions
// so the real TanStack Query hooks exercise cache logic without hitting fetch.
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getCompany: vi.fn(),
    getMembers: vi.fn(),
    getMyRole: vi.fn(),
    getInvitations: vi.fn(),
    transferOwnership: vi.fn(),
    updateMemberRole: vi.fn(),
    removeMember: vi.fn(),
    createInvitation: vi.fn(),
    revokeInvitation: vi.fn(),
  };
});

vi.mock('@/lib/permissions', () => ({
  usePermission: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

// hooks.ts imports useServerEvents from ./ws — stub it so no WebSocket is
// opened in the test environment.
vi.mock('@/lib/ws', () => ({
  useServerEvents: vi.fn(),
  useWebSocket: vi.fn(() => ({ status: 'disconnected' })),
}));

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Import mocked functions ───────────────────────────────────────────────

import { ApiError, getCompany, getMembers, getInvitations, transferOwnership } from '@/lib/api';
import { usePermission } from '@/lib/permissions';
import { useSession } from '@/lib/auth';
import { toast } from 'sonner';

// ── Test fixtures ─────────────────────────────────────────────────────────

const COMPANY_ID = 'test-co';

const ownerMember = {
  id: 'm-owner',
  userId: 'dev-user-000',
  role: 'owner' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const adminMember = {
  id: 'm-admin',
  userId: 'dev-user-001',
  role: 'admin' as const,
  createdAt: '2026-01-02T00:00:00.000Z',
};
const memberMember = {
  id: 'm-member',
  userId: 'dev-user-002',
  role: 'member' as const,
  createdAt: '2026-01-03T00:00:00.000Z',
};

const mockCompany = {
  id: COMPANY_ID,
  name: 'Test Co',
  description: null,
  mission: null,
  status: 'active' as const,
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  settings: {},
  brandColor: null,
  logoUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const PERMISSIONS: Record<string, Record<string, boolean>> = {
  owner: {
    'member.promote': true,
    'member.remove': true,
    'member.invite': true,
  },
  admin: {
    'member.promote': false,
    'member.remove': true,
    'member.invite': true,
  },
  member: {
    'member.promote': false,
    'member.remove': false,
    'member.invite': false,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────

function renderCompanyMembers() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/company/${COMPANY_ID}/members`]}>
        <Routes>
          <Route path="/company/:companyId/members" element={<CompanyMembers />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function setupMocks(
  options: {
    role?: 'owner' | 'admin' | 'member';
    members?: (typeof ownerMember)[];
    currentUserId?: string;
  } = {},
) {
  const {
    role = 'owner',
    members = [ownerMember, adminMember, memberMember],
    currentUserId = 'dev-user-000',
  } = options;

  // Track whether a transfer has been completed so getMembers can return
  // the persisted (post-transfer) data on refetch — simulating real server
  // behavior where the transfer endpoint mutates the database.
  let transferCompleted = false;

  vi.mocked(getCompany).mockResolvedValue(mockCompany);
  vi.mocked(getMembers).mockImplementation(async () => {
    if (transferCompleted) {
      return members.map((m) => {
        if (m.id === 'm-admin') {
          return { ...m, role: 'owner' as const };
        }
        if (m.id === 'm-owner') {
          return { ...m, role: 'admin' as const };
        }
        return m;
      });
    }
    return members;
  });
  vi.mocked(getInvitations).mockResolvedValue([]);
  vi.mocked(transferOwnership).mockImplementation(async () => {
    transferCompleted = true;
    return {
      data: {
        newOwner: { id: 'm-admin', userId: 'dev-user-001', role: 'owner' as const },
        previousOwner: { id: 'm-owner', userId: 'dev-user-000', role: 'admin' as const },
      },
    };
  });

  const perms = PERMISSIONS[role] ?? {};

  vi.mocked(usePermission).mockReturnValue({
    role,
    isLoading: false,
    isError: false,
    hasPermission: (perm: string) => perms[perm] ?? false,
  });

  vi.mocked(useSession).mockReturnValue({
    data: {
      user: {
        id: currentUserId,
        name: 'Test User',
        email: 'test@test.com',
        image: '',
        role: 'admin',
      },
    },
    isPending: false,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Ownership Transfer UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMocks();
  });

  // VAL-OWNER-012 / VAL-CROSS-004: button visibility by role
  describe('button visibility', () => {
    it('owner sees Transfer Ownership button on non-owner, non-self rows', async () => {
      renderCompanyMembers();
      // Wait for members to load
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      const buttons = screen.getAllByRole('button', { name: /transfer ownership/i });
      // Admin (Dev User 001) and Member (Dev User 002) → 2 buttons
      // Owner (Dev User 000) is self + owner → 0 buttons
      expect(buttons).toHaveLength(2);
    });

    it('owner does not see Transfer Ownership on own row', async () => {
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 000')).toBeInTheDocument();
      });

      // The owner's own row (Dev User 000) should not have a transfer button
      const ownerRow = screen.getByText('Dev User 000').closest('li');
      expect(ownerRow).not.toBeNull();
      expect(
        within(ownerRow!).queryByRole('button', { name: /transfer ownership/i }),
      ).not.toBeInTheDocument();
    });

    it('owner does not see Transfer Ownership on other owner rows', async () => {
      const secondOwner = {
        id: 'm-owner2',
        userId: 'dev-user-003',
        role: 'owner' as const,
        createdAt: '2026-01-04T00:00:00.000Z',
      };
      setupMocks({
        role: 'owner',
        members: [ownerMember, secondOwner, adminMember],
        currentUserId: 'dev-user-000',
      });
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 003')).toBeInTheDocument();
      });

      // The second owner row should NOT have a transfer button
      const secondOwnerRow = screen.getByText('Dev User 003').closest('li');
      expect(secondOwnerRow).not.toBeNull();
      expect(
        within(secondOwnerRow!).queryByRole('button', { name: /transfer ownership/i }),
      ).not.toBeInTheDocument();

      // The admin row SHOULD still have a transfer button
      const adminRow = screen.getByText('Dev User 001').closest('li');
      expect(adminRow).not.toBeNull();
      expect(
        within(adminRow!).getByRole('button', { name: /transfer ownership/i }),
      ).toBeInTheDocument();
    });

    it('admin does not see Transfer Ownership button on any row', async () => {
      setupMocks({ role: 'admin', currentUserId: 'dev-user-001' });
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /transfer ownership/i })).not.toBeInTheDocument();
    });

    it('member does not see Transfer Ownership button on any row', async () => {
      setupMocks({ role: 'member', currentUserId: 'dev-user-002' });
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 002')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /transfer ownership/i })).not.toBeInTheDocument();
    });
  });

  // VAL-OWNER-013: confirmation modal
  describe('confirmation modal', () => {
    it('opens a modal identifying the target and warning about demotion on click', async () => {
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      // Click Transfer Ownership on the admin row
      const adminRow = screen.getByText('Dev User 001').closest('li');
      fireEvent.click(within(adminRow!).getByRole('button', { name: /transfer ownership/i }));

      // Modal should appear with target name and demotion warning
      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });
      // "Dev User 001" appears in both the member row and the modal text
      expect(screen.getAllByText('Dev User 001').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText(/demoted to admin/i)).toBeInTheDocument();
    });

    it('does not send an API request until the user confirms', async () => {
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      const adminRow = screen.getByText('Dev User 001').closest('li');
      fireEvent.click(within(adminRow!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      // No API call yet
      expect(vi.mocked(transferOwnership)).not.toHaveBeenCalled();
    });

    it('closes the modal without sending a request on cancel', async () => {
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      const adminRow = screen.getByText('Dev User 001').closest('li');
      fireEvent.click(within(adminRow!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      // Click Cancel
      fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

      // Modal should close
      await waitFor(() => {
        expect(screen.queryByText('Transfer ownership')).not.toBeInTheDocument();
      });

      // No API call was made
      expect(vi.mocked(transferOwnership)).not.toHaveBeenCalled();
    });
  });

  // VAL-OWNER-014 / VAL-CROSS-003: confirmation sends request and updates badges
  describe('confirmation', () => {
    it('sends exactly one POST with the target member ID on confirm', async () => {
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      const adminRow = screen.getByText('Dev User 001').closest('li');
      fireEvent.click(within(adminRow!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      // Click Confirm transfer
      fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));

      await waitFor(() => {
        expect(vi.mocked(transferOwnership)).toHaveBeenCalledTimes(1);
      });

      expect(vi.mocked(transferOwnership)).toHaveBeenCalledWith(COMPANY_ID, 'm-admin');
    });

    it('updates role badges after successful transfer without page reload', async () => {
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      // Before transfer: Dev User 000 is Owner, Dev User 001 is Admin
      const ownerRowBefore = screen.getByText('Dev User 000').closest('li');
      expect(within(ownerRowBefore!).getByText('Owner')).toBeInTheDocument();
      const adminRowBefore = screen.getByText('Dev User 001').closest('li');
      expect(within(adminRowBefore!).getByText('Admin')).toBeInTheDocument();

      // Click Transfer Ownership on admin row
      fireEvent.click(within(adminRowBefore!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      // Confirm
      fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));

      // Wait for the modal to close first (onSuccess sets transferTarget to null)
      await waitFor(() => {
        expect(screen.queryByText('Transfer ownership')).not.toBeInTheDocument();
      });

      // After transfer: Dev User 001 should be Owner, Dev User 000 should be Admin
      // (modal is closed so there's only one instance of each name in the rows)
      const adminRowAfter = screen.getByText('Dev User 001').closest('li');
      expect(within(adminRowAfter!).getByText('Owner')).toBeInTheDocument();

      const ownerRowAfter = screen.getByText('Dev User 000').closest('li');
      expect(within(ownerRowAfter!).getByText('Admin')).toBeInTheDocument();
    });

    it('shows a success toast on successful transfer', async () => {
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      const adminRow = screen.getByText('Dev User 001').closest('li');
      fireEvent.click(within(adminRow!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));

      await waitFor(() => {
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith('Ownership transferred successfully');
      });
    });

    it('closes the modal after successful transfer', async () => {
      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      const adminRow = screen.getByText('Dev User 001').closest('li');
      fireEvent.click(within(adminRow!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));

      await waitFor(() => {
        expect(screen.queryByText('Transfer ownership')).not.toBeInTheDocument();
      });
    });
  });

  // VAL-OWNER-015: error handling
  describe('error handling', () => {
    it('shows an error toast and does not update badges on API failure', async () => {
      vi.mocked(transferOwnership).mockRejectedValue(
        new ApiError(403, 'Forbidden', { code: 'INSUFFICIENT_PERMISSION' }),
      );

      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      // Before: Dev User 000 is Owner, Dev User 001 is Admin
      const ownerRowBefore = screen.getByText('Dev User 000').closest('li');
      expect(within(ownerRowBefore!).getByText('Owner')).toBeInTheDocument();
      const adminRowBefore = screen.getByText('Dev User 001').closest('li');
      expect(within(adminRowBefore!).getByText('Admin')).toBeInTheDocument();

      // Click Transfer Ownership and confirm
      fireEvent.click(within(adminRowBefore!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));

      // Error toast should appear
      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
          'Ownership transfer failed (INSUFFICIENT_PERMISSION)',
        );
      });

      // Badges should be unchanged — scope to the member list (<ul role="list">)
      // because the modal stays open on error and also contains member names.
      const memberList = screen.getByRole('list');
      const ownerRowAfter = within(memberList).getByText('Dev User 000').closest('li');
      expect(within(ownerRowAfter!).getByText('Owner')).toBeInTheDocument();
      const adminRowAfter = within(memberList).getByText('Dev User 001').closest('li');
      expect(within(adminRowAfter!).getByText('Admin')).toBeInTheDocument();
    });

    it('shows a generic error toast for non-ApiError failures', async () => {
      vi.mocked(transferOwnership).mockRejectedValue(new Error('Network error'));

      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      const adminRow = screen.getByText('Dev User 001').closest('li');
      fireEvent.click(within(adminRow!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /confirm transfer/i }));

      await waitFor(() => {
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith('Network error');
      });
    });
  });

  // Prevent duplicate submissions
  describe('pending state', () => {
    it('disables the confirm button while the request is pending', async () => {
      // Return a promise that we control so it stays pending
      let resolveTransfer: (value: unknown) => void = () => {};
      vi.mocked(transferOwnership).mockReturnValue(
        new Promise((resolve) => {
          resolveTransfer = resolve;
        }),
      );

      renderCompanyMembers();
      await waitFor(() => {
        expect(screen.getByText('Dev User 001')).toBeInTheDocument();
      });

      const adminRow = screen.getByText('Dev User 001').closest('li');
      fireEvent.click(within(adminRow!).getByRole('button', { name: /transfer ownership/i }));

      await waitFor(() => {
        expect(screen.getByText('Transfer ownership')).toBeInTheDocument();
      });

      const confirmBtn = screen.getByRole('button', { name: /confirm transfer/i });
      fireEvent.click(confirmBtn);

      // Confirm button should be disabled while pending
      await waitFor(() => {
        expect(confirmBtn).toBeDisabled();
      });

      // Only one API call should have been made
      expect(vi.mocked(transferOwnership)).toHaveBeenCalledTimes(1);

      // Cancel button should also be disabled
      expect(screen.getByRole('button', { name: /cancel/i })).toBeDisabled();

      // Resolve the promise to clean up (wrap in act to avoid state update warning)
      await act(async () => {
        resolveTransfer({
          data: {
            newOwner: { id: 'm-admin', userId: 'dev-user-001', role: 'owner' },
            previousOwner: { id: 'm-owner', userId: 'dev-user-000', role: 'admin' },
          },
        });
      });
    });
  });
});
