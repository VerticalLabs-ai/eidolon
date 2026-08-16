import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApiKeys } from '../src/components/settings/AgentApiKeys';

// ── jsdom polyfill: HTMLDialogElement.showModal / close ───────────────────
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

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    getAgentApiKeysPage: vi.fn(),
    createAgentApiKey: vi.fn(),
    revokeAgentApiKey: vi.fn(),
  };
});

vi.mock('@/lib/permissions', () => ({
  usePermission: vi.fn(),
}));

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

import { getAgentApiKeysPage, type AgentApiKey } from '@/lib/api';
import { usePermission } from '@/lib/permissions';

// ── Test fixtures ─────────────────────────────────────────────────────────

const COMPANY_ID = 'test-co';

function makeKey(id: string, name: string, extra?: Partial<AgentApiKey>): AgentApiKey {
  return {
    id,
    name,
    keyPrefix: `eid_live_${id.slice(0, 6)}`,
    role: 'member' as const,
    agentId: null,
    lastUsedAt: null,
    createdAt: `2026-01-${id.padStart(2, '0')}T00:00:00.000Z`,
    revokedAt: null,
    ...extra,
  };
}

const page1Keys = [makeKey('01', 'Production Key'), makeKey('02', 'Staging Key')];

const page2Keys = [makeKey('03', 'Dev Key'), makeKey('04', 'Test Key')];

const filteredKeys = [makeKey('01', 'Production Key')];

// ── Helpers ───────────────────────────────────────────────────────────────

function renderAgentApiKeys() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AgentApiKeys companyId={COMPANY_ID} />
    </QueryClientProvider>,
  );
}

function setupPermission(canManage = true) {
  vi.mocked(usePermission).mockReturnValue({
    role: canManage ? 'admin' : 'member',
    isLoading: false,
    isError: false,
    hasPermission: (perm: string) => {
      if (perm === 'apikeys.manage') {return canManage;}
      return false;
    },
  });
}

/**
 * Default mock: first page returns 2 keys with hasMore=true and a cursor,
 * second page returns 2 more keys with hasMore=false. When a search param
 * is provided, returns filtered results with hasMore=false.
 */
