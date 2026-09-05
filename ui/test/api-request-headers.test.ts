import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCompany, startMissionRun } from '../src/lib/api';

const fetchMock = vi.fn();

describe('api request() header merging', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  // VAL-RUN-126 / VAL-CROSS-002: UI POST mutations must set
  // Content-Type: application/json. The request() helper previously spread
  // ...options after the merged headers object, so a caller-supplied
  // `headers` field overwrote Content-Type entirely and the server rejected
  // the body with 400 VALIDATION_ERROR.
  it('preserves Content-Type: application/json on a POST that supplies caller headers', async () => {
    await createCompany({ name: 'Test' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('merges caller-supplied headers with the default Content-Type', async () => {
    await startMissionRun(
      'company-1',
      'project-1',
      {
        projectThreadId: 'thread-1',
        mode: 'auto',
        request: { text: 'do the thing' },
      },
      'idem-key-1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    // Both the default Content-Type and the caller's Idempotency-Key survive.
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Idempotency-Key']).toBe('idem-key-1');
  });

  it('still sets Content-Type on a POST with no caller headers', async () => {
    await createCompany({ name: 'NoHeaders' });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });
});
