import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

import { wrapClientWithTracing, __resetForTesting } from '../utils/tracing.js';

// ---------------------------------------------------------------------------
// Regression test (scrutiny round 2): wrapClientWithTracing must preserve
// postgres-js Query/PendingQuery return values with all modifier methods
// (.values(), .raw(), .simple(), .cursor()). Calling .then() on a
// postgres.js Query creates a native Promise via Symbol.species, stripping
// these methods. The wrapper must NOT replace the original Query with a
// plain Promise.
// ---------------------------------------------------------------------------

/**
 * A postgres-js-like Query object. The real postgres.js Query extends
 * Promise and has `static get [Symbol.species]() { return Promise }`,
 * which means .then() returns a native Promise (not a Query). This fake
 * replicates that behavior so we can verify the wrapper preserves the
 * original Query type.
 */
class FakeQuery extends Promise<unknown[]> {
  public modifiersCalled: string[] = [];

  constructor(
    executor: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) => void,
  ) {
    super(
      executor as (
        resolve: (value: unknown[] | PromiseLike<unknown[]>) => void,
        reject: (reason?: unknown) => void,
      ) => void,
    );
  }

  static get [Symbol.species]() {
    return Promise;
  }

  simple(): this {
    this.modifiersCalled.push('simple');
    return this;
  }

  raw(): this {
    this.modifiersCalled.push('raw');
    return this;
  }

  values(): this {
    this.modifiersCalled.push('values');
    return this;
  }

  cursor(): this {
    this.modifiersCalled.push('cursor');
    return this;
  }
}

describe('wrapClientWithTracing — Query type preservation (scrutiny round 2)', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    __resetForTesting();
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
    __resetForTesting();
  });

  it('preserves .values(), .raw(), .simple(), .cursor() on the main callable result', async () => {
    const fakeClient = Object.assign(
      (strings: TemplateStringsArray) =>
        new FakeQuery((resolve) => resolve([{ id: 1, q: strings.join('') }])),
      {
        unsafe: () => new FakeQuery((resolve) => resolve([])),
        end: () => Promise.resolve(),
      },
    );

    const wrapped = wrapClientWithTracing(fakeClient);
    const result = wrapped`SELECT 1`;

    // The result must be a FakeQuery, not a plain Promise.
    expect(result).toBeInstanceOf(FakeQuery);
    expect(typeof result.values).toBe('function');
    expect(typeof result.raw).toBe('function');
    expect(typeof result.simple).toBe('function');
    expect(typeof result.cursor).toBe('function');

    // Modifier methods must be callable and return the same Query (chainable).
    const chained = result.simple().raw().values();
    expect(chained).toBe(result);
    expect(result.modifiersCalled).toEqual(['simple', 'raw', 'values']);

    // Awaiting must still work.
    const rows = await result;
    expect(rows).toEqual([{ id: 1, q: 'SELECT 1' }]);
  });

  it('preserves .values(), .raw(), .simple() on .unsafe() result', async () => {
    const fakeClient = Object.assign(
      (strings: TemplateStringsArray) =>
        new FakeQuery((resolve) => resolve([{ q: strings.join('') }])),
      {
        unsafe: (sql: string) => new FakeQuery((resolve) => resolve([{ sql }])),
        end: () => Promise.resolve(),
      },
    );

    const wrapped = wrapClientWithTracing(fakeClient);
    const result = wrapped.unsafe('SELECT 1');

    expect(result).toBeInstanceOf(FakeQuery);
    expect(typeof result.values).toBe('function');
    expect(typeof result.raw).toBe('function');
    expect(typeof result.simple).toBe('function');

    const chained = result.values().raw();
    expect(chained).toBe(result);
    expect(result.modifiersCalled).toEqual(['values', 'raw']);

    const rows = await result;
    expect(rows).toEqual([{ sql: 'SELECT 1' }]);
  });

  it('does not convert Query to a plain Promise via .then()', async () => {
    const fakeClient = Object.assign(
      (strings: TemplateStringsArray) =>
        new FakeQuery((resolve) => resolve([{ ok: true, q: strings.join('') }])),
      {
        unsafe: (sql: string) => new FakeQuery((resolve) => resolve([{ sql }])),
        end: () => Promise.resolve(),
      },
    );

    const wrapped = wrapClientWithTracing(fakeClient);
    const result = wrapped`SELECT 1`;

    // The returned object must retain the Query prototype (with modifier
    // methods), not be downgraded to a plain Promise.
    expect(Object.getPrototypeOf(result)).toBe(FakeQuery.prototype);
    expect(result.constructor).toBe(FakeQuery);

    await result;
  });

  it('still creates spans on query completion', async () => {
    const fakeClient = Object.assign(
      (strings: TemplateStringsArray) =>
        new FakeQuery((resolve) => resolve([{ ok: true, q: strings.join('') }])),
      {
        unsafe: (sql: string) => new FakeQuery((resolve) => resolve([{ sql }])),
        end: () => Promise.resolve(),
      },
    );

    const wrapped = wrapClientWithTracing(fakeClient);
    await wrapped`SELECT 1`;
    await wrapped.unsafe('SELECT 2');

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    const names = spans.map((s) => s.name);
    expect(names).toContain('db.query');
    expect(names).toContain('db.unsafe');
  });

  it('ends span with error status on query failure', async () => {
    const fakeClient = Object.assign(
      (strings: TemplateStringsArray) =>
        new FakeQuery((_, reject) => reject(new Error('query failed'))),
      {
        unsafe: (sql: string) => new FakeQuery((resolve) => resolve([{ sql }])),
        end: () => Promise.resolve(),
      },
    );

    const wrapped = wrapClientWithTracing(fakeClient);

    await expect(wrapped`SELECT 1`).rejects.toThrow('query failed');

    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    const errorSpans = spans.filter((s) => s.status.code === SpanStatusCode.ERROR);
    expect(errorSpans).toHaveLength(1);
    expect(errorSpans[0].name).toBe('db.query');
  });

  it('preserves modifier methods when chaining before await', async () => {
    const fakeClient = Object.assign(
      (strings: TemplateStringsArray) =>
        new FakeQuery((resolve) => resolve([{ data: 42, q: strings.join('') }])),
      {
        unsafe: (sql: string) => new FakeQuery((resolve) => resolve([{ sql }])),
        end: () => Promise.resolve(),
      },
    );

    const wrapped = wrapClientWithTracing(fakeClient);

    // Chain modifiers before awaiting — Drizzle-style usage.
    const result = wrapped.unsafe('SELECT 1').simple().values();
    expect(result).toBeInstanceOf(FakeQuery);
    expect(result.modifiersCalled).toEqual(['simple', 'values']);

    const rows = await result;
    expect(rows).toEqual([{ sql: 'SELECT 1' }]);

    // Span should still be created and ended.
    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    expect(spans.map((s) => s.name)).toContain('db.unsafe');
  });
});
