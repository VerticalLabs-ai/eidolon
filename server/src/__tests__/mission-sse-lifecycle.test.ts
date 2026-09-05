import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import * as schema from '@eidolon/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbInstance } from '../types.js';
import { MissionStreamService } from '../services/mission/stream.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(listenResult?: Promise<{ unlisten: () => Promise<void> }>) {
  let notify = () => {};
  const unlisten = vi.fn(async () => {});
  const readEvents = vi.fn(async (): Promise<never[]> => []);
  const listen = vi.fn((_channel: string, callback: () => void) => {
    notify = callback;
    return listenResult ?? Promise.resolve({ unlisten });
  });
  const db = {
    schema,
    client: { listen },
    drizzle: {
      select: () => ({
        from: (table: unknown) => {
          const query = {
            where: () => query,
            orderBy: () => query,
            limit: () =>
              table === schema.runEvents
                ? readEvents()
                : Promise.resolve([{ lastEventSequence: 0, status: 'draft' }]),
          };
          return query;
        },
      }),
    },
  } as unknown as DbInstance;
  const req = new EventEmitter() as Request;
  const res = Object.assign(new EventEmitter(), {
    writableEnded: false,
    writableLength: 0,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(() => {
      res.writableEnded = true;
    }),
  });
  const open = () =>
    new MissionStreamService(db).stream(
      {
        companyId: 'company',
        projectId: 'project',
        runId: 'run',
        after: 0,
        lastEventId: null,
      },
      req,
      res as unknown as Response,
    );
  return { open, req, res, readEvents, unlisten, listen, notify: () => notify() };
}

describe('Mission SSE notification lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv(
      'EIDOLON_FEATURE_FLAGS',
      JSON.stringify({
        missionAgentIntelligence: { enabled: true },
        missionPolish: { enabled: true },
      }),
    );
    vi.stubEnv('MISSION_SSE_POLL_MS', '200');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('keeps polling after a timer overlaps a notification read', async () => {
    const h = harness();
    await h.open();
    const pending = deferred<never[]>();
    h.readEvents.mockImplementationOnce(() => pending.promise);
    h.notify();
    await vi.advanceTimersByTimeAsync(200);
    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.readEvents).toHaveBeenCalledTimes(3);
    h.req.emit('close');
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('polls while LISTEN connects and releases a listener established after disconnect', async () => {
    const pending = deferred<{ unlisten: () => Promise<void> }>();
    const h = harness(pending.promise);
    const opening = h.open();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.listen).toHaveBeenCalledOnce();
    expect(h.readEvents.mock.calls.length).toBeGreaterThan(1);
    h.req.emit('close');
    const unlisten = vi.fn(async () => {});
    pending.resolve({ unlisten });
    await opening;
    expect(unlisten).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a failed journal tail so the client can reconnect', async () => {
    const h = harness();
    await h.open();
    h.readEvents.mockRejectedValueOnce(new Error('database disconnected'));
    await vi.advanceTimersByTimeAsync(200);
    expect(h.res.end).toHaveBeenCalledOnce();
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back to polling when LISTEN fails', async () => {
    const h = harness();
    h.listen.mockRejectedValueOnce(new Error('LISTEN unavailable'));
    await h.open();
    await vi.advanceTimersByTimeAsync(400);
    expect(h.readEvents).toHaveBeenCalledTimes(3);
    expect(h.res.end).not.toHaveBeenCalled();
    h.req.emit('close');
  });
});
