import { afterEach, describe, expect, it } from 'vitest';
import { backgroundWork } from '../services/background-work.js';

// ---------------------------------------------------------------------------
// Background work tracker — unit tests for the drain/track/fire API
// ---------------------------------------------------------------------------

describe('BackgroundWorkTracker', () => {
  afterEach(() => {
    backgroundWork.reset();
  });

  it('drain() returns immediately when no work is pending', async () => {
    expect(backgroundWork.pendingCount).toBe(0);
    await backgroundWork.drain();
    expect(backgroundWork.pendingCount).toBe(0);
  });

  it('fire() tracks a promise and drain() awaits it', async () => {
    let resolved = false;
    backgroundWork.fire(
      new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
        resolved = true;
      }),
      'test-work',
    );
    expect(backgroundWork.pendingCount).toBe(1);
    await backgroundWork.drain();
    expect(backgroundWork.pendingCount).toBe(0);
    expect(resolved).toBe(true);
  });

  it('drain() awaits multiple concurrent promises', async () => {
    let count = 0;
    for (let i = 0; i < 5; i++) {
      backgroundWork.fire(
        new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
          count++;
        }),
        `test-work-${i}`,
      );
    }
    expect(backgroundWork.pendingCount).toBe(5);
    await backgroundWork.drain();
    expect(backgroundWork.pendingCount).toBe(0);
    expect(count).toBe(5);
  });

  it('fire() swallows errors (logged, not re-thrown) and drain() still resolves', async () => {
    backgroundWork.fire(
      Promise.reject(new Error('boom')),
      'failing-work',
    );
    expect(backgroundWork.pendingCount).toBe(1);
    // drain should not throw
    await backgroundWork.drain();
    expect(backgroundWork.pendingCount).toBe(0);
  });

  it('track() re-throws errors to the caller but still drains', async () => {
    const tracked = backgroundWork.track(
      Promise.reject(new Error('boom')),
      'failing-work',
    );
    // The tracked promise rejects
    await expect(tracked).rejects.toThrow('boom');
    // But the tracker has cleaned it up
    await backgroundWork.drain();
    expect(backgroundWork.pendingCount).toBe(0);
  });

  it('drain() picks up work added during drain', async () => {
    let phase = 0;
    backgroundWork.fire(
      (async () => {
        // First work completes, then fires a second work
        phase = 1;
        backgroundWork.fire(
          (async () => {
            phase = 2;
          })(),
          'second-work',
        );
      })(),
      'first-work',
    );
    await backgroundWork.drain();
    expect(phase).toBe(2);
    expect(backgroundWork.pendingCount).toBe(0);
  });

  it('reset() clears the pending set without awaiting', async () => {
    let resolved = false;
    backgroundWork.fire(
      new Promise((resolve) => setTimeout(resolve, 50)).then(() => {
        resolved = true;
      }),
      'long-work',
    );
    expect(backgroundWork.pendingCount).toBe(1);
    backgroundWork.reset();
    expect(backgroundWork.pendingCount).toBe(0);
    // The underlying promise still resolves, but is no longer tracked
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(resolved).toBe(true);
  });
});
