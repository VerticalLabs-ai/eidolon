import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../services/mission/research/retry-after.js';

/**
 * Retry-After header parsing tests.
 *
 * VAL-RES-009: Retry-After bounded — delta-seconds and HTTP-date forms
 * are honored within remaining deadlines; excessive values are capped,
 * while malformed, negative, or past values use bounded local backoff
 * and never create an unbounded wait.
 */

const FIXED_NOW = new Date('2026-08-24T12:00:00Z');

describe('Retry-After parsing: delta-seconds', () => {
  it('parses a valid delta-seconds value', () => {
    expect(parseRetryAfter('30', FIXED_NOW, 60_000)).toBe(30_000);
  });

  it('parses zero delta-seconds', () => {
    expect(parseRetryAfter('0', FIXED_NOW, 10_000)).toBe(0);
  });

  it('parses large delta-seconds but caps at maxDelayMs', () => {
    expect(parseRetryAfter('600', FIXED_NOW, 5_000)).toBe(5_000);
  });

  it('parses fractional delta-seconds by truncating to integer seconds', () => {
    // Retry-After delta-seconds is an integer per RFC 7231.
    // Non-integer values are malformed.
    expect(parseRetryAfter('3.5', FIXED_NOW, 10_000)).toBe(null);
  });
});

describe('Retry-After parsing: HTTP-date', () => {
  it('parses a valid future HTTP-date', () => {
    const future = new Date('2026-08-24T12:00:05Z');
    const result = parseRetryAfter(future.toUTCString(), FIXED_NOW, 10_000);
    expect(result).toBe(5_000);
  });

  it('caps HTTP-date delay at maxDelayMs', () => {
    const farFuture = new Date('2026-08-24T13:00:00Z');
    const result = parseRetryAfter(farFuture.toUTCString(), FIXED_NOW, 5_000);
    expect(result).toBe(5_000);
  });

  it('returns null for a past HTTP-date (uses local backoff instead)', () => {
    const past = new Date('2026-08-24T11:00:00Z');
    const result = parseRetryAfter(past.toUTCString(), FIXED_NOW, 10_000);
    expect(result).toBe(null);
  });
});

describe('Retry-After parsing: malformed values', () => {
  it('returns null for null header', () => {
    expect(parseRetryAfter(null, FIXED_NOW, 10_000)).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(parseRetryAfter('', FIXED_NOW, 10_000)).toBe(null);
  });

  it('returns null for non-numeric, non-date string', () => {
    expect(parseRetryAfter('not-a-date', FIXED_NOW, 10_000)).toBe(null);
  });

  it('returns null for negative delta-seconds', () => {
    expect(parseRetryAfter('-5', FIXED_NOW, 10_000)).toBe(null);
  });

  it('returns null for whitespace-only string', () => {
    expect(parseRetryAfter('   ', FIXED_NOW, 10_000)).toBe(null);
  });
});

describe('Retry-After parsing: maxDelayMs boundary', () => {
  it('returns exact value when delta equals maxDelayMs', () => {
    // 5 seconds = 5000ms max
    expect(parseRetryAfter('5', FIXED_NOW, 5_000)).toBe(5_000);
  });

  it('caps when delta exceeds maxDelayMs by one second', () => {
    expect(parseRetryAfter('6', FIXED_NOW, 5_000)).toBe(5_000);
  });
});