function setupDefaultApiMock() {
  vi.mocked(getAgentApiKeysPage).mockImplementation(
    async (_companyId: string, params?: { cursor?: string; limit?: number; search?: string }) => {
      if (params?.search) {
        return { data: filteredKeys, nextCursor: null, hasMore: false };
      }
      if (params?.cursor) {
        return { data: page2Keys, nextCursor: null, hasMore: false };
      }
      return { data: page1Keys, nextCursor: 'cursor-1', hasMore: true };
    },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Agent API Keys Pagination UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupPermission(true);
    setupDefaultApiMock();
  });

  // VAL-KEYS-017: search input renders
  describe('search input', () => {
    it('renders a search input at the top of the key list', async () => {
      renderAgentApiKeys();
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/search.*key/i)).toBeInTheDocument();
      });
    });

    it('triggers a debounced API call with the search parameter', async () => {
      renderAgentApiKeys();

      // Wait for initial load (no search)
      await waitFor(() => {
        expect(screen.getByText('Production Key')).toBeInTheDocument();
      });

      // Clear the mock call history after initial load
      vi.mocked(getAgentApiKeysPage).mockClear();

      // Type a search term
      const searchInput = screen.getByPlaceholderText(/search.*key/i);
      fireEvent.change(searchInput, { target: { value: 'prod' } });

      // The API should NOT be called immediately (debounced)
      // Give it a tiny moment to ensure no immediate call
      await new Promise((r) => setTimeout(r, 50));
      // No new calls yet (debounce has not fired)
      const callsAfterTyping = vi.mocked(getAgentApiKeysPage).mock.calls.length;
      expect(callsAfterTyping).toBe(0);

      // Wait for debounce to fire (300ms) and new query to complete
      await waitFor(
        () => {
          expect(vi.mocked(getAgentApiKeysPage)).toHaveBeenCalledWith(
            COMPANY_ID,
            expect.objectContaining({ search: 'prod' }),
          );
        },
        { timeout: 2000 },
      );
    });

    it('updates results to show only matching keys after search', async () => {
      renderAgentApiKeys();

      // Initial load shows page1Keys
      await waitFor(() => {
        expect(screen.getByText('Production Key')).toBeInTheDocument();
        expect(screen.getByText('Staging Key')).toBeInTheDocument();
      });

      // Type search
      const searchInput = screen.getByPlaceholderText(/search.*key/i);
      fireEvent.change(searchInput, { target: { value: 'prod' } });

      // Wait for debounce + new results (filteredKeys only has "Production Key")
      await waitFor(
        () => {
          expect(screen.getByText('Production Key')).toBeInTheDocument();
        },
        { timeout: 2000 },
      );

      // Staging Key should be gone (filtered out)
      await waitFor(
        () => {
          expect(screen.queryByText('Staging Key')).not.toBeInTheDocument();
        },
        { timeout: 2000 },
      );
    });
  });

  // VAL-KEYS-018: Load More button visibility
  describe('Load More button visibility', () => {
    it('shows a Load More button when hasMore is true', async () => {
      renderAgentApiKeys();

      await waitFor(() => {
        expect(screen.getByText('Production Key')).toBeInTheDocument();
      });

      expect(screen.getByRole('button', { name: /load more/i })).toBeInTheDocument();
    });

    it('does not show a Load More button when hasMore is false', async () => {
      // Single page, no more results
      vi.mocked(getAgentApiKeysPage).mockResolvedValue({
        data: page1Keys,
        nextCursor: null,
        hasMore: false,
      });

      renderAgentApiKeys();

      await waitFor(() => {
        expect(screen.getByText('Production Key')).toBeInTheDocument();
      });

      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });
  });

  // VAL-KEYS-019 / VAL-CROSS-005: Load More appends keys
  describe('Load More appends keys', () => {
    it('appends new keys to the end of the list without replacing existing keys', async () => {
      renderAgentApiKeys();

      // Initial page: page1Keys visible
      await waitFor(() => {
        expect(screen.getByText('Production Key')).toBeInTheDocument();
        expect(screen.getByText('Staging Key')).toBeInTheDocument();
      });

      // Click Load More
      const loadMoreBtn = screen.getByRole('button', { name: /load more/i });
      fireEvent.click(loadMoreBtn);

      // After loading more: page2Keys should be appended
      await waitFor(() => {
        expect(screen.getByText('Dev Key')).toBeInTheDocument();
        expect(screen.getByText('Test Key')).toBeInTheDocument();
      });

      // Previously displayed keys should still be visible (not replaced)
      expect(screen.getByText('Production Key')).toBeInTheDocument();
      expect(screen.getByText('Staging Key')).toBeInTheDocument();

      // Load More button should be gone (second page has hasMore=false)
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
      });
    });
  });

  // Search resets pagination
  describe('search resets pagination', () => {
    it('resets pagination and fetches the first filtered page when search changes', async () => {
      renderAgentApiKeys();

      // Load first page
      await waitFor(() => {
        expect(screen.getByText('Production Key')).toBeInTheDocument();
      });

      // Load more to get page2Keys
      fireEvent.click(screen.getByRole('button', { name: /load more/i }));
      await waitFor(() => {
        expect(screen.getByText('Dev Key')).toBeInTheDocument();
      });

      // Now search — should reset to first page of filtered results
      const searchInput = screen.getByPlaceholderText(/search.*key/i);
      fireEvent.change(searchInput, { target: { value: 'prod' } });

      // Wait for debounce + new filtered results
      await waitFor(
        () => {
          expect(screen.getByText('Production Key')).toBeInTheDocument();
        },
        { timeout: 2000 },
      );

      // Page 2 keys should be gone (pagination was reset)
      await waitFor(
        () => {
          expect(screen.queryByText('Dev Key')).not.toBeInTheDocument();
          expect(screen.queryByText('Test Key')).not.toBeInTheDocument();
        },
        { timeout: 2000 },
      );

      // No Load More button (filtered results have hasMore=false)
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });
  });

  // Permission gating
  describe('permission gating', () => {
    it('renders nothing when user lacks apikeys.manage permission', () => {
      setupPermission(false);
      renderAgentApiKeys();
      expect(screen.queryByText('Agent API Keys')).not.toBeInTheDocument();
    });
  });
});
