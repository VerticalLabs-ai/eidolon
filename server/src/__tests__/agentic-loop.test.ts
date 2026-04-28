import { describe, expect, it } from 'vitest';
import {
  buildAgenticLoopRetryMetadata,
  MAX_CONTINUATION_RETRIES,
} from '../services/agentic-loop.js';
import {
  EXECUTION_CONTINUATION_RETRY_DELAY_MS,
  EXECUTION_RETRY_BASE_DELAY_MS,
  EXECUTION_RETRY_JITTER_MAX,
  EXECUTION_RETRY_JITTER_MIN,
  EXECUTION_RETRY_MAX_BACKOFF_MS,
} from '../services/execution-retry.js';

describe('AgenticLoop retry metadata', () => {
  it('caps continuation retries after max steps are reached', () => {
    const completedAt = new Date('2026-04-28T12:00:00.000Z');

    const scheduled = buildAgenticLoopRetryMetadata(
      'max_steps_reached',
      completedAt,
      MAX_CONTINUATION_RETRIES - 1,
    );
    expect(scheduled).toEqual(expect.objectContaining({
      retryAttempt: MAX_CONTINUATION_RETRIES,
      retryStatus: 'scheduled',
      failureCategory: 'max_steps_reached',
    }));
    expect(scheduled.retryDueAt).toEqual(
      new Date(completedAt.getTime() + EXECUTION_CONTINUATION_RETRY_DELAY_MS),
    );

    const exhausted = buildAgenticLoopRetryMetadata(
      'max_steps_reached',
      completedAt,
      MAX_CONTINUATION_RETRIES,
    );
    expect(exhausted).toEqual({
      retryAttempt: MAX_CONTINUATION_RETRIES,
      retryStatus: 'exhausted',
      retryDueAt: null,
      failureCategory: 'max_steps_reached',
    });
  });

  it('caps repeated failed retries', () => {
    const completedAt = new Date('2026-04-28T12:00:00.000Z');

    const scheduled = buildAgenticLoopRetryMetadata(
      'failed',
      completedAt,
      MAX_CONTINUATION_RETRIES - 1,
    );
    expect(scheduled).toEqual(expect.objectContaining({
      retryAttempt: MAX_CONTINUATION_RETRIES,
      retryStatus: 'scheduled',
      failureCategory: 'agentic_loop_error',
    }));
    const baseDelay = Math.min(
      EXECUTION_RETRY_BASE_DELAY_MS * 2 ** (MAX_CONTINUATION_RETRIES - 1),
      EXECUTION_RETRY_MAX_BACKOFF_MS,
    );
    const minDueAt = completedAt.getTime() + Math.floor(baseDelay * EXECUTION_RETRY_JITTER_MIN);
    const maxDueAt = completedAt.getTime() + Math.min(
      Math.floor(baseDelay * EXECUTION_RETRY_JITTER_MAX),
      EXECUTION_RETRY_MAX_BACKOFF_MS,
    );
    expect(scheduled.retryDueAt).toBeInstanceOf(Date);
    expect(scheduled.retryDueAt?.getTime()).toBeGreaterThanOrEqual(minDueAt);
    expect(scheduled.retryDueAt?.getTime()).toBeLessThanOrEqual(maxDueAt);

    const exhausted = buildAgenticLoopRetryMetadata(
      'failed',
      completedAt,
      MAX_CONTINUATION_RETRIES,
    );
    expect(exhausted).toEqual({
      retryAttempt: MAX_CONTINUATION_RETRIES,
      retryStatus: 'exhausted',
      retryDueAt: null,
      failureCategory: 'agentic_loop_error',
    });
  });

  it('preserves retry attempt history when a later run completes', () => {
    const completedAt = new Date('2026-04-28T12:00:00.000Z');

    expect(buildAgenticLoopRetryMetadata('completed', completedAt, 2)).toEqual({
      retryAttempt: 2,
      retryStatus: 'none',
      retryDueAt: null,
      failureCategory: null,
    });
  });

  it('treats input requests as non-retry outcomes', () => {
    const completedAt = new Date('2026-04-28T12:00:00.000Z');

    expect(buildAgenticLoopRetryMetadata('needs_input', completedAt, 1)).toEqual({
      retryAttempt: 1,
      retryStatus: 'none',
      retryDueAt: null,
      failureCategory: null,
    });
  });
});
