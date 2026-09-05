import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useMissionRunChildren, useMissionRunEvents } from '../src/lib/hooks';
import * as api from '../src/lib/api';

vi.mock('../src/lib/api', () => ({ getMissionRunChildren: vi.fn(), getMissionRunEvents: vi.fn() }));

describe('Mission child-tree response contract', () => {
  it('unwraps the server tree envelope', async () => {
    const tree: api.MissionChildTreeNode = {
      runId: 'run',
      status: 'running',
      cost: 12,
      stepKey: null,
      routingInfo: { mode: 'deep_work', model: null, provider: null },
      children: [],
    };
    vi.mocked(api.getMissionRunChildren).mockResolvedValueOnce({ data: { tree } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useMissionRunChildren('company', 'project', 'run'), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(tree);
  });

  it('does not request the Phase 2 endpoint when disabled', async () => {
    vi.mocked(api.getMissionRunChildren).mockClear();
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useMissionRunChildren('company', 'project', 'run', { enabled: false }),
      { wrapper },
    );
    expect(result.current.fetchStatus).toBe('idle');
    expect(api.getMissionRunChildren).not.toHaveBeenCalled();
  });
});

it('drains event pages through the newest durable event after cache invalidation', async () => {
  let latest = 125;
  vi.mocked(api.getMissionRunEvents).mockImplementation(
    async (_company, _project, _run, after = 0) => {
      const end = Math.min(after + 50, latest);
      return {
        data: {
          events: Array.from({ length: end - after }, (_, i) => ({
            sequence: after + i + 1,
            type: 'execution.progress',
            payload: {},
          })) as api.MissionReplayEvent[],
          nextCursor: end,
          latestSequence: latest,
        },
      };
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useMissionRunEvents('company', 'project', 'run'), {
    wrapper,
  });
  await waitFor(() => expect(result.current.data?.events.at(-1)?.sequence).toBe(125));
  latest = 180;
  await client.invalidateQueries({ queryKey: ['mission-run-events', 'company', 'project', 'run'] });
  await waitFor(() => expect(result.current.data?.events.at(-1)?.sequence).toBe(180));
  expect(result.current.data?.events).toHaveLength(180);
  unmount();
  client.clear();
});
